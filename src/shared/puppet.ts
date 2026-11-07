/**
 * Pantin (calcul pur, sans DOM) : une personne découpée sur une photo devient des PIÈCES rigides (tête, tronc, bras,
 * avant-bras, mains, cuisses, mollets, pieds) montées sur ses vraies articulations, mesurées par un modèle de pose.
 *
 * 1. `measureBones` : os = segments entre articulations détectées (positions en pixels de l'image). Aucune proportion
 *    préréglée : un os absent (hors cadre, peu visible) n'existe pas, ses pixels vont aux os voisins.
 * 2. `assignOwners` : chaque pixel opaque de la silhouette appartient à l'os le plus proche, dans une « capsule » dont
 *    la largeur suit la taille du corps.
 * 3. `extractParts` : une image par os, en pose de repos (rien n'est retourné ni pivoté), avec un RECOUVREMENT aux
 *    jonctions : chaque pièce garde un peu des pixels du voisin autour de l'articulation, et chaque voisin un peu des
 *    siens. Quand un bras tourne, aucun trou ne s'ouvre à l'épaule.
 * 4. `PuppetRig` : cinématique directe avec les rotations ajoutées par l'animation ; un os qui tourne entraîne ses enfants.
 *
 * Conventions de `./skeleton` : angle en degrés, 0 = l'os pointe vers le bas, positif = sens horaire à l'écran ;
 * `rz` (radians) est la rotation par rapport au repos, 0 au repos : le sprite est dessiné dans la pose de repos.
 */
import { aimAngle, dir, perp, wrap180 } from "./skeleton";

export type Pt = { x: number; y: number };
export type Joint = { x: number; y: number; v?: number };
/** Sortie `joints` d'un tracker de pose : coordonnées normalisées (0..1) sur l'image analysée. */
export type Joints = Record<string, Joint | undefined>;

export type MeasuredBone = {
  name: string;
  /** Parent cinématique (`null` : racine). */
  parent: string | null;
  /** Os dont on recouvre la jonction (pièce voisine), ou `null`. */
  cap: string | null;
  /** Origine (articulation) et extrémité, en pixels de l'image. */
  start: Pt;
  end: Pt;
  /** Demi-largeur de la capsule d'appartenance des pixels (pixels). */
  radius: number;
  /** Ordre de dessin (plus grand = devant). */
  z: number;
  /** `false` : articulation sans image (racine). */
  sprite: boolean;
};

export type Measure = {
  bones: MeasuredBone[];
  /** Largeur d'épaules en pixels : l'unité de taille du corps. */
  body: number;
  /** Os (avec image) absents, pour le diagnostic. */
  missing: string[];
};

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Rayons de capsule, en largeurs d'épaules. */
const RADIUS: Record<string, number> = {
  torse: 0.56,
  tete: 0.36,
  bras: 0.17,
  "avant-bras": 0.14,
  main: 0.12,
  cuisse: 0.26,
  mollet: 0.17,
  pied: 0.14,
};

/** Ordre de dessin : jambes derrière le tronc, bras devant. */
const Z: Record<string, number> = { cuisse: 0, mollet: 0.1, pied: 0.2, torse: 1, tete: 2, bras: 3, "avant-bras": 4, main: 5 };

type Side = "gauche" | "droit";
const SIDES: Array<[Side, "left" | "right"]> = [
  ["gauche", "left"],
  ["droit", "right"],
];
/** Accord des noms : `main-droite`, `cuisse-droite` (féminins) ; `bras-droit`, `avant-bras-droit`, `mollet-droit`, `pied-droit`. */
const side = (kind: string, s: Side): string => (s === "droit" && (kind === "main" || kind === "cuisse") ? `${kind}-droite` : `${kind}-${s}`);

export type MeasureOptions = { minVisibility?: number };

/**
 * Os mesurés d'une pose. `w`, `h` : taille en pixels de l'image analysée. `null` : pose inutilisable (épaules absentes).
 * Les noms `gauche` / `droite` sont ceux de l'écran (`left*` du tracker).
 */
