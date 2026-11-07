/**
 * Végétation et minéral vectoriels, d'après les paramètres de `tree`, `bush`, `grass`, `flowers`, `rock`.
 *
 * Arbres feuillus : tronc et branches en **traits effilés** (empattement, racines), canopée en masses festonnées à
 * 3 tons (ombre, masse, lumière décalée vers le soleil) avec petites touffes de bord ; saison (printemps en fleurs,
 * automne roux, hiver nu), fruits. Bouleau à lenticelles, saule à rameaux pendants, arbre mort tortueux.
 * Conifères en étages dentelés à flanc d'ombre (neige l'hiver), pin parasol, palmier à stipe annelé et palmes
 * pennées. Buissons en lobes, touffes d'herbe en brins effilés, massifs de fleurs à pétales, rochers à facettes
 * (enveloppe taillée, facettes éclairées / ombrées, mousse, fissures).
 */
import { Rng } from "../../core/rng";
import { type P2, Pen, hull, scallop, strokeVar } from "../shape";
import type { Kit } from "./kit";
import type { ObjectDrawer } from "./types";

const leafColor = (season: string, k: number) =>
  season === "autumn" ? (k % 3 === 0 ? "#b5683a" : k % 3 === 1 ? "#c89443" : "#9a5a35") : k % 3 === 2 ? "leaf2" : "leaf";

/** Masse de feuillage à trois tons + touffes de bord. */
function foliage(kit: Kit, m: [number, number, number, number, number, number], cx: number, cy: number, r: number, seed: number, fill: string, opts: { lobes?: number; squash?: number; flat?: number } = {}) {
  const em = kit.em;
  const sq = opts.squash ?? 0.85;
  const lobes = opts.lobes ?? 9;
  const L = kit.L;
  const lx = L[0] < 0 ? -1 : 1; // le soleil vient de -u si L.x < 0
  em.add(scallop(new Pen(m), cx, cy, r, r * sq, seed, lobes, r * 0.2, opts.flat ?? 0.15), fill, { tone: -1 });
  em.add(scallop(new Pen(m), cx + lx * r * 0.1, cy + r * 0.12, r * 0.8, r * 0.7 * sq, seed + 3.1, lobes - 1, r * 0.18, 0.3), fill, { tone: 0, stroke: null });
  em.add(scallop(new Pen(m), cx + lx * r * 0.32, cy + r * 0.36, r * 0.42, r * 0.34 * sq, seed + 7.7, Math.max(5, lobes - 3), r * 0.12, 0.4), fill, { tone: 1, stroke: null });
  // touffes en bord (côté lumière et dessus)
  const t = new Pen(m);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI * (0.25 + 0.5 * ((seed * 0.37 + i * 0.29) % 1)) * (lx < 0 ? 1 : 1);
    const ax = cx + Math.cos(a + (lx < 0 ? 0.4 : -0.4)) * r * 0.92 * (lx < 0 ? -1 : 1) * (i % 2 ? 1 : -0.6), ay = cy + Math.sin(a) * r * sq * 0.92;
    scallop(t, ax, ay, r * 0.17, r * 0.13, seed + i * 5.3, 5, r * 0.05, 0.2);
  }
  em.add(t, fill, { tone: 0, width: 0.5 });
}

type Br = { pts: P2[]; w: number[]; level: number };

function branches(rng: Rng, H: number, sp: string, trunkW: number): { list: Br[]; tips: P2[] } {
  const list: Br[] = [];
  const tips: P2[] = [];
  const maxL = sp === "dead" ? 3 : 2;
  const grow = (x: number, y: number, ang: number, len: number, w: number, level: number) => {
    const n = 4;
    const pts: P2[] = [[x, y]];
    const ws: number[] = [w];
    let a = ang;
    for (let i = 1; i <= n; i++) {
      a += rng.range(-0.18, 0.18) + (level === 0 ? -a * 0.25 : sp === "willow" ? 0.05 * Math.sign(a) : -a * 0.06);
      x += Math.sin(a) * (len / n);
      y += Math.cos(a) * (len / n);
      pts.push([x, y]);
      ws.push(w * (1 - (i / n) * (level === 0 ? 0.45 : 0.75)));
    }
    list.push({ pts, w: ws, level });
    if (level >= maxL) {
      tips.push([x, y]);
      return;
    }
    const kids = level === 0 ? rng.int(3, 4) : rng.int(2, 3);
    for (let k = 0; k < kids; k++) {
      const t = level === 0 ? rng.range(0.42, 0.85) : rng.range(0.35, 0.9);
      const idx = Math.min(n - 1, Math.max(1, Math.round(t * n)));
      const side = k % 2 ? 1 : -1;
      grow(pts[idx][0], pts[idx][1], a + side * rng.range(0.45, 0.95), len * rng.range(0.45, 0.62), ws[idx] * 0.68, level + 1);
    }
    if (rng.chance(0.6)) tips.push([x, y]);
  };
  grow(0, 0, rng.range(-0.06, 0.06), H * (sp === "dead" ? 0.5 : 0.52), trunkW, 0);
  return { list, tips };
}

