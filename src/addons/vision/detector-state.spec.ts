import { describe, expect, it } from "vitest";
import { compileMap } from "../../shared/ml/map-expr";
import { DetectorCore, labelKey } from "./detector-state";

const det = (label: string, score: number, x: number, y = 0.2, w = 0.2, h = 0.3) => ({ label, score, x, y, w, h });
const core = (o: Partial<ConstructorParameters<typeof DetectorCore>[0]> = {}) => new DetectorCore({ holdMs: 150, mirror: false, ...o });

describe("DetectorCore", () => {
  it("sans objet : neutre", () => {
    const out = core().update([], 0);
    expect(out).toMatchObject({ present: 0, count: 0, label: "", cx: 0.5 });
    expect(out.objects).toEqual([]);
  });

  it("meilleur objet, comptes par étiquette, centres", () => {
    const out = core().update([det("person", 0.9, 0.1), det("cup", 0.7, 0.6), det("cup", 0.6, 0.8)], 0);
    expect(out).toMatchObject({ present: 1, count: 3, label: "person", score: 0.9, x: 0.1 });
    expect(out.cx).toBeCloseTo(0.2);
    expect(out.labels).toEqual({ person: 1, cup: 2 });
    expect(out.objects).toHaveLength(3);
  });

  it("miroir : x inversé", () => {
    const out = core({ mirror: true }).update([det("cup", 0.9, 0.1, 0.2, 0.2)], 0);
    expect(out.x).toBeCloseTo(0.7);
    expect(out.cx).toBeCloseTo(0.8);
  });

  it("hold-ms : la dernière sortie est gardée, puis neutre", () => {
    const c = core({ holdMs: 100 });
    c.update([det("cup", 0.9, 0.1)], 0);
    expect(c.update([], 50)).toMatchObject({ present: 1, label: "cup" });
    expect(c.update([], 300)).toMatchObject({ present: 0, count: 0 });
  });

  it("map : clés dérivées", () => {
    const out = core({ map: compileMap("pitch=cx*3600; vol=labels.person ? 1 : 0") }).update([det("person", 0.9, 0.3)], 0);
    expect(out.pitch).toBeCloseTo(0.4 * 3600);
    expect(out.vol).toBe(1);
  });

  it("labelKey : minuscules, caractères non alphanumériques → _", () => {
    expect(labelKey("Traffic Light")).toBe("traffic_light");
    expect(labelKey("  cell-phone!")).toBe("cell_phone");
    expect(labelKey("")).toBe("objet");
  });
});