export function measureBones(joints: Joints, w: number, h: number, opts: MeasureOptions = {}): Measure | null {
  const minV = opts.minVisibility ?? 0.5;
  const pt = (name: string): Pt | null => {
    const j = joints[name];
    if (!j || !Number.isFinite(j.x) || !Number.isFinite(j.y)) return null;
    if ((Number.isFinite(j.v) ? (j.v as number) : 1) < minV) return null;
    if (j.x < -0.03 || j.x > 1.03 || j.y < -0.03 || j.y > 1.03) return null; // hors cadre : extrapolation du modèle
    return { x: j.x * w, y: j.y * h };
  };
  const mid = (a: Pt | null, b: Pt | null): Pt | null => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null);

  const ls = pt("leftShoulder");
  const rs = pt("rightShoulder");
  if (!ls || !rs) return null;
  const body = dist(ls, rs);
  if (body < 8) return null;
  const sh = mid(ls, rs) as Pt;

  // Bassin : milieu des hanches mesurées ; sinon point virtuel sous les épaules (photo en buste).
  const lh = pt("leftHip");
  const rh = pt("rightHip");
  let hip = mid(lh, rh);
  if (!hip) {
    let nx = -(rs.y - ls.y) / body;
    let ny = (rs.x - ls.x) / body;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    hip = { x: sh.x + nx * body * 1.35, y: sh.y + ny * body * 1.35 };
  }

  const rad = (kind: string) => Math.max(6, RADIUS[kind] * body);
  const bones: MeasuredBone[] = [];
  const missing: string[] = [];
  const add = (name: string, kind: string, parent: string | null, cap: string | null, start: Pt, end: Pt) => {
    bones.push({ name, parent, cap, start, end, radius: rad(kind), z: Z[kind], sprite: true });
  };

  bones.push({ name: "bassin", parent: null, cap: null, start: hip, end: hip, radius: 0, z: 0, sprite: false });
  add("torse", "torse", "bassin", null, hip, sh);

  // Tête : du cou vers le sommet, estimé depuis les oreilles (ou le nez).
  const ears = mid(pt("leftEar"), pt("rightEar"));
  const nose = pt("nose");
  const ref = ears ?? nose;
  if (ref && ref.y < sh.y) {
    const k = ears ? 1.8 : 1.55;
    add("tete", "tete", "torse", "torse", sh, { x: sh.x + (ref.x - sh.x) * k, y: sh.y + (ref.y - sh.y) * k });
  } else missing.push("tete");

  for (const [sd, en] of SIDES) {
    const shoulder = pt(`${en}Shoulder`);
    const elbow = pt(`${en}Elbow`);
    const wrist = pt(`${en}Wrist`);
    if (shoulder && elbow) {
      add(side("bras", sd), "bras", "torse", "torse", shoulder, elbow);
      if (wrist) {
        add(side("avant-bras", sd), "avant-bras", side("bras", sd), side("bras", sd), elbow, wrist);
        // Main : du poignet vers le milieu index / auriculaire, prolongé (le modèle donne la base des doigts).
        const knuckle = mid(pt(`${en}Index`), pt(`${en}Pinky`)) ?? pt(`${en}Index`);
        if (knuckle && dist(wrist, knuckle) > 2) {
          add(side("main", sd), "main", side("avant-bras", sd), side("avant-bras", sd), wrist, {
            x: wrist.x + (knuckle.x - wrist.x) * 1.6,
            y: wrist.y + (knuckle.y - wrist.y) * 1.6,
          });
        } else missing.push(side("main", sd));
      } else missing.push(side("avant-bras", sd), side("main", sd));
    } else missing.push(side("bras", sd), side("avant-bras", sd), side("main", sd));

    const hipJ = pt(`${en}Hip`);
    const knee = pt(`${en}Knee`);
    const ankle = pt(`${en}Ankle`);
    if (hipJ && knee) {
      add(side("cuisse", sd), "cuisse", "bassin", "torse", hipJ, knee);
      if (ankle) {
        add(side("mollet", sd), "mollet", side("cuisse", sd), side("cuisse", sd), knee, ankle);
        const toe = pt(`${en}FootIndex`);
        if (toe && dist(ankle, toe) > 2) add(side("pied", sd), "pied", side("mollet", sd), side("mollet", sd), ankle, toe);
        else missing.push(side("pied", sd));
      } else missing.push(side("mollet", sd), side("pied", sd));
    } else missing.push(side("cuisse", sd), side("mollet", sd), side("pied", sd));
  }
  return { bones, body, missing };
}

