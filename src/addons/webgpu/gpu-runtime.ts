/// <reference types="@webgpu/types" />

import {
  isFrameSource,
  type SonicFrameSource,
} from "../../shared/mediaRef";
import { shouldUploadElementFrame } from "../shader/gl-runtime";
import { WebGpuCompileError } from "./types";
import { buildWgslSource } from "./wgsl-prelude";

const UNIFORM_BYTES = 64; // resolution+time+frame+mouse+params + pad
const CHANNEL_COUNT = 4;

/** `true` si la texture existante peut être réécrite (même taille). */
export function channelTextureNeedsRecreate(
  current: { width: number; height: number } | null | undefined,
  nextW: number,
  nextH: number,
): boolean {
  if (!current) return true;
  return current.width !== nextW || current.height !== nextH;
}

function externalSourceSize(
  src: TexImageSource,
): { width: number; height: number } {
  if (
    typeof HTMLVideoElement !== "undefined" &&
    src instanceof HTMLVideoElement
  ) {
    return { width: src.videoWidth || 1, height: src.videoHeight || 1 };
  }
  if (
    typeof HTMLImageElement !== "undefined" &&
    src instanceof HTMLImageElement
  ) {
    return {
      width: src.naturalWidth || src.width || 1,
      height: src.naturalHeight || src.height || 1,
    };
  }
  if ("width" in src && "height" in src) {
    return {
      width: Math.max(1, Number(src.width) || 1),
      height: Math.max(1, Number(src.height) || 1),
    };
  }
  return { width: 1, height: 1 };
}

/** Adapter WebGPU : high-performance → low-power → défaut. */
export async function requestBestAdapter(
  gpu: GPU = navigator.gpu!,
): Promise<GPUAdapter | null> {
  return (
    (await gpu.requestAdapter({ powerPreference: "high-performance" })) ??
    (await gpu.requestAdapter({ powerPreference: "low-power" })) ??
    (await gpu.requestAdapter())
  );
}

export type WebGpuFrameState = {
  width: number;
  height: number;
  time: number;
  frame: number;
  mouse: [number, number, number, number];
  params: [number, number, number, number];
};

