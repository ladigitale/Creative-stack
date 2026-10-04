import {
  isFrameSource,
  type SonicFrameSource,
} from "../../shared/mediaRef";
import { buildFragmentSource, FULLSCREEN_VERTEX } from "./shadertoy-prelude";
import {
  ChannelSource,
  PassChannels,
  ReadRectResult,
  ShaderBufferFormat,
  ShaderCompileError,
  ShaderPassId,
  ShaderSources,
  parseBufferFormat,
} from "./types";

const PASS_ORDER: ShaderPassId[] = [
  "bufferA",
  "bufferB",
  "bufferC",
  "bufferD",
  "image",
];

const BUFFER_PASSES: Exclude<ShaderPassId, "image">[] = [
  "bufferA",
  "bufferB",
  "bufferC",
  "bufferD",
];

type GLProgram = {
  program: WebGLProgram;
  uniforms: UniformLocs;
};

type UniformLocs = {
  iResolution: WebGLUniformLocation | null;
  iTime: WebGLUniformLocation | null;
  iTimeDelta: WebGLUniformLocation | null;
  iFrameRate: WebGLUniformLocation | null;
  iFrame: WebGLUniformLocation | null;
  iMouse: WebGLUniformLocation | null;
  iDate: WebGLUniformLocation | null;
  iSampleRate: WebGLUniformLocation | null;
  iChannelTime: WebGLUniformLocation | null;
  iChannelResolution: WebGLUniformLocation | null;
  iChannel: (WebGLUniformLocation | null)[];
  uParam: (WebGLUniformLocation | null)[];
};

type PingPong = {
  textures: [WebGLTexture, WebGLTexture];
  framebuffers: [WebGLFramebuffer, WebGLFramebuffer];
  index: number;
};

type ExternalTexture = {
  texture: WebGLTexture;
  width: number;
  height: number;
  url: string;
  video?: HTMLVideoElement;
  /** Source live (`#élément`) — image / vidéo / canvas / SonicFrameSource. */
  source?: TexImageSource | SonicFrameSource | null;
  lastSeq: number;
  lastSrc?: string;
};

export type FrameUniforms = {
  time: number;
  timeDelta: number;
  frame: number;
  mouse: [number, number, number, number];
  params: [number, number, number, number];
};

/**
 * Décide si un slot élément doit être re-uploadé cette frame.
 * Exporté pour les tests unitaires (stratégie par type).
 */
export function shouldUploadElementFrame(
  source: unknown,
  lastSeq: number,
  lastSrc?: string,
): { upload: boolean; texSource: TexImageSource | null; nextSrc?: string } {
  if (!source) return { upload: false, texSource: null };
  if (
    typeof HTMLImageElement !== "undefined" &&
    source instanceof HTMLImageElement
  ) {
    const src = source.currentSrc || source.src || "";
    if (!src || !source.complete || source.naturalWidth < 1) {
      return { upload: false, texSource: null };
    }
    if (lastSrc === src && lastSeq > 0) {
      return { upload: false, texSource: null, nextSrc: src };
    }
    return { upload: true, texSource: source, nextSrc: src };
  }
  if (
    typeof HTMLVideoElement !== "undefined" &&
    source instanceof HTMLVideoElement
  ) {
    if (source.readyState < 2 || source.videoWidth < 1) {
      return { upload: false, texSource: null };
    }
    return { upload: true, texSource: source };
  }
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    source instanceof HTMLCanvasElement
  ) {
    if (source.width < 1 || source.height < 1) {
      return { upload: false, texSource: null };
    }
    return { upload: true, texSource: source };
  }
  if (isFrameSource(source)) {
    if (source.frameSeq === lastSeq) {
      return { upload: false, texSource: null };
    }
    const canvas = source.getFrameCanvas();
    if (!canvas || canvas.width < 1 || canvas.height < 1) {
      return { upload: false, texSource: null };
    }
    return { upload: true, texSource: canvas };
  }
  return { upload: false, texSource: null };
}

