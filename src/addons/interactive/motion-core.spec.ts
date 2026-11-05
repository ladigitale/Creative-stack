import { describe, expect, it } from "vitest";
import { MotionTracker, parseRange, parseScale, quantizeNote } from "./motion-core";

const opts = { smoothMs: 0, speedMax: 2, idleMs: 100, peakMs: 150 };

describe("MotionTracker", () => {
  it("vitesse signée sur une valeur, vel normalisée et bornée", () => {
    const m = new MotionTracker({ ...opts });
    expect(m.update(0, [0]).speed).toBe(0);
    const up = m.update(100, [0.1]);
    expect(up.speed).toBeCloseTo(1, 5);
    expect(up.vel).toBeCloseTo(0.5, 5);
    const down = m.update(200, [-0.2]);
    expect(down.speed).toBeCloseTo(-3, 5);
    expect(down.vel).toBe(1);
  });

  it("norme du déplacement avec plusieurs valeurs", () => {
    const m = new MotionTracker({ ...opts });
    m.update(0, [0, 0]);
    expect(m.update(100, [0.03, 0.04]).speed).toBeCloseTo(0.5, 5);
  });

  it("lissage : la vitesse monte progressivement", () => {
    const m = new MotionTracker({ ...opts, smoothMs: 100 });
    m.update(0, [0]);
    const a = m.update(50, [0.05]);
    expect(a.speed).toBeGreaterThan(0);
    expect(a.speed).toBeLessThan(1);
  });

  it("un trou de plus de 0,5 s repart de zéro sans pic", () => {
    const m = new MotionTracker({ ...opts });
    m.update(0, [0]);
    const r = m.update(2000, [1]);
    expect(r.speed).toBe(0);
    expect(r.peak).toBe(0);
  });

  it("le pic reste sur la fenêtre puis retombe", () => {
    const m = new MotionTracker({ ...opts });
    m.update(0, [0]);
    m.update(50, [0.1]); // 2 u/s
    expect(m.update(100, [0.1]).peakVel).toBe(1);
    expect(m.update(300, [0.1]).peak).toBeCloseTo(0, 5);
  });

  it("sans nouvelle valeur, la vitesse retombe vers 0 (idle)", () => {
    const m = new MotionTracker({ ...opts, smoothMs: 50 });
    m.update(0, [0]);
    m.update(50, [0.1]);
    expect(m.idle(100)).toBeNull(); // pas encore passé idle-ms
    const out = m.idle(400);
    expect(out).not.toBeNull();
    expect(Math.abs(out!.speed)).toBeLessThan(0.5);
    let last = out;
    for (let t = 450; t < 3000 && last; t += 50) last = m.idle(t) ?? last;
    expect(m.idle(3050)?.speed ?? 0).toBe(0);
  });

  it("changement de forme (1 → 2 valeurs) : remise à zéro", () => {
    const m = new MotionTracker({ ...opts });
    m.update(0, [0]);
    expect(m.update(100, [1, 1]).speed).toBe(0);
  });
});

describe("quantizeNote / parseurs", () => {
  it("arrondi simple sur la plage", () => {
    expect(quantizeNote(0, 48, 72)).toBe(48);
    expect(quantizeNote(1, 48, 72)).toBe(72);
    expect(quantizeNote(0.5, 48, 72)).toBe(60);
    expect(quantizeNote(2, 48, 72)).toBe(72);
    expect(quantizeNote(Number.NaN, 48, 72)).toBe(48);
  });

  it("calage sur une gamme pentatonique depuis la note basse", () => {
    const penta = [0, 2, 4, 7, 9];
    for (let i = 0; i <= 100; i++) {
      const n = quantizeNote(i / 100, 48, 72, penta);
      expect(penta).toContain((n - 48) % 12);
      expect(n).toBeGreaterThanOrEqual(48);
      expect(n).toBeLessThanOrEqual(72);
    }
  });

  it("parseRange / parseScale", () => {
    expect(parseRange("48, 72")).toEqual([48, 72]);
    expect(parseRange("48")).toBeUndefined();
    expect(parseRange("a,b")).toBeUndefined();
    expect(parseRange("0,200")).toBeUndefined();
    expect(parseScale("0,2,4")).toEqual([0, 2, 4]);
    expect(parseScale("")).toBeUndefined();
    expect(parseScale("0,x")).toBeUndefined();
  });
});
