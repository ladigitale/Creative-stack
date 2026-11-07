/**
 * Dessinateurs vectoriels complémentaires : plantes (`plant`), espèces d'arbres, silhouettes de buissons taillés,
 * formes de fleurs, types de rochers, et les objets de décor du mobilier urbain, du marché, du jardin, de la terrasse
 * et de la signalétique.
 */
import { Rng } from "../../core/rng";
import { type Affine, type P2, Pen, compose, hull, scallop, strokeVar } from "../shape";
import type { Kit } from "./kit";
import type { DrawCtx, ObjectDrawer } from "./types";

type M = Affine;
const lx = (kit: Kit) => (kit.L[0] < 0 ? 1 : -1); // côté ombré à l'écran

/* ------------------------------------------------------------------ plantes */

export const drawPlant: ObjectDrawer = (kit, p, ctx) => {
  const sp = String(p.species ?? "fern");
  const S = Number(p.size ?? 1);
  const rng = new Rng(`vplant/${sp}/${Number(p.variant ?? 0)}`);
  const m = compose(kit.board(0, 0, 0, ctx.mirror), [S, 0, 0, S, 0, 0]);
  const em = kit.em;
  switch (sp) {
    case "fern": {
      const back = new Pen(m), front = new Pen(m);
      const n = rng.int(7, 10);
      for (let i = 0; i < n; i++) {
        const a = -1.2 + (i / (n - 1)) * 2.4 + rng.range(-0.1, 0.1);
        const len = rng.range(0.35, 0.55);
        const tip: P2 = [Math.sin(a) * len, Math.cos(a) * len * 0.8 + 0.05];
        const mid: P2 = [tip[0] * 0.5, tip[1] * 0.75 + 0.08];
        // fronde pennée : dents de scie le long de la nervure
        const L: P2[] = [], R: P2[] = [];
        for (let k = 0; k <= 10; k++) {
          const t = k / 10;
          const q: P2 = [(1 - t) * (1 - t) * 0 + 2 * (1 - t) * t * mid[0] + t * t * tip[0], 2 * (1 - t) * t * mid[1] + t * t * tip[1]];
          const w = 0.07 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)) * (k % 2 ? 1 : 0.5);
          const nx = -Math.cos(a), ny = Math.sin(a);
          L.push([q[0] + nx * w, q[1] + ny * w]);
          R.push([q[0] - nx * w, q[1] - ny * w]);
        }
        (i % 2 ? front : back).poly(L.concat(R.reverse()));
      }
      em.add(back, "leaf", { tone: -1, width: 0.35 });
      em.add(front, "leaf2", { tone: 0, width: 0.35 });
      break;
    }
    case "tallgrass":
    case "reeds": {
      const reed = sp === "reeds";
      const a = new Pen(m), b = new Pen(m), heads = new Pen(m);
      const n = reed ? 9 : 14;
      const H = reed ? 1.6 : 1.1;
      for (let i = 0; i < n; i++) {
        const x = rng.range(-0.15, 0.15), lean = rng.range(-0.15, 0.15), h = H * rng.range(0.6, 1);
        strokeVar(i % 2 ? a : b, [[x, 0], [x + lean * 0.4, h * 0.6], [x + lean, h]], [reed ? 0.018 : 0.012, 0.01, 0.002], { capEnd: false });
        if (reed && i % 3 === 0) heads.rrect(x + lean * 0.85 - 0.025, h * 0.72, 0.05, h * 0.16, 0.025);
        else if (!reed && i % 2 === 0) heads.ellipse(x + lean, h, 0.02, 0.06);
      }
      em.add(b, reed ? "leaf" : "grass", { tone: -1, stroke: null });
      em.add(a, reed ? "leaf2" : "path", { tone: 0, stroke: null });
      em.add(heads, reed ? "bark" : "path", { tone: reed ? 0 : 1, width: 0.3 });
      break;
    }
    case "waterlily": {
      const pads = new Pen(m);
      for (let i = 0; i < 4; i++) {
        const x = rng.range(-0.25, 0.25), z = rng.range(-0.02, 0.04);
        const r = rng.range(0.1, 0.16);
        pads.M(x, z).L(x + r, z + 0.01).Q(x + r * 0.9, z + r * 0.3, x, z + r * 0.32).Q(x - r * 0.95, z + r * 0.3, x - r, z + 0.01).Z();
      }
      em.add(pads, "leaf2", { tone: 0, width: 0.35 });
      const f = new Pen(m);
      for (let k = 0; k < 5; k++) {
        const a = -0.7 + k * 0.35;
        f.M(0.02, 0.05).Q(0.02 + Math.sin(a) * 0.06, 0.05 + 0.08, 0.02 + Math.sin(a) * 0.09, 0.05 + Math.cos(a) * 0.1).Q(0.02 + Math.sin(a) * 0.02, 0.07, 0.02, 0.05).Z();
      }
      em.add(f, "flower", { tone: 1, width: 0.3 });
      break;
    }
    case "mushrooms": {
      for (let i = 0; i < 3; i++) {
        const x = (i - 1) * 0.08 + rng.range(-0.02, 0.02), h = rng.range(0.08, 0.2), r = rng.range(0.04, 0.08);
        em.add(new Pen(m).rect(x - r * 0.25, 0, r * 0.5, h), "paper", { tone: -1, width: 0.35 });
        em.add(new Pen(m).M(x - r, h).Q(x - r, h + r * 1.1, x, h + r * 1.1).Q(x + r, h + r * 1.1, x + r, h).Q(x, h - r * 0.2, x - r, h).Z(), "accent", { tone: 0, width: 0.4 });
        const sp2 = new Pen(m);
        for (let k = 0; k < 3; k++) sp2.ellipse(x + (k - 1) * r * 0.5, h + r * (0.5 + (k % 2) * 0.25), r * 0.14, r * 0.12);
        em.add(sp2, "paper", { stroke: null });
      }
      break;
    }
    case "stump": {
      const sub = kit.sub(0, 0, 0);
      sub.lathe([[0.3 * S, 0], [0.24 * S, 0.12 * S], [0.22 * S, 0.43 * S]], "bark", { top: true });
      const top = kit.P(0, 0.43 * S, 0);
      const rings = new Pen();
      for (const k of [0.6, 0.35]) rings.ellipse(top[0], top[1], 0.22 * S * k * kit.fr.scale, 0.22 * S * k * kit.pr.ay * kit.fr.scale);
      em.line(rings, "wood", 0.5, { tone: -1 });
      break;
    }
    case "log": {
      em.add(new Pen(m).rrect(-0.62, 0, 1.2, 0.36, 0.17), "bark", { tone: 0 });
      em.add(new Pen(m).rect(-0.55, 0, 1.1, 0.1), "bark", { tone: -1, stroke: null });
      em.add(new Pen(m).ellipse(0.58, 0.18, 0.09, 0.17), "wood", { tone: 1, width: 0.5 });
      em.line(new Pen(m).ellipse(0.58, 0.18, 0.045, 0.09), "wood", 0.4, { tone: -1 });
      const bk = new Pen(m);
      for (let k = 0; k < 6; k++) bk.M(-0.5 + k * 0.18, 0.3).L(-0.42 + k * 0.18, 0.06);
      em.line(bk, "bark", 0.4, { tone: -2 });
      const moss = new Pen(m);
      scallop(moss, -0.2, 0.34, 0.3, 0.06, 2.1, 6, 0.03, 0.7);
      em.add(moss, "leaf2", { stroke: null });
      break;
    }
    case "cactus": {
      const body = new Pen(m);
      strokeVar(body, [[0, 0], [0, 1.0], [0, 2.0]], [0.2, 0.2, 0.18]);
      strokeVar(body, [[0.12, 0.8], [0.45, 0.85], [0.48, 1.4]], [0.11, 0.11, 0.1]);
      strokeVar(body, [[-0.12, 1.1], [-0.4, 1.12], [-0.42, 1.6]], [0.1, 0.1, 0.09]);
      em.add(body, "leaf", { tone: 0 });
      const ribs = new Pen(m);
      for (const x of [-0.08, 0.06]) ribs.M(x, 0.1).L(x, 2.05);
      ribs.M(0.48, 0.95).L(0.48, 1.45).M(-0.42, 1.2).L(-0.42, 1.65);
      em.line(ribs, "leaf", 0.5, { tone: -1 });
      em.add(new Pen(m).rect(lx(kit) * 0.04, 0, lx(kit) * 0.15, 2.0), "leaf", { tone: -1, stroke: null, alpha: 0.6 });
      break;
    }
    case "bamboo": {
      const cul = new Pen(m), nodes = new Pen(m), leaves = new Pen(m);
      for (let i = 0; i < 5; i++) {
        const x = (i - 2) * 0.12 + rng.range(-0.03, 0.03), h = rng.range(3, 4), lean = rng.range(-0.15, 0.15);
        strokeVar(cul, [[x, 0], [x + lean * 0.5, h * 0.5], [x + lean, h]], [0.035, 0.03, 0.02]);
        for (let y = 0.4; y < h; y += 0.45) nodes.M(x + (lean * y) / h - 0.035, y).L(x + (lean * y) / h + 0.035, y);
        for (let k = 0; k < 5; k++) {
          const y = h * rng.range(0.4, 1), bx = x + (lean * y) / h, s = rng.chance(0.5) ? 1 : -1;
          strokeVar(leaves, [[bx, y], [bx + s * 0.18, y - 0.06], [bx + s * 0.32, y - 0.16]], [0.005, 0.03, 0.002]);
        }
      }
      em.add(cul, "leaf2", { tone: 0, width: 0.4 });
      em.line(nodes, "leaf", 0.6, { tone: -1 });
      em.add(leaves, "leaf", { tone: 0, stroke: null });
      break;
    }
    case "ivy": {
      const st = new Pen(m), lv = new Pen(m), lv2 = new Pen(m);
      for (let i = 0; i < 4; i++) {
        let x = (i - 1.5) * 0.1, y = 0;
        const pts: P2[] = [[x, y]];
        while (y < 3) {
          x += rng.range(-0.1, 0.1);
          y += rng.range(0.25, 0.4);
          pts.push([x, y]);
          const l = rng.chance(0.5) ? lv : lv2;
          for (const s of [-1, 1]) {
            const cx = x + s * 0.06, cy = y - 0.05;
            l.M(cx, cy - 0.05).Q(cx + 0.06, cy, cx, cy + 0.06).Q(cx - 0.06, cy, cx, cy - 0.05).Z();
          }
        }
        strokeVar(st, pts, pts.map(() => 0.01));
      }
      em.add(st, "bark", { stroke: null });
      em.add(lv, "leaf", { tone: 0, width: 0.3 });
      em.add(lv2, "leaf2", { tone: 1, width: 0.3 });
      break;
    }
    case "lavender": {
      em.add(scallop(new Pen(m), 0, 0.15, 0.22, 0.16, 1.7, 8, 0.03, 0.6), "leaf2", { tone: -1, width: 0.35 });
      const stems = new Pen(m), spikes = new Pen(m);
      for (let i = 0; i < 14; i++) {
        const a = -0.6 + (i / 13) * 1.2, h = rng.range(0.5, 0.7);
        const tip: P2 = [Math.sin(a) * h * 0.6, 0.15 + Math.cos(a) * h * 0.8];
        stems.M(0, 0.15).L(tip[0] * 0.7, 0.15 + (tip[1] - 0.15) * 0.7);
        spikes.ellipse(tip[0], tip[1], 0.025, 0.07);
      }
      em.line(stems, "leaf2", 0.4);
      em.add(spikes, "#8c76b8", { tone: 0, width: 0.3 });
      break;
    }
    default:
      em.add(scallop(new Pen(m), 0, 0.2, 0.3, 0.2, 1, 7, 0.04, 0.5), "leaf", { tone: 0 });
  }
};

