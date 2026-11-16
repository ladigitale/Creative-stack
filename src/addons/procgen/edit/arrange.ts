/**
 * Rangement d'un objet de scène procgen là où on le lâche (édition au doigt) : fonction pure, sans rendu.
 *
 * À partir d'un point visé (x, z), l'objet est posé sur son appui (relief, eau pour un objet `onWater`), aimanté
 * (contact dos au mur / à un bâtiment / à une clôture, bords alignés sur les voisins parallèles, sinon grille fine),
 * puis jugé : emprises au sol (rectangles orientés, boîtes englobantes par instance de la scène composée), tronçons de
 * clôture et garde-corps, chaussée et rivière (hors `onPath`), eau (hors `onWater`), bords de la scène. S'il gêne, il
 * glisse vers la place libre la plus proche (recherche commune avec `sonic-3d`, shared/free-place) ; sinon `valid: false`.
 */
import { type Rect2, fromRect, quarterGap, rectCorners, rectPenetration, rectRadius, searchFree, toRect } from "../../../shared/free-place";
import type { ObjectInfo, SceneModel } from "../scene/compose";

/** Obstacle : une emprise (ou un tronçon) d'un objet posé. */
export type Obstacle = { id: string; rect: Rect2; wall: boolean };

export type PlaceCtx = {
  size: [number, number];
  /** Hauteur du relief (sans les tabliers : comme la composition). */
  height: (x: number, z: number) => number;
  waterLevel: number | null;
  /** Distance au bord de la route la plus proche (négative dessus) et son type. */
  pathInfo: ((x: number, z: number) => { d: number; kind: string | null; id: string | null }) | null;
  obstacles: Obstacle[];
};

/** Objet à ranger : emprise (demi-dimensions), cap, nature. */
export type Mover = { id: string; generator: string; hx: number; hz: number; yaw: number; onWater?: boolean; onPath?: boolean };

export type Arranged = {
  x: number;
  y: number;
  z: number;
  /** Cap (radians). */
  yaw: number;
  valid: boolean;
  /** Ce qui gêne encore : ids d'objets, `bord`, `eau`, `terre` (objet flottant hors de l'eau), id de route. */
  hits: string[];
  /** `contact`, `aligne-x`, `aligne-z`, `grille`, `deplace` (poussé vers une place libre), `dedans` (ramené dans la scène). */
  snaps: string[];
};

export type ArrangeOptions = {
  /** Pas de grille (m, défaut 0,05 ; 0 : aucune). */
  grid?: number;
  /** Aimantation aux bords des voisins (défaut 0,08) et dos à un mur, un bâtiment, une clôture (défaut 0,3). */
  align?: number;
  wall?: number;
  /** Faux : pas de recherche de place libre. */
  resolve?: boolean;
};

/** Générateurs qui ne gênent pas (on marche dessus, ils roulent, ils bougent seuls). */
const NEVER = new Set(["grass", "flowers", "ball", "character", "animal"]);
/** Partie de l'emprise qui gêne vraiment : tronc d'un arbre (le feuillage passe au-dessus), touffe d'une plante. */
const CORE: Record<string, number> = { tree: 0.3, plant: 0.6, bush: 0.8, rock: 0.85 };
/** Objets « mur » : on s'y adosse de plus loin. */
const WALLISH = new Set(["building", "wall", "structure"]);

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Emprise d'un objet de la scène, réduite à ce qui gêne. */
export function rectOf(o: Pick<ObjectInfo, "pos" | "yaw" | "footprint" | "generator">): Rect2 {
  const k = CORE[o.generator] ?? 1;
  return { x: o.pos[0], z: o.pos[2], hx: Math.max(0.05, o.footprint.hx * k), hz: Math.max(0.05, o.footprint.hz * k), yaw: o.yaw };
}

/** Contexte de rangement d'une scène composée (une fois par geste). `skip` : ids ignorés (l'objet saisi). */
export function placeCtx(model: SceneModel, skip: ReadonlySet<string> = new Set()): PlaceCtx {
  const obstacles: Obstacle[] = [];
  for (const o of model.objects) {
    if (skip.has(o.id) || o.walkable || o.mode === "actor" || NEVER.has(o.generator)) continue;
    const wall = WALLISH.has(o.generator);
    if (o.blockers) {
      for (const [x, z, hx, hz, yaw] of o.blockers) obstacles.push({ id: o.id, rect: { x, z, hx, hz, yaw }, wall: true });
      continue;
    }
    obstacles.push({ id: o.id, rect: rectOf(o), wall });
  }
  const T = model.terrain;
  return {
    size: model.size,
    height: (x, z) => (T ? T.height(x, z) : 0),
    waterLevel: T?.spec.water ?? null,
    pathInfo: T
      ? (x, z) => {
          const p = T.pathInfo(x, z);
          return { d: p.d, kind: p.path?.kind ?? null, id: p.path?.id ?? null };
        }
      : null,
    obstacles,
  };
}

