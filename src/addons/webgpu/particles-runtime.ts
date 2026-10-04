/// <reference types="@webgpu/types" />

import { requestBestAdapter, type WebGpuFrameState } from "./gpu-runtime";

const PARTICLE_COUNT = 1200;
const FLOATS_PER_PARTICLE = 4; // x, y, vx, vy
const BYTES_PER_FLOAT = 4;
const WORKGROUP_SIZE = 64;
const VERTICES_PER_PARTICLE = 6;
/** Layout WGSL uniform (align vec4) : 16 × f32 = 64 bytes */
const UNIFORM_FLOATS = 16;

const UNIFORMS_STRUCT = `
struct Uniforms {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  _pad: vec2f,
  params: vec4f,
}
`;

const COMPUTE_WGSL = `
${UNIFORMS_STRUCT}
struct Particle {
  pos: vec2f,
  vel: vec2f,
}
const COUNT: u32 = ${PARTICLE_COUNT}u;
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle, COUNT>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= COUNT) { return; }
  var p = particles[i];
  let speed = 0.35 + u.params.x * 2.2;
  let attract = u.params.y;
  let damp = 0.98;
  var force = vec2f(0.0);
  if (attract > 0.001 && length(u.mouse) > 0.5) {
    let toM = u.mouse - p.pos;
    let d = max(length(toM), 12.0);
    force += normalize(toM) * (attract * 6000.0 / (d * d));
  }
  let c = u.resolution * 0.5;
  let toC = p.pos - c;
  force += vec2f(-toC.y, toC.x) * 0.0025 * speed;
  let stepDt = max(u.dt, 0.008);
  p.vel = (p.vel + force * stepDt) * damp;
  p.pos += p.vel * stepDt * 60.0 * speed;
  if (p.pos.x < 0.0) { p.pos.x += u.resolution.x; }
  if (p.pos.x > u.resolution.x) { p.pos.x -= u.resolution.x; }
  if (p.pos.y < 0.0) { p.pos.y += u.resolution.y; }
  if (p.pos.y > u.resolution.y) { p.pos.y -= u.resolution.y; }
  particles[i] = p;
}
`;

const RENDER_WGSL = `
${UNIFORMS_STRUCT}
struct Particle {
  pos: vec2f,
  vel: vec2f,
}
const COUNT: u32 = ${PARTICLE_COUNT}u;
struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) speed: f32,
  @location(1) local: vec2f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> particles: array<Particle, COUNT>;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  let i = vi / 6u;
  let c = vi % 6u;
  var local = vec2f(0.0);
  if (c == 0u) { local = vec2f(-1.0, -1.0); }
  else if (c == 1u) { local = vec2f(1.0, -1.0); }
  else if (c == 2u) { local = vec2f(-1.0, 1.0); }
  else if (c == 3u) { local = vec2f(-1.0, 1.0); }
  else if (c == 4u) { local = vec2f(1.0, -1.0); }
  else { local = vec2f(1.0, 1.0); }

  let p = particles[i];
  let radius = 2.8;
  let pos = p.pos + local * radius;
  let ndc = (pos / max(u.resolution, vec2f(1.0))) * 2.0 - vec2f(1.0);
  var out: VsOut;
  out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  out.speed = length(p.vel);
  out.local = local;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  let soft = 1.0 - smoothstep(0.55, 1.0, d);
  let t = clamp(in.speed * 0.08, 0.0, 1.0);
  let col = mix(vec3f(0.25, 0.65, 1.0), vec3f(1.0, 0.5, 0.2), t);
  return vec4f(col * soft, soft);
}
`;

/**
 * Noyau compute particules — ce qui démarque WebGPU de sonic-shader.
 * Fallback CPU + Canvas2D si pas d’adapter (même rendu utile en démo).
 */
