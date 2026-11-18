import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import manifest from "./manifest.json";
import example from "./examples/village-vivant.sdui.json";
import { SCENES } from "./scene/library";
import { STYLE_PRESETS } from "./style/style";
import { CAMERAS } from "./render/camera";
import { ACTIONS } from "./rig/locomotion";
import { VECTOR_STYLES } from "./vector/vstyle";
import { GENERATORS } from "./gen/index";

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

const wait = async (pred: () => boolean, ms = 20000) => {
  const t = Date.now();
  while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20));
};

describe("addon procgen v3", () => {
  it("définit sonic-procgen", () => {
    expect(customElements.get("sonic-procgen")).toBeTruthy();
  });

  it("le manifeste déclare chaque attribut lu par l'élément et cite scènes, styles, caméras, actions", () => {
    const c = manifest.components[0];
    expect(c.name).toBe("sonic-procgen");
    for (const k of ["dataProvider", "state-out", "scene", "seed", "scene-style", "camera", "interactive", "target", "action-prefix", "render"]) expect(Object.keys(c.props)).toContain(k);
    for (const s of Object.keys(SCENES)) expect(c.description).toContain(s);
    for (const s of VECTOR_STYLES) expect(c.description).toContain(s);
    for (const g of Object.keys(GENERATORS)) expect(c.description).toContain(g);
    for (const s of Object.keys(STYLE_PRESETS)) expect(c.description).toContain(s);
    for (const s of CAMERAS) expect(c.description).toContain(s);
    for (const a of ACTIONS) expect(c.description).toContain(a);
  });

  it("sans WebGL : compose quand même, publie l'erreur dans l'état de sortie, sans exception", async () => {
    set("pg", { scene: "blasons" });
    const host = document.createElement("div");
    host.innerHTML = `<sonic-procgen dataProvider="pg"></sonic-procgen>`;
    expect(() => document.body.appendChild(host)).not.toThrow();
    const out = () => (PublisherManager.get("pgState") as unknown as { get(): any }).get();
    await wait(() => !!out()?.status?.error && out()?.ids?.length > 0);
    expect(String(out().status.error)).toMatch(/WebGL/);
    expect(out().ids.map((i: { id: string }) => i.id)).toContain("ecus.0");
  }, 30000);

  it("recomposition : la vue de l'utilisateur est conservée, setView n'est rappelé que si l'entrée de vue change", async () => {
    set("pgv", { scene: "rue", render: "vector" });
    const host = document.createElement("div");
    host.innerHTML = `<sonic-procgen dataProvider="pgv"></sonic-procgen>`;
    document.body.appendChild(host);
    const el = host.firstElementChild as any;
    await wait(() => !!el.sceneModel && !!el.procgenView);
    const view = el.procgenView;
    let calls = 0;
    const setView = view.setView.bind(view);
    view.setView = (v: unknown, reset?: boolean) => (calls++, setView(v, reset));
    // l'utilisateur zoome et déplace la vue
    view.interact("zoom", -400);
    view.interact("pan", 30, 10);
    const mine = view.getView();
    expect(mine.zoom).toBeGreaterThan(1.5);
    // modification de la recette (paramètre) : nouveau modèle, même vue
    const m0 = el.sceneModel;
    set("pgv", { scene: "rue", render: "vector", seed: 7 });
    await wait(() => el.sceneModel !== m0);
    expect(el.sceneModel).not.toBe(m0);
    expect(el.procgenView).toBe(view);
    expect(calls).toBe(0);
    expect(view.getView()).toEqual(mine);
    // vue demandée par le DataProvider : appliquée
    set("pgv", { scene: "rue", render: "vector", seed: 7, view: { zoom: 3 } });
    await wait(() => calls > 0);
    expect(calls).toBe(1);
    expect(view.getView().zoom).toBe(3);
  }, 30000);

  it("états : la clé `states` règle les parties sans recomposer, publie parts, signale les entrées invalides", async () => {
    const recipe = { size: [12, 10], ground: { relief: 0 }, layers: [{ id: "malles", gen: "container.chest", params: { open: false }, place: { at: [{ x: 0, z: 0, yaw: 0 }] } }] };
    set("pgs", { recipe, render: "vector", select: "malles.0" });
    const host = document.createElement("div");
    host.innerHTML = `<sonic-procgen dataProvider="pgs"></sonic-procgen>`;
    document.body.appendChild(host);
    const el = host.firstElementChild as any;
    const out = () => (PublisherManager.get("pgsState") as unknown as { get(): any }).get();
    await wait(() => !!el.sceneModel && out()?.ids?.length > 0);
    const m0 = el.sceneModel;
    expect(out().ids[0].parts).toEqual([{ name: "lid", label: "couvercle", kind: "rotation", range: [0, -105], value: 0 }]);
    expect(out().ids[0].affords).toContain("open");
    set("pgs", { recipe, render: "vector", select: "malles.0", states: { "malles.0": { open: 1, burnin: 1 } } });
    await wait(() => out()?.selection?.parts?.[0]?.value === 1);
    expect(el.sceneModel).toBe(m0);
    expect(out().selection.parts[0].value).toBe(1);
    expect(out().status.issues.find((i: any) => i.path === "states.malles.0.burnin")).toMatchObject({ code: "unknown", didYouMean: "burning" });
    // état dans la recette (calque) : pas de recomposition non plus
    set("pgs", { recipe: { ...recipe, layers: [{ ...recipe.layers[0], states: { "0": { lid: 0.5 } } }] }, render: "vector", select: "malles.0" });
    await wait(() => out()?.selection?.parts?.[0]?.value === 0.5);
    expect(el.sceneModel).toBe(m0);
  }, 30000);

  it("l'exemple n'utilise ni code ni champ libre, et branche la scène sur un store", () => {
    const tags = new Set<string>();
    const walk = (n: any) => {
      tags.add(n.tagName);
      for (const k of ["markup", "innerHTML", "js", "prefix", "suffix"]) expect(n[k]).toBeUndefined();
      (n.nodes ?? []).forEach(walk);
    };
    (example as any).nodes.forEach(walk);
    expect(tags.has("sonic-procgen")).toBe(true);
    expect(tags.has("sonic-store")).toBe(true);
  });
});
