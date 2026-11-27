import { afterEach, describe, expect, it } from "vitest";
import jsonata from "jsonata";
import { dp, get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./store";
import { dispatch } from "./registry";
import { registerInteractiveHelpers } from "./helpers";
import { jsonSize, own } from "./store";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `it${i}`, title: `Objet ${i}`, tags: ["a", "b"], pos: { x: i, y: -i }, done: false }));

async function mount(id: string, initial: unknown, reducer: string, extra: Record<string, string> = {}): Promise<HTMLElement> {
  const el = document.createElement("sonic-store");
  el.id = id;
  el.setAttribute("initial", JSON.stringify(initial));
  el.setAttribute("reducer", reducer);
  for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

const REDUCER = `(
  $t := $action.type; $P := $action.payload;
  $t = 'select' ? $merge([$state, {"ui": $merge([$state.ui, {"selected": $P.id, "count": $state.ui.count + 1}])}])
  : $t = 'edit' ? $merge([$state, {"items": $map($state.items, function($it) { $it.id = $P.id ? $merge([$it, {"title": $P.title}]) : $it })}])
  : $t = 'tf' ? $state ~> | ui | {"tab": "b"} |
  : $state
)`;

describe("sonic-store : partage structurel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("un sous-arbre non touché garde la même référence ; l'état publié est gelé", async () => {
    await mount("partage1", { ui: { selected: null, count: 0, tab: "a" }, items: items(50) }, REDUCER);
    const before = get("partage1") as { items: unknown[]; ui: unknown };
    dispatch("partage1", { type: "select", payload: { id: "it3" } });
    await wait(20);
    const after = get("partage1") as { items: unknown[]; ui: { selected: string; count: number } };
    expect(after.ui).toMatchObject({ selected: "it3", count: 1 });
    expect(after.items).toBe(before.items);
    expect(Object.isFrozen(after.ui)).toBe(true);
    dispatch("partage1", { type: "edit", payload: { id: "it7", title: "Nouveau" } });
    await wait(20);
    const edited = get("partage1") as { items: { title: string }[] };
    expect(edited.items[7].title).toBe("Nouveau");
    // les autres lignes restent les mêmes objets
    expect(edited.items[6]).toBe(before.items[6]);
    expect(edited.items[8]).toBe(before.items[8]);
  });

  it("une liste n'est pas notifiée par une action qui ne la touche pas", async () => {
    await mount("partage2", { ui: { selected: null, count: 0, tab: "a" }, items: items(20) }, REDUCER);
    let list = 0, row = 0, ui = 0;
    dp("partage2.items").onAssign(() => list++, false);
    dp("partage2.items.4").onAssign(() => row++, false);
    dp("partage2.ui").onAssign(() => ui++, false);
    // (l'opérateur JSONata `~> | … |` copie toute son entrée : réservé aux petites parties de l'état)
    for (let i = 0; i < 5; i++) dispatch("partage2", { type: "select", payload: { id: `it${i}` } });
    await wait(30);
    expect(ui).toBeGreaterThanOrEqual(1);
    expect(list).toBe(0);
    expect(row).toBe(0);
  });

  it("historique par référence : @undo revient à l'état précédent", async () => {
    await mount("partage3", { ui: { selected: null, count: 0, tab: "a" }, items: items(3) }, REDUCER, { history: "5" });
    dispatch("partage3", { type: "select", payload: { id: "it1" } });
    dispatch("partage3", { type: "select", payload: { id: "it2" } });
    await wait(20);
    dispatch("partage3", { type: "@undo" });
    await wait(20);
    expect((get("partage3") as { ui: { selected: string; count: number } }).ui).toMatchObject({ selected: "it1", count: 1 });
  });

  it("le plafond de taille reste celui de JSON.stringify", async () => {
    await mount("partage4", { s: "" }, `$action.type = 'grow' ? {"s": $pad("", 600, "x")} : $state`, { "max-state-bytes": "500" });
    dispatch("partage4", { type: "grow" });
    await wait(20);
    const v = get("partage4") as { s: string; lastError: string | null };
    expect(v.s).toBe("");
    expect(v.lastError).toMatch(/trop gros/);
  });
});

describe("own / jsonSize", () => {
  const sample = () => ({
    a: 1, b: "é\"\n ", c: [1, undefined, () => 1, NaN, Infinity, { d: undefined, e: null }], f: undefined, g: () => 2,
    h: { i: [true, false, -0, 1e-7, 1e21] }, j: new Date(0), "k\"ey": [[], {}],
  });
  it("même résultat qu'un aller-retour JSON, gelé en profondeur", () => {
    const o = own(sample());
    expect(o).toEqual(JSON.parse(JSON.stringify(sample())));
    expect(Object.isFrozen(o) && Object.isFrozen(o.c) && Object.isFrozen(o.h.i)).toBe(true);
  });
  it("jsonSize = longueur de JSON.stringify", () => {
    const o = own(sample());
    expect(jsonSize(o)).toBe(JSON.stringify(o).length);
    const big = own({ items: items(200), n: [1.5, -3, 0.1 + 0.2] });
    expect(jsonSize(big)).toBe(JSON.stringify(big).length);
    expect(jsonSize(big)).toBe(JSON.stringify(big).length);
  });
});

describe("réducteurs sur entrée gelée", () => {
  const EXPRS = [
    `$merge([$, {"x": 1}])`,
    `$ ~> | items[id = "it2"] | {"title": "t"} |`,
    `$ ~> | items | {"done": true}, ["tags"] |`,
    `$map(items, function($v, $i) { $merge([$v, {"i": $i}]) })`,
    `$sort(items, function($a, $b) { $a.pos.y > $b.pos.y })`,
    `$reverse(items)`,
    `$append(items, [{"id": "z"}])`,
    `$filter(items, function($v) { $v.pos.x % 2 = 0 })`,
    `$reduce(items, function($a, $v) { $a + $v.pos.x }, 0)`,
    `$distinct(items.tags)`,
    `$spread(ui)`,
    `$each(ui, function($v, $k) { $k })`,
    `$keys(items[0])`,
    `$lookup(items, "title")`,
    `items{id: title}`,
    `items^(>pos.x)`,
    `items[[0..2]]`,
    `{"ui": ui, "items": items}`,
    `$set($, "ui.tab", "c")`,
    `$clamp(ui.count, 0, 10)`,
    `$range(0, 3)`,
  ];
  it("aucun réducteur ne modifie son entrée, et le résultat est le même que sur une copie", async () => {
    const make = () => ({ ui: { selected: null, count: 2, tab: "a" }, items: items(6) });
    for (const src of EXPRS) {
      const e = jsonata(src);
      registerInteractiveHelpers(e);
      const frozen = own(make());
      const snap = JSON.stringify(frozen);
      const onFrozen = await e.evaluate(frozen);
      const onCopy = await e.evaluate(make());
      expect(JSON.stringify(frozen), src).toBe(snap);
      expect(JSON.parse(JSON.stringify(onFrozen ?? null)), src).toEqual(JSON.parse(JSON.stringify(onCopy ?? null)));
    }
  });
});
