/**
 * Collisions entre objets posés d'un « monde » : chaque pièce dessinée d'un modèle est une boîte orientée, et deux
 * objets se touchent vraiment quand deux de leurs boîtes se pénètrent (théorème des axes séparateurs, en 3D).
 *
 * C'est plus fin qu'une emprise au sol : une chaise glissée sous une table ne la touche pas, un livre posé sur une
 * tablette trop basse touche le plateau du dessus, un meuble qui traverse un mur est vu. Un simple contact (objet posé
 * sur son appui, dos contre un mur) n'est pas une collision : il faut une pénétration de plus de `EPS`.
 *
 * Sert à la lecture (liste `conflicts` du monde) ; tout est mesuré une fois par modèle et mis en cache.
 */
import type { Conflict, Model, Placement } from "./format";
import { geometryOf } from "./geometry";
import { m4, m4Compose, type M4, type V3 } from "./math";
import { forward, STRIDE } from "./pose";
import { genMeasure, inPolygon } from "./supports";

/** Boîte orientée : centre, trois axes unitaires, demi-dimensions le long de chacun. */
export type Obb = { c: V3; ax: [V3, V3, V3]; h: V3 };

/** Pénétration en dessous de laquelle deux boîtes sont seulement en contact (mètres). */
export const EPS = 0.012;
/** Tolérance d'un objet souple (mètres) : un feuillage frôle un mur, un coussin s'enfonce dans un autre. */
export const SOFT = 0.1;
const MAX_BOXES = 40;

const cache = new WeakMap<Model, Obb[]>();

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Applique la partie linéaire (et la translation si `point`) d'une matrice colonne. */
function apply(m: M4, v: readonly number[], point: boolean): V3 {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + (point ? m[12] : 0), m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + (point ? m[13] : 0), m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + (point ? m[14] : 0)];
}

/** Boîte transformée par une matrice : les axes suivent la rotation, les demi-dimensions l'échelle. */
function transform(b: Obb, m: M4): Obb {
  const ax = [0, 1, 2].map((i) => apply(m, [b.ax[i][0] * b.h[i], b.ax[i][1] * b.h[i], b.ax[i][2] * b.h[i]], false));
  const h = ax.map((e) => Math.hypot(e[0], e[1], e[2])) as V3;
  // un axe aplati (plan, demi-dimension nulle) garde une direction : celle de l'axe d'origine tourné
  const unit = ax.map((e, i) => (h[i] > 1e-9 ? ([e[0] / h[i], e[1] / h[i], e[2] / h[i]] as V3) : normalize(apply(m, b.ax[i], false)))) as [V3, V3, V3];
  return { c: apply(m, b.c, true), ax: unit, h };
}
function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Boîtes d'un modèle au repos, dans son repère : une par pièce dessinée (une seule, englobante, au-delà de 40 pièces). */
export function boxesOf(model: Model): Obb[] {
  // forme de collision écrite : elle remplace celle des pièces
  if (model.collider === "none") return [];
  if (model.collider) return model.collider;
  // modèle procgen : tranches mesurées par le rendu une fois le maillage généré (aucune avant)
  if (model.gen)
    return (genMeasure(model)?.slabs ?? []).map((s) => ({ c: [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2], ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [(s.max[0] - s.min[0]) / 2, (s.max[1] - s.min[1]) / 2, (s.max[2] - s.min[2]) / 2] }) as Obb);
  const hit = cache.get(model);
  if (hit) return hit;
  const n = model.parts.length;
  const offs = new Float32Array(n * STRIDE);
  for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
  const world = new Float32Array(n * 16);
  forward(model, offs, m4(), world, m4());
  let out: Obb[] = [];
  for (let i = 0; i < n; i++) {
    const p = model.parts[i];
    const g = p.hidden ? null : geometryOf(p, 0);
    if (!g) continue;
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < g.pos.length; k += 3)
      for (let a = 0; a < 3; a++) {
        const v = g.pos[k + a];
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
      }
    const local: Obb = { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
    out.push(transform(local, world.subarray(i * 16, i * 16 + 16)));
  }
  if (out.length > MAX_BOXES) {
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of out) {
      const e = extent(b);
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], b.c[a] - e[a]);
        hi[a] = Math.max(hi[a], b.c[a] + e[a]);
      }
    }
    out = [{ c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] }];
  }
  cache.set(model, out);
  return out;
}

/** Demi-dimensions de la boîte alignée sur les axes du monde qui contient `b`. */
export function extent(b: Obb): V3 {
  return [0, 1, 2].map((a) => Math.abs(b.ax[0][a]) * b.h[0] + Math.abs(b.ax[1][a]) * b.h[1] + Math.abs(b.ax[2][a]) * b.h[2]) as V3;
}

/**
 * Pénétration de deux boîtes orientées (mètres) : 0 si un axe les sépare, sinon la plus petite profondeur de
 * recouvrement sur les 15 axes candidats (3 + 3 faces, 9 arêtes croisées).
 */
