import { describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "./dp";

describe("listenDp", () => {
  it("reçoit les écritures d'une sous-clé (bouton radio) sans doublon", () => {
    set("dpSousCle", { color: "#000000", size: "8" });
    const seen: unknown[] = [];
    const off = listenDp("dpSousCle", (v) => seen.push(v));
    seen.length = 0;
    set("dpSousCle.color", "#ff0000");
    expect(seen.at(-1)).toEqual({ color: "#ff0000", size: "8" });
    const n = seen.length;
    set("dpSousCle.color", "#ff0000");
    expect(seen.length).toBe(n);
    off();
    set("dpSousCle.color", "#00ff00");
    expect(seen.length).toBe(n);
  });

  it("ne boucle pas quand l'écouteur réécrit une clé de ce qu'il écoute", () => {
    set("dpBoucle", { a: 1, b: 0 });
    let calls = 0;
    const off = listenDp("dpBoucle", (v) => {
      calls++;
      if (calls > 50) throw new Error("boucle");
      set("dpBoucle.b", (v as { a: number }).a * 2);
    });
    set("dpBoucle.a", 5);
    expect(calls).toBeLessThan(10);
    off();
  });
});
