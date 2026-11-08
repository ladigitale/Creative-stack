import { readMonde2d, flattenPath, partColor2, monde2dSummary, STRIDE2, MULT2 } from "./format";
import { PRESETS2D } from "./presets";
import { Monde2dDriver } from "./driver";
import { clipState, sampleClips } from "../monde/pose";

describe("monde2d : lecture", () => {
  it("ne lève jamais, signale les problèmes, ignore les clés héritées", () => {
    for (const bad of [null, 1, "x", [], { models: 3 }, { place: [{ model: "?" }] }, { models: { a: { preset: "constructor" } } }, { models: { a: { parts: [{ path: "M 0 0 Q" }] } } }]) {
      expect(() => readMonde2d(bad)).not.toThrow();
    }
    const m = readMonde2d({ models: { a: { preset: "toString" } } });
    expect(m.issues.some((i) => i.message.includes("préréglage inconnu"))).toBe(true);
  });

  it("tous les préréglages, toutes les vues, plusieurs graines : sans problème, points finis", () => {
    for (const name of Object.keys(PRESETS2D))
      for (const vue of ["profil", "face", "dessus"])
        for (const seed of [1, 2, 3, 4]) {
          const m = readMonde2d({ models: { x: { preset: name, seed, params: { vue } } } });
          expect(m.issues, `${name}/${vue}/${seed}`).toEqual([]);
          const md = m.models.get("x")!;
          expect(md.parts.length).toBeGreaterThan(0);
          for (const p of md.parts) if (p.shape) expect(p.shape.pts.every(Number.isFinite), `${name}/${p.name}`).toBe(true);
        }
  });

  it("miroir de profil (z) : côté éloigné derrière, assombri, animé en décalé sans inversion", () => {
    const m = readMonde2d({ models: { j: { preset: "personnage", seed: 1, params: { vue: "profil" } } } });
    const md = m.models.get("j")!;
    const L = md.parts.find((p) => p.name === "cuisseL")!, R = md.parts.find((p) => p.name === "cuisseR")!;
    expect(R.z).toBeLessThan(L.z);
    expect(R.shade).toBeLessThan(0);
    const molR = md.parts.find((p) => p.name === "molletR")!;
    expect(molR.z).toBeLessThan(md.parts.find((p) => p.name === "molletL")!.z);
    const marche = md.clips.get("marche")!;
    const tL = marche.tracks.find((t) => md.parts[t.part].name === "cuisseL" && t.ch === 0)!;
    const tR = marche.tracks.find((t) => md.parts[t.part].name === "cuisseR" && t.ch === 0)!;
    expect(tR.keys).toEqual(tL.keys);
    expect(tR.phase - tL.phase).toBeCloseTo(0.5);
  });

  it("miroir vu de dessus (y) : pieds de part et d'autre, translation y inversée", () => {
    const m = readMonde2d({ models: { j: { preset: "personnage", seed: 1, params: { vue: "dessus" } } } });
    const md = m.models.get("j")!;
    const L = md.parts.find((p) => p.name === "piedL")!, R = md.parts.find((p) => p.name === "piedR")!;
    expect(L.at[1]).toBeCloseTo(-R.at[1]);
  });

  it("chemin SVG restreint : M L Q C Z, et rien d'autre", () => {
    const r = flattenPath("M0 0 L10 0 Q 15 5 10 10 C 5 15 0 10 0 5 Z", 24)!;
    expect(r.closed).toBe(true);
    expect(r.pts.length).toBeGreaterThan(10);
    expect(flattenPath("alert(1)", 24)).toBeNull();
  });

  it("placements bornés, calques, ordre", () => {
    const m = readMonde2d({
      layers: [{ name: "fond", parallax: 0.3 }, { name: "monde", parallax: 1, ysort: true }],
      models: { a: { parts: [{ name: "x", circle: 5 }] } },
      place: [{ model: "a", grid: [500, 500] }, { model: "a", name: "p", layer: "inconnu" }],
    });
    expect(m.place.length).toBeLessThanOrEqual(3000);
    expect(m.issues.length).toBeGreaterThan(0);
    expect(m.layers.map((l) => l.name)).toEqual(["fond", "monde"]);
  });

  it("couleurs : rôle d'instance validé", () => {
    const m = readMonde2d({ models: { j: { preset: "personnage", seed: 2 } } });
    const md = m.models.get("j")!;
    const torse = md.parts.find((p) => p.name === "torse")!;
    expect(partColor2(md, torse, { maillot: "#ff0000" }, m.palette)).toBe("#ff0000");
    expect(partColor2(md, torse, { maillot: "rouge" }, m.palette)).toMatch(/^#/);
  });

  it("résumé", () => {
    const m = readMonde2d({ models: { j: { preset: "personnage" } }, place: [{ model: "j", name: "p0" }, { model: "j" }] });
    const s = monde2dSummary(m);
    expect(s.instances[0].name).toBe("p0");
    expect(s.models.j.clips).toContain("tacle");
  });
});

describe("monde2d : clips et pilotage", () => {
  const m = readMonde2d({ models: { j: { preset: "personnage", seed: 3, params: { vue: "profil" } } }, place: [{ model: "j", name: "p0" }] });
  const md = m.models.get("j")!;

  it("échelles et opacité multiplicatives à 1 par défaut", () => {
    const out = new Float32Array(md.parts.length * STRIDE2);
    sampleClips(md.clips, clipState("idle", 0), 100, out, STRIDE2, MULT2);
    expect(out[3]).toBe(1);
    expect(out[6]).toBe(1);
  });

  it("pilote : clip, flip, déplacement interpolé, pièces", () => {
    const d = new Monde2dDriver();
    d.setMonde(m, 0);
    expect(d.apply("p0", { x: 100, ease: { ms: 100 }, clip: "course", flip: true, roles: { maillot: "#ff0000" } }, 0, true)).toBe(true);
    d.step(50);
    const inst = d.instances.get("p0")!;
    expect(inst.t.x).toBeGreaterThan(0);
    expect(inst.flip).toBe(true);
    expect(inst.clip.clip).toBe("course");
    expect(d.apply("p0_tete", { color: "#00ff00", visible: false }, 0, true)).toBe(true);
    expect([...inst.over.values()][0]).toEqual({ color: "#00ff00", visible: false });
    expect(d.apply("inconnu", { x: 1 }, 0, true)).toBe(false);
  });
});
