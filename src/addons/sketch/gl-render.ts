/**
 * Rendu des traits par la carte graphique (WebGL2), même image que le rendu 2D de `render.ts` :
 * - empreintes en quads instanciés : disque doux calculé dans le shader (dureté, bord lissé sur au moins
 *   ~0,75 px), pointe personnalisée tirée d'une texture (chemin rastérisé une fois, mipmaps), aplatissement,
 *   rotation ; même niveau de détail au dézoom (`eachStamp`) et même décision par trait (`strokePlan`) ;
 * - trait translucide ou en fusion : empreintes réunies dans un tampon, posé avec l'opacité du trait et son
 *   mode ; modes de fusion du canvas calculés dans un shader (formules W3C Compositing, couleurs
 *   prémultipliées), gomme en `destination-out` ;
 * - aplats et masques : polygones remplis en pair-impair au stencil ;
 * - multiéchantillonnage (MSAA) seulement quand il y a des formes à lisser.
 * Coût sur téléphone : ce qui pèse n'est pas le nombre d'empreintes mais les changements de cible (une puce
 * mobile recharge et réécrit tout l'écran à chacun). Les traits en tampon sont donc posés par lots : tant que
 * les traits qui se suivent ont le même mode et ne se chevauchent pas, ils partagent le tampon (chacun mis à
 * son opacité dans sa zone) et sont posés en un seul passage. Les empreintes posées directement d'une suite de
 * traits partent en un seul appel de dessin.
 */
import { intersects, type Multi } from "../vector/geometry";
import { clipToView } from "../vector/cull";
import { tipGeometry } from "../paint/tip";
import { BLEND_MODES } from "../paint/brush";
import { eachStamp, maskColor, MIN_STAMP_PX, strokePlan, strokeRect } from "./render";
import { toScreen, visibleRect, type Stroke, type View } from "./model";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type RGBA = [number, number, number, number];

const FLOATS = 10; // x, y, taille, rotation, aplatissement, dureté, r, g, b, a (par empreinte)

const STAMP_VS = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec4 a0; // x, y, taille, rotation
layout(location=2) in vec2 a1; // aplatissement, dureté
layout(location=3) in vec4 col;
uniform vec2 size;
out vec2 loc; out vec2 half_; out float hard; out vec4 color;
void main() {
  half_ = vec2(a0.z * a1.x, a0.z) * 0.5;
  vec2 l = corner * (half_ * 2.0 + 2.0);
  loc = l;
  hard = a1.y; color = col;
  float c = cos(a0.w), s = sin(a0.w);
  vec2 p = a0.xy + vec2(l.x * c - l.y * s, l.x * s + l.y * c);
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
}`;

const STAMP_FS = `#version 300 es
precision highp float;
in vec2 loc; in vec2 half_; in float hard; in vec4 color;
uniform sampler2D tip; uniform bool useTip;
out vec4 o;
void main() {
  float a;
  if (useTip) {
    vec2 uv = loc / (half_ * 2.0) + 0.5;
    a = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? 0.0 : texture(tip, uv).a;
  } else {
    vec2 q = loc / max(half_, vec2(1e-4));
    float d = length(q);
    float r = min(half_.x, half_.y);
    if (hard < 0.0) a = max(0.0, 1.0 - d);              // cône : empreinte plus petite qu'un pixel
    else {
      float w = max(1.0 - hard, 0.75 / max(r, 1e-4));    // rampe du bord, au moins ~0,75 px
      a = clamp((1.0 - d) / w, 0.0, 1.0);
    }
  }
  a *= color.a;
  o = vec4(color.rgb * a, a);
}`;

const FILL_VS = `#version 300 es
layout(location=0) in vec2 p;
uniform vec2 size;
void main() { gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0); }`;

const FILL_FS = `#version 300 es
precision highp float;
uniform vec4 color; out vec4 o;
void main() { o = color; }`;

/** Mise à l'échelle d'une zone du tampon (opacité d'un trait du lot) : fusion ZERO, SRC_ALPHA. */
const SCALE_VS = `#version 300 es
layout(location=0) in vec2 p;
layout(location=1) in float a;
uniform vec2 size;
out float va;
void main() { va = a; gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0); }`;
const SCALE_FS = `#version 300 es
precision highp float;
in float va; out vec4 o;
void main() { o = vec4(0.0, 0.0, 0.0, va); }`;

/** Tampon posé tel quel (fusion par le pipeline : normal, ou destination-out pour la gomme). */
const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D src; uniform vec2 size; uniform float alpha; out vec4 o;
void main() { o = texture(src, gl_FragCoord.xy / size) * alpha; }`;

