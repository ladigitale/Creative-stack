/**
 * Bâtiments en élévation / cavalière, d'après les paramètres du générateur `building` (mêmes cotes : travées,
 * étages, soubassement, débord de toit). Chaque face plane est dessinée dans son repère local puis projetée par une
 * affine (les détails restent des courbes exactes).
 *
 * Façade : soubassement appareillé, enduit à taches, pierre en assises irrégulières, brique en panneresses, chaînes
 * d'angle harpées, bandeaux d'étage et corniche avec leur ombre portée, fenêtres à encadrement, tableau ombré, vitre
 * à reflet, croisillons, appui saillant, clé, volets persiennés ou à écharpe (usure : volet manquant, de travers),
 * jardinières, balcons à barreaux, porte à panneaux et imposte, vitrine avec store à lambrequin et enseigne, potence,
 * colombages (poteaux, sablières, écharpes, croix de Saint-André), descente d'eau pluviale, fissures.
 * Toits : tuiles plates en rangs décalés, écailles, ardoises, chaume à bourrelet, tôle à joints debout, faîtage,
 * rive, ombre du débord ; croupe, mansarde à lucarnes, toit-terrasse à acrotère, réservoir. Cheminées à souche,
 * chaperon et mitrons. Styles : bourg, colombages, vapeur, moderne, neon, chaumiere, pierre.
 */
import { Rng } from "../../core/rng";
import { buildingDims } from "../compose";
import { type Affine, Pen, compose, translate } from "../shape";
import { type Kit } from "./kit";
import type { DrawCtx, ObjectDrawer } from "./types";

type Dims = ReturnType<typeof buildingDims>;

export const drawBuilding: ObjectDrawer = (kit, p, ctx) => {
  const b = buildingDims(p);
  const rng = ctx.rng;
  const st = b.st;
  const em = kit.em;
  const W2 = b.W / 2, D2 = b.D / 2;
  const wallRole = st === "pierre" ? "stone" : st === "vapeur" ? "roof" : "wall";
  // ombre portée au sol
  kit.castShadow(ctx.env.shadows, W2, D2, b.roofTop * 0.92, ctx.env.ground, em.z0 - 0.5, em.layer, em.depth);
  const faces = [
    { n: [0, 0, 1] as [number, number, number], o: [0, 0, D2] as [number, number, number], u: [1, 0, 0] as [number, number, number], half: W2, kind: "front" as const },
    { n: [0, 0, -1] as [number, number, number], o: [0, 0, -D2] as [number, number, number], u: [-1, 0, 0] as [number, number, number], half: W2, kind: "back" as const },
    { n: [1, 0, 0] as [number, number, number], o: [W2, 0, 0] as [number, number, number], u: [0, 0, -1] as [number, number, number], half: D2, kind: "side" as const },
    { n: [-1, 0, 0] as [number, number, number], o: [-W2, 0, 0] as [number, number, number], u: [0, 0, 1] as [number, number, number], half: D2, kind: "side" as const },
  ];
  const lean = st === "bourg" || st === "colombages" || st === "chaumiere" ? rng.range(-1, 1) * (0.006 + Number(p.decay ?? 0.1) * 0.012) : 0;
  for (const f of faces) {
    if (kit.vis(f.n) <= 1e-3) continue;
    const m0 = kit.face(f.o, f.u, [0, 1, 0]);
    // faux aplomb : cisaillement léger de la façade
    const m: Affine = lean ? compose(m0, [1, 0, lean, 1, 0, 0]) : m0;
    const tone = kit.tone(f.n);
    if (f.kind === "side") sideWall(kit, m, b, f.half, tone, wallRole, rng.fork(`s${f.n[0]}`), p, ctx);
    else facade(kit, m, b, f.kind === "front", tone, wallRole, rng.fork(f.kind), p, ctx);
  }
  roof(kit, b, rng.fork("roof"), p, ctx);
};

/* ------------------------------------------------------------------ façades */

function frameRoleOf(st: string) {
  return st === "colombages" || st === "chaumiere" ? "wood" : st === "moderne" || st === "neon" ? "metal" : "trim";
}

