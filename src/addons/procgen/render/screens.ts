/**
 * Écrans animés (rendu 3D) : télévisions, ordinateurs, téléphones, toiles de cinéma, panneaux et écrans
 * publicitaires. Chaque objet qui porte un écran (`screen` de l'objet : centre, taille, inclinaison) peut afficher :
 * - une vidéo (`video`) ou une image (`image`) : URL https, relative, blob: ou data: du bon type (jamais d'autre schéma) ;
 * - un diaporama (`images`, `interval` s) ;
 * - un élément de la page (`element: "#id"`) : canvas (sonic-shader, dessin…), vidéo ou image, recopié à chaque image ;
 * - une chaîne générée (`channel`) : mire, neige, info (bandeau défilant avec `text`), pub (`text` qui pulse),
 *   horloge, dessin animé.
 * Le contenu est éteint (`on: false`) ou allumé sans recomposer la scène : la clé `screens` du DataProvider est relue
 * à chaque changement. L'écran émet sa propre lumière (pas d'ombrage).
 */
import * as THREE from "three";
import { safeMediaUrl } from "../../../shared/media/urls";
import { type V3, m4Compose, qAxis, qMul } from "../core/math";
import type { ObjectInfo } from "../scene/compose";

export const SCREEN_CHANNELS = ["bars", "noise", "news", "ad", "clock", "cartoon"] as const;