/* ------------------------------------------------------------------ buissons taillés, fleurs, rochers */

export function drawTopiary(kit: Kit, shape: string, S: number, p: Record<string, unknown>, ctx: DrawCtx) {
  const em = kit.em;
  const m = compose(kit.board(0, 0, 0, ctx.mirror), [S, 0, 0, S, 0, 0]);
  const L = lx(kit);
  const bumpy = (pen: Pen, pts: P2[], amp: number) => {
    pen.M(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const nx = b[1] - a[1], ny = -(b[0] - a[0]), l = Math.hypot(nx, ny) || 1;
      pen.Q(mx + (nx / l) * amp, my + (ny / l) * amp, b[0], b[1]);
    }
    return pen.Z();
  };
  const fill = (pts: P2[], amp: number, light: (q: P2) => boolean) => {
    em.add(bumpy(new Pen(m), pts, amp), "leaf", { tone: 0 });
    const sh = pts.map((q): P2 => [q[0] * 0.98 + L * 0.06, q[1]]).filter((q) => q[0] * L > 0);
    if (sh.length > 2) em.add(new Pen(m).smooth([...sh, [0, sh[sh.length - 1][1]], [0, sh[0][1]]], true), "leaf", { tone: -1, stroke: null, alpha: 0.7 });
    const hl = pts.filter(light);
    if (hl.length > 2) em.add(new Pen(m).smooth(hl.map((q): P2 => [q[0] * 0.7 - L * 0.08, q[1] * 0.92 + 0.05]), true), "leaf2", { tone: 1, stroke: null, alpha: 0.6 });
  };
  const ring = (cx: number, cy: number, rx: number, ry: number, n: number): P2[] => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * rx, cy + Math.sin((i / n) * Math.PI * 2) * ry] as P2);
  switch (shape) {
    case "ball": {
      em.add(new Pen(m).rect(-0.05, 0, 0.1, 0.25), "bark", { width: 0.4 });
      fill(ring(0, 0.6, 0.42, 0.42, 22), 0.03, (q) => q[1] > 0.7 && q[0] * L < 0);
      break;
    }
    case "cone": {
      const pts: P2[] = [[-0.45, 0.05], [0.45, 0.05], ...Array.from({ length: 10 }, (_, i) => [0.45 * (1 - (i + 1) / 10), 0.05 + 1.85 * ((i + 1) / 10)] as P2), ...Array.from({ length: 9 }, (_, i) => [-0.45 * ((i + 1) / 10), 1.9 - 1.85 * ((i + 1) / 10)] as P2)];
      fill(pts, 0.025, (q) => q[0] * L < 0 && q[1] > 0.3);
      break;
    }
    case "spiral": {
      const pts: P2[] = [[-0.42, 0.05], [0.42, 0.05], [0, 1.9]];
      em.add(new Pen(m).poly(pts), "leaf", { tone: 0 });
      const groove = new Pen(m);
      for (let t = 0; t < 1; t += 0.02) {
        const y = 0.05 + t * 1.8, w = 0.42 * (1 - t);
        const x = Math.sin(t * Math.PI * 9) * w;
        if (Math.cos(t * Math.PI * 9) > 0) (t === 0 ? groove.M(x, y) : groove.L(x, y));
        else groove.M(x, y);
      }
      em.line(groove, "leaf", 1.6, { tone: -2 });
      break;
    }
    case "box": {
      em.add(new Pen(m).rrect(-0.5, 0.02, 1.0, 0.78, 0.08), "leaf", { tone: 0 });
      em.add(new Pen(m).rrect(L > 0 ? 0.15 : -0.5, 0.02, 0.35, 0.78, 0.08), "leaf", { tone: -1, stroke: null, alpha: 0.7 });
      const dots = new Pen(m);
      for (let i = 0; i < 18; i++) dots.ellipse(-0.42 + (i % 6) * 0.17, 0.12 + Math.floor(i / 6) * 0.25, 0.05, 0.035);
      em.add(dots, "leaf2", { tone: 1, stroke: null, alpha: 0.5 });
      break;
    }
    case "cloud": {
      const tr = new Pen(m);
      strokeVar(tr, [[0, 0], [0.1, 0.5], [-0.05, 0.9], [0.05, 1.3]], [0.06, 0.05, 0.04, 0.03]);
      strokeVar(tr, [[0.08, 0.55], [0.4, 0.7]], [0.03, 0.02]);
      strokeVar(tr, [[-0.03, 0.85], [-0.38, 0.98]], [0.03, 0.02]);
      em.add(tr, "bark", { width: 0.45 });
      for (const [x, y, r] of [[0.42, 0.72, 0.22], [-0.4, 1.0, 0.2], [0.05, 1.32, 0.26]] as const) {
        em.add(scallop(new Pen(m), x, y, r, r * 0.45, x * 7, 7, 0.03, 0.7), "leaf", { tone: 0 });
        em.add(scallop(new Pen(m), x - L * r * 0.15, y + r * 0.12, r * 0.7, r * 0.25, x * 5, 6, 0.02, 0.5), "leaf2", { tone: 1, stroke: null });
      }
      break;
    }
  }
  void p;
}

