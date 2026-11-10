import { describe, expect, it } from "vitest";
import { syncedState } from "./store";

describe("syncedState", () => {
  it("repart de la valeur du DataProvider (écritures de radios / cases comprises)", () => {
    const state = { n: 3, rythme: "2", voir: ["Club"] };
    const current = { n: 3, rythme: "4", voir: ["Club", "Plein air"], lastError: null };
    expect(syncedState(state, current)).toEqual({ n: 3, rythme: "4", voir: ["Club", "Plein air"] });
  });

  it("rend une copie simple, sans lastError", () => {
    const current = new Proxy({ a: 1, lastError: "x" }, {});
    const out = syncedState({ a: 0 }, current) as Record<string, unknown>;
    expect(out).toEqual({ a: 1 });
    expect(structuredClone(out)).toEqual({ a: 1 });
  });

  it("garde l'état interne si l'un des deux n'est pas un objet", () => {
    expect(syncedState(5, { value: 6 })).toBe(5);
    expect(syncedState({ a: 1 }, null)).toEqual({ a: 1 });
    expect(syncedState({ a: 1 }, [1, 2])).toEqual({ a: 1 });
  });
});
