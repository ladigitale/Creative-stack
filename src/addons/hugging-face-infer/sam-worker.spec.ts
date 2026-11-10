// @vitest-environment node
/**
 * Handlers `sam-*` du worker, avec le vrai processeur SAM 2 de Transformers.js (redimensionnement, mise à l'échelle des
 * invites, post-traitement des masques) et un modèle simulé (les poids ne sont pas téléchargés en test).
 */
import { createRequire } from "node:module";
import { it, expect } from "vitest";
import { hfWorkerMain } from "./hf-worker-runtime";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t: any = require("@huggingface/transformers");

/* eslint-disable @typescript-eslint/no-explicit-any */
it("sam-load / encode / decode / dispose avec le processeur SAM 2 réel", async () => {
  const cfg = { image_processor_type: "Sam2ImageProcessor", do_resize: true, size: { height: 1024, width: 1024 }, resample: 2, do_rescale: true, rescale_factor: 1 / 255, do_normalize: true, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225], do_convert_rgb: true, mask_size: { height: 256, width: 256 } };
  let seen: any = {};
  const fakeModel = {
    async get_image_embeddings({ pixel_values }: any) { seen.pixel = pixel_values.dims; return { "image_embeddings.0": new t.Tensor("float32", new Float32Array(4), [1, 4]) }; },
    async dispose() { seen.disposed = true; },
  };
  const call = async (feed: any) => {
    seen.feed = Object.fromEntries(Object.entries(feed).map(([k, v]: [string, any]) => [k, { dims: v.dims, data: Array.from(v.data).slice(0, 8).map(Number) }]));
    // 3 masques 256x256 : n°1 = carré centré (logits > 0), meilleur score
    const plane = 256 * 256, d = new Float32Array(3 * plane).fill(-5);
    for (let y = 96; y < 160; y++) for (let x = 96; x < 160; x++) d[plane + y * 256 + x] = 5;
    return { pred_masks: new t.Tensor("float32", d, [1, 1, 3, 256, 256]), iou_scores: new t.Tensor("float32", new Float32Array([0.2, 0.9, 0.5]), [1, 1, 3]) };
  };
  const model = Object.assign(call, fakeModel);
  const lib = {
    ...t,
    AutoProcessor: { from_pretrained: async () => new t.Sam2Processor({}, { image_processor: new t.Sam2ImageProcessor(cfg) }, null) },
    AutoModelForMaskGeneration: { from_pretrained: async (repo: string, o: any) => { seen.load = { repo, device: o.device, dtype: o.dtype, revision: o.revision }; return model; } },
  };
  const replies: any[] = [];
  let listener: any;
  hfWorkerMain(lib, { postMessage: (m) => replies.push(m), addEventListener: (_, l) => (listener = l) });
  const ask = (msg: any): Promise<any> => new Promise((res: any) => { const id = Math.random(); listener({ data: { ...msg, id } }); const iv = setInterval(() => { const r = replies.find((x: any) => x.id === id); if (r) { clearInterval(iv); res(r); } }, 5); });

  const ref = { alias: "sam", task: "mask-generation", repo: "onnx-community/sam2.1-hiera-tiny-ONNX", revision: "abc", options: { dtype: "fp16" } };
  let r = await ask({ type: "sam-load", model: ref, devices: ["wasm"] });
  expect(r.ok && r.result.backend === "wasm" && seen.load.dtype === "fp16" && seen.load.revision === "abc", "chargement").toBe(true);
  r = await ask({ type: "sam-decode", alias: "sam", points: [{ x: 1, y: 1, label: 1 }], box: null });
  expect(!r.ok, "décoder sans image : erreur").toBe(true);
  const W = 640, H = 480, data = new Uint8ClampedArray(W * H * 4).fill(128);
  r = await ask({ type: "sam-encode", alias: "sam", image: { width: W, height: H, data } });
  expect(r.ok && JSON.stringify(seen.pixel) === "[1,3,1024,1024]", "encodage : 1024×1024").toBe(true);
  r = await ask({ type: "sam-decode", alias: "sam", points: [{ x: 320, y: 240, label: 1 }, { x: 10, y: 10, label: 0 }], box: null });
  expect(r.ok, "décodage : réponse").toBe(true);
  const f = seen.feed;
  expect(JSON.stringify(f.input_points.dims) === "[1,1,2,2]" && Math.abs(f.input_points.data[0] - 512) < 1 && Math.abs(f.input_points.data[1] - 512) < 1, "points : forme [1,1,2,2], coordonnées à l'échelle 1024").toBe(true);
  expect(JSON.stringify(f.input_labels.dims) === "[1,1,2]" && f.input_labels.data.join() === "1,0", "étiquettes [1,0]").toBe(true);
  expect(!!f["image_embeddings.0"], "embeddings transmis").toBe(true);
  const res = r.result;
  expect(res.width === W && res.height === H && res.index === 1 && Math.abs(res.score - 0.9) < 1e-6, "masque à la taille de l'image, le meilleur retenu").toBe(true);
  const on = res.mask.reduce((a: number, b: number) => a + b / 255, 0);
  expect(res.mask[240 * W + 320] === 255 && res.mask[0] === 0 && Math.abs(on / (W * H) - 1 / 16) < 0.01, "masque : carré central (≈ 1/16 de l'image)").toBe(true);
  r = await ask({ type: "sam-decode", alias: "sam", points: [], box: { x0: 100, y0: 50, x1: 300, y1: 200 } });
  expect(r.ok && JSON.stringify(seen.feed.input_boxes.dims) === "[1,1,4]" && Math.abs(seen.feed.input_boxes.data[0] - 160) < 1 && !seen.feed.input_points, "boîte seule : forme [1,1,4], échelle 1024").toBe(true);
  r = await ask({ type: "sam-decode", alias: "sam", points: [], box: null });
  expect(r.ok && r.result === null, "sans invite : null").toBe(true);
  r = await ask({ type: "sam-dispose", alias: "sam" });
  expect(r.ok && seen.disposed, "libération").toBe(true);

}, 30_000);

