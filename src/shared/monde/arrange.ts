/**
 * Rangement d'un objet là où on le lâche : « mets ce meuble ici » devient une pose propre.
 *
 * À partir d'un point visé (x, z), `arrange` choisit l'appui selon la nature de l'objet (au sol, contre un mur, au
 * plafond, sur un meuble), l'aimante (dos au mur quand il en est proche, bords alignés sur ceux des voisins, sinon
 * grille), puis vérifie les collisions par boîtes orientées (collide.ts) et, s'il gêne, cherche la place libre la plus
 * proche. Sans place libre, la pose est rendue telle quelle avec `valid: false`.
 *
 * Fonction pure, sans rendu : elle sert au pilote (`nodes.<instance>.move`) comme au glisser du rendu 3D.
 */
import { clearanceBox, EPS, hull, penetration, placeBoxes, SOFT, type Obb } from "./collide";
import type { Model } from "./format";
import { boundsOf, DEFAULT_BOUNDS, inPolygon, localOn, surfaceOf, turnY, type Surface } from "./supports";

type V3 = [number, number, number];

/** Objet de la scène, à sa position courante. */
export type Body = {
  name: string;
  /** Nom écrit du modèle (sans variante). */
  base: string;
  model: Model;
  at: V3;
  rot: V3;
  scale: V3;
  famille: string;
  soft: boolean;
  /** Pose prévue du modèle : `sol`, `mur`, `plafond`, `dessus` (vide : au sol). */
  pose: string;
  /** Instance qui le porte (vide : aucune). */
  support: string;
};

export type Arranged = {
  at: V3;
  /** Cap (radians). */
  ry: number;
  /** Appui retenu : instance et position dans son repère (comme `Placement.on`), `null` au sol libre. */
  carry: { support: string; surface: string; local: V3; yaw: number } | null;
  /** Faux : aucune place libre trouvée près du point visé (la pose gêne `hits`). */
  valid: boolean;
  hits: string[];
  /** Aimantations appliquées : `mur`, `aligne-x`, `aligne-z`, `grille`, `deplace` (poussé vers une place libre). */
  snaps: string[];
};

export type ArrangeOptions = {
  /** Pas de la grille (mètres ; 0 : aucune). Défaut 0,05. */
  grid?: number;
  /** Distance d'aimantation aux murs (défaut 0,3) et aux bords des voisins (défaut 0,08). */
  wall?: number;
  align?: number;
  /** Contour de l'espace (mètres). */
  contour?: number[][] | null;
  /** Faux : pas de recherche d'une place libre (la pose visée est jugée telle quelle). */
  resolve?: boolean;
  /**
   * Cap voulu (radians) : l'objet le garde (au sol, au plafond, sur un meuble) et ne se colle dos à un mur que si ce
   * cap y tourne déjà le dos (à 45° près). Sans `ry` : cap actuel, et le mur proche l'oriente vers la pièce.
   */
  ry?: number;
};

const flat = (b: Body) => {
  const bb = boundsOf(b.model);
  return !!bb && (bb.max[1] - bb.min[1]) * Math.abs(b.scale[1]) < 0.03;
};
const isFloor = (b: Body) => b.base.startsWith("espace:zone_");
const isCeiling = (b: Body) => b.base === "espace:plafond";

