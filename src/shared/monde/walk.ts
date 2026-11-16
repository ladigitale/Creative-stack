/**
 * Déplacements en jeu qui respectent les obstacles : `nodes.<instance> = {x, z, collide: "glisser"}`.
 *
 * Le trajet de la position actuelle au point demandé est parcouru par pas de 10 cm au plus ; à chaque pas, les
 * boîtes orientées de l'objet (collide.ts) sont testées contre celles de la scène. `glisser` (défaut) : bloqué,
 * l'objet essaie chaque axe seul et longe l'obstacle ; `bloquer` : il s'arrête au dernier point libre. Ne gênent
 * pas : ce qu'il porte et ce qui le porte, sols, plafond, objets plats, portes et fenêtres (on passe par
 * l'ouverture, le mur autour reste un obstacle), et ce qu'il chevauchait déjà au départ (pour pouvoir en sortir).
 *
 * Fonction pure, sans rendu : les deux rendus corrigent le patch avant de déplacer l'instance.
 */
import { EPS, hull, penetration, placeBoxes, SOFT, type Obb } from "./collide";
import type { Body } from "./arrange";
import { boundsOf, DEFAULT_BOUNDS } from "./supports";
import { m4, m4Compose } from "./math";

export type WalkMode = "glisser" | "bloquer";

export type Walked = {
  x: number;
  z: number;
  /** Ce qui a gêné (noms d'instance, ou modèle pour le décor sans nom). */
  hits: string[];
  /** Vrai si le point demandé n'a pas été atteint. */
  blocked: boolean;
};

/** Pas maximal du parcours (m) et nombre de pas maximal. */
const STEP = 0.1;
const MAX_STEPS = 80;

const isFloor = (b: Body) => b.base.startsWith("espace:zone_") || b.base === "espace:plafond";

/** Boîtes d'un objet ; un modèle sans boîte mesurable (gen pas encore généré) : sa boîte d'emprise, sinon 50 × 100 × 50 cm. */
function boxesAt(b: Body, x: number, z: number): Obb[] {
  const boxes = placeBoxes(b.model, [x, b.at[1], z], b.rot, b.scale);
  if (boxes.length) return boxes;
  return [envelopeAt(b, x, z)];
}

/** Boîte d'emprise orientée d'un objet (celle de son modèle, à sa place) : contour de sélection, repli des collisions. */
export function envelopeOf(b: Body): Obb {
  return envelopeAt(b, b.at[0], b.at[2]);
}

function envelopeAt(b: Body, x: number, z: number): Obb {
  const bb = boundsOf(b.model) ?? DEFAULT_BOUNDS;
  const m = m4();
  m4Compose(m, x, b.at[1], z, b.rot[0], b.rot[1], b.rot[2], b.scale[0], b.scale[1], b.scale[2]);
  const c = [0, 1, 2].map((a) => (bb.min[a] + bb.max[a]) / 2);
  const h = [0, 1, 2].map((a) => ((bb.max[a] - bb.min[a]) / 2) * Math.abs(b.scale[a]));
  const ax = [0, 1, 2].map((a) => {
    const v = [m[a * 4], m[a * 4 + 1], m[a * 4 + 2]];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }) as Obb["ax"];
  const w = [0, 1, 2].map((r) => m[12 + r] + m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2]);
  return { c: [w[0], w[1], w[2]], ax, h: [h[0], h[1], h[2]] };
}

/** Parcourt le trajet de `name` vers (x, z) en évitant les obstacles. `null` si l'instance est inconnue. */
export function walk(bodies: Body[], name: string, x: number, z: number, mode: WalkMode = "glisser"): Walked | null {
  const me = bodies.find((b) => b.name === name);
  if (!me) return null;
  // ce que je porte et ce qui me porte (de proche en proche) ne gênent pas
  const free = new Set<string>([name]);
  for (let pass = 0; pass < 4; pass++) for (const b of bodies) if (free.has(b.support)) free.add(b.name);
  for (let s = me.support, k = 0; s && k < 8; k++) {
    free.add(s);
    s = bodies.find((b) => b.name === s)?.support ?? "";
  }
  const start = boxesAt(me, me.at[0], me.at[2]);
  const flat = (b: Body) => {
    const bb = boundsOf(b.model);
    return !!bb && (bb.max[1] - bb.min[1]) * Math.abs(b.scale[1]) < 0.03;
  };
  const obstacles = bodies
    .filter((b) => !(b.name && free.has(b.name)) && b !== me && !isFloor(b) && b.famille !== "ouverture" && !flat(b))
    .map((b) => {
      const boxes = placeBoxes(b.model, b.at, b.rot, b.scale);
      return { b, boxes, ...hull(boxes) };
    })
    .filter((o) => o.boxes.length)
    // déjà dedans au départ : on le laisse sortir
    .filter((o) => !start.some((a) => o.boxes.some((c) => penetration(a, c) > (me.soft || o.b.soft ? SOFT : EPS))));

  const hits = new Set<string>();
  const blockedAt = (px: number, pz: number): boolean => {
    const boxes = boxesAt(me, px, pz);
    const { lo, hi } = hull(boxes);
    let hit = false;
    for (const o of obstacles) {
      if (lo[0] > o.hi[0] || o.lo[0] > hi[0] || lo[1] > o.hi[1] || o.lo[1] > hi[1] || lo[2] > o.hi[2] || o.lo[2] > hi[2]) continue;
      const eps = me.soft || o.b.soft ? SOFT : EPS;
      if (boxes.some((a) => o.boxes.some((c) => penetration(a, c) > eps))) {
        hits.add(o.b.name || o.b.base);
        hit = true;
      }
    }
    return hit;
  };

  let cx = me.at[0], cz = me.at[2];
  const dist = Math.hypot(x - cx, z - cz);
  const n = Math.min(MAX_STEPS, Math.max(1, Math.ceil(dist / STEP)));
  const dx = (x - cx) / n, dz = (z - cz) / n;
  let stopped = false;
  for (let i = 0; i < n; i++) {
    if (!blockedAt(cx + dx, cz + dz)) {
      cx += dx;
      cz += dz;
      continue;
    }
    if (mode === "bloquer") {
      stopped = true;
      break;
    }
    // longer l'obstacle : l'axe qui avance le plus, s'il est libre
    const axes = Math.abs(dx) >= Math.abs(dz) ? [[dx, 0], [0, dz]] : [[0, dz], [dx, 0]];
    let moved = false;
    for (const [ax, az] of axes) {
      if ((ax || az) && !blockedAt(cx + ax, cz + az)) {
        cx += ax;
        cz += az;
        moved = true;
        break;
      }
    }
    if (!moved) {
      stopped = true;
      break;
    }
  }
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { x: r(cx), z: r(cz), hits: [...hits], blocked: stopped || Math.hypot(x - cx, z - cz) > 1e-3 };
}
