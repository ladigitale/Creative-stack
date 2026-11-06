import { afterEach, describe, expect, it } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { effectStyle, lineIndices, splitPieces, unitProgress } from "./core";
import { SonicSplitText } from "./split-text";

void SonicSplitText;

describe("découpe", () => {
  it("mots : les espaces restent du texte", () => {
    const p = splitPieces("un  deux trois", "words");
    expect(p.filter((x) => x.unit).map((x) => x.text)).toEqual(["un", "deux", "trois"]);
    expect(p.map((x) => x.text).join("")).toBe("un  deux trois");
  });
  it("caractères : un point de code par unité", () => {
    const p = splitPieces("a b😀", "chars");
    expect(p.filter((x) => x.unit).map((x) => x.text)).toEqual(["a", "b", "😀"]);
  });
  it("plafond d'unités", () => {
    const p = splitPieces("x".repeat(5000), "chars");
    expect(p.filter((x) => x.unit).length).toBe(2000);
    expect(p.map((x) => x.text).join("").length).toBe(5000);
  });
});

describe("avancement décalé", () => {
  it("bornes et ordre", () => {
    expect(unitProgress(0, 5, 0, 0.7)).toBe(0);
    expect(unitProgress(4, 5, 1, 0.7)).toBe(1);
    expect(unitProgress(0, 5, 0.3, 0.7)).toBeGreaterThan(unitProgress(4, 5, 0.3, 0.7));
    expect(unitProgress(4, 5, 0.3, 0.7)).toBe(0);
  });
  it("spread 0 : tout ensemble ; spread 1 : séquentiel", () => {
    expect(unitProgress(3, 5, 0.5, 0)).toBe(0.5);
    expect(unitProgress(0, 5, 0.01, 1)).toBe(1);
    expect(unitProgress(4, 5, 0.99, 1)).toBe(0);
    expect(unitProgress(0, 1, 0.4, 0.7)).toBe(0.4);
  });
  it("hors bornes", () => {
    expect(unitProgress(2, 5, -3, 0.5)).toBe(0);
    expect(unitProgress(2, 5, 9, 0.5)).toBe(1);
  });
});

describe("effets", () => {
  it("au repos : aucun style", () => {
    for (const e of ["rise", "fade", "blur", "wipe", "scale", "slide"] as const) {
      const s = effectStyle(e, 1, 20);
      expect([s.opacity, s.transform, s.filter, s.clipPath]).toEqual([1, "", "", ""]);
    }
  });
  it("caché au départ", () => {
    expect(effectStyle("rise", 0, 0).transform).toBe("translateY(110%)");
    expect(effectStyle("rise", 0, 0).outerClip).toBe(true);
    expect(effectStyle("fade", 0, 0).opacity).toBe(0);
    expect(effectStyle("wipe", 0, 0).clipPath).toBe("inset(0 100% 0 0)");
    expect(effectStyle("slide", 0, 30).transform).toBe("translateX(30px)");
    expect(effectStyle("blur", 0, 0).filter).toBe("blur(10px)");
  });
});

describe("lignes", () => {
  it("regroupe par position verticale", () => {
    expect(lineIndices([0, 0, 1, 30, 31, 60])).toEqual([0, 0, 0, 1, 1, 2]);
    expect(lineIndices([])).toEqual([]);
  });
});

describe("sonic-split-text", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  const mk = async (attrs: Record<string, string>, content = "") => {
    const el = document.createElement("sonic-split-text") as SonicSplitText;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (content) el.textContent = content;
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  };
  const inners = (el: Element) => [...el.querySelectorAll("span[aria-hidden] > span")] as HTMLElement[];

  it("découpe le texte, le conserve accessible", async () => {
    const el = await mk({ text: "Un deux trois", split: "words" });
    expect(inners(el).map((s) => s.textContent)).toEqual(["Un", "deux", "trois"]);
    expect(el.getAttribute("aria-label")).toBe("Un deux trois");
    expect(el.textContent).toBe("Un deux trois");
  });
  it("utilise le contenu quand text est vide", async () => {
    const el = await mk({ split: "chars" }, "ab c");
    expect(inners(el).map((s) => s.textContent)).toEqual(["a", "b", "c"]);
  });
  it("progress 0 : caché ; 1 : au repos", async () => {
    const el = await mk({ text: "a b c", effect: "fade", progress: "0" });
    expect(inners(el).every((s) => s.style.opacity === "0")).toBe(true);
    el.progress = 1;
    await el.updateComplete;
    expect(inners(el).every((s) => s.style.opacity === "")).toBe(true);
    expect(el.getState().done).toBe(true);
  });
  it("décalage : la première unité devance la dernière", async () => {
    const el = await mk({ text: "a b c d", effect: "fade", progress: "0.4", spread: "0.8" });
    const o = inners(el).map((s) => Number(s.style.opacity || 1));
    expect(o[0]).toBeGreaterThan(o[3]);
  });
  it("suit un DataProvider", async () => {
    const el = await mk({ text: "a b", effect: "fade", "progress-source": "txt-src.p", "out-data-provider": "txt-out" });
    dp("txt-src").set({ p: 0.0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(inners(el)[0].style.opacity).toBe("0");
    dp("txt-src").set({ p: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(inners(el)[0].style.opacity).toBe("");
    expect((dp("txt-out").get() as any).done).toBe(true);
  });
  it("changement de texte reconstruit", async () => {
    const el = await mk({ text: "a b", progress: "1" });
    el.text = "x y z";
    await el.updateComplete;
    expect(inners(el).length).toBe(3);
  });
});
