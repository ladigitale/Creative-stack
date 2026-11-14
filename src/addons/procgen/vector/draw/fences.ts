/**
 * Clôtures (`wall`, le long de ses points) et véhicules (`vehicle`) en élévation.
 *
 * Clôtures : chaque tronçon est une face verticale qui suit le terrain (affine cisaillée) et reçoit sa propre clé
 * d'ordre (un enclos ne passe pas devant ce qu'il entoure). Murets de pierre sèche à assises et couronnement,
 * murs enduits à chaperon et piliers, barrières à lisses, palissades, haies taillées festonnées, grilles sur mur
 * bahut, clôtures de bambou ; brèches.
 * Véhicules : carrosse, bicyclette, voiture ancienne, barque, voilier, montgolfière, charrette à bras, de profil
 * (axe avant +z), roues à rayons, reflets dans l'eau pour les bateaux.
 */
import type { V3 } from "../../core/math";
import { Rng } from "../../core/rng";
import { type Affine, type P2, Pen, compose, scallop, strokeVar } from "../shape";
import type { Kit } from "./kit";
import type { ObjectDrawer } from "./types";
import { PART_VEHICLES, vehiclePartsModel } from "../../gen/vehicle-parts";
import { drawParts } from "./parts";

const DEFAULT_H: Record<string, number> = { drystone: 0.85, coping: 1.0, fence: 1.1, picket: 1.0, hedge: 1.4, railing: 1.5, bamboo: 1.6 };

