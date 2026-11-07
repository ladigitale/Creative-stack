/**
 * Bâtiments en élévation / cavalière, d'après le **plan** du générateur `building` (mêmes tirages par graine : allure,
 * travées inégales, étages, soubassement, porte décentrée, toit, annexes). Chaque face plane est dessinée dans son
 * repère local puis projetée par une affine.
 *
 * Façades : soubassement appareillé, enduit à taches, pierre en assises, brique, bardage, colombages, shoji, béton ;
 * chaînes d'angle harpées, bandeaux, corniche à modillons, génoise ; baies rectangulaires, plein cintre,
 * segmentaires, à meneaux, ogives, shoji, larges ; tableau ombré, petits bois, appuis, clés, volets pleins ou
 * persiennes (usure), jardinières, balcons à barreaux, porte à panneaux et imposte, vitrine à store rayé et enseigne.
 * Toits : deux pans (faîtage parallèle ou pignon sur rue), coyaux, croupe, mansarde à lucarnes, pavillon japonais à
 * courbure, monopente, terrasse ; tuile (plate ou canal), ardoise, chaume, zinc, lauze, kawara. Annexes : grange,
 * aile, appentis, tourelles en poivrière, porche, escalier extérieur. Édifices singuliers : moulin à ailes, phare
 * rayé, tour ou donjon (créneaux, mâchicoulis, poivrière), chapelle à clocher et flèche.
 */
import type { V3 } from "../../core/math";
import { Rng } from "../../core/rng";
import { type Annex, type Look, type Plan, type WinKind, buildPlan } from "../buildplan";
import { type Affine, type P2, Pen, compose, scallop, strokeVar, translate } from "../shape";
import type { Kit } from "./kit";
import type { ObjectDrawer } from "./types";

type Ctx = { kit: Kit; plan: Plan; look: Look; rng: Rng; night: number; time: number; decay: number; shutters: number; balconies: number };

export const drawBuilding: ObjectDrawer = (kit0, p, ctx) => {
  const o = ctx.obj;
  const plan = ctx.plan ?? buildPlan(p, new Rng(o.id));
  // recentrage : l'ancre `roof` vaut (−cx, faîte, −cz) dans le repère de l'objet
  const rw = o.anchors.roof;
  let off: V3 = [0, 0, 0];
  if (rw) {
    const dx = (rw[0] - o.pos[0]) / o.scale, dz = (rw[2] - o.pos[2]) / o.scale;
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    off = [dx * c - dz * s, 0, dx * s + dz * c];
  }
  kit0.castShadow(ctx.env.shadows, o.footprint.hx / o.scale, o.footprint.hz / o.scale, (o.height / o.scale) * 0.85, ctx.env.ground, kit0.em.z0 - 0.5, kit0.em.layer, kit0.em.depth);
  const kit = kit0.sub(off[0], 0, off[2]);
  const c: Ctx = { kit, plan, look: plan.look, rng: ctx.rng, night: ctx.env.night, time: ctx.env.time, decay: Number(p.decay ?? 0.1), shutters: Number(p.shutters ?? 0.6), balconies: Number(p.balconies ?? 0.2) };
  if (plan.singular) return singular(c);
  const vols: { depth: number; draw: () => void }[] = [];
  const depthOf = (x: number, z: number) => kit.pr.depth(kit.fr.w(x, 0, z));
  vols.push({ depth: depthOf(0, plan.D / 2), draw: () => mainBody(c) });
  for (const a of plan.annexes) {
    if (a.kind === "barn" || a.kind === "wing") vols.push({ depth: depthOf(a.cx, a.cz + a.d / 2) - 0.01, draw: () => annexBody(c, a) });
    else if (a.kind === "shed") vols.push({ depth: depthOf(a.cx, a.cz + a.d / 2) - 0.02, draw: () => shed(c, a) });
    else if (a.kind === "turret") vols.push({ depth: depthOf(a.cx, a.cz + a.r) + 0.01, draw: () => turret(c, a) });
    else if (a.kind === "porch") vols.push({ depth: depthOf(a.u, plan.D / 2 + 1.6), draw: () => porch(c, a) });
    else if (a.kind === "stairs") vols.push({ depth: depthOf(0, plan.D / 2 + 1), draw: () => stairs(c, a.side) });
  }
  if (plan.st === "chapelle") vols.push({ depth: depthOf(0, -plan.D / 2 + 2), draw: () => belfry(c) });
  vols.sort((a, b) => a.depth - b.depth);
  for (const v of vols) v.draw();
};

/* ------------------------------------------------------------------ corps */

type Box = { cx: number; cz: number; w: number; d: number; fhs: number[]; plinth: number };

function faces(b: Box) {
  return [
    { n: [0, 0, 1] as V3, o: [b.cx, 0, b.cz + b.d / 2] as V3, u: [1, 0, 0] as V3, half: b.w / 2, kind: "front" as const },
    { n: [0, 0, -1] as V3, o: [b.cx, 0, b.cz - b.d / 2] as V3, u: [-1, 0, 0] as V3, half: b.w / 2, kind: "back" as const },
    { n: [1, 0, 0] as V3, o: [b.cx + b.w / 2, 0, b.cz] as V3, u: [0, 0, -1] as V3, half: b.d / 2, kind: "side" as const },
    { n: [-1, 0, 0] as V3, o: [b.cx - b.w / 2, 0, b.cz] as V3, u: [0, 0, 1] as V3, half: b.d / 2, kind: "side" as const },
  ];
}

function mainBody(c: Ctx) {
  const { kit, plan } = c;
  const b: Box = { cx: 0, cz: 0, w: plan.W, d: plan.D, fhs: plan.fhs, plinth: plan.plinth };
  const lean = plan.st === "bourg" || plan.st === "colombages" || plan.st === "chaumiere" ? c.rng.range(-1, 1) * (0.006 + c.decay * 0.012) : 0;
  for (const f of faces(b)) {
    if (kit.vis(f.n) <= 1e-3) continue;
    const m0 = kit.face(f.o, f.u, [0, 1, 0]);
    const m: Affine = lean ? compose(m0, [1, 0, lean, 1, 0, 0]) : m0;
    const tone = kit.tone(f.n);
    const gableHere = plan.roof === "gable" && (plan.ridgeZ ? f.kind !== "side" : f.kind === "side");
    const shedSide = plan.roof === "shed" && (plan.ridgeZ ? f.kind !== "side" : f.kind === "side");
    wall(c, m, f.half, b, tone, gableHere, shedSide ? (f.kind === "back" || f.n[0] < 0 ? -1 : 1) : 0);
    if (f.kind === "front" || f.kind === "back") openings(c, m, f.kind === "front", tone);
    else sideOpenings(c, m, f.half, tone, f.n[0]);
    if (gableHere) gableDetail(c, m, f.half, tone, f.kind === "front");
  }
  roof(c, b, true);
}

function annexBody(c: Ctx, a: Extract<Annex, { kind: "barn" | "wing" }>) {
  const { kit, plan } = c;
  const barn = a.kind === "barn";
  const look: Look = barn ? { ...c.look, finish: "bardage", wall: "wood", quoins: false, modillons: false } : c.look;
  const cc: Ctx = { ...c, look };
  const fhs = Array.from({ length: a.floors }, () => a.fh);
  const b: Box = { cx: a.cx, cz: a.cz, w: a.w, d: a.d, fhs, plinth: plan.plinth };
  const top = b.plinth + fhs.reduce((s, h) => s + h, 0);
  for (const f of faces(b)) {
    if (kit.vis(f.n) <= 1e-3) continue;
    const m = kit.face(f.o, f.u, [0, 1, 0]);
    const tone = kit.tone(f.n);
    const gableHere = f.kind !== "side";
    wall(cc, m, f.half, b, tone, gableHere, 0);
    if (f.kind === "front") {
      if (barn) {
        const dw = Math.min(a.w - 1.2, 3.2), dh = Math.min(top - b.plinth - 0.6, 3.1);
        const y0 = b.plinth;
        kit.em.add(new Pen(m).rect(-dw / 2, y0, dw, dh), "wood", { tone: tone - 1 });
        const br = new Pen(m);
        for (const sx of [-1, 1]) {
          const x0 = sx < 0 ? -dw / 2 : 0;
          br.M(x0 + 0.08, y0 + 0.08).L(x0 + dw / 2 - 0.08, y0 + dh - 0.08).M(x0, y0 + dh / 2).L(x0 + dw / 2, y0 + dh / 2);
        }
        kit.em.line(br, "wood", 1.6, { tone: tone + 1 });
        kit.em.line(new Pen(m).M(0, y0).L(0, y0 + dh), "wood", 1, { tone: tone - 2 });
        kit.em.add(new Pen(m).rect(-dw / 2 - 0.25, y0 + dh, dw + 0.5, 0.2), "wood", { tone: tone + 1, width: 0.6 });
        const hy = top + Math.tan(look.pitch) * (a.w / 2) * 0.35;
        kit.em.add(new Pen(m).rect(-0.35, hy - 0.3, 0.7, 0.6), "ink", { alpha: 0.85, width: 0.5 });
        kit.em.add(new Pen(m).rect(-0.35, hy - 0.3, 0.32, 0.6), "wood", { tone, width: 0.5 });
      } else for (let fl = 0; fl < a.floors; fl++) win(cc, m, 0, b.plinth + fl * a.fh + (fl === 0 ? 0.8 : a.fh * 0.24), 0.95, 1.3, look.win, tone, cc.rng.fork(`w${fl}`), fl, true);
    }
    if (gableHere) gableDetail(cc, m, f.half, tone, false, top);
  }
  roof(cc, b, false, true);
}

function shed(c: Ctx, a: Extract<Annex, { kind: "shed" }>) {
  const { kit } = c;
  const look: Look = a.wood ? { ...c.look, finish: "bardage", wall: "wood" } : c.look;
  const cc = { ...c, look };
  const b: Box = { cx: a.cx, cz: a.cz, w: a.w, d: a.d, fhs: [a.h], plinth: 0.15 };
  const rise = Math.tan(18 * (Math.PI / 180)) * a.w;
  for (const f of faces(b)) {
    if (kit.vis(f.n) <= 1e-3) continue;
    const m = kit.face(f.o, f.u, [0, 1, 0]);
    const tone = kit.tone(f.n);
    const dir = f.kind === "front" ? -a.side : f.kind === "back" ? a.side : 0;
    wall(cc, m, f.half, b, tone, false, 0, dir ? { rise, dir } : undefined);
    if (f.kind === "front" && a.door) kit.em.add(new Pen(m).rect(-0.45, 0.15, 0.9, 1.85), look.door, { tone: tone - 1, width: 0.6 });
  }
  const yLow = 0.15 + a.h, yHigh = yLow + rise;
  const xo = a.cx + (a.side * a.w) / 2 + a.side * 0.2, xi = a.cx - (a.side * a.w) / 2;
  const q = [kit.P(xi, yHigh, a.cz + a.d / 2 + 0.25), kit.P(xo, yLow - 0.06, a.cz + a.d / 2 + 0.25), kit.P(xo, yLow - 0.06, a.cz - a.d / 2 - 0.25), kit.P(xi, yHigh, a.cz - a.d / 2 - 0.25)];
  kit.em.add(new Pen().poly(q), look.roof, { tone: 1 });
  kit.em.add(new Pen().poly([q[0], q[1], [q[1][0], q[1][1] - 0.1 * kit.fr.scale], [q[0][0], q[0][1] - 0.1 * kit.fr.scale]]), look.roof, { tone: -1, width: 0.5 });
}

/* ------------------------------------------------------------------ murs */

