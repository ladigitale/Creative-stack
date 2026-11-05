import { describe, expect, it } from "vitest";
import { IdTracker, iou } from "./tracking";

const box = (label: string, x: number, y = 0.2, w = 0.2, h = 0.3) => ({ label, x, y, w, h });

describe("iou", () => {
  it("recouvrement ; boîtes disjointes ou vides : 0", () => {
    expect(iou({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(1);
    expect(iou({ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.25, y: 0, w: 0.5, h: 1 })).toBeCloseTo(1 / 3, 6);
    expect(iou({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })).toBe(0);
    expect(iou({ x: 0, y: 0, w: 0, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(0);
  });
});

describe("IdTracker", () => {
  it("un objet qui bouge un peu garde son id ; l'âge croît", () => {
    const t = new IdTracker();
    expect(t.update([box("cup", 0.1)], 0)).toEqual([{ id: 1, ageMs: 0 }]);
    expect(t.update([box("cup", 0.13)], 100)).toEqual([{ id: 1, ageMs: 100 }]);
    expect(t.update([box("cup", 0.17)], 250)).toEqual([{ id: 1, ageMs: 250 }]);
  });

  it("deux objets de même étiquette : ids distincts, stables même si l'ordre des boîtes change", () => {
    const t = new IdTracker();
    const a = t.update([box("cup", 0.1), box("cup", 0.6)], 0);
    expect(a.map((r) => r.id)).toEqual([1, 2]);
    const b = t.update([box("cup", 0.61), box("cup", 0.11)], 50);
    expect(b.map((r) => r.id)).toEqual([2, 1]);
  });

  it("une autre étiquette au même endroit reçoit un autre id", () => {
    const t = new IdTracker();
    t.update([box("cup", 0.1)], 0);
    expect(t.update([box("bottle", 0.1)], 50)[0].id).toBe(2);
  });

  it("disparu moins de maxAgeMs : retrouve son id ; plus longtemps : nouvel id", () => {
    const t = new IdTracker({ maxAgeMs: 300 });
    t.update([box("cup", 0.1)], 0);
    t.update([], 100);
    expect(t.update([box("cup", 0.11)], 200)[0]).toEqual({ id: 1, ageMs: 200 });
    t.update([], 300);
    expect(t.alive().has(1)).toBe(true);
    t.update([], 700);
    expect(t.alive().size).toBe(0);
    expect(t.update([box("cup", 0.11)], 800)[0]).toEqual({ id: 2, ageMs: 0 });
  });

  it("trop éloigné (IoU sous le seuil) : nouvel id ; seuil réglable", () => {
    const t = new IdTracker({ iou: 0.5 });
    t.update([box("cup", 0.1)], 0);
    expect(t.update([box("cup", 0.2)], 50)[0].id).toBe(2); // recouvrement 1/3 < 0,5
    const lax = new IdTracker({ iou: 0.1 });
    lax.update([box("cup", 0.1)], 0);
    expect(lax.update([box("cup", 0.2)], 50)[0].id).toBe(1);
  });

  it("deux boîtes pour une seule identité : la plus proche la garde, l'autre devient nouvelle", () => {
    const t = new IdTracker();
    t.update([box("cup", 0.1)], 0);
    const r = t.update([box("cup", 0.15), box("cup", 0.1)], 50);
    expect(r.map((x) => x.id)).toEqual([2, 1]);
  });

  it("reset : les ids repartent de 1", () => {
    const t = new IdTracker();
    t.update([box("cup", 0.1)], 0);
    t.reset();
    expect(t.update([box("cup", 0.1)], 10)[0].id).toBe(1);
  });
});
