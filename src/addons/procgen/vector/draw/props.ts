/**
 * Objets de décor (`prop.*`), blasons (`emblem`) et repli générique, dessinés en élévation d'après leurs
 * paramètres. Les objets ronds sont des corps de révolution ombrés ; les objets allongés (banc, charrette, barque,
 * clôture, étal, tente) suivent l'axe local le plus visible ; les boîtes montrent leurs faces visibles.
 */
import { type P2, Pen, compose, strokeVar } from "../shape";
import type { Kit } from "./kit";
import type { DrawCtx, ObjectDrawer } from "./types";

type M = [number, number, number, number, number, number];

const glow = (kit: Kit, m: M, x: number, y: number, r: number, night: number) => {
  if (night < 0.2) return;
  kit.em.add(new Pen(m).ellipse(x, y, r, r), "lamp", { kind: "halo", stroke: null, alpha: 0.35 + night * 0.4 });
};

export const drawProp: ObjectDrawer = (kit, p, ctx) => {
  const kind = String(p.kind ?? "crate");
  const size = Number(p.size ?? 1);
  const variant = Number(p.variant ?? 0);
  const fn = PROPS[kind];
  const o = ctx.obj;
  const em = kit.em;
  const fpx = o.footprint.hx / o.scale, fpz = o.footprint.hz / o.scale;
  if (kind !== "boat") kit.castShadow(ctx.env.shadows, fpx * 0.9, fpz * 0.9, (o.height / o.scale) * (kind === "lamp" || kind === "lantern" || kind === "signpost" ? 0.25 : 0.8), ctx.env.ground, em.z0 - 0.5, em.layer, em.depth, kind === "barrel" || kind === "well" || kind === "haystack" || kind === "campfire");
  if (fn) fn(kit, size, variant, ctx);
  else drawGeneric(kit, p, ctx);
};

