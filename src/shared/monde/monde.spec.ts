import { readMonde, partColor, mondeSummary, SHAPES } from "./format";
import { genMotion } from "./gen";
import { geometryOf } from "./geometry";
import { clipState, samplePose, setClip, STRIDE, forward } from "./pose";
import { MondeDriver } from "./driver";
import { hull, projOf, affineOf, silhouette, basisOf } from "./view2d";
import { readTex, texPixels, TEX_SIZE, TEX_KINDS } from "./textures";
import { PRESETS } from "./presets";
import { m4, m4Compose } from "./math";

const joueur = { preset: "bipede", seed: 3, params: { espece: "chat" } };

describe("monde : lecture", () => {
  it("ne lève jamais et signale les problèmes", () => {
    for (const bad of [null, 3, "x", [], { models: 4 }, { place: [{ model: "absent" }] }, { models: { a: { parts: [{ box: "x", sphere: 2 }] } } }]) {
      expect(() => readMonde(bad)).not.toThrow();
    }
    const m = readMonde({ place: [{ model: "absent" }] });
    expect(m.issues[0].message).toContain("modèle inconnu");
  });

  it("dédouble les pièces miroir et leurs enfants, côtés résolus", () => {
    const m = readMonde({ models: { j: joueur } });
    const names = m.models.get("j")!.parts.map((p) => p.name);
    for (const n of ["brasL", "brasR", "avantbrasL", "avantbrasR", "mainL", "mainR", "cuisseL", "molletR", "piedR"]) expect(names).toContain(n);
    const parts = m.models.get("j")!.parts;
    const mollet = parts.find((p) => p.name === "molletR")!;
    expect(parts[mollet.parent].name).toBe("cuisseR");
    // parents avant enfants
    parts.forEach((p, i) => expect(p.parent).toBeLessThan(i));
    expect(m.issues).toEqual([]);
  });

  it("tous les préréglages se lisent sans problème, quelle que soit la graine", () => {
    for (const name of Object.keys(PRESETS))
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const m = readMonde({ models: { x: { preset: name, seed } } });
        expect(m.issues, `${name}/${seed}`).toEqual([]);
        expect(m.models.get("x")!.parts.length).toBeGreaterThan(0);
      }
  });

  it("réutilise un modèle inchangé (pas de reconstruction)", () => {
    const src = { models: { j: joueur, k: { parts: [{ name: "a", box: [1, 1, 1] }] } } };
    const a = readMonde(src);
    const b = readMonde({ ...src, models: { ...src.models, k: { parts: [{ name: "a", box: [2, 1, 1] }] } } }, a);
    expect(b.models.get("j")).toBe(a.models.get("j"));
    expect(b.models.get("k")).not.toBe(a.models.get("k"));
  });

  it("répète, sème et quadrille", () => {
    const m = readMonde({
      models: { p: { parts: [{ name: "dent", box: [0.1, 0.1, 0.1], repeat: { n: 5, at: [0.2, 0, 0] } }] } },
      place: [{ model: "p", grid: [3, 4], step: [2, 0, 2] }, { model: "p", scatter: 7, area: [0, 0, 5, 5], seed: 2 }, { model: "p", name: "x" }],
    });
    expect(m.models.get("p")!.parts.map((p) => p.name)).toEqual(["dent0", "dent1", "dent2", "dent3", "dent4"]);
    expect(m.place.length).toBe(12 + 7 + 1);
    expect(m.place.filter((p) => p.name).map((p) => p.name)).toEqual(["x"]);
  });

  it("couleur : instance > préréglage > palette", () => {
    const m = readMonde({ palette: { maillot: "#111111" }, models: { j: joueur } });
    const md = m.models.get("j")!;
    const torse = md.parts.find((p) => p.name === "torse")!;
    expect(partColor(md, torse, undefined, m.palette)).toBe("#111111");
    expect(partColor(md, torse, { maillot: "#ff0000" }, m.palette)).toBe("#ff0000");
  });

  it("résumé : instances, clips, pièces", () => {
    const m = readMonde({ models: { j: joueur }, place: [{ model: "j", name: "p0" }, { model: "j" }] });
    const s = mondeSummary(m);
    expect(s.instances).toEqual([{ name: "p0", model: "j" }]);
    expect(s.decor).toBe(1);
    expect(s.models.j.clips).toContain("course");
  });
});

