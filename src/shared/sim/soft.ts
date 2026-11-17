/**
 * Pièces souples (capes, jupes, écharpes, drapeaux, queues, oreilles, cordes, mèches) : points à ressorts intégrés
 * en verlet, attachés à la pièce qui les porte, soumis à la gravité et au vent, repoussés par des sphères (le corps).
 * Pur calcul (aucun rendu), commun aux rendus ; la pose d'attache est une matrice monde 4×4 (colonnes).
 */

export type V3 = [number, number, number];

export type SoftSpec = {
  /** `tissu` : nappe ; `jupe` : tube ouvert (jupe, robe, manche, manche à air) ; `chaine` : ligne. */
  kind: "tissu" | "jupe" | "chaine";
  /** Bord (tissu) ou bout (chaîne) attaché : haut, bas, gauche, droite, avant, arriere. */
  pin: "haut" | "bas" | "gauche" | "droite" | "avant" | "arriere";
  /** 0 : très souple (soie), 1 : raide (cuir épais). */
  stiffness: number;
  /** Échelle de la gravité (poids du tissu). */
  weight: number;
  /** Amorti (0 à 1). */
  damping: number;
  /** Prise au vent (0 à 3). */
  wind: number;
  /** Repoussé par les autres pièces du modèle. */
  collide: boolean;
  /** Finesse (segments sur la longueur). */
  segments: number;
};

const PINS = ["haut", "bas", "gauche", "droite", "avant", "arriere"] as const;
const ALIAS: Record<string, SoftSpec["pin"]> = { top: "haut", bottom: "bas", left: "gauche", right: "droite", front: "avant", back: "arriere", "arrière": "arriere" };

export function readSoft(v: unknown, issue: (m: string) => void): SoftSpec | null {
  if (v === undefined || v === null || v === false) return null;
  const o: Record<string, unknown> = v === true ? {} : typeof v === "string" ? { type: v } : v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const t = String(o.type ?? "tissu").toLowerCase();
  const kind = t === "jupe" || t === "skirt" || t === "robe" || t === "tube" || t === "manche" ? "jupe" : t === "tissu" || t === "cloth" || t === "cape" || t === "drapeau" ? "tissu" : t === "chaine" || t === "chaîne" || t === "chain" || t === "corde" || t === "queue" || t === "meche" || t === "mèche" ? "chaine" : null;
  if (!kind) {
    issue(`souple : type « ${t} » inconnu (tissu, jupe, chaine)`);
    return null;
  }
  const p = String(o.attache ?? o.pin ?? "haut").toLowerCase();
  const pin = (PINS as readonly string[]).includes(p) ? (p as SoftSpec["pin"]) : ALIAS[p];
  if (!pin) issue(`souple : attache « ${p} » inconnue (${PINS.join(", ")})`);
  const n = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d);
  return {
    kind,
    pin: pin ?? "haut",
    stiffness: n(o.rigidite ?? o.stiffness, 0.5, 0, 1),
    weight: n(o.poids ?? o.weight, 1, 0, 5),
    damping: n(o.amorti ?? o.damping, 0.08, 0, 1),
    wind: n(o.vent ?? o.wind, 1, 0, 3),
    collide: o.collision !== false && o.collide !== false,
    segments: Math.round(n(o.segments, kind === "chaine" ? 10 : 8, 2, 24)),
  };
}

/** Repère local de la pièce souple : boîte [-hx, hx] × [-hy, hy] × [-hz, hz] autour de `c`. */
export type SoftBox = { c: V3; h: V3 };

const AX: Record<SoftSpec["pin"], [number, number]> = { haut: [1, 1], bas: [1, -1], droite: [0, 1], gauche: [0, -1], avant: [2, 1], arriere: [2, -1] };