export function drawFlowerKind(kit: Kit, kind: string, p: Record<string, unknown>, ctx: DrawCtx) {
  const S = Number(p.size ?? 0.8);
  const n = Math.min(24, Number(p.count ?? 14));
  const rng = ctx.rng.fork("fk");
  const m = kit.board(0, 0, 0);
  const em = kit.em;
  const stems = new Pen(m), heads = new Pen(m), centers = new Pen(m), leaves = new Pen(m);
  const color = kind === "daisy" ? "paper" : kind === "spike" ? "#8c76b8" : kind === "bell" ? "#9fb3d9" : rng.pick(["flower", "accent", "flower"]);
  for (let i = 0; i < n; i++) {
    const x = rng.range(-0.5, 0.5) * S, h = rng.range(0.18, 0.45);
    const bend = rng.range(-0.04, 0.04);
    const tx = x + bend, ty = h;
    strokeVar(stems, [[x, 0], [x + bend * 0.5, h * 0.5], [tx, ty]], [0.007, 0.005, 0.004]);
    if (i % 3 === 0) strokeVar(leaves, [[x, h * 0.2], [x + (i % 2 ? 0.05 : -0.05), h * 0.35], [x + (i % 2 ? 0.08 : -0.08), h * 0.33]], [0.003, 0.016, 0.002]);
    const r = rng.range(0.03, 0.045);
    if (kind === "round") heads.ellipse(tx, ty, r, r);
    else if (kind === "daisy") {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        heads.ellipse(tx + Math.cos(a) * r * 0.8, ty + Math.sin(a) * r * 0.6, r * 0.45, r * 0.25);
      }
      centers.ellipse(tx, ty, r * 0.35, r * 0.3);
    } else if (kind === "tulip") heads.M(tx - r, ty).L(tx - r, ty + r * 1.4).L(tx - r * 0.4, ty + r).L(tx, ty + r * 1.6).L(tx + r * 0.4, ty + r).L(tx + r, ty + r * 1.4).L(tx + r, ty).Q(tx, ty - r * 0.6, tx - r, ty).Z();
    else if (kind === "spike") for (let k = 0; k < 5; k++) heads.ellipse(tx, ty + k * r * 0.7, r * 0.5, r * 0.4);
    else if (kind === "bell") for (let k = 0; k < 3; k++) heads.M(tx + k * 0.03 - r * 0.5, ty - k * 0.04).Q(tx + k * 0.03, ty - k * 0.04 + r * 1.2, tx + k * 0.03 + r * 0.5, ty - k * 0.04).L(tx + k * 0.03 + r * 0.6, ty - k * 0.04 - r * 0.5).Q(tx + k * 0.03, ty - k * 0.04 - r * 0.2, tx + k * 0.03 - r * 0.6, ty - k * 0.04 - r * 0.5).Z();
  }
  em.add(stems, "leaf", { tone: -1, stroke: null });
  em.add(leaves, "leaf2", { tone: 0, stroke: null });
  em.add(heads, color, { tone: 0, width: 0.3 });
  if (!centers.empty) em.add(centers, "lamp", { stroke: null });
}

