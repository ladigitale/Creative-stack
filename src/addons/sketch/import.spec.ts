import { describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import type { SonicSketch } from "./sketch";

/** Toile posée dans un cadre d'écran simulé (jsdom n'a pas de mise en page). */
async function mount(attrs: Record<string, string>) {
  if (attrs.control) set(attrs.control, { import: 0 });
  const el = document.createElement("sonic-sketch") as SonicSketch;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  const canvas = el.shadowRoot!.querySelector("canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return el;
}
const result = (runs: number, paths: { color: string; d: string }[], frame: number[] | null = null) => ({
  status: "ready", runs, width: 100, height: 100, sourceWidth: 100, sourceHeight: 100, frame,
  paths: paths.map((p) => ({ ...p, area: 0, share: 0 })),
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const sq = (x: number, y: number, s: number) => `M${x} ${y}L${x + s} ${y}L${x + s} ${y + s}L${x} ${y + s}Z`;

describe("sonic-sketch : import de formes vectorisées", () => {
  it("importe les couches en aplats, sans le papier, en une étape d'annulation", async () => {
    const el = await mount({ width: "400", height: "300", background: "#ffffff", "import-from": "vecImport1", control: "skCtl1", "out-data-provider": "skState1" });
    set("vecImport1", result(0, []));
    // Couches empilées : papier blanc (ignoré), un carré rouge, un carré bleu posé dessus en partie.
    set("vecImport1", result(1, [{ color: "#ffffff", d: sq(0, 0, 100) }, { color: "#ff0000", d: sq(10, 10, 50) }, { color: "#0000ff", d: sq(40, 40, 40) }]));
    set("skCtl1", { import: 1 });
    const st = el.getState();
    expect(st.imported).toMatchObject({ layers: 2 });
    expect(st.colors).toBe(2);
    expect(st.regions).toBe(2);
    expect(st.strokes).toBe(1);
    expect(st.canUndo).toBe(true);
    el.undo();
    expect(el.getState().strokes).toBe(0);
    el.remove();
  });

  it("import-auto : chaque nouveau résultat est importé ; même couleur que l'existant : une seule région", async () => {
    set("vecImport2", result(3, [{ color: "#ff0000", d: sq(0, 0, 10) }]));
    const el = await mount({ width: "400", height: "300", background: "#ffffff", "import-from": "vecImport2", "import-auto": "", "out-data-provider": "skState2" });
    await tick();
    expect(el.getState().strokes).toBe(0); // résultat déjà là au branchement : pas réimporté
    set("vecImport2", result(4, [{ color: "#ff0000", d: sq(10, 10, 30) }]));
    await tick();
    set("vecImport2", result(5, [{ color: "#ff0000", d: sq(30, 30, 30) }]));
    await tick();
    const st = el.getState();
    expect(st.strokes).toBe(1);
    expect(st.regions).toBe(1);
    el.remove();
  });

  it("placement : là où la source était affichée (frame) ou ajusté dans la vue", async () => {
    const el = await mount({ width: "400", height: "300", background: "#ffffff", "import-from": "vecImport3", control: "skCtl3", "out-data-provider": "skState3" });
    // Source affichée 1:1 en haut à gauche de la toile : le carré 0..10 tombe sur les pixels d'écran 0..10.
    set("vecImport3", result(1, [{ color: "#ff0000", d: sq(0, 0, 10) }], [1, 0, 0, 1, 0, 0]));
    set("skCtl3", { import: 1 });
    let b = el.getState().bbox!;
    // Vue par défaut : centre (0, 0) au milieu de la toile → écran (0, 0) = monde (-200, -150).
    expect(b.x).toBeCloseTo(-200, 3);
    expect(b.y).toBeCloseTo(-150, 3);
    expect(b.w).toBeCloseTo(10, 3);
    el.undo();
    el.setAttribute("import-place", "view");
    await el.updateComplete;
    set("skCtl3", { import: 2 });
    b = el.getState().bbox!;
    // Ajusté (90 % de la hauteur) : 100 px d'image → 270 px, centré.
    expect(b.w).toBeCloseTo(27, 3);
    expect(b.x + b.w / 2).toBeCloseTo(-200 + 200 - 135 + 13.5, 3);
    el.remove();
  });

  it("import-colors-from : les couleurs de la source, par étendue, prennent celles de la palette", async () => {
    set("palImport5", { colors: ["#112233", "#445566"] });
    const el = await mount({ width: "400", height: "300", background: "#ffffff", "import-from": "vecImport5", "import-colors-from": "palImport5", "import-skip": "#000000", control: "skCtl5", "out-data-provider": "skState5" });
    // Fond noir ignoré ; rouge (le plus étendu) → 1re couleur, vert → 2e, bleu → 1re à nouveau (palette de 2).
    set("vecImport5", result(1, [
      { color: "#000000", d: sq(0, 0, 100) }, { color: "#ff0000", d: sq(0, 0, 40) },
      { color: "#00ff00", d: sq(50, 0, 30) }, { color: "#0000ff", d: sq(0, 60, 20) },
    ]));
    set("skCtl5", { import: 1 });
    const svg = el.toSvg() ?? "";
    expect(el.getState().colors).toBe(2);
    expect(svg).toContain("#112233");
    expect(svg).toContain("#445566");
    expect(svg).not.toMatch(/#ff0000|#00ff00|#0000ff|fill="#000000"/);
    el.remove();
  });

  it("rien d'importable : erreur dans l'état, document intact", async () => {
    const el = await mount({ width: "400", height: "300", "import-from": "vecImport4", control: "skCtl4", "out-data-provider": "skState4" });
    set("vecImport4", { status: "working" });
    set("skCtl4", { import: 1 });
    expect(el.getState().imported).toMatchObject({ error: expect.any(String) });
    expect(el.getState().strokes).toBe(0);
    el.remove();
  });
});

describe("précision du tracé en direct", () => {
  it("simplify lu dans brush-from, sinon l'attribut, borné 0..8", async () => {
    const el = document.createElement("sonic-sketch") as HTMLElement & { simplifyPx(): number; live: Record<string, unknown>; simplify: number };
    el.simplify = 0.35;
    expect(el.simplifyPx()).toBeCloseTo(0.35);
    el.live = { simplify: 2 };
    expect(el.simplifyPx()).toBe(2);
    el.live = { simplify: 0 };
    expect(el.simplifyPx()).toBe(0);
    el.live = { simplify: 40 };
    expect(el.simplifyPx()).toBe(8);
    el.live = { simplify: "" };
    expect(el.simplifyPx()).toBeCloseTo(0.35);
  });
});
