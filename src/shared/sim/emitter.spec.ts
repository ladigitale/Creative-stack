import { describe, expect, it } from "vitest";
import { BoxGrid, sweepBox } from "./grid";
import { Emitter, readEmitters, type Hit, type SimWorld } from "./emitter";

function world(boxes: { name?: string; tags: string[]; lo: number[]; hi: number[] }[] = [], poses: Record<string, { x: number; y: number; z: number; ry: number }> = {}): SimWorld {
  const g = new BoxGrid(2);
  for (const b of boxes) g.add({ name: b.name ?? "", tags: b.tags, lo: b.lo as never, hi: b.hi as never });
  return { boxes: g, ground: () => 0, pose: (n) => poses[n] ?? null };
}

function one(spec: Record<string, unknown>) {
  const issues: { path: string; message: string }[] = [];
  const [s] = readEmitters({ e: spec }, 1, issues);
  s.variants = [{ model: s.model, roles: {} }];
  return { e: new Emitter(s), issues };
}

const run = (e: Emitter, w: SimWorld, seconds: number, hits: Hit[] = []) => {
  for (let t = 0; t < seconds; t += 1 / 60) e.advance(1 / 60, w, hits);
  return hits;
};

describe("grille et balayage", () => {
  it("un segment rapide ne traverse pas une boîte mince", () => {
    const h = sweepBox([0, 1, 0], [0, 1, 10], 0.1, { name: "mur", tags: ["mur"], lo: [-1, 0, 5], hi: [1, 2, 5.05] });
    expect(h).not.toBeNull();
    expect(h!.t).toBeCloseTo((5 - 0.1) / 10, 3);
    expect(h!.n).toEqual([0, 0, -1]);
  });
  it("la grille rend chaque boîte une fois", () => {
    const g = new BoxGrid(1);
    g.add({ name: "a", tags: [], lo: [0, 0, 0], hi: [3, 1, 3] });
    let n = 0;
    g.query(-1, -1, 5, 5, () => n++);
    expect(n).toBe(1);
  });
});

describe("émetteur ballistic", () => {
  it("lit les réglages et signale les erreurs", () => {
    const issues: { path: string; message: string }[] = [];
    const list = readEmitters({ ok: { model: "boule", speed: [5, 6], onHit: "colle" }, "1x": { model: "a" }, sans: {} }, 1, issues);
    expect(list.map((s) => s.id)).toEqual(["ok"]);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(["emitters.ok.onHit", "emitters.1x", "emitters.sans"]));
  });

  it("une salve touche le mur visé et meurt (événement regroupé)", () => {
    const { e } = one({ model: "boule", at: [0, 1, 0], dir: [0, 0, 1], speed: 20, mask: ["mur"], life: 3 });
    const w = world([{ name: "mur", tags: ["mur"], lo: [-2, 0, 8], hi: [2, 3, 8.2] }]);
    e.emit(3, w);
    expect(e.n).toBe(3);
    const hits = run(e, w, 1);
    expect(hits.length).toBe(3);
    expect(hits[0].target).toBe("mur");
    expect(hits[0].z).toBeLessThan(8.01);
    expect(e.n).toBe(0);
  });

  it("part de l'instance source et suit son cap", () => {
    const { e } = one({ model: "boule", from: "heros", offset: [0, 1, 0.5], dir: [0, 0, 1], speed: 10 });
    const w = world([], { heros: { x: 4, y: 0, z: 2, ry: Math.PI / 2 } });
    e.emit(1, w);
    expect(e.px[0]).toBeCloseTo(4.5, 3);
    expect(e.py[0]).toBeCloseTo(1, 3);
    expect(e.vx[0]).toBeCloseTo(10, 3);
    expect(Math.abs(e.vz[0])).toBeLessThan(1e-3);
  });

  it("tombe, rebondit au sol puis s'arrête de rebondir", () => {
    const { e } = one({ model: "balle", at: [0, 2, 0], dir: [0, 0, 1], speed: 1, gravity: 9.8, mask: ["sol"], onHit: "bounce", bounce: 0.4, life: 0 });
    const w = world();
    e.emit(1, w);
    const hits = run(e, w, 4);
    expect(hits.length).toBeGreaterThan(1);
    expect(e.n).toBe(1);
    expect(e.py[0]).toBeLessThan(0.3);
    expect(e.py[0]).toBeGreaterThanOrEqual(0);
  });

  it("pool plein : la plus ancienne est recyclée", () => {
    const { e } = one({ model: "b", max: 4, speed: 1 });
    const w = world();
    e.emit(4, w);
    run(e, w, 0.2);
    e.emit(2, w);
    expect(e.n).toBe(4);
    expect(e.dropped).toBe(2);
  });

  it("même graine, même tir", () => {
    const a = one({ model: "b", spread: 30, speed: [5, 9], seed: "x" }).e;
    const b = one({ model: "b", spread: 30, speed: [5, 9], seed: "x" }).e;
    const w = world();
    a.emit(5, w);
    b.emit(5, w);
    run(a, w, 0.5);
    run(b, w, 0.5);
    expect(Array.from(a.px.slice(0, 5))).toEqual(Array.from(b.px.slice(0, 5)));
  });

  it("kill retire une copie par son identifiant", () => {
    const { e } = one({ model: "b", speed: 1 });
    e.emit(3, world());
    const id = e.ids[1];
    expect(e.kill([id])).toBe(1);
    expect(Array.from(e.ids.slice(0, e.n))).not.toContain(id);
  });
});