/** Modes de fusion du canvas (W3C Compositing and Blending, source-over), couleurs prémultipliées. */
const BLEND_FS = `#version 300 es
precision highp float;
uniform sampler2D src; uniform sampler2D dst; uniform vec2 size; uniform float alpha; uniform int mode;
out vec4 o;
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float softLight(float b, float s) {
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
}
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)); }
float dodge(float b, float s) { return b == 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
vec3 mix3(vec3 b, vec3 s) {
  if (mode == 1) return b * s;
  if (mode == 2) return b + s - b * s;
  if (mode == 3) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (mode == 4) return min(b, s);
  if (mode == 5) return max(b, s);
  if (mode == 6) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (mode == 7) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (mode == 8) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (mode == 9) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (mode == 10) return abs(b - s);
  if (mode == 11) return b + s - 2.0 * b * s;
  if (mode == 12) return setLum(setSat(s, sat(b)), lum(b));
  if (mode == 13) return setLum(setSat(b, sat(s)), lum(b));
  if (mode == 14) return setLum(s, lum(b));
  if (mode == 15) return setLum(b, lum(s));
  return s;
}
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  vec4 S = texture(src, uv) * alpha, D = texture(dst, uv);
  float as_ = S.a, ab = D.a;
  vec3 cs = as_ > 0.0 ? S.rgb / as_ : vec3(0.0), cb = ab > 0.0 ? D.rgb / ab : vec3(0.0);
  vec3 c = S.rgb * (1.0 - ab) + D.rgb * (1.0 - as_) + as_ * ab * clamp(mix3(cb, cs), 0.0, 1.0);
  o = vec4(c, as_ + ab * (1.0 - as_));
}`;

type Target = { fb: WebGLFramebuffer; tex: WebGLTexture; texFb: WebGLFramebuffer; rbs: WebGLRenderbuffer[]; own: WebGLFramebuffer[] };
type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Rect = [number, number, number, number];

/** Lot d'empreintes à poser (une pointe par lot). */
class Stamps {
  arr = new Float32Array(FLOATS * 4096);
  n = 0;
  tip: string | null = null;
}

/** Couleurs CSS → RGBA 0..1 (normalisées par un contexte 2D, comme le rendu canvas). */
const colorCache = new Map<string, RGBA>();
let colorCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
export function parseColor(c: string): RGBA {
  const hit = colorCache.get(c);
  if (hit) return hit;
  if (!colorCtx) {
    const cv = typeof document !== "undefined" ? document.createElement("canvas") : new OffscreenCanvas(1, 1);
    colorCtx = cv.getContext("2d") as CanvasRenderingContext2D | null;
  }
  let out: RGBA = [0, 0, 0, 1];
  if (colorCtx) {
    colorCtx.fillStyle = "#000";
    colorCtx.fillStyle = c;
    const v = String(colorCtx.fillStyle);
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
    if (m) out = [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, 1];
    else {
      const r = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(v);
      if (r) out = [+r[1] / 255, +r[2] / 255, +r[3] / 255, r[4] === undefined ? 1 : +r[4]];
    }
  }
  if (colorCache.size > 512) colorCache.clear();
  colorCache.set(c, out);
  return out;
}

const BLEND_INDEX = new Map<string, number>(BLEND_MODES.map((m, i) => [m, i]));
/** Clé de lot de la gomme (les modes de fusion vont de 0 à 15). */
const ERASE = -1;
/** Taille maximale d'un lot (le test de chevauchement est linéaire). */
const BATCH_MAX = 384;

const overlaps = (z: Rect, list: number[]): boolean => {
  for (let i = 0; i < list.length; i += 4) {
    if (z[0] < list[i] + list[i + 2] && list[i] < z[0] + z[2] && z[1] < list[i + 1] + list[i + 3] && list[i + 1] < z[1] + z[3]) return true;
  }
  return false;
};

/** Compteurs du dernier rendu (mesures). */
export type GLStats = { strokes: number; batches: number; switches: number; draws: number; msaa: boolean };

