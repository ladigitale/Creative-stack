import { afterEach, describe, expect, it } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./slider";
import type { SonicSlider } from "./slider";

const mount = async (attrs: Record<string, string>) => {
  const el = document.createElement("sonic-slider") as SonicSlider;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  await el.updateComplete;
  return el;
};
const input = (el: SonicSlider) => el.shadowRoot!.querySelector("input") as HTMLInputElement;

describe("sonic-slider", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("lit et écrit un nombre au chemin pointé du DataProvider, borné", async () => {
    PublisherManager.get("slJob").set({ photo: { lum: 10, gamma: 1 } });
    const el = await mount({ formDataProvider: "slJob", name: "photo.lum", min: "-100", max: "100", step: "5", label: "Luminosité" });
    expect(input(el).value).toBe("10");
    input(el).value = "35";
    input(el).dispatchEvent(new Event("input"));
    const v = PublisherManager.get("slJob").get() as { photo: { lum: unknown; gamma: number } };
    expect(v.photo.lum).toBe(35);
    expect(typeof v.photo.lum).toBe("number");
    expect(v.photo.gamma).toBe(1);
    // Écriture ailleurs : le curseur suit.
    PublisherManager.get("slJob").photo.lum.set(-20);
    await el.updateComplete;
    expect(input(el).value).toBe("-20");
    expect(el.shadowRoot!.textContent).toContain("Luminosité");
  });

  it("DataProvider de l'ancêtre, décimales du pas, valeur texte numérique acceptée", async () => {
    PublisherManager.get("slJob2").set({ g: "1.5" });
    const box = document.createElement("div");
    box.setAttribute("formDataProvider", "slJob2");
    document.body.append(box);
    const el = document.createElement("sonic-slider") as SonicSlider;
    el.setAttribute("name", "g"); el.setAttribute("min", "0.2"); el.setAttribute("max", "3"); el.setAttribute("step", "0.1"); el.setAttribute("unit", "×");
    box.append(el);
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector(".val")!.textContent).toContain("1,5");
    input(el).value = "9";
    input(el).dispatchEvent(new Event("input"));
    expect((PublisherManager.get("slJob2").get() as { g: number }).g).toBe(3);
  });

  it("montre `value` tant que le chemin est vide, puis crée la clé au premier mouvement", async () => {
    PublisherManager.get("slJob3").set({ vals: {} });
    const el = await mount({ formDataProvider: "slJob3", name: "vals.grille.pas", min: "1", max: "50", value: "12" });
    expect(input(el).value).toBe("12");
    input(el).value = "20";
    input(el).dispatchEvent(new Event("input"));
    expect((PublisherManager.get("slJob3").get() as { vals: { grille: { pas: number } } }).vals.grille.pas).toBe(20);
  });
});
