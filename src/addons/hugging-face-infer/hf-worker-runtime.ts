/**
 * Code exécuté DANS le worker. C'est le seul endroit qui touche Transformers.js.
 *
 * `hfWorkerMain` est volontairement autonome (aucune référence à un import ni
 * à une variable extérieure) : il est sérialisé tel quel (`toString()`) pour
 * construire le worker « blob » du mode `cdn`. Ne pas y utiliser d'import,
 * de helper externe ni de variable de module.
 *
 * Pour un worker construit par l'application (mode `worker`), utiliser
 * `serveHuggingFaceWorker` :
 *
 * ```ts
 * // hf.worker.ts (dans l'application)
 * import * as transformers from "@huggingface/transformers";
 * import { serveHuggingFaceWorker } from "@supersoniks/creative-stack/hugging-face-infer/worker";
 * serveHuggingFaceWorker(transformers);
 * ```
 */

/** Sous-ensemble de Transformers.js utilisé par le worker (typage structurel, sans import). */
export type HfLibrary = {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  env: Record<string, unknown> & {
    backends?: { onnx?: { wasm?: Record<string, unknown> } };
  };
  ModelRegistry?: {
    get_pipeline_files?: (
      task: string,
      model: string,
      options?: Record<string, unknown>,
    ) => Promise<string[]>;
    get_file_metadata?: (
      model: string,
      file: string,
      options?: Record<string, unknown>,
    ) => Promise<{ exists: boolean; size?: number; fromCache?: boolean }>;
    is_pipeline_cached?: (
      task: string,
      model: string,
      options?: Record<string, unknown>,
    ) => Promise<boolean>;
    clear_pipeline_cache?: (
      task: string,
      model: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  LogLevel?: Record<string, unknown>;
  /** Segmentation interactive (SAM, SAM 2) : chargement hors pipeline. */
  AutoProcessor?: { from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<unknown> };
  AutoModelForMaskGeneration?: { from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<unknown> };
  RawImage?: new (data: Uint8ClampedArray | Uint8Array, width: number, height: number, channels: number) => unknown;
};

/** Portée minimale d'un worker (évite de dépendre de la lib TS « webworker »). */
export type HfWorkerScope = {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (
    type: "message",
    listener: (event: { data: unknown }) => void,
  ) => void;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function hfWorkerMain(lib: HfLibrary, scope: HfWorkerScope): void {
  const pipelines = new Map<string, { pipe: any; task: string }>();
  let queue: Promise<unknown> = Promise.resolve();

  const post = (message: unknown) => scope.postMessage(message);
  const fail = (id: number, code: string, message: string) =>
    post({ id, ok: false, error: { code, message } });

  const errorCode = (err: unknown): string => {
    const text = String((err as any)?.message ?? err).toLowerCase();
    if ((err as any)?.code) return String((err as any).code);
    if (text.includes("quota")) return "quota";
    if (
      text.includes("failed to fetch") ||
      text.includes("network") ||
      text.includes("404") ||
      text.includes("could not locate")
    )
      return "network";
    return "runtime";
  };

  const loadOptions = (model: any) => {
    const opts: Record<string, unknown> = { ...(model.options || {}) };
    opts.revision = model.revision;
    return opts;
  };

  const hasWebGpu = async (): Promise<boolean> => {
    const gpu = (globalThis as any).navigator?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") return false;
    try {
      return !!(await gpu.requestAdapter());
    } catch {
      return false;
    }
  };

  const isTensor = (v: any) =>
    v && typeof v === "object" && typeof v.tolist === "function" && "dims" in v;
  const isRawImage = (v: any) =>
    v &&
    typeof v === "object" &&
    typeof v.toBlob === "function" &&
    typeof v.width === "number" &&
    typeof v.channels === "number";

  const serialize = async (v: any): Promise<any> => {
    if (isTensor(v)) return v.tolist();
    if (isRawImage(v)) {
      const blob = await v.toBlob("image/png");
      return { width: v.width, height: v.height, channels: v.channels, blob };
    }
    if (Array.isArray(v)) return Promise.all(v.map(serialize));
    if (v instanceof Blob) return v;
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) out[k] = await serialize(v[k]);
      return out;
    }
    return v;
  };

  /** Retire la dimension « lot » d'un Tensor pour un élément unique. */
  const unbatch = (v: any) =>
    Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) ? v[0] : v;

  /** Un module chargé depuis une URL blob: est-il autorisé ici (CSP script-src) ? */
  const canImportBlob = async (): Promise<boolean> => {
    let url = "";
    try {
      url = URL.createObjectURL(new Blob(["export default 1;"], { type: "text/javascript" }));
      const m: any = await import(/* @vite-ignore */ url);
      return m?.default === 1;
    } catch {
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };

  /** Modèles de segmentation interactive : `alias` → modèle, processeur, image encodée courante. */
  const segmenters = new Map<string, { model: any; processor: any; backend: string; image: any | null }>();

  const handlers: Record<string, (msg: any) => Promise<unknown>> = {
    /** Charge un modèle SAM / SAM 2 (`AutoModelForMaskGeneration` + `AutoProcessor`). */
    async "sam-load"({ model, devices }) {
      const existing = segmenters.get(model.alias);
      if (existing) return { backend: existing.backend, loadMs: 0 };
      if (!lib.AutoModelForMaskGeneration || !lib.AutoProcessor || !lib.RawImage) {
        const err: any = new Error("Cette version de Transformers.js ne gère pas la segmentation interactive.");
        err.code = "unsupported";
        throw err;
      }
      const t0 = performance.now();
      const files: Record<string, { loaded: number; total: number }> = {};
      const progress_callback = (info: any) => {
        if (info.status !== "progress") return;
        files[info.file] = { loaded: info.loaded, total: info.total };
        const all = Object.values(files);
        const loaded = all.reduce((a, f) => a + (f.loaded || 0), 0);
        const total = all.reduce((a, f) => a + (f.total || 0), 0);
        post({ type: "progress", alias: model.alias, progress: { file: info.file, loadedBytes: loaded, totalBytes: total, percent: total ? Math.round((loaded / total) * 100) : 0 } });
      };
      const processor: any = await lib.AutoProcessor.from_pretrained(model.repo, { revision: model.revision });
      const errors: string[] = [];
      for (const device of devices as string[]) {
        if (device === "webgpu" && !(await hasWebGpu())) {
          errors.push("webgpu indisponible");
          continue;
        }
        try {
          const m: any = await lib.AutoModelForMaskGeneration.from_pretrained(model.repo, { ...loadOptions(model), device, progress_callback });
          segmenters.set(model.alias, { model: m, processor, backend: device, image: null });
          return { backend: device, loadMs: Math.round(performance.now() - t0) };
        } catch (err) {
          const code = errorCode(err);
          if (code === "network" || code === "quota") throw err;
          errors.push(`${device} : ${String((err as any)?.message ?? err)}`);
        }
      }
      const err: any = new Error(`Aucun backend utilisable (${errors.join(" ; ") || "aucun autorisé"}).`);
      err.code = "unsupported";
      throw err;
    },

    /** Encode une image RGBA (une seule à la fois par modèle) : le décodage des invites réutilise l'encodage. */
    async "sam-encode"({ alias, image }) {
      const entry = segmenters.get(alias);
      if (!entry) {
        const err: any = new Error(`Modèle "${alias}" non chargé.`);
        err.code = "runtime";
        throw err;
      }
      const t0 = performance.now();
      const raw = new (lib.RawImage as any)(image.data, image.width, image.height, 4);
      const inputs = await entry.processor(raw);
      const embeddings = await entry.model.get_image_embeddings(inputs);
      entry.image = { embeddings, original_sizes: inputs.original_sizes, reshaped_input_sizes: inputs.reshaped_input_sizes, width: image.width, height: image.height };
      return { width: image.width, height: image.height, encodeMs: Math.round(performance.now() - t0) };
    },

    /**
     * Masque pour des invites en px de l'image encodée : points (`label` 1 objet, 0 hors objet) et/ou une boîte.
     * Renvoie le meilleur des masques proposés (score IoU estimé) en octets 0/1, à la taille de l'image.
     */
    async "sam-decode"({ alias, points, box }) {
      const entry = segmenters.get(alias);
      if (!entry || !entry.image) {
        const err: any = new Error("Aucune image encodée.");
        err.code = "runtime";
        throw err;
      }
      const t0 = performance.now();
      const ip = entry.processor.image_processor ?? entry.processor;
      const img = entry.image;
      const feed: Record<string, unknown> = { ...img.embeddings };
      const pts = Array.isArray(points) ? points : [];
      if (pts.length) {
        const input_points = ip.reshape_input_points([[pts.map((p: any) => [p.x, p.y])]], img.original_sizes, img.reshaped_input_sizes);
        feed.input_points = input_points;
        feed.input_labels = ip.add_input_labels([[pts.map((p: any) => (p.label === 0 ? 0 : 1))]], input_points);
      }
      if (box) feed.input_boxes = ip.reshape_input_points([[[box.x0, box.y0, box.x1, box.y1]]], img.original_sizes, img.reshaped_input_sizes, true);
      if (!feed.input_points && !feed.input_boxes) return null;
      const out = await entry.model(feed);
      const masks = await entry.processor.post_process_masks(out.pred_masks, img.original_sizes, img.reshaped_input_sizes);
      const m = masks[0];
      const scores: number[] = Array.from(out.iou_scores.data as ArrayLike<number>).map(Number);
      const count = m.dims[1];
      let best = 0;
      for (let i = 1; i < count; i++) if ((scores[i] ?? -Infinity) > (scores[best] ?? -Infinity)) best = i;
      const h = m.dims[2], w = m.dims[3];
      const plane = h * w;
      const mask = new Uint8Array(plane);
      const data = m.data as ArrayLike<number | boolean>;
      for (let i = 0, o = best * plane; i < plane; i++) mask[i] = data[o + i] ? 1 : 0;
      return { width: w, height: h, mask, score: scores[best] ?? 0, scores: scores.slice(0, count), index: best, decodeMs: Math.round(performance.now() - t0) };
    },

    async "sam-dispose"({ alias }) {
      const entry = segmenters.get(alias);
      segmenters.delete(alias);
      await entry?.model?.dispose?.();
      return true;
    },

    async configure({ env }) {
      const e = lib.env as any;
      e.allowLocalModels = false;
      e.allowRemoteModels = true;
      e.useBrowserCache = true;
      // Le cache WASM de Transformers.js recharge le module .mjs d'ONNX Runtime depuis une URL blob: : une CSP
      // script-src sans blob: le refuse (« Failed to fetch dynamically imported module: blob:… ») et aucun backend
      // ne démarre. On ne l'active que si un import blob: passe dans ce worker.
      e.useWasmCache = await canImportBlob();
      e.cacheKey = env.cacheKey;
      if (env.remoteHost) e.remoteHost = env.remoteHost;
      if (env.remotePathTemplate) e.remotePathTemplate = env.remotePathTemplate;
      if (env.wasmPaths && e.backends?.onnx?.wasm) {
        let paths = env.wasmPaths;
        if (typeof paths === "string") {
          // Même choix de binaire que Transformers.js (build asyncify, sauf
          // Safari < 26 sans WebGPU), mais sous forme d'objet : c'est la seule
          // forme que Transformers.js met en cache (Cache API).
          const base = paths.endsWith("/") ? paths : paths + "/";
          const ua = String((globalThis as any).navigator?.userAgent ?? "");
          const safari = /Safari\//.test(ua) && !/Chrome|Chromium|Android/.test(ua);
          const version = Number((/Version\/(\d+)/.exec(ua) ?? [])[1] ?? 99);
          const suffix =
            safari && version < 26 && !(globalThis as any).navigator?.gpu
              ? ""
              : ".asyncify";
          paths = {
            mjs: `${base}ort-wasm-simd-threaded${suffix}.mjs`,
            wasm: `${base}ort-wasm-simd-threaded${suffix}.wasm`,
          };
        }
        e.backends.onnx.wasm.wasmPaths = paths;
      }
      if (e.backends?.onnx?.wasm) {
        let threads = typeof env.numThreads === "number" && env.numThreads >= 1 ? Math.floor(env.numThreads) : undefined;
        if (threads === undefined && env.wasmPaths) {
          // Binaires sur une autre origine + multithread = import d'une URL blob: (refusée par une CSP sans blob:).
          const first = typeof env.wasmPaths === "string" ? env.wasmPaths : env.wasmPaths.mjs;
          let foreign = true;
          try {
            foreign = new URL(first, (globalThis as any).location?.href).origin !== (globalThis as any).location?.origin;
          } catch {
            foreign = true;
          }
          if (foreign) threads = 1;
        }
        if (threads !== undefined) e.backends.onnx.wasm.numThreads = threads;
      }
      if (env.logLevel && lib.LogLevel) {
        const level = (lib.LogLevel as any)[String(env.logLevel).toUpperCase()];
        if (level !== undefined) e.logLevel = level;
      }
      return { version: e.version ?? null };
    },

    async inspect({ model }) {
      const registry = lib.ModelRegistry;
      const opts = loadOptions(model);
      let cached = false;
      let totalBytes: number | null = null;
      try {
        cached = !!(await registry?.is_pipeline_cached?.(
          model.task,
          model.repo,
          opts,
        ));
      } catch {
        cached = false;
      }
      try {
        const files = await registry?.get_pipeline_files?.(
          model.task,
          model.repo,
          opts,
        );
        if (files && registry?.get_file_metadata) {
          const metas = await Promise.all(
            files.map((f) =>
              registry.get_file_metadata!(model.repo, f, {
                revision: model.revision,
              }).catch(() => null),
            ),
          );
          const sizes = metas.map((m) => m?.size);
          if (sizes.every((s) => typeof s === "number")) {
            totalBytes = (sizes as number[]).reduce((a, b) => a + b, 0);
          }
        }
      } catch {
        totalBytes = null;
      }
      return { cached, totalBytes };
    },

    async load({ model, devices }) {
      const existing = pipelines.get(model.alias);
      if (existing) return { backend: existing.pipe.__backend, loadMs: 0 };
      const t0 = performance.now();
      const files: Record<string, { loaded: number; total: number }> = {};
      const progress_callback = (info: any) => {
        if (info.status === "progress_total") {
          post({
            type: "progress",
            alias: model.alias,
            progress: {
              loadedBytes: info.loaded,
              totalBytes: info.total,
              percent: Math.round(info.progress ?? 0),
            },
          });
        } else if (info.status === "progress") {
          files[info.file] = { loaded: info.loaded, total: info.total };
          const all = Object.values(files);
          const loaded = all.reduce((a, f) => a + (f.loaded || 0), 0);
          const total = all.reduce((a, f) => a + (f.total || 0), 0);
          post({
            type: "progress",
            alias: model.alias,
            progress: {
              file: info.file,
              loadedBytes: loaded,
              totalBytes: total,
              percent: total ? Math.round((loaded / total) * 100) : 0,
            },
          });
        }
      };
      const errors: string[] = [];
      for (const device of devices as string[]) {
        if (device === "webgpu" && !(await hasWebGpu())) {
          errors.push("webgpu indisponible");
          continue;
        }
        try {
          const pipe: any = await lib.pipeline(model.task, model.repo, {
            ...loadOptions(model),
            device,
            progress_callback,
          });
          pipe.__backend = device;
          pipelines.set(model.alias, { pipe, task: model.task });
          return {
            backend: device,
            loadMs: Math.round(performance.now() - t0),
          };
        } catch (err) {
          const code = errorCode(err);
          if (code === "network" || code === "quota") throw err;
          errors.push(`${device} : ${String((err as any)?.message ?? err)}`);
        }
      }
      const err: any = new Error(
        `Aucun backend utilisable (${errors.join(" ; ") || "aucun autorisé"}).`,
      );
      err.code = "unsupported";
      throw err;
    },

    async run({ request }) {
      const entry = pipelines.get(request.alias);
      if (!entry) {
        const err: any = new Error(`Modèle "${request.alias}" non chargé.`);
        err.code = "runtime";
        throw err;
      }
      const { pipe } = entry;
      const call = { ...(request.call || {}) };
      let positional: unknown;
      if (request.positional) {
        positional = call[request.positional];
        delete call[request.positional];
      }
      const invoke = (input: unknown) =>
        request.positional ? pipe(input, positional, call) : pipe(input, call);

      if (request.batch) {
        const out: unknown[] = [];
        const size = 32;
        for (let i = 0; i < request.inputs.length; i += size) {
          const chunk = request.inputs.slice(i, i + size);
          const rows = await serialize(await invoke(chunk));
          out.push(...(Array.isArray(rows) ? rows : [rows]));
        }
        return out;
      }
      const out: unknown[] = [];
      for (const input of request.inputs) {
        const value = await serialize(await invoke(input));
        out.push(
          entry.task === "feature-extraction" ||
            entry.task === "image-feature-extraction"
            ? unbatch(value)
            : value,
        );
      }
      return out;
    },

    async clear({ model }) {
      const registry = lib.ModelRegistry;
      if (model) {
        const entry = pipelines.get(model.alias);
        pipelines.delete(model.alias);
        await entry?.pipe?.dispose?.();
        await registry?.clear_pipeline_cache?.(
          model.task,
          model.repo,
          loadOptions(model),
        );
        return true;
      }
      for (const entry of pipelines.values()) await entry.pipe?.dispose?.();
      pipelines.clear();
      const cacheKey = (lib.env as any).cacheKey;
      if (cacheKey && typeof caches !== "undefined") await caches.delete(cacheKey);
      return true;
    },
  };

  scope.addEventListener("message", (event) => {
    const msg: any = event.data;
    if (!msg || typeof msg.id !== "number" || !handlers[msg.type]) return;
    // Les requêtes sont traitées une par une : un seul modèle calcule à la fois.
    queue = queue
      .then(() => handlers[msg.type](msg))
      .then(
        (result) => post({ id: msg.id, ok: true, result }),
        (err) =>
          fail(msg.id, errorCode(err), String((err as any)?.message ?? err)),
      );
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** À appeler dans un worker construit par l'application (mode `runtime.source = "worker"`). */
export function serveHuggingFaceWorker(lib: HfLibrary): void {
  hfWorkerMain(lib, globalThis as unknown as HfWorkerScope);
}

/**
 * Source d'un worker module autonome qui importe Transformers.js depuis une
 * URL figée (mode `runtime.source = "cdn"`).
 */
export function buildHfWorkerSource(libraryUrl: string): string {
  // Les messages reçus pendant l'import du moteur sont mis de côté puis rejoués.
  return [
    `const hfWorkerMain = ${hfWorkerMain.toString()};`,
    `const pending = [];`,
    `const buffer = (event) => pending.push(event);`,
    `self.addEventListener("message", buffer);`,
    `let lib;`,
    `try {`,
    `  lib = await import(${JSON.stringify(libraryUrl)});`,
    `} catch (err) {`,
    `  self.postMessage({ type: "fatal", message: "Chargement de Transformers.js impossible : " + (err && err.message || err) });`,
    `  throw err;`,
    `}`,
    `self.removeEventListener("message", buffer);`,
    `hfWorkerMain(lib, {`,
    `  postMessage: (message, transfer) => self.postMessage(message, transfer),`,
    `  addEventListener: (type, listener) => {`,
    `    self.addEventListener(type, listener);`,
    `    for (const event of pending.splice(0)) listener(event);`,
    `  },`,
    `});`,
  ].join("\n");
}