it("GPU perdu pendant le calcul : rechargement sur WASM avec la précision WASM, image réencodée, masque rendu", async () => {
  const cfg = { image_processor_type: "Sam2ImageProcessor", do_resize: true, size: { height: 1024, width: 1024 }, resample: 2, do_rescale: true, rescale_factor: 1 / 255, do_normalize: true, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225], do_convert_rgb: true, mask_size: { height: 256, width: 256 } };
  Object.defineProperty(globalThis.navigator, "gpu", { value: { requestAdapter: async () => ({}) }, configurable: true });
  const loads: any[] = [];
  const encodes: string[] = [];
  const disposed: string[] = [];
  const make = (device: string) => {
    const call = async () => {
      if (device === "webgpu") throw new Error("failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost.");
      const plane = 256 * 256, d = new Float32Array(3 * plane).fill(-5);
      for (let i = 0; i < plane; i++) d[i] = 5;
      return { pred_masks: new t.Tensor("float32", d, [1, 1, 3, 256, 256]), iou_scores: new t.Tensor("float32", new Float32Array([0.9, 0.1, 0.1]), [1, 1, 3]) };
    };
    return Object.assign(call, {
      async get_image_embeddings() { encodes.push(device); return { "image_embeddings.0": new t.Tensor("float32", new Float32Array(4), [1, 4]) }; },
      async dispose() { disposed.push(device); },
    });
  };
  const lib = {
    ...t,
    AutoProcessor: { from_pretrained: async () => new t.Sam2Processor({}, { image_processor: new t.Sam2ImageProcessor(cfg) }, null) },
    AutoModelForMaskGeneration: { from_pretrained: async (_repo: string, o: any) => { loads.push({ device: o.device, dtype: o.dtype, extra: o.dtypeByDevice }); return make(o.device); } },
  };
  const replies: any[] = [];
  let listener: any;
  hfWorkerMain(lib, { postMessage: (m) => replies.push(m), addEventListener: (_, l) => (listener = l) });
  const ask = (msg: any): Promise<any> => new Promise((res: any) => { const id = Math.random(); listener({ data: { ...msg, id } }); const iv = setInterval(() => { const r = replies.find((x: any) => x.id === id); if (r) { clearInterval(iv); res(r); } }, 5); });
  try {
    const ref = { alias: "sam", task: "mask-generation", repo: "r", revision: "v", options: { dtype: "fp32", dtypeByDevice: { webgpu: "q4f16", wasm: "q8" } } };
    let r = await ask({ type: "sam-load", model: ref, devices: ["webgpu", "wasm"] });
    expect(r.result.backend).toBe("webgpu");
    expect(loads[0]).toEqual({ device: "webgpu", dtype: "q4f16", extra: undefined });
    r = await ask({ type: "sam-encode", alias: "sam", image: { width: 64, height: 32, data: new Uint8ClampedArray(64 * 32 * 4) } });
    expect(r.ok).toBe(true);
    expect(r.result.backend).toBe("webgpu");
    r = await ask({ type: "sam-decode", alias: "sam", points: [{ x: 10, y: 10, label: 1 }], box: null });
    expect(r.ok).toBe(true);
    expect(r.result.backend).toBe("wasm");
    expect(loads[1]).toEqual({ device: "wasm", dtype: "q8", extra: undefined });
    expect(disposed).toEqual(["webgpu"]);
    expect(encodes).toEqual(["webgpu", "wasm"]);
    expect(r.result.mask.length).toBe(64 * 32);
    expect(r.result.mask.every((v: number) => v === 255)).toBe(true);
    // une erreur qui n'est pas une panne GPU ne déclenche pas de rechargement
    const before = loads.length;
    r = await ask({ type: "sam-decode", alias: "sam", points: [], box: null });
    expect(r.ok).toBe(true);
    expect(loads.length).toBe(before);
  } finally {
    delete (globalThis.navigator as any).gpu;
  }
}, 30_000);

