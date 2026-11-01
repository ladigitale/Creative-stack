import { describe, expect, it } from "vitest";
import { firstForbiddenUrl, hostAllowed, readPointsSpec, sameCamera, styleUrls, toGeoJSON } from "./map-core";

const ORIGIN = "https://artifacts.tadaaa.space/x";

describe("toGeoJSON", () => {
  it("convertit lat/lon (ou lng) et garde les propriétés", () => {
    const fc = toGeoJSON([{ id: 1, lat: 47.27, lon: 0.62, label: "Monts" }, { id: "b", lat: "48.8", lng: "2.3" }]);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry.coordinates).toEqual([0.62, 47.27]);
    expect(fc.features[0].properties.label).toBe("Monts");
    expect(fc.features[1].geometry.coordinates).toEqual([2.3, 48.8]);
  });
  it("ignore les points sans id, sans coordonnées ou hors bornes", () => {
    const fc = toGeoJSON([{ lat: 1, lon: 1 }, { id: 2, lat: null, lon: 1 }, { id: 3, lat: 95, lon: 0 }, { id: 4, lat: 0, lon: 200 }, null, "x"]);
    expect(fc.features).toHaveLength(0);
  });
  it("accepte une valeur non tableau", () => {
    expect(toGeoJSON(undefined).features).toEqual([]);
  });
});

describe("readPointsSpec", () => {
  it("tableau seul ou objet {data, cluster}", () => {
    expect(readPointsSpec([{ id: 1, lat: 0, lon: 0 }]).data).toHaveLength(1);
    const s = readPointsSpec({ data: [], cluster: true, clusterRadius: 30 });
    expect(s).toEqual({ data: [], cluster: true, clusterRadius: 30, clusterMaxZoom: 14 });
  });
});

describe("hôtes et style", () => {
  it("autorise data:, blob:, même origine et hôtes listés en https", () => {
    expect(hostAllowed("data:application/json,{}", [], ORIGIN)).toBe(true);
    expect(hostAllowed("blob:x", [], ORIGIN)).toBe(true);
    expect(hostAllowed("/tiles/1.png", [], ORIGIN)).toBe(true);
    expect(hostAllowed("https://tiles.openfreemap.org/styles/positron", ["tiles.openfreemap.org"], ORIGIN)).toBe(true);
    expect(hostAllowed("http://tiles.openfreemap.org/x", ["tiles.openfreemap.org"], ORIGIN)).toBe(false);
    expect(hostAllowed("https://evil.example/x", ["tiles.openfreemap.org"], ORIGIN)).toBe(false);
  });
  it("relève toutes les URL d'un style", () => {
    const style = { glyphs: "https://g/{fontstack}/{range}.pbf", sprite: [{ id: "a", url: "https://s/a" }],
      sources: { t: { type: "vector", url: "https://v/tiles.json" }, r: { type: "raster", tiles: ["https://r/{z}/{x}/{y}.png"] }, g: { type: "geojson", data: "https://d/x.geojson" } } };
    expect(styleUrls(style).sort()).toEqual(["https://d/x.geojson", "https://g/{fontstack}/{range}.pbf", "https://r/{z}/{x}/{y}.png", "https://s/a", "https://v/tiles.json"]);
    expect(firstForbiddenUrl(style, ["g", "s", "v", "r", "d"], ORIGIN)).toBeNull();
    expect(firstForbiddenUrl(style, ["g", "s", "v", "r"], ORIGIN)).toBe("https://d/x.geojson");
    expect(firstForbiddenUrl("https://evil.example/style.json", [], ORIGIN)).toBe("https://evil.example/style.json");
  });
});

describe("sameCamera", () => {
  const have = { center: [2.35, 48.85] as [number, number], zoom: 9, bearing: 0, pitch: 0 };
  it("identique à la tolérance près", () => {
    expect(sameCamera({ center: [2.350001, 48.850001], zoom: 9.0001 }, have)).toBe(true);
  });
  it("différente dès qu'un champ change", () => {
    expect(sameCamera({ zoom: 10 }, have)).toBe(false);
    expect(sameCamera({ pitch: 30 }, have)).toBe(false);
  });
});