/** Ombre portée (demi-emprise x, z, hauteur, arrondie) des végétaux et rochers, calculée à part du dessin (gabarits). */
export function natureShadow(gen: string, p: Record<string, unknown>): [number, number, number] | null {
  if (gen === "tree") {
    const H = Number(p.height ?? 7), sp = String(p.species);
    const r = H * (sp === "pine" || sp === "fir" ? 0.2 : sp === "palm" ? 0.32 : sp === "willow" ? 0.36 : 0.3);
    return [r * 0.8, r * 0.55, H * 0.75];
  }
  if (gen === "bush") return [Number(p.size ?? 1) * 0.45, Number(p.size ?? 1) * 0.35, Number(p.size ?? 1) * 0.5];
  if (gen === "rock") return [Number(p.size ?? 1.2) * 0.6, Number(p.size ?? 1.2) * 0.45, Number(p.size ?? 1.2) * 0.35];
  return null;
}

export const drawTree: ObjectDrawer = (kit, p, ctx) => {
  const sp = String(p.species ?? "oak");
  const variant = Number(p.variant ?? 0);
  const H = Number(p.height ?? 7);
  const season = String(p.season ?? "summer");
  const density = Number(p.density ?? 0.7);
  const rng = new Rng(`vtree/${sp}/${variant}`);
  const em = kit.em;
  const m = kit.board(0, 0, 0, ctx.mirror);
  const bark = sp === "birch" ? "paper" : "bark";
  if (sp === "fir" || (sp === "pine" && variant % 2 === 0)) return fir(kit, m, H, rng, season, sp === "pine");
  if (sp === "pine") return umbrellaPine(kit, m, H, rng, season);
  if (sp === "palm") return palm(kit, m, H, rng);
  const trunkW = H * 0.035 * rng.range(0.9, 1.1) * (sp === "birch" ? 0.75 : 1);
  const { list, tips } = branches(rng, H, sp, trunkW);
  // racines + tronc + branches
  const roots = new Pen(m);
  for (const s of [-1, 1]) strokeVar(roots, [[0, trunkW * 0.8], [s * trunkW * 1.6, 0.02], [s * trunkW * 2.6, -0.04]], [trunkW * 0.5, trunkW * 0.25, 0.01]);
  em.add(roots, bark, { tone: -1, width: 0.7 });
  const leafy = sp !== "dead" && !(season === "winter");
  const wood = new Pen(m), woodShade = new Pen(m);
  for (const b of list) {
    const w = b.w.map((x, i) => (b.level === 0 && i === 0 ? x * 1.5 : x));
    strokeVar(wood, b.pts, w, { capStart: b.level === 0 });
    if (b.level === 0) strokeVar(woodShade, b.pts.map(([x, y]): P2 => [x + (kit.L[0] < 0 ? 1 : -1) * w[0] * 0.35, y]), w.map((x) => x * 0.5));
  }
  em.add(wood, bark, { tone: 0, width: 0.8 });
  em.add(woodShade, bark, { tone: -1, stroke: null });
  if (sp === "birch") {
    const marks = new Pen(m);
    for (let i = 0; i < 9; i++) {
      const y = H * 0.05 + i * H * 0.055 + rng.range(-0.1, 0.1);
      const w = trunkW * rng.range(0.5, 1.2);
      marks.M(-w * 0.7 + rng.range(-0.05, 0.05), y).L(w * 0.5, y + 0.03).L(w * 0.4, y + 0.08).Z();
    }
    em.add(marks, "ink", { stroke: null, alpha: 0.85 });
  } else {
    const grain = new Pen(m);
    for (let i = 0; i < 4; i++) {
      const x = rng.range(-trunkW * 0.5, trunkW * 0.5);
      grain.M(x, H * 0.04).Q(x + rng.range(-0.06, 0.06), H * 0.2, x * 0.6, H * 0.36);
    }
    em.line(grain, bark, 0.4, { tone: -2 });
  }
  if (!leafy) {
    if (season === "winter" && sp !== "dead") {
      // neige sur les fourches
      const snow = new Pen(m);
      for (const b of list.filter((q) => q.level <= 1)) {
        const [x, y] = b.pts[2];
        snow.ellipse(x, y + b.w[2] * 1.1, b.w[2] * 1.6, b.w[2] * 0.6);
      }
      em.add(snow, "snow", { tone: 1, width: 0.4 });
    }
    return;
  }
  // canopée : grappes de pointes → masses
  const groups = Math.max(3, Math.min(7, Math.round(3 + density * 4)));
  const sorted = tips.slice().sort((a, b) => Math.atan2(a[0], a[1] - H * 0.5) - Math.atan2(b[0], b[1] - H * 0.5));
  const masses: { x: number; y: number; r: number }[] = [];
  for (let g = 0; g < groups; g++) {
    const part = sorted.slice(Math.floor((g * sorted.length) / groups), Math.floor(((g + 1) * sorted.length) / groups));
    if (!part.length) continue;
    const x = part.reduce((s, q) => s + q[0], 0) / part.length, y = part.reduce((s, q) => s + q[1], 0) / part.length;
    masses.push({ x: x * 0.9, y: y + H * 0.02, r: H * rng.range(0.15, 0.21) * (0.85 + density * 0.3) * (sp === "birch" ? 0.8 : 1) });
  }
  masses.push({ x: 0, y: H * 0.68, r: H * 0.24 * (0.8 + density * 0.3) });
  masses.sort((a, b) => b.y - a.y);
  // masse arrière unifiée (évite les trous), puis masses
  const back = new Pen(m);
  for (const ms of masses) scallop(back, ms.x, ms.y, ms.r * 1.05, ms.r * 0.95, ms.x * 3 + ms.y, 8, ms.r * 0.2, 0.1);
  em.add(back, leafColor(season, 0), { tone: -2, stroke: null });
  if (sp === "willow") {
    const strands = new Pen(m), strands2 = new Pen(m);
    for (let i = 0; i < 26; i++) {
      const ms = masses[i % masses.length];
      const x0 = ms.x + rng.range(-ms.r, ms.r), y0 = ms.y - ms.r * 0.2;
      const len = rng.range(H * 0.3, H * 0.55);
      const bend = rng.range(-0.25, 0.25);
      strokeVar(i % 2 ? strands : strands2, [[x0, y0], [x0 + bend * 0.5, y0 - len * 0.5], [x0 + bend, y0 - len]], [H * 0.018, H * 0.014, H * 0.003]);
    }
    em.add(strands2, "leaf", { tone: -1, stroke: null });
    masses.forEach((ms, i) => foliage(kit, m, ms.x, ms.y, ms.r, variant * 7 + i * 1.3, leafColor(season, i), { squash: 0.7 }));
    em.add(strands, "leaf2", { tone: 0, width: 0.4 });
  } else masses.forEach((ms, i) => foliage(kit, m, ms.x, ms.y, ms.r, variant * 7 + i * 1.3, leafColor(season, i)));
  // fruits, fleurs de printemps
  const dots = new Pen(m);
  const fruit = sp === "fruit";
  if (fruit || season === "spring")
    for (const ms of masses)
      for (let i = 0; i < (fruit ? 4 : 6); i++) {
        const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * ms.r * 0.8;
        dots.ellipse(ms.x + Math.cos(a) * d, ms.y + Math.sin(a) * d * 0.8, H * (fruit ? 0.022 : 0.014), H * (fruit ? 0.022 : 0.014));
      }
  if (!dots.empty) em.add(dots, fruit && season !== "spring" ? "accent" : "flower", { tone: 0, width: 0.4 });
};