function isVideoUrl(url: string): boolean {
  return /\.(webm|mp4|ogg|mov)(\?|#|$)/i.test(url);
}

function texImageSourceSize(
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

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  pass: ShaderPassId | "vertex",
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new ShaderCompileError("Unable to create shader", pass, "");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const infoLog = gl.getShaderInfoLog(shader) || "";
    gl.deleteShader(shader);
    throw new ShaderCompileError(
      `Compile error (${pass}): ${infoLog}`,
      pass,
      infoLog,
    );
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vs: WebGLShader,
  fs: WebGLShader,
  pass: ShaderPassId,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new ShaderCompileError("Unable to create program", "link", "");
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const infoLog = gl.getProgramInfoLog(program) || "";
    gl.deleteProgram(program);
    throw new ShaderCompileError(
      `Link error (${pass}): ${infoLog}`,
      "link",
      infoLog,
    );
  }
  return program;
}

function getUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): UniformLocs {
  return {
    iResolution: gl.getUniformLocation(program, "iResolution"),
    iTime: gl.getUniformLocation(program, "iTime"),
    iTimeDelta: gl.getUniformLocation(program, "iTimeDelta"),
    iFrameRate: gl.getUniformLocation(program, "iFrameRate"),
    iFrame: gl.getUniformLocation(program, "iFrame"),
    iMouse: gl.getUniformLocation(program, "iMouse"),
    iDate: gl.getUniformLocation(program, "iDate"),
    iSampleRate: gl.getUniformLocation(program, "iSampleRate"),
    iChannelTime:
      gl.getUniformLocation(program, "iChannelTime[0]") ||
      gl.getUniformLocation(program, "iChannelTime"),
    iChannelResolution:
      gl.getUniformLocation(program, "iChannelResolution[0]") ||
      gl.getUniformLocation(program, "iChannelResolution"),
    iChannel: [0, 1, 2, 3].map((i) =>
      gl.getUniformLocation(program, `iChannel${i}`),
    ),
    uParam: [0, 1, 2, 3].map((i) =>
      gl.getUniformLocation(program, `uParam${i}`),
    ),
  };
}

type BufferGlFormat = {
  requested: ShaderBufferFormat;
  active: ShaderBufferFormat;
  internal: number;
  format: number;
  type: number;
  filter: number;
  float: boolean;
};

let warnedFloatFallback = false;

/**
 * Résout le format GPU des buffers A–D.
 * Exporté pour tests (mock `getExtension`).
 */
export function resolveBufferGlFormat(
  gl: WebGL2RenderingContext,
  requested: ShaderBufferFormat,
): BufferGlFormat {
  const want = parseBufferFormat(requested);
  if (want === "rgba8") {
    return {
      requested: want,
      active: "rgba8",
      internal: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      filter: gl.LINEAR,
      float: false,
    };
  }
  const ext = gl.getExtension("EXT_color_buffer_float");
  if (!ext) {
    if (!warnedFloatFallback) {
      warnedFloatFallback = true;
      console.warn(
        `[sonic-shader] buffer-format="${want}" indisponible (pas d'EXT_color_buffer_float) → rgba8`,
      );
    }
    return resolveBufferGlFormat(gl, "rgba8");
  }
  if (want === "rgba16f") {
    return {
      requested: want,
      active: "rgba16f",
      internal: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
      filter: gl.LINEAR,
      float: true,
    };
  }
  // rgba32f
  const linearOk = !!gl.getExtension("OES_texture_float_linear");
  return {
    requested: want,
    active: "rgba32f",
    internal: gl.RGBA32F,
    format: gl.RGBA,
    type: gl.FLOAT,
    filter: linearOk ? gl.LINEAR : gl.NEAREST,
    float: true,
  };
}

/** Reset du warn unique (tests). */
export function resetBufferFormatWarnFlag() {
  warnedFloatFallback = false;
}

function createEmptyTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  fmt?: BufferGlFormat,
): WebGLTexture {
  const f =
    fmt ??
    ({
      requested: "rgba8",
      active: "rgba8",
      internal: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      filter: gl.LINEAR,
      float: false,
    } satisfies BufferGlFormat);
  const tex = gl.createTexture();
  if (!tex) throw new Error("Unable to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    f.internal,
    width,
    height,
    0,
    f.format,
    f.type,
    null,
  );
  return tex;
}

function createFramebuffer(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  if (!fb) throw new Error("Unable to create framebuffer");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Incomplete framebuffer: ${status}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fb;
}

function createPingPong(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  fmt: BufferGlFormat,
): PingPong {
  const textures: [WebGLTexture, WebGLTexture] = [
    createEmptyTexture(gl, width, height, fmt),
    createEmptyTexture(gl, width, height, fmt),
  ];
  const framebuffers: [WebGLFramebuffer, WebGLFramebuffer] = [
    createFramebuffer(gl, textures[0]),
    createFramebuffer(gl, textures[1]),
  ];
  return { textures, framebuffers, index: 0 };
}

function destroyPingPong(gl: WebGL2RenderingContext, pp: PingPong) {
  for (const t of pp.textures) gl.deleteTexture(t);
  for (const f of pp.framebuffers) gl.deleteFramebuffer(f);
}

export function parseChannelSource(
  value: string | undefined | null,
  fallbackUrl: string,
): ChannelSource {
  const v = (value ?? "").trim();
  if (!v) {
    const fb = (fallbackUrl ?? "").trim();
    if (fb.startsWith("#")) return { kind: "element", key: fb };
    return fb ? { kind: "url", url: fb } : { kind: "none" };
  }
  if (v.startsWith("#")) {
    return { kind: "element", key: v };
  }
  const lower = v.toLowerCase();
  if (lower === "self") return { kind: "self" };
  if (lower === "buffer-a" || lower === "buffera" || lower === "a") {
    return { kind: "buffer", buffer: "bufferA" };
  }
  if (lower === "buffer-b" || lower === "bufferb" || lower === "b") {
    return { kind: "buffer", buffer: "bufferB" };
  }
  if (lower === "buffer-c" || lower === "bufferc" || lower === "c") {
    return { kind: "buffer", buffer: "bufferC" };
  }
  if (lower === "buffer-d" || lower === "bufferd" || lower === "d") {
    return { kind: "buffer", buffer: "bufferD" };
  }
  if (lower === "none" || lower === "null") return { kind: "none" };
  return { kind: "url", url: v };
}

