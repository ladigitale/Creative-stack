/**
 * Dessin vectoriel d'une liste de pièces (`gen/parts.ts`) : les mêmes données que le maillage 3D. Chaque pièce
 * convexe est dessinée d'un bloc ; les pièces sont triées de la plus lointaine à la plus proche (peintre), ce qui
 * suffit pour du mobilier et des objets du quotidien vus en élévation ou en cavalière.
 */
import { type V3, qRot } from "../../core/math";
import { type Part, type PartList, boxQ, ccw } from "../../gen/parts";
import { type P2, Pen, hull, strokeVar } from "../shape";
import type { Kit } from "./kit";
import { readParts } from "../../gen/parts";
import { seatModel } from "../../gen/seat";
import { placedTool } from "../../gen/tool";
import { containerModel } from "../../gen/container";
import { streetModel } from "../../gen/street";
import type { ObjectDrawer } from "./types";

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

function center(p: Part): V3 {
  switch (p.t) {
    case "plate":
    case "box":
    case "blob":
      return p.c;
    case "rod":
      return mul3(add3(p.a, p.b), 0.5);
    case "tube":
      return p.pts[Math.floor(p.pts.length / 2)];
    case "lathe": {
      const h = p.profile[p.profile.length - 1][1];
      return [p.c[0], p.c[1] + h / 2, p.c[2]];
    }
  }
}

/**
 * Surface de dessin : projection d'un point local, visibilité et ton d'une normale locale, profondeur (plus grand =
 * plus près), échelle (unités de dessin par mètre), émetteur. `lathe` optionnel (sinon enveloppe des anneaux).
 */
export type PartSurface = {
  P: (x: number, y: number, z: number) => P2;
  vis: (n: V3) => number;
  tone: (n: V3) => number;
  depth: (v: V3) => number;
  k: number;
  em: Kit["em"];
  /** Côté de la lumière en abscisse écran (−1 gauche, 1 droite). */
  lightSide: number;
  lathe?: (c: V3, profile: [number, number][], role: string, width: number) => void;
  /** Ton ajouté à tout (objet tenu côté ombre). */
  toneBias?: number;
};

export function kitSurface(kit: Kit): PartSurface {
  return {
    P: (x, y, z) => kit.P(x, y, z),
    vis: (n) => kit.vis(n),
    tone: (n) => kit.tone(n),
    depth: (v) => kit.pr.depth(kit.fr.w(v[0], v[1], v[2])),
    k: kit.fr.scale,
    em: kit.em,
    lightSide: kit.L[0] <= 0 ? -1 : 1,
    // silhouette : profil extérieur seulement (jusqu'au point le plus haut ; le retour intérieur d'un seau creux ne se voit pas de profil)
    lathe: (c, profile, role, width) => {
      let top = 0;
      profile.forEach(([, y], i) => (y >= profile[top][1] ? (top = i) : 0));
      kit.sub(c[0], c[1], c[2]).lathe(profile.slice(0, top + 1), role, { width });
    },
  };
}

/** Dessine les pièces avec la boîte à outils de l'objet. `width` : épaisseur relative des contours. */
export function drawParts(kit: Kit, parts: PartList, o: { width?: number } = {}) {
  drawPartsOn(kitSurface(kit), parts, o);
}

