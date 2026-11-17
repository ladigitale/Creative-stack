import { describe, expect, it } from "vitest";
import { composeScene } from "./compose";
import { mergeEmitters, readProcgenEmitters, SHAPES } from "./emitters";
import { ProcgenEmitterLayer, sceneBoxes } from "../render/emitters";
import { makeMaterials, sharedUniforms } from "../render/materials";
import { ROLES } from "../style/roles";
import { Issues } from "../core/schema";
import { SceneFx, fxInputOf } from "./fx";

const layer = () => {
  const shared = sharedUniforms();
  return new ProcgenEmitterLayer(shared, makeMaterials(shared, { value: new Float32Array(ROLES.length * 3) }));
};

/** Petite scène plate : une maison au centre, de l'eau au sud. */
function scene(extra: Record<string, unknown> = {}) {
  return composeScene({
    recipe: { size: [40, 40], ground: { relief: 0, ...extra }, layers: [{ id: "maison", gen: "building", params: { floors: 2 }, place: { at: [[0, 0]] } }] } as never,
    seed: 3,
  });
}

function run(l: ProcgenEmitterLayer, s: number, step = 1 / 30) {
  for (let t = 0; t < s; t += step) l.advance(step, t);
}

describe("procgen : émetteurs", () => {
  it("lit formes et générateurs, signale l'inconnu et le trop lourd", () => {
    const r = readProcgenEmitters({
      a: { shape: "bird", flock: { altitude: [8, 10] }, spawn: { count: 10, area: [-5, -5, 5, 5] } },
      b: { gen: "ball.soccer", speed: 8 },
      c: { gen: "licorne" },
      d: { gen: "building" },
      e: { shape: "dragon" },
    });
    expect(r.specs.map((s) => s.id)).toEqual(["a", "b"]);
    expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["emitters.c.gen", "emitters.d.gen", "emitters.e.shape"]));
    expect(r.looks[0].variants[0].frames).toHaveLength(4);
    expect(r.looks[0].flap).toBeGreaterThan(0);
    expect(r.looks[1].variants[0].frames).toHaveLength(1);
    // un ballon vole par son centre
    const bb = r.looks[1].variants[0].frames[0].bounds();
    expect(Math.abs(bb.min[1] + bb.max[1])).toBeLessThan(0.02);
  });

  it("toutes les formes légères se construisent en peu de triangles", () => {
    for (const shape of SHAPES) {
      const r = readProcgenEmitters({ x: { shape } });
      expect(r.looks[0].triangles, shape).toBeGreaterThan(0);
      expect(r.looks[0].triangles, shape).toBeLessThan(800);
    }
  });

  it("qualité réduite (mobile) : moitié des copies, sauf `mobile` propre à l'émetteur", () => {
    const src = { a: { shape: "bee", max: 400, spawn: { count: 400, area: [0, 0, 1, 1] }, rate: 10 }, b: { shape: "bee", max: 100, mobile: 1 } };
    const r = readProcgenEmitters(src, { quality: 0.5 });
    expect(r.specs[0].max).toBe(200);
    expect(r.specs[0].spawn!.count).toBe(200);
    expect(r.specs[0].rate).toBe(5);
    expect(r.specs[1].max).toBe(100);
  });

  it("pigeon en vol : images d'ailes battues figées, sans squelette ; variantes distinctes", () => {
    const r = readProcgenEmitters({ p: { gen: "animal.pigeon", variants: 2, flock: { altitude: 10 } } }, { seed: 5 });
    const v = r.looks[0].variants;
    expect(v).toHaveLength(2);
    expect(v[0].frames).toHaveLength(4);
    for (const f of v[0].frames) expect(f.skin).toBeNull();
    const span = (k: number) => {
      const b = v[0].frames[k].bounds();
      return b.max[0] - b.min[0];
    };
    // ailes déployées puis battues : l'envergure change d'une image à l'autre, plus large que le corps
    expect(span(0)).toBeGreaterThan(0.3);
    expect(Math.abs(span(0) - span(3))).toBeGreaterThan(0.05);
    expect(r.specs[0].variants).toHaveLength(2);
  });

  it("fusion recette ⊕ DataProvider : champs remplacés, null retire", () => {
    const m = mergeEmitters({ a: { shape: "bird", rate: 1 }, b: { shape: "rat" } }, { a: { rate: 3 }, b: null, c: { shape: "fish" } })!;
    expect(m).toEqual({ a: { shape: "bird", rate: 3 }, c: { shape: "fish" } });
  });

  it("boîtes de la scène : la maison est une cible (id, calque, générateur, famille)", () => {
    const boxes = sceneBoxes(scene());
    const b = boxes.find((x) => x.name === "maison.0")!;
    expect(b.tags).toEqual(expect.arrayContaining(["maison", "building", "batiment", "mur", "decor"]));
    expect(b.hi[1]).toBeGreaterThan(3);
  });

  it("un projectile touche le mur de la maison, sans le traverser, et publie l'impact", () => {
    const l = layer();
    l.setModel(scene());
    const hits: { target: string; z: number }[] = [];
    l.onHits = (h) => hits.push(...h);
    l.mount(readProcgenEmitters({ feu: { shape: "fireball", at: [0, 1.5, -15], dir: [0, 0, 1], speed: 20, mask: ["mur", "sol"], life: 4 } }));
    l.orders({ feu: { n: 0 } });
    l.orders({ feu: { n: 1, count: 3 } });
    run(l, 2);
    expect(hits.length).toBe(3);
    for (const h of hits) {
      expect(h.target).toBe("maison.0");
      expect(h.z).toBeLessThan(0);
    }
    expect(l.stats().feu.alive).toBe(0);
    l.dispose();
  });

  it("eau : une pierre tombée dans la mare touche `eau` ; hors de la scène : sortie comptée et signalée", () => {
    const l = layer();
    const m = composeScene({ recipe: { size: [40, 40], ground: { relief: 0, water: 0.5, coast: "south", coastAt: 0.5, coastDepth: 2 }, layers: [] } as never, seed: 1 });
    l.setModel(m);
    const tags: string[] = [];
    const exits: number[] = [];
    l.onHits = (h) => h.forEach((x) => tags.push(...x.tags));
    l.onExit = (e) => exits.push(e.count);
    // trouve un point sous l'eau
    let wz = 0;
    for (let z = -19; z < 19; z += 0.5) if (m.terrain!.height(0, z) < 0.3) wz = z;
    l.mount(readProcgenEmitters({ caillou: { shape: "stone", at: [0, 6, wz], dir: [0, -1, 0], speed: 2, gravity: 9.8, mask: ["eau"] }, fleche: { shape: "arrow", at: [0, 3, 0], dir: [1, 0, 0], speed: 40, events: ["exit"] } }));
    l.orders({ caillou: { n: 0 }, fleche: { n: 0 } });
    l.orders({ caillou: { n: 1 }, fleche: { n: 1 } });
    run(l, 2);
    expect(tags).toContain("eau");
    expect(exits).toEqual([1]);
    expect(l.stats().fleche.exited).toBe(1);
    l.dispose();
  });

  it("nuée en vol : les oiseaux tiennent leur altitude au-dessus du relief et suivent leur cible", () => {
    const l = layer();
    const m = scene();
    l.setModel(m);
    l.poseOf = (n) => (n === "maison.0" ? { x: 0, y: 0, z: 0, ry: 0 } : null);
    l.mount(readProcgenEmitters({ oiseaux: { shape: "bird", spawn: { count: 60, area: [-18, -18, -8, -8] }, flock: { altitude: [9, 11], seek: "maison.0", speed: [3, 5] }, publish: 2 } }));
    run(l, 6);
    const sim = l.sim("oiseaux")!;
    expect(sim.n).toBe(60);
    let cx = 0, cz = 0;
    for (let i = 0; i < sim.n; i++) {
      const h = sim.py[i] - m.terrain!.height(sim.px[i], sim.pz[i]);
      expect(h).toBeGreaterThan(7);
      expect(h).toBeLessThan(13);
      cx += sim.px[i] / sim.n;
      cz += sim.pz[i] / sim.n;
    }
    // le centre de la nuée s'est rapproché de la maison (départ vers (-13, -13))
    expect(Math.hypot(cx, cz)).toBeLessThan(12);
    expect(l.stats().oiseaux.near).toHaveLength(2);
    l.dispose();
  });

  it("relecture sans changement de définition : les copies en vol sont gardées, les réglages vivants suivis", () => {
    const l = layer();
    l.setModel(scene());
    const src = { r: { shape: "rat", spawn: { count: 20, area: [-5, 10, 5, 15] }, flock: { speed: [1, 2] } } };
    l.mount(readProcgenEmitters(src));
    const sim = l.sim("r");
    run(l, 0.5);
    l.mount(readProcgenEmitters({ r: { ...src.r, flock: { speed: [3, 4] } } }));
    expect(l.sim("r")).toBe(sim);
    expect(l.sim("r")!.spec.flock!.speed).toEqual([3, 4]);
    l.dispose();
  });
});

