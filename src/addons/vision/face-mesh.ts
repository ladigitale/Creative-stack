import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { safeMediaUrl } from "../../shared/media/urls";
import type { SonicFrameSource } from "../../shared/mediaRef";
import {
  COLOR_POINTS,
  FACE_INDICES,
  FACE_VERTEX_COUNT,
  blendGain,
  colorGain,
  featherWeights,
  fillPositions,
  fillUvCanonical,
  fillUvFromLandmarks,
  sampleMean,
  swapPartner,
  validLandmarks,
  type Rgb,
} from "../../shared/ml/face-mesh";
import { FACE_UV } from "../../shared/ml/face-mesh-data";
import type { Point } from "../../shared/ml/hands";
import { MIRROR, ParamOverlay, readParams, snapshot, type ParamSpecs } from "./live-params";

const tagName = "sonic-face-mesh";

export type FaceMeshMode = "swap" | "portrait" | "canonical";

/** Clés de réglage de `params` (nom de propriété → validation). */
export const FACE_MESH_PARAMS: ParamSpecs = {
  opacity: { kind: "number", min: 0, max: 1 },
  feather: { kind: "number", min: 0, max: 20 },
  colorMatch: { kind: "number", min: 0, max: 1 },
  face: { kind: "enum", values: ["all", "0", "1"] },
  mirror: MIRROR,
};

export type FaceMeshState = {
  /** `idle` (rien dessiné encore), `ready`, `error` (WebGL indisponible). */
  status: "idle" | "ready" | "error";
  /** Message d'erreur, `null` sans erreur ; renseigné aussi en `ready` si la texture est refusée ou illisible. */
  error: string | null;
  ready: boolean;
  /** `swap` (visages de l'image échangés), `portrait` (visage d'une autre image), `canonical` (texture à plat), `none` (rien à greffer). */
  mode: FaceMeshMode | "none";
  faces: number;
  drawn: number;
  /** Réglages effectifs (attributs recouverts par `params`). */
  settings: Record<string, unknown>;
};

type DrawState = Omit<FaceMeshState, "status" | "error" | "settings"> & { error?: string };

type FrameEl = Element & { getFrameSource?: () => HTMLVideoElement | null; getFrameCanvas?: () => HTMLCanvasElement | null };
type Frame = { image: CanvasImageSource; width: number; height: number; flip: boolean };

const VERT_MESH = `attribute vec2 aPos;attribute vec2 aUv;attribute float aFeather;varying vec2 vUv;varying float vF;
void main(){gl_Position=vec4(aPos,0.0,1.0);vUv=aUv;vF=aFeather;}`;
const FRAG_MESH = `precision mediump float;varying vec2 vUv;varying float vF;uniform sampler2D uTex;uniform vec3 uGain;uniform float uOpacity;
void main(){vec4 t=texture2D(uTex,vUv);gl_FragColor=vec4(clamp(t.rgb*uGain,0.0,1.0),t.a*vF*uOpacity);}`;
const VERT_QUAD = `attribute vec2 aPos;uniform float uFlip;varying vec2 vUv;
void main(){gl_Position=vec4(aPos,0.0,1.0);vec2 uv=vec2(aPos.x*0.5+0.5,0.5-aPos.y*0.5);vUv=vec2(mix(uv.x,1.0-uv.x,uFlip),uv.y);}`;
const FRAG_QUAD = `precision mediump float;varying vec2 vUv;uniform sampler2D uTex;
void main(){gl_FragColor=vec4(texture2D(uTex,vUv).rgb,1.0);}`;

/**
 * Greffe un visage sur le visage suivi : le maillage de 468 points d'un `sonic-face-tracker` (landmarks="true")
 * est dessiné en WebGL avec une texture, déformé comme ton visage (pose, bouche, yeux), avec correction de
 * couleur et bords estompés. Trois façons de fournir la texture :
 * - **échange** (défaut) : `background="synced"` ; avec 2 visages dans l'image (`max-faces="2"` côté tracker),
 *   chacun prend le visage de l'autre, lu dans la même image ;
 * - **portrait** : `texture-source="#img"` (source d'images) + `texture-landmarks="<DataProvider d'un second
 *   tracker qui analyse cette image>"` : son visage est plaqué sur le tien ;
 * - **à plat** : `texture="https://…"` = image dessinée sur le modèle canonique de visage MediaPipe (masques).
 * `background` = id d'une source d'images (sonic-camera, sonic-frame-sync) dessinée dessous ; vide : seul le
 * visage greffé est dessiné (fond transparent). Le composant est lui-même une source d'images (`getFrameCanvas`).
 * Calcul local : rien n'est envoyé, aucun HTML n'est injecté.
 */
