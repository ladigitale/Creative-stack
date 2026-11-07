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
