import { afterEach, describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicGamepad } from "./gamepad";
import { readRumble } from "../../shared/device/rumble";

void SonicGamepad;

let pads: unknown[] = [];
Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => pads });

afterEach(() => {
  document.body.innerHTML = "";
  pads = [];
});

const buttons = () => Array.from({ length: 16 }, () => ({ pressed: false }));

describe("sonic-gamepad : vibration", () => {
  it("readRumble borne les valeurs (ms ≤ 5000, 0..1), accepte ms comme alias", () => {
    expect(readRumble({ duration: 9000, strong: 2, weak: -1, pad: 1 })).toEqual({ duration: 5000, strong: 1, weak: 0, pad: 1 });
    expect(readRumble({ ms: 120 })).toEqual({ duration: 120, strong: 0.8, weak: 0.5, pad: undefined });
  });

  it("rumble par compteur (dual-rumble), stopRumble, état rumble", async () => {
    const effects: Array<Record<string, number>> = [];
    let resets = 0;
    let finish: () => void = () => {};
    pads = [{ index: 0, id: "pad", axes: [0, 0], buttons: buttons(), vibrationActuator: {
      playEffect: (_t: string, p: Record<string, number>) => { effects.push(p); return new Promise<void>((r) => (finish = r)); },
      reset: async () => void resets++,
    } }];
    document.body.innerHTML = `<sonic-gamepad control="gpc" out-data-provider="gpcs"></sonic-gamepad>`;
    const el = document.querySelector("sonic-gamepad") as SonicGamepad;
    await el.updateComplete;
    expect((dp("gpcs").get() as any).rumble).toEqual({ supported: true, active: false });
    set("gpc", { rumble: { n: 0 } }); // référence : rien
    expect(effects).toHaveLength(0);
    set("gpc", { rumble: { n: 1, duration: 300, strong: 0.4, weak: 0.2 } });
    expect(effects[0]).toMatchObject({ duration: 300, strongMagnitude: 0.4, weakMagnitude: 0.2 });
    expect((dp("gpcs").get() as any).rumble.active).toBe(true);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect((dp("gpcs").get() as any).rumble.active).toBe(false);
    set("gpc", { rumble: { n: 1 }, stopRumble: 0 });
    set("gpc", { rumble: { n: 1 }, stopRumble: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(resets).toBe(1);
  });

  it("repli hapticActuators ; erreurs lisibles sans changer status", async () => {
    const pulses: number[][] = [];
    pads = [{ index: 0, id: "old", axes: [0, 0], buttons: buttons(), hapticActuators: [{ pulse: async (v: number, d: number) => void pulses.push([v, d]) }] }];
    document.body.innerHTML = `<sonic-gamepad out-data-provider="gph"></sonic-gamepad>`;
    const el = document.querySelector("sonic-gamepad") as SonicGamepad;
    await el.updateComplete;
    expect(await el.rumble({ duration: 100, strong: 0.3, weak: 0.6 })).toBe(true);
    expect(pulses).toEqual([[0.6, 100]]);
    expect(await el.rumble({ pad: 2 })).toBe(false);
    expect(dp("gph").get()).toMatchObject({ status: "ready", error: expect.stringContaining("Aucune manette n° 2") });
    pads = [{ index: 0, id: "mute", axes: [0, 0], buttons: buttons() }];
    expect(await el.rumble()).toBe(false);
    expect((dp("gph").get() as any).error).toContain("ne sait pas vibrer");
    expect((dp("gph").get() as any).rumble.supported).toBe(false);
  });
});