function wall(c: Ctx, m: Affine, half: number, b: Box, tone: number, gable: boolean, shedDir: number, shedSlope?: { rise: number; dir: number }) {
  const { kit, look, plan } = c;
  const em = kit.em;
  const top = b.plinth + b.fhs.reduce((s, h) => s + h, 0);
  const pen = new Pen(m).M(-half, b.plinth).L(half, b.plinth);
  const rh = Math.tan(look.pitch) * half;
  const slope = shedSlope ?? (shedDir ? { rise: Math.tan(16 * (Math.PI / 180)) * half * 2, dir: shedDir } : undefined);
  if (gable) pen.L(half, top).L(0, top + rh - 0.04).L(-half, top);
  else if (slope) pen.L(half, top + (slope.dir > 0 ? slope.rise : 0)).L(-half, top + (slope.dir < 0 ? slope.rise : 0));
  else pen.L(half, top).L(-half, top);
  pen.Z();
  em.add(pen, look.wall, { tone });
  texture(c, m, -half, half, b.plinth, gable ? top + rh * 0.9 : top, tone, look.finish, gable ? { top, rh, half } : undefined);
  if (plan.st === "chalet" && b.fhs.length > 1) {
    em.add(new Pen(m).rect(-half, b.plinth, half * 2, b.fhs[0]), "stone", { tone });
    texture(c, m, -half, half, b.plinth, b.plinth + b.fhs[0], tone, "pierre");
  }
  if (look.finish === "colombages") timber(c, m, half, b, tone);
  em.add(new Pen(m).rect(-half - 0.07, 0, half * 2 + 0.14, b.plinth), look.base, { tone: tone - 1 });
  const plj = new Pen(m);
  for (let x = -half + 0.55; x < half; x += 0.75) plj.M(x, 0).L(x, b.plinth);
  if (!plan.modern) em.line(plj, look.base, 0.4, { tone: tone - 2 });
  if (look.quoins) {
    const q = new Pen(m);
    let i = 0;
    for (let y = b.plinth; y < top - 0.25; y += 0.42, i++) {
      const w = i % 2 ? 0.36 : 0.6;
      q.rect(-half, y + 0.02, w, 0.38).rect(half - w, y + 0.02, w, 0.38);
    }
    em.add(q, look.finish === "brique" ? "stone" : "trim", { tone, width: 0.45 });
  }
  if (look.bands && !plan.modern)
    for (let f = 1; f < b.fhs.length; f++) {
      const y = b.plinth + b.fhs.slice(0, f).reduce((s, h) => s + h, 0);
      em.add(new Pen(m).rect(-half, y - 0.05, half * 2, 0.06), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
      em.add(new Pen(m).rect(-half - 0.05, y, half * 2 + 0.1, 0.13), look.trim, { tone: tone + 1, width: 0.55 });
    }
  if (look.genoise) {
    const g = new Pen(m);
    for (let row = 0; row < 2; row++) {
      const y = top - 0.12 - row * 0.13;
      g.M(-half - 0.06, y);
      for (let x = -half; x < half; x += 0.2) g.Q(x + 0.1, y - 0.12, x + 0.2, y);
      g.L(half + 0.06, y + 0.12).L(-half - 0.06, y + 0.12).Z();
    }
    em.add(g, "roof", { tone: tone - 1, width: 0.4 });
  } else if (plan.st !== "chaumiere" && plan.st !== "japonais" && look.finish !== "bardage") {
    em.add(new Pen(m).rect(-half, top - 0.32, half * 2, 0.2), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
    em.add(new Pen(m).M(-half - 0.14, top - 0.14).L(half + 0.14, top - 0.14).L(half + 0.18, top).L(-half - 0.18, top).Z(), look.trim, { tone: tone + 1, width: 0.65 });
    if (look.modillons) {
      const dn = new Pen(m);
      for (let x = -half + 0.2; x < half - 0.1; x += 0.45) dn.M(x, top - 0.14).L(x + 0.12, top - 0.14).Q(x + 0.12, top - 0.3, x + 0.02, top - 0.28).Z();
      em.add(dn, look.trim, { tone: tone - 1, width: 0.35 });
    }
  }
  if (look.gutters && !plan.modern && look.roofMat !== "chaume" && !gable) {
    em.add(new Pen(m).rect(half - 0.22, 0.05, 0.09, top - 0.1), "metal", { tone: tone - 1, width: 0.45 });
    em.add(new Pen(m).rect(-half - 0.1, top - 0.08, half * 2 + 0.2, 0.09), "metal", { tone, width: 0.4 });
  }
}

function texture(c: Ctx, m: Affine, x0: number, x1: number, y0: number, y1: number, tone: number, finish: string, gable?: { top: number; rh: number; half: number }) {
  const em = c.kit.em;
  const rng = c.rng.fork(`tex${x0.toFixed(1)}${y0.toFixed(1)}`);
  const clipY = (x: number) => (gable ? gable.top + gable.rh * (1 - Math.abs(x) / gable.half) - 0.1 : y1);
  if (finish === "pierre") {
    const joints = new Pen(m), light = new Pen(m), dark = new Pen(m);
    let y = y0;
    while (y < y1 - 0.05) {
      const h = rng.range(0.26, 0.42);
      let x = x0 + rng.range(-0.3, 0);
      while (x < x1) {
        const w = rng.range(0.4, 0.9);
        const xa = Math.max(x0, x), xb = Math.min(x1, x + w);
        if (xb - xa > 0.08 && y + h < clipY((xa + xb) / 2)) {
          const r = rng.next();
          if (r < 0.16) light.rrect(xa + 0.03, y + 0.03, xb - xa - 0.06, h - 0.06, 0.05);
          else if (r < 0.3) dark.rrect(xa + 0.03, y + 0.03, xb - xa - 0.06, h - 0.06, 0.05);
          joints.M(xb, y).L(xb, y + h);
        }
        x += w;
      }
      y += h;
      if (y < y1) {
        const xs = gable ? Math.max(x0, -gable.half * (1 - (y - gable.top) / gable.rh)) : x0;
        joints.M(y > (gable?.top ?? Infinity) ? xs : x0, y).L(y > (gable?.top ?? Infinity) ? -xs : x1, y);
      }
    }
    if (!light.empty) em.add(light, "stone", { tone: tone + 1, stroke: null, alpha: 0.6 });
    if (!dark.empty) em.add(dark, "stone", { tone: tone - 1, stroke: null, alpha: 0.5 });
    em.line(joints, "stone", 0.4, { tone: tone - 2, alpha: 0.8 });
  } else if (finish === "brique") {
    const joints = new Pen(m), dark = new Pen(m);
    let row = 0;
    for (let y = y0; y < y1 - 0.01; y += 0.22, row++) {
      const xs = gable && y > gable.top ? -gable.half * (1 - (y - gable.top) / gable.rh) : x0;
      joints.M(xs, y).L(-xs === -x0 ? x1 : -xs, y);
      for (let x = x0 + (row % 2 ? 0.22 : 0); x < x1; x += 0.44) {
        if (y + 0.22 > clipY(x)) continue;
        joints.M(x, y).L(x, y + 0.22);
        if (rng.chance(0.1)) dark.rect(x + 0.02, y + 0.02, Math.min(0.44, x1 - x) - 0.04, 0.18);
      }
    }
    if (!dark.empty) em.add(dark, "roof", { tone: tone - 1, stroke: null, alpha: 0.6 });
    em.line(joints, "trim", 0.32, { tone: tone - 1, alpha: 0.7 });
  } else if (finish === "bardage") {
    const b = new Pen(m);
    for (let x = x0 + 0.18; x < x1; x += 0.22) b.M(x, y0).L(x, Math.min(y1, clipY(x)));
    em.line(b, "wood", 0.45, { tone: tone - 1 });
    const k = new Pen(m);
    for (let i = 0; i < 6; i++) k.ellipse(rng.range(x0, x1), rng.range(y0, y0 + (y1 - y0) * 0.6), 0.03, 0.05);
    em.add(k, "wood", { tone: tone - 2, stroke: null, alpha: 0.7 });
  } else if (finish === "enduit" || finish === "colombages") {
    const patch = new Pen(m);
    for (let i = 0; i < 3; i++) {
      const cx = rng.range(x0 + 0.5, x1 - 0.5), cy = rng.range(y0, Math.max(y0 + 0.1, Math.min(y1, clipY(cx)) - 0.6));
      blobInto(patch, cx, cy, rng.range(0.4, 1.2), rng.range(0.3, 0.8), rng.next() * 99);
    }
    em.add(patch, c.look.wall, { tone: tone - 1, stroke: null, alpha: 0.16 });
    if (rng.chance(c.decay * 1.6)) {
      const cx = rng.range(x0 + 0.8, x1 - 0.8), cy = rng.range(y0 + 0.5, Math.max(y0 + 0.6, Math.min(y1, clipY(cx)) - 0.8));
      const hole = new Pen(m);
      blobInto(hole, cx, cy, rng.range(0.35, 0.6), rng.range(0.25, 0.4), rng.next() * 99, 0.3);
      em.add(hole, "stone", { tone: tone - 1, width: 0.4 });
      const br = new Pen(m);
      for (let k = -1; k <= 1; k++) br.M(cx - 0.28, cy + k * 0.12).L(cx + 0.28, cy + k * 0.12);
      em.line(br, "stone", 0.35, { tone: tone - 2 });
    }
  } else if (finish === "beton") {
    const s = new Pen(m);
    for (let i = 1; i <= c.plan.fhs.length; i++) s.rect(x0, c.plan.floorY(i) - 0.22, x1 - x0, 0.22);
    em.add(s, "trim", { tone, stroke: null });
  } else if (finish === "shoji") {
    const g = new Pen(m);
    const n = Math.max(2, Math.round((x1 - x0) / 1.8));
    for (let k = 0; k <= n; k++) g.rect(x0 + ((x1 - x0) * k) / n - 0.07, y0, 0.14, Math.min(y1, clipY(x0 + ((x1 - x0) * k) / n)) - y0);
    g.rect(x0, Math.min(y1, c.plan.top) - 0.18, x1 - x0, 0.18);
    em.add(g, "bark", { tone: tone - 1, stroke: null });
  }
}

function blobInto(pen: Pen, cx: number, cy: number, rx: number, ry: number, seed: number, amp = 0.2) {
  const pts: P2[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const r = 1 + amp * Math.sin(seed + i * 2.3);
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  pen.smooth(pts, true);
}

function timber(c: Ctx, m: Affine, half: number, b: Box, tone: number) {
  const t = 0.16;
  const pen = new Pen(m);
  for (let f = 1; f < b.fhs.length; f++) {
    const y0 = b.plinth + b.fhs.slice(0, f).reduce((s, h) => s + h, 0), fh = b.fhs[f], y1 = y0 + fh;
    pen.rect(-half, y0, half * 2, t).rect(-half, y1 - t, half * 2, t);
    const n = Math.max(2, Math.round((half * 2) / 1.35));
    for (let k = 0; k <= n; k++) pen.rect(-half + (k * half * 2) / n - t / 2, y0, t, fh);
    for (let k = 0; k < n; k++) {
      const xa = -half + (k * half * 2) / n + t / 2, xb = xa + (half * 2) / n - t;
      const brace = (x1: number, ya: number, x2: number, yb: number) => {
        const dx = x2 - x1, dy = yb - ya, l = Math.hypot(dx, dy), nx = (-dy / l) * t * 0.45, ny = (dx / l) * t * 0.45;
        pen.M(x1 + nx, ya + ny).L(x2 + nx, yb + ny).L(x2 - nx, yb - ny).L(x1 - nx, ya - ny).Z();
      };
      if (k % 2) {
        brace(xa, y0 + t, xb, y1 - t);
        brace(xb, y0 + t, xa, y1 - t);
      } else brace(xa, y0 + t, xa + (xb - xa) * 0.4, y0 + fh * 0.45);
    }
  }
  if (!pen.empty) c.kit.em.add(pen, "wood", { tone: tone - 1, width: 0.45 });
}

/* ------------------------------------------------------------------ ouvertures */

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): P2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as P2;
  });
}