const PROPS: Record<string, (kit: Kit, size: number, variant: number, ctx: DrawCtx) => void> = {
  lamp(kit, _s, _v, ctx) {
    const { m } = kit.elev();
    const em = kit.em;
    kit.lathe([[0.13, 0], [0.12, 0.08], [0.09, 0.12], [0.08, 0.3], [0.05, 0.36]], "metal", { top: false });
    em.add(strokeVar(new Pen(m), [[0, 0.3], [0, 1.8], [0, 3.4]], [0.05, 0.042, 0.035]), "metal", { tone: 0, width: 0.6 });
    em.add(strokeVar(new Pen(m), [[0, 3.35], [0.12, 3.62], [0.4, 3.62], [0.55, 3.55]], [0.035, 0.03, 0.028, 0.028]), "metal", { tone: 0, width: 0.6 });
    em.add(new Pen(m).M(0.02, 3.2).Q(0.02, 3.42, 0.25, 3.5), "none", { stroke: "metal", width: 0.6, kind: "line" });
    const night = ctx.env.night;
    glow(kit, m, 0.55, 3.25, 1.6, night);
    em.add(new Pen(m).M(0.38, 3.55).L(0.72, 3.55).L(0.67, 3.2).L(0.43, 3.2).Z(), "lamp", { kind: night > 0.2 ? "glow" : "fill", tone: night > 0.2 ? 0 : -1, width: 0.6 });
    em.add(new Pen(m).M(0.3, 3.55).Q(0.55, 3.75, 0.8, 3.55).Z(), "metal", { tone: 1, width: 0.6 });
    em.add(new Pen(m).ellipse(0.55, 3.72, 0.04, 0.04), "metal", { width: 0.5 });
  },
  lantern(kit, _s, _v, ctx) {
    const { m } = kit.elev();
    const em = kit.em;
    em.add(strokeVar(new Pen(m), [[0, 0], [0, 1.95]], [0.04, 0.03]), "metal", { width: 0.6 });
    em.add(strokeVar(new Pen(m), [[0, 1.9], [0.12, 2.0], [0.26, 1.95]], [0.02, 0.018, 0.016]), "metal", { width: 0.5 });
    glow(kit, m, 0.26, 1.72, 1.1, ctx.env.night);
    em.add(new Pen(m).M(0.16, 1.88).L(0.36, 1.88).L(0.34, 1.6).L(0.26, 1.54).L(0.18, 1.6).Z(), "lamp", { kind: ctx.env.night > 0.2 ? "glow" : "fill", tone: ctx.env.night > 0.2 ? 0 : -1, width: 0.6 });
    em.add(new Pen(m).M(0.12, 1.88).Q(0.26, 2.0, 0.4, 1.88).Z(), "metal", { width: 0.5 });
    em.line(new Pen(m).M(0.26, 1.88).L(0.26, 1.58), "metal", 0.4);
  },
  bench(kit) {
    const { m, along } = kit.elev();
    const em = kit.em;
    if (along === "x") {
      for (const x of [-0.7, 0.7]) {
        const leg = new Pen(m).M(x - 0.04, 0).Q(x - 0.02, 0.25, x - 0.05, 0.45).L(x + 0.05, 0.45).Q(x + 0.02, 0.25, x + 0.06, 0).Z();
        em.add(leg, "metal", { tone: -1, width: 0.6 });
        em.add(strokeVar(new Pen(m), [[x, 0.45], [x - 0.02, 0.7], [x, 0.9]], [0.025, 0.022, 0.02]), "metal", { tone: -1, width: 0.5 });
      }
      for (let i = 0; i < 2; i++) em.add(new Pen(m).rrect(-0.82, 0.62 + i * 0.13, 1.64, 0.09, 0.02), "wood", { tone: 0, width: 0.6 });
      em.add(new Pen(m).rrect(-0.82, 0.42, 1.64, 0.07, 0.02), "wood", { tone: 1, width: 0.6 });
      em.add(new Pen(m).rect(-0.82, 0.38, 1.64, 0.04), "wood", { tone: -1, stroke: null });
    } else {
      // de profil : piétement et assise vus en bout
      const side = new Pen(m).M(-0.25, 0).L(-0.2, 0.45).L(0.22, 0.45).L(0.26, 0).M(-0.24, 0.45).L(-0.3, 0.95);
      em.line(side, "metal", 1.2, { tone: -1 });
      em.add(new Pen(m).rrect(-0.3, 0.42, 0.6, 0.07, 0.02), "wood", { width: 0.6 });
      em.add(new Pen(m).M(-0.27, 0.6).L(-0.2, 0.6).L(-0.28, 0.95).L(-0.35, 0.95).Z(), "wood", { width: 0.6 });
    }
  },
  crate(kit, s) {
    const h = 0.45 * s;
    kit.box(-h, 0, -h, h, 2 * h, h, "wood", {});
    for (const [n, o, u] of [[[0, 0, 1], [0, 0, h], [1, 0, 0]], [[1, 0, 0], [h, 0, 0], [0, 0, -1]], [[-1, 0, 0], [-h, 0, 0], [0, 0, 1]], [[0, 0, -1], [0, 0, -h], [-1, 0, 0]]] as [[number, number, number], [number, number, number], [number, number, number]][]) {
      if (kit.vis(n) <= 1e-3) continue;
      const m = kit.face(o, u, [0, 1, 0]);
      const t = kit.tone(n);
      const pl = new Pen(m);
      for (let k = 1; k < 4; k++) pl.M(-h, (2 * h * k) / 4).L(h, (2 * h * k) / 4);
      kit.em.line(pl, "wood", 0.4, { tone: t - 1 });
      const fr = new Pen(m).rect(-h, 0, 2 * h, 0.07).rect(-h, 2 * h - 0.07, 2 * h, 0.07).rect(-h, 0, 0.07, 2 * h).rect(h - 0.07, 0, 0.07, 2 * h);
      kit.em.add(fr, "trim", { tone: t, width: 0.4 });
      kit.em.add(new Pen(m).M(-h + 0.07, 0.07).L(-h + 0.16, 0.07).L(h - 0.07, 2 * h - 0.16).L(h - 0.07, 2 * h - 0.07).L(h - 0.16, 2 * h - 0.07).L(-h + 0.07, 0.16).Z(), "trim", { tone: t, width: 0.4 });
    }
  },
  barrel(kit, s) {
    const prof: [number, number][] = [[0.27, 0], [0.31, 0.22], [0.33, 0.45], [0.31, 0.68], [0.27, 0.9]].map(([r, y]) => [r * s, y * s]);
    kit.lathe(prof, "wood", {});
    const em = kit.em;
    const m = kit.board();
    const st = new Pen(m);
    for (const f of [-0.6, -0.2, 0.2, 0.6]) st.M(0.27 * s * f, 0.02).Q(0.34 * s * f, 0.45 * s, 0.27 * s * f, 0.88 * s);
    em.line(st, "wood", 0.4, { tone: -2, alpha: 0.7 });
    for (const y of [0.12, 0.3, 0.6, 0.78]) {
      const r = 0.31 * s + (y > 0.2 && y < 0.7 ? 0.02 * s : 0) * 1;
      const hp = new Pen(m).M(-r, y * s).Q(0, y * s - 0.06 * s, r, y * s).L(r, y * s + 0.05 * s).Q(0, y * s - 0.01 * s, -r, y * s + 0.05 * s).Z();
      em.add(hp, "metal", { tone: -1, width: 0.4 });
    }
  },
  well(kit, _s, _v, ctx) {
    const em = kit.em;
    kit.lathe([[0.78, 0], [0.8, 0.4], [0.78, 0.75], [0.84, 0.78], [0.84, 0.86]], "stone", {});
    const m = kit.board();
    const joints = new Pen(m);
    for (let r = 0; r < 3; r++) {
      const y = 0.06 + r * 0.24;
      joints.M(-0.79, y + 0.22).Q(0, y + 0.22 - 0.12, 0.79, y + 0.22);
      for (let k = -2; k <= 2; k++) joints.M(k * 0.3 + (r % 2) * 0.15, y).L(k * 0.3 + (r % 2) * 0.15, y + 0.22);
    }
    em.line(joints, "stone", 0.45, { tone: -2 });
    for (const x of [-0.68, 0.68]) em.add(new Pen(m).rect(x - 0.06, 0.8, 0.12, 1.75), "wood", { tone: x > 0 ? -1 : 0, width: 0.6 });
    em.add(strokeVar(new Pen(m), [[-0.75, 1.72], [0.75, 1.72]], [0.06, 0.06]), "wood", { tone: 0, width: 0.6 });
    em.line(new Pen(m).M(0.15, 1.7).L(0.15, 1.15), "wood", 0.6, { tone: -1 });
    em.add(new Pen(m).M(0.03, 1.15).L(0.27, 1.15).L(0.24, 0.92).L(0.06, 0.92).Z(), "wood", { tone: 0, width: 0.6 });
    em.add(strokeVar(new Pen(m), [[0.75, 1.72], [0.95, 1.72], [0.95, 1.5]], [0.025, 0.025, 0.02]), "metal", { width: 0.5 });
    // petit toit à deux pans
    const r = new Pen(m).M(-1.0, 2.35).L(0, 2.95).L(1.0, 2.35).L(0.92, 2.25).L(0, 2.8).L(-0.92, 2.25).Z();
    em.add(r, "roof", { tone: 0, width: 0.7 });
    const tl = new Pen(m);
    for (let k = 1; k < 5; k++) tl.M(-0.95 + k * 0.19, 2.32 + k * 0.11).L(-0.95 + k * 0.19 + 0.08, 2.26 + k * 0.11);
    em.line(tl, "roof", 0.4, { tone: -1 });
    void ctx;
  },
  campfire(kit, _s, _v, ctx) {
    const em = kit.em;
    const m = kit.board();
    const t = ctx.env.time;
    glow(kit, m, 0, 0.45, 1.2 + ctx.env.night * 2.4, Math.max(0.25, ctx.env.night));
    const back = new Pen(m), front = new Pen(m);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const x = Math.cos(a) * 0.5, z = Math.sin(a);
      (z < 0 ? back : front).ellipse(x, 0.06 + z * 0.06 * kit.pr.ay * 10 * 0.5, 0.15, 0.1);
    }
    em.add(back, "stone", { tone: -1, width: 0.5 });
    const logs = new Pen(m);
    strokeVar(logs, [[-0.45, 0.04], [0.3, 0.3]], [0.06, 0.05]);
    strokeVar(logs, [[0.45, 0.04], [-0.3, 0.3]], [0.06, 0.05]);
    strokeVar(logs, [[-0.1, 0.02], [0.05, 0.38]], [0.055, 0.045]);
    em.add(logs, "bark", { tone: 0, width: 0.6 });
    const flame = (w: number, h: number, ph: number, fill: string, tone: number) => {
      const f = Math.sin(t * 9 + ph) * 0.05 + Math.sin(t * 13.7 + ph * 2) * 0.03;
      const pen = new Pen(m).M(-w, 0.12).C(-w * 1.1, 0.12 + h * 0.45, -w * 0.2 + f, 0.12 + h * 0.6, f * 2, 0.12 + h).C(w * 0.25 + f, 0.12 + h * 0.62, w * 1.1, 0.12 + h * 0.45, w, 0.12).Q(0, 0.02, -w, 0.12).Z();
      em.add(pen, fill, { kind: "glow", tone, stroke: null });
    };
    flame(0.3, 0.95, 0, "fire", 0);
    flame(0.2, 0.7, 1.7, "lamp", 0);
    flame(0.1, 0.4, 3.1, "paper", 1);
    const sp = new Pen(m);
    for (let i = 0; i < 4; i++) {
      const k = ((t * 0.6 + i * 0.27) % 1);
      sp.ellipse(Math.sin(i * 3 + t) * 0.2 * k, 0.7 + k * 1.1, 0.02, 0.02);
    }
    em.add(sp, "lamp", { kind: "glow", stroke: null });
    em.add(front, "stone", { tone: 0, width: 0.5 });
  },
  tent(kit, _s, variant) {
    const em = kit.em;
    // prisme : pignon avant (z = +1.3) et pans latéraux
    for (const sz of [1, -1]) {
      const n: [number, number, number] = [0, 0, sz];
      if (kit.vis(n) <= 1e-3) continue;
      const m = kit.face([0, 0, sz * 1.3], [sz, 0, 0], [0, 1, 0]);
      em.add(new Pen(m).M(-1.3, 0).L(1.3, 0).L(0, 1.7).Z(), "cloth3", { tone: kit.tone(n) });
      if (sz > 0) {
        em.add(new Pen(m).M(-0.45, 0).L(0.45, 0).L(0, 1.0).Z(), "ink", { tone: 0, alpha: 0.85, width: 0.5 });
        em.add(new Pen(m).M(0, 1.0).L(0.45, 0).L(0.62, 0).Q(0.3, 0.5, 0, 1.0).Z(), "cloth3", { tone: -1, width: 0.5 });
        em.line(new Pen(m).M(0, 1.7).L(0, 1.95), "wood", 1);
      }
    }
    for (const sx of [1, -1]) {
      const l = Math.hypot(1.3, 1.7);
      const n: [number, number, number] = [(sx * 1.7) / l, 1.3 / l, 0];
      if (kit.vis(n) <= 1e-3) continue;
      const m = kit.face([sx * 1.3, 0, 1.3], [0, 0, -1], [(-sx * 1.3) / l, 1.7 / l, 0]);
      em.add(new Pen(m).rect(0, 0, 2.6, l), "cloth3", { tone: kit.tone(n) });
      const seams = new Pen(m);
      for (const u of [0.87, 1.73]) seams.M(u, 0).L(u, l);
      em.line(seams, "cloth3", 0.4, { tone: kit.tone(n) - 1 });
      if (variant % 2 === 0) em.add(new Pen(m).rect(0, l * 0.1, 2.6, 0.14), "accent", { tone: kit.tone(n), stroke: null });
    }
    // haubans
    const g = new Pen();
    for (const [x, z] of [[1.9, 1.6], [-1.9, 1.6]]) {
      const a = kit.P(0, 1.7, 1.3), b = kit.P(x, 0, z);
      g.M(a[0], a[1]).L(b[0], b[1]);
    }
    em.line(g, "paper", 0.4, { tone: -1 });
  },
  cart(kit) {
    const { m, along } = kit.elev();
    const em = kit.em;
    const L = along === "z" ? 1.1 : 0.75;
    // chargement
    const load = new Pen(m);
    for (let i = 0; i < 6; i++) load.ellipse(-L * 0.7 + (i * L * 1.4) / 5, 1.1 + (i % 2) * 0.1, 0.2, 0.17);
    em.add(load, "leaf2", { tone: 0, width: 0.5 });
    const fruits = new Pen(m);
    for (let i = 0; i < 4; i++) fruits.ellipse(-L * 0.5 + i * L * 0.33, 1.22, 0.1, 0.09);
    em.add(fruits, "flower", { tone: 0, width: 0.4 });
    em.add(new Pen(m).rect(-L, 0.62, L * 2, 0.4), "wood", { tone: 0, width: 0.7 });
    const pl = new Pen(m);
    for (const y of [0.75, 0.88]) pl.M(-L, y).L(L, y);
    em.line(pl, "wood", 0.4, { tone: -1 });
    em.add(strokeVar(new Pen(m), [[L, 0.72], [L + 0.9, 0.55], [L + 1.5, 0.45]], [0.04, 0.035, 0.03]), "wood", { width: 0.6 });
    // roue à rayons
    const wx = along === "z" ? -0.3 : 0, wr = 0.5;
    em.add(new Pen(m).ellipse(wx, wr, wr, wr), "wood", { tone: 0, width: 0.8 });
    em.add(new Pen(m).ellipse(wx, wr, wr * 0.82, wr * 0.82), "wood", { tone: -2, stroke: null });
    const sp = new Pen(m);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      strokeVar(sp, [[wx, wr], [wx + Math.cos(a) * wr * 0.84, wr + Math.sin(a) * wr * 0.84]], [0.03, 0.02], { capEnd: false });
    }
    em.add(sp, "wood", { tone: 0, stroke: null });
    em.add(new Pen(m).ellipse(wx, wr, 0.09, 0.09), "metal", { tone: 0, width: 0.5 });
  },
  stall(kit, _s, variant) {
    const { m } = kit.elev();
    const em = kit.em;
    for (const x of [-1.15, 1.15]) em.add(new Pen(m).rect(x - 0.04, 0, 0.08, 2.3), "wood", { tone: -1, width: 0.5 });
    em.add(new Pen(m).rect(-1.2, 0, 2.4, 0.9), "wood", { tone: 0, width: 0.7 });
    const pl = new Pen(m);
    for (let x = -0.9; x < 1.2; x += 0.3) pl.M(x, 0.05).L(x, 0.85);
    em.line(pl, "wood", 0.4, { tone: -1 });
    const goods = [["flower", 0.11], ["leaf2", 0.13], ["accent", 0.1]] as const;
    for (let i = 0; i < 7; i++) {
      const [c, r] = goods[(i + variant) % 3];
      em.add(new Pen(m).ellipse(-0.95 + i * 0.32, 0.98, r, r * 0.9), c, { tone: 0, width: 0.45 });
    }
    // auvent à rayures et lambrequin
    const a0 = 2.1, a1 = 2.45;
    em.add(new Pen(m).M(-1.3, a0).L(1.3, a0).L(1.15, a1).L(-1.15, a1).Z(), "paper", { tone: 1, width: 0.6 });
    const st = new Pen(m);
    for (let k = 0; k < 6; k += 2) {
      const xa = -1.3 + (k * 2.6) / 6, xb = -1.3 + ((k + 1) * 2.6) / 6;
      const xa2 = -1.15 + (k * 2.3) / 6, xb2 = -1.15 + ((k + 1) * 2.3) / 6;
      st.M(xa, a0).L(xb, a0).L(xb2, a1).L(xa2, a1).Z();
    }
    em.add(st, "accent", { tone: 0, stroke: null });
    const val = new Pen(m).M(-1.3, a0);
    for (let k = 0; k < 8; k++) val.Q(-1.3 + ((k + 0.5) * 2.6) / 8, a0 - 0.22, -1.3 + ((k + 1) * 2.6) / 8, a0);
    val.Z();
    em.add(val, "accent", { tone: -1, width: 0.5 });
  },
  signpost(kit, _s, variant) {
    const { m } = kit.elev();
    const em = kit.em;
    em.add(strokeVar(new Pen(m), [[0, 0], [0, 2.45]], [0.06, 0.05]), "wood", { tone: 0, width: 0.6 });
    const n = 2 + (variant % 2);
    for (let i = 0; i < n; i++) {
      const dir = (i + variant) % 2 ? 1 : -1;
      const y = 2.05 - i * 0.36;
      const pen = new Pen(compose(m, [dir, 0, 0, 1, 0, 0])).M(-0.1, y - 0.12).L(0.62, y - 0.12).L(0.78, y).L(0.62, y + 0.12).L(-0.1, y + 0.12).Z();
      em.add(pen, "paper", { tone: 0, width: 0.6 });
      // lettrage peint : mots de longueurs variées, capitale plus haute
      const t = new Pen(compose(m, [dir, 0, 0, 1, 0, 0]));
      let x = 0.0;
      for (let k = 0; k < 3 && x < 0.5; k++) {
        const w = [0.18, 0.1, 0.14, 0.22][(k + i + variant) % 4];
        t.rrect(x, y - 0.035, 0.025, 0.08, 0.01).rrect(x + 0.03, y - 0.035, Math.min(w, 0.56 - x), 0.05, 0.02);
        x += w + 0.07;
      }
      em.add(t, "ink", { stroke: null, alpha: 0.85 });
    }
  },
  fence(kit, _s, variant) {
    const { m } = kit.elev();
    const em = kit.em;
    if (variant % 2) {
      const pk = new Pen(m);
      for (let x = -0.95; x <= 0.96; x += 0.19) pk.M(x - 0.06, 0).L(x + 0.06, 0).L(x + 0.06, 0.9).L(x, 1.02).L(x - 0.06, 0.9).Z();
      em.add(pk, "wood", { tone: 0, width: 0.5 });
    }
    for (const y of [0.38, 0.8]) em.add(new Pen(m).rect(-1.02, y, 2.04, 0.08), "wood", { tone: variant % 2 ? -1 : 0, width: 0.5 });
    for (const x of [-1, 1]) em.add(new Pen(m).M(x - 0.06, 0).L(x + 0.06, 0).L(x + 0.06, 1.05).L(x, 1.12).L(x - 0.06, 1.05).Z(), "wood", { tone: -1, width: 0.6 });
  },
  haystack(kit, s) {
    const m = kit.board();
    const em = kit.em;
    const w = 0.95 * s, h = 1.3 * s;
    const body = new Pen(m).M(-w, 0).C(-w * 1.05, h * 0.55, -w * 0.5, h, 0, h).C(w * 0.5, h, w * 1.05, h * 0.55, w, 0).Z();
    em.add(body, "path", { tone: 0 });
    const lx = kit.L[0] < 0 ? 1 : -1;
    em.add(new Pen(m).M(lx * w * 0.2, h * 0.98).C(lx * w * 0.8, h * 0.85, lx * w * 1.05, h * 0.4, lx * w, 0).L(lx * w * 0.35, 0).C(lx * w * 0.6, h * 0.4, lx * w * 0.5, h * 0.8, lx * w * 0.2, h * 0.98).Z(), "path", { tone: -1, stroke: null });
    const str = new Pen(m);
    for (let i = 0; i < 26; i++) {
      const a = (i * 2.399) % 1, b = ((i * 0.618) % 1) * 0.9;
      const x = (a - 0.5) * 2 * w * Math.sqrt(1 - b * b * 0.8), y = b * h;
      str.M(x, y).L(x + 0.05 * s, y - 0.16 * s);
    }
    em.line(str, "path", 0.45, { tone: -2, alpha: 0.7 });
    em.line(new Pen(m).M(-w * 0.95, h * 0.35).Q(0, h * 0.25, w * 0.95, h * 0.35), "wood", 0.6, { tone: -1 });
  },
  bollard(kit) {
    kit.lathe([[0.12, 0], [0.12, 0.66], [0.15, 0.7], [0.14, 0.74], [0.1, 0.8], [0.03, 0.85]], "stone", {});
  },
  planter(kit) {
    const em = kit.em;
    kit.box(-0.5, 0, -0.5, 0.5, 0.5, 0.5, "stone", {});
    const m = kit.board(0, 0.5, 0);
    em.add(new Pen(m).rect(-0.52, -0.04, 1.04, 0.08), "trim", { tone: 1, width: 0.5 });
    const pl = new Pen(m);
    for (let i = 0; i < 5; i++) pl.ellipse(-0.32 + i * 0.16, 0.12 + (i % 2) * 0.08, 0.17, 0.15);
    em.add(pl, "leaf", { tone: 0, width: 0.5 });
    const f = new Pen(m);
    for (let i = 0; i < 4; i++) f.ellipse(-0.25 + i * 0.17, 0.22 + (i % 2) * 0.06, 0.05, 0.05);
    em.add(f, "flower", { tone: 0, width: 0.35 });
  },
  statue(kit) {
    const em = kit.em;
    kit.box(-0.6, 0, -0.6, 0.6, 1.0, 0.6, "stone", {});
    kit.box(-0.7, 1.0, -0.7, 0.7, 1.08, 0.7, "trim", {});
    const m = kit.board(0, 1.08, 0);
    // figure drapée en bronze : silhouette, plis, bras levé
    const fig = new Pen(m).M(-0.3, 0).C(-0.28, 0.4, -0.22, 0.7, -0.18, 1.1).C(-0.22, 1.25, -0.16, 1.35, -0.12, 1.42).C(-0.14, 1.55, -0.1, 1.68, 0, 1.7).C(0.1, 1.68, 0.14, 1.55, 0.12, 1.42).C(0.2, 1.4, 0.26, 1.55, 0.3, 1.85).L(0.36, 1.84).C(0.34, 1.5, 0.28, 1.25, 0.18, 1.1).C(0.22, 0.7, 0.28, 0.4, 0.3, 0).Z();
    em.add(fig, "metal", { tone: 0, width: 0.8 });
    const lx = kit.L[0] < 0 ? 1 : -1;
    em.add(new Pen(m).M(lx * 0.3, 0).C(lx * 0.28, 0.4, lx * 0.22, 0.7, lx * 0.18, 1.1).L(lx * 0.05, 1.1).C(lx * 0.1, 0.7, lx * 0.1, 0.3, lx * 0.08, 0).Z(), "metal", { tone: -1, stroke: null });
    const folds = new Pen(m);
    for (const x of [-0.15, 0.0, 0.12]) folds.M(x, 0.05).Q(x + 0.04, 0.5, x - 0.02, 1.0);
    em.line(folds, "metal", 0.45, { tone: -2 });
  },
  mailbox(kit) {
    const { m } = kit.elev();
    const em = kit.em;
    em.add(new Pen(m).rect(-0.04, 0, 0.08, 1.0), "wood", { tone: -1, width: 0.5 });
    em.add(new Pen(m).M(-0.2, 0.98).L(0.2, 0.98).L(0.2, 1.18).Q(0.2, 1.28, 0, 1.28).Q(-0.2, 1.28, -0.2, 1.18).Z(), "accent", { tone: 0, width: 0.6 });
    em.add(new Pen(m).rect(-0.1, 1.13, 0.2, 0.025), "ink", { stroke: null });
    em.add(new Pen(m).M(0.2, 1.05).L(0.24, 1.05).L(0.24, 1.32).L(0.36, 1.27).L(0.24, 1.22).Z(), "flower", { tone: 0, width: 0.4 });
  },
  boat(kit, _s, variant, ctx) {
    const { m, along } = kit.elev();
    const em = kit.em;
    const L = along === "z" ? 1.9 : 0.75;
    // reflet dans l'eau, ligne de flottaison
    const refl = new Pen(m).M(-L * 0.95, 0.1).Q(0, -0.35, L * 0.95, 0.1).Z();
    em.add(refl, "water", { tone: -1, stroke: null, alpha: 0.6 });
    const hull = new Pen(m).M(-L, 0.62).L(L, 0.62).Q(L * 0.92, 0.1, L * 0.55, 0.05).L(-L * 0.6, 0.05).Q(-L * 0.95, 0.15, -L, 0.62).Z();
    em.add(hull, "wood", { tone: 0 });
    const pl = new Pen(m);
    for (const y of [0.28, 0.45]) pl.M(-L * 0.93 + (0.62 - y) * 0.1, y).Q(0, y - 0.05, L * 0.93 - (0.62 - y) * 0.1, y);
    em.line(pl, "wood", 0.45, { tone: -1 });
    em.add(new Pen(m).rect(-L, 0.6, L * 2, 0.07), variant % 2 ? "accent" : "paper", { tone: 0, width: 0.5 });
    em.add(new Pen(m).M(-L * 0.6, 0.05).Q(0, 0.01, L * 0.55, 0.05).L(L * 0.4, 0.2).Q(0, 0.15, -L * 0.5, 0.2).Z(), "wood", { tone: -1, stroke: null });
    // ondes
    const t = ctx.env.time;
    const w = new Pen(m);
    for (let k = 0; k < 3; k++) {
      const x = -L * 1.2 + k * L * 1.2 + Math.sin(t * 1.3 + k) * 0.1;
      w.M(x, 0.02).Q(x + 0.25, 0.07, x + 0.5, 0.02);
    }
    em.line(w, "water", 0.6, { tone: 2 });
    if (along === "z" && variant % 3 === 0) {
      em.add(strokeVar(new Pen(m), [[0, 0.6], [0, 2.6]], [0.035, 0.03]), "wood", { width: 0.5 });
      em.add(new Pen(m).M(0.06, 2.5).Q(0.9, 1.9, 0.06, 0.8).Z(), "paper", { tone: 1, width: 0.6 });
    }
  },
};

