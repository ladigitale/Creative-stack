/**
 * Chevelures en mèches : des dizaines de mèches (petites chaînes verlet) plantées sur le haut et l'arrière d'une
 * pièce (la tête), qui tombent, suivent la tête, ondulent au vent et ne traversent pas le crâne. Pur calcul ; le
 * rendu en fait un seul maillage de rubans (un appel de dessin par chevelure).
 */
import { Rand } from "../monde/math";

export type V3 = [number, number, number];

export type HairSpec = {
  /** Nombre de mèches. */
  count: number;
  /** Longueur (m), variation (0 à 1). */
  length: number;
  spread: number;
  /** Ondulation (0 à 1), raideur près de la racine (0 à 1). */
  wave: number;
  stiffness: number;
  /** Largeur d'une mèche (m). */
  width: number;
  /** Couleur (vide : celle de la pièce). */
  color: string;
  /** Coupe : implantation des racines. */
  cut: "longs" | "courts" | "frange" | "queue" | "herisses";
  wind: number;
};

const CUTS = ["longs", "courts", "frange", "queue", "herisses"] as const;
const SEG = 5;

export function readHair(v: unknown, issue: (m: string) => void): HairSpec | null {
  if (v === undefined || v === null || v === false) return null;
  const o: Record<string, unknown> = v === true ? {} : typeof v === "string" ? { coupe: v } : v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const c = String(o.coupe ?? o.cut ?? "longs").toLowerCase().replace("é", "e");
  const cut = (CUTS as readonly string[]).includes(c) ? (c as HairSpec["cut"]) : null;
  if (!cut) issue(`cheveux : coupe « ${c} » inconnue (${CUTS.join(", ")})`);
  const n = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d);
  const k = cut ?? "longs";
  const defLen = k === "longs" ? 0.35 : k === "queue" ? 0.4 : k === "courts" ? 0.07 : k === "herisses" ? 0.09 : 0.12;
  return {
    count: Math.round(n(o.nombre ?? o.count, k === "queue" ? 40 : 90, 4, 400)),
    length: n(o.longueur ?? o.length, defLen, 0.01, 2),
    spread: n(o.variation ?? o.spread, 0.25, 0, 1),
    wave: n(o.ondulation ?? o.wave, 0.15, 0, 1),
    stiffness: n(o.raideur ?? o.stiffness, k === "herisses" ? 0.95 : k === "courts" ? 0.8 : 0.35, 0, 1),
    width: n(o.epaisseur ?? o.width, k === "herisses" ? 0.03 : k === "courts" ? 0.05 : 0.065, 0.003, 0.2),
    color: typeof o.couleur === "string" && /^#[0-9a-f]{6}$/i.test(o.couleur) ? o.couleur : "",
    cut: k,
    wind: n(o.vent ?? o.wind, 1, 0, 3),
  };
}

/** Racines sur la sphère de la tête (repère de la pièce) : position et direction de pousse. */
function roots(spec: HairSpec, c: V3, r: number): { p: V3; d: V3; len: number }[] {
  const out: { p: V3; d: V3; len: number }[] = [];
  const rand = new Rand(`cheveux${spec.count}${spec.cut}`);
  for (let i = 0; i < spec.count; i++) {
    // répartition en spirale (Fibonacci) sur la calotte, restreinte selon la coupe
    const t = (i + 0.5) / spec.count;
    let theta: number, phi: number;
    const golden = Math.PI * (3 - Math.sqrt(5));
    if (spec.cut === "queue") {
      // touffe serrée à l'arrière du crâne
      theta = 0.15 + 0.25 * Math.sqrt(t);
      phi = i * golden;
      const p: V3 = [Math.sin(theta) * Math.cos(phi) * 0.4, Math.cos(theta) * 0.2 + 0.25, -0.9];
      const l = Math.hypot(p[0], p[1], p[2]);
      const d: V3 = [p[0] / l, p[1] / l, p[2] / l];
      out.push({ p: [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r], d: [d[0] * 0.3, -0.2, -1], len: spec.length * (1 - spec.spread * rand.next()) });
      continue;
    }
    // calotte : haut et arrière (pas le visage, +z), frange : avant
    theta = Math.acos(1 - t * (spec.cut === "frange" ? 0.6 : 1.15));
    phi = i * golden;
    const d: V3 = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
    if (spec.cut !== "frange" && d[2] > 0.35 && d[1] < 0.75) continue;
    if (spec.cut === "frange" && d[2] < -0.1) continue;
    // pousse « coiffée » : couchée sur le crâne vers le bas et l'arrière (hérissés : droit dehors)
    const comb: V3 =
      spec.cut === "herisses"
        ? d
        : spec.cut === "frange"
          ? [d[0] * 0.35, -1, d[2] * 0.35 + 0.45]
          : [d[0] * (spec.cut === "courts" ? 0.6 : 0.3), -1 + Math.max(0, d[1]) * 0.4, d[2] * 0.3 - 0.35];
    out.push({ p: [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r], d: comb, len: spec.length * (1 - spec.spread * rand.next()) });
  }
  return out;
}