export class ParticlesRuntime {
  readonly backend: "webgpu" | "canvas2d";
  readonly canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private uniformBuffer: GPUBuffer | null = null;
  private particleBuffer: GPUBuffer | null = null;
  private computePipeline: GPUComputePipeline | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private cpu: Float32Array;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private lastTime = 0;
  private disposed = false;
  private seeded = false;

  private constructor(
    canvas: HTMLCanvasElement,
    backend: "webgpu" | "canvas2d",
  ) {
    this.canvas = canvas;
    this.backend = backend;
    this.cpu = new Float32Array(PARTICLE_COUNT * FLOATS_PER_PARTICLE);
  }

  static async create(canvas: HTMLCanvasElement): Promise<ParticlesRuntime> {
    const gpu = navigator.gpu;
    if (gpu) {
      try {
        const adapter = await requestBestAdapter(gpu);
        if (adapter) {
          const device = await adapter.requestDevice();
          const context = canvas.getContext("webgpu");
          if (context) {
            const format = gpu.getPreferredCanvasFormat();
            context.configure({
              device,
              format,
              alphaMode: "premultiplied",
            });
            const rt = new ParticlesRuntime(canvas, "webgpu");
            rt.device = device;
            rt.context = context;
            rt.format = format;
            rt.initGpu();
            return rt;
          }
          device.destroy();
        }
      } catch {
        /* fall through Canvas2D */
      }
    }
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Particles: ni WebGPU ni Canvas2D");
    const rt = new ParticlesRuntime(canvas, "canvas2d");
    rt.ctx2d = ctx;
    return rt;
  }

  async setShader(_s: string): Promise<void> {}
  async setChannel(_i: 0 | 1 | 2 | 3, _url: string): Promise<void> {}
  getTextureSize(_url: string) {
    return null;
  }

