import { describe, expect, it } from "vitest";
import { mondeSummary, readMonde } from "./format";
import { monde2dSummary, readMonde2d } from "../monde2d/format";

const table = {
  params: {
    longueur: { default: 1.6, min: 0.8, max: 4, step: 0.2, unit: "m" },
    couverts: { default: 4, options: [2, 4, 6] },
    teinte: { default: "#8b5a2b" },
  },
  parts: [
    { name: "plateau", box: ["= longueur", 0.05, 0.8, 0.02], at: [0, 0.75, 0], color: "= teinte" },
    { name: "pied", cylinder: [0.03, 0.75], at: ["= longueur / 2 - 0.08", 0, 0.32], mirror: "x" },
  ],
  use: [{ model: "chaise", repeat: "= couverts / 2", at: ["= (i + 0.5) * longueur / (couverts / 2) - longueur / 2", 0, 0.6], rot: [0, 180, 0] }],
};
const chaise = { parts: [{ name: "assise", box: [0.42, 0.04, 0.42], at: [0, 0.45, 0], role: "bois" }] };
const variants = (m: ReturnType<typeof readMonde>, base: string) => [...m.models.keys()].filter((k) => k.startsWith(`${base}~`));

describe("prefabs paramétrés", () => {
  it("un monde sans prefab est lu comme avant", () => {
    const m = readMonde({ models: { cube: { parts: [{ box: [1, 1, 1] }] } }, place: [{ model: "cube", name: "a" }] });
    expect([...m.models.keys()]).toEqual(["cube"]);
    expect(m.place[0].model).toBe("cube");
    expect(m.prefabs).toEqual({});
    expect(m.issues).toEqual([]);
  });

  it("valeurs par défaut, expressions dans les pièces, sous-modèles répétés", () => {
    const m = readMonde({ models: { table, chaise }, place: [{ model: "table", name: "t1" }] });
    expect(m.issues).toEqual([]);
    const [v] = variants(m, "table");
    const model = m.models.get(v)!;
    const names = model.parts.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["plateau", "piedL", "piedR", "chaise0", "chaise1", "chaise0_assise", "chaise1_assise"]));
    expect(model.parts.find((p) => p.name === "plateau")!.shape!.a[0]).toBeCloseTo(1.6);
    expect(model.parts.find((p) => p.name === "piedL")!.at[0]).toBeCloseTo(0.72);
    // deux chaises réparties sur la longueur, tournées vers la table
    expect(model.parts.find((p) => p.name === "chaise0")!.at[0]).toBeCloseTo(-0.4);
    expect(model.parts.find((p) => p.name === "chaise1")!.at[0]).toBeCloseTo(0.4);
    const seat = model.parts.find((p) => p.name === "chaise0_assise")!;
    expect(model.parts[seat.parent].name).toBe("chaise0");
    // le modèle écrit n'existe plus en tant que tel : seules ses variantes sont construites
    expect(m.models.has("table")).toBe(false);
  });

  it("une valeur de placement change la forme ; les bornes et le pas s'appliquent", () => {
    const m = readMonde({ models: { table, chaise }, place: [{ model: "table", name: "a", params: { longueur: 2.43, couverts: 6 } }, { model: "table", name: "b", params: { longueur: 99 } }] });
    const a = m.models.get(m.place[0].model)!;
    expect(a.parts.find((p) => p.name === "plateau")!.shape!.a[0]).toBeCloseTo(2.4);
    expect(a.parts.filter((p) => /^chaise\d$/.test(p.name))).toHaveLength(3);
    expect(m.models.get(m.place[1].model)!.parts.find((p) => p.name === "plateau")!.shape!.a[0]).toBeCloseTo(4);
  });

  it("une couleur ne crée pas de variante : rôle de couleur de la copie", () => {
    const m = readMonde({
      models: { table, chaise },
      place: [
        { model: "table", name: "a", params: { teinte: "#112233" } },
        { model: "table", name: "b", params: { teinte: "#445566" } },
      ],
    });
    expect(variants(m, "table")).toHaveLength(1);
    expect(m.place[0].roles["~teinte"]).toBe("#112233");
    expect(m.place[1].roles["~teinte"]).toBe("#445566");
    const model = m.models.get(m.place[0].model)!;
    expect(model.parts.find((p) => p.name === "plateau")!.role).toBe("~teinte");
  });

  it("1 000 copies tirées parmi 5 longueurs : 5 variantes, pas une de plus", () => {
    const m = readMonde({
      models: { table, chaise },
      place: [{ model: "table", scatter: 1000, area: [-50, -50, 50, 50], params: { longueur: "= pick(1.2, 1.6, 2, 2.4, 3)", teinte: "= pick('#8b5a2b', '#5b3a1e')" } }],
    });
    expect(m.issues).toEqual([]);
    expect(variants(m, "table")).toHaveLength(5);
    expect(new Set(m.place.map((p) => p.model)).size).toBe(5);
    expect(new Set(m.place.map((p) => p.roles["~teinte"])).size).toBe(2);
    // déterministe : même entrée, mêmes tirages
    const again = readMonde({
      models: { table, chaise },
      place: [{ model: "table", scatter: 1000, area: [-50, -50, 50, 50], params: { longueur: "= pick(1.2, 1.6, 2, 2.4, 3)", teinte: "= pick('#8b5a2b', '#5b3a1e')" } }],
    });
    expect(again.place.map((p) => p.model)).toEqual(m.place.map((p) => p.model));
  });

  it("au-delà du plafond, la variante la plus proche est réutilisée", () => {
    const tige = { params: { h: { default: 1, min: 0, max: 100 } }, parts: [{ cylinder: [0.05, "= h"] }] };
    const place = Array.from({ length: 40 }, (_, i) => ({ model: "tige", params: { h: 1 + i } }));
    const m = readMonde({ models: { tige }, place });
    expect(variants(m, "tige")).toHaveLength(32);
    expect(m.place).toHaveLength(40);
    expect(m.issues.some((i) => i.message.includes("variantes"))).toBe(true);
    // un nombre tiré sans pas est ramené à 16 paliers
    const r = readMonde({ models: { tige }, place: [{ model: "tige", scatter: 500, params: { h: "= rand(0, 100)" } }] });
    expect(variants(r, "tige").length).toBeLessThanOrEqual(16);
  });

  it("emplacements : garniture par défaut, choix du placement, famille vérifiée", () => {
    const models = {
      lampe: {
        famille: "luminaire",
        pose: "sol",
        tags: ["salon"],
        params: { hauteur: { default: 1.5, min: 1.1, max: 1.9, step: 0.1 } },
        parts: [{ name: "pied", cylinder: [0.02, "= hauteur"], at: [0, "= hauteur / 2", 0], matiere: "laiton" }],
        slots: { abatJour: { accepte: "abat-jour", at: [0, "= hauteur", 0], default: "cone" } },
      },
      cone: { famille: "abat-jour", parts: [{ name: "toile", cone: [0.2, 0.25] }] },
      boule: { famille: "abat-jour", params: { r: { default: 0.15 } }, parts: [{ name: "globe", sphere: "= r" }] },
      chaise,
    };
    const m = readMonde({
      models,
      place: [
        { model: "lampe", name: "a" },
        { model: "lampe", name: "b", slots: { abatJour: { model: "boule", params: { r: 0.2 } } } },
        { model: "lampe", name: "c", slots: { abatJour: null } },
        { model: "lampe", name: "d", slots: { abatJour: "chaise" } },
      ],
    });
    const parts = (i: number) => m.models.get(m.place[i].model)!.parts;
    expect(parts(0).map((p) => p.name)).toContain("abatJour_toile");
    expect(parts(0).find((p) => p.name === "abatJour")!.at[1]).toBeCloseTo(1.5);
    expect(parts(1).find((p) => p.name === "abatJour_globe")!.shape!.a[0]).toBeCloseTo(0.2);
    expect(parts(2).some((p) => p.name.startsWith("abatJour"))).toBe(false);
    // mauvaise famille : la garniture par défaut est gardée
    expect(parts(3).map((p) => p.name)).toContain("abatJour_toile");
    expect(m.issues.some((i) => i.path === "place.3.slots.abatJour")).toBe(true);
    // matière du nuancier de base
    const pied = parts(0).find((p) => p.name === "pied")!;
    expect(pied.color).toBe("#b08d57");
    expect(pied.tex?.kind).toBe("metal");
    const info = mondeSummary(m).prefabs!.lampe;
    expect(info.famille).toBe("luminaire");
    expect(info.pose).toBe("sol");
    expect(info.slots.abatJour).toEqual({ accepte: "abat-jour", default: "cone" });
    expect(info.params.hauteur).toMatchObject({ type: "nombre", default: 1.5, step: 0.1 });
    expect(mondeSummary(m).instances[0]).toMatchObject({ name: "a", prefab: "lampe" });
  });

  it("unite cm : pièces, placements et clips convertis en mètres", () => {
    const m = readMonde({
      unite: "cm",
      materiaux: { rose: "#ff66aa" },
      models: {
        bloc: {
          params: { l: { default: 120, unit: "cm" } },
          parts: [{ name: "b", box: ["= l", 40, 60], at: [0, 20, 0], matiere: "rose" }],
          clips: { saute: { ms: 400, tracks: { b: { y: [0, 30, 0] } } } },
        },
        plot: { parts: [{ cylinder: [5, 50] }] },
      },
      place: [
        { model: "bloc", name: "a", at: [200, 0, 100] },
        { model: "plot", grid: [2, 2], step: [100, 0, 100] },
      ],
    });
    expect(m.issues).toEqual([]);
    const bloc = m.models.get(m.place[0].model)!;
    expect(bloc.parts[0].shape!.a.slice(0, 3)).toEqual([1.2, 0.4, 0.6]);
    expect(bloc.parts[0].at[1]).toBeCloseTo(0.2);
    expect(bloc.parts[0].color).toBe("#ff66aa");
    expect(bloc.clips.get("saute")!.tracks[0].keys[1]).toBeCloseTo(0.3);
    expect(m.place[0].at).toEqual([2, 0, 1]);
    expect(m.place[m.place.length - 1].at[0]).toBeCloseTo(1);
    expect(m.models.get(m.place[1].model)!.parts[0].shape!.a[1]).toBeCloseTo(0.5);
  });

  it("erreurs signalées sans lever : cycle, paramètre inconnu, expression fausse, générateur dans use", () => {
    const m = readMonde({
      models: {
        a: { parts: [{ box: [1, 1, 1] }], use: [{ model: "b" }] },
        b: { parts: [{ box: [1, 1, 1] }], use: [{ model: "a" }] },
        c: { params: { h: { default: 1 } }, parts: [{ box: ["= inconnu * 2", "= h", 1] }], use: [{ model: "chien" }] },
        chien: { gen: "animal.dog" },
      },
      place: [{ model: "a" }, { model: "c", params: { h: 2, largeur: 3 } }],
    });
    const msgs = m.issues.map((i) => i.message).join(" | ");
    expect(msgs).toContain("cycle");
    expect(msgs).toContain("paramètre inconnu");
    expect(msgs).toContain("variable inconnue");
    expect(msgs).toContain("générateur");
    expect(m.place).toHaveLength(2);
  });

  it("les paramètres d'un modèle gen passent toujours par ses variantes propres", () => {
    const m = readMonde({ models: { chien: { gen: "animal.dog" } }, place: [{ model: "chien", name: "rex", params: { mood: "happy" } }] });
    expect(m.place[0].model.startsWith("chien~")).toBe(true);
    expect(m.models.get(m.place[0].model)!.gen).not.toBeNull();
  });

  it("un préréglage accepte des paramètres déclarés et des valeurs par placement", () => {
    const m = readMonde({
      models: { arbre: { preset: "arbre", params: { forme: { default: "rond", options: ["rond", "sapin"] } } } },
      place: [{ model: "arbre", scatter: 30, params: { forme: "= pick('rond', 'sapin')" } }],
    });
    expect(m.issues).toEqual([]);
    expect(variants(m, "arbre")).toHaveLength(2);
    expect(m.place).toHaveLength(30);
  });

  it("monde2d : mêmes prefabs, en pixels", () => {
    const m = readMonde2d({
      models: {
        fanion: {
          params: { h: { default: 60, min: 20, max: 200, step: 20, unit: "px" }, teinte: { default: "#e11d48" } },
          parts: [
            { name: "mat", rect: [4, "= h"], at: [0, "= -h / 2"], color: "#334155" },
            { name: "toile", poly: [[0, 0], [30, 8], [0, 16]], at: [2, "= -h"], color: "= teinte" },
          ],
          use: [{ model: "boule", at: [0, "= -h - 4"] }],
        },
        boule: { parts: [{ name: "b", circle: 4, color: "#facc15" }] },
      },
      place: [
        { model: "fanion", name: "a", at: [100, 300], params: { h: 100 } },
        { model: "fanion", grid: [10, 3], step: [40, 60], at: [0, 100], params: { h: "= pick(40, 60, 80)", teinte: "= pick('#e11d48', '#2563eb')" } },
      ],
    });
    expect(m.issues).toEqual([]);
    const a = m.models.get(m.place[0].model)!;
    expect(a.parts.map((p) => p.name)).toEqual(expect.arrayContaining(["mat", "toile", "boule", "boule_b"]));
    expect(a.parts.find((p) => p.name === "boule")!.at[1]).toBeCloseTo(-104);
    expect(m.place).toHaveLength(31);
    expect(new Set(m.place.map((p) => p.model)).size).toBeLessThanOrEqual(4);
    expect(new Set(m.place.slice(1).map((p) => p.roles["~teinte"]))).toEqual(new Set(["#e11d48", "#2563eb"]));
    expect(monde2dSummary(m).prefabs!.fanion.params.h.unit).toBe("px");
  });
});