/** Mobile d'après une emprise brute (nouvel objet) : réduite comme celles de la scène. */
export function moverFor(id: string, generator: string, hx: number, hz: number, yaw: number, flags: { onWater?: boolean; onPath?: boolean } = {}): Mover {
  const k = CORE[generator] ?? 1;
  return { id, generator, hx: Math.max(0.05, hx * k), hz: Math.max(0.05, hz * k), yaw, ...(flags.onWater ? { onWater: true } : {}), ...(flags.onPath ? { onPath: true } : {}) };
}

/** Mobile tiré d'un objet de la scène. */
export function moverOf(o: ObjectInfo): Mover {
  const k = CORE[o.generator] ?? 1;
  return { id: o.id, generator: o.generator, hx: Math.max(0.05, o.footprint.hx * k), hz: Math.max(0.05, o.footprint.hz * k), yaw: o.yaw, ...(o.onWater ? { onWater: true } : {}), ...(o.onPath ? { onPath: true } : {}) };
}

/** Hauteur de pose (comme la composition) : relief, plus bas coin d'un bâtiment, flottaison d'un bateau. */
export function restY(ctx: PlaceCtx, me: Mover, x: number, z: number, yaw = me.yaw): number {
  if (me.onWater && ctx.waterLevel !== null) return ctx.waterLevel - 0.15;
  if (me.generator === "building") return Math.min(ctx.height(x, z), ...rectCorners({ x, z, hx: me.hx, hz: me.hz, yaw }).map(([cx, cz]) => ctx.height(cx, cz))) - 0.05;
  return ctx.height(x, z) - 0.02;
}

/** Ce qui gêne l'objet posé en (x, z) avec ce cap. */
export function hitsAt(ctx: PlaceCtx, me: Mover, x: number, z: number, yaw = me.yaw): string[] {
  const rect: Rect2 = { x, z, hx: me.hx, hz: me.hz, yaw };
  const out: string[] = [];
  const W = ctx.size[0] / 2, D = ctx.size[1] / 2;
  const corners = rectCorners(rect);
  if (corners.some(([cx, cz]) => Math.abs(cx) > W + 1e-6 || Math.abs(cz) > D + 1e-6)) out.push("bord");
  // points témoins : centre et coins rapprochés (une emprise frôle souvent un bord sans gêner)
  const probes: [number, number][] = [[x, z], ...rectCorners({ ...rect, hx: me.hx * 0.6, hz: me.hz * 0.6 })];
  if (ctx.pathInfo && !me.onPath && !me.onWater) {
    for (const [i, [px, pz]] of probes.entries()) {
      const p = ctx.pathInfo(px, pz);
      if (!p.kind || p.d >= 0 || p.kind === "plaza" || (p.kind === "path" && i > 0)) continue;
      out.push(p.id ?? p.kind);
      break;
    }
  }
  if (ctx.waterLevel !== null) {
    if (me.onWater) {
      if (ctx.height(x, z) >= ctx.waterLevel - 0.4) out.push("terre");
    } else if (probes.some(([px, pz]) => ctx.height(px, pz) < ctx.waterLevel! + 0.05)) out.push("eau");
  }
  const R = rectRadius(rect);
  for (const o of ctx.obstacles) {
    if (Math.hypot(o.rect.x - x, o.rect.z - z) > R + rectRadius(o.rect)) continue;
    if (rectPenetration(rect, o.rect) > 0.012 && !out.includes(o.id)) out.push(o.id);
  }
  return out;
}

/** Ramène le point pour que l'emprise tienne dans la scène. */
function keepInside(ctx: PlaceCtx, me: Mover, x: number, z: number, yaw: number): [number, number] {
  const cs = rectCorners({ x: 0, z: 0, hx: me.hx, hz: me.hz, yaw });
  const ex = Math.max(...cs.map((c) => Math.abs(c[0]))), ez = Math.max(...cs.map((c) => Math.abs(c[1])));
  const W = Math.max(0, ctx.size[0] / 2 - ex), D = Math.max(0, ctx.size[1] / 2 - ez);
  return [Math.min(W, Math.max(-W, x)), Math.min(D, Math.max(-D, z))];
}

/**
 * Aimantation dans le repère de l'objet : pour chaque axe local, le plus petit décalage qui met un bord en contact avec
 * un voisin parallèle (dos au mur jusqu'à `wall`, sinon `align`) ou l'aligne sur un bord voisin (`align`).
 */