describe("procgen : émetteurs, boîtes tournées", () => {
  it("un tir touche la façade d'une maison tournée, pas sa boîte englobante", () => {
    const m = composeScene({ recipe: { size: [40, 40], ground: { relief: 0 }, layers: [{ id: "maison", gen: "building", params: { floors: 2 }, place: { at: [{ x: 0, z: 0, yaw: 40 }] } }] } as never, seed: 3 });
    const box = sceneBoxes(m).find((b) => b.name === "maison.0")!;
    expect(box.obb).toBeDefined();
    const l = layer();
    l.setModel(m);
    const hits: { x: number; z: number }[] = [];
    l.onHits = (h) => hits.push(...h);
    // le long de la diagonale : le coin de la boîte englobante est loin du mur réel
    l.mount(readProcgenEmitters({ f: { shape: "dart", at: [-15, 1.5, -15], dir: [1, 0, 1], speed: 30, radius: 0.05, mask: ["mur"] } }));
    l.orders({ f: { n: 0 } });
    l.orders({ f: { n: 1 } });
    run(l, 1.5);
    expect(hits).toHaveLength(1);
    const o = box.obb!, c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    const lx = (hits[0].x - o.cx) * c - (hits[0].z - o.cz) * s, lz = (hits[0].x - o.cx) * s + (hits[0].z - o.cz) * c;
    // le point touché est sur le bord de l'emprise tournée (au rayon près)
    expect(Math.max(Math.abs(lx) - o.hx, Math.abs(lz) - o.hz)).toBeGreaterThan(-0.01);
    expect(Math.max(Math.abs(lx) - o.hx, Math.abs(lz) - o.hz)).toBeLessThan(0.1);
    l.dispose();
  });
});

