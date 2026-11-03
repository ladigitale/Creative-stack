/**
 * Moteur MediaPipe générique (mains, gestes, visage, corps) : un seul worker classique par tâche,
 * repli automatique sur le fil principal, une détection à la fois, résultats « plats » clonables.
 * Les composants convertissent ce résultat brut (`MpResult`) en leurs propres clés de sortie.
 *
 * Le modèle arrive déjà téléchargé et vérifié (`shared/ml/model-fetch`) sous forme de buffer.
 */

export type MpTask = "hand" | "gesture" | "face" | "pose";

export type MpEngineOptions = {
  task: MpTask;
  /** Contenu du modèle (.task), déjà téléchargé, plafonné et éventuellement vérifié par sha256. */
  model: Uint8Array;
  /** Options de la tâche MediaPipe (`numHands`, `outputFaceBlendshapes`, `numPoses`, seuils…). */
  options: Record<string, unknown>;
  delegate: "gpu" | "cpu" | "auto";
  /** `auto` : worker puis repli fil principal ; `worker` : pas de repli ; `main` : jamais de worker. */
  thread: "auto" | "worker" | "main";
};

type MpPoint = { x: number; y: number; z: number; visibility?: number };
type MpCategory = { categoryName?: string; displayName?: string; score?: number };

/** Résultat brut MediaPipe, copié en objets simples (clonable entre worker et fil principal). */
export type MpResult = {
  landmarks?: MpPoint[][];
  worldLandmarks?: MpPoint[][];
  handedness?: MpCategory[][];
  handednesses?: MpCategory[][];
  gestures?: MpCategory[][];
  faceLandmarks?: MpPoint[][];
  faceBlendshapes?: Array<{ categories?: MpCategory[] }>;
  facialTransformationMatrixes?: Array<{ rows?: number; columns?: number; data?: number[] }>;
};

export type MpEngine = {
  /** `tsMs` strictement croissant. Une seule détection à la fois (le composant l'impose). */
  detect(frame: CanvasImageSource, tsMs: number): Promise<MpResult>;
  readonly backend: "gpu" | "cpu";
  readonly thread: "worker" | "main";
  close(): void;
};

export type MpEngineFactory = (options: MpEngineOptions) => Promise<MpEngine>;

export type VisionConfig = {
  /** Moteur de mains personnalisé (tests, backend TF.js) : renvoie directement des mains brutes. */
  createEngine?: import("./hand-engine").HandEngineFactory;
  /** Moteur MediaPipe personnalisé pour toutes les tâches (visage, corps, tests). */
  createMpEngine?: MpEngineFactory;
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

export const MEDIAPIPE_VERSION = "0.10.21";

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

/** Classe MediaPipe de chaque tâche. */
const TASK_CLASS: Record<MpTask, string> = {
  hand: "HandLandmarker",
  gesture: "GestureRecognizer",
  face: "FaceLandmarker",
  pose: "PoseLandmarker",
};

/* ---------------- fil principal ---------------- */

type MpTaskInstance = { detectForVideo(frame: CanvasImageSource, tsMs: number): unknown; close(): void };
type MpModule = {
  FilesetResolver: { forVisionTasks(wasm: string): Promise<unknown> };
} & Record<string, { createFromOptions(fs: unknown, o: unknown): Promise<MpTaskInstance> }>;

/** Copie en objets simples : tableaux, nombres, chaînes, objets ; typés → tableaux ; fonctions ignorées. */
export function plainResult(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value ?? undefined;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map((v) => plainResult(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "function") continue;
      out[k] = plainResult(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export async function createMainThreadMpEngine(opts: MpEngineOptions): Promise<MpEngine> {
  const { mediapipeBundleUrl, mediapipeWasmUrl } = getVisionConfig();
  // Import d'une URL épinglée par la config de l'app : le code vient du runtime, jamais de l'artefact.
  const mp = (await import(/* @vite-ignore */ mediapipeBundleUrl)) as MpModule;
  const fileset = await mp.FilesetResolver.forVisionTasks(mediapipeWasmUrl);
  const Task = mp[TASK_CLASS[opts.task]];
  if (!Task) throw new Error(`Tâche MediaPipe inconnue : ${opts.task}`);
  const make = (delegate: "GPU" | "CPU") =>
    Task.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: opts.model.slice(), delegate },
      runningMode: "VIDEO",
      ...opts.options,
    });
  let backend: "gpu" | "cpu" = opts.delegate === "cpu" ? "cpu" : "gpu";
  let task: MpTaskInstance;
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
    detect: async (frame, tsMs) => plainResult(task.detectForVideo(frame, tsMs)) as MpResult,
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
const CLASSES = { hand: "HandLandmarker", gesture: "GestureRecognizer", face: "FaceLandmarker", pose: "PoseLandmarker" };
const plain = (v, d) => {
  d = d || 0;
  if (d > 6 || v === null || v === undefined) return v === null ? null : undefined;
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return v;
  if (ArrayBuffer.isView(v)) return Array.from(v);
  if (Array.isArray(v)) return v.map((x) => plain(x, d + 1));
  if (t === "object") {
    const o = {};
    for (const k of Object.keys(v)) if (typeof v[k] !== "function") o[k] = plain(v[k], d + 1);
    return o;
  }
  return undefined;
};
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      const mp = await import(m.bundleUrl);
      const fileset = await mp.FilesetResolver.forVisionTasks(m.wasmUrl);
      const Task = mp[CLASSES[m.task]];
      if (!Task) throw new Error("Tâche MediaPipe inconnue : " + m.task);
      const make = (delegate) =>
        Task.createFromOptions(fileset, Object.assign({ baseOptions: { modelAssetBuffer: m.model.slice(), delegate }, runningMode: "VIDEO" }, m.options));
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

type Pending = { resolve: (r: MpResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export async function createWorkerMpEngine(opts: MpEngineOptions): Promise<MpEngine> {
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
    worker = new Worker(blobUrl, { name: `sonic-${opts.task}-tracker` });
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
      p.resolve(m.result ?? {});
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
          task: opts.task,
          options: opts.options,
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
      return new Promise<MpResult>((resolve, reject) => {
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

export const createMediaPipeMpEngine: MpEngineFactory = async (opts) => {
  if (opts.thread !== "main") {
    try {
      return await createWorkerMpEngine(opts);
    } catch (e) {
      if (opts.thread === "worker") throw e;
      // repli : fil principal
    }
  }
  return createMainThreadMpEngine(opts);
};
