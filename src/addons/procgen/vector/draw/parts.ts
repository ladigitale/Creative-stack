/**
 * Dessin vectoriel d'une liste de pièces (`gen/parts.ts`) : les mêmes données que le maillage 3D. Chaque pièce
 * convexe est dessinée d'un bloc ; les pièces sont triées de la plus lointaine à la plus proche (peintre), ce qui
 * suffit pour du mobilier et des objets du quotidien vus en élévation ou en cavalière.
 */
import { type Q, type V3, DEG, qEuler, qRot } from "../../core/math";
import type { Part, PartList } from "../../gen/parts";
import { type P2, Pen, hull, strokeVar } from "../shape";
import type { Kit } from "./kit";
import { readParts } from "../../gen/parts";
import { seatModel } from "../../gen/seat";
import type { ObjectDrawer } from "./types";

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

function center(p: Part): V3 {
  switch (p.t) {
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

/** Dessine les pièces avec la boîte à outils de l'objet. `width` : épaisseur relative des contours. */
export function drawParts(kit: Kit, parts: PartList, o: { width?: number } = {}) {
  const pr = kit.pr, fr = kit.fr, k = fr.scale;
  const W = o.width ?? 0.7;
  const items = parts.map((p, i) => ({ p, d: pr.depth(fr.w(...center(p))) + i * 1e-6 }));
  items.sort((a, b) => a.d - b.d);
  for (const { p } of items) {
    switch (p.t) {
      case "box": {
        const q: Q = p.rot ? qEuler(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG) : [0, 0, 0, 1];
        const axes: V3[] = [qRot(q, [1, 0, 0]), qRot(q, [0, 1, 0]), qRot(q, [0, 0, 1])];
        for (let a = 0; a < 3; a++)
          for (const s of [1, -1]) {
            const n = mul3(axes[a], s);
            if (kit.vis(n) <= 1e-3) continue;
            const u = (a + 1) % 3, v = (a + 2) % 3;
            const fc = add3(p.c, mul3(n, p.h[a]));
            const eu = mul3(axes[u], p.h[u]), ev = mul3(axes[v], p.h[v]);
            const quad: V3[] = [add3(add3(fc, eu), ev), add3(add3(fc, mul3(eu, -1)), ev), add3(add3(fc, mul3(eu, -1)), mul3(ev, -1)), add3(add3(fc, eu), mul3(ev, -1))];
            kit.em.add(new Pen().poly(quad.map((c) => kit.P(c[0], c[1], c[2]))), p.role, { tone: kit.tone(n), width: W });
          }
        break;
      }
      case "rod": {
        const a = kit.P(...p.a), b = kit.P(...p.b);
        kit.em.add(strokeVar(new Pen(), [a, b], [p.r * k, (p.r1 ?? p.r) * k], { capStart: true, capEnd: true }), p.role, { tone: 0, width: W * 0.8 });
        break;
      }
      case "tube": {
        const pts = p.pts.map((c) => kit.P(c[0], c[1], c[2]));
        kit.em.add(strokeVar(new Pen(), pts, pts.map(() => p.r * k), { capStart: true, capEnd: true }), p.role, { tone: 0, width: W * 0.8 });
        break;
      }
      case "lathe":
        kit.sub(p.c[0], p.c[1], p.c[2]).lathe(p.profile, p.role, { width: W });
        break;
      case "blob": {
        const pts: P2[] = [];
        for (let r = -2; r <= 2; r++) {
          const lat = (r / 2.5) * (Math.PI / 2), cy = Math.cos(lat), sy = Math.sin(lat);
          for (let j = 0; j < 14; j++) {
            const lo = (j / 14) * Math.PI * 2;
            pts.push(kit.P(p.c[0] + p.r[0] * cy * Math.cos(lo), p.c[1] + p.r[1] * sy, p.c[2] + p.r[2] * cy * Math.sin(lo)));
          }
        }
        pts.push(kit.P(p.c[0], p.c[1] + p.r[1], p.c[2]), kit.P(p.c[0], p.c[1] - p.r[1], p.c[2]));
        const h = hull(pts);
        if (h.length < 3) break;
        kit.em.add(new Pen().smooth(h, true), p.role, { tone: 0, width: W });
        // reflet doux côté lumière
        const [cu, cv] = kit.P(...p.c);
        const lx = kit.L[0] <= 0 ? -1 : 1;
        kit.em.add(new Pen().ellipse(cu + lx * p.r[0] * k * 0.35, cv + p.r[1] * k * 0.35, p.r[0] * k * 0.35, p.r[1] * k * 0.3), p.role, { tone: 1, stroke: null, alpha: 0.7 });
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
