import { afterEach, describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicGamepad, readGamepadParams } from "./gamepad";

void SonicGamepad;

let pads: unknown[] = [];
Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => pads });

afterEach(() => {
  document.body.innerHTML = "";
  pads = [];
});

const pad = (lx: number) => ({ id: "pad-test", axes: [lx, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) });

describe("sonic-gamepad", () => {
  it("readGamepadParams : deadzone bornée, valeurs refusées listées", () => {
    expect(readGamepadParams({ deadzone: 2 }).settings).toEqual({ deadzone: 0.95 });
    expect(readGamepadParams({ deadzone: "x", keymap: 3 }).invalid).toEqual(["deadzone", "keymap"]);
    expect(readGamepadParams({ deadzone: "" })).toEqual({ settings: {}, invalid: [] });
  });

  it("deadzone en direct par params ; état publié avec status", async () => {
    pads = [pad(0.3)];
    const el = document.createElement("sonic-gamepad") as SonicGamepad;
    el.dispatchEventFlag = true;
    el.setAttribute("keymap", '{"ls-x+":"right"}');
    el.setAttribute("params", "gp1p");
    el.setAttribute("out-data-provider", "gp1");
    document.body.appendChild(el);
    await el.updateComplete;
    const got: string[] = [];
    el.addEventListener("sonic-action", (e) => got.push((e as CustomEvent).detail.type));
    const poll = () => (el as unknown as { poll(): void }).poll();
    expect(dp("gp1").get()).toMatchObject({ status: "ready", connected: true, id: "pad-test", deadzone: 0.25 });
    poll(); // 0.3 > 0.25 : poussé
    expect(got).toEqual(["right"]);
    pads = [pad(0)];
    poll();
    set("gp1p", { deadzone: 0.5 });
    expect((dp("gp1").get() as any).deadzone).toBe(0.5);
    pads = [pad(0.3)];
    poll(); // 0.3 < 0.5 : rien
    expect(got).toEqual(["right"]);
    set("gp1p", {}); // retour à l'attribut
    poll();
    expect(got).toEqual(["right", "right"]);
    set("gp1p", { deadzone: "large" });
    expect((dp("gp1").get() as any).status).toBe("error");
    el.remove();
  });
});
