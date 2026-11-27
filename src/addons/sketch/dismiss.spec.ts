import { describe, expect, it } from "vitest";
import "./index";
import type { SonicSketch } from "./sketch";

// Doublure de sonic-pop (Concorde) : même contrat, Pop.pops = menus montés, open = ouvert.
class FakePop extends HTMLElement {
  static pops = new Set<FakePop>();
  open = false;
  connectedCallback() { FakePop.pops.add(this); }
  disconnectedCallback() { FakePop.pops.delete(this); }
}
if (!customElements.get("sonic-pop")) customElements.define("sonic-pop", FakePop);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ptr = (type: string, x: number, y: number, o: Record<string, unknown> = {}) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true });
  const all = { pointerId: 1, pointerType: "touch", pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, buttons: 1, button: 0, ...o };
  for (const [k, v] of Object.entries(all)) Object.defineProperty(e, k, { value: v });
  return e;
};
const mount = async (open: boolean) => {
  const pop = document.createElement("sonic-pop") as HTMLElement & { open: boolean };
  document.body.appendChild(pop);
  pop.open = open;
  const el = document.createElement("sonic-sketch") as SonicSketch;
  for (const [k, v] of Object.entries({ width: "400", height: "300", background: "transparent" })) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  const c = el.shadowRoot!.querySelector("canvas")!;
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { el, c, done: () => { el.remove(); pop.remove(); } };
};

describe("sonic-sketch : appui qui ferme un menu", () => {
  it("un tapotement qui ferme un sonic-pop ne trace rien", async () => {
    const { el, c, done } = await mount(true);
    c.dispatchEvent(ptr("pointerdown", 50, 50));
    c.dispatchEvent(ptr("pointermove", 53, 52));
    c.dispatchEvent(ptr("pointerup", 53, 52, { buttons: 0 }));
    await wait(20);
    expect(el.getState().strokes).toBe(0);
    done();
  });

  it("un déplacement net trace quand même, depuis le point d'appui", async () => {
    const { el, c, done } = await mount(true);
    c.dispatchEvent(ptr("pointerdown", 50, 50));
    c.dispatchEvent(ptr("pointermove", 90, 70));
    c.dispatchEvent(ptr("pointermove", 140, 90));
    c.dispatchEvent(ptr("pointerup", 140, 90, { buttons: 0 }));
    await wait(20);
    expect(el.getState().strokes).toBe(1);
    done();
  });

  it("sans menu ouvert, un tapotement pose un point comme avant", async () => {
    const { el, c, done } = await mount(false);
    c.dispatchEvent(ptr("pointerdown", 50, 50));
    c.dispatchEvent(ptr("pointerup", 50, 50, { buttons: 0 }));
    await wait(20);
    expect(el.getState().strokes).toBe(1);
    done();
  });
});
