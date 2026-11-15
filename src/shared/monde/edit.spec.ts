import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import { freeName, mondeParams, mondePlace, mondeRemove } from "./edit";
import { mondeAdd, mondeTurn } from "./edit-add";
import { readMonde } from "./format";
import { MondeDriver } from "./driver";
import { placedInfo } from "./arrange";
import { registerInteractiveHelpers } from "../../addons/interactive/helpers";

const chambre = () => ({
  unite: "cm",
  espace: { contour: [[0, 0], [420, 0], [420, 310], [0, 310]], hauteur: 250, zones: [{ nom: "plancher", revetement: "parquet" }] },
  place: [
    { model: "bureau", name: "bureau", against: "mur0", at: 300, params: { largeur: 140 } },
    { model: "lampe", on: "bureau", at: [-50, 0] },
    { model: "commode", name: "commode", at: [200, 0, 150] },
  ],
});

/** Range `name` comme un glisser, et rend le résultat publié. */
const drop = (monde: unknown, name: string, x: number, z: number) => {
  const m = readMonde(monde);
  const d = new MondeDriver();
  d.setMonde(m, 0);
  d.step(0);
  const r = d.arrangeTo(name, x, z, 1)!;
  return placedInfo(name, r, d.bodies(), m.unit);
};

describe("édition du monde écrit", () => {
  it("$mondePlace rend la pose durable : le monde relu redonne la position du glisser", () => {
    const w = chambre();
    const placed = drop(w, "commode", 1.0, 2.9);
    expect(placed.snaps).toContain("mur");
    const w2 = mondePlace(w, placed) as ReturnType<typeof chambre>;
    expect(w.place[2]).toEqual(chambre().place[2]);
    const again = readMonde(w2).place.find((p) => p.name === "commode")!;
    expect(again.at[0]).toBeCloseTo(placed.x, 3);
    expect(again.at[2]).toBeCloseTo(placed.z, 3);
    expect(again.rot[1]).toBeCloseTo(placed.ry, 3);
  });

  it("un objet nommé d'office (lampe sur le bureau) reçoit son nom et garde son appui", () => {
    const w = chambre();
    const placed = drop(w, "bureau-lampe1", 3.4, 0.3);
    expect(placed.src).toBe(1);
    const w2 = mondePlace(w, placed) as { place: Record<string, unknown>[] };
    expect(w2.place[1].name).toBe("bureau-lampe1");
    expect(w2.place[1].on).toBe("bureau");
    const lamp = readMonde(w2).place.find((p) => p.name === "bureau-lampe1")!;
    expect(lamp.on?.support).toBe("bureau");
  });

  it("$mondeRemove retire l'objet et ce qui est posé dessus", () => {
    const w2 = mondeRemove(chambre(), "bureau") as { place: Record<string, unknown>[] };
    expect(w2.place.map((e) => e.model)).toEqual(["commode"]);
    expect(mondeRemove(chambre(), "inconnu")).toEqual(chambre());
  });

  it("$mondeAdd ajoute à une place libre, avec l'appui de sa nature", () => {
    const w2 = mondeAdd(chambre(), { model: "armoire", params: { largeur: 120 } }) as { place: Record<string, unknown>[] };
    const added = w2.place[3];
    expect(added.name).toBe("armoire1");
    const m = readMonde(w2);
    expect(m.conflicts.filter((c) => c.a === "armoire1" || c.b === "armoire1")).toEqual([]);
    // un cadre va sur un mur
    const w3 = mondeAdd(w2, { model: "cadre" }, [2.1, 3.0]) as { place: Record<string, unknown>[] };
    expect(w3.place[4].on).toMatch(/^mur/);
    expect(freeName(w3, "armoire")).toBe("armoire2");
  });

  it("depuis un réducteur JSONata", async () => {
    const expr = jsonata('$action.type = "place" ? $merge([$state, {"monde": $mondePlace($state.monde, $action.payload)}]) : $action.type = "add" ? $merge([$state, {"monde": $mondeAdd($state.monde, $action.payload)}]) : $state');
    registerInteractiveHelpers(expr);
    const state = { monde: chambre() };
    const placed = drop(state.monde, "commode", 1.0, 2.9);
    const s2 = (await expr.evaluate(state, { state, action: { type: "place", payload: placed } })) as { monde: { place: Record<string, unknown>[] } };
    expect(s2.monde.place[2].at).toEqual(placed.place.at);
    const s3 = (await expr.evaluate(s2, { state: s2, action: { type: "add", payload: { model: "plante" } } })) as { monde: { place: Record<string, unknown>[] } };
    expect(s3.monde.place).toHaveLength(4);
  });

  it("$mondeParams change les paramètres d'un objet ; $mondeTurn le tourne d'un quart de tour sur place", () => {
    const w = mondeParams(chambre(), "commode", { tiroirs: 5, facade: "#e07a5f", largeur: null }) as { place: Record<string, unknown>[] };
    expect(w.place[2].params).toEqual({ tiroirs: 5, facade: "#e07a5f" });
    const lamp = mondeParams(chambre(), "bureau-lampe1", { abat: "boule" }, 1) as { place: Record<string, unknown>[] };
    expect(lamp.place[1]).toMatchObject({ name: "bureau-lampe1", params: { abat: "boule" } });
    const before = readMonde(chambre()).place.find((p) => p.name === "commode")!;
    const t = mondeTurn(chambre(), "commode") as ReturnType<typeof chambre>;
    const after = readMonde(t).place.find((p) => p.name === "commode")!;
    expect(Math.cos(after.rot[1] - before.rot[1] - Math.PI / 2)).toBeCloseTo(1);
    expect(Math.hypot(after.at[0] - before.at[0], after.at[2] - before.at[2])).toBeLessThan(0.1);
    expect(mondeTurn(chambre(), "mur0")).toEqual(chambre());
  });
});