export function drawRockKind(kit: Kit, kind: string, p: Record<string, unknown>, ctx: DrawCtx): boolean {
  const S = Number(p.size ?? 1.2);
  const rng = new Rng(`vrockk/${kind}/${Number(p.variant ?? 0)}`);
  const em = kit.em;
  const L = lx(kit);
  const stone = (cx: number, cz: number, r: number, h: number, sharp: number) => {
    const m = kit.board(cx, 0, cz);
    const raw: P2[] = [];
    const n = 6 + Math.round(sharp * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI + rng.range(-0.15, 0.15);
      raw.push([Math.cos(a) * r * rng.range(0.8, 1), Math.sin(a) * h * rng.range(0.75, 1)]);
    }
    raw.push([r, -0.01], [-r, -0.01]);
    const out = hull(raw);
    em.add(sharp > 0.4 ? new Pen(m).poly(out) : new Pen(m).smooth(out, true), "stone", { tone: 0, width: 0.6 });
    const sh = out.filter((q) => q[0] * L > r * 0.15);
    if (sh.length > 1) em.add(new Pen(m).poly([[L * r * 0.15, 0], ...sh.sort((a, b) => b[1] - a[1]), [L * r * 0.15, h * 0.6]]), "stone", { tone: -1, stroke: null, alpha: 0.8 });
    em.add(new Pen(m).poly(out.filter((q) => q[1] > h * 0.55)), "stone", { tone: 1, stroke: null, alpha: 0.7 });
  };
  switch (kind) {
    case "pebbles":
    case "scree": {
      const n = kind === "scree" ? 14 : 9;
      const list = Array.from({ length: n }, () => ({ x: rng.range(-0.65, 0.65) * S, z: rng.range(-0.6, 0.6) * S, r: rng.range(0.05, kind === "scree" ? 0.18 : 0.12) * S }));
      list.sort((a, b) => a.z - b.z);
      for (const q of list) stone(q.x, q.z, q.r, q.r * (kind === "scree" ? 0.8 : 0.55), kind === "scree" ? 0.8 : 0);
      return true;
    }
    case "slab": {
      const m = kit.board(0, 0, 0);
      em.add(new Pen(m).poly([[-0.5 * S, 0], [0.5 * S, 0], [0.45 * S, 0.08 * S], [-0.42 * S, 0.1 * S]]), "stone", { tone: 0, width: 0.6 });
      const q = [kit.P(-0.42 * S, 0.1 * S, -0.35 * S), kit.P(0.45 * S, 0.08 * S, -0.4 * S), kit.P(0.45 * S, 0.08 * S, 0.4 * S), kit.P(-0.5 * S, 0.1 * S, 0.38 * S)];
      em.add(new Pen().poly(q), "stone", { tone: 1, width: 0.5 });
      return true;
    }
    case "steps": {
      for (let k = 3; k >= -3; k--) {
        const z = k * 0.48 * S;
        const c = kit.P(rng.range(-0.1, 0.1) * S, 0.06, z);
        const r = rng.range(0.25, 0.35) * S * kit.fr.scale;
        em.add(new Pen().ellipse(c[0], c[1], r, Math.max(r * kit.pr.ay * 1.1, r * 0.18)), "stone", { tone: 1, width: 0.5 });
        em.add(new Pen().M(c[0] - r, c[1]).Q(c[0], c[1] - r * 0.35, c[0] + r, c[1]).L(c[0] + r, c[1] - 0.05 * S * kit.fr.scale).Q(c[0], c[1] - r * 0.4, c[0] - r, c[1] - 0.05 * S * kit.fr.scale).Z(), "stone", { tone: -1, stroke: null });
      }
      return true;
    }
    case "cliff": {
      const m = kit.board(0, 0, 0);
      const W = 1.1 * S, H = 0.9 * S;
      const pts: P2[] = [[-W, 0]];
      for (let i = 0; i <= 8; i++) pts.push([-W * 0.9 + (i / 8) * W * 1.8, H * (0.75 + 0.25 * Math.sin(i * 1.7 + rng.next())) * (1 - Math.abs(i - 4) / 10)]);
      pts.push([W, 0]);
      em.add(new Pen(m).poly(pts), "stone", { tone: 0, width: 0.7 });
      // strates et diaclases, facettes d'ombre
      const st = new Pen(m);
      for (let y = 0.18 * S; y < H; y += 0.18 * S) st.M(-W * 0.95, y).Q(0, y + rng.range(-0.05, 0.05) * S, W * 0.95, y + rng.range(-0.05, 0.05) * S);
      for (let k = 0; k < 6; k++) {
        const x = rng.range(-W * 0.8, W * 0.8);
        st.M(x, 0).L(x + rng.range(-0.1, 0.1) * S, H * rng.range(0.4, 0.8));
      }
      em.line(st, "stone", 0.5, { tone: -2, alpha: 0.7 });
      for (let k = 0; k < 4; k++) {
        const x = rng.range(-W * 0.8, W * 0.6);
        em.add(new Pen(m).poly([[x, 0], [x + 0.25 * S, 0], [x + 0.18 * S, H * 0.6], [x + 0.05 * S, H * 0.7]]), "stone", { tone: -1, stroke: null, alpha: 0.75 });
      }
      em.add(scallop(new Pen(m), 0, H * 0.95, W * 0.6, 0.08 * S, 3.3, 9, 0.03, 0.6), "leaf2", { tone: 0, width: 0.35 });
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ objets de décor */

export const MORE_PROPS: Record<string, (kit: Kit, size: number, variant: number, ctx: DrawCtx) => void> = {
  fountain(kit, size, _v, ctx) {
    const R = 1.6 * size;
    const em = kit.em;
    kit.lathe([[R, 0], [R, 0.55], [R + 0.08, 0.55], [R + 0.08, 0.62]], "stone", {});
    const m = kit.board();
    const t = ctx.env.time;
    const jets = new Pen(m);
    for (const s of [-1, -0.4, 0.4, 1]) jets.M(s * 0.7, 1.55).Q(s * 1.1, 1.45 + Math.sin(t * 3 + s) * 0.03, s * 1.2, 0.55);
    jets.M(0, 2.2).Q(0.05, 2.55, 0.08, 2.2).M(0, 2.2).Q(-0.05, 2.55, -0.08, 2.2);
    em.line(jets, "water", 1.4, { tone: 2, alpha: 0.85 });
    kit.sub(0, 0.15, 0).lathe([[0.3, 0], [0.22, 0.3], [0.16, 1.1], [0.26, 1.2]], "stone", {});
    kit.sub(0, 1.3, 0).lathe([[0.1, 0], [0.75, 0.12], [0.8, 0.3]], "trim", {});
    kit.sub(0, 1.55, 0).lathe([[0.08, 0], [0.06, 0.4], [0.12, 0.5], [0.01, 0.65]], "stone", {});
    const wv = new Pen(m);
    for (let k = 0; k < 4; k++) wv.M(-R + 0.3 + k * 0.7, 0.5).Q(-R + 0.65 + k * 0.7, 0.55, -R + 1 + k * 0.7, 0.5);
    em.line(wv, "water", 0.8, { tone: 2 });
  },
  kiosk(kit, size) {
    const R = 3 * size, em = kit.em;
    kit.lathe([[R + 0.35, 0], [R + 0.35, 1.05]], "stone", {});
    const m = kit.board(0, 1.05, 0);
    const posts = new Pen(m);
    for (const x of [-1, -0.7, -0.25, 0.25, 0.7, 1]) posts.rect(x * R - 0.06, 0, 0.12, 3);
    em.add(posts, "metal", { tone: -1, width: 0.45 });
    const rail = new Pen(m);
    for (let x = -R; x <= R; x += 0.18) rail.M(x, 0).L(x, 0.9);
    rail.M(-R, 0.9).L(R, 0.9);
    em.line(rail, "metal", 0.6, { tone: -1 });
    const lam = new Pen(m).M(-R - 0.3, 3);
    for (let k = 0; k < 12; k++) lam.Q(-R - 0.3 + (k + 0.5) * ((2 * R + 0.6) / 12), 2.75, -R - 0.3 + (k + 1) * ((2 * R + 0.6) / 12), 3);
    lam.L(R + 0.3, 3.2).L(-R - 0.3, 3.2).Z();
    em.add(lam, "paper", { tone: 0, width: 0.45 });
    kit.sub(0, 4.25, 0).lathe([[R + 0.4, 0], [R * 0.6, 0.9], [0.15, 1.9], [0.02, 2.2]], "roof", { top: false });
    kit.sub(0, 4.0, 0).lathe([[R + 0.4, 0], [R + 0.4, 0.25]], "accent", { top: false });
  },
  busstop(kit) {
    const { m } = kit.elev(), em = kit.em;
    em.add(new Pen(m).rect(-1.55, 0, 0.08, 2.5).rect(1.47, 0, 0.08, 2.5), "metal", { tone: -1, width: 0.4 });
    em.add(new Pen(m).rect(-1.5, 0.3, 3, 2.1), "glass", { tone: 0, alpha: 0.55, width: 0.4 });
    em.add(new Pen(m).M(-1.65, 2.5).L(1.65, 2.5).L(1.6, 2.7).L(-1.6, 2.7).Z(), "metal", { tone: 1, width: 0.5 });
    em.add(new Pen(m).rect(-1.2, 0.45, 2.4, 0.08), "wood", { width: 0.4 });
    em.add(new Pen(m).rect(0.6, 0.9, 0.8, 1.3), "paper", { tone: 0, width: 0.4 });
    em.add(new Pen(m).rect(0.68, 1.4, 0.64, 0.7), "accent", { stroke: null });
  },
  billboard(kit, _s, variant) {
    const { m } = kit.elev(), em = kit.em;
    em.add(new Pen(m).rect(-1.0, 0, 0.1, 1.2).rect(0.9, 0, 0.1, 1.2), "wood", { tone: -1, width: 0.4 });
    em.add(new Pen(m).rect(-1.3, 1.1, 2.6, 1.5), "paper", { tone: 0, width: 0.6 });
    em.add(new Pen(m).rect(-1.2, 1.2, 2.4, 1.3), ["accent", "water", "leaf2"][variant % 3], { tone: 0, stroke: null });
    em.add(new Pen(m).ellipse(-0.5, 1.85, 0.42, 0.42), "paper", { tone: 1, stroke: null });
    const tx = new Pen(m);
    for (let k = 0; k < 3; k++) tx.rrect(0.1, 2.1 - k * 0.25, 0.9 - k * 0.2, 0.12, 0.05);
    em.add(tx, "paper", { stroke: null });
  },
  pillar(kit, _s, variant) {
    const em = kit.em;
    kit.lathe([[0.66, 0], [0.62, 0.3], [0.6, 2.8]], "leaf2", {});
    const m = kit.board();
    const posters = new Pen(m);
    posters.rect(-0.5, 0.6, 0.45, 0.8).rect(0.05, 0.9, 0.4, 0.9).rect(-0.3, 1.6, 0.55, 0.9);
    em.add(posters, ["paper", "accent", "cloth3"][variant % 3], { tone: 0, width: 0.35 });
    em.add(new Pen(m).rect(-0.25, 1.75, 0.3, 0.1).rect(0.1, 1.2, 0.25, 0.08), "ink", { stroke: null, alpha: 0.7 });
    kit.sub(0, 2.8, 0).lathe([[0.68, 0], [0.62, 0.2], [0.3, 0.5], [0.05, 0.62]], "leaf2", { top: false });
  },
  bin(kit) {
    kit.lathe([[0.22, 0], [0.25, 0.85], [0.27, 0.9]], "leaf2", {});
    const m = kit.board(), em = kit.em;
    const sl = new Pen(m);
    for (const x of [-0.15, -0.05, 0.05, 0.15]) sl.M(x, 0.1).L(x * 1.1, 0.8);
    em.line(sl, "leaf2", 0.5, { tone: -1 });
  },
  lamp2(kit, _s, _v, ctx) {
    const { m } = kit.elev(), em = kit.em;
    kit.lathe([[0.16, 0], [0.12, 0.2], [0.08, 0.5]], "metal", { top: false });
    em.add(strokeVar(new Pen(m), [[0, 0.4], [0, 3.6]], [0.06, 0.045]), "metal", { width: 0.5 });
    for (const s of [-1, 1]) {
      em.add(strokeVar(new Pen(m), [[0, 3.3], [s * 0.35, 3.62], [s * 0.7, 3.55]], [0.03, 0.03, 0.025]), "metal", { width: 0.45 });
      if (ctx.env.night > 0.2) em.add(new Pen(m).ellipse(s * 0.7, 3.3, 1.3, 1.3), "lamp", { kind: "halo", stroke: null, alpha: 0.7 });
      em.add(new Pen(m).M(s * 0.7 - 0.15, 3.55).L(s * 0.7 + 0.15, 3.55).L(s * 0.7 + 0.1, 3.15).L(s * 0.7 - 0.1, 3.15).Z(), "lamp", { kind: ctx.env.night > 0.2 ? "glow" : "fill", tone: ctx.env.night > 0.2 ? 0 : -1, width: 0.45 });
      em.add(new Pen(m).M(s * 0.7 - 0.22, 3.55).Q(s * 0.7, 3.75, s * 0.7 + 0.22, 3.55).Z(), "metal", { width: 0.45 });
    }
    em.add(new Pen(m).ellipse(0, 3.85, 0.08, 0.08), "metal", { width: 0.4 });
  },
  clock(kit) {
    const { m } = kit.elev(), em = kit.em;
    kit.lathe([[0.2, 0], [0.12, 0.3], [0.08, 2.9]], "metal", { top: false });
    for (const y of [3.3]) {
      em.add(new Pen(m).ellipse(0, y, 0.42, 0.42), "metal", { width: 0.6 });
      em.add(new Pen(m).ellipse(0, y, 0.34, 0.34), "paper", { tone: 1, width: 0.4 });
      const ticks = new Pen(m);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        ticks.M(Math.cos(a) * 0.28, y + Math.sin(a) * 0.28).L(Math.cos(a) * 0.32, y + Math.sin(a) * 0.32);
      }
      ticks.M(0, y).L(0.15, y + 0.12).M(0, y).L(-0.04, y + 0.25);
      em.line(ticks, "ink", 0.9);
    }
    em.add(new Pen(m).ellipse(0, 3.82, 0.08, 0.1), "metal", { width: 0.4 });
  },
  hydrant(kit) {
    kit.lathe([[0.16, 0], [0.13, 0.08], [0.12, 0.75], [0.14, 0.8], [0.1, 0.92], [0.02, 1.0]], "accent", {});
    const m = kit.board();
    kit.em.add(new Pen(m).rrect(-0.24, 0.5, 0.48, 0.1, 0.04), "accent", { tone: -1, width: 0.4 });
    kit.em.add(new Pen(m).rect(-0.13, 0.75, 0.26, 0.05), "metal", { stroke: null });
  },
  awningstall(kit, _s, variant) {
    const { m } = kit.elev(), em = kit.em;
    em.add(new Pen(m).rect(-1.3, 0, 0.08, 2.2).rect(1.22, 0, 0.08, 2.2), "wood", { tone: -1, width: 0.4 });
    em.add(new Pen(m).rect(-1.3, 0, 2.6, 0.9), "wood", { tone: 0, width: 0.55 });
    const goods = new Pen(m);
    for (let i = 0; i < 9; i++) goods.ellipse(-1.15 + i * 0.29, 0.98 + (i % 2) * 0.04, 0.13, 0.11);
    em.add(goods, ["flower", "leaf2", "accent", "lamp"][variant % 4], { tone: 0, width: 0.35 });
    const st = new Pen(m), cl = ["accent", "leaf2", "water", "cloth1"][variant % 4];
    em.add(new Pen(m).M(-1.45, 2.05).L(1.45, 2.05).L(1.3, 2.45).L(-1.3, 2.45).Z(), "paper", { tone: 1, width: 0.5 });
    for (let k = 0; k < 8; k += 2) st.M(-1.45 + k * 0.3625, 2.05).L(-1.45 + (k + 1) * 0.3625, 2.05).L(-1.3 + (k + 1) * 0.325, 2.45).L(-1.3 + k * 0.325, 2.45).Z();
    em.add(st, cl, { stroke: null });
    const val = new Pen(m).M(-1.45, 2.05);
    for (let k = 0; k < 9; k++) val.Q(-1.45 + (k + 0.5) * (2.9 / 9), 1.82, -1.45 + (k + 1) * (2.9 / 9), 2.05);
    em.add(val.Z(), cl, { tone: -1, width: 0.45 });
  },
  baskets(kit, _s, variant) {
    const m = kit.board(), em = kit.em;
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * 0.5;
      em.add(new Pen(m).ellipse(x, 0.42, 0.22, 0.08), ["flower", "leaf2", "lamp"][(i + variant) % 3], { tone: 0, width: 0.4 });
      em.add(new Pen(m).M(x - 0.24, 0.42).L(x + 0.24, 0.42).L(x + 0.18, 0).L(x - 0.18, 0).Z(), "path", { tone: 0, width: 0.5 });
      const wv = new Pen(m);
      for (let y = 0.08; y < 0.4; y += 0.08) wv.M(x - 0.2, y).L(x + 0.2, y);
      em.line(wv, "path", 0.4, { tone: -1 });
    }
  },
  fruitcrates(kit, _s, variant) {
    const em = kit.em;
    kit.box(-0.65, 0, -0.3, 0.65, 0.4, 0.3, "wood", {});
    const m = kit.board(0, 0.4, 0.3);
    const f = new Pen(m);
    for (let i = 0; i < 9; i++) f.ellipse(-0.55 + i * 0.137, 0.06 + (i % 2) * 0.03, 0.07, 0.065);
    em.add(f, ["accent", "lamp", "leaf2", "flower"][variant % 4], { tone: 0, width: 0.35 });
    em.line(new Pen(kit.board(0, 0, 0.3)).M(-0.65, 0.2).L(0.65, 0.2).M(0, 0).L(0, 0.4), "wood", 0.5, { tone: -1 });
  },
  sacks(kit) {
    const m = kit.board(), em = kit.em;
    for (const [x, y, s] of [[-0.35, 0, 1], [0.35, 0, 0.9], [0, 0.32, 0.85]] as const) {
      em.add(new Pen(m).M(x - 0.3 * s, y).Q(x - 0.36 * s, y + 0.4 * s, x - 0.12 * s, y + 0.5 * s).L(x, y + 0.62 * s).L(x + 0.12 * s, y + 0.5 * s).Q(x + 0.36 * s, y + 0.4 * s, x + 0.3 * s, y).Z(), "cloth3", { tone: 0, width: 0.5 });
      em.line(new Pen(m).M(x - 0.1 * s, y + 0.5 * s).L(x + 0.1 * s, y + 0.5 * s), "leather", 0.8);
    }
  },
  wheelbarrow(kit) {
    const { m } = kit.elev(), em = kit.em;
    em.add(new Pen(m).ellipse(0.65, 0.2, 0.2, 0.2), "ink", { width: 0.5 });
    em.add(new Pen(m).M(-0.45, 0.65).L(0.55, 0.65).L(0.35, 0.3).L(-0.3, 0.3).Z(), "metal", { tone: 0, width: 0.55 });
    em.add(strokeVar(new Pen(m), [[0.65, 0.2], [0, 0.32], [-0.85, 0.5]], [0.025, 0.025, 0.02]), "wood", { width: 0.4 });
    em.add(new Pen(m).rect(-0.3, 0, 0.04, 0.32), "wood", { stroke: null });
    em.add(scallop(new Pen(m), 0.05, 0.68, 0.42, 0.08, 1.2, 7, 0.03, 0.6), "ground", { tone: -1, width: 0.35 });
  },
  wateringcan(kit) {
    const m = kit.board(), em = kit.em;
    em.add(new Pen(m).rrect(-0.15, 0, 0.3, 0.26, 0.04), "leaf2", { tone: 0, width: 0.45 });
    em.add(strokeVar(new Pen(m), [[0.13, 0.08], [0.3, 0.22], [0.36, 0.3]], [0.02, 0.015, 0.012]), "leaf2", { width: 0.4 });
    em.line(new Pen(m).M(-0.12, 0.26).Q(0, 0.42, 0.12, 0.26), "leaf2", 1.3, { tone: -1 });
  },
  beehive(kit, _s, variant) {
    const em = kit.em;
    if (variant % 2) {
      kit.lathe([[0.25, 0], [0.25, 0.4]], "bark", {});
      kit.sub(0, 0.4, 0).lathe([[0.32, 0], [0.33, 0.15], [0.3, 0.32], [0.22, 0.48], [0.1, 0.56], [0.01, 0.58]], "path", { top: false });
      const m = kit.board(0, 0.4, 0);
      const rings = new Pen(m);
      for (let k = 0; k < 4; k++) rings.M(-0.33 + k * 0.03, 0.1 + k * 0.1).Q(0, 0.06 + k * 0.1, 0.33 - k * 0.03, 0.1 + k * 0.1);
      em.line(rings, "path", 0.6, { tone: -1 });
      em.add(new Pen(m).rect(-0.06, 0.03, 0.12, 0.04), "ink", { stroke: null });
      return;
    }
    const m = kit.board();
    em.add(new Pen(m).rect(-0.2, 0, 0.04, 0.4).rect(0.16, 0, 0.04, 0.4), "wood", { tone: -1, stroke: null });
    em.add(new Pen(m).rect(-0.25, 0.4, 0.5, 0.36), "paper", { tone: 0, width: 0.45 });
    em.add(new Pen(m).rect(-0.25, 0.76, 0.5, 0.2), "cloth3", { tone: 0, width: 0.45 });
    em.add(new Pen(m).rect(-0.25, 0.96, 0.5, 0.2), "paper", { tone: 0, width: 0.45 });
    em.add(new Pen(m).M(-0.32, 1.16).L(0.32, 1.16).L(0.28, 1.24).L(-0.28, 1.24).Z(), "metal", { width: 0.45 });
    em.add(new Pen(m).rect(-0.1, 0.42, 0.2, 0.02), "ink", { stroke: null });
  },
  scarecrow(kit) {
    const m = kit.board(), em = kit.em;
    em.add(new Pen(m).rect(-0.04, 0, 0.08, 1.9), "wood", { tone: -1, width: 0.4 });
    em.add(strokeVar(new Pen(m), [[-0.8, 1.45], [0.8, 1.45]], [0.035, 0.035]), "wood", { width: 0.4 });
    em.add(new Pen(m).M(-0.3, 0.8).L(0.3, 0.8).L(0.38, 1.5).L(0.75, 1.48).L(0.75, 1.36).L(0.3, 1.32).L(-0.3, 1.32).L(-0.75, 1.36).L(-0.75, 1.48).L(-0.38, 1.5).Z(), "cloth1", { tone: 0, width: 0.5 });
    const patch = new Pen(m).rect(-0.15, 0.95, 0.14, 0.14);
    em.add(patch, "cloth3", { width: 0.35 });
    const straw = new Pen(m);
    for (const s of [-1, 1]) for (let k = 0; k < 4; k++) straw.M(s * 0.75, 1.42).L(s * (0.82 + k * 0.03), 1.32 + k * 0.05);
    for (let k = 0; k < 5; k++) straw.M(-0.2 + k * 0.1, 0.8).L(-0.22 + k * 0.11, 0.62);
    em.line(straw, "path", 0.8, { tone: 1 });
    em.add(new Pen(m).ellipse(0, 1.7, 0.17, 0.2), "cloth3", { tone: 1, width: 0.45 });
    em.add(new Pen(m).M(-0.1, 1.75).L(-0.04, 1.69).M(-0.1, 1.69).L(-0.04, 1.75).M(0.04, 1.75).L(0.1, 1.69).M(0.04, 1.69).L(0.1, 1.75).M(-0.08, 1.6).Q(0, 1.56, 0.08, 1.6), "none", { stroke: "ink", width: 0.8, kind: "line" });
    em.add(new Pen(m).M(-0.4, 1.83).L(0.4, 1.83).L(0.2, 1.88).L(0.16, 2.1).L(-0.16, 2.1).L(-0.2, 1.88).Z(), "path", { tone: 0, width: 0.45 });
  },
  birdhouse(kit) {
    const m = kit.board(), em = kit.em;
    em.add(new Pen(m).rect(-0.03, 0, 0.06, 1.7), "wood", { tone: -1, width: 0.4 });
    em.add(new Pen(m).M(-0.17, 1.7).L(0.17, 1.7).L(0.17, 1.92).L(0, 2.05).L(-0.17, 1.92).Z(), "paper", { tone: 0, width: 0.45 });
    em.add(new Pen(m).M(-0.22, 1.9).L(0, 2.08).L(0.22, 1.9).L(0.2, 1.86).L(0, 2.02).L(-0.2, 1.86).Z(), "roof", { width: 0.4 });
    em.add(new Pen(m).ellipse(0, 1.84, 0.05, 0.05), "ink", { stroke: null });
  },
  pergola(kit, size) {
    const L = 3 * size, D = 2.4, em = kit.em;
    const posts = new Pen();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const a = kit.P(sx * L / 2, 0, sz * D / 2), b = kit.P(sx * L / 2, 2.4, sz * D / 2);
      strokeVar(posts, [a, b], [0.07 * kit.fr.scale, 0.07 * kit.fr.scale], { capStart: false, capEnd: false });
    }
    em.add(posts, "wood", { tone: -1, width: 0.4 });
    const beams = new Pen();
    for (const sz of [-1, 1]) beams.poly([kit.P(-L / 2 - 0.25, 2.36, sz * D / 2), kit.P(L / 2 + 0.25, 2.36, sz * D / 2), kit.P(L / 2 + 0.25, 2.48, sz * D / 2), kit.P(-L / 2 - 0.25, 2.48, sz * D / 2)]);
    for (let i = 0; i <= 6; i++) {
      const x = -L / 2 + (i * L) / 6;
      beams.poly([kit.P(x - 0.035, 2.5, -D / 2 - 0.25), kit.P(x + 0.035, 2.5, -D / 2 - 0.25), kit.P(x + 0.035, 2.5, D / 2 + 0.25), kit.P(x - 0.035, 2.5, D / 2 + 0.25)]);
    }
    em.add(beams, "wood", { tone: 0, width: 0.4 });
    const vine = new Pen();
    for (let i = 0; i < 6; i++) {
      const c = kit.P(-L / 2 + (i * L) / 5, 2.6, -D / 2 + 0.3 + (i % 3) * 0.3);
      scallop(vine, c[0], c[1], 0.32 * kit.fr.scale, 0.18 * kit.fr.scale, i * 1.7, 6, 0.04, 0.4);
    }
    em.add(vine, "leaf", { tone: 0, width: 0.35 });
  },
  greenhouse(kit, size) {
    const L = 3 * size, D = 2.4, H = 2.0, rise = 0.8, em = kit.em;
    kit.box(-L / 2, 0, -D / 2, L / 2, 0.4, D / 2, "stone", {});
    for (const [n, o, u] of [[[0, 0, 1], [0, 0, D / 2], [1, 0, 0]], [[1, 0, 0], [L / 2, 0, 0], [0, 0, -1]], [[-1, 0, 0], [-L / 2, 0, 0], [0, 0, 1]]] as [[number, number, number], [number, number, number], [number, number, number]][]) {
      if (kit.vis(n) <= 1e-3) continue;
      const m = kit.face(o, u, [0, 1, 0]);
      const half = n[2] ? L / 2 : D / 2;
      const pts: P2[] = n[2] ? [[-half, 0.4], [half, 0.4], [half, H], [-half, H]] : [[-half, 0.4], [half, 0.4], [half, H], [0, H + rise], [-half, H]];
      em.add(new Pen(m).poly(pts), "glass", { tone: 1, alpha: 0.6, width: 0.4 });
      const g = new Pen(m);
      for (let x = -half; x <= half + 0.01; x += half / 3) g.M(x, 0.4).L(x, n[2] ? H : H + rise * (1 - Math.abs(x) / half));
      g.M(-half, 1.2).L(half, 1.2);
      em.line(g, "paper", 0.9, { tone: 1 });
    }
    const roofPts = [kit.P(-L / 2, H, D / 2), kit.P(L / 2, H, D / 2), kit.P(L / 2, H + rise, 0), kit.P(-L / 2, H + rise, 0)];
    em.add(new Pen().poly(roofPts), "glass", { tone: 2, alpha: 0.55, width: 0.45 });
    const plants = new Pen(kit.board(0, 0.4, 0));
    for (let i = 0; i < 6; i++) scallop(plants, -L / 2 + 0.4 + i * (L - 0.8) / 5, 0.25, 0.22, 0.2, i, 6, 0.03, 0.5);
    em.add(plants, "leaf", { tone: 0, stroke: null, alpha: 0.8 });
  },
  table(kit, _s, variant) {
    const m = kit.board(), em = kit.em;
    if (variant % 2) {
      em.add(new Pen(m).rect(-0.04, 0, 0.08, 0.72).rect(-0.2, 0, 0.4, 0.04), "metal", { tone: -1, width: 0.4 });
      em.add(new Pen(m).rect(-0.34, 0.72, 0.68, 0.05), "paper", { tone: 1, width: 0.45 });
      return;
    }
    em.add(new Pen(m).rect(-0.52, 0, 0.06, 0.72).rect(0.46, 0, 0.06, 0.72), "wood", { tone: -1, width: 0.4 });
    em.add(new Pen(m).rect(-0.62, 0.72, 1.24, 0.07), "wood", { tone: 0, width: 0.45 });
    em.add(new Pen(m).M(-0.6, 0.79).L(0.6, 0.79).L(0.62, 0.55).L(-0.62, 0.55).Z(), "paper", { tone: 0, width: 0.4, alpha: 0.9 });
    em.add(new Pen(m).rrect(-0.2, 0.79, 0.12, 0.16, 0.03).rrect(0.15, 0.79, 0.08, 0.2, 0.02), "glass", { tone: 1, width: 0.35 });
  },
  chair(kit) {
    const { m } = kit.elev(), em = kit.em;
    em.add(new Pen(m).M(-0.2, 0).L(-0.17, 0.45).L(0.18, 0.45).L(0.2, 0).M(-0.18, 0.45).L(-0.22, 0.95), "none", { stroke: "metal", width: 1.4, kind: "line" });
    em.add(new Pen(m).rect(-0.22, 0.43, 0.44, 0.05), "wood", { width: 0.4 });
    em.add(new Pen(m).M(-0.22, 0.6).L(-0.17, 0.6).L(-0.2, 0.95).L(-0.25, 0.95).Z(), "wood", { width: 0.4 });
  },
  parasol(kit, _s, variant) {
    const m = kit.board(), em = kit.em;
    em.add(new Pen(m).rect(-0.025, 0, 0.05, 2.3), "wood", { tone: -1, width: 0.35 });
    const cl = ["accent", "leaf2", "water", "cloth1"][variant % 4];
    em.add(new Pen(m).M(-1.3, 1.9).Q(-0.6, 2.45, 0, 2.5).Q(0.6, 2.45, 1.3, 1.9).Z(), "paper", { tone: 0, width: 0.5 });
    const st = new Pen(m);
    for (let k = 0; k < 4; k++) {
      const a = -1.3 + k * 0.65;
      st.M(a, 1.9).Q(a * 0.5 + 0.1, 2.3, 0, 2.5).Q(a * 0.5 + 0.25, 2.3, a + 0.33, 1.95).Z();
    }
    em.add(st, cl, { tone: 0, stroke: null });
    const val = new Pen(m).M(-1.3, 1.9);
    for (let k = 0; k < 8; k++) val.Q(-1.3 + (k + 0.5) * 0.325, 1.78, -1.3 + (k + 1) * 0.325, 1.9);
    em.add(val.Z(), cl, { tone: -1, width: 0.4 });
  },
  hanginglantern(kit, _s, _v, ctx) {
    const { m } = kit.elev(), em = kit.em;
    em.add(strokeVar(new Pen(m), [[0, 0], [0, 2.7]], [0.04, 0.035]), "wood", { width: 0.4 });
    em.add(strokeVar(new Pen(m), [[0, 2.6], [0.3, 2.62], [0.55, 2.55]], [0.02, 0.02, 0.02]), "metal", { width: 0.4 });
    if (ctx.env.night > 0.2) em.add(new Pen(m).ellipse(0.55, 2.2, 1.1, 1.1), "lamp", { kind: "halo", stroke: null, alpha: 0.75 });
    em.add(new Pen(m).M(0.47, 2.35).L(0.63, 2.35).Q(0.7, 2.18, 0.6, 2.02).L(0.5, 2.02).Q(0.4, 2.18, 0.47, 2.35).Z(), "lamp", { kind: ctx.env.night > 0.2 ? "glow" : "fill", width: 0.4 });
    em.add(new Pen(m).M(0.42, 2.35).L(0.68, 2.35).L(0.55, 2.45).Z(), "metal", { width: 0.35 });
  },
  garland(kit, size, _v, ctx) {
    const L = 5 * size;
    const { m } = kit.elev(), em = kit.em;
    em.add(new Pen(m).rect(-L / 2 - 0.04, 0, 0.08, 3).rect(L / 2 - 0.04, 0, 0.08, 3), "wood", { tone: -1, width: 0.4 });
    const pts: P2[] = [];
    for (let i = 0; i <= 10; i++) {
      const x = -L / 2 + (i * L) / 10;
      pts.push([x, 2.9 - 0.45 * (1 - ((2 * x) / L) ** 2)]);
    }
    const c = new Pen(m).M(pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) c.L(q[0], q[1]);
    em.line(c, "ink", 0.6);
    const bulbs = new Pen(m), bulbs2 = new Pen(m);
    for (let i = 1; i < 10; i++) (i % 3 ? bulbs : bulbs2).ellipse(pts[i][0], pts[i][1] - 0.08, 0.05, 0.065);
    if (ctx.env.night > 0.2) for (let i = 1; i < 10; i += 2) em.add(new Pen(m).ellipse(pts[i][0], pts[i][1] - 0.08, 0.5, 0.5), "lamp", { kind: "halo", stroke: null, alpha: 0.5 });
    em.add(bulbs, "lamp", { kind: "glow", width: 0.3 });
    em.add(bulbs2, "accent", { kind: "glow", width: 0.3 });
  },
  hangingsign(kit, _s, variant) {
    const { m } = kit.elev(), em = kit.em;
    em.add(strokeVar(new Pen(m), [[0, 0], [0, 2.7]], [0.05, 0.045]), "wood", { width: 0.4 });
    em.add(new Pen(m).rect(0, 2.53, 0.6, 0.04), "metal", { stroke: null });
    em.line(new Pen(m).M(0, 2.2).Q(0.2, 2.3, 0.42, 2.53).M(0.4, 2.53).L(0.4, 2.42).M(0.7, 2.53).L(0.7, 2.42), "metal", 0.8);
    const fill = ["accent", "wood", "leaf2", "paper"][variant % 4];
    const sign = new Pen(m);
    if (variant % 3 === 0) sign.ellipse(0.55, 2.18, 0.26, 0.26);
    else if (variant % 3 === 1) sign.poly([[0.3, 2.4], [0.8, 2.4], [0.8, 2.15], [0.55, 1.9], [0.3, 2.15]]);
    else sign.rrect(0.25, 2.0, 0.6, 0.38, 0.04);
    em.add(sign, fill, { tone: 0, width: 0.55 });
    em.add(new Pen(m).ellipse(0.55, 2.18, 0.09, 0.09), "metal", { tone: 1, stroke: null });
  },
  milestone(kit) {
    const m = kit.board(), em = kit.em;
    em.add(new Pen(m).M(-0.2, 0).L(0.2, 0).L(0.2, 0.55).Q(0.2, 0.8, 0, 0.8).Q(-0.2, 0.8, -0.2, 0.55).Z(), "stone", { tone: 0, width: 0.55 });
    em.add(new Pen(m).M(-0.2, 0.55).Q(-0.2, 0.8, 0, 0.8).Q(0.2, 0.8, 0.2, 0.55).Z(), "accent", { tone: 0, width: 0.4 });
    em.add(new Pen(m).rrect(-0.1, 0.3, 0.2, 0.06, 0.02).rrect(-0.07, 0.2, 0.14, 0.05, 0.02), "ink", { stroke: null, alpha: 0.75 });
  },
  puddle(kit, size, _v, ctx) {
    const em = kit.em;
    const c = kit.P(0, 0.02, 0);
    const s = kit.fr.scale;
    const rx = 1.1 * size * s, ry = Math.max(0.12, 0.85 * size * kit.pr.ay) * s;
    em.add(scallop(new Pen(), c[0], c[1], rx, ry, 2.2, 9, ry * 0.15, 0), "water", { tone: 1, stroke: null, alpha: 0.85 });
    const t = ctx.env.time;
    em.line(new Pen().M(c[0] - rx * 0.5, c[1]).Q(c[0], c[1] + ry * 0.2 + Math.sin(t) * 0.01, c[0] + rx * 0.4, c[1]), "paper", 0.7, { alpha: 0.7 });
  },
};

export type { M };