@customElement(tagName)
export class SonicFaceMesh extends LitElement implements SonicFrameSource {
  static styles = css`
    :host {
      display: block;
      position: relative;
      line-height: 0;
    }
    canvas {
      width: 100%;
      height: auto;
      display: block;
      border-radius: inherit;
    }
  `;

  /** DataProvider de la sortie d'un `sonic-face-tracker` publiant `landmarks="true"`. */
  @property({ type: String })
  source = "";

  /** Id d'une source d'images redessinée sous le visage (`#id` accepté). Requis pour l'échange. */
  @property({ type: String })
  background = "";

  /** Image à plat sur le modèle canonique (https, blob:, data:image, relative). */
  @property({ type: String })
  texture = "";

  /** Id d'une source d'images contenant le portrait (mode portrait). */
  @property({ type: String, attribute: "texture-source" })
  textureSource = "";

  /** DataProvider du tracker qui analyse `texture-source` (premier visage). */
  @property({ type: String, attribute: "texture-landmarks" })
  textureLandmarks = "";

  /** Miroir des images : `auto` (retourne une vidéo native, pas un canvas déjà dessiné), `true`, `false`. */
  @property({ type: String })
  mirror: "auto" | "true" | "false" = "auto";

  /** Quel visage recevoir la texture : `all`, `0` ou `1`. */
  @property({ type: String })
  face: "all" | "0" | "1" = "all";

  /** Largeur du fondu des bords, en anneaux de triangles (0 = bords nets). */
  @property({ type: Number })
  feather = 6;

  /** Correction de couleur vers la peau cible, 0 (aucune) à 1 (complète). */
  @property({ type: Number, attribute: "color-match" })
  colorMatch = 0.8;

  @property({ type: Number })
  opacity = 1;

  /** Taille du canvas sans image de fond. */
  @property({ type: Number })
  width = 640;

  @property({ type: Number })
  height = 480;

  /** DataProvider de l'état publié (`FaceMeshState`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  /** DataProvider de réglages en direct, prioritaires sur les attributs : `opacity`, `feather`, `colorMatch`, `face`, `mirror`. */
  @property({ type: String })
  params = "";

  @query("canvas")
  private canvas!: HTMLCanvasElement;

  private faces: Point[][] = [];
  private texFaces: Point[][] = [];
  private unlistenFaces: (() => void) | null = null;
  private unlistenTex: (() => void) | null = null;
  private unlistenParams: (() => void) | null = null;
  private overlay = new ParamOverlay(this);
  private raf = 0;
  private seq = 0;
  private tick = 0;
  private gains: Rgb[] = [];
  private lastState = "";

  private gl: WebGLRenderingContext | null = null;
  private glFailed = false;
  private meshProg: WebGLProgram | null = null;
  private quadProg: WebGLProgram | null = null;
  private bgTex: WebGLTexture | null = null;
  private texTex: WebGLTexture | null = null;
  private bufPos: WebGLBuffer | null = null;
  private bufUv: WebGLBuffer | null = null;
  private bufFeather: WebGLBuffer | null = null;
  private bufIdx: WebGLBuffer | null = null;
  private bufQuad: WebGLBuffer | null = null;
  private featherRings = -1;
  private pos = new Float32Array(FACE_VERTEX_COUNT * 2);
  private uv = new Float32Array(FACE_VERTEX_COUNT * 2);

  private textureImage: HTMLImageElement | null = null;
  private textureDirty = false;
  private textureError = "";
  private scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

  get frameSeq(): number {
    return this.seq;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.canvas && this.canvas.width > 0 && this.seq > 0 ? this.canvas : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.listenParams();
    this.loadTexture();
    if (!this.lastState) this.publish({ ready: false, mode: "none", faces: 0, drawn: 0, ...(this.textureError ? { error: this.textureError } : {}) });
  }

