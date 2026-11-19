import { afterEach, describe, expect, it, vi } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { distanceBearing, nearbyPlaces, type SonicGeolocation } from "./index";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("distances", () => {
  it("haversine et relèvement", () => {
    // Tours, place Jean-Jaurès → cathédrale : ~1 km vers le nord-est.
    const r = distanceBearing(47.3900, 0.6890, 47.3955, 0.6950);
    expect(r.distance).toBeGreaterThan(700);
    expect(r.distance).toBeLessThan(800);
    expect(r.bearing).toBeGreaterThan(30);
    expect(r.bearing).toBeLessThan(45);
    expect(distanceBearing(0, 0, 1, 0).bearing).toBeCloseTo(0);
    expect(distanceBearing(0, 0, 0, 1).bearing).toBeCloseTo(90);
  });

  it("lieux proches triés, hors rayon ignorés, entrées invalides ignorées", () => {
    const places = [
      { id: "loin", lat: 47.5, lon: 0.7 },
      { id: "près", lat: 47.3901, lon: 0.6891 },
      { id: "moyen", lat: 47.3910, lon: 0.6900 },
      { id: "cassé", lat: "x", lon: 1 },
    ];
    const n = nearbyPlaces(47.39, 0.689, places, 500);
    expect(n.map((p) => p.id)).toEqual(["près", "moyen"]);
    expect(n[0].distance).toBeLessThan(20);
  });
});

describe("sonic-geolocation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("suit la position et publie les lieux proches", async () => {
    let success: PositionCallback | null = null;
    const geo = { watchPosition: vi.fn((s: PositionCallback) => { success = s; return 7; }), clearWatch: vi.fn(), getCurrentPosition: vi.fn() };
    Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
    await import("./index");
    set("lieuxTest", [{ id: "balise", lat: 47.3901, lon: 0.6891 }]);
    const el = document.createElement("sonic-geolocation") as SonicGeolocation;
    el.id = "geoTest";
    el.setAttribute("places", "lieuxTest");
    el.setAttribute("radius", "100");
    document.body.appendChild(el);
    await tick();
    expect(el.start()).toBe(true);
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    success!({ coords: { latitude: 47.39, longitude: 0.689, accuracy: 8, altitude: null, heading: null, speed: null }, timestamp: 1 } as unknown as GeolocationPosition);
    await new Promise((r) => setTimeout(r, 80));
    const s = get("geoTestState") as { status: string; accuracy: number; nearest: { id: string; distance: number } };
    expect(s.status).toBe("ready");
    expect(s.accuracy).toBe(8);
    expect(s.nearest.id).toBe("balise");
    el.remove();
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
  });
});