function fir(kit: Kit, m: [number, number, number, number, number, number], H: number, rng: Rng, season: string, pine: boolean) {
  const em = kit.em;
  const tw = H * 0.028;
  em.add(strokeVar(new Pen(m), [[0, 0], [0, H * 0.3]], [tw * 1.3, tw]), "bark", { tone: -1, width: 0.7 });
  const tiers = pine ? 6 : 8;
  const base = H * (pine ? 0.24 : 0.12);
  const lx = kit.L[0] < 0 ? -1 : 1;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const y0 = base + (H - base) * t * 0.9;
    const y1 = Math.min(H, y0 + (H - base) * (1.9 / tiers) + H * 0.04);
    const w = H * (pine ? 0.22 : 0.27) * (1 - t * 0.82) * rng.range(0.92, 1.08);
    // bord inférieur dentelé, pointes retombantes
    const pts: P2[] = [];
    const n = 7 + Math.round((1 - t) * 4);
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const x = -w + u * w * 2;
      const droop = (1 - Math.abs(u - 0.5) * 2) * H * 0.015;
      pts.push([x, y0 - (k % 2 ? H * 0.035 : 0) + droop - Math.abs(u - 0.5) * H * 0.03]);
    }
    const tier = new Pen(m).M(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) tier.L(pts[k][0], pts[k][1]);
    tier.Q(w * 0.35, (y0 + y1) * 0.5, 0, y1).Q(-w * 0.35, (y0 + y1) * 0.5, pts[0][0], pts[0][1]).Z();
    em.add(tier, "leaf", { tone: 0, width: 0.6 });
    // flanc d'ombre (côté opposé à la lumière)
    const sh = new Pen(m);
    const half = pts.filter((q) => q[0] * -lx >= -1e-6);
    if (half.length > 1) {
      sh.M(0, y0 - H * 0.01);
      for (const q of lx < 0 ? half : half.slice().reverse()) sh.L(q[0], q[1]);
      sh.Q(-lx * w * 0.35, (y0 + y1) * 0.5, 0, y1).Z();
      em.add(sh, "leaf", { tone: -1, stroke: null });
    }
    // aiguilles : quelques traits clairs côté lumière
    const nd = new Pen(m);
    for (let k = 0; k < 3; k++) {
      const x = lx * w * rng.range(0.2, 0.7), y = y0 + (y1 - y0) * rng.range(0.15, 0.4);
      nd.M(x, y).L(x + lx * w * 0.2, y - H * 0.02);
    }
    em.line(nd, "leaf2", 0.45, { tone: 1 });
    if (season === "winter") {
      const snow = new Pen(m).M(-w * 0.7, y0 + (y1 - y0) * 0.25).Q(0, y0 + (y1 - y0) * 0.55, w * 0.7, y0 + (y1 - y0) * 0.25).Q(w * 0.3, y0 + (y1 - y0) * 0.4, 0, y0 + (y1 - y0) * 0.5).Q(-w * 0.3, y0 + (y1 - y0) * 0.4, -w * 0.7, y0 + (y1 - y0) * 0.25).Z();
      em.add(snow, "snow", { tone: 1, width: 0.4 });
    }
  }
}