it("bord affiné : le masque se recale sur le contour réel de l'image", async () => {
  const cfg = { image_processor_type: "Sam2ImageProcessor", do_resize: true, size: { height: 1024, width: 1024 }, resample: 2, do_rescale: true, rescale_factor: 1 / 255, do_normalize: true, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225], do_convert_rgb: true, mask_size: { height: 256, width: 256 } };
  // image 1024×512 : sombre à gauche (x < 128), claire à droite ; le masque basse définition du modèle simulé (256 px,
  // soit 4 px d'image par case) déborde d'une case : bord flou vers x = 132
  const W = 1024, H = 512, EDGE = 128;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; data[o] = data[o + 1] = data[o + 2] = x < EDGE ? 40 : 220; data[o + 3] = 255; }
  const model = Object.assign(async () => {
    const plane = 256 * 256, d = new Float32Array(3 * plane);
    for (let k = 0; k < 3; k++) for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) d[k * plane + y * 256 + x] = x < 33 ? 6 : -6;
    return { pred_masks: new t.Tensor("float32", d, [1, 1, 3, 256, 256]), iou_scores: new t.Tensor("float32", new Float32Array([0.9, 0.1, 0.1]), [1, 1, 3]) };
  }, { async get_image_embeddings() { return { "image_embeddings.0": new t.Tensor("float32", new Float32Array(4), [1, 4]) }; } });
  const lib = {
    ...t,
    AutoProcessor: { from_pretrained: async () => new t.Sam2Processor({}, { image_processor: new t.Sam2ImageProcessor(cfg) }, null) },
    AutoModelForMaskGeneration: { from_pretrained: async () => model },
  };
  const replies: any[] = [];
  let listener: any;
  hfWorkerMain(lib, { postMessage: (m) => replies.push(m), addEventListener: (_, l) => (listener = l) });
  const ask = (msg: any): Promise<any> => new Promise((res: any) => { const id = Math.random(); listener({ data: { ...msg, id } }); const iv = setInterval(() => { const r = replies.find((x: any) => x.id === id); if (r) { clearInterval(iv); res(r); } }, 5); });
  await ask({ type: "sam-load", model: { alias: "sam", task: "mask-generation", repo: "r", revision: "v", options: {} }, devices: ["wasm"] });
  await ask({ type: "sam-encode", alias: "sam", image: { width: W, height: H, data } });
  const raw = (await ask({ type: "sam-decode", alias: "sam", points: [{ x: 20, y: 256, label: 1 }], box: null, refine: false })).result;
  const fine = (await ask({ type: "sam-decode", alias: "sam", points: [{ x: 20, y: 256, label: 1 }], box: null })).result;
  const row = (m: Uint8Array) => Array.from(m.slice(256 * W, 257 * W));
  const area = (r: number[]) => r.reduce((a, v) => a + v / 255, 0);
  expect([fine.width, fine.height]).toEqual([W, H]);
  // brut : bord à 132, tout ou rien
  expect(area(row(raw.mask))).toBeGreaterThan(EDGE + 2);
  expect(row(raw.mask).every((v) => v === 0 || v === 255)).toBe(true);
  // affiné : bord ramené sur le contour réel (à un pixel près), intérieur et extérieur nets
  expect(Math.abs(area(row(fine.mask)) - EDGE)).toBeLessThanOrEqual(1);
  expect(row(fine.mask)[EDGE - 6]).toBe(255);
  expect(row(fine.mask)[EDGE]).toBeLessThan(64);
  expect(row(fine.mask)[EDGE + 3]).toBeLessThan(16);
}, 30_000);

