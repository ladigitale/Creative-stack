/**
 * Lecture des clips d'un modèle « monde » : pour chaque pièce, décalages par rapport au repos
 * (rx, ry, rz en radians, x, y, z en mètres, s facteur d'échelle). Commun à `sonic-3d` et `sonic-2d` :
 * une même instance, le même clip, au même instant, donne la même pose dans les deux rendus.
 */
import { m4Compose, m4Mul, type M4 } from "./math";
import type { Clip, Model, Part } from "./format";

/** Décalages par pièce : 7 nombres (rx, ry, rz, x, y, z, s). */
export const STRIDE = 7;

/** Durée du fondu entre deux clips (ms). */
export const BLEND_MS = 160;

export type ClipState = {
  clip: string;
  start: number;
  speed: number;
  /** Position imposée 0..1 (clipT) : le clip ne défile plus. */
  fixed: number | null;
  prev: string;
  prevStart: number;
  prevSpeed: number;
  blendStart: number;
};

export function clipState(clip: string, now: number): ClipState {
  return { clip, start: now, speed: 1, fixed: null, prev: "", prevStart: now, prevSpeed: 1, blendStart: -1e9 };
}

/** Change de clip (fondu court), de vitesse ou de position ; renvoie true si quelque chose a changé. */
export function setClip(st: ClipState, now: number, clip?: string, speed?: number, fixed?: number | null): boolean {
  let changed = false;
  if (typeof speed === "number" && Number.isFinite(speed) && speed !== st.speed) {
    // garde la phase courante : le temps de départ est recalé
    const el = (now - st.start) * st.speed;
    st.speed = Math.max(0, Math.min(8, speed));
    st.start = st.speed > 0 ? now - el / st.speed : now;
    changed = true;
  }
  if (fixed !== undefined && fixed !== st.fixed) {
    st.fixed = fixed;
    changed = true;
  }
  if (typeof clip === "string" && clip !== st.clip) {
    st.prev = st.clip;
    st.prevStart = st.start;
    st.prevSpeed = st.speed;
    st.blendStart = now;
    st.clip = clip;
    st.start = now;
    changed = true;
  }
  return changed;
}

export function sampleKeys(keys: number[], u: number, loop: boolean, smooth: boolean): number {
  const n = keys.length;
  if (n === 1) return keys[0];
  let f: number, i0: number, i1: number, im: number, i2: number;
  if (loop) {
    const x = (u - Math.floor(u)) * n;
    i0 = Math.floor(x) % n;
    f = x - Math.floor(x);
    i1 = (i0 + 1) % n;
    im = (i0 - 1 + n) % n;
    i2 = (i0 + 2) % n;
  } else {
    const x = Math.max(0, Math.min(1, u)) * (n - 1);
    i0 = Math.min(n - 2, Math.floor(x));
    f = x - i0;
    i1 = i0 + 1;
    im = Math.max(0, i0 - 1);
    i2 = Math.min(n - 1, i0 + 2);
  }
  const a = keys[i0], b = keys[i1];
  if (!smooth) return a + (b - a) * f;
  // Catmull-Rom : passe par chaque clé, sans à-coup
  const p0 = keys[im], p3 = keys[i2];
  const f2 = f * f, f3 = f2 * f;
  return 0.5 * (2 * a + (-p0 + b) * f + (2 * p0 - 5 * a + 4 * b - p3) * f2 + (-p0 + 3 * a - 3 * b + p3) * f3);
}

/** Avancement (0..1 pour un clip non bouclé, cycles pour un clip bouclé) d'un clip à l'instant `now`. */
function progress(c: Clip, start: number, speed: number, fixed: number | null, now: number): number {
  if (fixed !== null) return fixed;
  return ((now - start) * speed) / c.ms;
}

/** Canaux multiplicatifs (échelles, opacité) : la clé est un facteur, pas un décalage. */
function addClip(c: Clip, u: number, w: number, out: Float32Array, stride: number, mult: number) {
  for (const t of c.tracks) {
    const v = sampleKeys(t.keys, u + t.phase, c.loop, c.smooth);
    const k = t.part * stride + t.ch;
    if (mult & (1 << t.ch)) out[k] += (v - 1) * w;
    else out[k] += v * w;
  }
}

/**
 * Remplit `out` (parts × STRIDE, s = 1 par défaut) ; renvoie `true` tant que la pose bouge encore
 * (clip bouclé, clip en cours, fondu en cours). Un clip non bouclé fini passe à `then` s'il existe.
 */
export function samplePose(model: Model, st: ClipState, now: number, out: Float32Array): boolean {
  return sampleClips(model.clips, st, now, out, STRIDE, 1 << 6);
}

/**
 * Lecture générique (3D : rx ry rz x y z s ; 2D : voir monde2d) : `mult` = masque des canaux multiplicatifs,
 * initialisés à 1.
 */
export function sampleClips(clips: Map<string, Clip>, st: ClipState, now: number, out: Float32Array, stride: number, mult: number): boolean {
  out.fill(0);
  for (let ch = 0; ch < stride; ch++) if (mult & (1 << ch)) for (let i = ch; i < out.length; i += stride) out[i] = 1;
  let c = clips.get(st.clip);
  if (c && !c.loop && st.fixed === null && c.then && c.then !== st.clip && clips.has(c.then)) {
    const u = progress(c, st.start, st.speed, null, now);
    if (u >= 1) {
      setClip(st, st.start + (c.ms / Math.max(1e-3, st.speed)), c.then);
      c = clips.get(st.clip);
    }
  }
  const bw = st.prev ? Math.min(1, (now - st.blendStart) / BLEND_MS) : 1;
  let moving = false;
  if (c) {
    const u = progress(c, st.start, st.speed, st.fixed, now);
    addClip(c, u, bw, out, stride, mult);
    const chains = !!c.then && c.then !== st.clip && clips.has(c.then);
    moving = st.fixed === null && st.speed > 0 && (c.loop || u < 1 || chains);
  }
  if (bw < 1) {
    const p = clips.get(st.prev);
    if (p) addClip(p, progress(p, st.prevStart, st.prevSpeed, null, now), 1 - bw, out, stride, mult);
    moving = true;
  } else st.prev = "";
  return moving;
}

/** Matrice locale d'une pièce (articulation) avec ses décalages de clip. */
export function partLocal(p: Part, offs: Float32Array, i: number, out: M4): M4 {
  const o = i * STRIDE;
  const s = offs[o + 6];
  return m4Compose(
    out,
    p.at[0] + offs[o + 3],
    p.at[1] + offs[o + 4],
    p.at[2] + offs[o + 5],
    p.rot[0] + offs[o],
    p.rot[1] + offs[o + 1],
    p.rot[2] + offs[o + 2],
    p.scale[0] * s,
    p.scale[1] * s,
    p.scale[2] * s,
  );
}

/** Matrices monde de toutes les pièces (cinématique directe), racine = `root`. `world` : parts × 16. */
export function forward(model: Model, offs: Float32Array, root: M4, world: Float32Array, tmp: M4): void {
  const parts = model.parts;
  for (let i = 0; i < parts.length; i++) {
    partLocal(parts[i], offs, i, tmp);
    const pi = parts[i].parent;
    const parent = pi >= 0 ? world.subarray(pi * 16, pi * 16 + 16) : root;
    m4Mul(world.subarray(i * 16, i * 16 + 16), parent, tmp);
  }
}