export function penetration(a: Obb, b: Obb): number {
  const t: V3 = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
  let min = Infinity;
  const test = (l: readonly number[]): boolean => {
    const len = Math.hypot(l[0], l[1], l[2]);
    if (len < 1e-8) return true; // arêtes parallèles : axe déjà couvert par les faces
    const ra = (Math.abs(dot(a.ax[0], l)) * a.h[0] + Math.abs(dot(a.ax[1], l)) * a.h[1] + Math.abs(dot(a.ax[2], l)) * a.h[2]) / len;
    const rb = (Math.abs(dot(b.ax[0], l)) * b.h[0] + Math.abs(dot(b.ax[1], l)) * b.h[1] + Math.abs(dot(b.ax[2], l)) * b.h[2]) / len;
    const d = ra + rb - Math.abs(dot(t, l)) / len;
    if (d <= 0) return false;
    if (d < min) min = d;
    return true;
  };
  for (let i = 0; i < 3; i++) if (!test(a.ax[i])) return 0;
  for (let i = 0; i < 3; i++) if (!test(b.ax[i])) return 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(cross(a.ax[i], b.ax[j]))) return 0;
  return min === Infinity ? 0 : min;
}

type Item = { who: string; base: string; pl: Placement; boxes: Obb[]; lo: V3; hi: V3; kind: "objet" | "mur" | "ouverture"; soft: boolean };

const mat = m4();
function placed(pl: Placement, model: Model): Obb[] {
  return placeBoxes(model, pl.at, pl.rot, pl.scale);
}

/** Boîtes d'un modèle posé (position, rotation en radians, échelle), dans le repère du monde. */
export function placeBoxes(model: Model, at: readonly number[], rot: readonly number[], scale: readonly number[]): Obb[] {
  m4Compose(mat, at[0], at[1], at[2], rot[0], rot[1], rot[2], scale[0], scale[1], scale[2]);
  return boxesOf(model).map((b) => transform(b, mat));
}

/** Boîte alignée sur le monde qui contient des boîtes orientées. */
export function hull(boxes: Obb[]): { lo: V3; hi: V3 } {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    const e = extent(b);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], b.c[a] - e[a]);
      hi[a] = Math.max(hi[a], b.c[a] + e[a]);
    }
  }
  return { lo, hi };
}

/**
 * Dégagement d'une menuiserie posée : le passage d'une porte (aussi profond que large, 1 m au plus) ou les 15 cm
 * devant une fenêtre, à sa hauteur.
 */
export function clearanceBox(model: Model, at: readonly number[], rot: readonly number[], scale: readonly number[]): Obb | null {
  const bs = boxesOf(model);
  if (!bs.length) return null;
  const { lo, hi } = hull(bs);
  const w = hi[0] - lo[0], hgt = hi[1] - lo[1];
  const depth = at[1] < 0.05 ? Math.min(1, w) : 0.15;
  const local: Obb = { c: [(lo[0] + hi[0]) / 2, lo[1] + hgt / 2, hi[2] + depth / 2 + 0.02], ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [w / 2 - 0.03, hgt / 2 - 0.03, depth / 2] };
  m4Compose(mat, at[0], at[1], at[2], rot[0], rot[1], rot[2], scale[0], scale[1], scale[2]);
  return transform(local, mat);
}

export type CollideOptions = {
  /** Contour de l'espace (mètres) : un objet qui en sort est signalé. */
  contour?: number[][] | null;
  /** Famille d'un modèle (nom écrit, sans variante). */
  familleOf(base: string): string;
  /** Objet souple (feuillage, coussin, tissu) : toléré jusqu'à `SOFT` de pénétration. */
  softOf?(base: string): boolean;
  /** Au-delà, seules les instances nommées sont testées. */
  max?: number;
};

/**
 * Conflits entre objets posés : `chevauchement` (deux objets se pénètrent, ou un objet traverse un mur),
 * `degagement` (objet dans le passage d'une porte ou devant une fenêtre), `hors-espace` (objet hors du contour).
 * Ignorés : sols, plafond, objets plats (tapis) ; un modèle procgen n'est testé qu'une fois mesuré par le rendu.
 */
export function findConflicts(place: Placement[], models: Map<string, Model>, opt: CollideOptions): Conflict[] {
  return findAll(place, models, opt).conflicts;
}