function umbrellaPine(kit: Kit, m: [number, number, number, number, number, number], H: number, rng: Rng, season: string) {
  const em = kit.em;
  const tw = H * 0.03;
  const lean = rng.range(-0.12, 0.12) * H;
  const trunk = new Pen(m);
  strokeVar(trunk, [[0, 0], [lean * 0.4, H * 0.35], [lean, H * 0.7]], [tw * 1.5, tw, tw * 0.75]);
  strokeVar(trunk, [[lean * 0.7, H * 0.55], [lean * 0.7 - H * 0.12, H * 0.72]], [tw * 0.55, tw * 0.3]);
  strokeVar(trunk, [[lean * 0.85, H * 0.62], [lean + H * 0.14, H * 0.76]], [tw * 0.55, tw * 0.3]);
  em.add(trunk, "wood", { tone: 0, width: 0.7 });
  const plates = [[lean - H * 0.14, H * 0.76, H * 0.2], [lean + H * 0.15, H * 0.8, H * 0.19], [lean, H * 0.88, H * 0.24]];
  plates.forEach(([x, y, r], i) => foliage(kit, m, x, y, r, i * 3.3 + rng.next(), season === "winter" ? "leaf" : "leaf", { squash: 0.45, lobes: 11, flat: 0.6 }));
}

