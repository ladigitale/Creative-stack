import { afterEach, describe, expect, it } from "vitest";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./controller";
import { deadzone, type SonicController } from "./controller";

type FakePad = { index: number; id: string; mapping: string; connected: boolean; axes: number[]; buttons: { pressed: boolean; value: number }[]; vibrationActuator?: { playEffect: (t: string, p: object) => Promise<void>; reset?: () => Promise<void> } };
let pads: FakePad[] = [];
const pad = (index = 0): FakePad => ({
  index, id: `Pad ${index}`, mapping: "standard", connected: true, axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
});
Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => pads });

afterEach(() => {
  document.body.innerHTML = "";
  pads = [];
});

describe("sonic-controller", () => {
  it("zone morte radiale", () => {
    expect(deadzone(0.1, 0.05, 0.15)).toEqual([0, 0]);
    expect(deadzone(1, 0, 0.15)).toEqual([1, 0]);
    expect(deadzone(0.575, 0, 0.15)[0]).toBeCloseTo(0.5, 2);
  });

  it("boutons → store (appui et relâchement), sticks → action analogique, état publié", async () => {
    const got: { type: string; payload?: unknown }[] = [];
    customElements.define("fake-store-c", class extends HTMLElement { dispatchAction(a: { type: string; payload?: unknown }) { got.push(a); } });
    document.body.innerHTML = `<fake-store-c id="g"></fake-store-c>
      <sonic-controller id="pad" store="g" release analog-action="stick" rate="120" keymap='{"a":"jump","start":{"type":"pause","payload":1},"ls-left":"left"}'></sonic-controller>`;
    const el = document.querySelector("sonic-controller") as SonicController;
    await el.updateComplete;
    pads = [pad(0)];
    el.poll();
    pads[0].buttons[0] = { pressed: true, value: 1 };
    pads[0].axes = [-0.9, 0, 0, 0];
    pads[0].buttons[7] = { pressed: false, value: 0.6 };
    await new Promise((r) => setTimeout(r, 15));
    el.poll();
    pads[0].buttons[0] = { pressed: false, value: 0 };
    pads[0].buttons[9] = { pressed: true, value: 1 };
    await new Promise((r) => setTimeout(r, 15));
    el.poll();
    const types = got.map((a) => a.type);
    expect(types).toContain("jump");
    expect(types).toContain("jump:up");
    expect(types).toContain("left");
    expect(got.find((a) => a.type === "pause")!.payload).toBe(1);
    expect(got.find((a) => a.type === "jump")!.payload).toEqual({ pad: 0 });
    const stick = got.filter((a) => a.type === "stick").pop()!.payload as Record<string, number>;
    expect(stick.lx).toBeLessThan(-0.85);
    expect(stick.rt).toBe(0.6);
    await new Promise((r) => setTimeout(r, 0));
    el.poll();
    const st = get("padState") as ReturnType<SonicController["getState"]>;
    expect(st).toMatchObject({ status: "ready", count: 1 });
    expect(st.pads[0].pressed).toContain("start");
  });

  it("vibration par compteur ; sans manette : idle", async () => {
    let effects = 0;
    const p = pad(0);
    p.vibrationActuator = { playEffect: async () => void effects++ };
    document.body.innerHTML = `<sonic-controller id="pad2" control="padCtl"></sonic-controller>`;
    const el = document.querySelector("sonic-controller") as SonicController;
    await el.updateComplete;
    expect(el.getState().status).toBe("idle");
    pads = [p];
    const { set } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
    set("padCtl", { rumble: { n: 0 } });
    set("padCtl", { rumble: { n: 1, ms: 100 } });
    expect(effects).toBe(1);
  });
});

describe("sonic-controller : vibration", () => {
  it("pad ciblé, duration, stopRumble, état rumble et erreurs", async () => {
    const calls: string[] = [];
    const mk = (i: number, ok: boolean): FakePad => {
      const p = pad(i);
      if (ok) p.vibrationActuator = Object.assign({ playEffect: async (_t: string, o: object) => void calls.push(`play${i}:${(o as { duration: number }).duration}`) }, { reset: async () => void calls.push(`reset${i}`) });
      return p;
    };
    pads = [mk(0, true), mk(1, false)];
    document.body.innerHTML = `<sonic-controller id="padr" control="padRc"></sonic-controller>`;
    const el = document.querySelector("sonic-controller") as SonicController;
    await el.updateComplete;
    el.poll();
    expect(el.getState().rumble).toEqual({ supported: true, active: false });
    const { set } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
    set("padRc", { rumble: { n: 0 }, stopRumble: 0 });
    set("padRc", { rumble: { n: 1, duration: 9000, pad: 0 }, stopRumble: 0 });
    expect(calls).toEqual(["play0:5000"]);
    set("padRc", { rumble: { n: 1 }, stopRumble: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("reset0");
    expect(await el.rumbleWith({ pad: 1 })).toBe(false);
    expect(el.getState().error).toContain("ne sait pas vibrer");
    expect(await el.rumbleWith({ pad: 3 })).toBe(false);
    expect((get("padrState") as { error: string }).error).toContain("Aucune manette n° 3");
    expect(await el.rumbleWith({ ms: 50, pad: 0 })).toBe(true);
    expect(el.getState().error).toBeNull();
  });
});
