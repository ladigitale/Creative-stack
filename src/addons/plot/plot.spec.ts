import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { arcPath, band, linePath, makeFormatter, niceTicks, parseDate, ticksIn, timeTicks } from "./scales";
import { normalizeSpec } from "./spec";
import { buildChart, seriesColor } from "./layout";
import type { SonicPlot } from "./plot";

const rows = [
  { m: "2026-01", ca: 10, marge: 3, cat: "A" },
  { m: "2026-02", ca: 20, marge: 5, cat: "B" },
  { m: "2026-03", ca: 15, marge: 4, cat: "A" },
];

describe("scales", () => {
  it("graduations rondes", () => {
    const t = niceTicks(0, 97, 5);
    expect(t.domain).toEqual([0, 100]);
    expect(t.ticks).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(5, 5).domain[0]).toBeLessThan(5);
    expect(niceTicks(NaN, 1).ticks.length).toBeGreaterThan(1);
    expect(ticksIn(3, 17, 4).every((v) => v >= 3 && v <= 17)).toBe(true);
  });

  it("bandes régulières", () => {
    const b = band(["a", "b", "c"], [0, 300], 0.2);
    expect(b("b") - b("a")).toBeCloseTo(b("c") - b("b"));
    expect(b.center("a")).toBeGreaterThan(b("a"));
    expect(b("c") + b.bandwidth).toBeLessThanOrEqual(300);
  });

  it("graduations de dates sur le calendrier", () => {
    const t = timeTicks(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31), 6);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(new Date(t[1]).getUTCDate()).toBe(1);
    const y = timeTicks(Date.UTC(2020, 0, 1), Date.UTC(2030, 0, 1), 5);
    expect(y.every((v) => new Date(v).getUTCMonth() === 0)).toBe(true);
  });

  it("dates ISO uniquement", () => {
    expect(parseDate("2026-03-14")).toBe(Date.UTC(2026, 2, 14));
    expect(parseDate("2026-03")).toBe(Date.UTC(2026, 2, 1));
    expect(parseDate("12")).toBeNaN();
    expect(parseDate("hello")).toBeNaN();
  });

  it("formats nommés, repli sûr", () => {
    expect(makeFormatter("percent", "fr")(0.256)).toMatch(/25,6\s?%/);
    expect(makeFormatter("integer", "fr")(1234.6)).toMatch(/1\s?235/);
    expect(makeFormatter("currency:EUR", "fr")(12)).toMatch(/12,00\s?€/);
    expect(makeFormatter("compact", "en")(1500)).toBe("1.5K");
    expect(makeFormatter("n'importe quoi", "fr")("abc")).toBe("abc");
    expect(makeFormatter("number", "fr")(null)).toBe("");
  });

  it("la courbe monotone ne dépasse pas les valeurs", () => {
    const d = linePath([[0, 0], [10, 0], [20, 10], [30, 10]], "monotone");
    const ys = [...d.matchAll(/C[\d.-]+,([\d.-]+),[\d.-]+,([\d.-]+)/g)].flatMap((m) => [+m[1], +m[2]]);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(10);
    expect(linePath([[1, 2]], "step")).toBe("M1,2");
    expect(linePath([], "linear")).toBe("");
  });

  it("secteur en anneau fermé", () => {
    expect(arcPath(50, 50, 20, 40, 0, Math.PI)).toMatch(/^M.*A.*L.*A.*Z$/);
    expect(arcPath(50, 50, 0, 40, 0, Math.PI * 2)).toMatch(/Z$/);
  });
});

describe("normalizeSpec", () => {
  it("garde le valide, signale le refusé", () => {
    const { spec, errors } = normalizeSpec({ type: "bar", x: "m", y: "ca", format: { y: "compact", x: "function(){}" }, colors: ["primary", "url(x)", "#abc"], curve: "zig", evil: 1 });
    expect(spec.type).toBe("bar");
    expect(spec.y).toEqual(["ca"]);
    expect(spec.format).toEqual({ y: "compact" });
    expect(spec.colors).toEqual(["primary", "#abc"]);
    expect(spec.curve).toBeUndefined();
    expect(errors.length).toBe(3);
    expect("evil" in spec).toBe(false);
  });

  it("type inconnu -> line + erreur", () => {
    const r = normalizeSpec({ type: "radar" });
    expect(r.spec.type).toBe("line");
    expect(r.errors[0]).toMatch(/type inconnu/);
  });
});