export class SoftSim {
  readonly n: number;
  readonly pos: Float32Array;
  private prev: Float32Array;
  /** Position de repos de chaque point dans le repère de la pièce. */
  readonly rest: Float32Array;
  readonly pinned: Uint8Array;
  private cons: Int32Array;
  private len: Float32Array;
  private kw: Float32Array;
  private iters: number;
  /** Grille (tissu) : colonnes × rangées ; chaîne : 1 × points. */
  readonly cols: number;
  readonly rows: number;
  /** Rayon du tube (chaîne). */
  readonly radius: number;
  private started = false;
  private acc = 0;
  private t = 0;

  constructor(readonly spec: SoftSpec, box: SoftBox) {
    const [axis, sign] = AX[spec.pin];
    const pts: number[] = [];
    const pinned: number[] = [];
    const cons: number[] = [];
    /** Raideur de chaque contrainte : trame 1, cisaillement et pliure plus souples (le tissu drape). */
    const kw: number[] = [];
    const shear = 0.08 + 0.5 * spec.stiffness, bendK = 0.05 + 0.6 * spec.stiffness;
    if (spec.kind === "jupe") {
      // tube : anneaux autour de l'axe d'attache (y pour « haut »), fermés ; rayons = demi-côtés de la pièce
      const others = [0, 1, 2].filter((a) => a !== axis);
      const rows = spec.segments + 1;
      const cols = Math.max(8, Math.min(24, spec.segments * 2));
      this.cols = cols;
      this.rows = rows;
      this.radius = 0;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const a = (c / cols) * Math.PI * 2;
          const p: V3 = [box.c[0], box.c[1], box.c[2]];
          p[axis] = box.c[axis] + sign * box.h[axis] * (1 - (2 * r) / (rows - 1));
          p[others[0]] = box.c[others[0]] + Math.cos(a) * box.h[others[0]];
          p[others[1]] = box.c[others[1]] + Math.sin(a) * box.h[others[1]];
          pts.push(...p);
          pinned.push(r === 0 ? 1 : 0);
        }
      const id = (r: number, c: number) => r * cols + (((c % cols) + cols) % cols);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          cons.push(id(r, c), id(r, c + 1)), kw.push(1);
          if (r + 1 < rows) cons.push(id(r, c), id(r + 1, c)), kw.push(1);
          if (r + 1 < rows) cons.push(id(r, c), id(r + 1, c + 1), id(r, c + 1), id(r + 1, c)), kw.push(shear, shear);
          if (r + 2 < rows) cons.push(id(r, c), id(r + 2, c)), kw.push(bendK);
          // le tube garde sa rondeur : liaison au point opposé, souple
          if (c < cols / 2) cons.push(id(r, c), id(r, c + cols / 2)), kw.push(0.05 + 0.2 * spec.stiffness);
        }
    } else if (spec.kind === "tissu") {
      // la grille couvre les deux grandes dimensions ; la longueur (vers le bas du bord attaché) est l'axe `axis`
      const others = [0, 1, 2].filter((a) => a !== axis);
      const across = box.h[others[0]] >= box.h[others[1]] ? others[0] : others[1];
      const rows = spec.segments + 1;
      const cols = Math.max(2, Math.min(16, Math.round((spec.segments * box.h[across]) / Math.max(1e-3, box.h[axis])) + 1));
      this.cols = cols;
      this.rows = rows;
      this.radius = 0;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const p: V3 = [box.c[0], box.c[1], box.c[2]];
          p[axis] = box.c[axis] + sign * box.h[axis] * (1 - (2 * r) / (rows - 1));
          p[across] = box.c[across] - box.h[across] + (2 * box.h[across] * c) / (cols - 1);
          pts.push(...p);
          pinned.push(r === 0 ? 1 : 0);
        }
      const id = (r: number, c: number) => r * cols + c;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          if (c + 1 < cols) cons.push(id(r, c), id(r, c + 1)), kw.push(1);
          if (r + 1 < rows) cons.push(id(r, c), id(r + 1, c)), kw.push(1);
          if (r + 1 < rows && c + 1 < cols) cons.push(id(r, c), id(r + 1, c + 1), id(r, c + 1), id(r + 1, c)), kw.push(shear, shear);
          // pliure : sauts de deux points (raideur du tissu)
          if (r + 2 < rows) cons.push(id(r, c), id(r + 2, c)), kw.push(bendK);
          if (c + 2 < cols) cons.push(id(r, c), id(r, c + 2)), kw.push(bendK);
        }
    } else {
      // chaîne le long de la plus grande dimension, attachée au bout désigné (ou au bout haut de cet axe)
      const long = box.h[0] >= box.h[1] && box.h[0] >= box.h[2] ? 0 : box.h[1] >= box.h[2] ? 1 : 2;
      const ax = axis === long ? axis : long;
      const sg = axis === long ? sign : 1;
      const count = spec.segments + 1;
      this.cols = 1;
      this.rows = count;
      const rest = [0, 1, 2].filter((a) => a !== ax);
      this.radius = Math.max(0.004, (box.h[rest[0]] + box.h[rest[1]]) / 2);
      for (let i = 0; i < count; i++) {
        const p: V3 = [box.c[0], box.c[1], box.c[2]];
        p[ax] = box.c[ax] + sg * box.h[ax] * (1 - (2 * i) / (count - 1));
        pts.push(...p);
        pinned.push(i === 0 ? 1 : 0);
        if (i + 1 < count) cons.push(i, i + 1), kw.push(1);
        if (i + 2 < count) cons.push(i, i + 2), kw.push(bendK);
      }
    }
    this.n = pts.length / 3;
    this.rest = new Float32Array(pts);
    this.pos = new Float32Array(pts.length);
    this.prev = new Float32Array(pts.length);
    this.pinned = new Uint8Array(pinned);
    this.cons = new Int32Array(cons);
    this.len = new Float32Array(cons.length / 2);
    this.kw = new Float32Array(kw);
    for (let k = 0; k < this.len.length; k++) {
      const a = cons[k * 2] * 3, b = cons[k * 2 + 1] * 3;
      this.len[k] = Math.hypot(pts[a] - pts[b], pts[a + 1] - pts[b + 1], pts[a + 2] - pts[b + 2]);
    }
    this.iters = 2 + Math.round(spec.stiffness * 10);
  }

  private place(m: ArrayLike<number>, i: number, out: Float32Array, o: number) {
    const x = this.rest[i * 3], y = this.rest[i * 3 + 1], z = this.rest[i * 3 + 2];
    out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }

  /** Remet tous les points à leur place de repos (téléportation, premier affichage). */
  reset(m: ArrayLike<number>) {
    for (let i = 0; i < this.n; i++) {
      this.place(m, i, this.pos, i * 3);
      this.place(m, i, this.prev, i * 3);
    }
    this.started = true;
  }

  /**
   * Avance de `dt` s (pas fixes de 1/60 s, 3 au plus) : `m` = matrice monde de la pièce (attaches), `wind` (m/s),
   * `spheres` = [cx, cy, cz, r]… dans le repère du monde. Rend vrai si un point a bougé.
   */
  step(dt: number, m: ArrayLike<number>, gravity: V3, wind: V3, spheres: Float32Array | null): boolean {
    if (!this.started) {
      this.reset(m);
      return true;
    }
    // un saut (téléportation) : on repart du repos plutôt que d'étirer le tissu sur des mètres
    const p0 = this.pos;
    const tmp = new Float32Array(3);
    this.place(m, 0, tmp, 0);
    if (Math.hypot(tmp[0] - p0[0], tmp[1] - p0[1], tmp[2] - p0[2]) > 3) {
      this.reset(m);
      return true;
    }
    const h = 1 / 60;
    this.acc = Math.min(this.acc + dt, h * 3);
    let moved = false;
    while (this.acc >= h) {
      this.acc -= h;
      this.t += h;
      moved = this.tick(h, m, gravity, wind, spheres) || moved;
    }
    return moved;
  }

  private tick(h: number, m: ArrayLike<number>, gravity: V3, wind: V3, spheres: Float32Array | null): boolean {
    const s = this.spec, pos = this.pos, prev = this.prev;
    const keep = 1 - s.damping * 0.5;
    // rafales : le vent fluctue dans le temps et d'un point à l'autre
    const gust = 0.6 + 0.4 * Math.sin(this.t * 1.7) * Math.sin(this.t * 0.43 + 1.3);
    const ax = gravity[0] * s.weight, ay = gravity[1] * s.weight, az = gravity[2] * s.weight;
    let moved = false;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      if (this.pinned[i]) {
        this.place(m, i, prev, k);
        this.place(m, i, pos, k);
        continue;
      }
      const flutter = 0.6 + 0.4 * Math.sin(this.t * 6.1 + i * 0.9);
      const wk = s.wind * gust * flutter * 2.4;
      // turbulence : poussée de travers qui fait onduler (drapeau, cape)
      const tb = s.wind * Math.sin(this.t * 7.3 + i * 1.31 + (i % this.cols) * 0.7) * 1.4;
      const x = pos[k], y = pos[k + 1], z = pos[k + 2];
      const vx = (x - prev[k]) * keep, vy = (y - prev[k + 1]) * keep, vz = (z - prev[k + 2]) * keep;
      prev[k] = x;
      prev[k + 1] = y;
      prev[k + 2] = z;
      pos[k] = x + vx + (ax + wind[0] * wk - wind[2] * tb) * h * h;
      pos[k + 1] = y + vy + (ay + wind[1] * wk + Math.hypot(wind[0], wind[2]) * tb * 0.3) * h * h;
      pos[k + 2] = z + vz + (az + wind[2] * wk + wind[0] * tb) * h * h;
    }
    const cons = this.cons, len = this.len;
    for (let it = 0; it < this.iters; it++) {
      for (let c = 0; c < len.length; c++) {
        const a = cons[c * 2], b = cons[c * 2 + 1];
        const ka = a * 3, kb = b * 3;
        const dx = pos[kb] - pos[ka], dy = pos[kb + 1] - pos[ka + 1], dz = pos[kb + 2] - pos[ka + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        // pliure et cisaillement : ne résistent qu'à l'écrasement partiel (un tissu se plie, ne s'étire pas)
        const diff = ((d - len[c]) / d) * this.kw[c];
        const wa = this.pinned[a] ? 0 : 1, wb = this.pinned[b] ? 0 : 1;
        const w = wa + wb;
        if (!w) continue;
        const f = diff / w;
        pos[ka] += dx * f * wa;
        pos[ka + 1] += dy * f * wa;
        pos[ka + 2] += dz * f * wa;
        pos[kb] -= dx * f * wb;
        pos[kb + 1] -= dy * f * wb;
        pos[kb + 2] -= dz * f * wb;
      }
      if (spheres && this.spec.collide)
        for (let i = 0; i < this.n; i++) {
          if (this.pinned[i]) continue;
          const k = i * 3;
          for (let q = 0; q < spheres.length; q += 4) {
            const dx = pos[k] - spheres[q], dy = pos[k + 1] - spheres[q + 1], dz = pos[k + 2] - spheres[q + 2];
            const r = spheres[q + 3] + this.radius + 0.01;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < r * r && d2 > 1e-10) {
              const d = Math.sqrt(d2), f = r / d;
              pos[k] = spheres[q] + dx * f;
              pos[k + 1] = spheres[q + 1] + dy * f;
              pos[k + 2] = spheres[q + 2] + dz * f;
            }
          }
        }
    }
    // jamais sous le sol
    for (let i = 1; i < pos.length; i += 3) if (pos[i] < 0.005) pos[i] = 0.005;
    // a bougé : déplacement de ce pas (gravité, vent, attache qui avance)
    for (let i = 0; i < pos.length && !moved; i++) if (Math.abs(pos[i] - prev[i]) > 1e-6) moved = true;
    return moved;
  }
}
