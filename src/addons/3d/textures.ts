import * as THREE from "three";

/**
 * Textures procédurales (canvas 2D, sans image ni `fetch`).
 * Un matériau glTF nommé `tex:<kind>` reçoit la texture correspondante en `map`
 * (le `baseColorFactor` / `color` la teinte). Sans UV dans le glb, ils sont générés :
 * projection sphérique pour `marble`, planaire (XZ) pour les autres.
 */
export type TexKind = "wood" | "felt" | "marble" | "noise";

export const TEX_KINDS: readonly TexKind[] = ["wood", "felt", "marble", "noise"];

const SIZE = 256;
const PLANAR_SCALE = 0.18;
const cache = new Map<TexKind, THREE.Texture | null>();

function hash(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 374761393) ^
    Math.imul(y | 0, 668265263) ^
    Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Bruit de valeur périodique (px × py cellules) → [0,1]. */
function vnoise(x: number, y: number, px: number, py: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const h = (a: number, b: number) =>
    hash(mod(xi + a, px), mod(yi + b, py), seed);
  const top = h(0, 0) + (h(1, 0) - h(0, 0)) * fx;
  const bot = h(0, 1) + (h(1, 1) - h(0, 1)) * fx;
  return top + (bot - top) * fy;
}

function fbm(u: number, v: number, px: number, py: number, seed: number) {
  let a = 0.5;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    const f = 2 ** o;
    sum += a * vnoise(u * px * f, v * py * f, px * f, py * f, seed + o);
    norm += a;
    a *= 0.5;
  }
  return sum / norm;
}

/** Valeur de gris [0,1] pour (u,v) ∈ [0,1[². */
function sample(kind: TexKind, u: number, v: number): number {
  switch (kind) {
    case "wood": {
      // Fibres le long de u, anneaux ondulés en v (contraste proche d'un vrai plateau).
      const warp = fbm(u, v, 3, 2, 11) * 5;
      const rings = (0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 9 + warp)) ** 1.8;
      const fiber = vnoise(u * 6, v * 90, 6, 90, 5);
      const mottle = fbm(u, v, 4, 4, 17);
      return Math.max(0.35, 1 - 0.3 * rings - 0.3 * (fiber - 0.5) - 0.2 * (0.6 - mottle));
    }
    case "felt": {
      const grain = hash((u * SIZE) | 0, (v * SIZE) | 0, 3);
      const fib = vnoise(u * 60, v * 60, 60, 60, 4);
      return 0.72 + 0.16 * grain + 0.1 * fib + 0.1 * fbm(u, v, 5, 5, 9);
    }
    case "marble": {
      // Corps nuageux sombre + veines claires (teintées par la couleur de la bille).
      const n = fbm(u, v, 3, 2, 21);
      const cloud = fbm(u, v, 5, 3, 27);
      const s1 = Math.abs(Math.sin((u * 3 + v * 1.5 + n * 2.2) * Math.PI));
      const vein = Math.max(0, (0.12 - s1) / 0.12) ** 2;
      const s2 = Math.abs(Math.sin((v * 2 + u * 0.8 + cloud * 3.1) * Math.PI * 1.1));
      const vein2 = Math.max(0, (0.3 - s2) / 0.3) * 0.35;
      return Math.min(1, 0.55 + 0.42 * cloud + 0.25 * vein + vein2 * 0.15);
    }
    default:
      return 0.85 + 0.15 * hash((u * SIZE) | 0, (v * SIZE) | 0, 1);
  }
}

function make(kind: TexKind): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const img = g.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const c = Math.round(255 * Math.min(1, Math.max(0, sample(kind, x / SIZE, y / SIZE))));
      const i = (y * SIZE + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function get(kind: TexKind): THREE.Texture | null {
  if (!cache.has(kind)) cache.set(kind, make(kind));
  return cache.get(kind) ?? null;
}

function kindOf(name: string): TexKind | null {
  if (!name.startsWith("tex:")) return null;
  const k = name.slice(4) as TexKind;
  return TEX_KINDS.includes(k) ? k : null;
}

/** UV générés quand la géométrie n'en a pas (glb plus léger). */
function ensureUv(mesh: THREE.Mesh, kind: TexKind) {
  const geo = mesh.geometry;
  if (!geo || geo.getAttribute("uv")) return;
  const pos = geo.getAttribute("position");
  if (!pos) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (kind === "marble") {
      const r = Math.hypot(x, y, z) || 1;
      uv[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
      uv[i * 2 + 1] = Math.acos(Math.max(-1, Math.min(1, y / r))) / Math.PI;
    } else {
      uv[i * 2] = x * PLANAR_SCALE;
      uv[i * 2 + 1] = z * PLANAR_SCALE;
    }
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** Pose les textures procédurales sur les matériaux `tex:<kind>` du contenu chargé. */
function apply(root: THREE.Object3D | null) {
  if (!root) return;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const kind = kindOf(m?.name ?? "");
      if (!kind || !("map" in m)) continue;
      const std = m as THREE.MeshStandardMaterial;
      if (std.map) continue;
      const tex = get(kind);
      if (!tex) continue;
      ensureUv(mesh, kind);
      std.map = tex;
      std.needsUpdate = true;
    }
  });
}

export const textures = { apply, get, kindOf, ensureUv } as const;