describe("monde : formes", () => {
  it("chaque forme donne un maillage fini, indices valides, UV présents", () => {
    const shapes: Record<string, unknown> = {
      box: [1, 0.5, 0.3, 0.1],
      sphere: [0.5, 0.3, 0.4],
      capsule: [0.1, 0.5],
      cylinder: [0.3, 1, 0.1],
      cone: [0.3, 1],
      torus: [0.5, 0.1, 270],
      lathe: [[0, 0], [0.3, 0.2], [0.1, 0.6]],
      extrude: { pts: [[0, 0], [1, 0], [0.5, 1]], depth: 0.2 },
      tube: { pts: [[0, 0, 0], [0, 1, 0], [0.5, 1.5, 0]], r: 0.05 },
      plane: [2, 3],
    };
    expect(Object.keys(shapes).filter((k) => k !== "cone").sort()).toEqual(SHAPES.filter((k) => k !== "cone").sort());
    for (const [k, v] of Object.entries(shapes)) {
      const m = readMonde({ models: { a: { parts: [{ name: "x", [k]: v }] } } });
      const g = geometryOf(m.models.get("a")!.parts[0], 1)!;
      expect(g, k).toBeTruthy();
      const n = g.pos.length / 3;
      expect(g.uv.length / 2).toBe(n);
      expect([...g.pos].every(Number.isFinite), k).toBe(true);
      expect([...g.idx].every((i) => i < n), k).toBe(true);
    }
  });

  it("normales sortantes et triangles dans le sens trigonométrique vu de dehors (sphère)", () => {
    const m = readMonde({ models: { a: { parts: [{ name: "x", sphere: 1 }] } } });
    const g = geometryOf(m.models.get("a")!.parts[0], 1)!;
    let ok = 0, tot = 0;
    for (let t = 0; t < g.idx.length; t += 3) {
      const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]].map((i) => [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9) continue;
      tot++;
      if (nx * a[0] + ny * a[1] + nz * a[2] > 0) ok++;
    }
    expect(ok / tot).toBeGreaterThan(0.99);
  });
});

describe("monde : clips et pilotage", () => {
  const m = readMonde({ models: { j: joueur }, place: [{ model: "j", name: "p0", clip: "marche" }] });
  const model = m.models.get("j")!;
  const offs = new Float32Array(model.parts.length * STRIDE);
  const iL = model.parts.findIndex((p) => p.name === "cuisseL");
  const iR = model.parts.findIndex((p) => p.name === "cuisseR");

  it("boucle périodique, côtés en opposition", () => {
    const st = clipState("marche", 0);
    samplePose(model, st, 0, offs);
    const a = offs[iL * STRIDE];
    const r = offs[iR * STRIDE];
    expect(Math.sign(a)).not.toBe(Math.sign(r));
    samplePose(model, st, model.clips.get("marche")!.ms, offs);
    expect(offs[iL * STRIDE]).toBeCloseTo(a, 4);
  });

  it("un clip non bouclé enchaîne sur `then`", () => {
    const st = clipState("tir", 0);
    const ms = model.clips.get("tir")!.ms;
    expect(samplePose(model, st, ms * 0.5, offs)).toBe(true);
    samplePose(model, st, ms + 500, offs);
    expect(st.clip).toBe("idle");
  });

  it("clipT fige la pose ; clipSpeed garde la phase", () => {
    const st = clipState("marche", 0);
    setClip(st, 100, undefined, undefined, 0.25);
    samplePose(model, st, 100, offs);
    const v = offs[iL * STRIDE];
    samplePose(model, st, 900, offs);
    expect(offs[iL * STRIDE]).toBeCloseTo(v, 5);
  });

  it("pilote : clip, couleurs, transformations interpolées", () => {
    const d = new MondeDriver();
    d.setMonde(m, 0);
    const r = d.apply("p0", { clip: "course", roles: { maillot: "#ff0000" }, x: 4, ease: { ms: 100 } }, 0, true, true)!;
    expect(r).toEqual({ pose: true, roles: true, transform: true });
    d.step(50);
    expect(d.instances.get("p0")!.t.x).toBeCloseTo(2, 1);
    d.step(200);
    expect(d.instances.get("p0")!.t.x).toBe(4);
    expect(d.instances.get("p0")!.roles.maillot).toBe("#ff0000");
    expect(d.apply("inconnu", { x: 1 }, 0, true, true)).toBeNull();
    // un nouveau monde garde l'état des instances conservées
    d.setMonde(readMonde({ models: { j: joueur }, place: [{ model: "j", name: "p0" }] }, m), 300);
    expect(d.instances.get("p0")!.t.x).toBe(4);
  });

  it("cinématique directe : la main suit le bras", () => {
    const st = clipState("joie", 0);
    samplePose(model, st, 200, offs);
    const w = new Float32Array(model.parts.length * 16);
    forward(model, offs, m4(), w, m4());
    const main = model.parts.findIndex((p) => p.name === "mainL");
    const tete = model.parts.findIndex((p) => p.name === "tete");
    // bras levés : la main passe au-dessus de l'articulation du cou
    expect(w[main * 16 + 13]).toBeGreaterThan(w[tete * 16 + 13]);
  });
});

