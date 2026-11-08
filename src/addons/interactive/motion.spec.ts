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

describe("sonic-motion : params et état", () => {
  it("readMotionParams : bornes, clé vide ignorée, valeurs refusées listées", async () => {
    const { readMotionParams } = await import("./motion");
    expect(readMotionParams({ smoothMs: -5, speedMax: 0, idleMs: 1e9, peakMs: "" })).toEqual({ settings: { smoothMs: 0, speedMax: 0.001, idleMs: 60000 }, invalid: [] });
    expect(readMotionParams({ smoothMs: "x", peakMs: true }).invalid).toEqual(["smoothMs", "peakMs"]);
    expect(readMotionParams(null)).toEqual({ settings: {}, invalid: [] });
  });

  it("publie status dès le montage ; params remplace les attributs, clé retirée = retour à l'attribut", async () => {
    let out: any;
    dp("mo3out").onAssign((v: unknown) => void (out = v));
    const el = await mount({ source: "mo3", keys: "x", "smooth-ms": "0", "speed-max": "2", params: "mo3p", "out-data-provider": "mo3out" });
    expect(out.status).toBe("ready");
    expect(out.error).toBeNull();
    expect(out.speed).toBe(0);
    set("mo3p", { speedMax: 4 });
    expect(el.settings().speedMax).toBe(4);
    expect(out.settings.speedMax).toBe(4);
    set("mo3", { x: 0 });
    await vi.advanceTimersByTimeAsync(100);
    set("mo3", { x: 0.1 });
    expect(out.vel).toBeCloseTo(0.25, 1); // 1 unité/s sur 4
    set("mo3p", {});
    expect(el.settings().speedMax).toBe(2);
    set("mo3p", { idleMs: "abc" });
    expect(out.status).toBe("error");
    expect(out.error).toContain("idleMs");
  });

  it("sans keys : status idle", async () => {
    let out: any;
    dp("mo4out").onAssign((v: unknown) => void (out = v));
    await mount({ source: "mo4", "out-data-provider": "mo4out" });
    expect(out.status).toBe("idle");
  });
});