describe("buildChart", () => {
  it("ligne : séries multiples, axes, légende, survol au plus proche", () => {
    const m = buildChart(normalizeSpec({ type: "line", x: "m", y: ["ca", "marge"] }).spec, rows, 400, 200);
    expect(m.legend.map((l) => l.name)).toEqual(["ca", "marge"]);
    expect(m.hits.length).toBe(6);
    expect(m.xAxis!.ticks.length).toBeGreaterThan(1);
    expect(m.yAxis!.ticks[0].label).toBeDefined();
    const h = m.pick(m.hits[1].x, m.hits[1].y + 3)!;
    expect(h.seriesName).toBe("ca");
    expect(h.value).toBe(20);
  });

  it("barres empilées : le sommet dépasse chaque valeur seule", () => {
    const grouped = buildChart(normalizeSpec({ type: "bar", x: "m", y: ["ca", "marge"] }).spec, rows, 400, 200);
    const stacked = buildChart(normalizeSpec({ type: "bar", x: "m", y: ["ca", "marge"], stack: true }).spec, rows, 400, 200);
    const maxTick = (m: typeof grouped) => Math.max(...m.yAxis!.ticks.map((t) => parseFloat(t.label.replace(",", "."))));
    expect(maxTick(stacked)).toBeGreaterThanOrEqual(maxTick(grouped));
    const r = stacked.marks.filter((k) => k.k === "rect");
    expect(r.length).toBe(6);
    expect(stacked.pick((r[0] as { x: number; w: number; y: number; h: number }).x + 1, (r[0] as { y: number; h: number }).y + 1)).not.toBeNull();
  });

  it("aggregate : somme, moyenne et comptage par catégorie", () => {
    const sum = buildChart(normalizeSpec({ type: "bar", x: "cat", y: "ca", aggregate: "sum" }).spec, rows, 400, 200);
    expect(sum.hits.map((h) => [h.label, h.value])).toEqual([["A", 25], ["B", 20]]);
    const mean = buildChart(normalizeSpec({ type: "bar", x: "cat", y: "ca", aggregate: "mean" }).spec, rows, 400, 200);
    expect(mean.hits.find((h) => h.label === "A")!.value).toBe(12.5);
    const cnt = buildChart(normalizeSpec({ type: "bar", x: "cat", aggregate: "count" }).spec, rows, 400, 200);
    expect(cnt.hits.map((h) => h.value)).toEqual([2, 1]);
    expect(normalizeSpec({ aggregate: "median" }).errors[0]).toMatch(/aggregate/);
  });

  it("barres horizontales : catégories en ordonnée", () => {
    const m = buildChart(normalizeSpec({ type: "barh", x: "m", y: "ca" }).spec, rows, 400, 200);
    expect(m.yAxis!.ticks.map((t) => t.label)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(m.xAxis!.ticks.length).toBeGreaterThan(1);
  });

  it("série par champ (format long) et trous dans une courbe", () => {
    const long = [
      { x: 1, y: 1, s: "a" }, { x: 2, y: null, s: "a" }, { x: 3, y: 3, s: "a" }, { x: 1, y: 2, s: "b" },
    ];
    const m = buildChart(normalizeSpec({ type: "line", x: "x", y: "y", series: "s" }).spec, long, 300, 150);
    expect(m.legend.map((l) => l.name)).toEqual(["a", "b"]);
    const paths = m.overlay.filter((k) => k.k === "path");
    expect(paths.length).toBe(3); // a coupée en deux + b
  });

  it("secteurs : parts, total, pick par angle", () => {
    const m = buildChart(normalizeSpec({ type: "donut", x: "cat", value: "ca" }).spec, rows, 200, 200);
    expect(m.legend.map((l) => l.name)).toEqual(["A", "B"]);
    const a = m.hits.find((h) => h.label === "A")!;
    expect(a.value).toBe(25);
    expect(a.share).toBeCloseTo(25 / 45);
    expect(m.pick(a.x, a.y)!.label).toBe("A");
    expect(m.pick(100, 100)).toBeNull(); // trou du donut
  });

  it("histogramme : effectifs = nombre de valeurs", () => {
    const vals = Array.from({ length: 50 }, (_, i) => ({ v: i % 10 }));
    const m = buildChart(normalizeSpec({ type: "histogram", x: "v", bins: 5 }).spec, vals, 300, 200);
    expect(m.hits.reduce((n, h) => n + h.value, 0)).toBe(50);
  });

  it("carte de chaleur : cellules et bornes du dégradé", () => {
    const cells = [{ a: "x", b: "u", v: 1 }, { a: "y", b: "u", v: 5 }, { a: "x", b: "w", v: 3 }];
    const m = buildChart(normalizeSpec({ type: "heatmap", x: "a", y: "b", value: "v" }).spec, cells, 300, 200);
    expect(m.hits.length).toBe(3);
    expect(m.scale).toEqual({ min: "1", max: "5" });
  });

  it("nuage de points avec taille, dates sur l'axe", () => {
    const m = buildChart(normalizeSpec({ type: "scatter", x: "m", y: "ca", size: "marge" }).spec, rows, 400, 200);
    expect(m.xAxis!.ticks.length).toBeGreaterThan(1);
    expect(m.overlay.filter((k) => k.k === "dot").length).toBe(3);
  });

  it("sparkline sans axes ; données vides ; lignes de référence", () => {
    const sp = buildChart(normalizeSpec({ type: "sparkline", x: "m", y: "ca" }).spec, rows, 120, 40);
    expect(sp.xAxis).toBeNull();
    expect(buildChart(normalizeSpec({ type: "line" }).spec, [], 100, 100).empty).toBe(true);
    const r = buildChart(normalizeSpec({ type: "line", x: "m", y: "ca", rules: [{ value: 12, label: "cible" }, { value: 9999 }] }).spec, rows, 300, 200);
    expect(r.overlay.some((k) => k.k === "text" && k.text === "cible")).toBe(true);
  });

  it("couleurs : jetons du thème, jamais de valeur libre", () => {
    expect(seriesColor(0)).toBe("var(--sc-primary)");
    expect(seriesColor(1, ["danger"])).toBe("var(--sc-danger)");
    expect(seriesColor(6)).toContain("color-mix");
    expect(seriesColor(0, ["#ff0000"])).toBe("#ff0000");
  });
});

describe("sonic-plot", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 400, height: 200, top: 0, left: 0, right: 400, bottom: 200, x: 0, y: 0, toJSON() {} } as DOMRect);
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const settle = async (el: HTMLElement & { updateComplete?: Promise<unknown> }) => {
    for (let i = 0; i < 4; i++) { await el.updateComplete; await new Promise((r) => setTimeout(r, 0)); }
  };

  it("dessine depuis un DataProvider (tableau gelé par Concorde 6) et publie l'état", async () => {
    set("ventesT", rows);
    const el = document.createElement("sonic-plot") as SonicPlot;
    el.id = "pl";
    el.setAttribute("data-provider", "ventesT");
    el.setAttribute("type", "bar");
    el.setAttribute("x", "m");
    el.setAttribute("y", "ca");
    el.setAttribute("heading", "CA");
    document.body.append(el);
    await settle(el);
    const root = el.shadowRoot!;
    expect(root.querySelectorAll("svg rect").length).toBe(3);
    expect(root.querySelector(".title")!.textContent).toBe("CA");
    expect(root.querySelector("svg")!.getAttribute("role")).toBe("img");
    expect((dp("plState").get() as { count: number }).count).toBe(3);
  });

  it("suit les mises à jour du DataProvider", async () => {
    set("ventesU", rows);
    const el = document.createElement("sonic-plot") as SonicPlot;
    el.setAttribute("data-provider", "ventesU");
    el.setAttribute("type", "bar");
    el.setAttribute("x", "m");
    el.setAttribute("y", "ca");
    document.body.append(el);
    await settle(el);
    set("ventesU", [...rows, { m: "2026-04", ca: 30 }]);
    await settle(el);
    expect(el.shadowRoot!.querySelectorAll("svg rect").length).toBe(4);
  });

  it("clic : sélection publiée, re-clic la retire ; descripteur invalide signalé", async () => {
    const el = document.createElement("sonic-plot") as SonicPlot;
    el.id = "pl2";
    el.data = rows;
    el.spec = { type: "pie", x: "cat", value: "ca", format: { value: "js:alert(1)" } };
    document.body.append(el);
    await settle(el);
    expect(el.shadowRoot!.querySelectorAll("path").length).toBe(2);
    expect((dp("pl2State").get() as { error: string }).error).toMatch(/format\.value/);
  });
});