/** Contour d'une baie (même géométrie que le générateur). */
export function bayOutline(kind: WinKind, w: number, h: number, e = 0): P2[] {
  const hw = w / 2 + e;
  if (kind === "arch") return [[-hw, -e], [hw, -e], ...arc(0, h - w / 2, hw, 0, Math.PI, 10)];
  if (kind === "segment") {
    const rise = w * 0.16, leg = h - rise;
    const R = (hw * hw + rise * rise) / (2 * rise);
    const a = Math.asin(Math.min(1, hw / R));
    return [[-hw, -e], [hw, -e], ...arc(0, leg + rise + e - R, R, Math.PI / 2 - a, Math.PI / 2 + a, 6)];
  }
  if (kind === "lancet") {
    const leg = h - w * 0.8;
    const pts: P2[] = [[-hw, -e], [hw, -e], [hw, leg]];
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      pts.push([hw * (1 - t) ** 1.4 * (1 - 0.15 * t), leg + (h + e - leg) * Math.sin((t * Math.PI) / 2)]);
    }
    pts.push([0, h + e]);
    for (let i = 4; i >= 1; i--) {
      const t = i / 5;
      pts.push([-hw * (1 - t) ** 1.4 * (1 - 0.15 * t), leg + (h + e - leg) * Math.sin((t * Math.PI) / 2)]);
    }
    pts.push([-hw, leg]);
    return pts;
  }
  return [[-hw, -e], [hw, -e], [hw, h + e], [-hw, h + e]];
}