  resize(width: number, height: number) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.context && this.device) {
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });
    }
    this.seed(w, h);
  }

  draw(state: WebGpuFrameState) {
    if (this.disposed) return;
    if (state.width < 2 || state.height < 2) return;
    if (!this.seeded) this.seed(state.width, state.height);
    const dt =
      this.lastTime > 0
        ? Math.min(0.05, Math.max(0.001, state.time - this.lastTime))
        : 0.016;
    this.lastTime = state.time;
    if (this.backend === "webgpu") this.drawGpu(state, dt);
    else this.drawCpu(state, dt);
  }

  dispose(_lose = true) {
    if (this.disposed) return;
    this.disposed = true;
    this.uniformBuffer?.destroy();
    this.particleBuffer?.destroy();
    try {
      this.context?.unconfigure();
    } catch {
      /* ignore */
    }
    this.device?.destroy();
    this.device = null;
  }

  private initGpu() {
    const device = this.device!;
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * BYTES_PER_FLOAT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.particleBuffer = device.createBuffer({
      size: PARTICLE_COUNT * FLOATS_PER_PARTICLE * BYTES_PER_FLOAT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const computeModule = device.createShaderModule({ code: COMPUTE_WGSL });
    const renderModule = device.createShaderModule({ code: RENDER_WGSL });
    this.computePipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: computeModule, entryPoint: "cs_main" },
    });
    this.renderPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: renderModule, entryPoint: "vs_main" },
      fragment: {
        module: renderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  private ensureBindGroups() {
    const device = this.device!;
    if (!this.computePipeline || !this.renderPipeline) return;
    if (this.bindGroup) return;
    this.bindGroup = device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: { buffer: this.particleBuffer! } },
      ],
    });
  }

  private drawGpu(state: WebGpuFrameState, dt: number) {
    const device = this.device!;
    const context = this.context!;
    if (!this.computePipeline || !this.renderPipeline) return;
    // Souris host = origine bas (ShaderToy) ; buffer particules = origine haut
    const fixed: WebGpuFrameState = {
      ...state,
      mouse: [
        state.mouse[0],
        state.height - state.mouse[1],
        state.mouse[2],
        state.height - state.mouse[3],
      ],
    };
    this.writeUniforms(fixed, dt);
    this.ensureBindGroups();
    const renderBg = device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: { buffer: this.particleBuffer! } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const passC = encoder.beginComputePass();
    passC.setPipeline(this.computePipeline);
    passC.setBindGroup(0, this.bindGroup!);
    passC.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / WORKGROUP_SIZE));
    passC.end();
    const passR = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.04, g: 0.05, b: 0.08, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    passR.setPipeline(this.renderPipeline);
    passR.setBindGroup(0, renderBg);
    passR.draw(PARTICLE_COUNT * VERTICES_PER_PARTICLE);
    passR.end();
    device.queue.submit([encoder.finish()]);
  }

  private drawCpu(state: WebGpuFrameState, dt: number) {
    const ctx = this.ctx2d!;
    const w = state.width;
    const h = state.height;
    const speed = 0.35 + state.params[0] * 2.2;
    const attract = state.params[1];
    const mx = state.mouse[0];
    const my = h - state.mouse[1];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const o = i * FLOATS_PER_PARTICLE;
      let x = this.cpu[o];
      let y = this.cpu[o + 1];
      let vx = this.cpu[o + 2];
      let vy = this.cpu[o + 3];
      let fx = 0;
      let fy = 0;
      if (attract > 0.001 && (mx > 0.5 || my > 0.5)) {
        const dx = mx - x;
        const dy = my - y;
        const d = Math.max(Math.hypot(dx, dy), 8);
        const f = (attract * 4000) / (d * d);
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }
      const cx = w * 0.5;
      const cy = h * 0.5;
      fx += -(y - cy) * 0.0008 * speed;
      fy += (x - cx) * 0.0008 * speed;
      vx = (vx + fx * dt) * 0.985;
      vy = (vy + fy * dt) * 0.985;
      x += vx * dt * 60 * speed;
      y += vy * dt * 60 * speed;
      if (x < 0) x += w;
      if (x > w) x -= w;
      if (y < 0) y += h;
      if (y > h) y -= h;
      this.cpu[o] = x;
      this.cpu[o + 1] = y;
      this.cpu[o + 2] = vx;
      this.cpu[o + 3] = vy;
    }
    ctx.fillStyle = "rgb(10, 12, 20)";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const o = i * FLOATS_PER_PARTICLE;
      const sp = Math.hypot(this.cpu[o + 2], this.cpu[o + 3]);
      const t = Math.min(1, sp * 0.08);
      const r = Math.round(51 + t * 204);
      const g = Math.round(140 - t * 25);
      const b = Math.round(255 - t * 204);
      ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
      ctx.fillRect(this.cpu[o], this.cpu[o + 1], 2, 2);
    }
  }

  private writeUniforms(state: WebGpuFrameState, dt: number) {
    // Doit matcher le struct WGSL (padding avant params @ 32 bytes)
    const data = new Float32Array(UNIFORM_FLOATS);
    data[0] = state.width;
    data[1] = state.height;
    data[2] = state.time;
    data[3] = dt;
    data[4] = state.mouse[0];
    data[5] = state.mouse[1];
    data[6] = 0;
    data[7] = 0;
    data[8] = state.params[0];
    data[9] = state.params[1];
    data[10] = state.params[2];
    data[11] = state.params[3];
    this.device!.queue.writeBuffer(
      this.uniformBuffer!,
      0,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  private seed(w: number, h: number) {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const o = i * FLOATS_PER_PARTICLE;
      this.cpu[o] = Math.random() * w;
      this.cpu[o + 1] = Math.random() * h;
      this.cpu[o + 2] = (Math.random() - 0.5) * 2;
      this.cpu[o + 3] = (Math.random() - 0.5) * 2;
    }
    if (this.device && this.particleBuffer) {
      this.device.queue.writeBuffer(
        this.particleBuffer,
        0,
        this.cpu.buffer,
        this.cpu.byteOffset,
        this.cpu.byteLength,
      );
    }
    this.seeded = true;
  }
}