/** Rayon du recouvrement d'une jonction, autour de l'articulation de l'os enfant (pixels). */
export const capRadius = (b: MeasuredBone) => 0.55 * b.radius + 4;

/**
 * Propriétaire de chaque pixel : indice de l'os (dans `bones`) ou -1 (transparent). `rgba` : image de la personne
 * découpée (alpha = silhouette). Métrique par os : `max(distance à l'axe − rayon, dépassement au-delà des extrémités)`,
 * négative à l'intérieur de la capsule ; le plus petit gagne (un pixel hors de toute capsule va au plus proche).
 */
export function assignOwners(rgba: ArrayLike<number>, w: number, h: number, bones: MeasuredBone[], alphaMin = 24): Int16Array {
  const owners = new Int16Array(w * h).fill(-1);
  const segs = bones
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.sprite)
    .map(({ b, i }) => {
      const dx = b.end.x - b.start.x;
      const dy = b.end.y - b.start.y;
      const len = Math.hypot(dx, dy) || 1;
      return { i, sx: b.start.x, sy: b.start.y, ux: dx / len, uy: dy / len, len, r: b.radius };
    });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (rgba[p * 4 + 3] < alphaMin) continue;
      let best = -1;
      let bestM = Infinity;
      let bestQ = Infinity;
      for (const s of segs) {
        const rx = x - s.sx;
        const ry = y - s.sy;
        const t = rx * s.ux + ry * s.uy;
        const q = Math.abs(rx * s.uy - ry * s.ux);
        const excess = t < 0 ? -t : t > s.len ? t - s.len : 0;
        const m = Math.max(q - s.r, excess);
        if (m < bestM || (m === bestM && q < bestQ)) {
          bestM = m;
          bestQ = q;
          best = s.i;
        }
      }
      owners[p] = best;
    }
  }
  return owners;
}

export type Part = {
  name: string;
  z: number;
  /** Boîte de l'image dans l'image source (pixels). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** RGBA de la boîte (copie de la source ; transparent hors de la pièce). */
  data: Uint8ClampedArray;
  /** Articulation (origine de l'os) dans la boîte, en pixels de la boîte. */
  pivot: Pt;
};

/**
 * Une pièce par os avec image : pixels propres + recouvrement aux jonctions (pixels du voisin proches de l'articulation
 * de l'enfant, dans les deux sens). `null` pour un os sans pixel.
 */
export function extractParts(rgba: ArrayLike<number>, w: number, h: number, bones: MeasuredBone[], owners: Int16Array): Part[] {
  const index = new Map(bones.map((b, i) => [b.name, i]));
  // Jonctions : (enfant, voisin, centre, rayon²)
  const joints: Array<{ child: number; other: number; cx: number; cy: number; r2: number }> = [];
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    if (!b.sprite || !b.cap) continue;
    const o = index.get(b.cap);
    if (o === undefined || !bones[o].sprite) continue;
    const r = capRadius(b);
    joints.push({ child: i, other: o, cx: b.start.x, cy: b.start.y, r2: r * r });
  }
  // Membres de chaque pièce : masque par os
  const members: Array<Uint8Array | null> = bones.map((b) => (b.sprite ? new Uint8Array(w * h) : null));
  const box = bones.map(() => ({ x0: w, y0: h, x1: -1, y1: -1 }));
  const put = (i: number, x: number, y: number) => {
    (members[i] as Uint8Array)[y * w + x] = 1;
    const bb = box[i];
    if (x < bb.x0) bb.x0 = x;
    if (y < bb.y0) bb.y0 = y;
    if (x > bb.x1) bb.x1 = x;
    if (y > bb.y1) bb.y1 = y;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = owners[y * w + x];
      if (o < 0) continue;
      put(o, x, y);
      for (const j of joints) {
        const dx = x - j.cx;
        const dy = y - j.cy;
        if (dx * dx + dy * dy > j.r2) continue;
        if (o === j.other) put(j.child, x, y); // l'enfant garde un peu du parent
        else if (o === j.child) put(j.other, x, y); // le parent garde un peu de l'enfant
      }
    }
  }
  const parts: Part[] = [];
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    const m = members[i];
    const bb = box[i];
    if (!b.sprite || !m || bb.x1 < 0) continue;
    const pad = 1;
    const x0 = Math.max(0, bb.x0 - pad);
    const y0 = Math.max(0, bb.y0 - pad);
    const x1 = Math.min(w - 1, bb.x1 + pad);
    const y1 = Math.min(h - 1, bb.y1 + pad);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const data = new Uint8ClampedArray(bw * bh * 4);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!m[y * w + x]) continue;
        const s = (y * w + x) * 4;
        const d = ((y - y0) * bw + (x - x0)) * 4;
        data[d] = rgba[s];
        data[d + 1] = rgba[s + 1];
        data[d + 2] = rgba[s + 2];
        data[d + 3] = rgba[s + 3];
      }
    }
    parts.push({ name: b.name, z: b.z, x: x0, y: y0, w: bw, h: bh, data, pivot: { x: b.start.x - x0, y: b.start.y - y0 } });
  }
  return parts;
}