function wallTexture(kit: Kit, m: Affine, x0: number, x1: number, y0: number, y1: number, b: Dims, tone: number, wallRole: string, rng: Rng, decay: number) {
  const em = kit.em;
  const st = b.st;
  if (st === "pierre" || st === "chaumiere") {
    // assises irrégulières de moellons : joints en traits, quelques pierres en ton décalé
    const joints = new Pen(m);
    const stones = new Pen(m), stonesD = new Pen(m);
    let y = y0;
    const top = st === "chaumiere" ? Math.min(y1, y0 + 0.9) : y1;
    while (y < top - 0.05) {
      const h = Math.min(top - y, rng.range(0.28, 0.46));
      let x = x0 + rng.range(-0.3, 0);
      while (x < x1) {
        const w = rng.range(0.45, 0.95);
        const xa = Math.max(x0, x), xb = Math.min(x1, x + w);
        if (xb - xa > 0.06) {
          const r = rng.next();
          if (r < 0.18) stones.rrect(xa + 0.03, y + 0.03, xb - xa - 0.06, h - 0.06, 0.06);
          else if (r < 0.32) stonesD.rrect(xa + 0.03, y + 0.03, xb - xa - 0.06, h - 0.06, 0.06);
          joints.M(xb, y).L(xb, y + h);
        }
        x += w;
      }
      y += h;
      if (y < top - 0.02) joints.M(x0, y).L(x1, y);
    }
    if (!stones.empty) em.add(stones, st === "chaumiere" ? "stone" : wallRole, { tone: tone + 1, stroke: null, alpha: 0.7 });
    if (!stonesD.empty) em.add(stonesD, st === "chaumiere" ? "stone" : wallRole, { tone: tone - 1, stroke: null, alpha: 0.55 });
    if (!joints.empty) em.line(joints, wallRole, 0.45, { tone: tone - 2 });
  } else if (st === "vapeur") {
    // brique : assises de 25 cm, joints verticaux décalés d'une demi-brique, briques tachées
    const joints = new Pen(m);
    const dark = new Pen(m);
    const bh = 0.25, bw = 0.5;
    let row = 0;
    for (let y = y0; y < y1 - 0.01; y += bh, row++) {
      joints.M(x0, y).L(x1, y);
      for (let x = x0 + (row % 2 ? bw / 2 : 0); x < x1; x += bw) {
        joints.M(x, y).L(x, Math.min(y1, y + bh));
        if (rng.chance(0.12)) dark.rect(x + 0.02, y + 0.02, Math.min(bw, x1 - x) - 0.04, bh - 0.04);
      }
    }
    if (!dark.empty) em.add(dark, wallRole, { tone: tone - 1, stroke: null, alpha: 0.6 });
    em.line(joints, "trim", 0.35, { tone: tone - 1, alpha: 0.7 });
  } else if (st === "bourg" || st === "colombages") {
    // enduit : grandes taches de ton (patine) et, avec l'usure, enduit tombé laissant voir la pierre
    const patch = new Pen(m);
    for (let i = 0; i < 3; i++) {
      const cx = rng.range(x0, x1), cy = rng.range(y0, y1), rx = rng.range(0.6, 1.6), ry = rng.range(0.4, 1.0);
      blobInto(patch, cx, cy, rx, ry, rng.next() * 99);
    }
    em.add(patch, wallRole, { tone: tone - 1, stroke: null, alpha: 0.18 });
    if (rng.chance(decay * 1.6)) {
      const cx = rng.range(x0 + 0.8, x1 - 0.8), cy = rng.range(y0 + 0.5, y1 - 0.8);
      const hole = new Pen(m);
      blobInto(hole, cx, cy, rng.range(0.35, 0.7), rng.range(0.25, 0.45), rng.next() * 99, 0.3);
      em.add(hole, "stone", { tone: tone - 1, stroke: "ink", width: 0.4 });
      const bricks = new Pen(m);
      for (let k = -1; k <= 1; k++) bricks.M(cx - 0.3, cy + k * 0.13).L(cx + 0.3, cy + k * 0.13);
      em.line(bricks, "stone", 0.35, { tone: tone - 2 });
    }
    if (rng.chance(decay * 1.2)) {
      const c = new Pen(m);
      let x = rng.range(x0 + 0.5, x1 - 0.5), y = y1 - rng.range(0.2, 0.8);
      c.M(x, y);
      for (let k = 0; k < 5; k++) {
        x += rng.range(-0.15, 0.15);
        y -= rng.range(0.12, 0.3);
        c.L(x, y);
      }
      em.line(c, "ink", 0.4, { alpha: 0.6 });
    }
  } else if (st === "moderne") {
    // dalles d'étage apparentes
    const slab = new Pen(m);
    for (let f = 1; f <= b.floors; f++) slab.rect(x0, b.plinth + f * b.fh - 0.22, x1 - x0, 0.22);
    em.add(slab, "trim", { tone, stroke: null });
  } else if (st === "neon") {
    const fins = new Pen(m);
    for (let x = x0 + 0.4; x < x1 - 0.2; x += 1.6) fins.rect(x, b.plinth, 0.08, b.top - b.plinth);
    em.add(fins, "metal", { tone: tone - 1, stroke: null, alpha: 0.6 });
  }
}

function blobInto(pen: Pen, cx: number, cy: number, rx: number, ry: number, seed: number, amp = 0.2) {
  const pts: [number, number][] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const r = 1 + amp * Math.sin(seed + i * 2.3);
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  pen.smooth(pts, true);
}

/** Chaînes d'angle harpées (alternance boutisse / panneresse). */
function quoins(kit: Kit, m: Affine, x0: number, x1: number, b: Dims, tone: number) {
  if (b.st !== "bourg" && b.st !== "pierre" && b.st !== "vapeur") return;
  const pen = new Pen(m);
  let i = 0;
  for (let y = b.plinth; y < b.top - 0.25; y += 0.42, i++) {
    const w = i % 2 ? 0.38 : 0.62;
    pen.rect(x0, y + 0.02, w, 0.38);
    pen.rect(x1 - w, y + 0.02, w, 0.38);
  }
  kit.em.add(pen, b.st === "vapeur" ? "stone" : "trim", { tone, stroke: "ink", width: 0.45 });
}

function facade(kit: Kit, m: Affine, b: Dims, front: boolean, tone: number, wallRole: string, rng: Rng, p: Record<string, unknown>, ctx: DrawCtx) {
  const em = kit.em;
  const st = b.st;
  const W2 = b.W / 2;
  const decay = Number(p.decay ?? 0.1);
  const night = ctx.env.night;
  // mur
  em.add(new Pen(m).rect(-W2, b.plinth, b.W, b.top - b.plinth), wallRole, { tone });
  wallTexture(kit, m, -W2, W2, b.plinth, b.top, b, tone, wallRole, rng.fork("tex"), decay);
  // colombages
  if (st === "colombages") timber(kit, m, b, tone);
  // soubassement appareillé
  const pl = new Pen(m).rect(-W2 - 0.07, 0, b.W + 0.14, b.plinth);
  em.add(pl, "stone", { tone: tone - 1 });
  const plj = new Pen(m);
  for (let x = -W2 + 0.55; x < W2; x += 0.75) plj.M(x, 0).L(x, b.plinth);
  if (st !== "moderne") em.line(plj, "stone", 0.4, { tone: tone - 2 });
  quoins(kit, m, -W2, W2, b, tone);
  // bandeaux d'étage + ombre portée sous chaque bandeau
  if (st !== "moderne" && st !== "chaumiere")
    for (let f = 1; f < b.floors; f++) {
      const y = b.plinth + f * b.fh;
      em.add(new Pen(m).rect(-W2, y - 0.05, b.W, 0.1), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
      em.add(new Pen(m).rect(-W2 - 0.05, y, b.W + 0.1, 0.14), "trim", { tone: tone + 1, width: 0.6 });
    }
  // ouvertures
  const frame = frameRoleOf(st);
  for (let f = 0; f < b.floors; f++) {
    const y = b.plinth + f * b.fh + (f === 0 ? 0 : b.fh * 0.22);
    for (let bay = 0; bay < b.bays; bay++) {
      const x = b.x0 + (bay + 0.5) * b.bayW;
      const r = rng.fork(`${f}.${bay}`);
      if (f === 0 && front && bay === b.doorBay) {
        door(kit, m, x, b.plinth, st === "moderne" ? 1.6 : 1.05, Math.min(b.fh - 0.5, 2.3), b, frame, tone, r, night);
        continue;
      }
      if (f === 0 && front && p.shop) {
        shopFront(kit, m, x, b.plinth + 0.35, b.bayW - 0.7, b.fh - 1.1, b, tone, r, night);
        continue;
      }
      const ww = b.winW, wh = f === 0 && st !== "moderne" && st !== "neon" ? b.winH * 0.9 : b.winH;
      const wy = f === 0 && st !== "moderne" && st !== "neon" ? b.plinth + 0.75 : y;
      win(kit, m, x, wy, ww, wh, b, frame, tone, r, Number(p.shutters ?? 0.6), decay, night, f > 0 && front);
      if (f > 0 && front && r.chance(Number(p.balconies ?? 0.2))) balcony(kit, m, x, wy, ww, tone);
    }
  }
  // corniche
  if (st !== "chaumiere") {
    em.add(new Pen(m).rect(-W2, b.top - 0.32, b.W, 0.2), "shadow", { kind: "shadow", stroke: null, alpha: 0.55 });
    const c = new Pen(m).M(-W2 - 0.16, b.top - 0.12).L(W2 + 0.16, b.top - 0.12).L(W2 + 0.2, b.top).L(-W2 - 0.2, b.top).Z();
    em.add(c, "trim", { tone: tone + 1, width: 0.7 });
    if (st === "bourg" || st === "pierre") {
      // denticules
      const dn = new Pen(m);
      for (let x = -W2; x < W2 - 0.05; x += 0.22) dn.rect(x, b.top - 0.22, 0.11, 0.08);
      em.add(dn, "trim", { tone: tone - 1, stroke: null });
    }
  }
  // descente d'eau pluviale
  if (st !== "moderne" && st !== "neon") {
    const dx = front ? W2 - 0.18 : -W2 + 0.18;
    const g = new Pen(m).rect(dx - 0.05, 0.05, 0.1, b.top - 0.1);
    em.add(g, "metal", { tone: tone - 1, width: 0.5 });
    const coll = new Pen(m).M(dx - 0.05, 0.12).L(dx + 0.05, 0.12).L(dx + 0.18 * (front ? -1 : 1), 0.02).Z();
    em.add(coll, "metal", { tone, width: 0.4 });
  }
  // néon : enseignes lumineuses
  if (st === "neon" && front) {
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const yy = b.plinth + rng.range(1.6, b.top - b.plinth - 1.2);
      const vertical = rng.chance(0.5);
      const w = vertical ? 0.45 : rng.range(1.2, 2.2), h = vertical ? rng.range(1.4, 2.4) : 0.5;
      const xx = rng.range(-W2 + w, W2 - w);
      const sign = new Pen(m).rrect(xx - w / 2, yy, w, h, 0.12);
      em.add(sign, "lamp", { kind: "glow", stroke: null });
      const bars = new Pen(m);
      for (let k = 0; k < (vertical ? 4 : 3); k++) {
        if (vertical) bars.rect(xx - 0.1, yy + 0.18 + k * (h - 0.3) / 4, 0.2, (h - 0.3) / 6);
        else bars.rect(xx - w / 2 + 0.15 + k * (w - 0.3) / 3, yy + 0.15, (w - 0.3) / 4.5, 0.2);
      }
      em.add(bars, "accent", { kind: "glow", stroke: null });
    }
  }
}

