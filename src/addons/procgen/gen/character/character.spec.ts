import { describe, expect, it } from "vitest";
import { Rng } from "../../core/rng";
import { Issues, resolveParams } from "../../core/schema";
import { MAX_BONES } from "../../render/shaders";
import { ROLE } from "../../style/roles";
import { character } from "../character";
import type { Look } from "./look";

function build(params: Record<string, unknown>, seed = "chr-test") {
  const issues = new Issues();
  const rng = new Rng(seed);
  const p = resolveParams(character.schema, params, { rng, vars: {} }, issues);
  return { asset: character.build(p, { rng, issues, path: "t" }), issues };
}

describe("personnage : précision et variété", () => {
  const { asset } = build({ detail: "crowd", top: "shirt", pattern: "stripes", over: "vest", beard: "full", figure: "masculine", age: "adult", item: "staff", gloves: "none" });
  const m = asset.mesh;

  it("bords de couleur nets : chaque triangle n'a qu'un rôle", () => {
    let mixed = 0;
    for (let t = 0; t < m.idx.length; t += 3) {
      const r = m.role[m.idx[t]];
      if (m.role[m.idx[t + 1]] !== r || m.role[m.idx[t + 2]] !== r) mixed++;
    }
    expect(mixed).toBe(0);
    // le motif est bien là : rayures (détail) sur le haut
    expect(m.role.filter((r) => r === ROLE.cloth3).length).toBeGreaterThan(100);
  });

  it("maillage valide : poids normalisés, indices dans les bornes, squelette ≤ MAX_BONES", () => {
    expect(asset.skeleton!.count).toBeLessThanOrEqual(MAX_BONES);
    for (let v = 0; v < m.vertexCount; v++) {
      const w = m.weight!.slice(v * 4, v * 4 + 4);
      expect(Math.abs(w.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-3);
    }
    expect(Math.max(...m.idx)).toBeLessThan(m.vertexCount);
    expect(m.morph!.length).toBe(m.vertexCount * 3);
  });

  it("la main droite se referme sur l'objet tenu (prise au contact de la main)", () => {
    const grip = asset.anchors["hand.r.grip"].pos;
    const hand = asset.skeleton!.index["hand.r"];
    let near = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      if (m.role[v] !== ROLE.skin || m.skin![v * 4] !== hand) continue;
      if (Math.hypot(m.pos[v * 3] - grip[0], m.pos[v * 3 + 1] - grip[1], m.pos[v * 3 + 2] - grip[2]) < 0.05) near++;
    }
    expect(near).toBeGreaterThan(20);
  });
});

describe("valeurs auto cohérentes", () => {
  const looks: Look[] = [];
  for (let i = 0; i < 40; i++) looks.push(build({ detail: "crowd" }, `crowd-${i}`).asset.extra!.look as Look);

  it("une foule est variée (coiffures, hauts, rôles)", () => {
    expect(new Set(looks.map((l) => l.hair)).size).toBeGreaterThan(6);
    expect(new Set(looks.map((l) => l.top)).size).toBeGreaterThan(4);
    expect(new Set(looks.map((l) => l.role)).size).toBeGreaterThan(3);
  });

  it("pas de barbe chez les enfants ni les silhouettes féminines ; un rôle biaise sans enfermer", () => {
    for (const l of looks) if (l.age === "child" || l.figure === "feminine") expect(l.beard).toBe("none");
    const guards = Array.from({ length: 12 }, (_, i) => build({ detail: "crowd", role: "guard" }, `g-${i}`).asset.extra!.look as Look);
    expect(guards.filter((l) => l.over === "armor").length).toBeGreaterThan(6);
    expect(guards.filter((l) => l.hat === "helmet").length).toBeGreaterThan(6);
  });

  it("déterministe : même graine → même apparence ; une valeur explicite l'emporte", () => {
    const a = build({ detail: "crowd" }, "same").asset.extra!.look as Look;
    const b = build({ detail: "crowd" }, "same").asset.extra!.look as Look;
    expect(a).toEqual(b);
    const c = build({ detail: "crowd", hat: "cowboy" }, "same").asset.extra!.look as Look;
    expect(c.hat).toBe("cowboy");
    expect(c.beard).toBe(a.beard);
  });
});

describe("personnage animal", () => {
  it("chat : pelage, museau blanc et truffe noire, pas de barbe ni de cheveux, queue", () => {
    const { asset, issues } = build({ detail: "crowd", animal: "cat", beard: "full", top: "tee" }, "chat");
    const look = (asset.extra as { look: Look }).look;
    expect(look.animal).toBe("cat");
    expect(look.beard).toBe("none");
    expect(look.hair).toBe("none");
    const roles = new Set(asset.mesh.role);
    expect(roles.has(ROLE.white)).toBe(true);
    expect(roles.has(ROLE.black)).toBe(true);
    expect(["#8f8a86", "#d98a3d", "#3b3533", "#e9e1d6", "#b98a5e"]).toContain((asset.colors as Record<string, string>).skin);
    expect(issues.list.filter((i) => i.code !== "info")).toEqual([]);
    // la queue dépasse derrière le bassin
    let minZ = 0;
    for (let i = 0; i < asset.mesh.vertexCount; i++) minZ = Math.min(minZ, asset.mesh.pos[i * 3 + 2]);
    expect(minZ).toBeLessThan(-0.2 * asset.height);
  });
  it("espèce inconnue signalée, humain par défaut", () => {
    const { asset, issues } = build({ detail: "crowd", animal: "licorne" }, "x");
    expect((asset.extra as { look: Look }).look.animal).toBe("none");
    expect(issues.list.some((i) => String(i.path).endsWith("animal"))).toBe(true);
  });
});