/** Range `name` au point visé (x, z). `null` si l'instance est inconnue. */
export function arrange(bodies: Body[], name: string, x: number, z: number, opt: ArrangeOptions = {}): Arranged | null {
  const me = bodies.find((b) => b.name === name);
  if (!me) return null;
  const grid = opt.grid ?? 0.05, wallSnap = opt.wall ?? 0.3, alignSnap = opt.align ?? 0.08;
  const want = isFinite(opt.ry ?? NaN) ? opt.ry! : me.rot[1];
  const B = boundsOf(me.model) ?? DEFAULT_BOUNDS;
  const sc = me.scale;
  // ce que je porte me suit : ce n'est pas un obstacle
  const carried = new Set<string>([name]);
  for (let pass = 0; pass < 4; pass++) for (const b of bodies) if (carried.has(b.support)) carried.add(b.name);
  const others = bodies.filter((b) => !carried.has(b.name));
  const faces = others.map((b) => ({ b, s: surfaceOf(b.model, "top") })).filter((f): f is { b: Body; s: Surface } => !!f.s);
  const walls = faces.filter((f) => f.s.face === "+z");
  const ceiling = faces.find((f) => f.s.face === "-y" || isCeiling(f.b));
  const obstacles = others
    .filter((b) => !isFloor(b) && !isCeiling(b) && !flat(b))
    .map((b) => {
      const boxes = placeBoxes(b.model, b.at, b.rot, b.scale);
      return { b, boxes, ...hull(boxes) };
    })
    .filter((o) => o.boxes.length);
  const clear = others
    .filter((b) => b.famille === "ouverture")
    .map((b) => ({ b, box: clearanceBox(b.model, b.at, b.rot, b.scale) }))
    .filter((c): c is { b: Body; box: Obb } => !!c.box);

  const snaps: string[] = [];
  const round = (v: number) => (grid > 0 ? Math.round(v / grid) * grid : v);
  /** Point du monde dans le repère d'un appui (unités de son modèle). */
  const toLocal = (f: { b: Body }, px: number, pz: number): [number, number] => {
    const k = f.b.scale[0] || 1;
    const [lx, lz] = turnY(px - f.b.at[0], pz - f.b.at[2], -f.b.rot[1]);
    return [lx / k, lz / k];
  };
  type Pose = { at: V3; ry: number; carry: Arranged["carry"] };
  /** Pose sur une surface, `a0`, `a1` comptés depuis l'origine de la surface (voir `localOn`). */
  const onSurface = (f: { b: Body; s: Surface }, a0: number, a1: number, yaw: number): Pose => {
    const k = f.b.scale[0] || 1;
    const got = localOn(f.s, B, sc, k, [a0, a1], 0, yaw);
    const [wx, wz] = turnY(got.local[0] * k, got.local[2] * k, f.b.rot[1]);
    return { at: [f.b.at[0] + wx, f.b.at[1] + got.local[1] * k, f.b.at[2] + wz], ry: f.b.rot[1] + yaw, carry: { support: f.b.name, surface: "top", local: got.local, yaw } };
  };
  /** `at` d'une surface pour un point local : la surface compte depuis son centre, son origine ou son coin. */
  const origin = (s: Surface, lx: number, second: number): [number, number] => {
    const ox = s.from === "coin" ? s.x0 : s.from === "centre" ? (s.x0 + s.x1) / 2 : 0;
    const o2 = s.face === "+z" ? (s.from === "coin" ? s.y0 : s.from === "centre" ? (s.y0 + s.y) / 2 : 0) : s.from === "coin" ? s.z0 : s.from === "centre" ? (s.z0 + s.z1) / 2 : 0;
    return [lx - ox, second - o2];
  };
  /** Mur le plus proche d'un point, avec la position du point dans son repère (z = distance à la face, vers la pièce). */
  const nearestWall = (px: number, pz: number) => {
    let best: { f: { b: Body; s: Surface }; lx: number; lz: number; d: number } | null = null;
    for (const f of walls) {
      const [lx, lz] = toLocal(f, px, pz);
      const k = f.b.scale[0] || 1;
      // hors du mur dans sa longueur : distance au bout le plus proche
      const over = Math.max(0, f.s.x0 - lx, lx - f.s.x1);
      const d = Math.hypot(over, lz - f.s.z) * k;
      if (lz >= f.s.z - 0.5 && (!best || d < best.d)) best = { f, lx, lz, d };
    }
    return best;
  };

  // 1. Pose visée selon la nature de l'objet
  const hasBack = B.min[2] * sc[2] > -0.02 && B.max[2] * sc[2] > 0.05;
  const depth = (B.max[2] - Math.min(0, B.min[2])) * Math.abs(sc[2]);
  let pose: Pose;
  /** Déplacements permis pour chercher une place libre : dans le plan du sol, ou le long d'un mur. */
  let slide: (d: number, dir: number) => Pose | null;
  /** Replis essayés dans l'ordre quand `slide` ne trouve rien (autres murs, sol libre). */
  const fallbacks: ((d: number, dir: number) => Pose | null)[] = [];
  let floorFallback = false;
  const wall = nearestWall(x, z);
  if (me.pose === "mur" && wall) {
    const k = wall.f.b.scale[0] || 1;
    const baseH = (me.at[1] + B.min[1] * sc[1] - wall.f.b.at[1]) / k;
    const make = (lx: number): Pose => onSurface(wall.f, ...origin(wall.f.s, round(lx), Math.max(wall.f.s.y0, baseH)), 0);
    pose = make(wall.lx);
    snaps.push("mur");
    slide = (d, dir) => (dir === 0 || dir === 8 ? make(wall.lx + (dir === 0 ? d : -d) / k) : null);
    // les autres murs, du plus proche au plus loin, depuis le point du mur le plus proche du point visé
    const rest = walls
      .filter((f) => f !== wall.f)
      .map((f) => {
        const [lx, lz] = toLocal(f, x, z);
        const kk = f.b.scale[0] || 1;
        return { f, lx: Math.min(Math.max(lx, f.s.x0), f.s.x1), d: Math.hypot(Math.max(0, f.s.x0 - lx, lx - f.s.x1), lz - f.s.z) * kk };
      })
      .sort((p, q) => p.d - q.d);
    for (const w of rest) {
      const kk = w.f.b.scale[0] || 1;
      const h = (me.at[1] + B.min[1] * sc[1] - w.f.b.at[1]) / kk;
      const on = (lx: number): Pose => onSurface(w.f, ...origin(w.f.s, round(lx), Math.max(w.f.s.y0, h)), 0);
      fallbacks.push((d, dir) => (dir === 0 || dir === 8 ? on(w.lx + (dir === 0 ? d : -d) / kk) : null));
    }
  } else if (me.pose === "plafond" && ceiling) {
    const make = (px: number, pz: number): Pose => onSurface(ceiling, ...origin(ceiling.s, ...toLocal(ceiling, round(px), round(pz))), want - ceiling.b.rot[1]);
    pose = make(x, z);
    slide = (d, dir) => make(x + Math.cos((dir * Math.PI) / 8) * d, z + Math.sin((dir * Math.PI) / 8) * d);
  } else {
    // sur un meuble (objets à poser dessus) : le dessus le plus haut sous le point visé
    let top: { f: { b: Body; s: Surface }; lx: number; lz: number } | null = null;
    if (me.pose === "dessus")
      for (const f of faces) {
        if (f.s.face !== "top" || isFloor(f.b) || flat(f.b)) continue;
        const [lx, lz] = toLocal(f, x, z);
        if (lx < f.s.x0 || lx > f.s.x1 || lz < f.s.z0 || lz > f.s.z1) continue;
        if (!top || f.b.at[1] + f.s.y * (f.b.scale[0] || 1) > top.f.b.at[1] + top.f.s.y * (top.f.b.scale[0] || 1)) top = { f, lx, lz };
      }
    if (top) {
      const t = top;
      const make = (lx: number, lz: number): Pose => onSurface(t.f, ...origin(t.f.s, lx, lz), want - t.f.b.rot[1]);
      pose = make(t.lx, t.lz);
      slide = (d, dir) => make(t.lx + Math.cos((dir * Math.PI) / 8) * d, t.lz + Math.sin((dir * Math.PI) / 8) * d);
    } else {
      const y = -B.min[1] * sc[1];
      let ry = want;
      let px = x, pz = z;
      let alongWall: { f: { b: Body; s: Surface }; lx: number } | null = null;
      // dos au mur quand l'objet en a un et qu'il en est proche
      // un cap imposé qui ne tourne pas le dos à ce mur : pas d'aimantation au mur
      const facing = opt.ry === undefined || !wall || Math.abs(Math.atan2(Math.sin(want - wall.f.b.rot[1]), Math.cos(want - wall.f.b.rot[1]))) < Math.PI / 4;
      if (hasBack && wall && facing && wall.lz * (wall.f.b.scale[0] || 1) < wallSnap + depth) {
        alongWall = { f: wall.f, lx: wall.lx };
        snaps.push("mur");
      }
      const free = (qx: number, qz: number, yaw: number): Pose => ({ at: [qx, y, qz], ry: yaw, carry: null });
      const against = (lx: number): Pose => {
        const p = onSurface(alongWall!.f, ...origin(alongWall!.f.s, lx, alongWall!.f.s.y0), 0);
        // au sol contre le mur : l'objet ne dépend pas du mur
        return { at: [p.at[0], y, p.at[2]], ry: p.ry, carry: null };
      };
      if (alongWall) {
        pose = against(round(alongWall.lx));
        ry = pose.ry;
      } else {
        pose = free(px, pz, ry);
      }
      // bords alignés sur ceux des voisins au sol, sinon grille
      const mine = hull(placeBoxes(me.model, pose.at, [me.rot[0], pose.ry, me.rot[2]], sc));
      const shift: [number, number] = [0, 0];
      for (const axis of [0, 2] as const) {
        let best = Infinity;
        for (const o of obstacles) {
          if (o.b.famille === "ouverture" || o.lo[1] > 0.3 || surfaceOf(o.b.model, "top")?.face === "+z") continue;
          // voisin sur l'autre axe seulement : s'aligner sur un meuble à l'autre bout de la pièce n'aide pas
          const other = axis === 0 ? 2 : 0;
          if (mine.lo[other] > o.hi[other] + 1.5 || o.lo[other] > mine.hi[other] + 1.5) continue;
          const m3 = [mine.lo[axis], (mine.lo[axis] + mine.hi[axis]) / 2, mine.hi[axis]];
          const o3 = [o.lo[axis], (o.lo[axis] + o.hi[axis]) / 2, o.hi[axis]];
          for (const [i, j] of [[0, 0], [2, 2], [1, 1], [0, 2], [2, 0]]) {
            const d = o3[j] - m3[i];
            if (Math.abs(d) <= alignSnap && Math.abs(d) < Math.abs(best)) best = d;
          }
        }
        if (best !== Infinity) {
          shift[axis === 0 ? 0 : 1] = best;
          snaps.push(axis === 0 ? "aligne-x" : "aligne-z");
        }
      }
      if (alongWall) {
        // le long du mur seulement : le décalage d'alignement est projeté sur sa direction
        const [dx, dz] = turnY(1, 0, alongWall.f.b.rot[1]);
        const along = shift[0] * dx + shift[1] * dz;
        const baseLx = along ? alongWall.lx + along / (alongWall.f.b.scale[0] || 1) : round(alongWall.lx);
        pose = against(baseLx);
        const aw = alongWall;
        slide = (d, dir) => (dir === 0 || dir === 8 ? against(baseLx + (dir === 0 ? d : -d) / (aw.f.b.scale[0] || 1)) : null);
        // mur plein près du point : place libre au sol, même orientation, en partant de la pose contre le mur
        const [fx, , fz] = pose.at, fry = pose.ry;
        floorFallback = true;
        fallbacks.push((d, dir) => ({ at: [fx + Math.cos((dir * Math.PI) / 8) * d, y, fz + Math.sin((dir * Math.PI) / 8) * d], ry: fry, carry: null }));
      } else {
        px = shift[0] ? px + shift[0] : round(px);
        pz = shift[1] ? pz + shift[1] : round(pz);
        if (grid > 0 && !shift[0] && !shift[1]) snaps.push("grille");
        pose = free(px, pz, ry);
        slide = (d, dir) => free(px + Math.cos((dir * Math.PI) / 8) * d, pz + Math.sin((dir * Math.PI) / 8) * d, ry);
      }
    }
  }

  // 2. Collisions à cette pose ; sinon la place libre la plus proche
  const hitsAt = (p: Pose): string[] => {
    const boxes = placeBoxes(me.model, p.at, [me.rot[0], p.ry, me.rot[2]], sc);
    if (!boxes.length) return [];
    const { lo, hi } = hull(boxes);
    const out: string[] = [];
    for (const o of obstacles) {
      // une menuiserie gêne par son dégagement (ci-dessous), pas par son cadre pris dans le mur
      if (o.b.famille === "ouverture") continue;
      if (lo[0] > o.hi[0] || o.lo[0] > hi[0] || lo[1] > o.hi[1] || o.lo[1] > hi[1] || lo[2] > o.hi[2] || o.lo[2] > hi[2]) continue;
      const eps = me.soft || o.b.soft ? SOFT : EPS;
      if (boxes.some((a) => o.boxes.some((b) => penetration(a, b) > eps))) out.push(o.b.name || o.b.base);
    }
    if (me.famille !== "rideau") for (const c of clear) if (boxes.some((a) => penetration(a, c.box) > (me.soft ? SOFT : EPS))) out.push(c.b.name || c.b.base);
    if (opt.contour && opt.contour.length >= 3) {
      const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
      const t = me.soft ? SOFT + 0.03 : 0.03;
      const outside = boxes.some((b) =>
        [-1, 1].some((sx) =>
          [-1, 1].some((sz) => {
            const px = b.c[0] + sx * b.ax[0][0] * b.h[0] + sz * b.ax[2][0] * b.h[2], pz = b.c[2] + sx * b.ax[0][2] * b.h[0] + sz * b.ax[2][2] * b.h[2];
            const dx = cx - px, dz = cz - pz, l = Math.hypot(dx, dz) || 1;
            return !inPolygon(px + (dx / l) * Math.min(l, t), pz + (dz / l) * Math.min(l, t), opt.contour!);
          }),
        ),
      );
      if (outside) out.push("espace");
    }
    return out;
  };
  let hits = hitsAt(pose);
  if (hits.length && opt.resolve !== false) {
    const sources = [slide, ...fallbacks];
    search: for (let i = 0; i < sources.length; i++)
      for (let d = 0.05; d <= 1.5 + 1e-9; d += 0.05)
        for (let dir = 0; dir < 16; dir++) {
          const cand = sources[i](d, dir);
          if (!cand) continue;
          if (!hitsAt(cand).length) {
            pose = cand;
            hits = [];
            // replié au sol loin du mur visé : ni « mur » ni alignements
            if (i > 0 && !cand.carry && floorFallback) snaps.length = 0;
            snaps.push("deplace");
            break search;
          }
        }
  }
  return { at: pose.at, ry: pose.ry, carry: pose.carry, valid: hits.length === 0, hits, snaps };
}