export function snapShift(ctx: PlaceCtx, me: Mover, x: number, z: number, yaw: number, align = 0.08, wall = 0.3): { dx: number; dz: number; snaps: string[] } {
  const frame: Rect2 = { x, z, hx: me.hx, hz: me.hz, yaw };
  const best = [Infinity, Infinity];
  const kinds: string[] = ["", ""];
  const R = rectRadius(frame);
  for (const o of ctx.obstacles) {
    if (quarterGap(o.rect.yaw, yaw) > 0.03) continue;
    const dist = Math.hypot(o.rect.x - x, o.rect.z - z);
    if (dist > R + rectRadius(o.rect) + Math.max(wall, 1.5)) continue;
    // extents du voisin dans mon repère (exacts : côtés parallèles)
    const loc = rectCorners(o.rect).map(([cx, cz]) => toRect(frame, cx, cz));
    const lo = [Math.min(...loc.map((p) => p[0])), Math.min(...loc.map((p) => p[1]))];
    const hi = [Math.max(...loc.map((p) => p[0])), Math.max(...loc.map((p) => p[1]))];
    const mine = [me.hx, me.hz];
    for (const axis of [0, 1]) {
      const other = 1 - axis;
      const h = mine[axis], ho = mine[other];
      const overlapOther = lo[other] < ho - 1e-3 && hi[other] > -ho + 1e-3;
      const nearOther = lo[other] < ho + 1.5 && hi[other] > -ho - 1.5;
      const cands: [number, number, string][] = [];
      if (overlapOther) {
        // en face sur cet axe : contact de mon bord contre le sien, du côté où il se trouve ; un mur derrière moi
        // (axe z, dos = -z) attire de plus loin
        const behind = (lo[axis] + hi[axis]) / 2 < 0;
        if (behind) cands.push([hi[axis] + h, axis === 1 && o.wall ? wall : align, "contact"]);
        else cands.push([lo[axis] - h, align, "contact"]);
      } else if (nearOther) {
        // côte à côte : bords et milieux alignés
        const k = axis === 0 ? "aligne-x" : "aligne-z";
        cands.push([lo[axis] + h, align, k], [hi[axis] - h, align, k], [(lo[axis] + hi[axis]) / 2, align, k]);
      }
      for (const [d, lim, kind] of cands)
        if (Math.abs(d) <= lim && Math.abs(d) < Math.abs(best[axis])) {
          best[axis] = d;
          kinds[axis] = kind;
        }
    }
  }
  const lx = Number.isFinite(best[0]) ? best[0] : 0, lz = Number.isFinite(best[1]) ? best[1] : 0;
  const [wx, wz] = fromRect(frame, lx, lz);
  return { dx: wx - x, dz: wz - z, snaps: [...new Set(kinds.filter(Boolean))] };
}

/** Range `me` au point visé (x, z), cap gardé (jamais tourné tout seul). */
export function arrangeAt(ctx: PlaceCtx, me: Mover, x: number, z: number, opt: ArrangeOptions = {}): Arranged {
  const grid = opt.grid ?? 0.05;
  const yaw = me.yaw;
  const snaps: string[] = [];
  let [px, pz] = keepInside(ctx, me, x, z, yaw);
  if (Math.hypot(px - x, pz - z) > 1e-6) snaps.push("dedans");
  const sh = snapShift(ctx, me, px, pz, yaw, opt.align ?? 0.08, opt.wall ?? 0.3);
  if (sh.snaps.length) {
    px += sh.dx;
    pz += sh.dz;
    snaps.push(...sh.snaps);
  } else if (grid > 0) {
    px = Math.round(px / grid) * grid;
    pz = Math.round(pz / grid) * grid;
    snaps.push("grille");
  }
  let hits = hitsAt(ctx, me, px, pz, yaw);
  if (hits.length && opt.resolve !== false) {
    // pas et portée à l'échelle de l'objet : un banc se cherche au centimètre près, une maison au demi-mètre
    const R = rectRadius({ x: 0, z: 0, hx: me.hx, hz: me.hz, yaw: 0 });
    const step = Math.max(0.05, Math.round(R / 8 / 0.05) * 0.05);
    const max = Math.min(16, Math.max(1.5, R * 3));
    const ox = px, oz = pz;
    const found = searchFree<[number, number]>(
      [(d, dir) => keepInside(ctx, me, ox + Math.cos((dir * Math.PI) / 8) * d, oz + Math.sin((dir * Math.PI) / 8) * d, yaw)],
      ([qx, qz]) => !hitsAt(ctx, me, qx, qz, yaw).length,
      { step, max, dirs: 16 },
    );
    if (found) {
      [px, pz] = found.pose;
      hits = [];
      snaps.push("deplace");
    }
  }
  return { x: r4(px), y: r4(restY(ctx, me, px, pz, yaw)), z: r4(pz), yaw, valid: hits.length === 0, hits, snaps };
}
