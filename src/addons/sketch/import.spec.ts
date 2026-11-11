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

describe("sonic-sketch : retouches et carnet", async () => {
  const { MemoryBackend } = await import("./store");
  const { SonicSketch: Sketch } = await import("./sketch");

  it("aperçu d'une retouche, puis validation (une étape d'annulation) ou abandon", async () => {
    const el = await mount({ width: "400", height: "300", background: "#ffffff", "import-from": "vecImport9", control: "skCtl9", "out-data-provider": "skState9" });
    set("vecImport9", result(0, []));
    set("vecImport9", result(1, [{ color: "#ff0000", d: sq(10, 10, 50) }, { color: "#0000ff", d: sq(60, 10, 40) }]));
    set("skCtl9", { import: 1 });
    el.selectAll();
    expect(el.previewEdit("outline", 4, "black")).toBe(true);
    expect(el.getState().edit.preview).toBe(true);
    // L'aperçu n'est pas enregistré.
    expect(el.getState().colors).toBe(2);
    el.cancelEdit();
    expect(el.getState().edit.preview).toBe(false);
    el.previewEdit("outline", 4, ["black"]);
    expect(el.applyEdit()).toBe(true);
    expect(el.getState().colors).toBe(3);
    expect(el.getState().selection.count).toBe(3);
    el.undo();
    expect(el.getState().colors).toBe(2);
    el.remove();
  });

  it("enregistre le dessin ouvert, le rouvre, en crée un autre, le supprime", async () => {
    const mem = new MemoryBackend();
    Sketch.drawingBackend = mem;
    const el = await mount({ width: "400", height: "300", background: "#ffffff", "import-from": "vecImport10", control: "skCtl10", persist: "test" });
    await tick(); await tick();
    expect(el.getState().library).toMatchObject({ enabled: true, status: "saved", id: null, drawings: [] });
    set("vecImport10", result(0, []));
    set("vecImport10", result(1, [{ color: "#ff0000", d: sq(10, 10, 50) }]));
    set("skCtl10", { import: 1 });
    expect(await el.saveNow()).toBe(true);
    const first = el.getState().library.id!;
    expect(el.getState().library.drawings).toHaveLength(1);
    await el.newDrawing();
    expect(el.getState().strokes).toBe(0);
    expect(el.getState().library.id).toBeNull();
    el.remove();
    // Une autre toile du même carnet rouvre le dernier dessin ouvert.
    const again = await mount({ width: "400", height: "300", persist: "test" });
    await tick(); await tick(); await tick();
    expect(again.getState().strokes).toBe(0);
    expect(await again.openDrawing(first)).toBe(true);
    expect(again.getState().regions).toBe(1);
    await again.renameDrawing("Rouge");
    await again.saveNow();
    expect(again.getState().library.drawings[0]).toMatchObject({ id: first, name: "Rouge", current: true });
    await again.deleteDrawing(first);
    expect(again.getState().library.drawings).toEqual([]);
    expect(again.getState().strokes).toBe(0);
    again.remove();
  });
});

describe("sonic-sketch : retouches sur tout le dessin et couleurs de palette", () => {
  it("sans sélection : la retouche vise tout ; conversion vers la palette (palette-from)", async () => {
    set("palX", { colors: ["#000000", "#ffffff"] });
    const el = await mount({ width: "400", height: "300", background: "#ffffff", "import-from": "vecImport11", control: "skCtl11", "palette-from": "palX" });
    set("vecImport11", result(0, []));
    set("vecImport11", result(1, [{ color: "#ff0000", d: sq(10, 10, 50) }, { color: "#3344cc", d: sq(60, 10, 40) }]));
    set("skCtl11", { import: 1 });
    expect(el.getState().edit.scope).toBe("all");
    expect(el.previewEdit("palette", 100)).toBe(true);
    expect(el.applyEdit()).toBe(true);
    const st = el.getState();
    expect(st.colors).toBeLessThanOrEqual(2);
    expect(st.selection.count).toBe(0);
    el.undo();
    expect(el.previewEdit("grow", 4)).toBe(true);
    el.cancelEdit();
    el.remove();
  });
});

describe("sonic-sketch : enregistrement manuel", async () => {
  const { MemoryBackend } = await import("./store");
  const { SonicSketch: Sketch } = await import("./sketch");
  it("save-mode=manual : rien sans commande ; Enregistrer, Enregistrer sous (nom lu dans name-from)", async () => {
    Sketch.drawingBackend = new MemoryBackend();
    set("nomX", { name: "Variante" });
    const el = await mount({ width: "400", height: "300", "import-from": "vecImport12", control: "skCtl12", persist: "manuel", "save-mode": "manual", "name-from": "nomX" });
    await tick(); await tick();
    set("vecImport12", result(0, []));
    set("vecImport12", result(1, [{ color: "#ff0000", d: sq(10, 10, 50) }]));
    set("skCtl12", { import: 1, saveDrawingAs: 0 });
    await new Promise((r) => setTimeout(r, 2300));
    expect(el.getState().library.drawings).toHaveLength(0);
    expect(el.getState().library.dirty).toBe(true);
    expect(await el.saveDrawing()).toBe(true);
    const lib = el.getState().library;
    expect(lib).toMatchObject({ dirty: false, progress: 100, mode: "manual" });
    expect(lib.drawings).toHaveLength(1);
    set("skCtl12", { import: 1, saveDrawingAs: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const after = el.getState().library;
    expect(after.drawings.map((d: { name: string }) => d.name).sort()).toEqual([lib.name, "Variante"].sort());
    expect(after.name).toBe("Variante");
    el.remove();
  }, 10000);
});