it("sortie GPU invalide (NaN) : bascule sur WASM", async () => {
  const cfg = { image_processor_type: "Sam2ImageProcessor", do_resize: true, size: { height: 1024, width: 1024 }, resample: 2, do_rescale: true, rescale_factor: 1 / 255, do_normalize: true, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225], do_convert_rgb: true, mask_size: { height: 256, width: 256 } };
  Object.defineProperty(globalThis.navigator, "gpu", { value: { requestAdapter: async () => ({}) }, configurable: true });
  const loads: string[] = [];
  const make = (device: string) => Object.assign(async () => {
    const plane = 256 * 256, d = new Float32Array(3 * plane).fill(device === "webgpu" ? NaN : 5);
    return { pred_masks: new t.Tensor("float32", d, [1, 1, 3, 256, 256]), iou_scores: new t.Tensor("float32", new Float32Array([0.9, 0.1, 0.1]), [1, 1, 3]) };
  }, { async get_image_embeddings() { return { "image_embeddings.0": new t.Tensor("float32", new Float32Array(4), [1, 4]) }; }, async dispose() {} });
  const lib = {
    ...t,
    AutoProcessor: { from_pretrained: async () => new t.Sam2Processor({}, { image_processor: new t.Sam2ImageProcessor(cfg) }, null) },
    AutoModelForMaskGeneration: { from_pretrained: async (_r: string, o: any) => { loads.push(o.device); return make(o.device); } },
  };
  const replies: any[] = [];
  let listener: any;
  hfWorkerMain(lib, { postMessage: (m) => replies.push(m), addEventListener: (_, l) => (listener = l) });
  const ask = (msg: any): Promise<any> => new Promise((res: any) => { const id = Math.random(); listener({ data: { ...msg, id } }); const iv = setInterval(() => { const r = replies.find((x: any) => x.id === id); if (r) { clearInterval(iv); res(r); } }, 5); });
  try {
    await ask({ type: "sam-load", model: { alias: "sam", repo: "r", revision: "v", options: {} }, devices: ["webgpu", "wasm"] });
    await ask({ type: "sam-encode", alias: "sam", image: { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) } });
    const r = await ask({ type: "sam-decode", alias: "sam", points: [{ x: 5, y: 5, label: 1 }], box: null, refine: false });
    expect(r.ok).toBe(true);
    expect(r.result.backend).toBe("wasm");
    expect(loads).toEqual(["webgpu", "wasm"]);
    expect(r.result.mask.every((v: number) => v === 255)).toBe(true);
  } finally {
    delete (globalThis.navigator as any).gpu;
  }
}, 30_000);