/** Ce qu'un rangement devient dans `place` (unité du document) : de quoi rendre la pose durable dans le monde écrit. */
export type PlacedInfo = {
  objectId: string;
  /** Position et cap de l'instance (mètres, radians), comme dans `nodes`. */
  x: number;
  y: number;
  z: number;
  ry: number;
  valid: boolean;
  hits: string[];
  snaps: string[];
  /** Clés à fusionner dans le placement de l'instance (`on` / `at` / `rot`, unité du document). */
  place: Record<string, unknown>;
};

export function placedInfo(name: string, res: Arranged, bodies: Body[], unit: number): PlacedInfo {
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const me = bodies.find((b) => b.name === name);
  const sup = res.carry ? bodies.find((b) => b.name === res.carry!.support) : undefined;
  let place: Record<string, unknown>;
  const s = sup ? surfaceOf(sup.model, "top") : null;
  if (res.carry && sup && s && me) {
    const k = sup.scale[0] || 1;
    const B = boundsOf(me.model) ?? DEFAULT_BOUNDS;
    const [lx, ly, lz] = res.carry.local;
    const ox = s.from === "coin" ? s.x0 : s.from === "centre" ? (s.x0 + s.x1) / 2 : 0;
    let second: number;
    if (s.face === "+z") second = ly + (B.min[1] * me.scale[1]) / k - (s.from === "coin" ? s.y0 : s.from === "centre" ? (s.y0 + s.y) / 2 : 0);
    else second = lz - (s.from === "coin" ? s.z0 : s.from === "centre" ? (s.z0 + s.z1) / 2 : 0);
    const deg = (res.carry.yaw * 180) / Math.PI;
    place = { on: sup.name, against: null, at: [r4(((lx - ox) * k) / unit), r4((second * k) / unit)], rot: [0, r4(deg), 0] };
  } else place = { on: null, against: null, at: [r4(res.at[0] / unit), r4(res.at[1] / unit), r4(res.at[2] / unit)], rot: [0, r4((res.ry * 180) / Math.PI), 0] };
  return { objectId: name, x: r4(res.at[0]), y: r4(res.at[1]), z: r4(res.at[2]), ry: r4(res.ry), valid: res.valid, hits: res.hits, snaps: res.snaps, place };
}