describe("émetteur flock", () => {
  it("la nuée rejoint sa cible sans s'entasser", () => {
    const { e } = one({ model: "rat", max: 60, spawn: { count: 60, area: [-10, -10, -5, -5] }, flock: { seek: "heros", speed: [2, 3], separation: 0.5 } });
    const w = world([], { heros: { x: 6, y: 0, z: 6, ry: 0 } });
    e.seed(w);
    const d0 = avgDist(e, 6, 6);
    run(e, w, 8);
    expect(avgDist(e, 6, 6)).toBeLessThan(d0 / 3);
    // séparation : peu de paires collées
    let close = 0;
    for (let i = 0; i < e.n; i++) for (let j = i + 1; j < e.n; j++) if (Math.hypot(e.px[i] - e.px[j], e.pz[i] - e.pz[j]) < 0.1) close++;
    expect(close).toBeLessThan(e.n / 4);
  });

  it("contourne les boîtes de son masque", () => {
    const { e } = one({ model: "rat", max: 20, spawn: { count: 20, area: [-1, -6, 1, -5] }, mask: ["decor"], flock: { seek: "fromage", speed: 2 } });
    const w = world([{ tags: ["decor"], lo: [-1.5, 0, -1], hi: [1.5, 1, 1] }], { fromage: { x: 0, y: 0, z: 6, ry: 0 } });
    e.seed(w);
    for (let t = 0; t < 10; t += 1 / 60) {
      e.advance(1 / 60, w, []);
      for (let i = 0; i < e.n; i++) {
        const inside = Math.abs(e.px[i]) < 1.5 && Math.abs(e.pz[i]) < 1;
        expect(inside).toBe(false);
      }
    }
  });

  it("fuit une instance proche", () => {
    const { e } = one({ model: "lapin", max: 10, spawn: { count: 10, area: [-1, -1, 1, 1] }, flock: { flee: "chien", fleeRadius: 6, speed: 3, wander: 0 } });
    const w = world([], { chien: { x: 0, y: 0, z: -2, ry: 0 } });
    e.seed(w);
    run(e, w, 3);
    expect(avgDist(e, 0, -2)).toBeGreaterThan(5);
  });
});

function avgDist(e: Emitter, x: number, z: number) {
  let s = 0;
  for (let i = 0; i < e.n; i++) s += Math.hypot(e.px[i] - x, e.pz[i] - z);
  return s / Math.max(1, e.n);
}

describe("tir sur une nuée", () => {
  it("un projectile touche une copie d'un autre émetteur et la retire", () => {
    const issues: { path: string; message: string }[] = [];
    const [b, r] = readEmitters({ b: { model: "boule", at: [0, 0.1, 0], speed: 20, mask: ["rats"] }, rats: { model: "rat", max: 5, spawn: { count: 5, area: [-0.1, 4, 0.1, 4.2] }, flock: { speed: 0.01, wander: 0 } } }, 1, issues);
    b.variants = [{ model: "boule", roles: {} }];
    r.variants = [{ model: "rat", roles: {} }];
    const eb = new Emitter(b), er = new Emitter(r);
    const w = world();
    w.emitter = (id) => (id === "rats" ? er : null);
    er.seed(w);
    eb.emit(1, w);
    const hits: Hit[] = [];
    for (let t = 0; t < 1; t += 1 / 60) {
      er.advance(1 / 60, w, []);
      eb.advance(1 / 60, w, hits);
    }
    expect(hits.length).toBe(1);
    expect(hits[0].target).toBe("rats");
    expect(typeof hits[0].copy).toBe("number");
    expect(er.n).toBe(4);
    expect(eb.n).toBe(0);
  });
});
