import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicMotion } from "./motion";

void SonicMotion;

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-motion") as SonicMotion;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("sonic-motion", () => {
  it("publie la vitesse d'une valeur du DataProvider source", async () => {
    await mount({ source: "mo1", keys: "right.x", "smooth-ms": "0", "speed-max": "2", "out-data-provider": "mo1out" });
    let out: any;
    dp("mo1out").onAssign((v: unknown) => void (out = v));
    set("mo1", { right: { x: 0 } });
    await vi.advanceTimersByTimeAsync(100);
    set("mo1", { right: { x: 0.1 } });
    expect(out.speed).toBeCloseTo(1, 1);
    expect(out.vel).toBeCloseTo(0.5, 1);
    expect(out.moving).toBe(true);
  });

  it("valeur absente ou non numérique : pas de mesure, la vitesse retombe seule", async () => {
    await mount({ source: "mo2", keys: "x", "smooth-ms": "50", "idle-ms": "100", "out-data-provider": "mo2out" });
    let out: any;
    dp("mo2out").onAssign((v: unknown) => void (out = v));
    set("mo2", { x: 0 });
    await vi.advanceTimersByTimeAsync(50);
    set("mo2", { x: 0.1 });
    expect(out.speed).toBeGreaterThan(0);
    set("mo2", { x: null }); // pas de mesure
    await vi.advanceTimersByTimeAsync(4000); // la boucle idle fait retomber la vitesse
    expect(out.speed).toBe(0);
    expect(out.moving).toBe(false);
  });
});
