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
  const segmenters = new Map<string, { model: any; processor: any; backend: string; image: any | null; raw: any | null; ref: any; fallbacks: string[] }>();

  const samModelOn = async (model: any, device: string) => {
    const opts: Record<string, unknown> = loadOptions(model);
    const byDevice = (opts.dtypeByDevice ?? null) as Record<string, unknown> | null;
    delete opts.dtypeByDevice;
    if (byDevice && byDevice[device] !== undefined) opts.dtype = byDevice[device];
    const files: Record<string, { loaded: number; total: number }> = {};
    const progress_callback = (info: any) => {
      if (info.status !== "progress") return;
      files[info.file] = { loaded: info.loaded, total: info.total };
      const all = Object.values(files);
      const loaded = all.reduce((a, f) => a + (f.loaded || 0), 0);
      const total = all.reduce((a, f) => a + (f.total || 0), 0);
      post({ type: "progress", alias: model.alias, progress: { file: info.file, loadedBytes: loaded, totalBytes: total, percent: total ? Math.round((loaded / total) * 100) : 0 } });
    };
    return lib.AutoModelForMaskGeneration!.from_pretrained(model.repo, { ...opts, device, progress_callback });
  };

  const samEntry = (alias: string) => {
    const entry = segmenters.get(alias);
    if (!entry) {
      const err: any = new Error(`Modèle "${alias}" non chargé.`);
      err.code = "runtime";
      throw err;
    }
    return entry;
  };

  /** Perte du GPU, mémoire GPU épuisée, échec d'exécution WebGPU : le moteur suivant peut prendre le relais. */
  const isGpuFailure = (err: unknown) => /device\s*(is\s*)?lost|mapAsync|GPUBuffer|webgpu|OrtRun|out of memory|GPUValidationError/i.test(String((err as any)?.message ?? err));

  /**
   * Exécute `fn` ; si le moteur GPU lâche, recharge le modèle sur le moteur suivant (WASM en général) et relance
   * `fn(true)` (qui réencode l'image si besoin). Le changement est définitif pour ce modèle.
   */
  const samWithFallback = async <R>(entry: any, fn: (retried: boolean) => Promise<R>): Promise<R> => {
    try {
      return await fn(false);
    } catch (err) {
      if (entry.backend === "wasm" || !entry.fallbacks?.length || !isGpuFailure(err)) throw err;
      const next = entry.fallbacks.shift();
      try { await entry.model?.dispose?.(); } catch { /* GPU déjà perdu */ }
      entry.model = await samModelOn(entry.ref, next);
      entry.backend = next;
      entry.image = null;
      return await fn(true);
    }
  };

  const samEncode = async (entry: any, image: any) => {
    const raw = new (lib.RawImage as any)(image.data, image.width, image.height, 4);
    const inputs = await entry.processor(raw);
    const embeddings = await entry.model.get_image_embeddings(inputs);
    entry.image = { embeddings, original_sizes: inputs.original_sizes, reshaped_input_sizes: inputs.reshaped_input_sizes, width: image.width, height: image.height };
  };

  /** Moyenne sur une fenêtre (2r+1)², bords compris (somme glissante séparable, O(n)). */
  const boxMean = (src: Float32Array, w: number, h: number, r: number): Float32Array => {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[row + x];
      for (let x = 0; x < w; x++) {
        const lo = x - r - 1, hi = x + r;
        if (hi < w && x > 0) acc += src[row + hi];
        if (lo >= 0) acc -= src[row + lo];
        tmp[row + x] = acc / (Math.min(w - 1, hi) - Math.max(0, x - r) + 1);
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = 0; y <= Math.min(r, h - 1); y++) acc += tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        const lo = y - r - 1, hi = y + r;
        if (hi < h && y > 0) acc += tmp[hi * w + x];
        if (lo >= 0) acc -= tmp[lo * w + x];
        out[y * w + x] = acc / (Math.min(h - 1, hi) - Math.max(0, y - r) + 1);
      }
    }
    return out;
  };

  /**
   * Filtre guidé (He et al.) : le masque `p` (0..1) épouse les bords de l'image guide `I` (luminance 0..1).
   * Renvoie l'alpha affiné (0..1).
   */
  const guidedFilter = (I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array => {
    const n = w * h;
    const Ip = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const varI = mII[i] - mI[i] * mI[i];
      a[i] = (mIp[i] - mI[i] * mp[i]) / (varI + eps);
      b[i] = mp[i] - a[i] * mI[i];
    }
    const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
    return q;
  };

  /** Demi-flottant IEEE 754 (bits) → nombre. */
  const halfToFloat = (h: number): number => {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
  };

  /** Tenseur float16 → float32 (les données sont un Float16Array, ou les bits bruts dans un Uint16Array). */
  const toFloat32 = (t: any): any => {
    if (!t || t.type !== "float16") return t;
    const d = t.data;
    const out = new Float32Array(d.length);
    if (d instanceof Uint16Array) for (let i = 0; i < d.length; i++) out[i] = halfToFloat(d[i]);
    else for (let i = 0; i < d.length; i++) out[i] = Number(d[i]);
    return new (lib as any).Tensor("float32", out, t.dims);
  };

  const samDecode = async (entry: any, points: any, box: any, refine: boolean) => {
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
    let out: any;
    try {
      out = await entry.model(feed);
    } catch (err) {
      // encodeur en fp16 et décodeur en fp32 (précision mixte) : les embeddings sont convertis une fois pour toutes
      if (!/Unexpected input data type/i.test(String((err as any)?.message ?? err))) throw err;
      for (const k of Object.keys(img.embeddings)) img.embeddings[k] = toFloat32(img.embeddings[k]);
      out = await entry.model({ ...feed, ...img.embeddings });
    }
    out = { ...out, pred_masks: toFloat32(out.pred_masks), iou_scores: toFloat32(out.iou_scores) };
    const scores: number[] = Array.from(out.iou_scores.data as ArrayLike<number>).map(Number);
    // un GPU en précision réduite peut déborder (valeurs infinies ou NaN) : on le traite comme une panne GPU,
    // ce qui fait basculer sur le moteur suivant
    if (entry.backend !== "wasm") {
      const raw = out.pred_masks.data as ArrayLike<number>;
      let bad = scores.some((v) => !Number.isFinite(v));
      for (let i = 0; !bad && i < raw.length; i += 61) if (!Number.isFinite(Number(raw[i]))) bad = true;
      if (bad) throw new Error("webgpu : sortie invalide du modèle (NaN ou infini)");
    }
    const count = out.pred_masks.dims[2];
    let best = 0;
    for (let i = 1; i < count; i++) if ((scores[i] ?? -Infinity) > (scores[best] ?? -Infinity)) best = i;
    // seul le meilleur masque est agrandi, en valeurs continues (logits) pour garder un bord exploitable
    const chosen = out.pred_masks.slice(null, null, [best, best + 1]);
    const masks = await entry.processor.post_process_masks(chosen, img.original_sizes, img.reshaped_input_sizes, { binarize: false });
    const m = masks[0];
    const h = m.dims[m.dims.length - 2], w = m.dims[m.dims.length - 1];
    const n = h * w;
    const logits = m.data as ArrayLike<number>;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = logits[i] > 0 ? 255 : 0;
    if (refine && entry.raw && entry.raw.width === w && entry.raw.height === h) {
      // le masque du modèle sort en 256 px : sa zone floue fait quelques max(w, h) / 256 px ; la fenêtre la couvre
      const r = Math.max(2, Math.round(Math.max(w, h) / 128));
      // le filtre ne change rien loin du bord : on ne calcule que la boîte qui entoure le bord, élargie de 2 fenêtres
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = mask[y * w + x];
        if ((x + 1 < w && mask[y * w + x + 1] !== v) || (y + 1 < h && mask[(y + 1) * w + x] !== v)) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 >= 0) {
        const m2 = 4 * r + 2;
        x0 = Math.max(0, x0 - m2); y0 = Math.max(0, y0 - m2); x1 = Math.min(w - 1, x1 + m2); y1 = Math.min(h - 1, y1 + m2);
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1, cn = cw * ch;
        const px = entry.raw.data as Uint8ClampedArray;
        const I = new Float32Array(cn), p = new Float32Array(cn);
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          const k = (y + y0) * w + (x + x0), o = k * 4, c = y * cw + x;
          I[c] = (0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]) / 255;
          p[c] = mask[k] / 255;
        }
        // deux passes : la première rapproche le bord du contour, la seconde le colle (le halo résiduel s'efface)
        const q = guidedFilter(I, guidedFilter(I, p, cw, ch, r, 1e-4), cw, ch, r, 1e-4);
        // contraste sur la bande de transition : bord net, transition d'un ou deux pixels
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          const t = Math.min(1, Math.max(0, (q[y * cw + x] - 0.25) / 0.5));
          mask[(y + y0) * w + (x + x0)] = Math.round(t * t * (3 - 2 * t) * 255);
        }
      }
    }
    return { width: w, height: h, mask, score: scores[best] ?? 0, scores: scores.slice(0, count), index: best };
  };

  const handlers: Record<string, (msg: any) => Promise<unknown>> = {
    /**
     * Charge un modèle SAM / SAM 2 (`AutoModelForMaskGeneration` + `AutoProcessor`). `options.dtypeByDevice`
     * (`{ webgpu: …, wasm: … }`) choisit la précision par moteur (q4f16 n'a de sens que sur GPU).
     */
    async "sam-load"({ model, devices }) {
      const existing = segmenters.get(model.alias);
      if (existing) return { backend: existing.backend, loadMs: 0 };
      if (!lib.AutoModelForMaskGeneration || !lib.AutoProcessor || !lib.RawImage) {
        const err: any = new Error("Cette version de Transformers.js ne gère pas la segmentation interactive.");
        err.code = "unsupported";
        throw err;
      }
      const t0 = performance.now();
      const processor: any = await lib.AutoProcessor.from_pretrained(model.repo, { revision: model.revision });
      const errors: string[] = [];
      const list = devices as string[];
      for (let i = 0; i < list.length; i++) {
        const device = list[i];
        if (device === "webgpu" && !(await hasWebGpu())) {
          errors.push("webgpu indisponible");
          continue;
        }
        try {
          const m = await samModelOn(model, device);
          segmenters.set(model.alias, { model: m, processor, backend: device, image: null, raw: null, ref: model, fallbacks: list.slice(i + 1) });
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
      const entry = samEntry(alias);
      const t0 = performance.now();
      entry.raw = image;
      await samWithFallback(entry, () => samEncode(entry, image));
      return { width: image.width, height: image.height, encodeMs: Math.round(performance.now() - t0), backend: entry.backend };
    },

    /**
     * Masque pour des invites en px de l'image encodée : points (`label` 1 objet, 0 hors objet) et/ou une boîte.
     * Renvoie le meilleur des masques proposés (score IoU estimé) en alpha 0..255 à la taille de l'image ;
     * `refine` (défaut) colle le bord aux contours de l'image (filtre guidé).
     */
    async "sam-decode"({ alias, points, box, refine }) {
      const entry = samEntry(alias);
      if (!entry.image) {
        const err: any = new Error("Aucune image encodée.");
        err.code = "runtime";
        throw err;
      }
      const t0 = performance.now();
      const res = await samWithFallback(entry, async (retried) => {
        if (retried && entry.raw) await samEncode(entry, entry.raw);
        return samDecode(entry, points, box, refine !== false);
      });
      return res ? { ...res, decodeMs: Math.round(performance.now() - t0), backend: entry.backend } : null;
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