it("précision mixte : embeddings fp16 convertis pour un décodeur fp32, sorties fp16 relues correctement", async () => {
  const cfg = { image_processor_type: "Sam2ImageProcessor", do_resize: true, size: { height: 1024, width: 1024 }, resample: 2, do_rescale: true, rescale_factor: 1 / 255, do_normalize: true, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225], do_convert_rgb: true, mask_size: { height: 256, width: 256 } };
  const half = (v: number) => { const f = new Float32Array([v]); const i = new Uint32Array(f.buffer)[0]; const sgn = (i >>> 16) & 0x8000; const e = ((i >>> 23) & 0xff) - 127 + 15; const m = (i >>> 13) & 0x3ff; if (e <= 0) return sgn; if (e >= 31) return sgn | 0x7c00; return sgn | (e << 10) | m; };
  let calls = 0;
  let seenType = "";
  const model = Object.assign(async (feed: any) => {
    calls++;
    seenType = feed["image_embeddings.0"].type;
    if (seenType !== "float32") throw new Error("Unexpected input data type. Actual: (tensor(float16)) , expected: (tensor(float))");
    // sorties en float16 (bits bruts) : +6 sur la moitié gauche, -6 ailleurs
    const plane = 256 * 256, d = new Uint16Array(3 * plane);
    for (let k = 0; k < 3; k++) for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) d[k * plane + y * 256 + x] = half(x < 128 ? 6 : -6);
    return { pred_masks: new t.Tensor("float16", d, [1, 1, 3, 256, 256]), iou_scores: new t.Tensor("float16", new Uint16Array([half(0.9), half(0.2), half(0.1)]), [1, 1, 3]) };
  }, { async get_image_embeddings() { return { "image_embeddings.0": new t.Tensor("float16", new Uint16Array([half(1.5), half(-2)]), [1, 2]) }; } });
  const lib = {
    ...t,
    AutoProcessor: { from_pretrained: async () => new t.Sam2Processor({}, { image_processor: new t.Sam2ImageProcessor(cfg) }, null) },
    AutoModelForMaskGeneration: { from_pretrained: async () => model },
  };
  const replies: any[] = [];
  let listener: any;
  hfWorkerMain(lib, { postMessage: (m) => replies.push(m), addEventListener: (_, l) => (listener = l) });
  const ask = (msg: any): Promise<any> => new Promise((res: any) => { const id = Math.random(); listener({ data: { ...msg, id } }); const iv = setInterval(() => { const r = replies.find((x: any) => x.id === id); if (r) { clearInterval(iv); res(r); } }, 5); });
  await ask({ type: "sam-load", model: { alias: "sam", repo: "r", revision: "v", options: {} }, devices: ["wasm"] });
  await ask({ type: "sam-encode", alias: "sam", image: { width: 64, height: 32, data: new Uint8ClampedArray(64 * 32 * 4) } });
  let r = await ask({ type: "sam-decode", alias: "sam", points: [{ x: 5, y: 5, label: 1 }], box: null, refine: false });
  expect(r.ok).toBe(true);
  expect(seenType).toBe("float32");
  expect(r.result.score).toBeCloseTo(0.9, 2);
  const row = Array.from(r.result.mask.slice(16 * 64, 17 * 64) as Uint8Array);
  expect(row.slice(0, 30).every((v) => v === 255)).toBe(true);
  expect(row.slice(34).every((v) => v === 0)).toBe(true);
  // conversion faite une fois : le décodage suivant passe directement
  const before = calls;
  r = await ask({ type: "sam-decode", alias: "sam", points: [{ x: 5, y: 5, label: 1 }], box: null, refine: false });
  expect(r.ok).toBe(true);
  expect(calls).toBe(before + 1);
}, 30_000);