  disconnectedCallback(): void {
    this.unlistenFaces?.();
    this.unlistenTex?.();
    this.unlistenFaces = this.unlistenTex = null;
    this.unlistenParams?.();
    this.unlistenParams = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.releaseGl();
    super.disconnectedCallback();
  }

  protected willUpdate(changed: Map<PropertyKey, unknown>): void {
    super.willUpdate(changed);
    this.overlay.guard(changed);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("params")) this.listenParams();
    if (changed.has("source") || changed.has("textureLandmarks")) this.listen();
    if (changed.has("texture")) this.loadTexture();
    this.schedule();
  }

  render() {
    return html`<canvas @webglcontextlost=${this.onContextLost}></canvas>`;
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.releaseGl();
    this.schedule();
  };

  private listen(): void {
    this.unlistenFaces?.();
    this.unlistenTex?.();
    this.unlistenFaces = this.unlistenTex = null;
    this.faces = [];
    this.texFaces = [];
    const src = this.source.trim();
    if (src) {
      this.unlistenFaces = listenDp(src, (v) => {
        this.faces = facesOf(v);
        this.schedule();
      });
    }
    const tex = this.textureLandmarks.trim();
    if (tex) {
      this.unlistenTex = listenDp(tex, (v) => {
        this.texFaces = facesOf(v);
        this.schedule();
      });
    }
  }

  private listenParams(): void {
    this.unlistenParams?.();
    this.unlistenParams = null;
    const path = this.params.trim();
    if (!path) return;
    this.unlistenParams = listenDp(path, (v) => {
      this.overlay.set(readParams(FACE_MESH_PARAMS, v));
      this.schedule();
    });
  }

  private loadTexture(): void {
    this.textureImage = null;
    this.textureError = "";
    const url = this.texture.trim();
    if (!url) return;
    if (!safeMediaUrl(url, "image")) {
      this.textureError = "URL de texture refusée";
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (this.texture.trim() !== url) return;
      this.textureImage = img;
      this.textureDirty = true;
      this.schedule();
    };
    img.onerror = () => {
      this.textureError = "texture illisible";
      this.schedule();
    };
    img.src = url;
  }

  private schedule(): void {
    if (this.raf || !this.isConnected) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
      // L'image de fond change à chaque trame : on continue tant qu'il y en a une.
      if (this.background.trim() || this.textureSource.trim()) this.schedule();
    });
  }

  private frameOf(idRaw: string): Frame | null {
    const id = idRaw.trim().replace(/^#/, "");
    if (!id) return null;
    const root = this.getRootNode() as Document | ShadowRoot;
    const el = (root.getElementById?.(id) ?? document.getElementById(id)) as FrameEl | null;
    const video = el?.getFrameSource?.();
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      return { image: video, width: video.videoWidth, height: video.videoHeight, flip: this.mirror === "true" || this.mirror === "auto" };
    }
    const canvas = el?.getFrameCanvas?.();
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      return { image: canvas, width: canvas.width, height: canvas.height, flip: this.mirror === "true" };
    }
    return null;
  }

  /** Mode effectif d'après les attributs et les données reçues. */
  resolveMode(): FaceMeshMode | "none" {
    if (this.textureImage) return "canonical";
    if (this.textureSource.trim() && this.textureLandmarks.trim()) return this.texFaces.length ? "portrait" : "none";
    if (this.background.trim() && this.faces.length >= 2) return "swap";
    return "none";
  }

  private initGl(): boolean {
    if (this.gl) return true;
    if (this.glFailed || !this.canvas) return false;
    const gl = this.canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: true }) as WebGLRenderingContext | null;
    if (!gl) {
      this.glFailed = true;
      return false;
    }
    try {
      this.meshProg = program(gl, VERT_MESH, FRAG_MESH);
      this.quadProg = program(gl, VERT_QUAD, FRAG_QUAD);
    } catch {
      this.glFailed = true;
      return false;
    }
    this.gl = gl;
    this.bgTex = texture(gl);
    this.texTex = texture(gl);
    this.bufPos = gl.createBuffer();
    this.bufUv = gl.createBuffer();
    this.bufFeather = gl.createBuffer();
    this.bufIdx = gl.createBuffer();
    this.bufQuad = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FACE_INDICES, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.featherRings = -1;
    this.textureDirty = true;
    return true;
  }

  private releaseGl(): void {
    this.gl = null;
    this.meshProg = this.quadProg = null;
    this.bgTex = this.texTex = null;
    this.bufPos = this.bufUv = this.bufFeather = this.bufIdx = this.bufQuad = null;
  }

  /** Dessine l'état courant ; retourne le nombre de visages greffés (public pour les tests). */
  draw(): number {
    const canvas = this.canvas;
    if (!canvas) return 0;
    const bg = this.frameOf(this.background);
    const w = bg ? bg.width : Math.max(1, Math.round(this.width) || 640);
    const h = bg ? bg.height : Math.max(1, Math.round(this.height) || 480);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (!this.initGl() || !this.gl) {
      this.publish({ ready: false, mode: "none", faces: this.faces.length, drawn: 0, error: "WebGL indisponible" });
      return 0;
    }
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.tick++;

    if (bg) this.drawBackground(gl, bg);

    const mode = this.resolveMode();
    let drawn = 0;
    if (mode !== "none") {
      const portraitFrame = mode === "portrait" ? this.frameOf(this.textureSource) : null;
      if (mode === "portrait" && !portraitFrame) {
        this.publish({ ready: true, mode: "none", faces: this.faces.length, drawn: 0 });
        return 0;
      }
      if (mode === "canonical") this.uploadTextureImage(gl);
      if (mode === "portrait" && portraitFrame) this.upload(gl, this.texTex, portraitFrame.image);

      const pixelsDest = this.tick % 3 === 1 && this.colorMatch > 0 && bg ? this.pixels(bg) : null;
      const pixelsSrc =
        this.tick % 3 === 1 && this.colorMatch > 0
          ? mode === "portrait" && portraitFrame
            ? this.pixels(portraitFrame)
            : mode === "canonical" && this.textureImage
              ? this.pixels({ image: this.textureImage, width: this.textureImage.naturalWidth, height: this.textureImage.naturalHeight, flip: false })
              : pixelsDest
          : null;

      this.useMesh(gl);
      const wanted = this.face === "0" ? [0] : this.face === "1" ? [1] : this.faces.map((_, i) => i);
      for (const i of wanted) {
        const lm = this.faces[i];
        if (!lm) continue;
        let flipUv = false;
        let srcLm: Point[] | null = null;
        if (mode === "canonical") {
          fillUvCanonical(this.uv);
        } else if (mode === "portrait") {
          srcLm = this.texFaces[0] ?? null;
          if (!srcLm) continue;
          flipUv = !!portraitFrame?.flip;
          fillUvFromLandmarks(this.uv, srcLm, flipUv);
        } else {
          const partner = swapPartner(i, this.faces.length);
          srcLm = partner >= 0 ? this.faces[partner] : null;
          if (!srcLm) continue;
          flipUv = !!bg?.flip;
          fillUvFromLandmarks(this.uv, srcLm, flipUv);
        }
        fillPositions(this.pos, lm);

        if (pixelsDest && (mode !== "canonical" || pixelsSrc)) {
          // Les copies réduites sont dans l'orientation affichée : on lit les points tels quels (sans retourner).
          const dest = sampleMean(pixelsDest.data, pixelsDest.w, pixelsDest.h, COLOR_POINTS.map((k) => lm[k]), 1);
          const sampleAt =
            mode === "canonical"
              ? COLOR_POINTS.map((k) => ({ x: FACE_UV[k * 2], y: FACE_UV[k * 2 + 1] }))
              : srcLm
                ? COLOR_POINTS.map((k) => srcLm![k])
                : null;
          const from = sampleAt && pixelsSrc ? sampleMean(pixelsSrc.data, pixelsSrc.w, pixelsSrc.h, sampleAt, 1) : null;
          const next = colorGain(from, dest, this.colorMatch);
          this.gains[i] = blendGain(this.gains[i] ?? [1, 1, 1], next, this.gains[i] ? 0.3 : 1);
        }
        this.drawMesh(gl, mode === "portrait" ? this.texTex : mode === "canonical" ? this.texTex : this.bgTex, this.gains[i] ?? [1, 1, 1]);
        drawn++;
      }
    }
    this.seq++;
    this.publish({ ready: true, mode, faces: this.faces.length, drawn, ...(this.textureError ? { error: this.textureError } : {}) });
    return drawn;
  }

  private drawBackground(gl: WebGLRenderingContext, bg: Frame): void {
    if (!this.quadProg || !this.bgTex) return;
    this.upload(gl, this.bgTex, bg.image);
    gl.useProgram(this.quadProg);
    const loc = gl.getAttribLocation(this.quadProg, "aPos");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufQuad);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.uniform1i(gl.getUniformLocation(this.quadProg, "uTex"), 0);
    gl.uniform1f(gl.getUniformLocation(this.quadProg, "uFlip"), bg.flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(loc);
  }

  private useMesh(gl: WebGLRenderingContext): void {
    gl.useProgram(this.meshProg);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (this.featherRings !== Math.round(this.feather)) {
      this.featherRings = Math.round(this.feather);
      const weights = this.featherRings > 0 ? featherWeights(this.featherRings) : new Float32Array(FACE_VERTEX_COUNT).fill(1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufFeather);
      gl.bufferData(gl.ARRAY_BUFFER, weights, gl.STATIC_DRAW);
    }
  }

  private drawMesh(gl: WebGLRenderingContext, tex: WebGLTexture | null, gain: Rgb): void {
    const prog = this.meshProg;
    if (!prog) return;
    const attr = (name: string, buf: WebGLBuffer | null, size: number, data?: Float32Array) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return loc;
    };
    const a = attr("aPos", this.bufPos, 2, this.pos);
    const b = attr("aUv", this.bufUv, 2, this.uv);
    const c = attr("aFeather", this.bufFeather, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
    gl.uniform3f(gl.getUniformLocation(prog, "uGain"), gain[0], gain[1], gain[2]);
    gl.uniform1f(gl.getUniformLocation(prog, "uOpacity"), Math.max(0, Math.min(1, this.opacity)));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
    gl.drawElements(gl.TRIANGLES, FACE_INDICES.length, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(a);
    gl.disableVertexAttribArray(b);
    gl.disableVertexAttribArray(c);
  }

  private upload(gl: WebGLRenderingContext, tex: WebGLTexture | null, image: CanvasImageSource): void {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image as TexImageSource);
    } catch {
      /* image pas encore lisible : on garde la précédente */
    }
  }

  private uploadTextureImage(gl: WebGLRenderingContext): void {
    if (!this.textureDirty || !this.textureImage) return;
    this.upload(gl, this.texTex, this.textureImage);
    this.textureDirty = false;
  }

  /** Copie réduite de l'image (retournée comme à l'écran) pour mesurer les couleurs ; null si illisible. */
  private pixels(frame: Frame): { data: Uint8ClampedArray; w: number; h: number } | null {
    try {
      if (!this.scratch) {
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        this.scratch = { canvas: c, ctx };
      }
      const { canvas: c, ctx } = this.scratch;
      const w = 96;
      const h = Math.max(1, Math.round((96 * frame.height) / Math.max(1, frame.width)));
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      ctx.save();
      if (frame.flip) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(frame.image, 0, 0, w, h);
      ctx.restore();
      const img = ctx.getImageData(0, 0, w, h);
      return { data: new Uint8ClampedArray(img.data), w, h };
    } catch {
      return null; // image d'une autre origine : pas de correction de couleur
    }
  }

  private publish(draw: DrawState): void {
    if (!this.outDataProvider) return;
    const { error, ...rest } = draw;
    const status: FaceMeshState["status"] = error && !draw.ready ? "error" : draw.ready ? "ready" : "idle";
    const state: FaceMeshState = { status, error: error ?? null, ...rest, settings: snapshot(this, FACE_MESH_PARAMS) };
    const key = JSON.stringify(state);
    if (key === this.lastState) return;
    this.lastState = key;
    set(this.outDataProvider, state);
  }
}

/** Visages (listes de ≥ 468 points) d'une sortie de tracker. */
function facesOf(v: unknown): Point[][] {
  const faces = (v as { faces?: Array<{ landmarks?: unknown }> } | null)?.faces;
  if (!Array.isArray(faces)) return [];
  const present = (v as { present?: unknown }).present;
  if (present === false || present === "false") return [];
  const out: Point[][] = [];
  for (const f of faces) if (validLandmarks(f?.landmarks)) out.push(f.landmarks as Point[]);
  return out;
}

function program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error("shader");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram();
  if (!p) throw new Error("program");
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  return p;
}

function texture(gl: WebGLRenderingContext): WebGLTexture | null {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}