export type PuppetNode = { x: number; y: number; rz: number };

/** Cinématique directe d'os mesurés : positions en pixels de l'image, `rz` en radians par rapport au repos. */
export class PuppetRig {
  private order: MeasuredBone[];
  private local = new Map<string, { along: number; off: number; rel: number }>();
  private bind = new Map<string, number>();

  constructor(bones: MeasuredBone[]) {
    // `measureBones` range les parents avant leurs enfants
    this.order = bones;
    const byName = new Map(bones.map((b) => [b.name, b]));
    const angleOf = (b: MeasuredBone) => aimAngle(b.end.x - b.start.x, b.end.y - b.start.y) ?? 0;
    for (const b of bones) {
      const world = b.parent === null ? 0 : angleOf(b);
      this.bind.set(b.name, world);
      const p = b.parent ? byName.get(b.parent) : null;
      if (!p) {
        this.local.set(b.name, { along: 0, off: 0, rel: world });
        continue;
      }
      const pw = this.bind.get(p.name) as number;
      const vx = b.start.x - p.start.x;
      const vy = b.start.y - p.start.y;
      const d = dir(pw);
      const q = perp(pw);
      this.local.set(b.name, { along: vx * d.x + vy * d.y, off: vx * q.x + vy * q.y, rel: wrap180(world - pw) });
    }
  }

  /**
   * Pose pour des rotations ajoutées par os (`rz` en radians, absent = 0) et un décalage de la racine (pixels).
   * Retourne un nœud par os (articulation et rotation par rapport au repos).
   */
  solve(add: Record<string, number | undefined> = {}, shift: Pt = { x: 0, y: 0 }): Record<string, PuppetNode> {
    const out: Record<string, PuppetNode> = {};
    const state = new Map<string, { x: number; y: number; angle: number }>();
    for (const b of this.order) {
      const l = this.local.get(b.name) as { along: number; off: number; rel: number };
      const delta = ((Number.isFinite(add[b.name]) ? (add[b.name] as number) : 0) * 180) / Math.PI;
      const parent = b.parent ? state.get(b.parent) : null;
      let x: number;
      let y: number;
      let angle: number;
      if (!parent) {
        x = b.start.x + shift.x;
        y = b.start.y + shift.y;
        angle = l.rel + delta;
      } else {
        const d = dir(parent.angle);
        const q = perp(parent.angle);
        x = parent.x + d.x * l.along + q.x * l.off;
        y = parent.y + d.y * l.along + q.y * l.off;
        angle = parent.angle + l.rel + delta;
      }
      state.set(b.name, { x, y, angle });
      out[b.name] = { x, y, rz: (wrap180(angle - (this.bind.get(b.name) as number)) * Math.PI) / 180 };
    }
    return out;
  }
}
