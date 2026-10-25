import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import manifest from "./manifest.json";
import example from "./examples/port-vivant.sdui.json";

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("addon procgen", () => {
  it("définit sonic-procgen, branché sur le store de Concorde", async () => {
    expect(customElements.get("sonic-procgen")).toBeTruthy();
    const { ProcgenScene } = await import("./index");
    expect(ProcgenScene.store.kind).toBe("Concorde");
  });

  it("le manifeste déclare le composant et chaque attribut lu par l'élément", () => {
    const c = manifest.components[0];
    expect(c.name).toBe("sonic-procgen");
    for (const k of ["dataProvider", "scene", "seed", "scene-style", "interactive", "target", "select-action-type"]) {
      expect(Object.keys(c.props)).toContain(k);
    }
  });

  it("se monte sans WebGL : erreur publiée dans status, pas d'exception", async () => {
    const dpName = "pg-test";
    set(dpName, { scene: "port vivant (animé)" });
    const host = document.createElement("div");
    host.innerHTML = `<sonic-procgen dataProvider="${dpName}"></sonic-procgen>`;
    expect(() => document.body.appendChild(host)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    const { dp } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
    expect(String((dp(dpName) as any).get()?.status?.error ?? "")).toMatch(/WebGL/);
  });

  it("l'exemple n'utilise que des balises du catalogue et pas de champ de code", () => {
    const tags = new Set<string>();
    const walk = (n: any) => {
      tags.add(n.tagName);
      for (const k of ["markup", "innerHTML", "js", "prefix", "suffix"]) expect(n[k]).toBeUndefined();
      (n.nodes ?? []).forEach(walk);
    };
    (example as any).nodes.forEach(walk);
    expect(tags.has("sonic-procgen")).toBe(true);
  });
});
