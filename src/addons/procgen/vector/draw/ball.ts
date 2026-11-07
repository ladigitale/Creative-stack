/**
 * Ballons en vraie illustration vectorielle : silhouette exacte de l'ellipsoïde, régions du motif découpées par
 * l'hémisphère visible (le bord suit la silhouette, pas une corde), coutures visibles, ombre propre et reflet.
 * Même géométrie que le maillage 3D (`gen/ball.ts`).
 */
import type { V3 } from "../../core/math";
import { ballSpec, patternToLocal, toPatternDir } from "../../gen/ball";
import { clipHemisphere, clipPolyline, regionOutlines, type Region } from "../../gen/sphere-pattern";
import { type P2, Pen, hull, strokeVar } from "../shape";
import type { ObjectDrawer } from "./types";

export const drawBall: ObjectDrawer = (kit, p, ctx) => {
  const spec = ballSpec(p);
  const em = kit.em;
  const o = ctx.obj;
  const fr = kit.fr;
  const k = fr.scale;
  kit.castShadow(ctx.env.shadows, (o.footprint.hx / o.scale) * 0.9, (o.footprint.hz / o.scale) * 0.9, spec.height * 0.5, ctx.env.ground, em.z0 - 0.5, em.layer, em.depth, true);
  // monde → repère local de l'objet (inverse du cap)
  const toLocal = (w: V3): V3 => [w[0] * fr.c - w[2] * fr.s, w[1], w[0] * fr.s + w[2] * fr.c];
  const view = toPatternDir(spec, toLocal(kit.pr.dir));
  const light = toPatternDir(spec, toLocal(kit.L));
  const P = (q: V3): P2 => {
    const l = patternToLocal(spec, q);
    return kit.P(l[0], l[1], l[2]);
  };
  // silhouette : enveloppe des points de l'ellipsoïde
  const sil: P2[] = [];
  for (let i = 0; i <= 12; i++) {
    const lat = -Math.PI / 2 + (i / 12) * Math.PI;
    for (let j = 0; j < 28; j++) {
      const a = (j / 28) * Math.PI * 2;
      sil.push(P([Math.cos(lat) * Math.cos(a), Math.sin(lat), Math.cos(lat) * Math.sin(a)]));
    }
  }
  const h = hull(sil);
  if (h.length < 3) return;
  const silPen = () => new Pen().smooth(h, true);
  const baseRole = spec.role(spec.pattern.base);
  em.add(silPen(), baseRole, { tone: 0, stroke: null });
  const fill = (r: Region, role: string, opts: { alpha?: number; kind?: "shadow"; tone?: number } = {}) => {
    for (const out of regionOutlines(r)) {
      const c = clipHemisphere(out, view);
      if (c.length < 3) continue;
      em.add(new Pen().poly(c.map(P)), role, { tone: opts.tone ?? 0, stroke: null, alpha: opts.alpha, kind: opts.kind });
    }
  };
  for (const reg of spec.pattern.regions) fill(reg.r, spec.role(reg.slot));
  // coutures : traits fins, ou bandes à épaisseur réelle (tennis, lacets)
  for (const s of spec.pattern.seams) {
    const role = spec.role(s.slot);
    for (const run of clipPolyline(s.pts, s.closed, view)) {
      const pts = run.map(P);
      const hw = s.w * spec.R * k;
      if (s.w >= 0.018 && hw > 0.004) em.add(strokeVar(new Pen(), pts, pts.map(() => hw), { capStart: !s.closed, capEnd: !s.closed }), role, { tone: s.tone ?? 0, stroke: null, alpha: s.alpha });
      else em.line(new Pen().poly(pts, false), role, s.w >= 0.012 ? 0.6 : 0.4, { tone: s.tone ?? (role === baseRole ? -1 : 0), alpha: s.alpha });
    }
  }
  // ombre propre (côté opposé à la lumière, découpée par la silhouette) et reflet
  const away: V3 = [-light[0], -light[1], -light[2]];
  fill({ k: "cap", c: away, cos: 0.12 }, "shadow", { kind: "shadow", alpha: 0.5 });
  const hv = [light[0] + view[0] * 1.4, light[1] + view[1] * 1.4, light[2] + view[2] * 1.4];
  const hl = Math.hypot(hv[0], hv[1], hv[2]) || 1;
  fill({ k: "cap", c: [hv[0] / hl, hv[1] / hl, hv[2] / hl], cos: Math.cos(0.32) }, "white", { alpha: 0.28, tone: 1 });
  // contour par-dessus (les régions ne le mangent pas)
  if (em.stroke) em.line(silPen(), baseRole, 0.95, { tone: -2 });
};