describe("procgen : émetteurs, allègement", () => {
  it("une grande nuée d'animaux est allégée sous le budget ; `lod: false` garde le modèle", () => {
    const big = readProcgenEmitters({ p: { gen: "animal.pigeon", max: 400, flock: { altitude: 10 } } }, { seed: 2 });
    const full = readProcgenEmitters({ p: { gen: "animal.pigeon", max: 400, lod: false, flock: { altitude: 10 } } }, { seed: 2 });
    expect(full.looks[0].triangles).toBeGreaterThan(1000);
    expect(big.looks[0].triangles).toBeLessThanOrEqual(300);
    expect(big.looks[0].triangles).toBeGreaterThan(40);
    const b = big.looks[0].variants[0].frames[0].bounds(), f = full.looks[0].variants[0].frames[0].bounds();
    // même silhouette (envergure à 15 % près)
    expect(Math.abs((b.max[0] - b.min[0]) / (f.max[0] - f.min[0]) - 1)).toBeLessThan(0.15);
  });
});

describe("procgen : émetteurs et particules", () => {
  it("traînée semée par chaque copie (le système ne naît plus à sa source), salve au point d'impact", () => {
    const recipe = { size: [30, 30], ground: { relief: 0 }, layers: [], particles: { fumee: { preset: "smoke", rate: 20, at: [0, 1, 0] }, eclats: { preset: "sparks", burst: 12 } } };
    const m = composeScene({ recipe: recipe as never, seed: 1 });
    const fx = new SceneFx();
    fx.configure(fxInputOf(recipe as never), m, {}, new Issues());
    const l = layer();
    l.setModel(m);
    l.mount(readProcgenEmitters({ feu: { shape: "fireball", at: [-10, 2, 0], dir: [1, 0, 0], speed: 8, mask: ["sol"], gravity: 2, trail: "fumee", burst: "eclats" } }));
    fx.trailed = new Set(["fumee"]);
    const ctx = { target: [0, 0, 0] as [number, number, number], extent: 12 };
    const born = (id: string) => fx.systems.find((x) => x.id === id)!.sys.spawned;
    fx.step(0.5, ctx);
    // sans copie en vol, la traînée ne sème rien (pas de naissance à la source du système)
    expect(born("fumee")).toBe(0);
    l.onHits = (h) => h.forEach((x) => fx.impact("eclats", [x.x, x.y, x.z]));
    l.orders({ feu: { n: 0 } });
    l.orders({ feu: { n: 1 } });
    for (let t = 0; t < 2; t += 1 / 30) {
      l.advance(1 / 30, t);
      fx.step(1 / 30, ctx);
      fx.trail("fumee", l.sim("feu")!, 1 / 30);
    }
    expect(born("fumee")).toBeGreaterThan(8);
    expect(born("eclats")).toBeGreaterThan(0);
    l.dispose();
  });
});

describe("procgen : émetteurs dans le monde infini", () => {
  it("le peuplement des tuiles chargées arrête les tirs, le sol suit le relief des tuiles", () => {
    const l = layer();
    l.setModel(composeScene({ recipe: { size: [20, 20], ground: { relief: 0 }, layers: [] } as never, seed: 1 }));
    // « tuile » : une maison loin du centre de la scène de base
    const tile = composeScene({ recipe: { size: [40, 40], ground: { relief: 0 }, layers: [{ id: "t0_maison", gen: "building", place: { at: [[10, 0]] } }] } as never, seed: 2 });
    const objects = tile.objects.map((o) => ({ ...o, pos: [o.pos[0] + 100, o.pos[1], o.pos[2]] as [number, number, number] }));
    const w = { height: () => 0.5, waterLevel: null, objects: () => objects, version: 1 };
    l.syncInfinite(w);
    const hits: { target: string; x: number }[] = [];
    l.onHits = (h) => hits.push(...h);
    l.mount(readProcgenEmitters({ f: { shape: "dart", at: [95, 2, 0], dir: [1, 0, 0], speed: 30, mask: ["batiment", "sol"] } }));
    l.orders({ f: { n: 0 } });
    l.orders({ f: { n: 1 } });
    run(l, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].target).toBe("t0_maison.0");
    expect(hits[0].x).toBeGreaterThan(100);
    expect(l.world().bounds).toBeNull();
    expect(l.world().ground(500, 500)).toBe(0.5);
    l.dispose();
  });
});