export class HairSim {
  readonly strands: number;
  /** Points par mèche (SEG + 1). */
  readonly per = SEG + 1;
  readonly pos: Float32Array;
  private prev: Float32Array;
  /** Racine et direction de pousse (repère de la pièce) par mèche ; longueur d'un segment. */
  private root: Float32Array;
  private dir: Float32Array;
  private seg: Float32Array;
  private started = false;
  private acc = 0;
  private t = 0;
  /** Centre et rayon du crâne (repère de la pièce). */
  constructor(readonly spec: HairSpec, private head: V3, private radius: number) {
    const rs = roots(spec, head, radius);
    this.strands = rs.length;
    this.pos = new Float32Array(rs.length * this.per * 3);
    this.prev = new Float32Array(this.pos.length);
    this.root = new Float32Array(rs.length * 3);
    this.dir = new Float32Array(rs.length * 3);
    this.seg = new Float32Array(rs.length);
    rs.forEach((r, i) => {
      this.root.set(r.p, i * 3);
      const l = Math.hypot(r.d[0], r.d[1], r.d[2]) || 1;
      this.dir.set([r.d[0] / l, r.d[1] / l, r.d[2] / l], i * 3);
      this.seg[i] = r.len / SEG;
    });
  }

  private local(m: ArrayLike<number>, x: number, y: number, z: number, out: Float32Array, o: number, dirOnly = false) {
    const w = dirOnly ? 0 : 1;
    out[o] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  }

  reset(m: ArrayLike<number>) {
    const tmp = new Float32Array(3), dw = new Float32Array(3);
    for (let s = 0; s < this.strands; s++) {
      this.local(m, this.root[s * 3], this.root[s * 3 + 1], this.root[s * 3 + 2], tmp, 0);
      this.local(m, this.dir[s * 3], this.dir[s * 3 + 1], this.dir[s * 3 + 2], dw, 0, true);
      const l = Math.hypot(dw[0], dw[1], dw[2]) || 1;
      for (let k = 0; k < this.per; k++) {
        const o = (s * this.per + k) * 3;
        // départ : pousse puis retombe (évite une première image hérissée)
        const down = Math.min(1, k / 2);
        this.pos[o] = tmp[0] + (dw[0] / l) * this.seg[s] * k * (1 - down * 0.5);
        this.pos[o + 1] = tmp[1] + (dw[1] / l) * this.seg[s] * k * (1 - down) - this.seg[s] * k * down * 0.8;
        this.pos[o + 2] = tmp[2] + (dw[2] / l) * this.seg[s] * k * (1 - down * 0.5);
      }
    }
    this.prev.set(this.pos);
    this.started = true;
  }

  /** Avance (pas fixes de 1/60 s) ; `m` : matrice monde de la tête ; `wind` en m/s. */
  step(dt: number, m: ArrayLike<number>, gravity: V3, wind: V3): boolean {
    if (!this.started) {
      this.reset(m);
      return true;
    }
    const h = 1 / 60;
    this.acc = Math.min(this.acc + dt, h * 3);
    let ticked = false;
    while (this.acc >= h) {
      this.acc -= h;
      this.t += h;
      this.tick(h, m, gravity, wind);
      ticked = true;
    }
    return ticked;
  }