export class ShaderToyRuntime {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private vao: WebGLVertexArrayObject | null = null;
  private vertexShader: WebGLShader | null = null;
  private programs = new Map<ShaderPassId, GLProgram>();
  private buffers = new Map<Exclude<ShaderPassId, "image">, PingPong>();
  private external = new Map<string, ExternalTexture>();
  private width = 0;
  private height = 0;
  private passChannels = new Map<ShaderPassId, PassChannels>();
  private activePasses: ShaderPassId[] = [];
  private blackTexture: WebGLTexture | null = null;
  private elementResolver: ((key: string) => Element | null) | null = null;
  private bufferFmt: BufferGlFormat;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
      // true : readPixels (sample / extract) fiable après draw
      preserveDrawingBuffer: true,
      powerPreference: "default",
    });
    if (!gl || gl.isContextLost()) {
      throw new Error("WebGL2 not available");
    }
    this.canvas = canvas;
    this.gl = gl;
    this.bufferFmt = resolveBufferGlFormat(gl, "rgba8");
    this.initGeometry();
    this.blackTexture = createEmptyTexture(gl, 1, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.blackTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
  }

  /** Format réellement utilisé pour les buffers A–D (après repli éventuel). */
  get activeBufferFormat(): ShaderBufferFormat {
    return this.bufferFmt.active;
  }

  /**
   * Change le format des buffers A–D. Recrée les FBO si la taille est déjà connue.
   * Retourne le format actif (peut différer si extension manquante).
   */
  setBufferFormat(requested: ShaderBufferFormat): ShaderBufferFormat {
    const next = resolveBufferGlFormat(this.gl, requested);
    if (
      next.active === this.bufferFmt.active &&
      next.filter === this.bufferFmt.filter
    ) {
      this.bufferFmt = next;
      return next.active;
    }
    this.bufferFmt = next;
    if (this.width >= 1 && this.height >= 1) {
      for (const id of BUFFER_PASSES) {
        const existing = this.buffers.get(id);
        if (existing) destroyPingPong(this.gl, existing);
        if (this.programs.has(id)) {
          this.buffers.set(
            id,
            createPingPong(this.gl, this.width, this.height, this.bufferFmt),
          );
        } else {
          this.buffers.delete(id);
        }
      }
    }
    return next.active;
  }

  /** True si le contexte a été perdu / déjà disposé. */
  get isLost(): boolean {
    return this.gl.isContextLost();
  }

  private initGeometry() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Unable to create VAO");
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Fullscreen triangle
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  resize(width: number, height: number) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const id of BUFFER_PASSES) {
      const existing = this.buffers.get(id);
      if (existing) destroyPingPong(this.gl, existing);
      if (this.programs.has(id)) {
        this.buffers.set(
          id,
          createPingPong(this.gl, w, h, this.bufferFmt),
        );
      }
    }
  }

  setSources(sources: ShaderSources, channels: Map<ShaderPassId, PassChannels>) {
    if (this.gl.isContextLost()) {
      throw new Error("WebGL context lost");
    }
    this.disposePrograms();
    this.passChannels = channels;
    this.activePasses = [];
    this.vertexShader = compileShader(
      this.gl,
      this.gl.VERTEX_SHADER,
      FULLSCREEN_VERTEX,
      "vertex",
    );

    for (const pass of PASS_ORDER) {
      const code =
        pass === "image"
          ? sources.image
          : sources[pass as keyof ShaderSources];
      if (!code?.trim()) continue;
      const fsSource = buildFragmentSource(sources.common || "", code);
      const fs = compileShader(
        this.gl,
        this.gl.FRAGMENT_SHADER,
        fsSource,
        pass,
      );
      const program = linkProgram(this.gl, this.vertexShader, fs, pass);
      this.gl.deleteShader(fs);
      this.programs.set(pass, {
        program,
        uniforms: getUniforms(this.gl, program),
      });
      this.activePasses.push(pass);
      if (pass !== "image" && this.width > 0) {
        const prev = this.buffers.get(pass);
        if (prev) destroyPingPong(this.gl, prev);
        this.buffers.set(
          pass,
          createPingPong(this.gl, this.width, this.height, this.bufferFmt),
        );
      }
    }

    if (!this.programs.has("image")) {
      throw new ShaderCompileError(
        "image pass is required",
        "image",
        "Missing image shader source",
      );
    }
  }

  /**
   * Met à jour les bindings de canaux sans recompiler les programmes.
   * Les URLs / clés `#élément` absentes des textures sont allouées à la demande
   * (via `ensureTextures` / `ensureElementTexture` côté composant).
   */
  setPassChannels(channels: Map<ShaderPassId, PassChannels>) {
    if (this.gl.isContextLost()) {
      throw new Error("WebGL context lost");
    }
    this.passChannels = channels;
  }

  async ensureTextures(urls: string[]) {
    const unique = [...new Set(urls.filter(Boolean))];
    await Promise.all(unique.map((url) => this.loadTexture(url)));
  }

  /** Alloue un slot texture vide pour un canal `#élément` (upload live ensuite). */
  ensureElementTexture(key: string) {
    if (this.external.has(key)) return;
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    this.external.set(key, {
      texture: tex,
      width: 1,
      height: 1,
      url: key,
      lastSeq: 0,
    });
  }

  /**
   * Upload live des canaux élément / vidéo.
   * `resolveEl(key)` fournit l’Element (résolution `#id` côté host).
   */
  updateElementTextures(resolveEl?: (key: string) => Element | null) {
    const gl = this.gl;
    for (const [key, ext] of this.external) {
      let source: unknown = ext.video ?? ext.source ?? null;
      // Canaux #id : re-résoudre chaque frame (élément peut apparaître / partir).
      if (key.startsWith("#") && resolveEl) {
        source = resolveEl(key);
        ext.source = source as TexImageSource | SonicFrameSource | null;
      }
      if (
        typeof HTMLVideoElement !== "undefined" &&
        source instanceof HTMLVideoElement
      ) {
        ext.video = source;
      }
      const decision = shouldUploadElementFrame(
        source,
        ext.lastSeq,
        ext.lastSrc,
      );
      if (!decision.upload || !decision.texSource) continue;
      const size = texImageSourceSize(decision.texSource);
      gl.bindTexture(gl.TEXTURE_2D, ext.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      if (ext.width === size.width && ext.height === size.height && ext.lastSeq > 0) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          decision.texSource,
        );
      } else {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          decision.texSource,
        );
        ext.width = size.width;
        ext.height = size.height;
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      if (isFrameSource(source)) {
        ext.lastSeq = source.frameSeq;
      } else {
        ext.lastSeq = (ext.lastSeq || 0) + 1;
      }
      if (decision.nextSrc !== undefined) ext.lastSrc = decision.nextSrc;
    }
  }

  /** @deprecated alias — préférer `updateElementTextures`. */
  updateVideoTextures() {
    this.updateElementTextures();
  }

  setVideosPlaying(playing: boolean) {
    for (const ext of this.external.values()) {
      const video =
        ext.video ||
        (typeof HTMLVideoElement !== "undefined" &&
        ext.source instanceof HTMLVideoElement
          ? ext.source
          : null);
      if (!video) continue;
      if (playing) {
        void video.play().catch(() => {});
      } else {
        video.pause();
      }
    }
  }

  /** Size of a loaded external texture/video, if any. */
  getTextureSize(url: string): { width: number; height: number } | null {
    const ext = this.external.get(url);
    if (!ext || ext.width < 1 || ext.height < 1) return null;
    return { width: ext.width, height: ext.height };
  }

  private loadTexture(url: string): Promise<void> {
    const existing = this.external.get(url);
    if (existing) return Promise.resolve();
    if (isVideoUrl(url)) return this.loadVideoTexture(url);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const gl = this.gl;
        const tex = gl.createTexture();
        if (!tex) {
          reject(new Error("Unable to create texture"));
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        this.external.set(url, {
          texture: tex,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          url,
          lastSeq: 0,
        });
        resolve();
      };
      img.onerror = () => reject(new Error(`Failed to load texture: ${url}`));
      img.src = url;
    });
  }

  private loadVideoTexture(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to load video: ${url}`));
      };
      const ready = () => {
        if (settled) return;
        if (!video.videoWidth) return;
        settled = true;
        const gl = this.gl;
        const tex = gl.createTexture();
        if (!tex) {
          reject(new Error("Unable to create texture"));
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          video,
        );
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        this.external.set(url, {
          texture: tex,
          width: video.videoWidth,
          height: video.videoHeight,
          url,
          video,
          lastSeq: 0,
        });
        void video.play().catch(() => {});
        resolve();
      };
      video.addEventListener("loadeddata", ready);
      video.addEventListener("error", fail);
      video.src = url;
      video.load();
    });
  }

  private resolveChannel(
    pass: ShaderPassId,
    source: ChannelSource,
  ): { texture: WebGLTexture; width: number; height: number } {
    const black = {
      texture: this.blackTexture!,
      width: 1,
      height: 1,
    };
    if (source.kind === "none") return black;
    if (source.kind === "url" || source.kind === "element") {
      const key = source.kind === "url" ? source.url : source.key;
      const ext = this.external.get(key);
      return ext
        ? { texture: ext.texture, width: ext.width, height: ext.height }
        : black;
    }
    const bufferId =
      source.kind === "self"
        ? pass === "image"
          ? null
          : pass
        : source.buffer;
    if (!bufferId) return black;
    const pp = this.buffers.get(bufferId);
    if (!pp) return black;
    // pp.index is the last completed write. During a self-feedback pass it
    // still points at the previous frame until after drawArrays.
    return {
      texture: pp.textures[pp.index],
      width: this.width,
      height: this.height,
    };
  }

  private bindChannels(pass: ShaderPassId, uniforms: UniformLocs) {
    const gl = this.gl;
    const channels =
      this.passChannels.get(pass) ||
      ([
        { kind: "none" },
        { kind: "none" },
        { kind: "none" },
        { kind: "none" },
      ] as PassChannels);
    const resolutions: number[] = [];
    for (let i = 0; i < 4; i++) {
      const resolved = this.resolveChannel(pass, channels[i]);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, resolved.texture);
      if (uniforms.iChannel[i]) {
        gl.uniform1i(uniforms.iChannel[i], i);
      }
      resolutions.push(resolved.width, resolved.height, 1);
    }
    if (uniforms.iChannelResolution) {
      gl.uniform3fv(uniforms.iChannelResolution, resolutions);
    }
    if (uniforms.iChannelTime) {
      gl.uniform1fv(uniforms.iChannelTime, [0, 0, 0, 0]);
    }
  }

  private setCommonUniforms(uniforms: UniformLocs, frame: FrameUniforms) {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    if (uniforms.iResolution) gl.uniform3f(uniforms.iResolution, w, h, 1);
    if (uniforms.iTime) gl.uniform1f(uniforms.iTime, frame.time);
    if (uniforms.iTimeDelta) gl.uniform1f(uniforms.iTimeDelta, frame.timeDelta);
    if (uniforms.iFrameRate) {
      gl.uniform1f(
        uniforms.iFrameRate,
        frame.timeDelta > 0 ? 1 / frame.timeDelta : 60,
      );
    }
    if (uniforms.iFrame) gl.uniform1i(uniforms.iFrame, frame.frame);
    if (uniforms.iMouse) {
      gl.uniform4f(
        uniforms.iMouse,
        frame.mouse[0],
        frame.mouse[1],
        frame.mouse[2],
        frame.mouse[3],
      );
    }
    if (uniforms.iDate) {
      const d = new Date();
      gl.uniform4f(
        uniforms.iDate,
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        d.getHours() * 3600 +
          d.getMinutes() * 60 +
          d.getSeconds() +
          d.getMilliseconds() * 0.001,
      );
    }
    if (uniforms.iSampleRate) gl.uniform1f(uniforms.iSampleRate, 44100);
    for (let i = 0; i < 4; i++) {
      if (uniforms.uParam[i]) {
        gl.uniform1f(uniforms.uParam[i], frame.params[i]);
      }
    }
  }

  /** Host fournit la résolution `#id` / live Element. */
  setElementResolver(fn: ((key: string) => Element | null) | null) {
    this.elementResolver = fn;
  }

  render(frame: FrameUniforms) {
    const gl = this.gl;
    if (!this.vao || this.width < 1 || this.height < 1) return;
    this.updateElementTextures(this.elementResolver ?? undefined);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    for (const pass of this.activePasses) {
      if (pass === "image") continue;
      const gp = this.programs.get(pass);
      const pp = this.buffers.get(pass);
      if (!gp || !pp) continue;
      const writeIndex = 1 - pp.index;
      gl.bindFramebuffer(gl.FRAMEBUFFER, pp.framebuffers[writeIndex]);
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(gp.program);
      this.setCommonUniforms(gp.uniforms, frame);
      this.bindChannels(pass, gp.uniforms);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      pp.index = writeIndex;
    }

    const image = this.programs.get("image");
    if (!image) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(image.program);
    this.setCommonUniforms(image.uniforms, frame);
    this.bindChannels("image", image.uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * Lit un rectangle du framebuffer Image (origine bas-gauche, coords drawing buffer).
   * À appeler juste après `render`.
   */
  readRect(x: number, y: number, w: number, h: number): ReadRectResult | null {
    return this.readFramebufferRect(null, x, y, w, h);
  }

  /**
   * Lit un rectangle d’un buffer ping-pong (dernier write) ou de l’Image (`pass === "image"`).
   * Les buffers flottants renvoient un `Float32Array` ; Image / rgba8 → `Uint8Array`.
   */
  readBufferRect(
    pass: ShaderPassId,
    x: number,
    y: number,
    w: number,
    h: number,
  ): ReadRectResult | null {
    if (pass === "image") return this.readRect(x, y, w, h);
    const pp = this.buffers.get(pass);
    if (!pp) return null;
    return this.readFramebufferRect(
      pp.framebuffers[pp.index],
      x,
      y,
      w,
      h,
      this.bufferFmt.float,
    );
  }

  /**
   * Lit 1 px du framebuffer Image (origine bas-gauche, coords drawing buffer).
   * À appeler juste après `render`.
   */
  readPixel(x: number, y: number): [number, number, number, number] {
    const rect = this.readRect(Math.floor(x), Math.floor(y), 1, 1);
    if (!rect || rect.data.length < 4) return [0, 0, 0, 0];
    return [rect.data[0], rect.data[1], rect.data[2], rect.data[3]];
  }

  private readFramebufferRect(
    framebuffer: WebGLFramebuffer | null,
    x: number,
    y: number,
    w: number,
    h: number,
    asFloat = false,
  ): ReadRectResult | null {
    const gl = this.gl;
    if (gl.isContextLost() || this.width < 1 || this.height < 1) return null;
    let px = Math.floor(x);
    let py = Math.floor(y);
    let pw = Math.floor(w);
    let ph = Math.floor(h);
    if (pw < 1 || ph < 1) return null;
    if (px < 0) {
      pw += px;
      px = 0;
    }
    if (py < 0) {
      ph += py;
      py = 0;
    }
    if (px + pw > this.width) pw = this.width - px;
    if (py + ph > this.height) ph = this.height - py;
    if (pw < 1 || ph < 1) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    let data: Uint8Array | Float32Array;
    if (asFloat) {
      data = new Float32Array(pw * ph * 4);
      gl.readPixels(px, py, pw, ph, gl.RGBA, gl.FLOAT, data);
    } else {
      data = new Uint8Array(pw * ph * 4);
      gl.readPixels(px, py, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { x: px, y: py, width: pw, height: ph, data };
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  disposePrograms() {
    for (const gp of this.programs.values()) {
      this.gl.deleteProgram(gp.program);
    }
    this.programs.clear();
    this.activePasses = [];
    if (this.vertexShader) {
      this.gl.deleteShader(this.vertexShader);
      this.vertexShader = null;
    }
  }

  /**
   * Libère les ressources GPU.
   * @param loseContext - si true, libère aussi le slot navigateur (~8–16 max).
   *   Après lose, il faut un **nouveau** canvas (ou restoreContext) pour réutiliser.
   */
  dispose(loseContext = true) {
    if (!this.gl.isContextLost()) {
      this.disposePrograms();
      for (const pp of this.buffers.values()) {
        destroyPingPong(this.gl, pp);
      }
      this.buffers.clear();
      for (const ext of this.external.values()) {
        if (ext.video) {
          ext.video.pause();
          ext.video.removeAttribute("src");
          ext.video.load();
        }
        this.gl.deleteTexture(ext.texture);
      }
      this.external.clear();
      if (this.blackTexture) {
        this.gl.deleteTexture(this.blackTexture);
        this.blackTexture = null;
      }
      if (this.vao) {
        this.gl.deleteVertexArray(this.vao);
        this.vao = null;
      }
      if (loseContext) {
        const lose = this.gl.getExtension("WEBGL_lose_context");
        lose?.loseContext();
      }
    } else {
      this.programs.clear();
      this.buffers.clear();
      this.external.clear();
      this.blackTexture = null;
      this.vao = null;
      this.vertexShader = null;
    }
  }
}