export class GLRenderer {
  private gl: WebGL2RenderingContext;
  private stampProg: Prog;
  private fillProg: Prog;
  private scaleProg: Prog;
  private copyProg: Prog;
  private blendProg: Prog;
  private quadBuf: WebGLBuffer;
  private stampVao: WebGLVertexArrayObject;
  private instBuf: WebGLBuffer;
  private fillVao: WebGLVertexArrayObject;
  private fillBuf: WebGLBuffer;
  private scaleVao: WebGLVertexArrayObject;
  private scaleBuf: WebGLBuffer;
  private tips = new Map<string, WebGLTexture>();
  private main: Target | null = null;
  private scratch: Target | null = null;
  private dstCopy: Target | null = null;
  private W = 0;
  private H = 0;
  private samples = 4;
  private msaa = false;
  private bound: WebGLFramebuffer | null | undefined = undefined;
  /** Empreintes à poser sur la toile, et dans le tampon du lot. */
  private toMain = new Stamps();
  private toScratch = new Stamps();
  /** Lot ouvert : mode, zones des traits (x, y, l, h en px de la toile, origine en haut), opacités. */
  private batch: { key: number; zones: number[]; scales: number[]; box: Rect } | null = null;
  /** Zones des traits posés directement pendant que le lot est ouvert (ils ne le chevauchent pas). */
  private beside: number[] = [];
  stats: GLStats = { strokes: 0, batches: 0, switches: 0, draws: 0, msaa: false };
  lost = false;

