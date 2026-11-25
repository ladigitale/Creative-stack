/**
 * Expressions du visage en 3D : morphs d'humeur, bouche qui parle et regard (`Asset.expr`, construits par
 * `gen/character/face.ts`). Les décalages sont rangés dans une texture demi-flottante lue par le shader de sommets
 * (`gl_VertexID`) ; ce module crée la texture et les uniformes, et fait vivre les poids (transition d'humeur, parole,
 * mâche, regard vers une cible ou petits mouvements d'yeux au repos).
 */
import * as THREE from "three";
import type { Asset } from "../gen/types";
import { EXPR_SLOTS, EXPR_TEX_W } from "./shaders";
import { handPose, mouthOpen } from "../rig/face-motion";

type Expr = NonNullable<Asset["expr"]>;

let empty: THREE.DataTexture | null = null;
function emptyTexture(): THREE.DataTexture {
  if (!empty) {
    empty = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    empty.needsUpdate = true;
  }
  return empty;
}

const textures = new WeakMap<Expr, THREE.DataTexture>();

/** Texture des morphs d'un asset (partagée par tous les acteurs du même personnage). */
export function exprTexture(e: Expr): THREE.DataTexture {
  let t = textures.get(e);
  if (t) return t;
  const n = e.channels.length * e.count;
  const h = Math.max(1, Math.ceil(n / EXPR_TEX_W));
  const data = new Uint16Array(EXPR_TEX_W * h * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(e.data[i * 3]);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(e.data[i * 3 + 1]);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(e.data[i * 3 + 2]);
  }
  t = new THREE.DataTexture(data, EXPR_TEX_W, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  textures.set(e, t);
  return t;
}

/** Uniformes d'expression (neutres : aucune lecture de texture tant que `uExprRange.y` vaut 0). */
export function exprUniforms(): Record<string, THREE.IUniform> {
  return {
    uExprTex: { value: emptyTexture() },
    uExprW: { value: Array.from({ length: EXPR_SLOTS }, () => new THREE.Vector4()) },
    uExprRange: { value: new THREE.Vector2(0, 0) },
  };
}

/** Branche les morphs d'un asset sur des uniformes (sans effet si l'asset n'en a pas). */
export function bindExpr(uniforms: Record<string, THREE.IUniform>, asset: Asset) {
  const e = asset.expr;
  if (!e || e.channels.length > EXPR_SLOTS * 4) return;
  uniforms.uExprTex.value = exprTexture(e);
  (uniforms.uExprRange.value as THREE.Vector2).set(e.base, e.count);
}

const MOODS = ["neutral", "happy", "sad", "angry", "surprised", "sleepy"];

/** État vivant d'un visage : poids courants, regard, saccades. */
export class FaceState {
  /** Poids par canal (ordre de `Asset.expr.channels`). */
  w: number[];
  private channels: readonly string[];
  private gaze: [number, number] = [0, 0];
  private sacc: [number, number] = [0, 0];
  private saccT: number;
  private time = 0;

  constructor(
    readonly asset: Asset,
    mood: string,
    seed: number,
  ) {
    this.channels = asset.expr?.channels ?? [];
    this.w = this.channels.map((c) => (c === mood ? 1 : 0));
    this.saccT = 0.5 + (seed % 2);
  }

  get active() {
    return this.channels.length > 0;
  }

  /**
   * Avance d'un pas : `mood` visé, action en cours (parole, mâche, acclamation), regard voulu en repère de la tête
   * (`look` : [gauche, haut] en radians, ou null pour un regard libre).
   */
  step(dt: number, mood: string, action: string, look: [number, number] | null, seed: number) {
    if (!this.active) return;
    this.time += dt;
    const k = 1 - Math.exp(-dt * 7);
    const target = MOODS.includes(mood) ? mood : "neutral";
    // bouche : parole (syllabes irrégulières), mâche, cri de joie
    const t = this.time + seed;
    const talk = mouthOpen(action, t);
    const hands = handPose(action, t);
    const kh = 1 - Math.exp(-dt * 9);
    // regard libre : petits déplacements de temps en temps
    this.saccT -= dt;
    if (this.saccT <= 0) {
      const r = (x: number) => (Math.sin(x * 12.9898 + seed * 78.233) * 43758.5453) % 1;
      this.sacc = [r(t) * 0.25, r(t + 3.1) * 0.12];
      this.saccT = 1.2 + Math.abs(r(t + 7.7)) * 2.8;
    }
    const want: [number, number] = look ? [clamp(look[0] / 0.6, -1, 1), clamp(look[1] / 0.45, -1, 1)] : this.sacc;
    // les yeux sautent vite vers leur cible
    const kg = 1 - Math.exp(-dt * 18);
    this.gaze[0] += (want[0] - this.gaze[0]) * kg;
    this.gaze[1] += (want[1] - this.gaze[1]) * kg;
    this.channels.forEach((c, i) => {
      if (c === "talk") {
        this.w[i] += (talk - this.w[i]) * (1 - Math.exp(-dt * 25));
        return;
      }
      if (c.endsWith(".l") || c.endsWith(".r")) return void (this.w[i] += ((hands[c] ?? 0) - this.w[i]) * kh);
      if (c === "gazeX") return void (this.w[i] = this.gaze[0]);
      if (c === "gazeY") return void (this.w[i] = this.gaze[1]);
      this.w[i] += ((c === target ? 1 : 0) - this.w[i]) * k;
    });
  }

  /** Recopie les poids dans les uniformes `uExprW`. */
  write(uniforms: Record<string, THREE.IUniform>) {
    const arr = uniforms.uExprW?.value as THREE.Vector4[] | undefined;
    if (!arr) return;
    for (let s = 0; s < arr.length; s++) arr[s].set(this.w[s * 4] ?? 0, this.w[s * 4 + 1] ?? 0, this.w[s * 4 + 2] ?? 0, this.w[s * 4 + 3] ?? 0);
  }
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
