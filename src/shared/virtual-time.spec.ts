import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeVirtualClock, installVirtualTime, nextRealFrame, nextTask } from "./virtual-time";

/** Vrai rAF doublé : les rappels sont gardés, on les déclenche à la main. */
let realQueue: Map<number, (t: number) => void>;
let realSeq = 0;
const realRaf = vi.fn((cb: (t: number) => void) => {
  realQueue.set(++realSeq, cb);
  return realSeq;
});
const realCaf = vi.fn((id: number) => {
  realQueue.delete(id);
});
function fireReal(t: number) {
  const batch = [...realQueue.values()];
  realQueue.clear();
  for (const cb of batch) cb(t);
}

beforeEach(() => {
  realQueue = new Map();
  vi.stubGlobal("requestAnimationFrame", realRaf);
  vi.stubGlobal("cancelAnimationFrame", realCaf);
});

afterEach(() => {
  activeVirtualClock()?.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("horloge virtuelle", () => {
  it("installée : rAF retenus, temps figé, pas exact de 1/fps, rappels au pas suivant", () => {
    const perfNow = performance.now;
    const clock = installVirtualTime();
    expect(activeVirtualClock()).toBe(clock);
    expect(requestAnimationFrame).not.toBe(realRaf);
    expect(performance.now).not.toBe(perfNow);
    // Avant freeze : le temps suit le temps réel.
    expect(clock.frozen).toBe(false);
    clock.freeze(1000);
    expect(performance.now()).toBe(1000);
    const d0 = Date.now();
    const seen: number[] = [];
    const nows: number[] = [];
    const loop = (t: number) => {
      seen.push(t);
      nows.push(performance.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    expect(realRaf).not.toHaveBeenCalled();
    expect(clock.pending).toBe(1);
    const step = 1000 / 30;
    for (let i = 1; i <= 3; i++) expect(clock.advanceTo(1000 + i * step)).toBe(1);
    expect(seen).toEqual([1000 + step, 1000 + 2 * step, 1000 + 3 * step]);
    expect(nows).toEqual(seen);
    expect(Math.abs(Date.now() - d0 - 100)).toBeLessThanOrEqual(1);
    // Annulation d'un rAF virtuel.
    const id = requestAnimationFrame(() => seen.push(-1));
    cancelAnimationFrame(id);
    clock.advance(step);
    expect(seen.at(-1)).toBeCloseTo(1000 + 4 * step, 9);
    expect(seen).not.toContain(-1);
    expect(realCaf).not.toHaveBeenCalled();
  });

  it("restauré : fonctions d'origine, boucles en attente rendues au vrai rAF, réinstallable", () => {
    const perfNow = performance.now;
    const dateNow = Date.now;
    const clock = installVirtualTime();
    clock.freeze(50);
    const seen: number[] = [];
    requestAnimationFrame((t) => seen.push(t));
    expect(() => installVirtualTime()).toThrow(/déjà en cours/);
    clock.restore();
    clock.restore(); // idempotent
    expect(clock.installed).toBe(false);
    expect(activeVirtualClock()).toBeNull();
    expect(requestAnimationFrame).toBe(realRaf);
    expect(cancelAnimationFrame).toBe(realCaf);
    expect(performance.now).toBe(perfNow);
    expect(Date.now).toBe(dateNow);
    expect(Object.prototype.hasOwnProperty.call(performance, "now")).toBe(false);
    expect(clock.advance(10)).toBe(0);
    // Le rappel en attente part au prochain vrai rafraîchissement.
    expect(realRaf).toHaveBeenCalledTimes(1);
    fireReal(777);
    expect(seen).toEqual([777]);
    const again = installVirtualTime();
    expect(again.installed).toBe(true);
    again.restore();
  });

  it("un rappel qui lève n'empêche pas les autres ; restauration après erreur", () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (e: unknown) => reported.push(e));
    const perfNow = performance.now;
    const ran: string[] = [];
    const run = () => {
      const clock = installVirtualTime();
      try {
        requestAnimationFrame(() => {
          throw new Error("boum");
        });
        requestAnimationFrame(() => ran.push("b"));
        clock.advance(10);
        throw new Error("capture en échec");
      } finally {
        clock.restore();
      }
    };
    expect(run).toThrow("capture en échec");
    expect(ran).toEqual(["b"]);
    expect(reported).toHaveLength(1);
    expect(performance.now).toBe(perfNow);
    expect(requestAnimationFrame).toBe(realRaf);
    expect(activeVirtualClock()).toBeNull();
  });

  it("nextRealFrame : vrai rAF, ou délai maximal quand rAF est suspendu ; nextTask passe les microtâches", async () => {
    const clock = installVirtualTime();
    const p = nextRealFrame(clock.real, 1000);
    fireReal(42);
    expect(await p).toBe(42);
    const late = await nextRealFrame(clock.real, 5);
    expect(typeof late).toBe("number");
    clock.restore();
    let done = false;
    void Promise.resolve().then(() => Promise.resolve()).then(() => (done = true));
    await nextTask();
    expect(done).toBe(true);
  });
});
