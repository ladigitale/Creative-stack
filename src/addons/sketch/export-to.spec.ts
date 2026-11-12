import { afterEach, describe, expect, it, vi } from "vitest";
import "./index";
import type { SonicSketch } from "./sketch";
import { registerStore, unregisterStore } from "../interactive/registry";

describe("sonic-sketch : export-to", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("chaque export part en action au store ; les URL des 4 derniers exports restent valides", async () => {
    let n = 0;
    const revoked: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:e${++n}`, revokeObjectURL: (u: string) => void revoked.push(u) }));
    const got: { type: string; payload: { url: string; mime: string } }[] = [];
    registerStore({ id: "expTarget", dispatch: (a) => void got.push(a as never), getState: () => ({}), reset: () => {} });
    const el = document.createElement("sonic-sketch") as SonicSketch;
    for (const [k, v] of Object.entries({ width: "200", height: "100", "export-to": "expTarget", "export-action": "io:exported" })) el.setAttribute(k, v);
    document.body.appendChild(el);
    await el.updateComplete;
    for (let i = 0; i < 5; i++) el.save();
    expect(got).toHaveLength(5);
    expect(got[0]).toMatchObject({ type: "io:exported", payload: { url: "blob:e1", mime: "image/svg+xml" } });
    expect(el.getState().last?.url).toBe("blob:e5");
    expect(revoked).toEqual(["blob:e1"]);
    el.remove();
    expect(revoked.sort()).toEqual(["blob:e1", "blob:e2", "blob:e3", "blob:e4", "blob:e5"]);
    unregisterStore("expTarget");
  });
});
