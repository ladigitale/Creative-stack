/**
 * Moteurs de détection de mains. `HandEngine` est le seul contrat vu par `sonic-hand-tracker`.
 *
 * Par défaut : MediaPipe tasks-vision, dans un **worker classique** (le fil principal reste libre pour
 * l'audio, les shaders et l'interface), avec repli automatique sur le fil principal si le worker est
 * impossible (pas d'OffscreenCanvas, CSP sans `worker-src blob:`, échec d'initialisation).
 * L'app hôte peut fournir son propre moteur (`configureVision({ createEngine })`).
 *
 * Le modèle arrive déjà téléchargé et vérifié (`shared/ml/model-fetch`) sous forme de buffer.
 */
import type { Point, RawHand } from "../../shared/ml/hands";

export type HandEngineOptions = {
  /** Contenu du modèle (.task), déjà téléchargé, plafonné et éventuellement vérifié par sha256. */
  model: Uint8Array;
  /** `true` : le modèle fournit aussi les gestes (GestureRecognizer). */
  gestures: boolean;
  maxHands: number;
  minScore: number;
  delegate: "gpu" | "cpu" | "auto";
  /** `auto` : worker puis repli fil principal ; `worker` : pas de repli ; `main` : jamais de worker. */
  thread: "auto" | "worker" | "main";
};

export type HandEngine = {
  /** `tsMs` strictement croissant. Une seule détection à la fois (le composant l'impose). */
  detect(frame: CanvasImageSource, tsMs: number): Promise<RawHand[]>;
  readonly backend: "gpu" | "cpu";
  readonly thread: "worker" | "main";
  close(): void;
};

export type HandEngineFactory = (options: HandEngineOptions) => Promise<HandEngine>;

export type VisionConfig = {
  createEngine?: HandEngineFactory;
  /** Module ESM de MediaPipe tasks-vision (épinglé). */
  mediapipeBundleUrl: string;
  /** Dossier des fichiers WASM correspondants. */
  mediapipeWasmUrl: string;
  /** Fabrique de worker (tests, ou hôte qui sert le script lui-même pour une CSP stricte). */
  createWorker?: () => Worker;
  /** `fetch` utilisé pour télécharger les modèles (tests, proxy de l'hôte). */
  fetchImpl?: typeof fetch;
  /** Délai max d'initialisation du worker avant repli (ms). */
  initTimeoutMs: number;
  /** Délai max d'une détection (ms). */
  detectTimeoutMs: number;
};

const MEDIAPIPE_VERSION = "0.10.21";