  /** Moteur sur une toile (OffscreenCanvas dans un worker), ou `null` sans WebGL2. */
  static create(canvas: Canvas): GLRenderer | null {
    try {
      const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" }) as WebGL2RenderingContext | null;
      return gl ? new GLRenderer(gl, canvas) : null;
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext, canvas: Canvas) {
    this.gl = gl;
    (canvas as unknown as EventTarget).addEventListener?.("webglcontextlost", () => { this.lost = true; });
    this.samples = Math.max(1, Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number));
    this.stampProg = this.prog(STAMP_VS, STAMP_FS, ["size", "tip", "useTip"]);
    this.fillProg = this.prog(FILL_VS, FILL_FS, ["size", "color"]);
    this.scaleProg = this.prog(SCALE_VS, SCALE_FS, ["size"]);
    this.copyProg = this.prog(FILL_VS, COPY_FS, ["src", "size", "alpha"]);
    this.blendProg = this.prog(FILL_VS, BLEND_FS, ["src", "dst", "size", "alpha", "mode"]);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    this.stampVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.stampVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(3, 1);
    this.fillVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fillVao);
    this.fillBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.scaleVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.scaleVao);
    this.scaleBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.scaleBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
  }

  private prog(vs: string, fs: string, names: string[]): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "programme");
    const u: Prog["u"] = {};
    for (const n of names) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  private texture(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return tex;
  }

  /**
   * Cible de dessin (couleur + stencil) et sa texture : en MSAA, tampon multiéchantillonné résolu dans la
   * texture ; sinon, la texture est la cible même (`texFb` = `fb`). `stencil` faux : texture seule (copie).
   */
  private target(w: number, h: number, msaa: boolean, stencil = true): Target {
    const gl = this.gl;
    const tex = this.texture(w, h);
    const texFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, texFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const rbs: WebGLRenderbuffer[] = [];
    const rb = (fmt: number) => {
      const r = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, r);
      if (msaa) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, fmt, w, h);
      else gl.renderbufferStorage(gl.RENDERBUFFER, fmt, w, h);
      rbs.push(r);
      return r;
    };
    let fb = texFb;
    if (msaa) {
      fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb(gl.RGBA8));
    }
    if (stencil) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb(gl.DEPTH24_STENCIL8));
    this.bound = undefined;
    return { fb, tex, texFb, rbs, own: fb === texFb ? [fb] : [fb, texFb] };
  }

  private freeTarget(t: Target | null): void {
    if (!t) return;
    const gl = this.gl;
    for (const r of t.rbs) gl.deleteRenderbuffer(r);
    for (const f of t.own) gl.deleteFramebuffer(f);
    gl.deleteTexture(t.tex);
  }

  private resize(W: number, H: number, msaa: boolean): void {
    if (this.W === W && this.H === H && this.msaa === msaa && this.main) return;
    this.freeTarget(this.main);
    this.freeTarget(this.scratch);
    this.freeTarget(this.dstCopy);
    this.W = W;
    this.H = H;
    this.msaa = msaa;
    this.main = this.target(W, H, msaa);
    this.scratch = this.target(W, H, msaa);
    this.dstCopy = msaa ? null : this.target(W, H, false, false);
  }

  private bind(fb: WebGLFramebuffer | null): void {
    if (this.bound === fb) return;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fb);
    this.bound = fb;
    this.stats.switches++;
  }

  /** Copie (ou résolution MSAA) d'un rectangle de la toile (px, origine en haut) d'une cible vers une autre. */
  private blit(from: WebGLFramebuffer, to: WebGLFramebuffer | null, r: Rect): void {
    const gl = this.gl;
    const x = r[0], y = this.H - r[1] - r[3], X = x + r[2], Y = y + r[3];
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(x, y, X, Y, x, y, X, Y, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.bound = undefined;
    this.stats.switches++;
  }

  /** Texture d'une pointe : chemin rastérisé (blanc sur transparent), plus long côté = la texture. */
  private tipTexture(d: string): WebGLTexture | null {
    const hit = this.tips.get(d);
    if (hit) return hit;
    const g = tipGeometry(d);
    if (!g) return null;
    const N = 256;
    const cv = typeof document !== "undefined" ? Object.assign(document.createElement("canvas"), { width: N, height: N }) : new OffscreenCanvas(N, N);
    const ctx = cv.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.translate(N / 2, N / 2);
    ctx.scale(N * g.k, N * g.k);
    ctx.translate(-g.cx, -g.cy);
    ctx.fillStyle = "#fff";
    ctx.fill(new Path2D(d), "nonzero");
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.tips.size > 32) { for (const t of this.tips.values()) gl.deleteTexture(t); this.tips.clear(); }
    this.tips.set(d, tex);
    return tex;
  }

  /* ------------------------------------------------------------ empreintes */

  private view!: View;
  private w = 0;
  private h = 0;
  private dpr = 1;

  /** Ajoute les empreintes d'un trait à un lot (opacité `alpha` × facteur de niveau de détail). */
  private pushStamps(list: Stamps, st: Stroke, alpha: number, color: RGBA): void {
    const { view, w, h, dpr } = this;
    const b = st.brush;
    const tip = b.tip && tipGeometry(b.tip) ? b.tip : null;
    if (tip !== list.tip) { this.drawStamps(list); list.tip = tip; }
    const hard = Math.min(0.999, Math.max(0, b.hardness));
    const vr = view.rotation || 0;
    eachStamp(st, view.zoom, (st0, k) => {
      const [sx, sy] = toScreen(view, st0.x, st0.y, w, h);
      let px = st0.size * view.zoom;
      let a = alpha * k;
      if (px < MIN_STAMP_PX) { a *= (px / MIN_STAMP_PX) ** 2; px = MIN_STAMP_PX; }
      if (a < 1 / 512 || sx < -px - 2 || sy < -px - 2 || sx > w + px + 2 || sy > h + px + 2) return;
      a = Math.min(1, a);
      let P = px * dpr, hd = hard;
      // Plus petite que ~1,5 px de la toile : cône de 1,5 px, de même quantité de couleur.
      if (!tip && P < 1.5) {
        const F = hd * hd + ((1 - hd) * (1 + 2 * hd)) / 3;
        a = Math.min(1, (a * P * P * F) / (1.5 * 1.5 / 3));
        P = 1.5;
        hd = -1;
      }
      if (list.n * FLOATS + FLOATS > list.arr.length) {
        if (list.arr.length < FLOATS * 262144) { const g = new Float32Array(list.arr.length * 2); g.set(list.arr); list.arr = g; }
        else this.drawStamps(list);
      }
      const o = list.n++ * FLOATS, I = list.arr;
      I[o] = sx * dpr; I[o + 1] = sy * dpr; I[o + 2] = P; I[o + 3] = st0.rot + vr;
      I[o + 4] = st0.squash; I[o + 5] = hd;
      I[o + 6] = color[0]; I[o + 7] = color[1]; I[o + 8] = color[2]; I[o + 9] = a;
    });
  }

  /** Dessine un lot d'empreintes sur sa cible (toile ou tampon), source-over prémultiplié. */
  private drawStamps(list: Stamps): void {
    if (!list.n) return;
    const gl = this.gl;
    this.bind(list === this.toMain ? this.main!.fb : this.scratch!.fb);
    gl.useProgram(this.stampProg.p);
    gl.uniform2f(this.stampProg.u.size, this.W, this.H);
    const tex = list.tip ? this.tipTexture(list.tip) : null;
    gl.uniform1i(this.stampProg.u.useTip, tex ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.stampProg.u.tip, 0);
    gl.bindVertexArray(this.stampVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, list.arr.subarray(0, list.n * FLOATS), gl.STREAM_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, list.n);
    this.stats.draws++;
    list.n = 0;
  }

  /* ------------------------------------------------------------ formes */

  /** Remplit une forme (pair-impair, stencil) sur la cible liée : couleur prémultipliée, fusion du pipeline. */
  private fillShape(shape: Multi, color: RGBA, erase: boolean): void {
    const { view, w, h, dpr } = this;
    let m = shape;
    try { m = clipToView(shape, visibleRect(view, w, h), 2 / view.zoom); } catch { /* forme laissée entière */ }
    const tris: number[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of m) for (const ring of poly) {
      if (ring.length < 3) continue;
      const pts = ring.map(([x, y]) => toScreen(view, x, y, w, h));
      for (const [sx, sy] of pts) { x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy); }
      for (let i = 2; i < pts.length; i++) tris.push(pts[0][0] * dpr, pts[0][1] * dpr, pts[i - 1][0] * dpr, pts[i - 1][1] * dpr, pts[i][0] * dpr, pts[i][1] * dpr);
    }
    if (!tris.length) return;
    const gl = this.gl;
    gl.useProgram(this.fillProg.p);
    gl.uniform2f(this.fillProg.u.size, this.W, this.H);
    gl.bindVertexArray(this.fillVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    // 1) parité de recouvrement dans le stencil
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, tris.length / 2);
    // 2) couverture de la boîte là où la parité est impaire, stencil remis à zéro au passage
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    const X0 = Math.max(0, x0 - 2) * dpr, Y0 = Math.max(0, y0 - 2) * dpr, X1 = Math.min(w, x1 + 2) * dpr, Y1 = Math.min(h, y1 + 2) * dpr;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([X0, Y0, X1, Y0, X0, Y1, X1, Y0, X1, Y1, X0, Y1]), gl.STREAM_DRAW);
    gl.uniform4f(this.fillProg.u.color, color[0] * color[3], color[1] * color[3], color[2] * color[3], color[3]);
    gl.enable(gl.BLEND);
    if (erase) gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.STENCIL_TEST);
    this.stats.draws += 2;
  }

  /* ------------------------------------------------------------ lots de traits en tampon */

  /** Triangles couvrant une liste de zones (px de la toile). */
  private zoneTris(zones: number[], withAlpha?: number[]): Float32Array {
    const n = zones.length / 4, k = withAlpha ? 3 : 2;
    const out = new Float32Array(n * 6 * k);
    for (let i = 0, o = 0; i < n; i++) {
      const x = zones[i * 4], y = zones[i * 4 + 1], X = x + zones[i * 4 + 2], Y = y + zones[i * 4 + 3];
      const a = withAlpha ? withAlpha[i] : 0;
      for (const [px, py] of [[x, y], [X, y], [x, Y], [X, y], [X, Y], [x, Y]]) {
        out[o++] = px; out[o++] = py;
        if (withAlpha) out[o++] = a;
      }
    }
    return out;
  }

  /** Pose le lot ouvert sur la toile, puis les empreintes directes en attente. */
  private flushAll(): void {
    const b = this.batch;
    if (b) {
      this.batch = null;
      this.beside = [];
      const gl = this.gl;
      this.drawStamps(this.toScratch);
      // Opacité de chaque trait du lot, dans sa zone (les zones ne se chevauchent pas).
      const sc = b.scales;
      if (sc.length) {
        const zones: number[] = [], al: number[] = [];
        for (let i = 0; i < sc.length; i += 5) { zones.push(sc[i], sc[i + 1], sc[i + 2], sc[i + 3]); al.push(sc[i + 4]); }
        this.bind(this.scratch!.fb);
        gl.useProgram(this.scaleProg.p);
        gl.uniform2f(this.scaleProg.u.size, this.W, this.H);
        gl.bindVertexArray(this.scaleVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.scaleBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this.zoneTris(zones, al), gl.STREAM_DRAW);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, (zones.length / 4) * 6);
        this.stats.draws++;
      }
      const S = this.scratch!, M = this.main!;
      if (this.msaa) this.blit(S.fb, S.texFb, b.box);
      const blend = b.key > 0;
      let dst: WebGLTexture | null = null;
      if (blend) {
        // Ce qui est dessous, pour le calcul de la fusion (copie, ou résolution MSAA).
        const D = this.msaa ? M : this.dstCopy!;
        this.blit(M.fb, D.texFb, b.box);
        dst = D.tex;
      }
      this.bind(M.fb);
      gl.bindVertexArray(this.fillVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.zoneTris(b.zones), gl.STREAM_DRAW);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, S.tex);
      if (blend) {
        gl.useProgram(this.blendProg.p);
        gl.uniform1i(this.blendProg.u.src, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, dst);
        gl.uniform1i(this.blendProg.u.dst, 1);
        gl.uniform2f(this.blendProg.u.size, this.W, this.H);
        gl.uniform1f(this.blendProg.u.alpha, 1);
        gl.uniform1i(this.blendProg.u.mode, b.key);
        gl.disable(gl.BLEND);
      } else {
        gl.useProgram(this.copyProg.p);
        gl.uniform1i(this.copyProg.u.src, 0);
        gl.uniform2f(this.copyProg.u.size, this.W, this.H);
        gl.uniform1f(this.copyProg.u.alpha, 1);
        gl.enable(gl.BLEND);
        if (b.key === ERASE) gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.drawArrays(gl.TRIANGLES, 0, (b.zones.length / 4) * 6);
      this.stats.draws++;
    }
    this.drawStamps(this.toMain);
  }

  /** Lot pour un trait en tampon (mode `key`, zone `z`) : rejoint le lot ouvert si possible, sinon en ouvre un. */
  private joinBatch(key: number, z: Rect): void {
    const b = this.batch;
    if (b && (b.key !== key || b.zones.length >= BATCH_MAX * 4 || overlaps(z, b.zones) || overlaps(z, this.beside))) this.flushAll();
    if (!this.batch) {
      // Les empreintes directes déjà en attente passent avant le lot (elles peuvent être dessous).
      this.drawStamps(this.toMain);
      this.bind(this.scratch!.fb);
      const gl = this.gl;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      this.batch = { key, zones: [], scales: [], box: [z[0], z[1], z[2], z[3]] };
      this.stats.batches++;
    }
    const bb = this.batch!;
    bb.zones.push(z[0], z[1], z[2], z[3]);
    const x0 = Math.min(bb.box[0], z[0]), y0 = Math.min(bb.box[1], z[1]);
    const x1 = Math.max(bb.box[0] + bb.box[2], z[0] + z[2]), y1 = Math.max(bb.box[1] + bb.box[3], z[1] + z[3]);
    bb.box = [x0, y0, x1 - x0, y1 - y0];
  }

  /** Zone de la toile couverte par un trait (px de la toile, origine en haut), ou `null`. */
  private zoneOf(st: Stroke): Rect | null {
    const fake = { canvas: { width: this.W, height: this.H }, getTransform: () => ({ a: this.dpr, d: this.dpr, e: 0, f: 0 }) } as unknown as CanvasRenderingContext2D;
    return strokeRect({ ctx: fake, w: this.w, h: this.h, view: this.view }, st) as Rect | null;
  }

  private shapeZone(shape: Multi): Rect | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of shape) for (const ring of poly) for (const [x, y] of ring) {
      const [sx, sy] = toScreen(this.view, x, y, this.w, this.h);
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    const d = this.dpr;
    const X0 = Math.max(0, Math.floor(x0 * d - 2)), Y0 = Math.max(0, Math.floor(y0 * d - 2));
    const X1 = Math.min(this.W, Math.ceil(x1 * d + 2)), Y1 = Math.min(this.H, Math.ceil(y1 * d + 2));
    return X1 > X0 && Y1 > Y0 ? [X0, Y0, X1 - X0, Y1 - Y0] : null;
  }

  /* ------------------------------------------------------------ traits */

  private drawOne(st: Stroke): void {
    this.stats.strokes++;
    const plan = strokePlan(st, this.view.zoom);
    if (plan.kind === "flat") {
      for (const r of st.flat!) {
        const col = parseColor(r.color);
        if (!r.blend || r.blend === "normal") {
          this.flushAll();
          this.bind(this.main!.fb);
          this.fillShape(r.shape, col, false);
          continue;
        }
        const z = this.shapeZone(r.shape);
        if (!z) continue;
        this.joinBatch(BLEND_INDEX.get(r.blend) ?? 0, z);
        this.drawStamps(this.toScratch);
        this.bind(this.scratch!.fb);
        this.fillShape(r.shape, col, false);
      }
      return;
    }
    if (plan.kind === "mask") {
      this.flushAll();
      this.bind(this.main!.fb);
      this.fillShape(st.mask!, parseColor(maskColor(st.brush.opacity)), true);
      return;
    }
    const color = parseColor(st.brush.color);
    if (plan.kind === "direct" && (!plan.blend || plan.blend === "normal")) {
      // Pendant un lot, un trait direct qui ne le chevauche pas est posé à part (l'ordre entre eux est libre).
      if (this.batch) {
        const z = this.zoneOf(st);
        if (!z) return;
        if (overlaps(z, this.batch.zones)) this.flushAll();
        else this.beside.push(z[0], z[1], z[2], z[3]);
      }
      return this.pushStamps(this.toMain, st, plan.stampAlpha, color);
    }
    const z = this.zoneOf(st);
    if (!z) return;
    if (plan.kind === "direct") {
      // Touche unique ou trait minuscule en fusion : empreintes à leur opacité, tampon posé à pleine force.
      this.joinBatch(BLEND_INDEX.get(plan.blend || "normal") ?? 0, z);
      this.pushStamps(this.toScratch, st, plan.stampAlpha, color);
      return;
    }
    this.joinBatch(plan.erase ? ERASE : BLEND_INDEX.get(plan.blend || "normal") ?? 0, z);
    this.pushStamps(this.toScratch, st, 1, color);
    if (plan.alpha < 0.999) this.batch!.scales.push(z[0], z[1], z[2], z[3], plan.alpha);
  }

  /**
   * Rend des traits sur la toile du moteur pour une vue (w × h px CSS, densité dpr), sur un fond optionnel.
   * `pause` (facultatif) est appelée entre deux traits ; si elle renvoie une promesse, le rendu l'attend
   * (le worker y lit ses messages) et s'arrête si elle renvoie `false`.
   */
  async render(strokes: Stroke[], view: View, w: number, h: number, dpr: number, bg: string | null, pause?: () => boolean | Promise<boolean>): Promise<boolean> {
    const gl = this.gl;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    const cv = gl.canvas as Canvas;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const rect = visibleRect(view, w, h);
    const visible = (st: Stroke) => intersects(st.bbox, rect) && Math.max(st.bbox.w, st.bbox.h) * view.zoom >= 0.4;
    // Lissage MSAA seulement s'il y a des formes (aplats, masques) à l'écran : les empreintes sont lissées par le shader.
    const msaa = strokes.some((st) => (st.flat || st.mask) && visible(st));
    this.resize(W, H, msaa);
    this.view = view; this.w = w; this.h = h; this.dpr = dpr;
    this.toMain.n = 0; this.toMain.tip = null; this.toScratch.n = 0; this.toScratch.tip = null;
    this.batch = null; this.beside = [];
    this.stats = { strokes: 0, batches: 0, switches: 0, draws: 0, msaa };
    gl.viewport(0, 0, W, H);
    this.bound = undefined;
    this.bind(this.main!.fb);
    const c = bg ? parseColor(bg) : null;
    gl.clearColor(c ? c[0] * c[3] : 0, c ? c[1] * c[3] : 0, c ? c[2] * c[3] : 0, c ? c[3] : 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    let t = performance.now();
    for (const st of strokes) {
      if (!visible(st)) continue;
      this.drawOne(st);
      if (pause && performance.now() - t > 25) {
        gl.flush();
        const go = await pause();
        if (!go || this.lost) return false;
        this.bound = undefined;
        t = performance.now();
      }
    }
    this.flushAll();
    // Résolution sur la toile.
    this.blit(this.main!.fb, null, [0, 0, W, H]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bound = undefined;
    return !this.lost && !gl.isContextLost();
  }
}
