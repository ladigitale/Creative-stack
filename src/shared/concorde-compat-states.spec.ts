import { describe, expect, it, beforeEach } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "@supersoniks/concorde/states";
import { sameStateValue, statesRenderNeedsStableKey } from "./concorde-compat";

type LitEl = HTMLElement & { updateComplete: Promise<boolean>; requestUpdate(): void };

const tick = () => new Promise((r) => setTimeout(r, 0));

async function settle(el: LitEl): Promise<void> {
  await customElements.whenDefined("sonic-states");
  for (let i = 0; i < 3; i++) {
    await tick();
    await el.updateComplete;
  }
}

async function mountStates(dp: string, path: string): Promise<LitEl> {
  const host = document.createElement("div");
  host.innerHTML = `<sonic-states dataProvider="${dp}" data-path="${path}">
      <template data-value="edit"><input class="field" /><div class="scroller"></div></template>
      <template data-value="view"><p class="view">Vue</p></template>
    </sonic-states>`;
  document.body.appendChild(host);
  const el = host.firstElementChild as LitEl;
  await settle(el);
  return el;
}

describe("sonic-states : utilitaires", () => {
  it("égalité d'état", () => {
    expect(sameStateValue("a", "a")).toBe(true);
    expect(sameStateValue(1, "1")).toBe(true);
    expect(sameStateValue("a", "b")).toBe(false);
    expect(sameStateValue(undefined, "")).toBe(false);
    expect(sameStateValue({}, {})).toBe(false);
  });
  it("garde de version : seul un render à clé horodatée est remplacé", () => {
    expect(statesRenderNeedsStableKey(function () { return 1 + new Date().getTime(); })).toBe(true);
    expect(statesRenderNeedsStableKey(function () { return (/* @__PURE__ */ new Date()).getTime(); })).toBe(true);
    expect(statesRenderNeedsStableKey(function () { return 1; })).toBe(false);
  });
});

describe("sonic-states (Concorde classique complété)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("réassigner la même valeur ne recrée pas le contenu", async () => {
    const pub = PublisherManager.get("compatStates1");
    pub.set({ ui: { mode: "edit" }, text: "" });
    const el = await mountStates("compatStates1", "ui.mode");
    const input = el.querySelector("input.field") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "en cours de saisie";

    (pub as unknown as { ui: { mode: { set(v: unknown): void } } }).ui.mode.set("edit");
    await settle(el);
    el.requestUpdate();
    await settle(el);

    const after = el.querySelector("input.field") as HTMLInputElement;
    expect(after).toBe(input);
    expect(after.value).toBe("en cours de saisie");
  });

  it("assigner tout le DataProvider (autre clé modifiée) ne recrée pas le contenu", async () => {
    const pub = PublisherManager.get("compatStates2");
    pub.set({ ui: { mode: "edit" }, text: "a" });
    const el = await mountStates("compatStates2", "ui.mode");
    const input = el.querySelector("input.field");
    pub.set({ ui: { mode: "edit" }, text: "ab" });
    await settle(el);
    expect(el.querySelector("input.field")).toBe(input);
  });

  it("réassigner le parent de data-path avec les mêmes valeurs ne recrée pas le contenu", async () => {
    const pub = PublisherManager.get("compatStates3");
    pub.set({ ui: { mode: "edit", other: 1 } });
    const el = await mountStates("compatStates3", "ui.mode");
    const input = el.querySelector("input.field");
    (pub as unknown as { ui: { set(v: unknown): void } }).ui.set({ mode: "edit", other: 1 });
    await settle(el);
    el.requestUpdate();
    await settle(el);
    expect(el.querySelector("input.field")).toBe(input);
  });

  it("une valeur différente bascule de template", async () => {
    const pub = PublisherManager.get("compatStates4");
    pub.set({ ui: { mode: "edit" } });
    const el = await mountStates("compatStates4", "ui.mode");
    expect(el.querySelector("input.field")).toBeTruthy();
    (pub as unknown as { ui: { mode: { set(v: unknown): void } } }).ui.mode.set("view");
    await settle(el);
    expect(el.querySelector("input.field")).toBeNull();
    expect(el.querySelector("p.view")).toBeTruthy();
    (pub as unknown as { ui: { mode: { set(v: unknown): void } } }).ui.mode.set("edit");
    await settle(el);
    expect(el.querySelector("input.field")).toBeTruthy();
    expect(el.querySelector("p.view")).toBeNull();
  });
});