const DEFAULT_CONFIG: VisionConfig = {
  mediapipeBundleUrl: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`,
  mediapipeWasmUrl: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  initTimeoutMs: 45_000,
  detectTimeoutMs: 3_000,
};

let config: VisionConfig = { ...DEFAULT_CONFIG };

export function getVisionConfig(): VisionConfig {
  return config;
}

/** Configuration par l'app hôte (CSP : `script-src` / `connect-src` pour le bundle MediaPipe, `worker-src blob:`, `'wasm-unsafe-eval'`). */
export function configureVision(next: Partial<VisionConfig>): VisionConfig {
  config = { ...config, ...next };
  return config;
}

export function resetVisionConfig(): void {
  config = { ...DEFAULT_CONFIG };
}

/* ---------------- conversion des résultats MediaPipe ---------------- */

type MpLandmark = { x: number; y: number; z: number };
type MpCategory = { categoryName?: string; displayName?: string; score?: number };
export type MpResult = {
  landmarks?: MpLandmark[][];
  worldLandmarks?: MpLandmark[][];
  handedness?: MpCategory[][];
  handednesses?: MpCategory[][];
  gestures?: MpCategory[][];
};

const toPoints = (l: MpLandmark[] | undefined): Point[] | undefined => l?.map((p) => ({ x: p.x, y: p.y, z: p.z }));

/** Convertit un résultat MediaPipe (sans dépendre de ses types) en mains brutes. */
export function handsFromMediaPipe(result: MpResult, minScore: number): RawHand[] {
  const out: RawHand[] = [];
  const marks = result.landmarks ?? [];
  const handed = result.handedness ?? result.handednesses ?? [];
  for (let i = 0; i < marks.length; i++) {
    const landmarks = toPoints(marks[i]);
    if (!landmarks || landmarks.length < 21) continue;
    const cat = handed[i]?.[0];
    const score = cat?.score ?? 1;
    if (score < minScore) continue;
    const gesture = result.gestures?.[i]?.[0];
    out.push({
      landmarks,
      world: toPoints(result.worldLandmarks?.[i]),
      label: cat?.categoryName ?? cat?.displayName,
      score,
      gesture: gesture?.categoryName && gesture.categoryName !== "None" ? gesture.categoryName : undefined,
      gestureScore: gesture?.score,
    });
  }
  return out;
}

/* ---------------- fil principal ---------------- */

type MpTask = { detectForVideo(frame: CanvasImageSource, tsMs: number): MpResult; close(): void };
type MpModule = {
  FilesetResolver: { forVisionTasks(wasm: string): Promise<unknown> };
  HandLandmarker: { createFromOptions(fs: unknown, o: unknown): Promise<MpTask> };
  GestureRecognizer: { createFromOptions(fs: unknown, o: unknown): Promise<MpTask> };
};

export async function createMainThreadEngine(opts: HandEngineOptions): Promise<HandEngine> {
  const { mediapipeBundleUrl, mediapipeWasmUrl } = getVisionConfig();
  // Import d'une URL épinglée par la config de l'app : le code vient du runtime, jamais de l'artefact.
  const mp = (await import(/* @vite-ignore */ mediapipeBundleUrl)) as MpModule;
  const fileset = await mp.FilesetResolver.forVisionTasks(mediapipeWasmUrl);
  const Task = opts.gestures ? mp.GestureRecognizer : mp.HandLandmarker;
  const make = (delegate: "GPU" | "CPU") =>
    Task.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: opts.model.slice(), delegate },
      runningMode: "VIDEO",
      numHands: opts.maxHands,
      minHandDetectionConfidence: opts.minScore,
      minHandPresenceConfidence: opts.minScore,
      minTrackingConfidence: opts.minScore,
    });
  let backend: "gpu" | "cpu" = opts.delegate === "cpu" ? "cpu" : "gpu";
  let task: MpTask;
  try {
    task = await make(backend === "gpu" ? "GPU" : "CPU");
  } catch (e) {
    if (opts.delegate !== "auto") throw e;
    backend = "cpu";
    task = await make("CPU");
  }
  return {
    backend,
    thread: "main",
    detect: async (frame, tsMs) => handsFromMediaPipe(task.detectForVideo(frame, tsMs), opts.minScore),
    close: () => task.close(),
  };
}

/* ---------------- worker ---------------- */

/**
 * Script du worker (classique : MediaPipe y charge son WASM par `importScripts`, absent des workers module).
 * Texte statique, sans interpolation. `import()` dynamique d'un module ESM est permis dans un worker classique.
 */
export const WORKER_SOURCE = `"use strict";
let task = null;
const P = (l) => (l || []).map((p) => ({ x: p.x, y: p.y, z: p.z }));
const C = (c) => (c || []).map((o) => ({ categoryName: o.categoryName, displayName: o.displayName, score: o.score }));
const plain = (r) => ({
  landmarks: (r.landmarks || []).map(P),
  worldLandmarks: (r.worldLandmarks || []).map(P),
  handedness: (r.handedness || r.handednesses || []).map(C),
  gestures: (r.gestures || []).map(C),
});
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      const mp = await import(m.bundleUrl);
      const fileset = await mp.FilesetResolver.forVisionTasks(m.wasmUrl);
      const Task = m.gestures ? mp.GestureRecognizer : mp.HandLandmarker;
      const make = (delegate) =>
        Task.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: m.model.slice(), delegate },
          runningMode: "VIDEO",
          numHands: m.maxHands,
          minHandDetectionConfidence: m.minScore,
          minHandPresenceConfidence: m.minScore,
          minTrackingConfidence: m.minScore,
        });
      let backend = m.delegate === "cpu" ? "cpu" : "gpu";
      try {
        task = await make(backend === "gpu" ? "GPU" : "CPU");
      } catch (err) {
        if (m.delegate !== "auto") throw err;
        backend = "cpu";
        task = await make("CPU");
      }
      self.postMessage({ type: "ready", backend });
    } else if (m.type === "detect") {
      try {
        const result = task.detectForVideo(m.bitmap, m.ts);
        self.postMessage({ type: "result", id: m.id, result: plain(result) });
      } finally {
        if (m.bitmap && m.bitmap.close) m.bitmap.close();
      }
    } else if (m.type === "close") {
      if (task) task.close();
      task = null;
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });
  }
};
`;

type Pending = { resolve: (hands: RawHand[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export async function createWorkerEngine(opts: HandEngineOptions): Promise<HandEngine> {
  const cfg = getVisionConfig();
  let blobUrl: string | null = null;
  let worker: Worker;
  if (cfg.createWorker) {
    worker = cfg.createWorker();
  } else {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
      throw new Error("Worker, OffscreenCanvas ou createImageBitmap indisponible.");
    }
    blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(blobUrl, { name: "sonic-hand-tracker" });
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  let initHandlers: { resolve: (backend: "gpu" | "cpu") => void; reject: (e: Error) => void } | null = null;

  const failAll = (error: Error) => {
    initHandlers?.reject(error);
    initHandlers = null;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; id?: number; backend?: "gpu" | "cpu"; result?: MpResult; message?: string };
    if (m.type === "ready") {
      initHandlers?.resolve(m.backend ?? "cpu");
      initHandlers = null;
    } else if (m.type === "result" && m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(handsFromMediaPipe(m.result ?? {}, opts.minScore));
    } else if (m.type === "error") {
      const error = new Error(m.message ?? "erreur du worker");
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        clearTimeout(p.timer);
        p.reject(error);
      } else {
        failAll(error);
      }
    }
  };
  worker.onerror = (e: ErrorEvent) => failAll(new Error(e.message || "erreur du worker"));

  const dispose = () => {
    if (closed) return;
    closed = true;
    try {
      worker.postMessage({ type: "close" });
    } catch {
      /* ignoré */
    }
    worker.terminate();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    failAll(new Error("moteur fermé"));
  };

  let backend: "gpu" | "cpu";
  try {
    backend = await new Promise<"gpu" | "cpu">((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("initialisation du worker trop longue")), cfg.initTimeoutMs);
      initHandlers = {
        resolve: (b) => (clearTimeout(timer), resolve(b)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      // Copie : le buffer du composant reste valable pour un éventuel repli sur le fil principal.
      const model = opts.model.slice();
      worker.postMessage(
        {
          type: "init",
          bundleUrl: cfg.mediapipeBundleUrl,
          wasmUrl: cfg.mediapipeWasmUrl,
          model,
          gestures: opts.gestures,
          maxHands: opts.maxHands,
          minScore: opts.minScore,
          delegate: opts.delegate,
        },
        [model.buffer],
      );
    });
  } catch (e) {
    dispose();
    throw e;
  }

  return {
    backend,
    thread: "worker",
    async detect(frame, tsMs) {
      if (closed) throw new Error("moteur fermé");
      const bitmap = await createImageBitmap(frame as ImageBitmapSource);
      const id = nextId++;
      return new Promise<RawHand[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("détection trop longue"));
        }, cfg.detectTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ type: "detect", id, ts: tsMs, bitmap }, [bitmap]);
      });
    },
    close: dispose,
  };
}

/* ---------------- fabrique par défaut ---------------- */

export const createMediaPipeEngine: HandEngineFactory = async (opts) => {
  if (opts.thread !== "main") {
    try {
      return await createWorkerEngine(opts);
    } catch (e) {
      if (opts.thread === "worker") throw e;
      // repli : fil principal
    }
  }
  return createMainThreadEngine(opts);
};