export function drawPartsOn(sf: PartSurface, parts: PartList, o: { width?: number } = {}) {
  const k = sf.k, em = sf.em, tb = sf.toneBias ?? 0;
  const W = o.width ?? 0.7;
  const items = parts.map((p, i) => ({ p, d: sf.depth(center(p)) + i * 1e-6 }));
  items.sort((a, b) => a.d - b.d);
  for (const { p } of items) {
    switch (p.t) {
      case "box": {
        const q = boxQ(p);
        const axes: V3[] = [qRot(q, [1, 0, 0]), qRot(q, [0, 1, 0]), qRot(q, [0, 0, 1])];
        for (let a = 0; a < 3; a++)
          for (const s of [1, -1]) {
            const n = mul3(axes[a], s);
            if (sf.vis(n) <= 1e-3) continue;
            const u = (a + 1) % 3, v = (a + 2) % 3;
            const fc = add3(p.c, mul3(n, p.h[a]));
            const eu = mul3(axes[u], p.h[u]), ev = mul3(axes[v], p.h[v]);
            const quad: V3[] = [add3(add3(fc, eu), ev), add3(add3(fc, mul3(eu, -1)), ev), add3(add3(fc, mul3(eu, -1)), mul3(ev, -1)), add3(add3(fc, eu), mul3(ev, -1))];
            em.add(new Pen().poly(quad.map((c) => sf.P(c[0], c[1], c[2]))), p.role, { tone: sf.tone(n) + tb, width: W });
          }
        break;
      }
      case "plate": {
        const q = boxQ(p);
        const pts = ccw(p.pts);
        const W3 = (x: number, y: number, z: number): V3 => add3(p.c, qRot(q, [x, y, z]));
        const nz = qRot(q, [0, 0, 1]);
        // tranches visibles d'abord, puis la face visible
        for (let i = 0; i < pts.length; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
          const l = Math.hypot(bx - ax, by - ay) || 1;
          const n = qRot(q, [(by - ay) / l, -(bx - ax) / l, 0]);
          if (sf.vis(n) <= 1e-3) continue;
          const quad = [W3(ax, ay, p.d), W3(ax, ay, -p.d), W3(bx, by, -p.d), W3(bx, by, p.d)].map((c) => sf.P(c[0], c[1], c[2]));
          em.add(new Pen().poly(quad), p.role, { tone: sf.tone(n) + tb, width: W * 0.6 });
        }
        const front = sf.vis(nz) >= 0;
        const n = front ? nz : mul3(nz, -1);
        em.add(new Pen().poly(pts.map(([x, y]) => { const c = W3(x, y, front ? p.d : -p.d); return sf.P(c[0], c[1], c[2]); })), p.role, { tone: sf.tone(n) + tb, width: W });
        break;
      }
      case "rod": {
        const a = sf.P(...p.a), b = sf.P(...p.b);
        em.add(strokeVar(new Pen(), [a, b], [p.r * k, (p.r1 ?? p.r) * k], { capStart: true, capEnd: true }), p.role, { tone: tb, width: W * 0.8 });
        break;
      }
      case "tube": {
        const pts = p.pts.map((c) => sf.P(c[0], c[1], c[2]));
        em.add(strokeVar(new Pen(), pts, pts.map(() => p.r * k), { capStart: true, capEnd: true }), p.role, { tone: tb, width: W * 0.8 });
        break;
      }
      case "lathe": {
        if (sf.lathe && !tb) {
          sf.lathe(p.c, p.profile, p.role, W);
          break;
        }
        const pts: P2[] = [];
        for (const [r, y] of p.profile) for (let j = 0; j < 12; j++) {
          const a = (j / 12) * Math.PI * 2;
          pts.push(sf.P(p.c[0] + r * Math.cos(a), p.c[1] + y, p.c[2] + r * Math.sin(a)));
        }
        const h = hull(pts);
        if (h.length >= 3) em.add(new Pen().poly(h), p.role, { tone: tb, width: W });
        break;
      }
      case "blob": {
        const pts: P2[] = [];
        for (let r = -2; r <= 2; r++) {
          const lat = (r / 2.5) * (Math.PI / 2), cy = Math.cos(lat), sy = Math.sin(lat);
          for (let j = 0; j < 14; j++) {
            const lo = (j / 14) * Math.PI * 2;
            pts.push(sf.P(p.c[0] + p.r[0] * cy * Math.cos(lo), p.c[1] + p.r[1] * sy, p.c[2] + p.r[2] * cy * Math.sin(lo)));
          }
        }
        pts.push(sf.P(p.c[0], p.c[1] + p.r[1], p.c[2]), sf.P(p.c[0], p.c[1] - p.r[1], p.c[2]));
        const h = hull(pts);
        if (h.length < 3) break;
        em.add(new Pen().smooth(h, true), p.role, { tone: tb, width: W });
        if (!tb) {
          const [cu, cv] = sf.P(...p.c);
          em.add(new Pen().ellipse(cu + sf.lightSide * p.r[0] * k * 0.35, cv + p.r[1] * k * 0.35, p.r[0] * k * 0.35, p.r[1] * k * 0.3), p.role, { tone: 1, stroke: null, alpha: 0.7 });
        }
        break;
      }
    }
  }
}

/* ---------- dessinateurs des générateurs à pièces ---------- */


const shadowOf: ObjectDrawer = (kit, _p, ctx) => {
  const o = ctx.obj;
  kit.castShadow(ctx.env.shadows, (o.footprint.hx / o.scale) * 0.9, (o.footprint.hz / o.scale) * 0.9, (o.height / o.scale) * 0.6, ctx.env.ground, kit.em.z0 - 0.5, kit.em.layer, kit.em.depth);
};

export const drawSeat: ObjectDrawer = (kit, p, ctx) => {
  shadowOf(kit, p, ctx);
  const m = seatModel(p);
  drawParts(kit, m.parts, { width: m.scale < 0.6 ? 0.5 : 0.7 });
};

export const drawAssembly: ObjectDrawer = (kit, p, ctx) => {
  shadowOf(kit, p, ctx);
  drawParts(kit, readParts(p.parts).parts);
};

export const drawTool: ObjectDrawer = (kit, p, ctx) => {
  shadowOf(kit, p, ctx);
  drawParts(kit, placedTool(String(p.kind), p).parts, { width: 0.5 });
};

export const drawContainer: ObjectDrawer = (kit, p, ctx) => {
  shadowOf(kit, p, ctx);
  // couvercle levé : derrière le corps (dessiné d'abord) ; fermé : par-dessus
  const m = containerModel(p);
  if (m.lidBehind && m.lid.length) drawParts(kit, m.lid, { width: 0.55 });
  drawParts(kit, [...m.body, ...m.fill], { width: 0.55 });
  if (!m.lidBehind && m.lid.length) drawParts(kit, m.lid, { width: 0.55 });
};

export const drawStreet: ObjectDrawer = (kit, p, ctx) => {
  // ombre de pied : poteaux, bras de lampadaire et panneaux n'en projettent qu'une petite
  const o = ctx.obj;
  const hx = Math.min(o.footprint.hx / o.scale, 0.6), hz = Math.min(o.footprint.hz / o.scale, 0.6);
  kit.castShadow(ctx.env.shadows, hx * 0.9, hz * 0.9, Math.min(o.height / o.scale, 2) * 0.6, ctx.env.ground, kit.em.z0 - 0.5, kit.em.layer, kit.em.depth);
  drawParts(kit, streetModel(p).parts, { width: 0.55 });
};