function win(c: Ctx, m: Affine, x: number, y: number, w: number, h: number, kind: WinKind, tone: number, r: Rng, floor: number, front: boolean) {
  const { kit, look, plan } = c;
  const em = kit.em;
  const mm = compose(m, translate(x, y));
  const fr = kind === "mullion" ? 0.16 : plan.modern || kind === "shoji" ? 0.06 : 0.13;
  const lit = c.night > 0.25 && r.chance(0.55);
  const frameRole = plan.modern ? "metal" : kind === "shoji" ? "bark" : look.trim;
  em.add(new Pen(mm).poly(bayOutline(kind, w, h, fr)), frameRole, { tone: tone + (frameRole === "trim" ? 1 : 0), width: 0.6 });
  em.add(new Pen(mm).poly(bayOutline(kind, w, h, 0)), lit ? "lamp" : kind === "shoji" ? "paper" : "glass", { kind: lit ? "glow" : "fill", tone: lit || kind === "shoji" ? 0 : -1, width: 0.45 });
  if (kind === "shoji") {
    const g = new Pen(mm);
    for (let i = 1; i < 3; i++) g.M(-w / 2 + (i * w) / 3, 0).L(-w / 2 + (i * w) / 3, h);
    for (let j = 1; j < 4; j++) g.M(-w / 2, (j * h) / 4).L(w / 2, (j * h) / 4);
    em.line(g, "bark", 0.6, { tone: tone - 1 });
    return;
  }
  if (!lit) em.add(new Pen(mm).M(-w / 2 + w * 0.15, h * 0.95).L(-w / 2 + w * 0.42, h * 0.95).L(-w / 2 + w * 0.05, h * 0.3).L(-w / 2, h * 0.3).L(-w / 2, h * 0.7).Z(), "glass", { tone: 2, stroke: null, alpha: 0.5 });
  em.add(new Pen(mm).M(-w / 2, 0).L(-w / 2, h * 0.92).L(w / 2, h * 0.92).L(w / 2 - 0.1, h * 0.92 - 0.12).L(-w / 2 + 0.1, h * 0.92 - 0.12).L(-w / 2 + 0.1, 0).Z(), "shadow", { kind: "shadow", stroke: null, alpha: lit ? 0.3 : 0.65 });
  const g = new Pen(mm);
  if (kind === "mullion") g.rect(-0.06, 0, 0.12, h).rect(-w / 2, h * 0.62 - 0.06, w, 0.12);
  else if (kind === "lancet") g.rect(-0.025, 0, 0.05, h * 0.82);
  else if (kind === "wide") g.rect(-0.03, 0, 0.06, h);
  else {
    g.rect(-0.025, 0, 0.05, h * 0.9).rect(-w / 2, h * 0.62 - 0.025, w, 0.05);
    if (look.petitsBois) g.rect(-w / 2, h * 0.32 - 0.015, w, 0.03);
  }
  em.add(g, kind === "mullion" ? look.trim : frameRole, { tone, stroke: null });
  if (plan.modern) return;
  em.add(new Pen(mm).rect(-w / 2 - fr * 1.5, -0.16, w + fr * 3, 0.07), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
  em.add(new Pen(mm).rect(-w / 2 - fr * 1.5, -0.09, w + fr * 3, 0.1), look.trim, { tone: tone + 1, width: 0.55 });
  if ((kind === "arch" || kind === "segment") && look.ornament > 0.4) em.add(new Pen(mm).M(-0.1, h + fr - 0.04).L(0.1, h + fr - 0.04).L(0.13, h + fr + 0.14).L(-0.13, h + fr + 0.14).Z(), look.trim, { tone: tone + 1, width: 0.45 });
  if (look.shutterKind !== "none" && kind !== "mullion" && kind !== "lancet" && r.chance(c.shutters)) {
    for (const sx of [-1, 1]) {
      if (r.chance(c.decay * 0.5)) continue;
      const sw = w / 2;
      const x0 = sx < 0 ? -w / 2 - fr - sw : w / 2 + fr;
      const askew = r.chance(c.decay * 0.6) ? sx * 0.07 : 0;
      const sm = askew ? compose(mm, compose(translate(x0 + sw / 2, h), compose([Math.cos(askew), Math.sin(askew), -Math.sin(askew), Math.cos(askew), 0, 0], translate(-(x0 + sw / 2), -h)))) : mm;
      em.add(new Pen(sm).rect(x0, 0, sw, h), look.shutter, { tone, width: 0.55 });
      const d = new Pen(sm);
      if (look.shutterKind === "persiennes") for (let yy = 0.12; yy < h - 0.08; yy += 0.09) d.M(x0 + 0.05, yy).L(x0 + sw - 0.05, yy);
      else {
        for (const t of [0.33, 0.66]) d.M(x0 + sw * t, 0.02).L(x0 + sw * t, h - 0.02);
        d.M(x0 + 0.04, h * 0.2).L(x0 + sw - 0.04, h * 0.8);
      }
      em.line(d, look.shutter, 0.4, { tone: tone - 1 });
    }
  }
  if (front && floor > 0 && look.planters > 0 && r.chance(look.planters)) {
    em.add(new Pen(mm).rect(-w / 2, -0.02, w, 0.18), "wood", { tone, width: 0.45 });
    em.add(new Pen(mm).ellipse(0, 0.17, w / 2, 0.1), "leaf", { tone, stroke: null });
    const fl = new Pen(mm);
    for (let i = 0; i < 7; i++) fl.ellipse(-w / 2 + 0.08 + (i * (w - 0.16)) / 6, 0.2 + (i % 2) * 0.05, 0.07, 0.06);
    em.add(fl, r.chance(0.5) ? "flower" : "accent", { tone, width: 0.35 });
  }
}

function openings(c: Ctx, m: Affine, front: boolean, tone: number) {
  const { plan, look } = c;
  const st = plan.st;
  for (let f = 0; f < plan.floors; f++) {
    const y0 = plan.floorY(f), fh = plan.fhs[f];
    for (let b = 0; b < plan.bays; b++) {
      const u = front ? plan.bayX(b) : -plan.bayX(b);
      const r = c.rng.fork(`${front}${f}.${b}`);
      if (front && f === 0 && b === plan.doorBay) {
        door(c, m, u, plan.plinth, st === "chapelle" ? 1.8 : plan.modern ? 1.6 : 1.1, Math.min(fh - 0.45, st === "chapelle" ? 3.6 : plan.modern ? 2.4 : 2.35), tone, r, st === "chapelle" || look.ornament > 0.6);
        continue;
      }
      if (front && f === 0 && plan.shop && st !== "chapelle") {
        shopFront(c, m, u, plan.plinth + 0.3, plan.bayWs[b] - 0.55, fh - 1.0, tone, r);
        continue;
      }
      if (!front && r.chance(0.35)) continue;
      const ww = plan.modern ? plan.bayWs[b] * 0.6 : st === "japonais" ? plan.bayWs[b] * 0.7 : st === "chaumiere" || st === "ferme" ? 0.85 : look.win === "mullion" ? 1.25 : 1.02;
      let wh = plan.modern ? fh * 0.58 : st === "chapelle" ? fh * 0.55 : st === "japonais" ? fh * 0.6 : (st === "chaumiere" || st === "ferme" ? 0.95 : 1.45) * (f === plan.floors - 1 && plan.floors > 2 ? 0.85 : 1);
      if (f === 0 && !plan.modern && st !== "chapelle") wh *= 0.92;
      const wy = f === 0 ? y0 + (plan.modern ? 0.5 : st === "chapelle" ? fh * 0.3 : 0.8) : y0 + fh * 0.24;
      win(c, m, u, wy, ww, wh, st === "chapelle" ? "lancet" : look.win, tone, r, f, front);
      if (f > 0 && front && !plan.modern && r.chance(c.balconies)) balcony(c, m, u, wy, ww, tone);
    }
  }
  const em = c.kit.em;
  if (st === "japonais" && plan.floors > 1) {
    const y = plan.floorY(1) + 0.15, half = plan.W / 2 + 0.75;
    em.add(new Pen(m).M(-half, y - 0.35).Q(0, y - 0.25, half, y - 0.35).L(half - 0.6, y + 0.12).L(-half + 0.6, y + 0.12).Z(), look.roof, { tone: tone - 1, width: 0.6 });
  }
  if (st === "japonais") {
    // engawa : plancher périphérique sur pilotis
    const half = plan.W / 2 + 0.7;
    em.add(new Pen(m).rect(-half, plan.plinth - 0.1, half * 2, 0.1), "wood", { tone: tone + 1, width: 0.5 });
    const piles = new Pen(m);
    for (const x of [-half + 0.1, -half / 3, half / 3, half - 0.1]) piles.rect(x - 0.07, 0, 0.14, plan.plinth - 0.1);
    em.add(piles, "wood", { tone: tone - 1, width: 0.4 });
  }
  if (st === "chalet" && plan.floors > 1 && front) {
    const by = plan.floorY(1) + 0.05, half = plan.W / 2 + 0.3;
    em.add(new Pen(m).rect(-half, by - 0.08, half * 2, 0.12), "wood", { tone: tone - 1, width: 0.5 });
    const bl = new Pen(m);
    for (let x = -half + 0.08; x <= half; x += 0.16) bl.M(x - 0.05, by + 0.05).L(x + 0.05, by + 0.05).Q(x + 0.09, by + 0.45, x + 0.04, by + 0.82).L(x - 0.04, by + 0.82).Q(x - 0.09, by + 0.45, x - 0.05, by + 0.05).Z();
    em.add(bl, "wood", { tone, width: 0.35 });
    em.add(new Pen(m).rect(-half, by + 0.82, half * 2, 0.08), "wood", { tone: tone + 1, width: 0.5 });
  }
  if (st === "neon" && front) neonSigns(c, m);
}

function sideOpenings(c: Ctx, m: Affine, half: number, tone: number, sx: number) {
  const { plan, look } = c;
  const r = c.rng.fork(`side${sx}`);
  const n = plan.D > 8.5 ? 2 : plan.D > 5 ? 1 : 0;
  for (let f = 0; f < plan.floors; f++)
    for (let k = 0; k < n; k++) {
      if (!r.chance(f === 0 ? 0.35 : 0.6)) continue;
      const u = n === 1 ? r.range(-0.6, 0.6) : (k - 0.5) * plan.D * 0.45;
      win(c, m, u, plan.floorY(f) + (f === 0 ? 0.8 : plan.fhs[f] * 0.24), plan.modern ? 1.6 : 0.85, plan.st === "chapelle" ? plan.fhs[0] * 0.5 : plan.modern ? 1.8 : 1.2, plan.st === "chapelle" ? "lancet" : look.win, tone, r, f, false);
    }
  if (plan.st === "chapelle") {
    const h = plan.fhs[0] * 0.8;
    const cf = new Pen(m);
    for (let k = 0; k < 3; k++) {
      const u = (k - 1) * half * 0.66 + half * 0.32;
      cf.M(u - 0.25, 0).L(u + 0.25, 0).L(u + 0.25, h).L(u, h + 0.35).L(u - 0.25, h).Z();
    }
    c.kit.em.add(cf, look.base, { tone: tone - 1, width: 0.55 });
  }
}

function gableDetail(c: Ctx, m: Affine, half: number, tone: number, front: boolean, topIn?: number) {
  const { plan, look } = c;
  const em = c.kit.em;
  const top = topIn ?? plan.top;
  const rh = Math.tan(look.pitch) * half;
  if (plan.st === "chapelle" && front) {
    oculus(c, m, 0, top + rh * 0.35, 0.55, tone);
    return;
  }
  if (rh > 1.4) {
    if (plan.st === "chalet" || (front && c.rng.fork("gable").chance(0.5))) win(c, m, 0, top + rh * 0.18, plan.st === "chalet" ? 1.4 : 0.9, Math.min(1.3, rh * 0.5), plan.st === "chalet" ? "rect" : look.win, tone, c.rng.fork("gw"), 3, false);
    else oculus(c, m, 0, top + rh * 0.42, 0.36, tone);
  }
  if (look.finish === "bardage" || plan.st === "chalet") {
    const p = new Pen(m);
    for (const s of [-1, 1])
      for (let k = 0; k < 10; k++) {
        const t = k / 10;
        const x = s * (half + 0.5) * (1 - t);
        const y = top - 0.1 + (rh + 0.35) * t;
        p.M(x, y).L(x - s * 0.12, y + 0.05).L(x - s * 0.06, y - 0.2).Z();
      }
    em.add(p, "wood", { tone: tone - 1, stroke: null, alpha: 0.85 });
  }
}

function oculus(c: Ctx, m: Affine, x: number, y: number, r: number, tone: number) {
  const em = c.kit.em;
  em.add(new Pen(m).ellipse(x, y, r + 0.12, r + 0.12), c.look.trim, { tone: tone + 1, width: 0.55 });
  em.add(new Pen(m).ellipse(x, y, r, r), c.night > 0.3 ? "lamp" : "glass", { kind: c.night > 0.3 ? "glow" : "fill", tone: -1, width: 0.4 });
  em.line(new Pen(m).M(x - r, y).L(x + r, y).M(x, y - r).L(x, y + r), c.look.trim, 0.5);
}

function balcony(c: Ctx, m: Affine, x: number, y: number, w: number, tone: number) {
  const em = c.kit.em;
  const x0 = x - w / 2 - 0.3, x1 = x + w / 2 + 0.3;
  em.add(new Pen(m).rect(x0, y - 0.38, x1 - x0, 0.14), "shadow", { kind: "shadow", stroke: null, alpha: 0.55 });
  em.add(new Pen(m).rect(x0, y - 0.16, x1 - x0, 0.12), "stone", { tone: tone + 1, width: 0.55 });
  const cons = new Pen(m);
  for (const cx of [x0 + 0.12, x1 - 0.12]) cons.M(cx - 0.07, y - 0.16).L(cx + 0.07, y - 0.16).Q(cx + 0.07, y - 0.34, cx, y - 0.4).Q(cx - 0.05, y - 0.3, cx - 0.07, y - 0.16).Z();
  em.add(cons, "stone", { tone, width: 0.45 });
  const rail = new Pen(m);
  const n = Math.max(6, Math.round((x1 - x0) / 0.13));
  for (let k = 0; k <= n; k++) rail.rect(x0 + 0.04 + (k / n) * (x1 - x0 - 0.08) - 0.016, y - 0.04, 0.032, 0.9);
  rail.rect(x0, y + 0.84, x1 - x0, 0.05).rect(x0, y + 0.02, x1 - x0, 0.035);
  rail.ellipse(x - 0.12, y + 0.45, 0.09, 0.12).ellipse(x + 0.12, y + 0.45, 0.09, 0.12);
  em.add(rail, "metal", { tone: tone - 1, stroke: null });
}

function door(c: Ctx, m: Affine, x: number, y: number, w: number, h: number, tone: number, r: Rng, rich: boolean) {
  const { look, plan } = c;
  const em = c.kit.em;
  const kind: WinKind = plan.st === "chapelle" ? "lancet" : rich || look.win === "arch" ? "arch" : look.win === "segment" ? "segment" : "rect";
  const mm = compose(m, translate(x, y));
  em.add(new Pen(mm).poly(bayOutline(kind, w, h, 0.17)), look.trim, { tone: tone + 1, width: 0.65 });
  const leaf = plan.modern ? "glass" : plan.st === "japonais" ? "paper" : look.door;
  em.add(new Pen(mm).poly(bayOutline(kind, w, h, 0)), leaf, { tone, width: 0.55 });
  em.add(new Pen(mm).M(-w / 2, 0).L(-w / 2, h * 0.92).L(w / 2, h * 0.92).L(w / 2 - 0.08, h * 0.92 - 0.1).L(-w / 2 + 0.08, h * 0.92 - 0.1).L(-w / 2 + 0.08, 0).Z(), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
  if (kind !== "rect") {
    const legH = kind === "arch" ? h - w / 2 : kind === "segment" ? h - w * 0.16 : h - w * 0.8;
    em.add(new Pen(mm).poly(bayOutline(kind, w - 0.16, h - 0.08, 0).map(([px, py]): P2 => [px, Math.max(legH, py)])), c.night > 0.25 ? "lamp" : "glass", { kind: c.night > 0.25 ? "glow" : "fill", tone: -1, width: 0.4 });
  }
  if (leaf !== "glass" && leaf !== "paper") {
    const pn = new Pen(mm);
    const top = kind === "rect" ? h : kind === "arch" ? h - w / 2 : h - w * 0.2;
    for (const sx of [-1, 1]) {
      pn.rrect(sx * w * 0.24 - w * 0.16, h * 0.08, w * 0.32, top * 0.38, 0.04);
      pn.rrect(sx * w * 0.24 - w * 0.16, top * 0.55, w * 0.32, top * 0.32, 0.04);
    }
    em.add(pn, leaf, { tone: tone - 1, width: 0.35 });
    em.add(new Pen(mm).ellipse(w * 0.36, h * 0.45, 0.035, 0.035), "metal", { tone: 1, stroke: null });
  }
  if (plan.st !== "japonais") em.add(new Pen(mm).rect(-w / 2 - 0.3, -0.16, w + 0.6, 0.16), look.base, { tone: tone + 1, width: 0.5 });
  if (r.chance(0.45) && !plan.modern && plan.st !== "chapelle") {
    const lx = w / 2 + 0.4, ly = h * 0.95;
    em.add(new Pen(mm).M(lx - 0.09, ly).L(lx + 0.09, ly).L(lx + 0.06, ly - 0.3).L(lx - 0.06, ly - 0.3).Z(), "lamp", { kind: c.night > 0.25 ? "glow" : "fill", tone: c.night > 0.25 ? 0 : -1, width: 0.45 });
  }
}

function shopFront(c: Ctx, m: Affine, x: number, y: number, w: number, h: number, tone: number, r: Rng) {
  const em = c.kit.em;
  const lit = c.night > 0.2;
  em.add(new Pen(m).rect(x - w / 2 - 0.15, y - 0.3, w + 0.3, h + 0.45), c.look.door, { tone, width: 0.65 });
  em.add(new Pen(m).rect(x - w / 2, y, w, h), lit ? "lamp" : "glass", { kind: lit ? "glow" : "fill", tone: lit ? 0 : -1, width: 0.45 });
  const goods = new Pen(m);
  for (let i = 0; i < 6; i++) {
    const gx = x - w / 2 + 0.2 + (i * (w - 0.4)) / 5, gh = r.range(0.18, 0.45);
    if (r.chance(0.5)) goods.rrect(gx - 0.08, y + 0.05, 0.16, gh, 0.05);
    else goods.ellipse(gx, y + 0.05 + gh * 0.5, 0.1, gh * 0.5);
  }
  em.add(goods, r.pick(["accent", "cloth2", "flower", "paper"]), { tone: -1, stroke: null, alpha: 0.9 });
  const ay = y + h + 0.05, ah = 0.62;
  em.add(new Pen(m).rect(x - w / 2 - 0.25, ay - ah - 0.2, w + 0.5, 0.2), "shadow", { kind: "shadow", stroke: null, alpha: 0.4 });
  em.add(new Pen(m).M(x - w / 2 - 0.25, ay - ah).L(x + w / 2 + 0.25, ay - ah).L(x + w / 2 + 0.1, ay).L(x - w / 2 - 0.1, ay).Z(), "paper", { tone: tone + 1, width: 0.55 });
  const stripes = new Pen(m);
  const n = Math.max(4, Math.round(w / 0.32));
  for (let k = 0; k < n; k += 2) {
    const t0 = k / n, t1 = (k + 1) / n;
    stripes.M(x - w / 2 - 0.25 + t0 * (w + 0.5), ay - ah).L(x - w / 2 - 0.25 + t1 * (w + 0.5), ay - ah).L(x - w / 2 - 0.1 + t1 * (w + 0.2), ay).L(x - w / 2 - 0.1 + t0 * (w + 0.2), ay).Z();
  }
  const stripeRole = r.pick(["cloth1", "accent", "leaf2", "water"]);
  em.add(stripes, stripeRole, { tone, stroke: null });
  const val = new Pen(m).M(x - w / 2 - 0.25, ay - ah);
  const nv = Math.max(5, Math.round(w / 0.25));
  for (let k = 0; k < nv; k++) val.Q(x - w / 2 - 0.25 + ((k + 0.5) / nv) * (w + 0.5), ay - ah - 0.24, x - w / 2 - 0.25 + ((k + 1) / nv) * (w + 0.5), ay - ah);
  val.L(x - w / 2 - 0.25, ay - ah + 0.02).Z();
  em.add(val, stripeRole, { tone: tone - 1, width: 0.45 });
  const sy = y + h + 0.2;
  em.add(new Pen(m).rrect(x - w / 2 + 0.1, sy, w - 0.2, 0.42, 0.05), "accent", { tone, width: 0.55 });
  const letters = new Pen(m);
  let lx = x - w / 2 + 0.3;
  while (lx < x + w / 2 - 0.5) {
    const ww = r.range(0.25, 0.6);
    letters.rrect(lx, sy + 0.12, 0.05, 0.2, 0.01).rrect(lx + 0.07, sy + 0.12, Math.max(0.05, Math.min(ww, x + w / 2 - 0.3 - lx)), 0.13, 0.03);
    lx += ww + 0.18;
  }
  em.add(letters, "paper", { tone: 1, stroke: null });
  if (r.chance(0.45)) {
    const px = x + w / 2 + 0.25;
    em.line(new Pen(m).M(px, sy + 0.6).L(px + 0.75, sy + 0.6).M(px, sy + 0.25).Q(px + 0.4, sy + 0.32, px + 0.7, sy + 0.6), "metal", 0.8, { tone: -1 });
    em.add(new Pen(m).ellipse(px + 0.5, sy + 0.22, 0.24, 0.24), "paper", { width: 0.55 });
    em.add(new Pen(m).ellipse(px + 0.5, sy + 0.22, 0.12, 0.12), "accent", { stroke: null });
  }
}

function neonSigns(c: Ctx, m: Affine) {
  const em = c.kit.em;
  const r = c.rng.fork("neon");
  const W2 = c.plan.W / 2;
  for (let i = 0; i < r.int(1, 3); i++) {
    const yy = c.plan.plinth + r.range(1.6, c.plan.top - c.plan.plinth - 1.2);
    const vertical = r.chance(0.5);
    const w = vertical ? 0.45 : r.range(1.2, 2.2), h = vertical ? r.range(1.4, 2.4) : 0.5;
    const xx = r.range(-W2 + w, W2 - w);
    em.add(new Pen(m).rrect(xx - w / 2, yy, w, h, 0.12), "lamp", { kind: "glow", stroke: null });
    em.add(new Pen(m).ellipse(xx, yy + h / 2, w * 1.4, h * 1.2), "lamp", { kind: "halo", stroke: null, alpha: 0.5 });
  }
}

/* ------------------------------------------------------------------ toits */

function roof(c: Ctx, b: Box, main: boolean, forceGableZ = false) {
  const { kit, plan, look } = c;
  const em = kit.em;
  const st = plan.st;
  const kind = forceGableZ ? "gable" : plan.roof;
  const ridgeZ = forceGableZ ? true : plan.ridgeZ;
  const top = b.plinth + b.fhs.reduce((s, h) => s + h, 0);
  const over = st === "chalet" ? 0.75 : st === "japonais" ? 0.7 : look.roofMat === "chaume" ? 0.45 : st === "mediterraneen" ? 0.2 : 0.35;
  const overEnd = st === "chalet" ? 0.9 : look.roofMat === "chaume" ? 0.35 : st === "mediterraneen" ? 0.1 : 0.3;
  const pitch = look.pitch;
  const L = ridgeZ ? b.d : b.w, S = ridgeZ ? b.w : b.d;
  // repère du toit : l le long du faîtage, s en travers (vers l'avant quand le faîtage est parallèle à la façade)
  const P3 = (l: number, y: number, s: number): V3 => (ridgeZ ? [b.cx + s, y, b.cz - l] : [b.cx + l, y, b.cz + s]);
  const dir3 = (l: number, y: number, s: number): V3 => (ridgeZ ? [s, y, -l] : [l, y, s]);
  const role = look.roof;
  if (kind === "flat") {
    if (kit.vis([0, 1, 0]) > 1e-3) em.add(new Pen().poly([kit.P(b.cx - b.w / 2, top + 0.04, b.cz + b.d / 2), kit.P(b.cx + b.w / 2, top + 0.04, b.cz + b.d / 2), kit.P(b.cx + b.w / 2, top + 0.04, b.cz - b.d / 2), kit.P(b.cx - b.w / 2, top + 0.04, b.cz - b.d / 2)]), st === "mediterraneen" ? "path" : "road", { tone: 0 });
    const parapet = look.trim === "metal" ? "trim" : look.trim;
    kit.box(b.cx - b.w / 2, top, b.cz + b.d / 2 - 0.18, b.cx + b.w / 2, top + 0.5, b.cz + b.d / 2, st === "mediterraneen" ? look.wall : parapet, {});
    kit.box(b.cx + b.w / 2 - 0.18, top, b.cz - b.d / 2, b.cx + b.w / 2, top + 0.5, b.cz + b.d / 2 - 0.18, st === "mediterraneen" ? look.wall : parapet, {});
    const r = c.rng.fork("flat");
    for (let i = 0; i < r.int(1, 2); i++) {
      const x = b.cx + r.range(-b.w / 2 + 1, b.w / 2 - 1), z = b.cz + r.range(-b.d / 2 + 1, b.d / 2 - 1.5);
      kit.box(x - 0.3, top, z - 0.3, x + 0.3, top + 0.45, z + 0.3, "metal", {});
    }
    if (st === "mediterraneen") {
      const pg = new Pen();
      for (const [dx, dz] of [[0.3, 0.3], [2.6, 0.3], [0.3, 2.3], [2.6, 2.3]]) {
        const a = kit.P(b.cx - b.w / 2 + dx, top, b.cz - b.d / 2 + dz), e = kit.P(b.cx - b.w / 2 + dx, top + 2.2, b.cz - b.d / 2 + dz);
        pg.M(a[0], a[1]).L(e[0], e[1]);
      }
      for (let k = 0; k < 6; k++) {
        const a = kit.P(b.cx - b.w / 2 + 0.3 + k * 0.46, top + 2.22, b.cz - b.d / 2 + 0.1), e = kit.P(b.cx - b.w / 2 + 0.3 + k * 0.46, top + 2.22, b.cz - b.d / 2 + 2.5);
        pg.M(a[0], a[1]).L(e[0], e[1]);
      }
      em.line(pg, "wood", 1.4, { tone: -1 });
      const v0 = kit.P(b.cx - b.w / 2 + 1.4, top + 2.25, b.cz - b.d / 2 + 1.3);
      em.add(scallop(new Pen(), v0[0], v0[1], 1.2 * kit.fr.scale, 0.35 * kit.fr.scale, 3.3, 9, 0.12, 0.3), "leaf", { tone: 0, width: 0.4 });
    } else if (st === "neon" || c.rng.fork("tank").chance(0.3)) kit.sub(b.cx + b.w * 0.2, top + 0.6, b.cz - b.d * 0.15).lathe([[0.7, 0], [0.72, 0.7], [0.7, 1.4], [0.3, 1.65], [0.02, 1.72]], "wood", { top: false });
    chimneys(c, b, top, top + 0.5, kind, false);
    return;
  }
  if (kind === "shed") {
    const a = 16 * (Math.PI / 180);
    const rise = Math.tan(a) * S;
    const q = [P3(-L / 2 - overEnd, top - 0.1, S / 2 + over), P3(L / 2 + overEnd, top - 0.1, S / 2 + over), P3(L / 2 + overEnd, top + rise + 0.1, -S / 2 - 0.1), P3(-L / 2 - overEnd, top + rise + 0.1, -S / 2 - 0.1)];
    const n = dir3(0, Math.cos(a), Math.sin(a));
    const len = Math.hypot(S + over + 0.1, rise + 0.2);
    const u = dir3(1, 0, 0), v: V3 = [(q[3][0] - q[0][0]) / len, (q[3][1] - q[0][1]) / len, (q[3][2] - q[0][2]) / len];
    const m = kit.face(q[0], u, v);
    const vis = kit.vis(n) > 1e-3;
    em.add(new Pen().poly(q.map((p) => kit.P(p[0], p[1], p[2]))), role, { tone: vis ? kit.tone(n) : -1 });
    if (vis) tiles(c, m, L + 2 * overEnd, len, () => 0, () => L + 2 * overEnd, look.roofMat, kit.tone(n), role);
    em.add(new Pen().poly([kit.P(...q[0]), kit.P(...q[1]), kit.P(q[1][0], q[1][1] - 0.12, q[1][2]), kit.P(q[0][0], q[0][1] - 0.12, q[0][2])]), role, { tone: -1, width: 0.45 });
    chimneys(c, b, top, top + rise, kind, ridgeZ);
    return;
  }
  if (kit.vis([0, 0, 1]) > 0 && main) {
    const m = kit.face([b.cx, 0, b.cz + b.d / 2], [1, 0, 0], [0, 1, 0]);
    em.add(new Pen(m).rect(-b.w / 2, top - 0.42, b.w, 0.42), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
  }
  if (kind === "gable") {
    const half = S / 2, rh = Math.tan(pitch) * half;
    const yE = top - Math.tan(pitch) * over;
    const coy = look.coyau && look.roofMat !== "chaume";
    for (const sgn of [1, -1]) {
      const nW = dir3(0, Math.cos(pitch), sgn * Math.sin(pitch));
      if (kit.vis(nW) <= 1e-3) continue;
      const tone = kit.tone(nW);
      const len = Math.hypot(half + over, rh + Math.tan(pitch) * over);
      const v3 = dir3(0, (rh + Math.tan(pitch) * over) / len, (-sgn * (half + over)) / len);
      // u orienté pour que la tranche d'égout soit lue de gauche à droite
      const uL = sgn > 0 ? 1 : -1;
      const o3 = P3(-uL * (L / 2 + overEnd), yE, sgn * (half + over));
      const m = kit.face(o3, dir3(uL, 0, 0), v3);
      const Wd = L + 2 * overEnd;
      const outline = new Pen(m);
      if (coy) outline.M(0, -0.12).Q(Wd / 2, -0.02, Wd, -0.12).L(Wd, len).L(0, len).Z();
      else outline.rect(0, 0, Wd, len);
      em.add(outline, role, { tone });
      tiles(c, m, Wd, len, () => 0, () => Wd, look.roofMat, tone, role);
      if (look.roofMat === "chaume") {
        const e = new Pen(m).M(-0.1, -0.2);
        const nn = Math.round(Wd / 0.5);
        for (let i = 0; i < nn; i++) e.Q((i + 0.5) * (Wd / nn), -0.42, (i + 1) * (Wd / nn), -0.2);
        e.L(Wd, 0.25).L(0, 0.25).Z();
        em.add(e, role, { tone: tone - 1, width: 0.55 });
      } else em.add(new Pen(m).rect(0, -0.06, Wd, 0.13), role, { tone: tone - 1, width: 0.45 });
      if (main && !ridgeZ && sgn > 0 && rh > 1.6 && st !== "chalet" && st !== "japonais") dormers(c, m, Wd, len, tone);
    }
    const a = kit.P(...P3(-L / 2 - overEnd, top + rh, 0)), z = kit.P(...P3(L / 2 + overEnd, top + rh, 0));
    const k = kit.fr.scale;
    const ridge = new Pen().M(a[0], a[1] - 0.06 * k);
    const nR = Math.max(3, Math.round((L + 2 * overEnd) / 0.45));
    for (let i = 0; i < nR; i++) {
      const t = (i + 1) / nR, tm = (i + 0.5) / nR;
      ridge.Q(a[0] + (z[0] - a[0]) * tm, a[1] + (z[1] - a[1]) * tm + 0.18 * k, a[0] + (z[0] - a[0]) * t, a[1] + (z[1] - a[1]) * t - 0.06 * k);
    }
    ridge.L(z[0], z[1] - 0.12 * k).L(a[0], a[1] - 0.12 * k).Z();
    em.add(ridge, look.roofMat === "chaume" ? "leaf2" : look.roofMat === "tuile" ? "roof" : "metal", { tone: 0, width: 0.55 });
    // rives : planches le long des pignons visibles
    for (const e of [-1, 1]) {
      if (kit.vis(dir3(e, 0, 0)) <= 1e-3) continue;
      const p0 = kit.P(...P3(e * (L / 2 + overEnd), yE, half + over)), pc = kit.P(...P3(e * (L / 2 + overEnd), top + rh, 0)), p1 = kit.P(...P3(e * (L / 2 + overEnd), yE, -half - over));
      const th = (look.roofMat === "chaume" ? 0.32 : look.roofMat === "lauze" ? 0.2 : 0.14) * k;
      em.add(new Pen().M(p0[0], p0[1]).L(pc[0], pc[1]).L(p1[0], p1[1]).L(p1[0], p1[1] - th).L(pc[0], pc[1] - th).L(p0[0], p0[1] - th).Z(), st === "chalet" || look.finish === "colombages" || look.finish === "bardage" ? "wood" : role, { tone: -1, width: 0.5 });
    }
    chimneys(c, b, top, top + rh, kind, ridgeZ);
    return;
  }
  // croupe, mansarde, pavillon : bandes de trapèzes plans (profil du générateur)
  const So = S / 2 + over;
  const ridgeLen = Math.max(0, L - S);
  const jp = kind === "pavilion";
  const rh = (kind === "mansard" ? 0.62 : jp ? 0.5 : Math.tan(pitch) * 0.5) * S;
  const prof: [number, number][] = kind === "mansard" ? [[1, 0], [0.8, 0.78], [0.78, 0.8], [0, 1]] : jp ? [[1.04, 0.02], [0.86, 0.12], [0.66, 0.3], [0.44, 0.56], [0.2, 0.85], [0, 1]] : [[1, 0], [0, 1]];
  const y0 = top - over * Math.tan(pitch) * (jp ? 0.6 : 1);
  const rect = (s: number): [number, number] => [So * s + ridgeLen / 2, So * s];
  type Trap = { n: V3; pts: V3[]; m: Affine; W: number; len: number; inset: number; band: number };
  const traps: Trap[] = [];
  for (let i = 0; i < prof.length - 1; i++) {
    const [s0, h0] = prof[i], [s1, h1] = prof[i + 1];
    const [a0, b0] = rect(s0), [a1, b1] = rect(s1);
    const ya = y0 + h0 * rh, yb = y0 + h1 * rh;
    for (const [axis, sgn] of [["s", 1], ["s", -1], ["l", 1], ["l", -1]] as const) {
      const half0 = axis === "s" ? a0 : b0, half1 = axis === "s" ? a1 : b1;
      const off0 = axis === "s" ? b0 : a0, off1 = axis === "s" ? b1 : a1;
      if (half0 < 1e-3) continue;
      const pt = (along: number, off: number, y: number): V3 => (axis === "s" ? P3(along * sgn, y, sgn * off) : P3(sgn * off, y, -along * sgn));
      const pts = [pt(-half0, off0, ya), pt(half0, off0, ya), pt(half1, off1, yb), pt(-half1, off1, yb)];
      const e1: V3 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
      const mid0: V3 = [(pts[0][0] + pts[1][0]) / 2, ya, (pts[0][2] + pts[1][2]) / 2], mid1: V3 = [(pts[2][0] + pts[3][0]) / 2, yb, (pts[2][2] + pts[3][2]) / 2];
      const v: V3 = [mid1[0] - mid0[0], mid1[1] - mid0[1], mid1[2] - mid0[2]];
      const len = Math.hypot(...v), W = Math.hypot(...e1);
      if (len < 1e-4 || W < 1e-4) continue;
      const u = e1.map((x) => x / W) as V3, vn = v.map((x) => x / len) as V3;
      const nr: V3 = [u[1] * vn[2] - u[2] * vn[1], u[2] * vn[0] - u[0] * vn[2], u[0] * vn[1] - u[1] * vn[0]];
      traps.push({ n: nr[1] < 0 ? [-nr[0], -nr[1], -nr[2]] : nr, pts, m: kit.face(pts[0], u, vn), W, len, inset: half0 - half1, band: i });
    }
  }
  for (const t of traps.filter((q) => kit.vis(q.n) > 1e-3).sort((a, b) => a.band - b.band || kit.vis(a.n) - kit.vis(b.n))) {
    const tone = kit.tone(t.n);
    em.add(new Pen().poly(t.pts.map((v) => kit.P(v[0], v[1], v[2]))), role, { tone });
    tiles(c, t.m, t.W, t.len, (v) => (t.inset * v) / t.len, (v) => t.W - (t.inset * v) / t.len, look.roofMat, tone, role);
  }
  if (kind === "mansard" && main && kit.vis([0, 0, 1]) > 0) {
    for (let bay = 0; bay < plan.bays; bay++) {
      const m = kit.face([plan.bayX(bay), top + 0.1, b.cz + b.d / 2 + 0.15], [1, 0, 0], [0, 1, 0]);
      em.add(new Pen(m).M(-0.42, 0).L(0.42, 0).L(0.42, 0.95).Q(0, 1.3, -0.42, 0.95).Z(), look.wall, { tone: 0, width: 0.55 });
      em.add(new Pen(m).M(-0.28, 0.12).L(0.28, 0.12).L(0.28, 0.8).Q(0, 1.02, -0.28, 0.8).Z(), c.night > 0.3 ? "lamp" : "glass", { tone: -1, width: 0.4, kind: c.night > 0.3 ? "glow" : "fill" });
      em.add(new Pen(m).M(-0.52, 0.95).Q(0, 1.45, 0.52, 0.95).L(0.52, 1.05).Q(0, 1.58, -0.52, 1.05).Z(), role, { tone: -1, width: 0.45 });
    }
  }
  if (jp) {
    const a = kit.P(...P3(-ridgeLen / 2 - 0.3, y0 + rh + 0.05, 0)), z = kit.P(...P3(ridgeLen / 2 + 0.3, y0 + rh + 0.05, 0));
    const k = kit.fr.scale;
    em.add(strokeVar(new Pen(), [a, z], [0.1 * k, 0.1 * k]), "metal", { tone: -1, width: 0.5 });
    for (const [q, s] of [[a, -1], [z, 1]] as const) em.add(new Pen().M(q[0], q[1]).Q(q[0] + s * 0.2 * k, q[1] + 0.35 * k, q[0], q[1] + 0.45 * k).Z(), "metal", { tone: 0, width: 0.45 });
  }
  chimneys(c, b, top, y0 + rh, kind, false);
}

function dormers(c: Ctx, m: Affine, Wd: number, len: number, tone: number) {
  const r = c.rng.fork("dormers");
  const em = c.kit.em;
  if (!r.chance(0.55 + c.look.ornament * 0.3)) return;
  const n = r.int(1, Math.max(1, c.plan.bays - 1));
  const kind = r.pick(["pignon", "pignon", "rampant", "oeil"] as const);
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? Wd / 2 : 1.4 + ((Wd - 2.8) * i) / Math.max(1, n - 1);
    const v = len * 0.3;
    if (kind === "oeil") {
      em.add(new Pen(m).M(x - 0.5, v).Q(x, v + 1.0, x + 0.5, v).Z(), c.look.roof, { tone: tone - 1, width: 0.5 });
      em.add(new Pen(m).ellipse(x, v + 0.28, 0.2, 0.17), "glass", { tone: -1, width: 0.4 });
      continue;
    }
    em.add(new Pen(m).rect(x - 0.5, v, 1.0, 0.85), c.look.wall, { tone, width: 0.5 });
    em.add(new Pen(m).rect(x - 0.32, v + 0.1, 0.64, 0.62), c.night > 0.3 && r.chance(0.5) ? "lamp" : "glass", { tone: -1, width: 0.4 });
    em.add(new Pen(m).rect(x - 0.02, v + 0.1, 0.04, 0.62), c.look.trim, { stroke: null });
    if (kind === "pignon") em.add(new Pen(m).M(x - 0.65, v + 0.82).L(x, v + 1.35).L(x + 0.65, v + 0.82).L(x + 0.55, v + 0.78).L(x, v + 1.2).L(x - 0.55, v + 0.78).Z(), c.look.roof, { tone: tone - 1, width: 0.45 });
    else em.add(new Pen(m).M(x - 0.62, v + 0.8).L(x + 0.62, v + 0.8).L(x + 0.55, v + 1.05).L(x - 0.55, v + 1.05).Z(), c.look.roof, { tone: tone - 1, width: 0.45 });
  }
}

function chimneys(c: Ctx, b: Box, top: number, peak: number, kind: string, ridgeZ: boolean) {
  const { kit, plan, look } = c;
  const r = c.rng.fork("ch");
  const n = kind === "flat" || plan.st === "japonais" ? 0 : plan.st === "chateau" ? r.int(2, 3) : r.int(0, 2);
  for (let i = 0; i < n; i++) {
    const x = b.cx + (n === 1 ? r.range(-b.w / 2 + 0.8, b.w / 2 - 0.8) : -b.w / 2 + 0.7 + ((b.w - 1.4) * i) / Math.max(1, n - 1));
    const z = b.cz + (ridgeZ ? r.range(-b.d / 2 + 1, b.d / 2 - 1) : r.range(-b.d * 0.15, b.d * 0.12));
    if (plan.st === "vapeur") {
      const h = peak - top + 2.6;
      kit.sub(x, top, z).lathe([[0.26, 0], [0.24, h * 0.5], [0.22, h], [0.32, h + 0.05], [0.32, h + 0.25]], "metal", {});
      smoke(c, x, top + h + 0.4, z);
      continue;
    }
    const h = peak - top + r.range(0.4, 0.9);
    const cw = r.range(0.28, 0.42), cd = r.range(0.38, 0.6);
    const role = look.finish === "brique" || r.chance(0.3) ? "roof" : look.finish === "pierre" ? "stone" : look.wall;
    kit.box(x - cw, top + (peak - top) * 0.4, z - cd, x + cw, top + h, z + cd, role, {});
    kit.box(x - cw - 0.06, top + h, z - cd - 0.06, x + cw + 0.06, top + h + 0.1, z + cd + 0.06, look.trim, {});
    if (r.chance(0.6)) for (let k = 0; k < r.int(1, 3); k++) kit.sub(x, top + h + 0.1, z - cd + 0.2 + k * 0.28).lathe([[0.08, 0], [0.07, 0.26], [0.09, 0.3]], "roof", {});
    if (r.chance(0.4)) smoke(c, x, top + h + 0.5, z);
  }
}

function smoke(c: Ctx, x: number, y: number, z: number) {
  for (let i = 0; i < 4; i++) {
    const k = i / 4;
    const [u, v] = c.kit.P(x + k * 1.6, y + k * 2.2, z);
    const rr = (0.2 + k * 0.5) * c.kit.fr.scale;
    c.kit.em.add(new Pen().ellipse(u, v, rr, rr * 0.8), "paper", { tone: -1, stroke: null, alpha: 0.55 * (1 - k * 0.8) });
  }
}

function tiles(c: Ctx, m: Affine, W: number, L: number, xl: (v: number) => number, xr: (v: number) => number, mat: string, tone: number, role: string) {
  const em = c.kit.em;
  const rng = c.rng.fork(`t${W.toFixed(2)}${L.toFixed(2)}`);
  if (mat === "tuile" && (c.plan.st === "mediterraneen" || c.look.pitch < 30 * (Math.PI / 180))) {
    // tuiles canal : colonnes de demi-ronds, rangs festonnés
    const pen = new Pen(m), hi = new Pen(m);
    for (let x = 0.12; x < W; x += 0.24) {
      if (x < xl(0) || x > xr(0)) continue;
      const top = x < xl(L) || x > xr(L) ? L * (x < xl(L) ? x / Math.max(1e-3, xl(L)) : (W - x) / Math.max(1e-3, W - xr(L))) : L;
      hi.rect(x - 0.05, 0, 0.04, Math.max(0, top));
      pen.M(x + 0.11, 0).L(x + 0.11, Math.max(0, top));
    }
    for (let v = 0.4; v < L; v += 0.4) {
      pen.M(xl(v), v);
      for (let x = xl(v); x < xr(v) - 0.24; x += 0.24) pen.Q(x + 0.12, v - 0.1, x + 0.24, v);
    }
    em.add(hi, role, { tone: tone + 1, stroke: null, alpha: 0.6 });
    em.line(pen, role, 0.4, { tone: tone - 1 });
  } else if (mat === "tuile" || mat === "ardoise") {
    const step = mat === "ardoise" ? 0.22 : 0.3, tw = mat === "ardoise" ? 0.3 : 0.24;
    const lines = new Pen(m), alt = new Pen(m), sh = new Pen(m);
    let row = 0;
    for (let v = step; v < L - 0.05; v += step, row++) {
      const a = xl(v), b = xr(v);
      lines.M(a, v).L(b, v);
      sh.M(a, v).L(b, v).L(b, v - 0.05).L(a, v - 0.05).Z();
      for (let x = a + (row % 2 ? tw / 2 : 0); x < b; x += tw) {
        lines.M(x, v - step).L(x, v);
        if (rng.chance(0.07)) alt.rect(x + 0.01, v - step + 0.01, Math.min(tw, b - x) - 0.02, step - 0.02);
      }
    }
    if (!alt.empty) em.add(alt, role, { tone: tone + (rng.chance(0.5) ? 1 : -1), stroke: null, alpha: 0.7 });
    em.add(sh, "shadow", { kind: "shadow", stroke: null, alpha: 0.3 });
    em.line(lines, role, 0.33, { tone: tone - 1 });
    if (c.plan.st === "colombages" || c.look.ornament > 0.75) {
      const sc = new Pen(m);
      for (let v = L * 0.6; v < L - 0.1; v += 0.24) for (let x = xl(v); x + 0.24 <= xr(v); x += 0.24) sc.M(x, v).Q(x + 0.12, v - 0.22, x + 0.24, v);
      em.line(sc, role, 0.33, { tone: tone - 1 });
    }
  } else if (mat === "lauze") {
    const pen = new Pen(m), alt = new Pen(m);
    for (let v = 0.35; v < L; v += rng.range(0.3, 0.42)) {
      const a = xl(v), b = xr(v);
      pen.M(a, v);
      for (let x = a; x < b; ) {
        const w = rng.range(0.35, 0.7);
        pen.Q(x + w / 2, v - 0.06, Math.min(b, x + w), v);
        if (rng.chance(0.15)) alt.rrect(x + 0.03, v - 0.28, Math.max(0.05, Math.min(w, b - x) - 0.06), 0.25, 0.06);
        x += w;
      }
    }
    if (!alt.empty) em.add(alt, role, { tone: tone + 1, stroke: null, alpha: 0.6 });
    em.line(pen, role, 0.45, { tone: tone - 1 });
  } else if (mat === "chaume") {
    const pen = new Pen(m);
    for (let v = 0.35; v < L - 0.1; v += 0.42) for (let x = xl(v) + rng.range(0, 0.12); x < xr(v); x += rng.range(0.08, 0.16)) pen.M(x, v).L(x + rng.range(-0.03, 0.03), v - rng.range(0.18, 0.34));
    em.line(pen, role, 0.4, { tone: tone - 1, alpha: 0.85 });
    const lite = new Pen(m);
    for (let v = 0.5; v < L - 0.1; v += 0.84) lite.M(xl(v), v).Q(W / 2, v + 0.08, xr(v), v).L(xr(v), v + 0.1).Q(W / 2, v + 0.18, xl(v), v + 0.1).Z();
    em.add(lite, role, { tone: tone + 1, stroke: null, alpha: 0.6 });
  } else if (mat === "kawara") {
    const pen = new Pen(m);
    for (let x = 0.1; x < W; x += 0.2) {
      if (x < xl(0) || x > xr(0)) continue;
      pen.M(x, 0).L(Math.min(Math.max(x, xl(L)), xr(L)), L);
    }
    em.line(pen, role, 0.5, { tone: tone - 1 });
    const disc = new Pen(m);
    for (let x = xl(0) + 0.1; x < xr(0); x += 0.2) disc.ellipse(x, 0.04, 0.07, 0.07);
    em.add(disc, role, { tone: tone + 1, stroke: null });
  } else {
    const pen = new Pen(m);
    for (let x = 0.3; x < W; x += 0.5) if (x > xl(0) && x < xr(0)) pen.M(x, 0).L(Math.min(Math.max(x, xl(L)), xr(L)), L);
    em.line(pen, role, 0.45, { tone: tone - 1 });
  }
}

/* ------------------------------------------------------------------ annexes */

function turret(c: Ctx, a: Extract<Annex, { kind: "turret" }>) {
  const { kit, look } = c;
  const em = kit.em;
  if (a.corbel) kit.sub(a.cx, a.y0 - 1.2, a.cz).lathe([[0.05, 0], [a.r * 0.6, 0.6], [a.r, 1.2]], look.base, { top: false });
  else kit.sub(a.cx, 0, a.cz).lathe([[a.r + 0.08, 0], [a.r + 0.08, 0.6]], look.base, { top: false });
  kit.sub(a.cx, a.y0, a.cz).lathe([[a.r, 0], [a.r, a.h]], look.wall, { top: false });
  const m = kit.face([a.cx, 0, a.cz + a.r], [1, 0, 0], [0, 1, 0]);
  for (let y = a.y0 + 1.2; y < a.y0 + a.h - 1.4; y += 2.6) {
    em.add(new Pen(compose(m, translate(0, y))).poly(bayOutline("arch", 0.5, 0.95, 0.08)), look.trim, { tone: 1, width: 0.5 });
    em.add(new Pen(compose(m, translate(0, y))).poly(bayOutline("arch", 0.5, 0.95, 0)), c.night > 0.3 ? "lamp" : "glass", { tone: -1, width: 0.4, kind: c.night > 0.3 ? "glow" : "fill" });
  }
  kit.sub(a.cx, a.y0 + a.h - 0.05, a.cz).lathe([[a.r + 0.08, 0], [a.r + 0.08, 0.14]], look.trim, { shade: false });
  const rh = a.r * (c.plan.st === "chateau" ? 2.6 : 2.1);
  kit.sub(a.cx, a.y0 + a.h + 0.05, a.cz).lathe([[a.r + 0.25, 0], [a.r * 0.85, rh * 0.18], [a.r * 0.3, rh * 0.7], [0.01, rh]], look.roof, { top: false });
  const tip = kit.P(a.cx, a.y0 + a.h + rh, a.cz);
  const s = kit.fr.scale;
  em.line(new Pen().M(tip[0], tip[1]).L(tip[0], tip[1] + 0.7 * s), "metal", 0.8);
  em.add(new Pen().M(tip[0], tip[1] + 0.7 * s).L(tip[0] + 0.45 * s, tip[1] + 0.6 * s).L(tip[0], tip[1] + 0.48 * s).Z(), "accent", { width: 0.4 });
}

function porch(c: Ctx, a: Extract<Annex, { kind: "porch" }>) {
  const { kit, plan, look } = c;
  const z = plan.D / 2 + 1.5;
  for (const sx of [-1, 1]) kit.sub(a.u + (sx * a.w) / 2, 0, z).lathe([[0.07, 0], [0.06, a.h]], "wood", { top: false });
  const s = kit.fr.scale;
  const q = [kit.P(a.u - a.w / 2 - 0.25, a.h + 0.1, z + 0.3), kit.P(a.u + a.w / 2 + 0.25, a.h + 0.1, z + 0.3), kit.P(a.u + a.w / 2 + 0.25, a.h + 0.9, plan.D / 2), kit.P(a.u - a.w / 2 - 0.25, a.h + 0.9, plan.D / 2)];
  kit.em.add(new Pen().poly(q), look.roof, { tone: 1 });
  kit.em.add(new Pen().poly([q[0], q[1], [q[1][0], q[1][1] - 0.12 * s], [q[0][0], q[0][1] - 0.12 * s]]), "wood", { tone: -1, width: 0.5 });
}

function stairs(c: Ctx, sx: number) {
  const { kit, plan, look } = c;
  const y1 = plan.floorY(1);
  const n = Math.round(y1 / 0.2), run = n * 0.28;
  const x0 = sx * (plan.W / 2 - 0.2);
  const m = kit.face([0, 0, plan.D / 2 + 0.9], [1, 0, 0], [0, 1, 0]);
  const pen = new Pen(m).M(x0 - sx * run, 0);
  for (let k = 0; k < n; k++) {
    const xa = x0 - sx * (run - k * 0.28);
    pen.L(xa, ((k + 1) * y1) / n).L(xa + sx * 0.28, ((k + 1) * y1) / n);
  }
  pen.L(x0 + sx * 0.6, y1).L(x0 + sx * 0.6, 0).Z();
  kit.em.add(pen, look.wall, { tone: 0, width: 0.55 });
  kit.em.line(new Pen(m).M(x0 - sx * run, 0.9).L(x0, y1 + 0.9).L(x0 + sx * 0.6, y1 + 0.9), "metal", 0.9, { tone: -1 });
  kit.em.add(new Pen(kit.face([0, 0, plan.D / 2 + 0.02], [1, 0, 0], [0, 1, 0])).rect(x0 + sx * 0.05 - 0.45, y1, 0.9, 2.0), look.door, { tone: -1, width: 0.5 });
}

function belfry(c: Ctx) {
  const { kit, plan, look } = c;
  const W = plan.W, D = plan.D;
  const tw = Math.min(W * 0.42, 2.6);
  const th = plan.top + Math.tan(look.pitch) * (W / 2) + 2.2;
  const zc = -D / 2 + tw / 2 + 0.1;
  kit.box(-tw / 2, 0, zc - tw / 2, tw / 2, th, zc + tw / 2, look.wall, {});
  if (kit.vis([0, 0, 1]) > 0) {
    const m = kit.face([0, 0, zc + tw / 2], [1, 0, 0], [0, 1, 0]);
    kit.em.add(new Pen(compose(m, translate(0, th - 1.7))).poly(bayOutline("arch", tw * 0.45, 1.3, 0.1)), look.trim, { tone: 1, width: 0.5 });
    kit.em.add(new Pen(compose(m, translate(0, th - 1.7))).poly(bayOutline("arch", tw * 0.45, 1.3, 0)), "ink", { alpha: 0.9, width: 0.4 });
    kit.em.add(new Pen(m).M(-0.25, th - 1.45).Q(-0.2, th - 1.0, 0, th - 0.95).Q(0.2, th - 1.0, 0.25, th - 1.45).Z(), "#b98a3a", { width: 0.45 });
  }
  const tip: V3 = [0, th + tw * 2.3, zc];
  const base = [[-tw * 0.62, zc + tw * 0.62], [tw * 0.62, zc + tw * 0.62], [tw * 0.62, zc - tw * 0.62], [-tw * 0.62, zc - tw * 0.62]];
  for (let i = 0; i < 4; i++) {
    const a = base[i], b = base[(i + 1) % 4];
    const n: V3 = [(a[0] + b[0]) / 2, tw * 0.3, (a[1] + b[1]) / 2 - zc];
    if (kit.vis(n) <= 0) continue;
    kit.em.add(new Pen().poly([kit.P(a[0], th, a[1]), kit.P(b[0], th, b[1]), kit.P(tip[0], tip[1], tip[2])]), look.roof, { tone: kit.tone(n) });
  }
  const t = kit.P(tip[0], tip[1], tip[2]);
  const s = kit.fr.scale;
  kit.em.line(new Pen().M(t[0], t[1]).L(t[0], t[1] + 0.9 * s).M(t[0] - 0.25 * s, t[1] + 0.6 * s).L(t[0] + 0.25 * s, t[1] + 0.6 * s), "metal", 1.2);
}

/* ------------------------------------------------------------------ édifices singuliers */

function singular(c: Ctx) {
  const { kit, plan } = c;
  const em = kit.em;
  const floors = plan.floors;
  const night = c.night > 0.3;
  const archWin = (m: Affine, x: number, y: number, w: number, h: number, fill = night ? "lamp" : "glass") => {
    em.add(new Pen(compose(m, translate(x, y))).poly(bayOutline("arch", w, h, 0.08)), "trim", { tone: 1, width: 0.45 });
    em.add(new Pen(compose(m, translate(x, y))).poly(bayOutline("arch", w, h, 0)), fill, { tone: -1, width: 0.4, kind: night && fill === "lamp" ? "glow" : "fill" });
  };
  if (plan.st === "moulin") {
    const H = 6 + floors * 1.6, R0 = 2.6, R1 = 1.8;
    kit.lathe([[R0 + 0.15, 0], [R0 + 0.15, 0.5], [R0, 0.5], [R1, H], [R1 + 0.15, H]], "wall", {});
    const m = kit.face([0, 0, R0 - 0.05], [1, 0, 0], [0, 1, 0]);
    em.add(new Pen(compose(m, translate(0, 0.5))).poly(bayOutline("arch", 1.0, 2.1, 0.12)), "trim", { tone: 1, width: 0.55 });
    em.add(new Pen(compose(m, translate(0, 0.5))).poly(bayOutline("arch", 1.0, 2.1, 0)), "wood", { width: 0.5 });
    for (let k = 0; k < 3; k++) {
      const y = 2.6 + (k * (H - 3.5)) / 3;
      archWin(kit.face([(k - 1) * 0.6, 0, R0 - (R0 - R1) * (y / H)], [1, 0, 0], [0, 1, 0]), 0, y, 0.5, 0.75);
    }
    kit.sub(0, H + 0.12, 0).lathe([[R1 + 0.3, 0], [R1 + 0.2, 0.5], [R1 * 0.7, 1.75], [0.02, 2.2]], "roof", { top: false });
    const hub = kit.P(0, H + 0.5, R1 + 0.7);
    const L = H * 0.75, s = kit.fr.scale;
    const spin = plan.tilt + c.time * 0.6;
    const frame = new Pen(), sail = new Pen();
    for (let k = 0; k < 4; k++) {
      const a = spin + (k * Math.PI) / 2;
      const d: P2 = [Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2)], n: P2 = [Math.cos(a), Math.sin(a)];
      const P = (t: number, w: number): P2 => [hub[0] + (d[0] * L * t + n[0] * w) * s, hub[1] + (d[1] * L * t + n[1] * w) * s];
      strokeVar(frame, [P(0, 0), P(1, 0)], [0.08 * s, 0.05 * s]);
      for (let i = 1; i <= 7; i++) {
        const t = 0.22 + (i / 7) * 0.76;
        const a1 = P(t, 0), a2 = P(t, 0.78);
        frame.M(a1[0], a1[1]).L(a2[0], a2[1]).L(a2[0] + n[0] * 0.035 * s + d[0] * 0.035 * s, a2[1] + n[1] * 0.035 * s + d[1] * 0.035 * s).L(a1[0] + d[0] * 0.035 * s, a1[1] + d[1] * 0.035 * s).Z();
      }
      const e1 = P(0.22, 0.78), e2 = P(1, 0.78);
      frame.M(e1[0], e1[1]).L(e2[0], e2[1]).L(e2[0] + n[0] * 0.04 * s, e2[1] + n[1] * 0.04 * s).L(e1[0] + n[0] * 0.04 * s, e1[1] + n[1] * 0.04 * s).Z();
      if (k % 2 === 0) sail.poly([P(0.3, 0.05), P(0.98, 0.05), P(0.98, 0.74), P(0.3, 0.74)]);
    }
    em.add(sail, "cloth3", { tone: 0, width: 0.45, alpha: 0.92 });
    em.add(frame, "wood", { tone: -1, width: 0.4 });
    em.add(new Pen().ellipse(hub[0], hub[1], 0.26 * s, 0.26 * s), "wood", { width: 0.5 });
    return;
  }
  if (plan.st === "phare") {
    const H = 9 + floors * 2.2, R0 = 1.9, R1 = 1.25;
    const kx = plan.keeper;
    const hx = kx * (R0 + 2.1 - 0.2);
    kit.box(hx - 2.1, 0, -2.0, hx + 2.1, 2.8, 1.4, "wall", {});
    const hm = kit.face([hx, 0, 1.4], [1, 0, 0], [0, 1, 0]);
    em.add(new Pen(hm).M(-2.4, 2.75).L(0, 4.0).L(2.4, 2.75).L(2.4, 2.55).L(0, 3.8).L(-2.4, 2.55).Z(), "roof", { tone: 1, width: 0.55 });
    em.add(new Pen(hm).M(-2.1, 2.8).L(0, 3.82).L(2.1, 2.8).Z(), "wall", { tone: 0, width: 0.45 });
    em.add(new Pen(hm).rect(kx * 0.8 - 0.45, 1.2, 0.9, 0.8), night ? "lamp" : "glass", { tone: -1, width: 0.45, kind: night ? "glow" : "fill" });
    for (const sx of [-1, 1]) em.add(new Pen(hm).rect(kx * 0.8 + sx * 0.72 - 0.24, 1.18, 0.48, 0.84), "water", { width: 0.4 });
    kit.lathe([[R0 + 0.3, 0], [R0 + 0.3, 0.6]], "stone", {});
    const bands = 5 + (floors % 3);
    for (let k = 0; k < bands; k++) {
      const y0 = (k / bands) * H, y1 = ((k + 1) / bands) * H;
      kit.sub(0, y0, 0).lathe([[R0 + (R1 - R0) * (y0 / H), 0], [R0 + (R1 - R0) * (y1 / H), y1 - y0]], k % 2 ? "accent" : "wall", { top: false });
    }
    const m = kit.face([0, 0, R0], [1, 0, 0], [0, 1, 0]);
    em.add(new Pen(m).rect(-0.45, 0.15, 0.9, 2.0), "wood", { width: 0.5 });
    em.add(new Pen(m).rect(-0.55, 2.15, 1.1, 0.12), "trim", { width: 0.45 });
    for (let k = 0; k < 4; k++) {
      const y = 3 + (k * (H - 4)) / 4;
      archWin(kit.face([k % 2 ? 0.3 : -0.3, 0, R0 + (R1 - R0) * (y / H)], [1, 0, 0], [0, 1, 0]), 0, y, 0.4, 0.7, "glass");
    }
    kit.sub(0, H - 0.6, 0).lathe([[R1, 0], [R1 + 0.6, 0.6], [R1 + 0.6, 0.76]], "stone", { top: true });
    const lamp = kit.P(0, H + 0.9, 0);
    if (c.night > 0.2) {
      const s = kit.fr.scale;
      em.add(new Pen().M(lamp[0], lamp[1]).L(lamp[0] + 30 * s, lamp[1] + 4 * s).L(lamp[0] + 30 * s, lamp[1] - 2 * s).Z(), "lamp", { kind: "glow", stroke: null, alpha: 0.18 });
      em.add(new Pen().ellipse(lamp[0], lamp[1], 6 * s, 6 * s), "lamp", { kind: "halo", stroke: null, alpha: 0.8 });
    }
    kit.sub(0, H + 0.16, 0).lathe([[R1 * 0.75, 0], [R1 * 0.75, 0.5]], "metal", { top: false });
    kit.sub(0, H + 0.66, 0).lathe([[R1 * 0.7, 0], [R1 * 0.7, 1.4]], "lamp", { top: false, shade: false });
    const mg = kit.face([0, H + 0.66, R1 * 0.7], [1, 0, 0], [0, 1, 0]);
    const bars = new Pen(mg);
    for (const x of [-0.6, -0.2, 0.2, 0.6]) bars.M(x * R1, 0).L(x * R1, 1.4);
    em.line(bars, "metal", 0.8, { tone: -1 });
    const rl = new Pen(kit.face([0, H + 0.16, R1 + 0.55], [1, 0, 0], [0, 1, 0]));
    for (let x = -R1 - 0.55; x <= R1 + 0.56; x += 0.25) rl.M(x, 0).L(x, 0.6);
    rl.M(-R1 - 0.55, 0.6).L(R1 + 0.55, 0.6);
    em.line(rl, "metal", 0.7, { tone: -1 });
    kit.sub(0, H + 2.06, 0).lathe([[R1 * 0.85, 0], [R1 * 0.6, 0.45], [0.12, 0.9], [0.01, 1.0]], "metal", { top: false });
    return;
  }
  // tour / donjon
  const H = 8 + floors * 2.4, R = plan.R, round = plan.round;
  const PR = R + 0.35;
  if (round) kit.lathe([[R + 0.35, 0], [R + 0.1, 1.2], [R, 1.4], [R, H]], "stone", { top: false });
  else {
    kit.box(-R - 0.25, 0, -R - 0.25, R + 0.25, 1.2, R + 0.25, "stone", {});
    kit.box(-R, 1.2, -R, R, H, R, "stone", {});
  }
  const m = kit.face([0, 0, R], [1, 0, 0], [0, 1, 0]);
  const jn = new Pen(m);
  for (let y = 1.6, i = 0; y < H - 0.3; y += 0.55, i++) {
    jn.M(-R * 0.97, y).L(R * 0.97, y);
    for (let x = -R + (i % 2) * 0.5; x < R; x += 1.0) jn.M(x, y).L(x, Math.min(H, y + 0.55));
  }
  em.line(jn, "stone", 0.35, { tone: -2, alpha: 0.6 });
  em.add(new Pen(compose(m, translate(0, 0.5))).poly(bayOutline("arch", 1.3, 2.5, 0.2)), "trim", { tone: 1, width: 0.55 });
  em.add(new Pen(compose(m, translate(0, 0.5))).poly(bayOutline("arch", 1.3, 2.5, 0)), "wood", { width: 0.5 });
  const nk = Math.floor(H / 3.2);
  for (let k = 0; k < nk; k++) {
    const y = 3.8 + k * 3.2;
    const x = (k % 2 ? 0.4 : -0.4) * R;
    if (k < nk - 1) em.add(new Pen(m).rect(x - 0.06, y - 0.4, 0.12, 0.8), "ink", { width: 0.4 });
    else archWin(m, x, y - 0.55, 0.6, 1.1);
  }
  if (round) kit.sub(0, H, 0).lathe([[PR, 0], [PR, 1.0]], "stone", { top: !plan.crenel });
  else kit.box(-PR, H, -PR, PR, H + 1.0, PR, "stone", {});
  const cons = new Pen(kit.face([0, H - 0.5, PR], [1, 0, 0], [0, 1, 0]));
  for (let x = -PR + 0.2; x < PR; x += 0.5) cons.M(x - 0.1, 0.5).L(x + 0.1, 0.5).L(x + 0.06, 0.05).L(x - 0.06, 0.05).Z();
  em.add(cons, "trim", { tone: -1, width: 0.4 });
  if (plan.crenel) {
    const cp = new Pen(kit.face([0, H + 1.0, PR], [1, 0, 0], [0, 1, 0]));
    for (let x = -PR; x < PR - 0.3; x += 0.7) cp.rect(x, 0, 0.42, 0.55);
    em.add(cp, "stone", { tone: 0, width: 0.5 });
    const t = kit.P(0, H + 1.0, 0), s = kit.fr.scale;
    em.line(new Pen().M(t[0], t[1]).L(t[0], t[1] + 2.5 * s), "wood", 1);
    em.add(new Pen().M(t[0], t[1] + 2.4 * s).L(t[0] + 1.0 * s, t[1] + 2.3 * s).L(t[0] + 0.8 * s, t[1] + 2.05 * s).L(t[0] + 1.0 * s, t[1] + 1.8 * s).L(t[0], t[1] + 1.7 * s).Z(), "accent", { width: 0.45 });
  } else {
    const rh = R * 2.2;
    kit.sub(0, H + 1.0, 0).lathe([[PR + 0.3, 0], [PR * 0.9, rh * 0.15], [PR * 0.35, rh * 0.7], [0.01, rh]], "metal", { top: false });
  }
}