function timber(kit: Kit, m: Affine, b: Dims, tone: number) {
  const em = kit.em;
  const W2 = b.W / 2;
  const t = 0.16;
  for (let f = 1; f < b.floors; f++) {
    const y0 = b.plinth + f * b.fh, y1 = y0 + b.fh;
    const pen = new Pen(m);
    pen.rect(-W2, y0, b.W, t); // sablière basse
    pen.rect(-W2, y1 - t, b.W, t); // sablière haute
    for (let k = 0; k <= b.bays; k++) pen.rect(b.x0 + k * b.bayW - t / 2, y0, t, b.fh);
    for (let k = 0; k < b.bays; k++) {
      const xa = b.x0 + k * b.bayW + t / 2, xb = xa + b.bayW - t;
      // croix de Saint-André sous la fenêtre, écharpes de part et d'autre
      const yb = y0 + t, ym = y0 + b.fh * 0.22;
      const cx = (xa + xb) / 2;
      const brace = (x1: number, y1b: number, x2: number, y2: number) => {
        const dx = x2 - x1, dy = y2 - y1b, l = Math.hypot(dx, dy), nx = (-dy / l) * t * 0.45, ny = (dx / l) * t * 0.45;
        pen.M(x1 + nx, y1b + ny).L(x2 + nx, y2 + ny).L(x2 - nx, y2 - ny).L(x1 - nx, y1b - ny).Z();
      };
      brace(xa, yb, cx - b.winW / 2 - 0.1, ym);
      brace(xb, yb, cx + b.winW / 2 + 0.1, ym);
      brace(xa, y1 - t, xa + b.bayW * 0.18, y1 - t - b.fh * 0.3);
      brace(xb, y1 - t, xb - b.bayW * 0.18, y1 - t - b.fh * 0.3);
    }
    em.add(pen, "wood", { tone: tone - 1, width: 0.5 });
  }
}