describe("monde : vue 2D", () => {
  it("enveloppe convexe", () => {
    const h = hull([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5]);
    expect(h.length).toBe(8);
  });

  it("affine de dessus : x → x écran, z → y écran, à l'échelle", () => {
    const p = projOf("top");
    const w = m4Compose(m4(), 2, 0, 3, 0, 0, 0, 1, 1, 1);
    const [u, v] = basisOf([0, -1, 0]);
    const out = affineOf(w, u, v, p, 10, 100, 50, [0, 0, 0, 0, 0, 0]);
    expect(out[4]).toBeCloseTo(120);
    expect(out[5]).toBeCloseTo(80);
    // la base (u, v) se projette sur un repère orthonormé de l'écran
    expect(Math.abs(out[0] * out[3] - out[1] * out[2])).toBeCloseTo(100);
  });

  it("silhouette d'une sphère vue de face ≈ disque", () => {
    const m = readMonde({ models: { a: { parts: [{ name: "x", sphere: 1 }] } } });
    const g = geometryOf(m.models.get("a")!.parts[0], 2)!;
    const [u, v] = basisOf([0, 0, -1]);
    const h = silhouette(g.pos, u, v);
    for (let i = 0; i < h.length; i += 2) expect(Math.hypot(h[i], h[i + 1])).toBeGreaterThan(0.95);
  });
});

describe("monde : textures", () => {
  it("noms français et anglais, inconnu signalé", () => {
    expect(readTex("stripes")!.kind).toBe("rayures");
    expect(readTex({ kind: "herbe", scale: 3 })!.scale).toBe(3);
    const msgs: string[] = [];
    expect(readTex("plasma", (m) => msgs.push(m))).toBeNull();
    expect(msgs[0]).toContain("plasma");
  });

  it("chaque texture remplit sa tuile", () => {
    for (const k of TEX_KINDS) {
      const px = texPixels(readTex(k)!, "#336699");
      expect(px.length).toBe(TEX_SIZE * TEX_SIZE * 4);
      expect(px[3]).toBe(255);
    }
  });
});