export const drawWall: ObjectDrawer = (kit, p, ctx) => {
  const kind = String(p.kind ?? "drystone");
  const H = Number(p.height ?? 0) > 0 ? Number(p.height) : DEFAULT_H[kind] ?? 1;
  const pts = (Array.isArray(p.points) && (p.points as unknown[]).length >= 2 ? (p.points as [number, number][]) : [[-5, 0], [5, 0]]).map((q) => [Number(q[0]) || 0, Number(q[1]) || 0] as [number, number]);
  if (p.closed) pts.push(pts[0]);
  const em = kit.em;
  const o = ctx.obj;
  const g = (x: number, z: number) => {
    const w = kit.fr.w(x, 0, z);
    return (ctx.env.ground(w[0], w[2]) - o.pos[1]) / o.scale;
  };
  const halfW = kind === "hedge" ? 0.45 : kind === "drystone" ? 0.28 : kind === "coping" ? 0.22 : 0.1;
  const rng = new Rng(`wall/${o.id}`);
  const z0 = em.z0;
  // tronçons du fond vers l'avant, chacun à sa profondeur
  const segs = pts.slice(0, -1).map((a, i) => ({ a, b: pts[i + 1], i })).filter((s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > 0.05);
  const depth = (x: number, z: number) => kit.pr.key(kit.fr.w(x, 0, z));
  segs.sort((s, t) => Math.max(depth(...s.a), depth(...s.b)) - Math.max(depth(...t.a), depth(...t.b)));
  for (const s of segs) {
    const [x0, zz0] = s.a, [x1, zz1] = s.b;
    const L = Math.hypot(x1 - x0, zz1 - zz0);
    const ux = (x1 - x0) / L, uz = (zz1 - zz0) / L;
    // normale côté observateur
    let nx = -uz, nz = ux;
    if (kit.vis([nx, 0, nz]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    em.z0 = Math.max(depth(x0 + nx * halfW, zz0 + nz * halfW), depth(x1 + nx * halfW, zz1 + nz * halfW));
    const g0 = g(x0, zz0), g1 = g(x1, zz1);
    // face avant : origine au pied du début, u le long (pente du terrain), v vertical ; affichée côté observateur
    const flip = kit.vis([nx, 0, nz]) >= 0 && kit.pr.vec(kit.fr.dir(ux, 0, uz))[0] < 0;
    const A: V3 = [x0 + nx * halfW, g0, zz0 + nz * halfW];
    const m0 = kit.face(A, [ux, (g1 - g0) / L, uz], [0, 1, 0]);
    const m: Affine = flip ? compose(m0, [-1, 0, 0, 1, L, 0]) : m0;
    const tone = kit.tone([nx, 0, nz]);
    const gap = L > 4 && rng.chance(Number(p.gaps ?? 0.1)) ? rng.range(1, L - 2.2) : -10;
    const inGap = (u: number) => u > gap && u < gap + 1.2;
    const top = (y: number) => {
      // dessus (épaisseur) visible d'en haut
      const q = [kit.P(x0 + nx * halfW, g0 + y, zz0 + nz * halfW), kit.P(x1 + nx * halfW, g1 + y, zz1 + nz * halfW), kit.P(x1 - nx * halfW, g1 + y, zz1 - nz * halfW), kit.P(x0 - nx * halfW, g0 + y, zz0 - nz * halfW)];
      return new Pen().poly(q);
    };
    switch (kind) {
      case "drystone": {
        em.add(top(H - 0.06), "stone", { tone: 1 });
        em.add(new Pen(m).rect(0, 0, L, H - 0.06), "stone", { tone });
        const st = new Pen(m), lt = new Pen(m), dk = new Pen(m);
        const courses = Math.max(2, Math.round(H / 0.2));
        const ch = (H - 0.12) / courses;
        for (let c = 0; c < courses; c++) {
          let u = (c % 2) * 0.15;
          while (u < L) {
            const w = rng.range(0.2, 0.42);
            const uu = Math.min(L, u + w);
            if (!(inGap(u) && c > courses * 0.4)) {
              const r = rng.next();
              (r < 0.18 ? lt : r < 0.32 ? dk : st).rrect(u + 0.015, c * ch + 0.015, uu - u - 0.03, ch - 0.03, 0.05);
            }
            u = uu;
          }
        }
        em.add(st, "stone", { tone, width: 0.35 });
        em.add(lt, "stone", { tone: tone + 1, width: 0.35 });
        em.add(dk, "stone", { tone: tone - 1, width: 0.35 });
        const cap = new Pen(m);
        for (let u = 0.08; u < L; u += 0.24) if (!inGap(u)) cap.rrect(u - 0.07 + rng.range(-0.02, 0.02), H - 0.12, 0.14, 0.24, 0.04);
        em.add(cap, "stone", { tone: tone + 1, width: 0.35 });
        const moss = new Pen(m);
        for (let k = 0; k < Math.round(L / 2); k++) scallop(moss, rng.range(0.3, L - 0.3), rng.range(0.02, 0.1), rng.range(0.15, 0.3), 0.07, k + 1.3, 5, 0.03, 0.6);
        em.add(moss, "leaf2", { tone: 0, stroke: null });
        break;
      }
      case "coping": {
        em.add(top(H + 0.05), "trim", { tone: 1 });
        em.add(new Pen(m).rect(0, 0, L, H), "wall", { tone });
        em.add(new Pen(m).rect(0, 0, L, 0.24), "stone", { tone: tone - 1, width: 0.5 });
        em.add(new Pen(m).M(-0.05, H - 0.12).L(L + 0.05, H - 0.12).L(L + 0.05, H - 0.02).L(L / 2, H + 0.08).L(-0.05, H - 0.02).Z(), "trim", { tone: tone + 1, width: 0.5 });
        const patch = new Pen(m);
        for (let k = 0; k < Math.round(L / 3); k++) patch.rrect(rng.range(0.3, L - 0.6), rng.range(0.3, H - 0.4), rng.range(0.25, 0.5), rng.range(0.12, 0.22), 0.06);
        em.add(patch, "stone", { tone: tone - 1, width: 0.3 });
        const n = Math.max(1, Math.round(L / 4));
        for (let k = 0; k <= n; k++) {
          const u = (k * L) / n;
          em.add(new Pen(m).rect(u - 0.2, 0, 0.4, H + 0.24), "wall", { tone: tone + 0, width: 0.55 });
          em.add(new Pen(m).rect(u - 0.26, H + 0.22, 0.52, 0.1), "trim", { tone: tone + 1, width: 0.45 });
          if (k % 2 === 0) em.add(new Pen(m).ellipse(u, H + 0.42, 0.11, 0.11), "trim", { tone: tone + 1, width: 0.4 });
        }
        break;
      }
      case "fence":
      case "picket":
      case "bamboo": {
        if (kind === "picket") {
          const pk = new Pen(m);
          for (let u = 0.07; u < L; u += 0.14) {
            if (inGap(u)) continue;
            const h = H * rng.range(0.95, 1.02);
            pk.M(u - 0.045, 0).L(u + 0.045, 0).L(u + 0.045, h - 0.07).L(u, h).L(u - 0.045, h - 0.07).Z();
          }
          em.add(new Pen(m).rect(0, H * 0.25 - 0.03, L, 0.06).rect(0, H * 0.7 - 0.03, L, 0.06), "paper", { tone: tone - 1, width: 0.4 });
          em.add(pk, "paper", { tone, width: 0.4 });
        } else if (kind === "bamboo") {
          const cn = new Pen(m), cn2 = new Pen(m), nodes = new Pen(m);
          for (let u = 0.03, i = 0; u < L; u += 0.065, i++) {
            (i % 3 ? cn : cn2).rect(u - 0.028, 0, 0.056, H - 0.05);
            for (let y = 0.35 + (i % 2) * 0.15; y < H - 0.1; y += 0.42) nodes.M(u - 0.028, y).L(u + 0.028, y);
          }
          em.add(cn, "path", { tone, width: 0.3 });
          em.add(cn2, "leaf2", { tone, width: 0.3 });
          em.line(nodes, "path", 0.4, { tone: tone - 2 });
          em.add(new Pen(m).rect(0, H * 0.3 - 0.03, L, 0.06).rect(0, H * 0.65 - 0.03, L, 0.06).rect(0, H * 0.95 - 0.03, L, 0.06), "bark", { tone: tone - 1, width: 0.4 });
        } else {
          const rails = new Pen(m);
          for (const y of [0.38, 0.85]) rails.M(0, y * H - 0.035).Q(L / 2, y * H - 0.035 - 0.04, L, y * H - 0.035).L(L, y * H + 0.035).Q(L / 2, y * H + 0.035 - 0.04, 0, y * H + 0.035).Z();
          em.add(rails, "wood", { tone, width: 0.45 });
          const posts = new Pen(m);
          const n = Math.max(1, Math.round(L / 2));
          for (let k = 0; k <= n; k++) {
            const u = (k * L) / n;
            if (inGap(u) && rng.chance(0.5)) continue;
            const lean = rng.range(-0.06, 0.06) * H;
            posts.M(u - 0.05, 0).L(u + 0.05, 0).L(u + 0.05 + lean, H + 0.05).L(u + lean, H + 0.12).L(u - 0.05 + lean, H + 0.05).Z();
          }
          em.add(posts, "wood", { tone: tone - 1, width: 0.5 });
        }
        break;
      }
      case "railing": {
        em.add(top(0.64), "trim", { tone: 1 });
        em.add(new Pen(m).rect(0, 0, L, 0.6), "stone", { tone, width: 0.55 });
        em.add(new Pen(m).rect(-0.03, 0.58, L + 0.06, 0.08), "trim", { tone: tone + 1, width: 0.45 });
        const bars = new Pen(m);
        for (let u = 0.06; u < L; u += 0.12) bars.rect(u - 0.012, 0.66, 0.024, H - 0.66).M(u - 0.03, H).L(u + 0.03, H).L(u, H + 0.1).Z();
        bars.rect(0, 0.74, L, 0.035).rect(0, H - 0.16, L, 0.035);
        em.add(bars, "metal", { tone: tone - 1, stroke: null });
        const n = Math.max(1, Math.round(L / 3.5));
        for (let k = 0; k <= n; k++) {
          const u = (k * L) / n;
          em.add(new Pen(m).rect(u - 0.16, 0, 0.32, H + 0.2), "stone", { tone, width: 0.5 });
          em.add(new Pen(m).rect(u - 0.2, H + 0.18, 0.4, 0.1), "trim", { tone: tone + 1, width: 0.4 });
        }
        break;
      }
      case "hedge": {
        // haie taillée : dessus plat légèrement bosselé, flancs festonnés, deux tons, quelques trouées
        em.add(top(H * 0.97), "leaf", { tone: 1 });
        const body = new Pen(m).M(0, 0).L(L, 0).L(L + 0.06, H * 0.5);
        const n = Math.max(3, Math.round(L / 0.35));
        for (let k = n; k > 0; k--) {
          const u0 = (k * L) / n, u1 = ((k - 1) * L) / n;
          body.Q((u0 + u1) / 2, H + 0.07 + rng.range(-0.02, 0.04), u1, H * 0.98);
        }
        body.L(-0.06, H * 0.5).Z();
        em.add(body, "leaf", { tone });
        const tufts = new Pen(m);
        for (let k = 0; k < Math.round(L * 2.2); k++) scallop(tufts, rng.range(0.1, L - 0.1), rng.range(0.2, H - 0.25), rng.range(0.12, 0.22), rng.range(0.08, 0.15), k * 1.7, 6, 0.03, 0);
        em.add(tufts, "leaf2", { tone: tone + 1, stroke: null, alpha: 0.85 });
        const shade = new Pen(m).M(0, 0).L(L, 0).L(L, H * 0.22).Q(L / 2, H * 0.3, 0, H * 0.22).Z();
        em.add(shade, "leaf", { tone: tone - 1, stroke: null });
        break;
      }
    }
  }
  em.z0 = z0;
};

/* ------------------------------------------------------------------ véhicules */

/** Affine d'élévation le long de l'axe local z (avant du véhicule), raccourci au plus à 45 %. */
function zElev(kit: Kit): { m: Affine; k: number } {
  const az = kit.pr.vec(kit.fr.dir(0, 0, 1));
  let ku = az[0];
  if (Math.abs(ku) < 0.45) ku = 0.45 * (ku < 0 ? -1 : 1);
  const [u, v] = kit.P(0, 0, 0);
  const s = kit.fr.scale;
  return { m: [ku * s, az[1] * s * 0.3, 0, s, u, v], k: Math.abs(az[0]) };
}

function wheel(kit: Kit, m: Affine, x: number, r: number, spokes: number, rim: string, hub: string, tone = 0) {
  const em = kit.em;
  em.add(new Pen(m).ellipse(x, r, r, r), rim, { tone: tone - 1, width: 0.7 });
  em.add(new Pen(m).ellipse(x, r, r * 0.86, r * 0.86), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
  const sp = new Pen(m);
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2 + 0.2;
    strokeVar(sp, [[x, r], [x + Math.cos(a) * r * 0.86, r + Math.sin(a) * r * 0.86]], [r * 0.045, r * 0.03], { capEnd: false });
  }
  em.add(sp, hub, { tone, stroke: null });
  em.add(new Pen(m).ellipse(x, r, r * 0.16, r * 0.16), hub, { tone: tone + 1, width: 0.45 });
}

export const drawVehicle: ObjectDrawer = (kit, p, ctx) => {
  const kind = String(p.kind ?? "car");
  const variant = Math.max(0, Number(p.variant ?? 0));
  const autoPaint = ["accent", "leaf2", "water", "cloth2", "cloth1", "ink", "paper", "wood"][variant % 8];
  const P = String(p.paint ?? "auto") === "auto" ? autoPaint : String(p.paint);
  const em = kit.em;
  const o = ctx.obj;
  const { m } = zElev(kit);
  const t = ctx.env.time;
  const water = kind === "rowboat" || kind === "sailboat";
  if (!water && kind !== "balloon") kit.castShadow(ctx.env.shadows, o.footprint.hx / o.scale, o.footprint.hz / o.scale, 0.6, ctx.env.ground, em.z0 - 0.5, em.layer, em.depth);
  if ((PART_VEHICLES as readonly string[]).includes(kind)) {
    drawParts(kit, vehiclePartsModel(p), { width: 0.55 });
    return;
  }
  switch (kind) {
    case "carriage": {
      wheel(kit, m, -0.85, 0.6, 12, "wood", "wood", -1);
      em.add(new Pen(m).rect(-1.1, 0.72, 2.2, 0.08), "wood", { tone: -1, width: 0.5 });
      const body = new Pen(m).M(-0.95, 0.85).C(-1.05, 1.3, -1.0, 1.85, -0.75, 1.95).L(0.4, 1.95).C(0.65, 1.85, 0.7, 1.3, 0.55, 0.85).Z();
      em.add(body, P, { tone: 0 });
      em.add(new Pen(m).rect(-0.95, 1.95, 1.4, 0.1), "ink", { width: 0.5 });
      em.add(new Pen(m).rect(-0.85, 2.05, 1.2, 0.08), "metal", { tone: 1, width: 0.4 });
      em.add(new Pen(m).rrect(-0.5, 1.35, 0.55, 0.45, 0.06), "glass", { tone: -1, width: 0.5 });
      em.add(new Pen(m).rect(-0.62, 0.95, 0.04, 1.0).rect(0.12, 0.95, 0.04, 1.0), "metal", { tone: 1, stroke: null });
      em.add(new Pen(m).M(-0.85, 1.15).L(0.5, 1.15), "none", { stroke: P === "accent" ? "paper" : "accent", width: 1, kind: "line" });
      // siège du cocher, lanterne, brancards
      em.add(new Pen(m).rect(0.65, 1.3, 0.35, 0.08).rect(0.95, 1.3, 0.05, 0.3), P, { tone: -1, width: 0.45 });
      em.add(new Pen(m).rrect(0.7, 1.4, 0.1, 0.14, 0.03), "lamp", { kind: ctx.env.night > 0.2 ? "glow" : "fill", width: 0.4 });
      em.add(strokeVar(new Pen(m), [[0.6, 0.78], [1.4, 0.72], [2.3, 0.7]], [0.03, 0.03, 0.025]), "wood", { width: 0.5 });
      em.add(new Pen(m).M(-0.9, 0.85).Q(-1.0, 1.1, -0.75, 1.0), "none", { stroke: "metal", width: 1, kind: "line" });
      wheel(kit, m, 0.9, 0.42, 10, "wood", "wood");
      wheel(kit, m, -0.85, 0.6, 12, "wood", "wood");
      break;
    }
    case "bicycle": {
      const fr = ["accent", "leaf2", "ink", "water"][variant % 4];
      wheel(kit, m, -0.52, 0.34, 12, "ink", "metal");
      wheel(kit, m, 0.52, 0.34, 12, "ink", "metal");
      const bb: P2 = [-0.05, 0.32], seat: P2 = [-0.22, 0.82], head: P2 = [0.38, 0.8];
      const f = new Pen(m);
      for (const [a, b] of [[bb, seat], [bb, head], [seat, head], [bb, [-0.52, 0.34]], [seat, [-0.52, 0.34]], [head, [0.52, 0.34]]] as [P2, P2][]) strokeVar(f, [a, b], [0.022, 0.022]);
      em.add(f, fr, { tone: 0, width: 0.4 });
      em.add(new Pen(m).rrect(-0.32, 0.83, 0.22, 0.06, 0.03), "leather", { width: 0.4 });
      em.add(strokeVar(new Pen(m), [head, [0.36, 0.92], [0.28, 0.95]], [0.015, 0.015, 0.015]), "metal", { width: 0.4 });
      em.add(new Pen(m).ellipse(-0.05, 0.32, 0.07, 0.07), "metal", { width: 0.4 });
      if (variant % 2) em.add(new Pen(m).M(0.42, 0.78).L(0.66, 0.78).L(0.62, 0.98).L(0.46, 0.98).Z(), "path", { width: 0.45 });
      break;
    }
    case "car": {
      wheel(kit, m, -1.15, 0.34, 12, "ink", "paper", -1);
      const body = new Pen(m).M(-1.75, 0.45).L(-1.8, 0.82).L(-0.6, 0.86).L(-0.5, 0.86).L(0.35, 0.86).L(1.6, 0.98).L(1.65, 0.62).L(1.75, 0.5).Z();
      em.add(body, P, { tone: 0 });
      // ailes galbées
      const wing = new Pen(m);
      for (const x of [-1.15, 1.05]) wing.M(x - 0.48, 0.5).C(x - 0.45, 0.95, x + 0.45, 0.95, x + 0.48, 0.5).L(x + 0.38, 0.52).C(x + 0.3, 0.82, x - 0.3, 0.82, x - 0.38, 0.52).Z();
      em.add(wing, P, { tone: -1, width: 0.5 });
      em.add(new Pen(m).M(-1.25, 0.86).C(-1.2, 1.35, -0.5, 1.38, -0.35, 1.3).L(-0.3, 0.86).Z(), Number(variant) % 2 ? "ink" : "cloth3", { tone: 0, width: 0.55 });
      em.add(new Pen(m).M(0.2, 0.86).L(0.38, 1.25).L(0.44, 1.25).L(0.27, 0.86).Z(), "glass", { tone: 1, width: 0.45 });
      em.add(new Pen(m).rrect(-0.6, 0.9, 0.5, 0.18, 0.05), "leather", { width: 0.4 });
      em.add(new Pen(m).rect(1.58, 0.58, 0.08, 0.42), "metal", { tone: 1, width: 0.45 });
      em.add(new Pen(m).ellipse(1.55, 1.0, 0.09, 0.09), "lamp", { kind: ctx.env.night > 0.2 ? "glow" : "fill", width: 0.4 });
      em.add(new Pen(m).rect(-0.5, 0.42, 1.1, 0.05), "ink", { stroke: null });
      em.add(new Pen(m).M(-1.6, 0.7).L(1.5, 0.78), "none", { stroke: P === "accent" ? "paper" : "accent", width: 0.8, kind: "line" });
      wheel(kit, m, -1.15, 0.34, 12, "ink", "paper");
      wheel(kit, m, 1.05, 0.34, 12, "ink", "paper");
      break;
    }
    case "rowboat":
    case "sailboat": {
      const sail = kind === "sailboat";
      const L = sail ? 2.6 : 1.7, hb = sail ? 0.55 : 0.5;
      const hullFill = sail ? (P === "ink" || P === "wood" ? "paper" : P) : P === "ink" ? "wood" : P;
      em.add(new Pen(m).M(-L * 0.95, 0.12).Q(0, -0.45, L * 0.95, 0.12).Z(), "water", { tone: -1, stroke: null, alpha: 0.6 });
      const hull = new Pen(m).M(-L * 0.92, hb + 0.06).L(L * 1.05, hb + 0.2).Q(L * 0.95, sail ? -0.2 : 0.05, L * 0.4, sail ? -0.22 : 0.02).L(-L * 0.6, sail ? -0.12 : 0.02).Q(-L * 0.95, 0.1, -L * 0.92, hb + 0.06).Z();
      em.add(hull, hullFill, { tone: 0 });
      const pl = new Pen(m);
      for (const y of [0.18, 0.34]) pl.M(-L * 0.85, y + 0.02).Q(0, y - 0.06, L * 0.95, y + 0.08);
      em.line(pl, hullFill, 0.45, { tone: -1 });
      em.add(new Pen(m).M(-L * 0.92, hb + 0.06).L(L * 1.05, hb + 0.2).L(L * 1.02, hb + 0.12).L(-L * 0.9, hb - 0.02).Z(), sail ? "wood" : variant % 2 ? "accent" : "paper", { tone: 0, width: 0.45 });
      em.add(new Pen(m).M(-L * 0.6, 0.02).Q(0, -0.04, L * 0.4, 0.02).L(L * 0.3, 0.14).Q(0, 0.1, -L * 0.5, 0.14).Z(), hullFill, { tone: -1, stroke: null });
      if (sail) {
        em.add(new Pen(m).rect(-0.6, hb + 0.05, 0.9, 0.3), "paper", { tone: 0, width: 0.45 });
        em.add(new Pen(m).rect(-0.45, hb + 0.15, 0.12, 0.08).rect(-0.1, hb + 0.15, 0.12, 0.08), "glass", { stroke: null });
        const sway = Math.sin(t * 0.8 + variant) * 0.05;
        em.add(strokeVar(new Pen(m), [[0.35, hb], [0.35 + sway, 5.5]], [0.04, 0.03]), "wood", { width: 0.45 });
        em.add(new Pen(m).M(0.3 + sway, 5.6).Q(-0.6, 3.4, 0.28, 1.25).L(-0.95, 1.25).Q(-0.3, 3.0, 0.3 + sway, 5.6).Z(), "paper", { tone: 1, width: 0.55 });
        em.add(new Pen(m).M(0.42 + sway, 5.35).L(2.3, 0.7).Q(1.2, 2.2, 0.42, 0.65).Z(), variant % 2 ? "paper" : "cloth3", { tone: 0, width: 0.55 });
        em.add(strokeVar(new Pen(m), [[-0.95, 1.25], [0.35, 1.25]], [0.03, 0.03]), "wood", { stroke: null });
        em.add(new Pen(m).M(0.35 + sway, 5.9).L(0.8 + sway, 5.82).L(0.35 + sway, 5.7).Z(), "accent", { width: 0.4 });
      } else {
        em.add(strokeVar(new Pen(m), [[-0.2, hb], [-0.9, 0.12], [-1.35, -0.05]], [0.02, 0.02, 0.02]), "wood", { width: 0.4 });
        em.add(new Pen(m).rect(-0.2, hb - 0.06, 0.3, 0.06).rect(0.6, hb - 0.04, 0.3, 0.06), "wood", { tone: -1, stroke: null });
      }
      const w = new Pen(m);
      for (let k = 0; k < 3; k++) {
        const x = -L * 1.2 + k * L * 1.1 + Math.sin(t * 1.3 + k) * 0.1;
        w.M(x, 0.02).Q(x + 0.25, 0.07, x + 0.5, 0.02);
      }
      em.line(w, "water", 0.6, { tone: 2 });
      break;
    }
    case "balloon": {
      const R = 3 * Number(p.size ?? 1);
      const bm = kit.board(0, 0, 0);
      const s = (r: number, y: number): P2 => [(r / 3) * R, 2.6 + (y / 3) * R];
      const prof: [number, number][] = [[0.55, 0], [1.4, 0.9], [2.6, 2.4], [3.0, 3.6], [2.7, 4.8], [1.8, 5.6], [0, 6.0]];
      const right = prof.map(([r, y]) => s(r, y)), left = prof.map(([r, y]) => s(-r, y)).reverse();
      em.add(new Pen(bm).smooth([...right, ...left.slice(1, -1)], true), P, { tone: 0 });
      // fuseaux alternés
      const gores = new Pen(bm);
      for (let k = -3; k <= 3; k += 2) {
        const f0 = Math.sin((k * Math.PI) / 8), f1 = Math.sin(((k + 1) * Math.PI) / 8);
        const a = prof.map(([r, y]) => s(r * f0, y)), b = prof.map(([r, y]) => s(r * f1, y)).reverse();
        gores.smooth([...a, ...b], true);
      }
      em.add(gores, P === "paper" ? "accent" : "paper", { tone: 0, stroke: null });
      const lx = kit.L[0] < 0 ? 1 : -1;
      em.add(new Pen(bm).smooth(prof.map(([r, y]) => s(lx * r, y)).concat(prof.map(([r, y]) => s(lx * r * 0.55, y)).reverse()), true), P, { tone: -1, stroke: null, alpha: 0.45 });
      const ropes = new Pen(bm);
      for (const sx of [-1, -0.35, 0.35, 1]) ropes.M(sx * 0.42, 0.72).L(sx * 0.55 * (R / 3) * 1.2, 2.6);
      em.line(ropes, "ink", 0.5);
      em.add(new Pen(bm).M(-0.45, 0.72).L(0.45, 0.72).L(0.42, 0).L(-0.42, 0).Z(), "path", { tone: 0, width: 0.55 });
      const weave = new Pen(bm);
      for (let y = 0.12; y < 0.7; y += 0.12) weave.M(-0.43, y).L(0.43, y);
      em.line(weave, "path", 0.4, { tone: -1 });
      em.add(new Pen(bm).rect(-0.48, 0.68, 0.96, 0.08), "leather", { width: 0.45 });
      em.add(new Pen(bm).M(-0.08, 1.75).Q(0, 2.3 + Math.sin(t * 9) * 0.05, 0.08, 1.75).Z(), "fire", { kind: "glow", stroke: null });
      break;
    }
    case "handcart": {
      wheel(kit, m, -0.1, 0.45, 8, "wood", "wood", -1);
      em.add(new Pen(m).rect(-0.75, 0.53, 1.5, 0.06), "wood", { tone: 0, width: 0.5 });
      const sides = new Pen(m);
      for (const y of [0.66, 0.78]) sides.rect(-0.75, y, 1.5, 0.05);
      for (const z of [-0.6, 0, 0.6]) sides.rect(z - 0.02, 0.59, 0.04, 0.24);
      em.add(sides, "wood", { tone: 0, width: 0.4 });
      const load = new Pen(m);
      for (let k = 0; k < 3; k++) load.M(-0.6 + k * 0.4, 0.62).Q(-0.62 + k * 0.4, 0.98, -0.4 + k * 0.4, 0.98).Q(-0.2 + k * 0.4, 0.98, -0.22 + k * 0.4, 0.62).Z();
      em.add(load, "cloth3", { tone: 0, width: 0.45 });
      em.add(strokeVar(new Pen(m), [[0.75, 0.55], [1.9, 0.5]], [0.025, 0.02]), "wood", { width: 0.45 });
      wheel(kit, m, -0.1, 0.45, 8, "wood", "wood");
      break;
    }
    default: {
      const hx = o.footprint.hx / o.scale, hz = o.footprint.hz / o.scale, h = o.height / o.scale;
      kit.box(-hx, 0.2, -hz, hx, h, hz, P, {});
    }
  }
};

export type { Kit };
