import { afterEach, describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicMatrix, cellsBetween } from "./matrix";
import { registerStore, unregisterStore, type SonicActionMessage } from "./registry";

void SonicMatrix;

function pointer(type: string, x: number, y: number, id = 1): Event {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(e, "pointerId", { value: id });
  return e;
}

async function mount(attrs: string): Promise<{ el: SonicMatrix; canvas: HTMLCanvasElement; got: SonicActionMessage[] }> {
  const got: SonicActionMessage[] = [];
  registerStore({ id: "mx", dispatch: (a) => got.push(a), getState: () => null, reset: () => {} });
  set("mxGrid", { grid: [[0, 1, 0, 0], [0, 0, 2, 0], [0, 0, 0, 0]] });
  document.body.innerHTML = `<sonic-matrix dataProvider="mxGrid" target="mx" ${attrs}></sonic-matrix>`;
  const el = document.querySelector("sonic-matrix") as SonicMatrix;
  await el.updateComplete;
  const canvas = el.shadowRoot!.querySelector("canvas")!;
  // 4 colonnes × 3 lignes de 10 px
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 40, height: 30, right: 40, bottom: 30, x: 0, y: 0, toJSON() {} });
  (canvas as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  return { el, canvas, got };
}

afterEach(() => {
  document.body.innerHTML = "";
  unregisterStore("mx");
});

describe("sonic-matrix interactif", () => {
  it("cellsBetween : cases traversées sans saut", () => {
    expect(cellsBetween({ row: 0, col: 0 }, { row: 0, col: 3 }).map((c) => c.col)).toEqual([0, 1, 2, 3]);
    expect(cellsBetween({ row: 0, col: 0 }, { row: 2, col: 2 })).toEqual([{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 2 }]);
  });

  it('emit="cell" : un clic envoie matrix:cell {row, col, value, index}', async () => {
    const { canvas, got } = await mount('emit="cell"');
    canvas.dispatchEvent(pointer("click", 15, 5));
    canvas.dispatchEvent(pointer("click", 25, 15));
    canvas.dispatchEvent(pointer("click", 80, 5)); // hors grille
    expect(got.map((a) => a.payload)).toEqual([
      { row: 0, col: 1, value: 1, index: 1, stroke: 1, first: true },
      { row: 1, col: 2, value: 2, index: 6, stroke: 2, first: true },
    ]);
    expect(got[0].type).toBe("matrix:cell");
  });

  it("sans emit ni paint : aucune action", async () => {
    const { canvas, got } = await mount("");
    canvas.dispatchEvent(pointer("click", 15, 5));
    canvas.dispatchEvent(pointer("pointerdown", 15, 5));
    expect(got).toEqual([]);
  });

  it("paint : une action par case nouvelle du geste, cases sautées comblées, paint-value", async () => {
    const { el, canvas, got } = await mount('paint paint-value="3"');
    expect(el.hasAttribute("paint")).toBe(true);
    canvas.dispatchEvent(pointer("pointerdown", 5, 5));
    canvas.dispatchEvent(pointer("pointermove", 6, 6)); // même case
    canvas.dispatchEvent(pointer("pointermove", 35, 5)); // saute deux cases
    canvas.dispatchEvent(pointer("pointermove", 5, 5)); // retour : déjà peintes
    canvas.dispatchEvent(pointer("pointerup", 5, 5));
    canvas.dispatchEvent(pointer("click", 5, 5)); // le clic qui suit n'ajoute rien
    expect(got.map((a) => (a.payload as { index: number }).index)).toEqual([0, 1, 2, 3]);
    expect(got[0].payload).toMatchObject({ paint: 3, first: true, stroke: 1 });
    expect(got[1].payload).toMatchObject({ first: false });
    canvas.dispatchEvent(pointer("pointerdown", 5, 5));
    expect(got).toHaveLength(5); // nouveau geste : la case repart
    expect(got[4].payload).toMatchObject({ index: 0, stroke: 2 });
  });
});
