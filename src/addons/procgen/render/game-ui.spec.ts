import { describe, expect, it } from "vitest";
import { holdButton, shieldUi } from "./game-ui";

const ev = (type: string, pointerId = 1) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "pointerId", { value: pointerId });
  return e;
};

describe("commandes tactiles des jeux", () => {
  it("un appui sur l'habillage ne remonte pas jusqu'à la scène (qui capturerait le pointeur)", () => {
    const stage = document.createElement("div"), ui = document.createElement("div"), btn = document.createElement("div");
    stage.append(ui);
    ui.append(btn);
    shieldUi(ui);
    let seen = 0;
    stage.addEventListener("pointerdown", () => seen++);
    stage.addEventListener("pointermove", () => seen++);
    btn.dispatchEvent(ev("pointerdown"));
    btn.dispatchEvent(ev("pointermove"));
    expect(seen).toBe(0);
    // ailleurs dans la scène, les gestes de caméra marchent toujours
    stage.dispatchEvent(ev("pointerdown"));
    expect(seen).toBe(1);
  });
  it("bouton tenu : enfoncé jusqu'au relâchement de son pointeur, même s'il le perd", () => {
    const btn = document.createElement("div");
    const log: boolean[] = [];
    holdButton(btn, (d) => log.push(d));
    btn.dispatchEvent(ev("pointerdown", 7));
    btn.dispatchEvent(ev("pointerleave", 7));
    btn.dispatchEvent(ev("pointerup", 3));
    expect(log).toEqual([true]);
    btn.dispatchEvent(ev("pointerup", 7));
    expect(log).toEqual([true, false]);
    btn.dispatchEvent(ev("pointerdown", 8));
    btn.dispatchEvent(ev("lostpointercapture", 8));
    btn.dispatchEvent(ev("pointercancel", 8));
    expect(log).toEqual([true, false, true, false]);
  });
});