export type ScreenSpec = {
  on?: boolean;
  video?: string;
  image?: string;
  images?: string[];
  interval?: number;
  element?: string;
  channel?: string;
  text?: string;
  /** Couleur d'accent de la chaîne (#rrggbb). */
  color?: string;
  brightness?: number;
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Lecture tolérante d'un contenu d'écran (chaîne seule = nom de chaîne ou URL). */
export function readScreen(v: unknown): ScreenSpec | null {
  if (v === null || v === undefined || v === false) return null;
  if (v === true) return { channel: "bars" };
  if (typeof v === "string") {
    const s = v.trim();
    if ((SCREEN_CHANNELS as readonly string[]).includes(s)) return { channel: s };
    if (s.startsWith("#")) return { element: s };
    if (safeMediaUrl(s, "video") && /\.(mp4|webm|ogv|mov)(\?|$)/i.test(s)) return { video: s };
    if (safeMediaUrl(s, "image")) return { image: s };
    return null;
  }
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: ScreenSpec = {};
  if (o.on === false) out.on = false;
  if (typeof o.video === "string" && safeMediaUrl(o.video, "video")) out.video = o.video;
  if (typeof o.image === "string" && safeMediaUrl(o.image, "image")) out.image = o.image;
  if (Array.isArray(o.images)) out.images = o.images.filter((u): u is string => typeof u === "string" && safeMediaUrl(u, "image")).slice(0, 24);
  if (typeof o.interval === "number" && Number.isFinite(o.interval)) out.interval = Math.min(120, Math.max(0.5, o.interval));
  if (typeof o.element === "string" && /^#[A-Za-z][\w-]{0,80}$/.test(o.element)) out.element = o.element;
  if (typeof o.channel === "string" && (SCREEN_CHANNELS as readonly string[]).includes(o.channel)) out.channel = o.channel;
  if (typeof o.text === "string") out.text = o.text.slice(0, 200);
  if (typeof o.color === "string" && HEX.test(o.color)) out.color = o.color;
  if (typeof o.brightness === "number" && Number.isFinite(o.brightness)) out.brightness = Math.min(2, Math.max(0.1, o.brightness));
  if (!out.video && !out.image && !out.images?.length && !out.element && !out.channel && out.on !== false) out.channel = "bars";
  return out;
}

/** Identifiant d'objet des écrans dans les données de la scène (contours, brume) : aucun objet ne le porte. */
const SCREEN_OBJ = 999_979;

const VS = /* glsl */ `
out vec2 vUv;
out float vViewZ;
out vec3 vNv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = -mv.z;
  vNv = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;
// émissif : la couleur de l'image, sans ombrage ; même sortie de données que la scène (normale, profondeur, objet)
const FS = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outData;
in vec2 vUv;
in float vViewZ;
in vec3 vNv;
uniform sampler2D map;
uniform float uHasMap;
uniform float uBright;
uniform float uFar;
void main() {
  vec3 c = uHasMap > 0.5 ? texture(map, vUv).rgb : vec3(0.02);
  outColor = vec4(c * uBright, 1.0);
  outData = vec4(normalize(vNv).xy * 0.5 + 0.5, vViewZ / uFar, fract(${SCREEN_OBJ}.0 * 0.0731 + 0.1));
}`;

type Item = {
  key: string;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  tex: THREE.Texture | null;
  spec: ScreenSpec;
  canvas?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D | null;
  video?: HTMLVideoElement;
  imgs?: HTMLImageElement[];
  el?: HTMLCanvasElement | HTMLVideoElement | HTMLImageElement | null;
  last: number;
  seed: number;
};

export class ScreenLayer {
  readonly group = new THREE.Group();
  private items = new Map<string, Item>();

  /** `far` : uniforme partagé de la scène (profondeur des données). */
  constructor(private far: { value: number }) {
    this.group.name = "procgen~screens";
  }

  get count() {
    return this.items.size;
  }

  /** Écrans à afficher : `objects` (avec `screen`), contenus par id d'objet (recette, couche, DataProvider). */
  sync(objects: ObjectInfo[], specs: Record<string, unknown>) {
    const want = new Map<string, { o: ObjectInfo; spec: ScreenSpec }>();
    for (const o of objects) {
      if (!o.screen) continue;
      const raw = specs[o.id] ?? specs[o.layer] ?? o.screen.content;
      const spec = readScreen(raw);
      if (!spec || spec.on === false) continue;
      want.set(o.id, { o, spec });
    }
    for (const [id, it] of this.items) if (!want.has(id)) this.drop(id, it);
    for (const [id, { o, spec }] of want) {
      const key = JSON.stringify(spec);
      let it = this.items.get(id);
      if (it && it.key !== key) {
        this.drop(id, it);
        it = undefined;
      }
      if (!it) it = this.make(id, spec, key);
      this.place(it, o);
    }
  }

  private make(id: string, spec: ScreenSpec, key: string): Item {
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: { map: { value: null }, uHasMap: { value: 0 }, uBright: { value: 1 }, uFar: this.far } });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.name = `screen~${id}`;
    mesh.renderOrder = 1;
    const it: Item = { key, mesh, mat, tex: null, spec, last: -1, seed: [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7) };
    mat.uniforms.uBright.value = spec.brightness ?? 1;
    if (typeof document !== "undefined") {
      if (spec.video) {
        const v = document.createElement("video");
        v.crossOrigin = "anonymous";
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
        v.src = spec.video;
        void v.play?.().catch(() => undefined);
        it.video = v;
        it.tex = new THREE.VideoTexture(v);
        mat.uniforms.uHasMap.value = 1;
      } else if (spec.image || spec.images?.length) {
        const urls = spec.images?.length ? spec.images : [spec.image!];
        it.imgs = urls.map((u) => {
          const im = new Image();
          im.crossOrigin = "anonymous";
          im.decoding = "async";
          im.src = u;
          return im;
        });
        it.tex = new THREE.Texture();
      } else if (spec.element) {
        it.el = this.findElement(spec.element);
        it.tex = it.el instanceof HTMLVideoElement ? new THREE.VideoTexture(it.el) : new THREE.Texture();
        if (it.el instanceof HTMLVideoElement) mat.uniforms.uHasMap.value = 1;
      } else {
        it.canvas = document.createElement("canvas");
        it.canvas.width = 384;
        it.canvas.height = 216;
        it.ctx = it.canvas.getContext("2d");
        it.tex = new THREE.CanvasTexture(it.canvas);
      }
    }
    if (it.tex) {
      it.tex.colorSpace = THREE.SRGBColorSpace;
      mat.uniforms.map.value = it.tex;
    }
    this.group.add(mesh);
    this.items.set(id, it);
    return it;
  }

  /** Élément de la page : canvas, vidéo, image, ou premier canvas / vidéo d'un composant (ombre comprise). */
  private findElement(sel: string): HTMLCanvasElement | HTMLVideoElement | HTMLImageElement | null {
    const el = document.getElementById(sel.slice(1));
    if (!el) return null;
    if (el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement || el instanceof HTMLImageElement) return el;
    const root = (el as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? el;
    return (root.querySelector("canvas, video") as HTMLCanvasElement | HTMLVideoElement | null) ?? null;
  }

  private place(it: Item, o: ObjectInfo) {
    const s = o.screen!;
    const q = qMul(qAxis([0, 1, 0], o.yaw), qAxis([1, 0, 0], ((s.tilt ?? 0) * Math.PI) / 180));
    // légèrement devant la dalle de l'écran
    const c: V3 = [s.c[0], s.c[1], s.c[2] + 0.004];
    const T = m4Compose(o.pos, qAxis([0, 1, 0], o.yaw), o.scale);
    const p: V3 = [T[0] * c[0] + T[4] * c[1] + T[8] * c[2] + T[12], T[1] * c[0] + T[5] * c[1] + T[9] * c[2] + T[13], T[2] * c[0] + T[6] * c[1] + T[10] * c[2] + T[14]];
    it.mesh.position.set(p[0], p[1], p[2]);
    it.mesh.quaternion.set(q[0], q[1], q[2], q[3]);
    it.mesh.scale.set(s.w * o.scale, s.h * o.scale, 1);
  }

  /** Une image : chaînes dessinées (12 i/s), diaporama, recopie des éléments de la page. */
  step(time: number) {
    for (const it of this.items.values()) {
      const sp = it.spec;
      if (it.imgs && it.tex) {
        const n = it.imgs.length;
        const k = n > 1 ? Math.floor(time / (sp.interval ?? 5)) % n : 0;
        const im = it.imgs[k];
        if (im.complete && im.naturalWidth > 0 && it.tex.image !== im) {
          it.tex.image = im;
          it.tex.needsUpdate = true;
          it.mat.uniforms.uHasMap.value = 1;
        }
      } else if (it.el && it.tex && !(it.el instanceof HTMLVideoElement)) {
        if (it.tex.image !== it.el) it.tex.image = it.el;
        if (it.el instanceof HTMLCanvasElement ? it.el.width > 0 : it.el.complete) ((it.tex.needsUpdate = true), (it.mat.uniforms.uHasMap.value = 1));
      } else if (it.ctx && it.tex) {
        const f = Math.floor(time * 12);
        if (f === it.last) continue;
        it.last = f;
        drawChannel(it.ctx, sp, time, it.seed);
        it.tex.needsUpdate = true;
        it.mat.uniforms.uHasMap.value = 1;
      }
    }
  }

  private drop(id: string, it: Item) {
    this.group.remove(it.mesh);
    it.mesh.geometry.dispose();
    it.tex?.dispose();
    it.mat.dispose();
    if (it.video) {
      it.video.pause();
      it.video.removeAttribute("src");
      it.video.load();
    }
    this.items.delete(id);
  }

  dispose() {
    for (const [id, it] of [...this.items]) this.drop(id, it);
  }
}

/** Chaînes générées, dessinées au canvas 2D (aucun HTML injecté). */
export function drawChannel(g: CanvasRenderingContext2D, sp: ScreenSpec, t: number, seed: number) {
  const W = g.canvas.width, H = g.canvas.height;
  const accent = sp.color ?? ["#e8463c", "#2f7de1", "#f2b632", "#27a36b"][seed % 4];
  switch (sp.channel) {
    case "noise": {
      // neige : grains gris qui changent à chaque image
      const img = g.createImageData(W / 4, H / 4);
      let r = (Math.floor(t * 12) * 9301 + seed) % 233280;
      for (let i = 0; i < img.data.length; i += 4) {
        r = (r * 9301 + 49297) % 233280;
        const v = (r / 233280) * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(g.canvas, 0, 0, W / 4, H / 4, 0, 0, W, H);
      break;
    }
    case "news": {
      // journal : fond, présentateur en silhouette, logo, bandeau défilant en bas
      const grd = g.createLinearGradient(0, 0, W, H);
      grd.addColorStop(0, "#14315a");
      grd.addColorStop(1, "#0a1a30");
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      g.fillStyle = "rgba(255,255,255,0.08)";
      for (let i = 0; i < 6; i++) g.fillRect(((i * 70 + t * 10) % (W + 60)) - 60, 30 + i * 14, 50, 2);
      g.fillStyle = "#d9b38c";
      g.beginPath();
      g.arc(W * 0.32, H * 0.42, H * 0.12, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#2b2f3a";
      g.fillRect(W * 0.2, H * 0.55, W * 0.24, H * 0.3);
      g.fillStyle = accent;
      g.fillRect(W * 0.58, H * 0.2, W * 0.34, H * 0.42);
      g.fillStyle = "#fff";
      g.font = `bold ${Math.round(H * 0.09)}px sans-serif`;
      g.fillText("INFO", W * 0.62, H * 0.33);
      g.fillStyle = accent;
      g.fillRect(0, H * 0.82, W, H * 0.18);
      g.fillStyle = "#fff";
      g.font = `bold ${Math.round(H * 0.08)}px sans-serif`;
      const msg = (sp.text ?? "Dernières nouvelles · Météo : soleil · Circulation fluide") + "   ·   ";
      const tw = g.measureText(msg).width;
      const x = -((t * 60) % tw);
      for (let k = 0; k < 3; k++) g.fillText(msg, x + k * tw, H * 0.94);
      break;
    }
    case "ad": {
      // publicité : dégradé qui tourne, texte qui pulse, formes qui passent
      const hue = (t * 20 + seed) % 360;
      const grd = g.createLinearGradient(0, 0, W, H);
      grd.addColorStop(0, `hsl(${hue},80%,55%)`);
      grd.addColorStop(1, `hsl(${(hue + 60) % 360},80%,45%)`);
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 5; i++) {
        g.fillStyle = "rgba(255,255,255,0.18)";
        g.beginPath();
        g.arc(((i * 97 + t * 40) % (W + 80)) - 40, H * (0.2 + 0.15 * i), 18 + 6 * i, 0, Math.PI * 2);
        g.fill();
      }
      const s = 1 + 0.06 * Math.sin(t * 4);
      g.save();
      g.translate(W / 2, H / 2);
      g.scale(s, s);
      g.fillStyle = "#fff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `bold ${Math.round(H * 0.2)}px sans-serif`;
      g.fillText(sp.text ?? "SOLDES -50%", 0, 0);
      g.restore();
      g.textAlign = "start";
      g.textBaseline = "alphabetic";
      break;
    }
    case "clock": {
      g.fillStyle = "#050807";
      g.fillRect(0, 0, W, H);
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0"), ss = String(d.getSeconds()).padStart(2, "0");
      g.fillStyle = accent;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `bold ${Math.round(H * 0.36)}px monospace`;
      g.fillText(`${hh}:${mm}`, W / 2, H * 0.45);
      g.font = `${Math.round(H * 0.12)}px monospace`;
      g.fillText(ss, W / 2, H * 0.78);
      g.textAlign = "start";
      g.textBaseline = "alphabetic";
      break;
    }
    case "cartoon": {
      // dessin animé : ciel, collines qui défilent, personnage rond qui saute
      g.fillStyle = "#7cc6f2";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#ffd84a";
      g.beginPath();
      g.arc(W * 0.85, H * 0.2, H * 0.1, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#5cb85c";
      for (let i = -1; i < 5; i++) {
        const x = i * 110 - ((t * 50) % 110);
        g.beginPath();
        g.arc(x, H, 90, Math.PI, 0);
        g.fill();
      }
      const y = H * 0.62 - Math.abs(Math.sin(t * 3)) * H * 0.3;
      g.fillStyle = accent;
      g.beginPath();
      g.arc(W * 0.4, y, H * 0.11, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(W * 0.42, y - H * 0.03, H * 0.035, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#000";
      g.beginPath();
      g.arc(W * 0.43, y - H * 0.03, H * 0.016, 0, Math.PI * 2);
      g.fill();
      break;
    }
    default: {
      // mire : barres de couleur, bandeau inférieur, carré qui clignote
      const cols = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
      cols.forEach((c, i) => {
        g.fillStyle = c;
        g.fillRect((i * W) / 7, 0, W / 7 + 1, H * 0.72);
      });
      const cols2 = ["#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0"];
      cols2.forEach((c, i) => {
        g.fillStyle = c;
        g.fillRect((i * W) / 7, H * 0.72, W / 7 + 1, H * 0.08);
      });
      g.fillStyle = "#101010";
      g.fillRect(0, H * 0.8, W, H * 0.2);
      g.fillStyle = Math.floor(t * 2) % 2 ? "#fff" : "#101010";
      g.fillRect(W * 0.8, H * 0.84, H * 0.1, H * 0.1);
    }
  }
}
