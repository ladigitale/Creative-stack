/**
 * Boîte à outils des dessinateurs : émetteur de formes (ordre, plan, profondeur), repères d'objet (local → monde →
 * dessin), faces planes affines, boîtes, cylindres, corps de révolution, ombres portées au sol, tons d'éclairage.
 */
import type { V3 } from "../../core/math";
import type { Project } from "./types";
import { type Affine, type P2, type Paint, Pen, type Shape, type ShapeKind, hull } from "../shape";

/** Lumière du mode vectoriel : venue du haut à gauche, un peu de face (ombres portées vers la droite). */
export function lightDir(elevationDeg = 48): V3 {
  const el = (Math.max(8, Math.min(85, elevationDeg)) * Math.PI) / 180;
  const v: V3 = [-Math.cos(el) * 0.85, Math.sin(el), Math.cos(el) * 0.42];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Ton d'une face selon sa normale monde (−1 ombre, 0 base, 1 lumière). */
export function faceTone(n: V3, L: V3): number {
  const d = n[0] * L[0] + n[1] * L[1] + n[2] * L[2];
  return d > 0.66 ? 1 : d > 0.18 ? 0 : -1;
}

export type AddOpts = { tone?: number; stroke?: Paint | null; width?: number; kind?: ShapeKind; alpha?: number; dz?: number; layer?: number; depth?: number };

/** Émetteur de formes d'un objet (ou d'un groupe de décor). */
export class Emitter {
  private n = 0;
  constructor(
    readonly out: Shape[],
    public z0: number,
    public layer: number,
    public objId: number,
    public depth: number,
    /** Contour par défaut (`ink`, `darker` résolu au rendu, ou null). */
    public stroke: Paint | null = "ink",
    public pal?: Record<string, string>,
  ) {}
  add(d: string | Pen, fill: Paint, o: AddOpts = {}): Shape | null {
    const ds = typeof d === "string" ? d : d.d;
    if (!ds) return null;
    const s: Shape = { d: ds, fill, z: this.z0 + (o.dz ?? 0) + this.n++ * 1e-7, layer: o.layer ?? this.layer, objId: this.objId, depth: o.depth ?? this.depth };
    const st = o.stroke === undefined ? this.stroke : o.stroke;
    if (st && st !== "none") {
      s.stroke = st;
      s.width = o.width ?? 1;
    }
    if (o.tone) s.tone = o.tone;
    if (o.kind && o.kind !== "fill") s.kind = o.kind;
    if (o.alpha !== undefined && o.alpha < 1) s.alpha = o.alpha;
    if (this.pal) s.pal = this.pal;
    this.out.push(s);
    return s;
  }
  /** Trait fin (détail intérieur : joints, barreaux, lattes) dessiné en `stroke` sans remplissage. */
  line(d: string | Pen, paint: Paint, width = 0.5, o: AddOpts = {}) {
    return this.add(d, "none", { ...o, stroke: paint, width, kind: "line" });
  }
}

/** Repère d'un objet : position, cap (rad), échelle ; local → monde. */
export class Frame {
  readonly c: number;
  readonly s: number;
  constructor(readonly pos: V3, readonly yaw: number, readonly scale: number) {
    this.c = Math.cos(yaw);
    this.s = Math.sin(yaw);
  }
  /** Point local → monde (même convention que `m4Compose(pos, qAxis(y, yaw), scale)`). */
  w(x: number, y: number, z: number): V3 {
    const k = this.scale;
    return [this.pos[0] + (x * this.c + z * this.s) * k, this.pos[1] + y * k, this.pos[2] + (-x * this.s + z * this.c) * k];
  }
  /** Direction locale → monde (sans échelle). */
  dir(x: number, y: number, z: number): V3 {
    return [x * this.c + z * this.s, y, -x * this.s + z * this.c];
  }
}

/** Outils de dessin liés à une projection et à un repère. */
export class Kit {
  constructor(readonly pr: Project, readonly fr: Frame, readonly em: Emitter, readonly L: V3) {}

  /** Sous-outil dont l'origine est le point local (x, y, z). */
  sub(x: number, y: number, z: number): Kit {
    return new Kit(this.pr, new Frame(this.fr.w(x, y, z), this.fr.yaw, this.fr.scale), this.em, this.L);
  }
  P(x: number, y: number, z: number): P2 {
    return this.pr.pv(this.fr.w(x, y, z));
  }
  /** Affine d'une face locale : origine, axe u, axe v (repère local de l'objet, échelle comprise). */
  face(o: V3, u: V3, v: V3): Affine {
    const k = this.fr.scale;
    const ud = this.fr.dir(u[0], u[1], u[2]), vd = this.fr.dir(v[0], v[1], v[2]);
    return this.pr.face(this.fr.w(o[0], o[1], o[2]), [ud[0] * k, ud[1] * k, ud[2] * k], [vd[0] * k, vd[1] * k, vd[2] * k]);
  }
  /** Normale locale → visibilité et ton. */
  vis(n: V3): number {
    return this.pr.facing(this.fr.dir(n[0], n[1], n[2]));
  }
  tone(n: V3): number {
    return faceTone(this.fr.dir(n[0], n[1], n[2]), this.L);
  }
  /** Affine « affiche » face à l'observateur, centrée sur un point local (dessins symétriques, végétation). */
  board(x = 0, y = 0, z = 0, mirror = false): Affine {
    const [u, v] = this.P(x, y, z);
    const k = this.fr.scale;
    return [mirror ? -k : k, 0, 0, k, u, v];
  }
  /**
   * Affine d'élévation pour un objet allongé : u le long de l'axe local le plus visible (x ou z), raccourci par le cap
   * mais jamais sous 40 % (lisibilité), v vers le haut. Renvoie aussi l'axe choisi.
   */
  elev(x = 0, y = 0, z = 0): { m: Affine; along: "x" | "z"; k: number } {
    const ax = this.pr.vec(this.fr.dir(1, 0, 0)), az = this.pr.vec(this.fr.dir(0, 0, 1));
    const along = Math.abs(ax[0]) >= Math.abs(az[0]) * 0.8 ? "x" : "z";
    const a = along === "x" ? ax : az;
    let ku = a[0];
    if (Math.abs(ku) < 0.4) ku = 0.4 * (ku < 0 ? -1 : 1);
    const [u, v] = this.P(x, y, z);
    const k = this.fr.scale;
    return { m: [ku * k, a[1] * k * 0.3, 0, k, u, v], along, k: Math.abs(a[0]) };
  }

  /** Boîte locale [x0,x1]×[y0,y1]×[z0,z1] : faces visibles en aplat avec ton d'éclairage. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, fill: Paint, o: { stroke?: Paint | null; tone?: number; width?: number; topFill?: Paint } = {}) {
    const faces: [V3, V3[]][] = [
      [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
      [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
      [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
      [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
      [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    ];
    for (const [n, q] of faces) {
      if (this.vis(n) <= 1e-3) continue;
      const pen = new Pen().poly(q.map((p) => this.P(p[0], p[1], p[2])));
      this.em.add(pen, n[1] > 0 && o.topFill ? o.topFill : fill, { tone: (o.tone ?? 0) + this.tone(n), stroke: o.stroke, width: o.width });
    }
  }

  /** Points projetés d'un cercle horizontal local (rayon r, hauteur y). */
  ring(cx: number, y: number, cz: number, r: number, n = 20): P2[] {
    const out: P2[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(this.P(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r));
    }
    return out;
  }

  /**
   * Corps de révolution vertical (profil [rayon, hauteur]) : silhouette lisse, bande d'ombre côté opposé à la
   * lumière, reflet, couvercle elliptique si le dessus est visible. Sert aux tonneaux, bornes, poteaux, vases.
   */
  lathe(profile: [number, number][], fill: Paint, o: { cx?: number; cz?: number; stroke?: Paint | null; top?: boolean; shade?: boolean; width?: number; tone?: number } = {}) {
    const cx = o.cx ?? 0, cz = o.cz ?? 0;
    const [bu, bv] = this.P(cx, 0, cz);
    const k = this.fr.scale;
    const stretch = Math.hypot(1, this.pr.ax);
    const ry = this.pr.ay * k;
    const L = this.L;
    const side = L[0] <= 0 ? 1 : -1; // côté ombré à l'écran (+u si lumière à gauche)
    const right = profile.map(([r, y]): P2 => [bu + r * k * stretch, bv + y * k]);
    const left = profile.map(([r, y]): P2 => [bu - r * k * stretch, bv + y * k]).reverse();
    // bas arrondi (ellipse avant) et haut (ellipse arrière)
    const pen = new Pen();
    const r0 = profile[0][0] * k * stretch;
    pen.M(left[left.length - 1][0], left[left.length - 1][1]);
    if (ry > 1e-3 && r0 > 0) pen.C(bu - r0, bv - ry * profile[0][0] * 1.33, bu + r0, bv - ry * profile[0][0] * 1.33, right[0][0], right[0][1]);
    else pen.L(right[0][0], right[0][1]);
    pen.smooth(right, false, false);
    pen.L(left[0][0], left[0][1]);
    pen.smooth(left, false, false);
    pen.Z();
    this.em.add(pen, fill, { stroke: o.stroke, width: o.width, tone: o.tone });
    if (o.shade !== false) {
      // bande d'ombre (≈ 35 % du côté sombre) et filet de lumière côté clair
      const sh = new Pen();
      const outer = profile.map(([r, y]): P2 => [bu + side * r * k * stretch, bv + y * k]);
      const inner = profile.map(([r, y]): P2 => [bu + side * r * k * stretch * 0.38, bv + y * k]).reverse();
      sh.smooth(outer, false, true).L(inner[0][0], inner[0][1]);
      sh.smooth(inner, false, false).Z();
      this.em.add(sh, fill, { tone: (o.tone ?? 0) - 1, stroke: null });
      const hl = new Pen();
      const a = profile.map(([r, y]): P2 => [bu - side * r * k * stretch * 0.62, bv + y * k]);
      const b = profile.map(([r, y]): P2 => [bu - side * r * k * stretch * 0.48, bv + y * k]).reverse();
      hl.smooth(a.slice(1, -1), false, true).L(b[1][0], b[1][1]);
      hl.smooth(b.slice(1, -1), false, false).Z();
      if (a.length > 3) this.em.add(hl, fill, { tone: (o.tone ?? 0) + 1, stroke: null, alpha: 0.8 });
    }
    const last = profile[profile.length - 1];
    if (o.top !== false && ry > 1e-3 && last[0] > 0.01) {
      const t = new Pen().ellipse(bu, bv + last[1] * k, last[0] * k * stretch, ry * last[0] * 1.0);
      this.em.add(t, fill, { tone: (o.tone ?? 0) + 1, stroke: o.stroke, width: (o.width ?? 1) * 0.6 });
    }
  }

  /** Ombre portée au sol d'un volume (emprise locale extrudée sur `h`, projetée selon la lumière). */
  castShadow(out: Shape[], hx: number, hz: number, h: number, ground: (x: number, z: number) => number, zKey: number, layer: number, depth: number, round = false) {
    const L = this.L;
    const kx = (-L[0] / L[1]) * h, kz = (-L[2] / L[1]) * h;
    const base: V3[] = [];
    if (round) for (let i = 0; i < 12; i++) base.push(this.fr.w(Math.cos((i / 12) * Math.PI * 2) * hx, 0, Math.sin((i / 12) * Math.PI * 2) * hz));
    else base.push(this.fr.w(-hx, 0, -hz), this.fr.w(hx, 0, -hz), this.fr.w(hx, 0, hz), this.fr.w(-hx, 0, hz));
    const pts: P2[] = [];
    const sc = this.fr.scale;
    for (const b of base) {
      const y = ground(b[0], b[2]) + 0.02;
      pts.push(this.pr.p(b[0], y, b[2]));
      const sx = b[0] + kx * sc, sz = b[2] + kz * sc;
      pts.push(this.pr.p(sx, ground(sx, sz) + 0.02, sz));
    }
    const hl = hull(pts);
    if (hl.length < 3) return;
    const pen = new Pen();
    if (round) pen.smooth(hl, true);
    else pen.poly(hl);
    out.push({ d: pen.d, fill: "shadow", kind: "shadow", z: zKey, layer, objId: 0, depth });
  }
}

export { hull, Pen };
export type { Affine, P2, Paint, Shape };