async function createPlaceholderTexture(
  device: GPUDevice,
): Promise<GPUTexture> {
  const texture = device.createTexture({
    size: [1, 1],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array([0, 0, 0, 0]),
    { bytesPerRow: 4 },
    [1, 1],
  );
  return texture;
}

/**
 * Runtime WebGPU minimal : 1 passe fullscreen + 4 textures + uniforms.
 */
export class WebGpuRuntime {
  readonly backend = "webgpu" as const;
  readonly canvas: HTMLCanvasElement;
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer;
  private sampler: GPUSampler;
  private channelTextures: (GPUTexture | null)[] = [
    null,
    null,
    null,
    null,
  ];
  private channelViews: (GPUTextureView | null)[] = [
    null,
    null,
    null,
    null,
  ];
  private channelSizes: ({ width: number; height: number } | null)[] = [
    null,
    null,
    null,
    null,
  ];
  private channelUrls: [string, string, string, string] = ["", "", "", ""];
  private channelLastSeq = [0, 0, 0, 0];
  private channelLastSrc: (string | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  private placeholder: GPUTexture | null = null;
  private placeholderView: GPUTextureView | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private disposed = false;
  /** Un token par canal — un token global annulait Promise.all(setChannel×4). */
  private channelLoadTokens = [0, 0, 0, 0];

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  /**
   * Teste WebGPU sans toucher au canvas (évite de le verrouiller si échec).
   * @returns `null` si OK, sinon raison courte.
   */
  static async probe(): Promise<string | null> {
    const gpu = navigator.gpu;
    if (!gpu) return "WebGPU indisponible (pas de navigator.gpu)";
    try {
      const adapter = await requestBestAdapter(gpu);
      if (!adapter) return "WebGPU adapter indisponible";
      const device = await adapter.requestDevice();
      device.destroy();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  static async create(canvas: HTMLCanvasElement): Promise<WebGpuRuntime> {
    const gpu = navigator.gpu;
    if (!gpu) {
      throw new Error("WebGPU indisponible (pas de navigator.gpu)");
    }
    const adapter = await requestBestAdapter(gpu);
    if (!adapter) {
      throw new Error("WebGPU adapter indisponible");
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) {
      device.destroy();
      throw new Error("WebGPU canvas context indisponible");
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      alphaMode: "premultiplied",
    });
    const runtime = new WebGpuRuntime(canvas, device, context, format);
    runtime.placeholder = await createPlaceholderTexture(device);
    runtime.placeholderView = runtime.placeholder.createView();
    return runtime;
  }

  async setShader(userBody: string): Promise<void> {
    this.assertAlive();
    let source: string;
    try {
      source = buildWgslSource(userBody);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new WebGpuCompileError(message);
    }
    const module = this.device.createShaderModule({ code: source });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) {
      throw new WebGpuCompileError(
        "WGSL compile error",
        errors.map((m) => m.message).join("\n"),
      );
    }
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.bindGroup = null;
  }

  async setChannel(index: 0 | 1 | 2 | 3, url: string): Promise<void> {
    this.assertAlive();
    const trimmed = url.trim();
    if (trimmed.startsWith("#")) {
      this.bindElementChannel(index, trimmed);
      return;
    }
    if (this.channelUrls[index] === trimmed && this.channelTextures[index]) {
      return;
    }
    this.channelUrls[index] = trimmed;
    this.channelLastSeq[index] = 0;
    this.channelLastSrc[index] = undefined;
    const token = ++this.channelLoadTokens[index];
    if (!trimmed) {
      this.destroyChannel(index);
      this.bindGroup = null;
      return;
    }
    const img = await loadImage(trimmed);
    if (token !== this.channelLoadTokens[index] || this.disposed) return;
    this.uploadExternal(index, img, /* flipY */ false);
  }

  /**
   * Upload live des canaux `#id` / FrameSource / video / canvas.
   * Recrée la texture seulement si la taille change (pas de createTexture chaque frame).
   */
  updateLiveChannels(resolveEl: (key: string) => Element | null) {
    this.assertAlive();
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const key = this.channelUrls[i];
      if (!key.startsWith("#")) continue;
      const el = resolveEl(key);
      const decision = shouldUploadElementFrame(
        el,
        this.channelLastSeq[i],
        this.channelLastSrc[i],
      );
      if (!decision.upload || !decision.texSource) continue;
      this.uploadExternal(i, decision.texSource, /* flipY */ true);
      if (isFrameSource(el)) {
        this.channelLastSeq[i] = (el as SonicFrameSource).frameSeq;
      } else {
        this.channelLastSeq[i] = (this.channelLastSeq[i] || 0) + 1;
      }
      if (decision.nextSrc !== undefined) {
        this.channelLastSrc[i] = decision.nextSrc;
      }
    }
  }

  getTextureSize(url: string): { width: number; height: number } | null {
    const i = this.channelUrls.indexOf(url.trim());
    if (i < 0) return null;
    return this.channelSizes[i];
  }

  resize(width: number, height: number) {
    this.assertAlive();
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "premultiplied",
    });
  }

  draw(state: WebGpuFrameState) {
    this.assertAlive();
    if (!this.pipeline || !this.placeholderView) return;
    this.writeUniforms(state);
    if (!this.bindGroup) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          {
            binding: 1,
            resource: this.channelViews[0] ?? this.placeholderView,
          },
          {
            binding: 2,
            resource: this.channelViews[1] ?? this.placeholderView,
          },
          {
            binding: 3,
            resource: this.channelViews[2] ?? this.placeholderView,
          },
          {
            binding: 4,
            resource: this.channelViews[3] ?? this.placeholderView,
          },
          { binding: 5, resource: this.sampler },
        ],
      });
    }
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(destroyDevice = false) {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      this.channelLoadTokens[i]++;
      this.destroyChannel(i);
    }
    this.placeholder?.destroy();
    this.placeholder = null;
    this.placeholderView = null;
    this.uniformBuffer.destroy();
    this.pipeline = null;
    this.bindGroup = null;
    try {
      this.context.unconfigure();
    } catch {
      /* ignore */
    }
    if (destroyDevice) {
      try {
        this.device.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  private bindElementChannel(index: 0 | 1 | 2 | 3, key: string) {
    if (this.channelUrls[index] === key && this.channelTextures[index]) {
      return;
    }
    this.channelUrls[index] = key;
    this.channelLastSeq[index] = 0;
    this.channelLastSrc[index] = undefined;
    this.channelLoadTokens[index]++;
    if (!this.channelTextures[index]) {
      const texture = this.device.createTexture({
        size: [1, 1],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.writeTexture(
        { texture },
        new Uint8Array([0, 0, 0, 255]),
        { bytesPerRow: 4 },
        [1, 1],
      );
      this.channelTextures[index] = texture;
      this.channelViews[index] = texture.createView();
      this.channelSizes[index] = { width: 1, height: 1 };
      this.bindGroup = null;
    }
  }

  private uploadExternal(
    index: number,
    source: TexImageSource,
    flipY: boolean,
  ) {
    const { width, height } = externalSourceSize(source);
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const existing = this.channelTextures[index];
    if (
      existing &&
      !channelTextureNeedsRecreate(this.channelSizes[index], w, h)
    ) {
      this.device.queue.copyExternalImageToTexture(
        { source, flipY },
        { texture: existing },
        [w, h],
      );
      return;
    }
    const texture = this.device.createTexture({
      size: [w, h],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source, flipY },
      { texture },
      [w, h],
    );
    this.destroyChannel(index);
    this.channelTextures[index] = texture;
    this.channelViews[index] = texture.createView();
    this.channelSizes[index] = { width: w, height: h };
    this.bindGroup = null;
  }

  private writeUniforms(state: WebGpuFrameState) {
    const data = new ArrayBuffer(UNIFORM_BYTES);
    const f32 = new Float32Array(data);
    f32[0] = state.width;
    f32[1] = state.height;
    f32[2] = state.time;
    f32[3] = state.frame;
    f32[4] = state.mouse[0];
    f32[5] = state.mouse[1];
    f32[6] = state.mouse[2];
    f32[7] = state.mouse[3];
    f32[8] = state.params[0];
    f32[9] = state.params[1];
    f32[10] = state.params[2];
    f32[11] = state.params[3];
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  private destroyChannel(index: number) {
    this.channelTextures[index]?.destroy();
    this.channelTextures[index] = null;
    this.channelViews[index] = null;
    this.channelSizes[index] = null;
  }

  private assertAlive() {
    if (this.disposed) throw new Error("WebGPU runtime disposed");
  }
}

async function loadImage(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load texture: ${url}`);
  const blob = await res.blob();
  return createImageBitmap(blob);
}
