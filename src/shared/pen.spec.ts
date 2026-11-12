import { describe, expect, it } from "vitest";
import { PalmGuard, VelocityPressure, pressureCurve, readPen, tiltToSpherical } from "./pen";

const ev = (o: Partial<PointerEvent> & { altitudeAngle?: number; azimuthAngle?: number }) =>
  ({ pointerType: "pen", pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, tangentialPressure: 0, buttons: 1, button: 0, ...o }) as unknown as PointerEvent;

describe("pen", () => {
  it("inclinaison : tiltX / tiltY → azimut et altitude", () => {
    expect(tiltToSpherical(0, 0)).toEqual({ azimuth: 0, altitude: Math.PI / 2 });
    const r = tiltToSpherical(45, 0);
    expect(r.azimuth).toBeCloseTo(0);
    expect(r.altitude).toBeCloseTo(Math.PI / 4);
    expect(tiltToSpherical(0, 45).azimuth).toBeCloseTo(Math.PI / 2);
    expect(tiltToSpherical(-45, 0).azimuth).toBeCloseTo(Math.PI);
  });

  it("readPen : bout gomme, bouton latéral, rotation, angles natifs prioritaires", () => {
    expect(readPen(ev({ buttons: 32 })).eraser).toBe(true);
    expect(readPen(ev({ button: 5 })).eraser).toBe(true);
    expect(readPen(ev({ buttons: 3 })).barrel).toBe(true);
    expect(readPen(ev({ twist: 90 })).twist).toBe(90);
    expect(readPen(ev({ twist: 0 })).twist).toBeNull();
    const n = readPen(ev({ altitudeAngle: 0.5, azimuthAngle: 1, tiltX: 45 }));
    expect([n.altitude, n.azimuth, n.hasTilt]).toEqual([0.5, 1, true]);
    expect(readPen(ev({})).hasTilt).toBe(false);
    const m = readPen(ev({ pointerType: "mouse", buttons: 32, pressure: 0.5 }));
    expect([m.pressure, m.eraser, m.hasTilt]).toEqual([1, false, false]);
    expect(readPen(ev({ pressure: 0 })).pressure).toBe(0.5);
  });

  it("courbe de pression", () => {
    expect(pressureCurve(0.5)).toBe(0.5);
    expect(pressureCurve(0.5, 2)).toBeCloseTo(0.25);
    expect(pressureCurve(0, 1, 0.2)).toBeCloseTo(0.2);
    expect(pressureCurve(1, 3, 0.2)).toBeCloseTo(1);
    expect(pressureCurve(2, NaN, -1)).toBe(1);
  });

  it("pression simulée : lent = appuyé, rapide = léger", () => {
    const v = new VelocityPressure(2, 0.3, 0);
    expect(v.feed(0, 0, 0)).toBe(1);
    expect(v.feed(1, 0, 10)).toBeGreaterThan(0.9);
    expect(v.feed(101, 0, 20)).toBeCloseTo(0.3);
  });

  it("rejet de la paume", () => {
    const g = new PalmGuard("auto");
    const touch = ev({ pointerType: "touch" });
    expect(g.navigates(touch)).toBe(false);
    g.note(ev({}));
    expect(g.navigates(touch)).toBe(true);
    expect(g.navigates(ev({}))).toBe(false);
    expect(new PalmGuard("navigate").navigates(touch)).toBe(true);
    const d = new PalmGuard("draw"); d.note(ev({}));
    expect(d.navigates(touch)).toBe(false);
  });
});