function win(kit: Kit, m: Affine, x: number, y: number, w: number, h: number, b: Dims, frame: string, tone: number, r: Rng, shutters: number, decay: number, night: number, upper: boolean) {
  const em = kit.em;
  const st = b.st;
  const fr = st === "moderne" || st === "neon" ? 0.06 : 0.14;
  const lit = night > 0.25 && r.chance(0.55);
  // encadrement
  em.add(new Pen(m).rect(x - w / 2 - fr, y - 0.02, w + fr * 2, h + fr + 0.02), frame, { tone: tone + (frame === "trim" ? 1 : 0), width: 0.6 });
  // baie : vitre, tableau ombré (retrait), reflet
  em.add(new Pen(m).rect(x - w / 2, y, w, h), lit ? "lamp" : "glass", { kind: lit ? "glow" : "fill", tone: lit ? 0 : -1, width: 0.5 });
  if (!lit) {
    const refl = new Pen(m).M(x - w / 2 + w * 0.15, y + h).L(x - w / 2 + w * 0.45, y + h).L(x - w / 2 + w * 0.05, y + h * 0.35).L(x - w / 2, y + h * 0.35).L(x - w / 2, y + h * 0.75).Z();
    em.add(refl, "glass", { tone: 2, stroke: null, alpha: 0.55 });
  }
  const rev = new Pen(m).M(x - w / 2, y).L(x - w / 2, y + h).L(x + w / 2, y + h).L(x + w / 2 - 0.1, y + h - 0.12).L(x - w / 2 + 0.1, y + h - 0.12).L(x - w / 2 + 0.1, y).Z();
  em.add(rev, "shadow", { kind: "shadow", stroke: null, alpha: lit ? 0.3 : 0.7 });
  // croisillons
  if (st !== "moderne" && st !== "neon") {
    const c = new Pen(m).rect(x - 0.025, y, 0.05, h).rect(x - w / 2, y + h * 0.62 - 0.025, w, 0.05);
    em.add(c, frame, { tone, stroke: null });
  } else {
    em.add(new Pen(m).rect(x - 0.02, y, 0.04, h), frame, { tone, stroke: null });
  }
  // appui saillant + son ombre
  if (st !== "neon") {
    em.add(new Pen(m).rect(x - w / 2 - fr * 1.6, y - 0.16, w + fr * 3.2, 0.07), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
    em.add(new Pen(m).rect(x - w / 2 - fr * 1.6, y - 0.09, w + fr * 3.2, 0.1), "trim", { tone: tone + 1, width: 0.6 });
  }
  // clé de linteau
  if (st === "bourg" || st === "pierre") {
    const k = new Pen(m).M(x - 0.1, y + h + fr).L(x + 0.1, y + h + fr).L(x + 0.13, y + h + fr + 0.14).L(x - 0.13, y + h + fr + 0.14).Z();
    em.add(k, "trim", { tone: tone + 1, width: 0.5 });
  }
  // volets
  if (r.chance(shutters) && st !== "moderne" && st !== "neon") {
    const slats = st === "bourg" || st === "pierre" || st === "vapeur";
    for (const sx of [-1, 1]) {
      if (r.chance(decay * 0.5)) continue; // volet manquant
      const sw = w / 2;
      const x0 = sx < 0 ? x - w / 2 - fr - sw : x + w / 2 + fr;
      const askew = r.chance(decay * 0.6) ? sx * 0.07 : 0;
      const sm = askew ? compose(m, compose(translate(x0 + sw / 2, y + h), compose([Math.cos(askew), Math.sin(askew), -Math.sin(askew), Math.cos(askew), 0, 0], translate(-(x0 + sw / 2), -(y + h))))) : m;
      em.add(new Pen(sm).rect(x0, y, sw, h), "accent", { tone: tone - (r.chance(0.5) ? 0 : 0), width: 0.6 });
      const d = new Pen(sm);
      if (slats) for (let yy = y + 0.12; yy < y + h - 0.08; yy += 0.09) d.M(x0 + 0.05, yy).L(x0 + sw - 0.05, yy);
      else {
        d.M(x0 + sw * 0.5, y).L(x0 + sw * 0.5, y + h);
        d.M(x0 + 0.04, y + h * 0.2).L(x0 + sw - 0.04, y + h * 0.8);
      }
      em.line(d, "accent", 0.4, { tone: tone - 1 });
      em.add(new Pen(sm).rect(x0, y, sw, 0.05), "accent", { tone: tone + 1, stroke: null });
    }
  }
  // jardinière fleurie (étages, bourg / colombages)
  if (upper && (st === "bourg" || st === "colombages") && r.chance(0.28)) {
    em.add(new Pen(m).rect(x - w / 2, y - 0.02, w, 0.18), "wood", { tone, width: 0.5 });
    const fl = new Pen(m);
    for (let i = 0; i < 7; i++) fl.ellipse(x - w / 2 + 0.08 + (i * (w - 0.16)) / 6, y + 0.2 + (i % 2) * 0.05, 0.075, 0.065);
    em.add(new Pen(m).ellipse(x, y + 0.17, w / 2, 0.1), "leaf", { tone, stroke: null });
    em.add(fl, "flower", { tone, width: 0.4 });
  }
}

function balcony(kit: Kit, m: Affine, x: number, y: number, w: number, tone: number) {
  const em = kit.em;
  const x0 = x - w / 2 - 0.3, x1 = x + w / 2 + 0.3;
  em.add(new Pen(m).rect(x0, y - 0.38, x1 - x0, 0.14), "shadow", { kind: "shadow", stroke: null, alpha: 0.55 });
  em.add(new Pen(m).rect(x0, y - 0.16, x1 - x0, 0.12), "stone", { tone: tone + 1, width: 0.6 });
  // consoles
  const cons = new Pen(m);
  for (const cx of [x0 + 0.12, x1 - 0.12]) cons.M(cx - 0.07, y - 0.16).L(cx + 0.07, y - 0.16).Q(cx + 0.07, y - 0.34, cx, y - 0.4).Q(cx - 0.05, y - 0.3, cx - 0.07, y - 0.16).Z();
  em.add(cons, "stone", { tone, width: 0.5 });
  const rail = new Pen(m);
  const n = Math.max(6, Math.round((x1 - x0) / 0.13));
  for (let k = 0; k <= n; k++) {
    const xx = x0 + 0.04 + (k / n) * (x1 - x0 - 0.08);
    rail.rect(xx - 0.016, y - 0.04, 0.032, 0.9);
  }
  rail.rect(x0, y + 0.84, x1 - x0, 0.05).rect(x0, y + 0.02, x1 - x0, 0.035);
  // volutes au centre
  rail.ellipse(x - 0.12, y + 0.45, 0.09, 0.12).ellipse(x + 0.12, y + 0.45, 0.09, 0.12);
  em.add(rail, "metal", { tone: tone - 1, stroke: null });
}

function door(kit: Kit, m: Affine, x: number, y: number, w: number, h: number, b: Dims, frame: string, tone: number, r: Rng, night: number) {
  const em = kit.em;
  const st = b.st;
  const fr = 0.16;
  const arch = st === "bourg" || st === "pierre";
  const sh = new Pen(m);
  if (arch) sh.M(x - w / 2 - fr, y).L(x - w / 2 - fr, y + h).Q(x, y + h + w * 0.55 + fr, x + w / 2 + fr, y + h).L(x + w / 2 + fr, y).Z();
  else sh.rect(x - w / 2 - fr, y, w + fr * 2, h + fr);
  em.add(sh, frame, { tone: tone + (frame === "trim" ? 1 : 0), width: 0.7 });
  // imposte vitrée (arc) puis vantail à panneaux
  if (arch) {
    const imp = new Pen(m).M(x - w / 2, y + h).Q(x, y + h + w * 0.5, x + w / 2, y + h).Z();
    em.add(imp, night > 0.25 ? "lamp" : "glass", { kind: night > 0.25 ? "glow" : "fill", tone: -1, width: 0.5 });
    const rays = new Pen(m);
    for (let k = 1; k < 4; k++) {
      const a = (k / 4) * Math.PI;
      rays.M(x, y + h).L(x - Math.cos(a) * w * 0.45, y + h + Math.sin(a) * w * 0.22);
    }
    em.line(rays, frame, 0.4, { tone });
  }
  const leafRole = st === "moderne" || st === "neon" ? "glass" : "wood";
  em.add(new Pen(m).rect(x - w / 2, y, w, h), leafRole, { tone: tone - 0, width: 0.6 });
  em.add(new Pen(m).M(x - w / 2, y).L(x - w / 2, y + h).L(x + w / 2, y + h).L(x + w / 2 - 0.08, y + h - 0.1).L(x - w / 2 + 0.08, y + h - 0.1).L(x - w / 2 + 0.08, y).Z(), "shadow", { kind: "shadow", stroke: null, alpha: 0.55 });
  if (leafRole === "wood") {
    const pn = new Pen(m);
    const pw = w * 0.32, ph1 = h * 0.42, ph2 = h * 0.3;
    for (const sx of [-1, 1]) {
      pn.rrect(x + sx * w * 0.24 - pw / 2, y + h * 0.1, pw, ph1, 0.04);
      pn.rrect(x + sx * w * 0.24 - pw / 2, y + h * 0.6, pw, ph2, 0.04);
    }
    em.add(pn, "wood", { tone: tone - 1, width: 0.4 });
    em.add(new Pen(m).ellipse(x + w * 0.36, y + h * 0.48, 0.035, 0.035), "metal", { tone: 1, stroke: null });
  }
  // marche
  em.add(new Pen(m).rect(x - w / 2 - 0.25, y - 0.16, w + 0.5, 0.16), "stone", { tone: tone + 1, width: 0.5 });
  // applique au-dessus de la porte
  if (r.chance(0.5) && st !== "moderne") {
    const lx = x + w / 2 + 0.38, ly = y + h * 0.95;
    em.add(new Pen(m).rect(lx - 0.02, ly - 0.05, 0.12, 0.04), "metal", { stroke: null });
    em.add(new Pen(m).M(lx - 0.09, ly).L(lx + 0.09, ly).L(lx + 0.06, ly - 0.3).L(lx - 0.06, ly - 0.3).Z(), "lamp", { kind: night > 0.25 ? "glow" : "fill", tone: night > 0.25 ? 0 : -1, width: 0.5 });
  }
}

function shopFront(kit: Kit, m: Affine, x: number, y: number, w: number, h: number, b: Dims, tone: number, r: Rng, night: number) {
  const em = kit.em;
  const lit = night > 0.2;
  em.add(new Pen(m).rect(x - w / 2 - 0.15, y - 0.35, w + 0.3, h + 0.5), "wood", { tone: tone, width: 0.7 });
  em.add(new Pen(m).rect(x - w / 2, y, w, h), lit ? "lamp" : "glass", { kind: lit ? "glow" : "fill", tone: lit ? 0 : -1, width: 0.5 });
  // étalage : silhouettes de marchandises
  const goods = new Pen(m);
  for (let i = 0; i < 6; i++) {
    const gx = x - w / 2 + 0.2 + (i * (w - 0.4)) / 5;
    const gh = r.range(0.18, 0.45);
    if (r.chance(0.5)) goods.rrect(gx - 0.08, y + 0.05, 0.16, gh, 0.05);
    else goods.ellipse(gx, y + 0.05 + gh * 0.5, 0.1, gh * 0.5);
  }
  em.add(goods, r.pick(["accent", "cloth2", "flower", "paper"]), { tone: -1, stroke: null, alpha: 0.9 });
  em.add(new Pen(m).rect(x - w / 2, y + 0.55, w, 0.04), "wood", { stroke: null, tone: -1 });
  if (!lit) em.add(new Pen(m).M(x - w / 2 + 0.2, y + h).L(x - w / 2 + 0.6, y + h).L(x - w / 2 + 0.1, y + 0.2).L(x - w / 2, y + 0.2).L(x - w / 2, y + h * 0.6).Z(), "glass", { tone: 2, stroke: null, alpha: 0.5 });
  // store à rayures et lambrequin festonné
  const aw = new Pen(m);
  const ay = y + h + 0.05, ah = 0.62;
  aw.M(x - w / 2 - 0.25, ay - ah).L(x + w / 2 + 0.25, ay - ah).L(x + w / 2 + 0.1, ay).L(x - w / 2 - 0.1, ay).Z();
  em.add(new Pen(m).rect(x - w / 2 - 0.25, ay - ah - 0.2, w + 0.5, 0.2), "shadow", { kind: "shadow", stroke: null, alpha: 0.4 });
  em.add(aw, "paper", { tone: tone + 1, width: 0.6 });
  const stripes = new Pen(m);
  const n = Math.max(4, Math.round(w / 0.32));
  for (let k = 0; k < n; k += 2) {
    const t0 = k / n, t1 = (k + 1) / n;
    const xa = x - w / 2 - 0.25 + t0 * (w + 0.5), xb = x - w / 2 - 0.25 + t1 * (w + 0.5);
    const xa2 = x - w / 2 - 0.1 + t0 * (w + 0.2), xb2 = x - w / 2 - 0.1 + t1 * (w + 0.2);
    stripes.M(xa, ay - ah).L(xb, ay - ah).L(xb2, ay).L(xa2, ay).Z();
  }
  em.add(stripes, "cloth1", { tone: tone, stroke: null });
  const val = new Pen(m);
  const nv = Math.max(5, Math.round(w / 0.25));
  val.M(x - w / 2 - 0.25, ay - ah);
  for (let k = 0; k < nv; k++) {
    const xa = x - w / 2 - 0.25 + (k / nv) * (w + 0.5), xb = x - w / 2 - 0.25 + ((k + 1) / nv) * (w + 0.5);
    val.Q((xa + xb) / 2, ay - ah - 0.24, xb, ay - ah);
  }
  val.L(x - w / 2 - 0.25, ay - ah + 0.02).Z();
  em.add(val, "cloth1", { tone: tone - 1, width: 0.5 });
  // enseigne : bandeau peint et faux lettrage
  const sy = y + h + 0.2;
  em.add(new Pen(m).rrect(x - w / 2 + 0.1, sy, w - 0.2, 0.42, 0.05), "accent", { tone, width: 0.6 });
  const letters = new Pen(m);
  const nl = Math.max(3, Math.round((w - 0.6) / 0.22));
  for (let k = 0; k < nl; k++) {
    const lx = x - (nl * 0.2) / 2 + k * 0.2;
    if (r.chance(0.85)) letters.rect(lx, sy + 0.1, 0.12, r.chance(0.3) ? 0.26 : 0.2);
  }
  em.add(letters, "paper", { tone: 1, stroke: null });
  // enseigne en potence
  if (r.chance(0.45)) {
    const px = x + w / 2 + 0.25;
    const br = new Pen(m).M(px, sy + 0.6).L(px + 0.75, sy + 0.6).M(px, sy + 0.25).Q(px + 0.4, sy + 0.32, px + 0.7, sy + 0.6);
    em.line(br, "metal", 0.8, { tone: -1 });
    em.add(new Pen(m).ellipse(px + 0.5, sy + 0.22, 0.24, 0.24), "paper", { tone: 0, width: 0.6 });
    em.add(new Pen(m).ellipse(px + 0.5, sy + 0.22, 0.12, 0.12), "accent", { tone: 0, stroke: null });
  }
}

function sideWall(kit: Kit, m: Affine, b: Dims, half: number, tone: number, wallRole: string, rng: Rng, p: Record<string, unknown>, ctx: DrawCtx) {
  const em = kit.em;
  const pen = new Pen(m).M(-half, b.plinth).L(half, b.plinth).L(half, b.top);
  if (b.roof === "gable") {
    pen.L(0, b.top + b.rh - 0.05).L(-half, b.top);
  } else pen.L(-half, b.top);
  pen.Z();
  em.add(pen, wallRole, { tone });
  wallTexture(kit, m, -half, half, b.plinth, b.top, b, tone, wallRole, rng.fork("tex"), Number(p.decay ?? 0.1));
  em.add(new Pen(m).rect(-half - 0.07, 0, half * 2 + 0.14, b.plinth), "stone", { tone: tone - 1 });
  quoins(kit, m, -half, half, b, tone);
  if (b.st !== "chaumiere" && b.st !== "moderne")
    for (let f = 1; f < b.floors; f++) em.add(new Pen(m).rect(-half, b.plinth + f * b.fh, half * 2, 0.12), "trim", { tone, width: 0.5 });
  // fenêtres de pignon
  const frame = frameRoleOf(b.st);
  for (let f = b.D > 8 ? 1 : b.floors; f < b.floors; f++) {
    const r = rng.fork(`w${f}`);
    if (!r.chance(0.6)) continue;
    win(kit, m, 0, b.plinth + f * b.fh + b.fh * 0.22, b.winW, b.winH, b, frame, tone, r, 0.5, 0.1, ctx.env.night, false);
  }
  if (b.roof === "gable") {
    // œil-de-bœuf dans le pignon
    if (b.rh > 1.6 && b.st !== "moderne") {
      const cy = b.top + b.rh * 0.42;
      em.add(new Pen(m).ellipse(0, cy, 0.34, 0.34), "trim", { tone: tone + 1, width: 0.6 });
      em.add(new Pen(m).ellipse(0, cy, 0.24, 0.24), ctx.env.night > 0.3 ? "lamp" : "glass", { tone: -1, width: 0.4, kind: ctx.env.night > 0.3 ? "glow" : "fill" });
    }
    if (b.st === "colombages") {
      const t = new Pen(m).M(-half, b.top).L(half, b.top).L(half, b.top + 0.14).L(-half, b.top + 0.14).Z().M(-0.08, b.top).L(0.08, b.top).L(0.08, b.top + b.rh - 0.2).L(-0.08, b.top + b.rh - 0.2).Z();
      em.add(t, "wood", { tone: tone - 1, width: 0.5 });
    }
  }
}

/* ------------------------------------------------------------------ toits */

function roof(kit: Kit, b: Dims, rng: Rng, p: Record<string, unknown>, ctx: DrawCtx) {
  const em = kit.em;
  const st = b.st;
  const W2 = b.W / 2, D2 = b.D / 2;
  const o = b.over;
  const role = st === "chaumiere" ? "path" : st === "vapeur" ? "metal" : st === "pierre" ? "stone" : "roof";
  const tile = st === "chaumiere" ? "thatch" : st === "vapeur" ? "seam" : st === "pierre" ? "slate" : st === "colombages" ? "scale" : "flat";
  const slopes: { o: [number, number, number]; u: [number, number, number]; v: [number, number, number]; n: [number, number, number]; len: number; w: number; inset: [number, number]; topInset?: number }[] = [];
  if (b.roof === "gable") {
    const half = D2 + o;
    for (const sz of [1, -1]) {
      const n: [number, number, number] = [0, half, sz * b.rh];
      const l = Math.hypot(half, b.rh);
      slopes.push({ o: [-W2 - o, b.top, sz * half], u: [1, 0, 0], v: [0, b.rh / l, (-sz * half) / l], n: [0, n[1] / l, n[2] / l], len: l, w: b.W + 2 * o, inset: [0, 0] });
    }
  } else if (b.roof === "hip" || b.roof === "mansard") {
    const k = b.roof === "hip" ? 0.18 : 0.72;
    const hgt = b.roof === "hip" ? b.rh : b.rh * 0.7;
    const ax = W2 + o, az = D2 + o;
    // quatre pans : avant, arrière, droite, gauche (trapèzes plans)
    for (const [sx, sz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const along = sz !== 0 ? ax : az, across = sz !== 0 ? az : ax;
      const run = across * (1 - k);
      const l = Math.hypot(run, hgt);
      const u: [number, number, number] = sz !== 0 ? [sz, 0, 0] : [0, 0, -sx];
      const origin: [number, number, number] = sz !== 0 ? [-sz * ax, b.top, sz * az] : [sx * ax, b.top, sx * az];
      const v: [number, number, number] = sz !== 0 ? [0, hgt / l, -sz * run / l] : [-sx * run / l, hgt / l, 0];
      const n: [number, number, number] = sz !== 0 ? [0, run / l, sz * hgt / l] : [sx * hgt / l, run / l, 0];
      slopes.push({ o: origin, u, v, n, len: l, w: along * 2, inset: [along * (1 - k), along * (1 - k)] });
    }
  }
  const tone0 = (n: [number, number, number]) => kit.tone(n);
  // ombre du débord sur la façade (avant si visible)
  if (b.roof !== "flat" && kit.vis([0, 0, 1]) > 0) {
    const m = kit.face([0, 0, D2], [1, 0, 0], [0, 1, 0]);
    em.add(new Pen(m).rect(-W2, b.top - 0.42, b.W, 0.42), "shadow", { kind: "shadow", stroke: null, alpha: 0.55 });
  }
  const vis = slopes.filter((s) => kit.vis(s.n) > 1e-3).sort((a, c) => kit.vis(a.n) - kit.vis(c.n));
  for (const s of vis) {
    const m = kit.face(s.o, s.u, s.v);
    const tone = tone0(s.n);
    const W = s.w, L = s.len;
    const xl = (v: number) => (s.inset[0] * v) / L, xr = (v: number) => W - (s.inset[1] * v) / L;
    const outline = new Pen(m).M(0, 0).L(W, 0).L(xr(L), L).L(xl(L), L).Z();
    em.add(outline, role, { tone });
    tiles(kit, m, W, L, xl, xr, tile, tone, role, rng.fork(`t${s.n[0]}${s.n[2]}`));
    // bourrelet de chaume / rive
    if (tile === "thatch") {
      const eave = new Pen(m);
      eave.M(-0.1, -0.2);
      const nn = Math.round(W / 0.5);
      for (let i = 0; i < nn; i++) eave.Q((i + 0.5) * (W / nn), -0.42, (i + 1) * (W / nn), -0.2);
      eave.L(W, 0.25).L(0, 0.25).Z();
      em.add(eave, role, { tone: tone - 1, width: 0.6 });
    } else em.add(new Pen(m).rect(0, -0.04, W, 0.12), role, { tone: tone - 1, width: 0.5 });
  }
  // dessus de croupe / terrasson de mansarde
  if ((b.roof === "hip" || b.roof === "mansard") && kit.vis([0, 1, 0]) > 1e-3) {
    const k = b.roof === "hip" ? 0.18 : 0.72, y = b.top + b.rh * (b.roof === "hip" ? 1 : 0.72);
    const ax = (W2 + o) * k, az = (D2 + o) * k;
    em.add(new Pen().poly([kit.P(-ax, y, az), kit.P(ax, y, az), kit.P(ax, y, -az), kit.P(-ax, y, -az)]), role, { tone: tone0([0, 1, 0]) });
  }
  // fascia (épaisseur du toit au bord de l'égout) côté avant
  if (b.roof !== "flat" && kit.vis([0, 0, 1]) > 0 && st !== "chaumiere") {
    const m = kit.face([0, 0, D2 + o], [1, 0, 0], [0, 1, 0]);
    em.add(new Pen(m).rect(-W2 - o, b.top - 0.16, b.W + 2 * o, 0.16), "trim", { tone: tone0([0, 0, 1]) - 1, width: 0.5 });
  }
  if (b.roof === "gable") {
    // faîtage : tuiles faîtières
    const r0 = kit.P(-W2 - o, b.top + b.rh, 0), r1 = kit.P(W2 + o, b.top + b.rh, 0);
    const ridge = new Pen();
    const k = kit.fr.scale;
    ridge.M(r0[0], r0[1] - 0.06 * k);
    const n = Math.max(3, Math.round((b.W + 2 * o) / 0.45));
    for (let i = 0; i < n; i++) {
      const a = (i + 1) / n;
      const x = r0[0] + (r1[0] - r0[0]) * a, y = r0[1] + (r1[1] - r0[1]) * a;
      const xm = r0[0] + (r1[0] - r0[0]) * (a - 0.5 / n), ym = r0[1] + (r1[1] - r0[1]) * (a - 0.5 / n);
      ridge.Q(xm, ym + 0.2 * k, x, y - 0.06 * k);
    }
    ridge.L(r1[0], r1[1] - 0.12 * k).L(r0[0], r0[1] - 0.12 * k).Z();
    em.add(ridge, st === "chaumiere" ? "leaf2" : role, { tone: st === "chaumiere" ? -1 : 0, width: 0.6 });
    // rives des pignons visibles (oblique)
    for (const sx of [1, -1]) {
      if (kit.vis([sx, 0, 0]) <= 1e-3) continue;
      const a = kit.P(sx * (W2 + o), b.top - 0.05, D2 + o), c = kit.P(sx * (W2 + o), b.top + b.rh, 0), d = kit.P(sx * (W2 + o), b.top - 0.05, -D2 - o);
      const bar = new Pen().M(a[0], a[1]).L(c[0], c[1]).L(d[0], d[1]).L(d[0], d[1] + 0.18 * k).L(c[0], c[1] + 0.18 * k).L(a[0], a[1] + 0.18 * k).Z();
      em.add(bar, st === "colombages" || st === "chaumiere" ? "wood" : "trim", { tone: -1, width: 0.5 });
    }
  }
  if (b.roof === "mansard") {
    // lucarnes sur le brisis avant
    if (kit.vis([0, 0, 1]) > 0)
      for (let bay = 0; bay < b.bays; bay++) {
        const x = b.x0 + (bay + 0.5) * b.bayW;
        const zf = D2 + 0.2;
        const m = kit.face([x, b.top + 0.05, zf], [1, 0, 0], [0, 1, 0]);
        em.add(new Pen(m).M(-0.45, 0).L(0.45, 0).L(0.45, 0.95).Q(0, 1.35, -0.45, 0.95).Z(), "wall", { tone: 0, width: 0.6 });
        em.add(new Pen(m).M(-0.3, 0.12).L(0.3, 0.12).L(0.3, 0.82).Q(0, 1.05, -0.3, 0.82).Z(), ctx.env.night > 0.3 && rng.chance(0.5) ? "lamp" : "glass", { tone: -1, width: 0.45, kind: ctx.env.night > 0.3 ? "glow" : "fill" });
        em.add(new Pen(m).rect(-0.02, 0.12, 0.04, 0.8), "trim", { stroke: null });
        em.add(new Pen(m).M(-0.55, 0.95).Q(0, 1.5, 0.55, 0.95).L(0.55, 1.05).Q(0, 1.62, -0.55, 1.05).Z(), role, { tone: -1, width: 0.5 });
      }
  }
  if (b.roof === "flat") {
    // acrotère et toit-terrasse
    const top = kit.vis([0, 1, 0]) > 1e-3;
    if (top) {
      const pen = new Pen().poly([kit.P(-W2, b.top + 0.04, D2), kit.P(W2, b.top + 0.04, D2), kit.P(W2, b.top + 0.04, -D2), kit.P(-W2, b.top + 0.04, -D2)]);
      em.add(pen, "road", { tone: 0 });
    }
    kit.box(-W2, b.top, D2 - 0.18, W2, b.top + 0.5, D2, "trim", {});
    kit.box(W2 - 0.18, b.top, -D2, W2, b.top + 0.5, D2 - 0.18, "trim", {});
    const vents = rng.int(1, 3);
    for (let i = 0; i < vents; i++) {
      const x = rng.range(-W2 + 1, W2 - 1), z = rng.range(-D2 + 1, D2 - 1.5);
      kit.box(x - 0.3, b.top, z - 0.3, x + 0.3, b.top + 0.45, z + 0.3, "metal", {});
    }
    if (st === "neon" || rng.chance(0.3)) {
      // réservoir sur pieds, cerclé
      const tx = W2 * 0.4, tz = -D2 * 0.3;
      const legs = new Pen();
      for (const dx of [-0.55, 0.55]) {
        const a = kit.P(tx + dx, b.top, tz + 0.5), c = kit.P(tx + dx * 0.9, b.top + 0.8, tz + 0.5);
        legs.M(a[0], a[1]).L(c[0], c[1]);
      }
      em.line(legs, "metal", 1, { tone: -1 });
      const sub = kit.sub(tx, b.top + 0.7, tz);
      sub.lathe([[0.7, 0], [0.72, 0.7], [0.7, 1.4], [0.35, 1.65], [0.02, 1.75]], "wood", { top: false });
      const hoops = new Pen();
      for (const y of [0.35, 1.05]) {
        const a = sub.P(-0.72, y, 0), c = sub.P(0.72, y, 0);
        hoops.M(a[0], a[1]).Q((a[0] + c[0]) / 2, a[1] - 0.12, c[0], c[1]);
      }
      em.line(hoops, "metal", 0.8, { tone: -1 });
    }
  }
  // cheminées
  const nCh = Number(p.chimneys ?? -1) >= 0 ? Number(p.chimneys) : b.roof === "flat" ? 0 : rng.int(0, 2);
  const cr = rng.fork("ch");
  for (let i = 0; i < nCh; i++) {
    const x = W2 - 0.8 + (-b.W + 1.6) * (nCh === 1 ? cr.range(0.15, 0.85) : i / Math.max(1, nCh - 1));
    const z = cr.range(-D2 * 0.3, D2 * 0.2);
    const roofY = b.roof === "gable" ? b.top + b.rh * (1 - Math.abs(z) / (D2 + o)) : b.roofTop;
    if (st === "vapeur") {
      const sub = kit.sub(x, roofY - 0.3, z);
      const h = 2.8;
      sub.lathe([[0.26, 0], [0.24, h * 0.5], [0.22, h], [0.32, h + 0.05], [0.32, h + 0.25], [0.22, h + 0.3]], "metal", { top: true });
      smoke(kit, x, roofY + h, z, cr, ctx);
    } else {
      const h = Math.max(0.9, b.roofTop - roofY + 0.9);
      kit.box(x - 0.32, roofY - 0.4, z - 0.42, x + 0.32, roofY + h, z + 0.42, st === "colombages" || st === "chaumiere" ? "stone" : "wall", {});
      kit.box(x - 0.4, roofY + h, z - 0.5, x + 0.4, roofY + h + 0.12, z + 0.5, "trim", {});
      for (const dx of [-0.14, 0.14]) {
        const sub = kit.sub(x + dx, roofY + h + 0.12, z);
        sub.lathe([[0.08, 0], [0.07, 0.22], [0.09, 0.26]], "roof", { top: true });
      }
      if (cr.chance(0.5)) smoke(kit, x, roofY + h + 0.4, z, cr, ctx);
    }
  }
}

function smoke(kit: Kit, x: number, y: number, z: number, rng: Rng, ctx: DrawCtx) {
  const t = ctx.env.time;
  for (let i = 0; i < 4; i++) {
    const k = (i + (t * 0.25) % 1) / 4;
    const [u, v] = kit.P(x + k * 1.6, y + k * 2.2, z);
    const r = (0.2 + k * 0.5) * kit.fr.scale;
    const pen = new Pen();
    pen.ellipse(u, v, r, r * 0.8);
    kit.em.add(pen, "paper", { tone: -1, stroke: null, alpha: 0.55 * (1 - k * 0.8) });
  }
}

function tiles(kit: Kit, m: Affine, W: number, L: number, xl: (v: number) => number, xr: (v: number) => number, kind: string, tone: number, role: string, rng: Rng) {
  const em = kit.em;
  if (kind === "flat" || kind === "slate") {
    // rangs décalés : ligne de rang + joints verticaux en quinconce, quelques tuiles de ton différent
    const step = kind === "slate" ? 0.24 : 0.3;
    const lines = new Pen(m), alt = new Pen(m), sh = new Pen(m);
    let row = 0;
    for (let v = step; v < L - 0.05; v += step, row++) {
      const a = xl(v), c = xr(v);
      lines.M(a, v).L(c, v);
      sh.M(a, v).L(c, v).L(c, v - 0.05).L(a, v - 0.05).Z();
      const tw = kind === "slate" ? 0.3 : 0.24;
      for (let x = a + (row % 2 ? tw / 2 : 0); x < c; x += tw) {
        lines.M(x, v - step).L(x, v);
        if (rng.chance(0.07)) alt.rect(x + 0.01, v - step + 0.01, Math.min(tw, c - x) - 0.02, step - 0.02);
      }
    }
    if (!alt.empty) em.add(alt, role, { tone: tone + (rng.chance(0.5) ? 1 : -1), stroke: null, alpha: 0.7 });
    em.add(sh, "shadow", { kind: "shadow", stroke: null, alpha: 0.35 });
    em.line(lines, role, 0.35, { tone: tone - 1 });
  } else if (kind === "scale") {
    // écailles : rangs d'arcs en quinconce
    const step = 0.26, tw = 0.26;
    const pen = new Pen(m);
    let row = 0;
    for (let v = step; v < L; v += step, row++) {
      const a = xl(v), c = xr(v);
      pen.M(a, v);
      for (let x = a + (row % 2 ? tw / 2 : 0); x + tw <= c + 0.01; x += tw) {
        pen.M(x, v).Q(x + tw / 2, v - step * 0.95, x + tw, v);
      }
    }
    em.line(pen, role, 0.4, { tone: tone - 1 });
  } else if (kind === "thatch") {
    // chaume : brins courts en lits, crêtes ondulées
    const pen = new Pen(m);
    for (let v = 0.35; v < L - 0.1; v += 0.42) {
      const a = xl(v), c = xr(v);
      for (let x = a + rng.range(0, 0.12); x < c; x += rng.range(0.08, 0.16)) {
        const l = rng.range(0.18, 0.34);
        pen.M(x, v).L(x + rng.range(-0.03, 0.03), v - l);
      }
    }
    em.line(pen, role, 0.4, { tone: tone - 1, alpha: 0.85 });
    const lite = new Pen(m);
    for (let v = 0.5; v < L - 0.1; v += 0.84) lite.M(xl(v), v).Q(W / 2, v + 0.08, xr(v), v).L(xr(v), v + 0.1).Q(W / 2, v + 0.18, xl(v), v + 0.1).Z();
    em.add(lite, role, { tone: tone + 1, stroke: null, alpha: 0.6 });
  } else if (kind === "seam") {
    const pen = new Pen(m);
    for (let x = 0.3; x < W; x += 0.55) pen.M(x, 0).L(x, L);
    em.line(pen, role, 0.45, { tone: tone - 1 });
    const rust = new Pen(m);
    for (let i = 0; i < 4; i++) blobInto(rust, rng.range(0, W), rng.range(0, L * 0.6), rng.range(0.2, 0.5), rng.range(0.2, 0.6), rng.next() * 9);
    em.add(rust, "roof", { tone: -1, stroke: null, alpha: 0.35 });
  }
}