/** Comme `findConflicts`, avec les boîtes des objets en conflit (`marks`, pour les montrer à l'écran). */
export function findAll(place: Placement[], models: Map<string, Model>, opt: CollideOptions): { conflicts: Conflict[]; marks: Obb[] } {
  const many = place.length > (opt.max ?? 800);
  const items: Item[] = [];
  const counts: Record<string, number> = {};
  for (const pl of place) {
    if (pl.hidden || pl.sensor || (many && !pl.name)) continue;
    const model = models.get(pl.model);
    if (!model) continue;
    const base = pl.model.split("~")[0];
    if (base.startsWith("espace:zone_") || base === "espace:plafond") continue;
    const boxes = placed(pl, model);
    if (!boxes.length) continue;
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of boxes) {
      const e = extent(b);
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], b.c[a] - e[a]);
        hi[a] = Math.max(hi[a], b.c[a] + e[a]);
      }
    }
    const kind = base.startsWith("espace:") ? "mur" : opt.familleOf(base) === "ouverture" ? "ouverture" : "objet";
    // objets plats (tapis, cadre posé à plat) : on marche et on pose dessus
    if (kind === "objet" && hi[1] - lo[1] < 0.03) continue;
    const k = (counts[base] = (counts[base] ?? 0) + 1);
    items.push({ who: pl.name || `${base}#${k}`, base, pl, boxes, lo, hi, kind, soft: opt.softOf?.(base) === true });
  }
  const out: Conflict[] = [];
  const seen = new Set<string>();
  const marked = new Set<Item>();
  const byWho = new Map(items.map((it) => [it.who, it]));
  const add = (a: string, b: string, type: Conflict["type"]) => {
    const key = `${a}|${b}|${type}`;
    if (seen.has(key) || out.length >= 200) return;
    seen.add(key);
    out.push({ a, b, type });
    for (const n of [a, b]) {
      const it = byWho.get(n);
      if (it && it.kind === "objet") marked.add(it);
    }
  };

  // Dégagement des ouvertures : le battant d'une porte, l'accès à une fenêtre
  const clear: { who: string; box: Obb; lo: V3; hi: V3 }[] = [];
  for (const it of items) {
    if (it.kind !== "ouverture") continue;
    const box = clearanceBox(models.get(it.pl.model)!, it.pl.at, it.pl.rot, it.pl.scale);
    if (!box) continue;
    const e = extent(box);
    clear.push({ who: it.who, box, lo: [box.c[0] - e[0], box.c[1] - e[1], box.c[2] - e[2]], hi: [box.c[0] + e[0], box.c[1] + e[1], box.c[2] + e[2]] });
  }

  const apart = (alo: V3, ahi: V3, blo: V3, bhi: V3) => alo[0] > bhi[0] || blo[0] > ahi[0] || alo[1] > bhi[1] || blo[1] > ahi[1] || alo[2] > bhi[2] || blo[2] > ahi[2];
  // tri sur x : chaque objet n'est comparé qu'à ceux dont l'intervalle en x recoupe le sien
  items.sort((p, q) => p.lo[0] - q.lo[0]);
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length && items[j].lo[0] <= a.hi[0]; j++) {
      const b = items[j];
      if (a.kind !== "objet" && b.kind !== "objet") continue;
      // une menuiserie tient dans l'épaisseur de son mur
      if ((a.kind === "ouverture" && b.kind === "mur") || (a.kind === "mur" && b.kind === "ouverture")) continue;
      // un rideau pend devant sa fenêtre, contre son appui
      if ((a.kind === "ouverture" && opt.familleOf(b.base) === "rideau") || (b.kind === "ouverture" && opt.familleOf(a.base) === "rideau")) continue;
      if (apart(a.lo, a.hi, b.lo, b.hi)) continue;
      let hit = false;
      const eps = a.soft || b.soft ? SOFT : EPS;
      for (const x of a.boxes) {
        for (const y of b.boxes) if (penetration(x, y) > eps) {
          hit = true;
          break;
        }
        if (hit) break;
      }
      if (hit) add(a.kind === "objet" ? a.who : b.who, a.kind === "objet" ? b.who : a.who, "chevauchement");
    }
    if (a.kind !== "objet") continue;
    // rideaux et voilages vivent devant les fenêtres
    if (opt.familleOf(a.base) !== "rideau") for (const c of clear) if (!apart(a.lo, a.hi, c.lo, c.hi) && a.boxes.some((x) => penetration(x, c.box) > (a.soft ? SOFT : EPS))) add(a.who, c.who, "degagement");
    if (opt.contour && opt.contour.length >= 3) {
      // emprise au sol de l'objet, rentrée de 2 cm : un meuble contre un mur n'est pas dehors
      const cx = (a.lo[0] + a.hi[0]) / 2, cz = (a.lo[2] + a.hi[2]) / 2;
      const outside = a.boxes.some((x) =>
        [-1, 1].some((sx) =>
          [-1, 1].some((sz) => {
            const px = x.c[0] + sx * x.ax[0][0] * x.h[0] + sz * x.ax[2][0] * x.h[2], pz = x.c[2] + sx * x.ax[0][2] * x.h[0] + sz * x.ax[2][2] * x.h[2];
            const dx = cx - px, dz = cz - pz, l = Math.hypot(dx, dz) || 1;
            const t = Math.min(l, a.soft ? SOFT + 0.03 : 0.03);
            return !inPolygon(px + (dx / l) * t, pz + (dz / l) * t, opt.contour!);
          }),
        ),
      );
      if (outside) add(a.who, "espace", "hors-espace");
    }
  }
  return { conflicts: out, marks: [...marked].flatMap((it) => it.boxes) };
}
