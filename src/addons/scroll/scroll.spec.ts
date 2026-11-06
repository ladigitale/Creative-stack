import { afterEach, describe, expect, it } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { activeSection, ema, sectionMetrics, smoothTo } from "./core";
import { SonicScroll } from "./scroll";

void SonicScroll;

describe("lissage", () => {
  it("rejoint la cible et ne dépend pas de la cadence", () => {
    const at = (fps: number) => { let v = 0; for (let i = 0; i < fps * 2; i++) v = smoothTo(v, 100, 1 / fps, 0.1); return v; };
    expect(at(60)).toBeGreaterThan(99.9);
    expect(Math.abs(at(30) - at(144))).toBeLessThan(0.05);
    expect(smoothTo(5, 9, 0.016, 1)).toBe(9);
    expect(smoothTo(5, 9, 0.016, 0)).toBe(5);
    expect(smoothTo(5, 9, 0, 0.5)).toBe(5);
  });
  it("vitesse lissée", () => {
    expect(ema(0, 1000, 1)).toBeGreaterThan(999);
    const v = ema(0, 1000, 0.016);
    expect(v).toBeGreaterThan(100);
    expect(v).toBeLessThan(300);
  });
});

describe("sections", () => {
  const vh = 800;
  it("avancement de la traversée", () => {
    expect(sectionMetrics({ top: 800, bottom: 1600, height: 800 }, vh).progress).toBe(0);
    expect(sectionMetrics({ top: 0, bottom: 800, height: 800 }, vh).progress).toBe(0.5);
    expect(sectionMetrics({ top: -800, bottom: 0, height: 800 }, vh).progress).toBe(1);
    expect(sectionMetrics({ top: 2000, bottom: 2800, height: 800 }, vh).inView).toBe(false);
  });
  it("épinglage d'une section plus haute que l'écran", () => {
    const h = 3000;
    expect(sectionMetrics({ top: 100, bottom: 100 + h, height: h }, vh).pin).toBe(0);
    expect(sectionMetrics({ top: -1100, bottom: 1900, height: h }, vh).pin).toBeCloseTo(0.5, 6);
    expect(sectionMetrics({ top: -2200, bottom: 800, height: h }, vh).pin).toBe(1);
  });
  it("visibilité", () => {
    expect(sectionMetrics({ top: 400, bottom: 1200, height: 800 }, vh).visible).toBe(0.5);
    expect(sectionMetrics({ top: -100, bottom: 1500, height: 1600 }, vh).visible).toBe(1);
  });
  it("section active : celle du milieu de l'écran, sinon la plus proche", () => {
    const r = (top: number, h = 800) => ({ top, bottom: top + h, height: h });
    expect(activeSection([r(-700), r(100), r(900)], vh)).toBe(1);
    expect(activeSection([r(-2000), r(-1000, 100)], vh)).toBe(1);
    expect(activeSection([], vh)).toBe(-1);
  });
});

// jsdom n'a pas de mise en page : on fournit la géométrie.
function setupPage(sectionCount = 3, h = 800) {
  let y = 0;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: sectionCount * h });
  const secs: HTMLElement[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = document.createElement("section");
    s.id = `s${i + 1}`;
    s.getBoundingClientRect = () => ({ top: i * h - y, bottom: (i + 1) * h - y, height: h, left: 0, right: 0, width: 0, x: 0, y: i * h - y, toJSON() {} }) as DOMRect;
    document.body.appendChild(s);
    secs.push(s);
  }
  window.scrollTo = ((o: ScrollToOptions) => { y = o.top ?? 0; window.dispatchEvent(new Event("scroll")); }) as typeof window.scrollTo;
  return { scrollTo: (v: number) => { y = v; window.dispatchEvent(new Event("scroll")); } };
}
const mount = (attrs: Record<string, string>) => {
  const el = document.createElement("sonic-scroll") as SonicScroll;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = (p: string) => JSON.parse(JSON.stringify(dp(p).get()));

afterEach(() => { document.body.innerHTML = ""; });

describe("sonic-scroll", () => {
  it("publie la position, l'avancement et les sections", async () => {
    const page = setupPage();
    mount({ sections: "section", "out-data-provider": "sc1", smooth: "1" });
    await wait(60);
    expect(state("sc1")).toMatchObject({ y: 0, max: 1600, progress: 0, atTop: true, atEnd: false });
    expect(state("sc1").sections.map((s: { id: string }) => s.id)).toEqual(["s1", "s2", "s3"]);
    page.scrollTo(800);
    await wait(80);
    const s = state("sc1");
    expect(s).toMatchObject({ y: 800, progress: 0.5, smoothProgress: 0.5 });
    expect(s.active).toMatchObject({ index: 1, id: "s2" });
    page.scrollTo(1600);
    await wait(80);
    expect(state("sc1")).toMatchObject({ atEnd: true, progress: 1 });
  });

  it("la valeur lissée rattrape le défilement et la vitesse retombe à zéro", async () => {
    const page = setupPage();
    mount({ "out-data-provider": "sc2", smooth: "0.3" });
    await wait(40);
    page.scrollTo(1000);
    await wait(40);
    const early = state("sc2");
    expect(early.y).toBe(1000);
    expect(early.smoothY).toBeLessThan(1000);
    expect(early.direction).toBe(1);
    await wait(1500);
    const late = state("sc2");
    expect(late.smoothY).toBe(1000);
    expect(late.velocity).toBe(0);
    expect(late.direction).toBe(0);
  });

  it("scrollTo par la commande control, une fois par compteur", async () => {
    setupPage();
    mount({ sections: "section", control: "sc3c", "out-data-provider": "sc3", smooth: "1" });
    await wait(40);
    dp("sc3c").set({ to: "#s3", n: 0 });
    await wait(20);
    expect(window.scrollY).toBe(0);
    dp("sc3c").set({ to: "#s3", n: 1 });
    await wait(80);
    expect(window.scrollY).toBe(1600);
    dp("sc3c").set({ to: 300, n: 2 });
    await wait(80);
    expect(window.scrollY).toBe(300);
  });

  it("ignore les sélecteurs invalides sans planter", async () => {
    setupPage();
    mount({ sections: "section[", "out-data-provider": "sc4" });
    await wait(60);
    expect(state("sc4").sections).toEqual([]);
  });
});