function palm(kit: Kit, m: [number, number, number, number, number, number], H: number, rng: Rng) {
  const em = kit.em;
  const bend = rng.range(0.15, 0.3) * H * (rng.chance(0.5) ? 1 : -1);
  const tw = H * 0.03;
  const pts: P2[] = [[0, 0], [bend * 0.15, H * 0.3], [bend * 0.55, H * 0.62], [bend, H * 0.9]];
  em.add(strokeVar(new Pen(m), pts, [tw * 1.6, tw * 1.05, tw * 0.9, tw * 0.8]), "bark", { tone: 0, width: 0.7 });
  const rings = new Pen(m);
  for (let i = 1; i < 14; i++) {
    const t = i / 14;
    const x = bend * t * t, y = H * 0.9 * t, w = tw * (1.4 - 0.6 * t);
    rings.M(x - w, y).Q(x, y - w * 0.4, x + w, y);
  }
  em.line(rings, "bark", 0.5, { tone: -2 });
  const top: P2 = [bend, H * 0.9];
  const fronds = 8;
  const back = new Pen(m), front = new Pen(m);
  for (let i = 0; i < fronds; i++) {
    const a = -Math.PI / 2 + ((i + 0.5) / fronds - 0.5) * Math.PI * 1.9;
    const len = H * rng.range(0.36, 0.46);
    const dx = Math.sin(a) * len, droop = (0.15 + Math.abs(Math.sin(a)) * 0.55) * len;
    const spine: P2[] = [top, [top[0] + dx * 0.5, top[1] + len * 0.22 * Math.cos(a) + len * 0.12], [top[0] + dx, top[1] - droop]];
    // palme pennée : contour en dents de scie le long de la nervure
    const n = 12;
    const L: P2[] = [], R: P2[] = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const q = bez(spine[0], spine[1], spine[2], t), q2 = bez(spine[0], spine[1], spine[2], Math.min(1, t + 0.02));
      const nx = -(q2[1] - q[1]), ny = q2[0] - q[0];
      const l = Math.hypot(nx, ny) || 1;
      const w = len * 0.16 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (k % 2 ? 1 : 0.55);
      L.push([q[0] + (nx / l) * w, q[1] + (ny / l) * w - w * 0.5]);
      R.push([q[0] - (nx / l) * w, q[1] - (ny / l) * w - w * 0.5]);
    }
    const tgt = i % 2 ? front : back;
    tgt.poly(L.concat(R.reverse()));
  }
  em.add(back, "leaf", { tone: -1, width: 0.5 });
  const nuts = new Pen(m);
  for (let k = 0; k < 3; k++) nuts.ellipse(top[0] + (k - 1) * tw * 1.3, top[1] - tw * 1.2 - (k % 2) * tw * 0.5, tw * 0.9, tw * 0.9);
  em.add(nuts, "wood", { tone: -1, width: 0.5 });
  em.add(front, "leaf2", { tone: 0, width: 0.5 });
}

const bez = (a: P2, b: P2, c: P2, t: number): P2 => [(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1]];