describe("monde : entrées hostiles", () => {
  it("clés héritées (constructor, toString) : ni exception ni couleur invalide", () => {
    const m = readMonde({
      palette: { constructor: "#123456" },
      textures: { toString: "rayures" },
      models: { a: { preset: "constructor" }, b: { preset: "toString" }, c: { parts: [{ name: "x", box: 1, role: "constructor" }, { name: "y", box: 1, role: "toString" }, { name: "z", box: 1, role: "valueOf" }] } },
      place: [{ model: "c", name: "i", roles: { hasOwnProperty: "#ff0000" } }],
    });
    const c = m.models.get("c")!;
    for (const p of c.parts) expect(partColor(c, p, m.place[0].roles, m.palette)).toMatch(/^#[0-9a-f]{3,6}$/i);
    expect(m.issues.some((i) => i.message.includes("préréglage inconnu"))).toBe(true);
  });

  it("couleurs invalides ignorées (préréglage, patchs)", () => {
    const m = readMonde({ models: { j: { preset: "bipede", params: { peau: "banane" } } }, place: [{ model: "j", name: "p" }] });
    const md = m.models.get("j")!;
    expect(md.roles.peau).toMatch(/^#/);
    const d = new MondeDriver();
    d.setMonde(m, 0);
    d.apply("p", { roles: { peau: "banane", constructor: "#ffffff" } }, 0, true, true);
    expect(d.instances.get("p")!.roles.peau).toBeUndefined();
  });

  it("grilles et semis géants : bornés et rapides", () => {
    const t = performance.now();
    const m = readMonde({ models: { a: { parts: [{ name: "x", box: 1 }] } }, place: Array.from({ length: 50 }, () => ({ model: "a", grid: [200, 200, 200] })) });
    expect(performance.now() - t).toBeLessThan(1500);
    expect(m.place.length).toBeLessThanOrEqual(4000);
    expect(m.issues.length).toBeGreaterThan(0);
  });

  it("un clip qui s'enchaîne sur lui-même ou sur un clip absent s'arrête", () => {
    const m = readMonde({ models: { a: { parts: [{ name: "x", box: 1 }], clips: { k: { ms: 100, loop: false, then: "k", tracks: { x: { rx: [0, 10] } } }, l: { ms: 100, loop: false, then: "absent", tracks: { x: { rx: [0, 10] } } } } } } });
    const md = m.models.get("a")!;
    const o = new Float32Array(md.parts.length * STRIDE);
    expect(samplePose(md, clipState("k", 0), 500, o)).toBe(false);
    expect(samplePose(md, clipState("l", 0), 500, o)).toBe(false);
  });

  it("rayon nul : normales finies", () => {
    const m = readMonde({ models: { a: { parts: [{ name: "x", sphere: [0] }] } } });
    const g = geometryOf(m.models.get("a")!.parts[0], 0)!;
    expect([...g.nrm].every(Number.isFinite)).toBe(true);
  });
});

describe("monde : modèles gen (procgen)", () => {
  it("os en pièces nommées, clips par défaut, rôles du format, sans forme", () => {
    const m = readMonde({ models: { j: { gen: "character", params: { top: "tee" }, seed: 2 } }, place: [{ model: "j", name: "p0" }] });
    const j = m.models.get("j")!;
    expect(m.issues).toEqual([]);
    expect(j.gen).toEqual({ id: "character", params: { top: "tee" }, seed: "2", rig: "humanoid" });
    const names = j.parts.map((p) => p.name);
    for (const n of ["racine", "bassin", "torse", "tete", "cuisseL", "cuisseR", "avantBrasL", "mainR", "orteilL"]) expect(names).toContain(n);
    expect(j.parts.every((p) => p.shape === null)).toBe(true);
    for (const c of ["idle", "marche", "course", "joie", "tir", "passe", "tacle", "controle", "chute", "plongeon"]) expect(j.clips.has(c)).toBe(true);
    expect(j.clip).toBe("idle");
    expect(Object.keys(j.roles)).toEqual(expect.arrayContaining(["maillot", "short", "peau", "cloth1", "skin"]));
  });

  it("pistes d'os : paire en opposition, côté droit miroir ; os inconnus signalés", () => {
    const v = readMonde({
      models: { j: { gen: "character", params: { top: "tee" }, seed: 1 }, b: { box: [1, 1, 1] } as never },
      place: [
        { model: "j", name: "p0", params: { animal: "fox" } },
        { model: "j", name: "p1", params: { animal: "fox" } },
        { model: "j", name: "p2", genSeed: 7 },
        { model: "j", name: "p3" },
      ],
    });
    const mp = v.place.map((p) => p.model);
    expect(mp[0]).toBe(mp[1]);
    expect(mp[0]).toMatch(/^j~/);
    expect(mp[2]).not.toBe(mp[0]);
    expect(mp[3]).toBe("j");
    expect(v.models.get(mp[0])!.gen!.params).toMatchObject({ top: "tee", animal: "fox" });
    expect(v.models.get(mp[2])!.gen!.seed).not.toBe(v.models.get("j")!.gen!.seed);
    expect(v.models.get(mp[0])!.gen!.seed).toBe(v.models.get("j")!.gen!.seed);
    const a = readMonde({ models: { j: { gen: "character", clips: { danse: { action: "cheer", speed: 2, tracks: {} }, z: { action: "voler" } } } } });
    const cd = a.models.get("j")!.clips.get("danse")!;
    expect(cd.action).toBe("cheer");
    expect(cd.move).toBe(2);
    expect(a.issues.some((i) => i.path.endsWith("clips.z.action"))).toBe(true);
    expect(genMotion("danse", cd)).toEqual({ speed: 2, action: "cheer" });
    expect(genMotion("course", a.models.get("j")!.clips.get("course"))).toEqual({ speed: 3.8, action: "" });
    expect(genMotion("joie", null).action).toBe("cheer");
    const m = readMonde({ models: { j: { gen: "character", clips: { geste: { tracks: { bras: { rz: [0, 40] }, aileron: { rx: [0, 1] } } } } } } });
    const c = m.models.get("j")!.clips.get("geste")!;
    expect(c.tracks.length).toBe(2);
    expect(c.tracks[0].keys[1]).toBeCloseTo((40 * Math.PI) / 180);
    expect(c.tracks[1].keys[1]).toBeCloseTo((-40 * Math.PI) / 180);
    expect(c.tracks[1].phase).toBe(0.5);
    expect(m.issues.some((i) => i.path.endsWith("aileron"))).toBe(true);
  });

  it("animaux, oiseaux, décor ; générateur inconnu et pièces ignorées signalés", () => {
    const m = readMonde({
      models: { c: { gen: "animal.dog" }, o: { gen: "animal", params: { species: "duck" } }, a: { gen: "tree" }, x: { gen: "dragon" }, y: { gen: "rock", parts: [{ name: "a", box: [1, 1, 1] }] } },
    });
    expect(m.models.get("c")!.gen!.rig).toBe("quadruped");
    expect(m.models.get("c")!.parts.map((p) => p.name)).toContain("queue3");
    expect(m.models.get("o")!.gen!.rig).toBe("bird");
    expect(m.models.get("o")!.parts.map((p) => p.name)).toContain("aileL");
    expect(m.models.get("a")!.parts).toEqual([]);
    expect(m.models.get("x")!.gen).toBeNull();
    expect(m.issues.some((i) => i.path === "models.x.gen")).toBe(true);
    expect(m.issues.some((i) => i.path === "models.y.parts")).toBe(true);
  });

  it("os ↔ pièces", async () => {
    const { boneAlias, aliasBone } = await import("./gen");
    for (const b of ["thigh.l", "forearm.r", "neck.1", "tail.3", "head", "root", "wing.l"]) expect(aliasBone(boneAlias(b))).toBe(b);
    expect(aliasBone("chapeau")).toBeNull();
  });

  it("le pilote anime les os par les clips du format (rotations ajoutées)", () => {
    const m = readMonde({ models: { j: { gen: "character" } }, place: [{ model: "j", name: "p0" }] });
    const d = new MondeDriver();
    d.setMonde(m, 0);
    d.apply("p0", { clip: "tir" }, 0, true, false);
    d.step(300);
    const inst = d.instances.get("p0")!;
    const i = inst.model.parts.findIndex((p) => p.name === "cuisseR");
    expect(Math.abs(inst.offs[i * STRIDE])).toBeGreaterThan(0.1);
  });
});

describe("monde : traits", () => {
  it("importance des traits bornée, 1 par défaut", () => {
    expect(readMonde({}).traits).toBe(1);
    expect(readMonde({ traits: 0.4 }).traits).toBeCloseTo(0.4);
    expect(readMonde({ traits: 9 }).traits).toBe(3);
    expect(readMonde({ traits: "x" as never }).traits).toBe(1);
  });
});