/* ---------------- blasons ---------------- */

const SHIELDS: Record<string, P2[]> = {
  heater: [[-0.5, 0.6], [0.5, 0.6], [0.5, 0.05], [0.38, -0.32], [0, -0.6], [-0.38, -0.32], [-0.5, 0.05]],
  round: [],
  kite: [[0, 0.62], [0.42, 0.35], [0.36, -0.1], [0, -0.68], [-0.36, -0.1], [-0.42, 0.35]],
  banner: [[-0.4, 0.65], [0.4, 0.65], [0.4, -0.6], [0, -0.38], [-0.4, -0.6]],
  square: [[-0.5, 0.55], [0.5, 0.55], [0.5, -0.55], [-0.5, -0.55]],
};
for (let i = 0; i < 24; i++) SHIELDS.round.push([Math.cos((i / 24) * Math.PI * 2 + Math.PI / 2) * 0.55, Math.sin((i / 24) * Math.PI * 2 + Math.PI / 2) * 0.55]);

function clipHalf(poly: P2[], a: number, b: number, c: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = a * p[0] + b * p[1] + c, fq = a * q[0] + b * q[1] + c;
    if (fp >= 0) out.push(p);
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

const star = (n: number, r0: number, r1: number): P2[] => Array.from({ length: n * 2 }, (_, i) => {
  const a = Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? r1 : r0;
  return [Math.cos(a) * r, Math.sin(a) * r] as P2;
});

export const drawEmblem: ObjectDrawer = (kit, p) => {
  const em = kit.em;
  const shape = SHIELDS[String(p.shape)] ?? SHIELDS.heater;
  const m = kit.board(0, 0.62, 0);
  const F = String(p.field ?? "accent"), T = String(p.tincture ?? "paper"), MT = String(p.metal ?? "metal");
  em.add(new Pen(compose(m, [1, 0, 0, 1, 0.04, -0.05])).smooth(shape.length > 8 ? shape : shape, true), "shadow", { kind: "shadow", stroke: null, alpha: 0.6 });
  em.add(new Pen(m).poly(shape), MT, { tone: 0, width: 1.2 });
  const inner = shape.map(([x, y]): P2 => [x * 0.86, y * 0.86 - 0.005]);
  const parts: [P2[], string][] = [];
  switch (String(p.division)) {
    case "per-pale":
      parts.push([clipHalf(inner, -1, 0, 0), F], [clipHalf(inner, 1, 0, 0), T]);
      break;
    case "per-fess":
      parts.push([clipHalf(inner, 0, 1, 0), F], [clipHalf(inner, 0, -1, 0), T]);
      break;
    case "per-bend":
      parts.push([clipHalf(inner, -1, 1, 0), F], [clipHalf(inner, 1, -1, 0), T]);
      break;
    case "quarterly":
      for (const [sx, sy, r] of [[-1, 1, F], [1, 1, T], [-1, -1, T], [1, -1, F]] as const) parts.push([clipHalf(clipHalf(inner, sx, 0, 0), 0, sy, 0), r]);
      break;
    case "chief":
      parts.push([clipHalf(inner, 0, -1, 0.3), F], [clipHalf(inner, 0, 1, -0.3), T]);
      break;
    default:
      parts.push([inner, F]);
  }
  for (const [poly, r] of parts) if (poly.length >= 3) em.add(new Pen(m).poly(poly), r, { tone: 0, width: 0.6 });
  // reflet de l'écu (bombé)
  em.add(new Pen(m).poly(clipHalf(clipHalf(inner, -1, 0, -0.12), 0, 1, -0.15)), "paper", { tone: 2, stroke: null, alpha: 0.2 });
  let c: P2[] | null = null;
  switch (String(p.charge)) {
    case "star":
      c = star(5, 0.24, 0.1);
      break;
    case "circle":
      c = Array.from({ length: 20 }, (_, i) => [Math.cos((i / 20) * Math.PI * 2) * 0.18, Math.sin((i / 20) * Math.PI * 2) * 0.18] as P2);
      break;
    case "cross":
      c = [[-0.06, 0.28], [0.06, 0.28], [0.06, 0.06], [0.24, 0.06], [0.24, -0.06], [0.06, -0.06], [0.06, -0.3], [-0.06, -0.3], [-0.06, -0.06], [-0.24, -0.06], [-0.24, 0.06], [-0.06, 0.06]];
      break;
    case "chevron":
      c = [[-0.34, -0.12], [0, 0.2], [0.34, -0.12], [0.34, -0.26], [0, 0.06], [-0.34, -0.26]];
      break;
    case "tower":
      c = [[-0.16, -0.26], [0.16, -0.26], [0.16, 0.12], [0.2, 0.12], [0.2, 0.26], [0.1, 0.26], [0.1, 0.18], [0.03, 0.18], [0.03, 0.26], [-0.03, 0.26], [-0.03, 0.18], [-0.1, 0.18], [-0.1, 0.26], [-0.2, 0.26], [-0.2, 0.12], [-0.16, 0.12]];
      break;
    case "tree":
      c = [[-0.03, -0.28], [0.03, -0.28], [0.03, -0.12], [0.2, -0.12], [0.08, 0.02], [0.15, 0.02], [0.05, 0.14], [0.1, 0.14], [0, 0.28], [-0.1, 0.14], [-0.05, 0.14], [-0.15, 0.02], [-0.08, 0.02], [-0.2, -0.12], [-0.03, -0.12]];
      break;
    case "crescent": {
      const pen = new Pen(m).M(0.05, 0.2).C(-0.22, 0.2, -0.22, -0.2, 0.05, -0.2).C(-0.1, -0.12, -0.1, 0.12, 0.05, 0.2).Z();
      em.add(pen, MT, { tone: 1, width: 0.6 });
      break;
    }
  }
  if (c) {
    em.add(new Pen(compose(m, [1, 0, 0, 1, 0.02, -0.02])).poly(c), "shadow", { kind: "shadow", stroke: null, alpha: 0.5 });
    em.add(new Pen(m).poly(c), MT, { tone: 1, width: 0.6 });
  }
  // rivets de bordure
  const rv = new Pen(m);
  shape.forEach(([x, y], i) => i % (shape.length > 8 ? 3 : 1) === 0 && rv.ellipse(x * 0.93, y * 0.93, 0.018, 0.018));
  em.add(rv, MT, { tone: 1, stroke: null });
};

/* ---------------- repli générique ---------------- */

/** Générateur ou valeur inconnus : silhouette sobre d'après l'emprise et la hauteur (volume arrondi, faces ombrées). */
export const drawGeneric: ObjectDrawer = (kit, _p, ctx) => {
  const o = ctx.obj;
  const hx = o.footprint.hx / o.scale, hz = o.footprint.hz / o.scale, h = Math.max(0.2, o.height / o.scale);
  const role = o.generator === "building" ? "wall" : o.generator === "character" ? "cloth1" : "stone";
  kit.castShadow(ctx.env.shadows, hx, hz, h * 0.8, ctx.env.ground, kit.em.z0 - 0.5, kit.em.layer, kit.em.depth);
  if (hx < h * 0.25 && hz < h * 0.25) {
    kit.lathe([[Math.max(hx, hz), 0], [Math.max(hx, hz) * 0.95, h * 0.7], [Math.max(hx, hz) * 0.7, h * 0.95], [0.01, h]], role, {});
    return;
  }
  kit.box(-hx, 0, -hz, hx, h * 0.92, hz, role, {});
  kit.box(-hx * 1.04, h * 0.92, -hz * 1.04, hx * 1.04, h, hz * 1.04, "trim", {});
};