export const drawBush: ObjectDrawer = (kit, p, ctx) => {
  const S = Number(p.size ?? 1);
  const rng = new Rng(`vbush/${Number(p.variant ?? 0)}`);
  const em = kit.em;
  const m = kit.board(0, 0, 0, ctx.mirror);
  const n = rng.int(3, 5);
  const lobes: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const r = S * rng.range(0.26, 0.36) * (1 - Math.abs(t - 0.5) * 0.5);
    lobes.push({ x: (t - 0.5) * S * 0.75, y: r * 0.85 + rng.range(0, S * 0.08), r });
  }
  lobes.push({ x: rng.range(-0.1, 0.1) * S, y: S * 0.48, r: S * 0.3 });
  lobes.sort((a, b) => b.y - a.y);
  const back = new Pen(m);
  for (const l of lobes) scallop(back, l.x, l.y, l.r * 1.05, l.r * 0.92, l.x * 7 + l.y, 7, l.r * 0.2, 0.5);
  em.add(back, "leaf", { tone: -2, stroke: null });
  lobes.forEach((l, i) => foliage(kit, m, l.x, l.y, l.r, i * 2.7 + Number(p.variant ?? 0), i % 2 ? "leaf2" : "leaf", { lobes: 7, flat: 0.45 }));
  const fl = Number(p.flowers ?? 0);
  if (fl > 0) {
    const f = new Pen(m), c = new Pen(m);
    for (let i = 0; i < Math.round(fl * 14); i++) {
      const l = lobes[i % lobes.length];
      const a = rng.range(0.2, Math.PI - 0.2), d = rng.range(0.3, 0.9) * l.r;
      const x = l.x + Math.cos(a) * d, y = l.y + Math.sin(a) * d * 0.8;
      for (let k = 0; k < 5; k++) {
        const b = (k / 5) * Math.PI * 2;
        f.ellipse(x + Math.cos(b) * S * 0.028, y + Math.sin(b) * S * 0.028, S * 0.026, S * 0.026);
      }
      c.ellipse(x, y, S * 0.014, S * 0.014);
    }
    em.add(f, "flower", { tone: 0, width: 0.35 });
    em.add(c, "lamp", { stroke: null });
  }
};

export const drawGrass: ObjectDrawer = (kit, p, ctx) => {
  const s = Number(p.size ?? 0.35);
  const rng = new Rng(`vgrass/${Number(p.variant ?? 0)}`);
  const m = kit.board(0, 0, 0, ctx.mirror);
  const a = new Pen(m), b = new Pen(m);
  const n = Math.max(4, Math.round(Number(p.blades ?? 9) * 0.8));
  for (let i = 0; i < n; i++) {
    const x0 = rng.range(-0.5, 0.5) * s * 0.35;
    const lean = rng.range(-0.55, 0.55);
    const h = s * rng.range(0.55, 1.1);
    strokeVar(i % 3 ? a : b, [[x0, 0], [x0 + lean * h * 0.3, h * 0.55], [x0 + lean * h * 0.75, h]], [s * 0.028, s * 0.018, s * 0.002], { capEnd: false });
  }
  kit.em.add(a, "grass", { tone: 0, stroke: null });
  kit.em.add(b, "leaf2", { tone: 1, stroke: null });
  if (Number(p.flowers ?? 0) > 0 && rng.chance(Number(p.flowers) * 0.6)) {
    const f = new Pen(m);
    f.ellipse(rng.range(-0.2, 0.2) * s, s * 0.9, s * 0.06, s * 0.05);
    kit.em.add(f, ctx.mirror ? "flower" : "paper", { stroke: null });
  }
};

export const drawFlowers: ObjectDrawer = (kit, p, ctx) => {
  const S = Number(p.size ?? 0.8);
  const n = Math.min(24, Number(p.count ?? 14));
  const rng = ctx.rng.fork("fl");
  const m = kit.board(0, 0, 0);
  const em = kit.em;
  const stems = new Pen(m), leaves = new Pen(m);
  const heads: { x: number; y: number; c: string; r: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = rng.range(-0.5, 0.5) * S, h = rng.range(0.15, 0.42);
    const bend = rng.range(-0.05, 0.05);
    strokeVar(stems, [[x, 0], [x + bend, h * 0.5], [x + bend * 1.5, h]], [0.008, 0.006, 0.004]);
    if (i % 3 === 0) strokeVar(leaves, [[x, h * 0.25], [x + (i % 2 ? 0.05 : -0.05), h * 0.38], [x + (i % 2 ? 0.09 : -0.09), h * 0.36]], [0.004, 0.018, 0.002]);
    heads.push({ x: x + bend * 1.5, y: h, c: rng.chance(0.3) ? "accent" : rng.chance(0.3) ? "paper" : "flower", r: rng.range(0.03, 0.05) });
  }
  em.add(stems, "leaf", { tone: -1, stroke: null });
  em.add(leaves, "leaf2", { tone: 0, stroke: null });
  for (const c of ["flower", "accent", "paper"]) {
    const pet = new Pen(m), ctr = new Pen(m);
    for (const h of heads.filter((q) => q.c === c)) {
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + h.x * 10;
        pet.ellipse(h.x + Math.cos(a) * h.r * 0.7, h.y + Math.sin(a) * h.r * 0.6, h.r * 0.55, h.r * 0.45);
      }
      ctr.ellipse(h.x, h.y, h.r * 0.35, h.r * 0.35);
    }
    if (!pet.empty) {
      em.add(pet, c, { tone: 0, width: 0.35 });
      em.add(ctr, c === "paper" ? "lamp" : "wood", { stroke: null, tone: c === "paper" ? 0 : -1 });
    }
  }
};

