import { describe, expect, it } from "vitest";
import { GOV, governDpr, keepFrame, newGovernor, syncView } from "./steady";

describe("procgen : stabilité de la vue", () => {
  it("syncView : première vue appliquée, recomposition sans changement de vue → rien à ré-appliquer", () => {
    const a = syncView({ key: "", modelKey: "" }, { camera: "iso", zoom: 1 }, null, undefined);
    expect(a.apply).toEqual({ camera: "iso", zoom: 1 });
    expect(a.reset).toBe(false);
    // même recette recomposée (objet déplacé) : mêmes entrées de vue
    const b = syncView(a.next, { camera: "iso", zoom: 1 }, null, undefined);
    expect(b.apply).toBeNull();
    expect(b.next).toBe(a.next);
  });

  it("syncView : d.view modifié → fusionné avec la vue courante ; vue de la recette ou caméra modifiée → repart du défaut", () => {
    const a = syncView({ key: "", modelKey: "" }, { camera: "iso" }, null, undefined).next;
    const b = syncView(a, { camera: "iso" }, null, { zoom: 2 });
    expect(b.apply).toEqual({ camera: "iso", zoom: 2 });
    expect(b.reset).toBe(false);
    const c = syncView(b.next, { camera: "perspective", yaw: 10 }, null, { zoom: 2 });
    expect(c.apply).toEqual({ camera: "perspective", yaw: 10, zoom: 2 });
    expect(c.reset).toBe(true);
    const d = syncView(c.next, { camera: "perspective", yaw: 10 }, "top", { zoom: 2 });
    expect(d.apply?.camera).toBe("top");
    expect(d.reset).toBe(true);
  });

  it("keepFrame : petit changement d'étendue ignoré, grand changement adopté", () => {
    expect(keepFrame(null, 12)).toBe(12);
    expect(keepFrame(20, 21)).toBe(20);
    expect(keepFrame(20, 14)).toBe(20);
    expect(keepFrame(20, 40)).toBe(40);
    expect(keepFrame(20, 10)).toBe(10);
  });
});

describe("procgen : régulateur de densité de pixels", () => {
  const run = (g = newGovernor(), dpr: number, frames: number, dt: number, ms: number, t0: number) => {
    let t = t0;
    const changes: { t: number; dpr: number }[] = [];
    for (let i = 0; i < frames; i++) {
      t += dt;
      const n = governDpr(g, dpr, 2, dt, ms, t);
      if (n !== dpr) changes.push({ t, dpr: (dpr = n) });
    }
    return { g, dpr, t, changes };
  };

  it("baisse quand c'est lent, puis ne remonte pas dans les 10 s qui suivent", () => {
    const slow = run(undefined, 1.5, 40, 1 / 30, 20, 0);
    expect(slow.dpr).toBe(1.25);
    // fluide juste après la baisse : pas de remontée avant 10 s
    const fast = run(slow.g, slow.dpr, Math.round(9 * 60), 1 / 60 - 0.001, 3, slow.t);
    expect(fast.changes).toEqual([]);
    const later = run(fast.g, fast.dpr, 5 * 60, 1 / 60 - 0.001, 3, fast.t);
    expect(later.changes.length).toBe(1);
    expect(later.dpr).toBe(1.5);
    expect(later.changes[0].t - slow.changes[0].t).toBeGreaterThanOrEqual(GOV.holdAfterDrop);
  });

  it("charge en limite : pas d'oscillation, au plus un changement toutes les quelques secondes", () => {
    const g = newGovernor();
    let dpr = 1.5, t = 0;
    const changes: number[] = [];
    // alternance de passages lents et rapides
    for (let s = 0; s < 60; s++) {
      const slow = s % 2 === 0;
      for (let i = 0; i < 40; i++) {
        const dt = slow ? 1 / 35 : 1 / 62;
        t += dt;
        const n = governDpr(g, dpr, 2, dt, slow ? 12 : 3, t);
        if (n !== dpr) {
          changes.push(t);
          dpr = n;
        }
      }
    }
    for (let i = 1; i < changes.length; i++) expect(changes[i] - changes[i - 1]).toBeGreaterThanOrEqual(GOV.gap);
    // jamais de remontée : il n'y a jamais `stable` secondes de fluidité d'affilée
    expect(dpr).toBe(GOV.min);
  });

  it("ne remonte pas au-delà du maximum ni ne descend sous le minimum", () => {
    expect(run(undefined, 2, 20 * 60, 1 / 70, 2, 0).dpr).toBe(2);
    expect(run(undefined, 0.75, 600, 1 / 20, 30, 0).dpr).toBe(0.75);
  });
});