  private tick(h: number, m: ArrayLike<number>, gravity: V3, wind: V3) {
    const pos = this.pos, prev = this.prev, per = this.per, sp = this.spec;
    const rootW = new Float32Array(3), dirW = new Float32Array(3), headW = new Float32Array(3);
    this.local(m, this.head[0], this.head[1], this.head[2], headW, 0);
    const scale = Math.hypot(m[0], m[1], m[2]);
    const rad = this.radius * scale;
    const gust = 0.6 + 0.4 * Math.sin(this.t * 1.9) * Math.sin(this.t * 0.51 + 2);
    for (let s = 0; s < this.strands; s++) {
      this.local(m, this.root[s * 3], this.root[s * 3 + 1], this.root[s * 3 + 2], rootW, 0);
      this.local(m, this.dir[s * 3], this.dir[s * 3 + 1], this.dir[s * 3 + 2], dirW, 0, true);
      const dl = Math.hypot(dirW[0], dirW[1], dirW[2]) || 1;
      const seg = this.seg[s] * scale;
      const base = s * per * 3;
      // racine collée au crâne
      pos[base] = prev[base] = rootW[0];
      pos[base + 1] = prev[base + 1] = rootW[1];
      pos[base + 2] = prev[base + 2] = rootW[2];
      for (let k = 1; k < per; k++) {
        const o = base + k * 3;
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        const wv = sp.wind * gust * (0.7 + 0.3 * Math.sin(this.t * 5 + s * 1.7 + k));
        const vx = (x - prev[o]) * 0.96, vy = (y - prev[o + 1]) * 0.96, vz = (z - prev[o + 2]) * 0.96;
        prev[o] = x;
        prev[o + 1] = y;
        prev[o + 2] = z;
        pos[o] = x + vx + (gravity[0] + wind[0] * wv * 2) * h * h;
        pos[o + 1] = y + vy + (gravity[1] + wind[1] * wv * 2) * h * h;
        pos[o + 2] = z + vz + (gravity[2] + wind[2] * wv * 2) * h * h;
      }
      for (let it = 0; it < 3; it++) {
        for (let k = 1; k < per; k++) {
          const a = base + (k - 1) * 3, b = base + k * 3;
          // raideur : chaque segment tend vers le prolongement de la pousse, plus fort près de la racine
          const fall = 1 - (k - 1) / (per - 1);
          const stiff = sp.stiffness * sp.stiffness * 0.45 * fall * fall;
          if (stiff > 0) {
            const tx = pos[a] + (dirW[0] / dl) * seg, ty = pos[a + 1] + (dirW[1] / dl) * seg, tz = pos[a + 2] + (dirW[2] / dl) * seg;
            pos[b] += (tx - pos[b]) * stiff;
            pos[b + 1] += (ty - pos[b + 1]) * stiff;
            pos[b + 2] += (tz - pos[b + 2]) * stiff;
          }
          const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
          const d = Math.hypot(dx, dy, dz) || 1e-6;
          const f = (d - seg) / d;
          pos[b] -= dx * f;
          pos[b + 1] -= dy * f;
          pos[b + 2] -= dz * f;
          // hors du crâne
          const cx = pos[b] - headW[0], cy = pos[b + 1] - headW[1], cz = pos[b + 2] - headW[2];
          const cd = Math.hypot(cx, cy, cz);
          const rr = rad + sp.width * 0.4;
          if (cd < rr && cd > 1e-6) {
            pos[b] = headW[0] + (cx / cd) * rr;
            pos[b + 1] = headW[1] + (cy / cd) * rr;
            pos[b + 2] = headW[2] + (cz / cd) * rr;
          }
        }
      }
    }
  }

  /** Décalage d'ondulation du point `k` d'une mèche (rendu). */
  waveAt(s: number, k: number): number {
    return Math.sin(k * 1.9 + s * 2.3) * this.spec.wave * this.spec.width * 1.5;
  }
}