export const drawRock: ObjectDrawer = (kit, p, ctx) => {
  const S = Number(p.size ?? 1.2);
  const pieces = Number(p.pieces ?? 3);
  const sharp = Number(p.sharpness ?? 0.6), flat = Number(p.flat ?? 0.3), moss = Number(p.moss ?? 0.2);
  const rng = new Rng(`vrock/${Number(p.variant ?? 0)}`);
  const em = kit.em;
  void ctx;
  const blocks: { x: number; s: number; z: number }[] = [{ x: 0, s: S, z: 0 }];
  for (let k = 1; k < pieces; k++) blocks.push({ x: rng.range(0.55, 0.9) * S * (k % 2 ? 1 : -1), s: S * rng.range(0.25, 0.5), z: k % 2 ? 0.1 : -0.1 });
  blocks.sort((a, b) => a.z - b.z || b.s - a.s);
  const lx = kit.L[0] < 0 ? -1 : 1;
  for (const bl of blocks) {
    const m = kit.board(bl.x, 0, bl.z * S);
    const s = bl.s;
    const n = 7 + Math.round(sharp * 4);
    const raw: P2[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI + rng.range(-0.15, 0.15);
      const r = s * 0.5 * rng.range(0.78, 1.0);
      raw.push([Math.cos(a) * r * 1.15, Math.sin(a) * r * (1 - flat * 0.45) * 0.95]);
    }
    raw.push([s * 0.58, -s * 0.05], [-s * 0.58, -s * 0.05]);
    const h = hull(raw);
    // enfoui : on coupe sous le sol
    const out: P2[] = h.map(([x, y]) => [x, Math.max(-0.02 * s, y)]);
    const body = new Pen(m);
    if (sharp > 0.4) body.poly(out);
    else body.smooth(out, true);
    em.add(body, "stone", { tone: 0 });
    // facettes : éventail depuis un point de crête décalé vers la lumière
    const ridge: P2 = [lx * s * 0.12, s * 0.3 * (1 - flat * 0.4)];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      if (a[1] < 0.01 * s && b[1] < 0.01 * s) continue;
      const nx = b[1] - a[1], ny = -(b[0] - a[0]);
      const l = Math.hypot(nx, ny) || 1;
      const lit = (nx / l) * lx * -1 * 0.8 + (ny / l) * 0.9;
      const tone = lit > 0.55 ? 1 : lit > 0.05 ? 0 : -1;
      if (tone === 0) continue;
      const f = new Pen(m).M(ridge[0], ridge[1]).L(a[0], a[1]).L(b[0], b[1]).Z();
      em.add(f, "stone", { tone, stroke: null, alpha: tone > 0 ? 0.85 : 1 });
    }
    // arêtes et fissure
    const e = new Pen(m);
    for (let i = 0; i < out.length; i += 2) if (out[i][1] > 0.05 * s) e.M(ridge[0], ridge[1]).L(out[i][0] * 0.85 + ridge[0] * 0.15, out[i][1] * 0.85 + ridge[1] * 0.15);
    em.line(e, "stone", 0.4, { tone: -2, alpha: 0.6 });
    if (moss > 0.05) {
      const top = out.filter((q) => q[1] > s * 0.12).sort((a, b) => a[0] - b[0]);
      if (top.length >= 2) {
        const mp = new Pen(m);
        mp.smooth(top.map(([x, y]): P2 => [x, y + s * 0.02]), false, true);
        const th = s * 0.07 * (0.5 + moss);
        const inner = top.slice().reverse().map(([x, y]): P2 => [x * 0.92, y - th * (1 + Math.sin(x * 9) * 0.4)]);
        mp.L(inner[0][0], inner[0][1]);
        mp.smooth(inner, false, false).Z();
        em.add(mp, "leaf2", { tone: 0, width: 0.4 });
      }
    }
  }
};
