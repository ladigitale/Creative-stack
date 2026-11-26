import { afterEach, describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { registerStore, unregisterStore } from "../interactive/registry";
import { ForceSim, MAX_NODES, normalizeGraph, staticLayout } from "./force";
import { readSelection, type GraphState, type SonicGraph } from "./graph";

const small = {
  nodes: [{ id: "a", label: "Alpha", group: "x" }, { id: "b", group: "y" }, { id: "c" }, { id: "d" }, { id: "e" }],
  links: [
    { source: "a", target: "b", weight: 2, label: "ab" },
    { source: "b", target: "c" },
    { source: "c", target: "a" },
    { source: "c", target: "d", directed: true },
  ],
};

/** Graphe aléatoire mais fixe : `n` nœuds, une chaîne + quelques raccourcis. */
function chain(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));
  const links = nodes.slice(1).map((_, i) => ({ source: `n${Math.floor(i / 2)}`, target: `n${i + 1}` }));
  return { nodes, links };
}

const dist = (s: ForceSim, a: string, b: string) => {
  const p = s.nodes[s.indexOf(a)!], q = s.nodes[s.indexOf(b)!];
  return Math.hypot(p.x - q.x, p.y - q.y);
};

describe("normalizeGraph", () => {
  it("nœuds et liens, nœuds manquants créés, rang accepté", () => {
    const g = normalizeGraph({ nodes: ["a", { id: "b", size: 9, fixed: true, x: 1, y: 2 }], links: [{ source: 0, target: "b" }, { source: "b", target: "z" }, { source: "", target: "a" }] });
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "z"]);
    expect(g.nodes[1]).toMatchObject({ size: 9, fixed: true, x: 1, y: 2 });
    expect(g.links).toEqual([{ source: "a", target: "b" }, { source: "b", target: "z" }]);
  });

  it("forme de $graphPath : edges en triplets et liste d'adjacence", () => {
    const e = normalizeGraph({ edges: [["a", "b", 2], ["b", "c"]], directed: true });
    expect(e.links).toEqual([{ source: "a", target: "b", weight: 2, directed: true }, { source: "b", target: "c", directed: true }]);
    const adj = normalizeGraph({ a: { b: 3 }, b: ["c"] });
    expect(adj.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(adj.links).toEqual([{ source: "a", target: "b", directed: true, weight: 3 }, { source: "b", target: "c", directed: true }]);
  });

  it("plafonne le nombre de nœuds avec une erreur lisible", () => {
    const g = normalizeGraph({ nodes: Array.from({ length: MAX_NODES + 5 }, (_, i) => i) });
    expect(g.nodes.length).toBe(MAX_NODES);
    expect(g.errors[0]).toMatch(/trop de nœuds/);
    expect(normalizeGraph(null).nodes).toEqual([]);
  });
});

describe("ForceSim", () => {
  it("converge : l'énergie décroît et la simulation se pose", () => {
    const s = new ForceSim({ seed: 3 });
    s.setGraph(normalizeGraph(chain(60)));
    const energy = (from: number, to: number) => {
      let e = 0;
      for (let i = from; i < to; i++) {
        s.tick();
        e += s.energy();
      }
      return e;
    };
    const early = energy(0, 20);
    energy(20, 100);
    const late = energy(100, 120);
    expect(late).toBeLessThan(early);
    for (let i = 0; i < 2000 && !s.settled; i++) s.tick();
    expect(s.settled).toBe(true);
    expect(s.energy()).toBeLessThan(early / 20);
    // Les voisins sont plus proches que les nœuds éloignés dans la chaîne.
    expect(dist(s, "n0", "n1")).toBeLessThan(dist(s, "n0", "n59"));
  });

  it("Barnes-Hut au-delà de 300 nœuds : pas de NaN, énergie qui décroît", () => {
    const s = new ForceSim({ seed: 1 });
    s.setGraph(normalizeGraph(chain(450)));
    const q = s.quadtree();
    expect(q.count).toBe(450);
    s.tick(5);
    const e0 = s.energy();
    s.tick(200);
    expect(s.energy()).toBeLessThan(e0);
    expect(s.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("déterministe : même graine = mêmes positions, autre graine = autre dessin", () => {
    const run = (seed: string) => {
      const s = new ForceSim({ seed });
      s.setGraph(normalizeGraph(small));
      s.tick(150);
      return s.nodes.map((n) => [n.x, n.y]);
    };
    expect(run("7")).toEqual(run("7"));
    expect(run("7")).not.toEqual(run("8"));
  });

  it("recharger garde la position des nœuds présents, nœud figé respecté", () => {
    const s = new ForceSim({ seed: 2 });
    s.setGraph(normalizeGraph(small));
    s.tick(100);
    const before = { ...s.nodes[s.indexOf("a")!] };
    const kept = s.setGraph(normalizeGraph({ ...small, nodes: [...small.nodes, { id: "f", x: 500, y: 500, fixed: true }], links: [...small.links, { source: "f", target: "a" }] }));
    expect(kept).toBe(5);
    expect(s.nodes[s.indexOf("a")!].x).toBe(before.x);
    s.tick(50);
    expect(s.nodes[s.indexOf("f")!]).toMatchObject({ x: 500, y: 500 });
  });
});

describe("placements fixes", () => {
  it("arbre en couches depuis la racine, parent centré sur ses enfants", () => {
    const g = normalizeGraph({ links: [{ source: "r", target: "a" }, { source: "r", target: "b" }, { source: "a", target: "a1" }, { source: "a", target: "a2" }, { source: "b", target: "b1" }] });
    const p = staticLayout("tree", g);
    const y = (id: string) => p.get(id)![1];
    const x = (id: string) => p.get(id)![0];
    expect(y("r")).toBeLessThan(y("a"));
    expect(y("a")).toBe(y("b"));
    expect(y("a1")).toBeGreaterThan(y("a"));
    expect(x("a")).toBeCloseTo((x("a1") + x("a2")) / 2);
    expect(x("a1")).toBeLessThan(x("a2"));
    // Autre racine : `b` en haut.
    const q = staticLayout("tree", g, { root: "b" });
    expect(q.get("b")![1]).toBeLessThan(q.get("r")![1]);
  });

  it("cercle et grille", () => {
    const g = normalizeGraph(chain(9));
    const c = staticLayout("circle", g);
    const radii = [...c.values()].map(([a, b]) => Math.hypot(a, b));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-9);
    const grid = staticLayout("grid", g, { spacing: 10 });
    expect(new Set([...grid.values()].map((v) => v[0])).size).toBe(3);
  });
});

describe("readSelection", () => {
  it("id, liste, résultat de $graphPath", () => {
    expect([...readSelection("a").nodes]).toEqual(["a"]);
    expect([...readSelection(["a", "b"]).nodes]).toEqual(["a", "b"]);
    const s = readSelection({ found: true, path: ["a", "b", "c"], cost: 3 });
    expect(s.nodes.size).toBe(3);
    expect(s.links.size).toBe(4);
    expect(readSelection(null).nodes.size).toBe(0);
  });
});

describe("<sonic-graph>", () => {
  const els: HTMLElement[] = [];
  afterEach(() => {
    for (const e of els.splice(0)) e.remove();
    unregisterStore("grStore");
  });

  async function mount(attrs: Record<string, string>, data: unknown = small): Promise<SonicGraph> {
    set(attrs["data-provider"], data);
    const el = document.createElement("sonic-graph") as SonicGraph;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    els.push(el);
    await el.updateComplete;
    el.settle(3000);
    await el.updateComplete;
    return el;
  }

  const pointer = (type: string, target: Element, x = 0, y = 0) => {
    const e = new MouseEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y });
    Object.defineProperty(e, "pointerId", { value: 1 });
    Object.defineProperty(e, "pointerType", { value: "mouse" });
    target.dispatchEvent(e);
  };

  it("dessine nœuds, liens, flèches, étiquettes en texte et publie l'état", async () => {
    const el = await mount({ id: "g1", "data-provider": "grData1", "publish-positions": "" }, { ...small, nodes: [...small.nodes, { id: "x", label: "<b>pas du html</b>" }] });
    const root = el.shadowRoot!;
    expect(root.querySelectorAll("circle.node").length).toBe(6);
    expect(root.querySelectorAll("line.link").length).toBe(4);
    expect(root.querySelectorAll("path.arrow").length).toBe(1);
    const texts = [...root.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toContain("Alpha");
    expect(texts).toContain("ab");
    expect(texts).toContain("<b>pas du html</b>");
    expect(root.querySelector("b")).toBeNull();
    // Couleurs par jetons uniquement.
    const fills = [...root.querySelectorAll("circle.node")].map((c) => c.getAttribute("fill"));
    expect(fills.every((f) => f!.startsWith("var(--sc-"))).toBe(true);
    expect(new Set(fills).size).toBe(2);
    expect(root.querySelectorAll(".legend li").length).toBe(2);
    const st = dp("g1State").get() as GraphState;
    expect(st).toMatchObject({ status: "ready", nodes: 6, links: 4, layout: "force", settled: true });
    expect(Object.keys(st.positions!)).toHaveLength(6);
  });

  it("tap sur un nœud : action graph:select vers le store, sélection surlignée", async () => {
    const got: { type: string; payload: unknown }[] = [];
    registerStore({ id: "grStore", dispatch: (a) => void got.push({ type: a.type, payload: a.payload }), getState: () => ({}), reset: () => {} });
    set("grSel", { found: true, path: ["a", "b"] });
    const el = await mount({ id: "g2", "data-provider": "grData2", target: "grStore", selection: "grSel", layout: "circle" });
    const root = el.shadowRoot!;
    const svgEl = root.querySelector("svg")!;
    const node = root.querySelector('circle[data-i="0"]')!;
    pointer("pointerdown", node);
    pointer("pointerup", svgEl);
    expect(got).toEqual([{ type: "graph:select", payload: { id: "a", node: { id: "a", label: "Alpha", group: "x" } } }]);
    await el.updateComplete;
    expect((dp("g2State").get() as GraphState).selected).toBe("a");
    expect(root.querySelectorAll("circle.sel").length).toBe(2);
    expect(root.querySelectorAll("line.hl").length).toBe(1);
  });

  it("survol : les non-voisins sont estompés", async () => {
    const el = await mount({ id: "g3", "data-provider": "grData3", layout: "grid" });
    const root = el.shadowRoot!;
    pointer("pointermove", root.querySelector('circle[data-i="3"]')!); // d : voisin de c seulement
    await el.updateComplete;
    expect(root.querySelectorAll("circle.dim").length).toBe(3);
    expect((dp("g3State").get() as GraphState).hover).toBe("d");
  });

  it("glisser avec pin : le nœud reste où on le lâche", async () => {
    const el = await mount({ id: "g4", "data-provider": "grData4", pin: "" });
    const root = el.shadowRoot!;
    const svgEl = root.querySelector("svg")!;
    pointer("pointerdown", root.querySelector('circle[data-i="4"]')!, 10, 10);
    pointer("pointermove", svgEl, 60, 40);
    pointer("pointerup", svgEl, 60, 40);
    const before = el.positions().e;
    el.settle(3000);
    expect(el.positions().e).toEqual(before);
    await el.updateComplete;
    expect(root.querySelectorAll("circle.pinned").length).toBe(1);
  });

  it("relit le DP en direct et garde les positions déjà calculées", async () => {
    const el = await mount({ id: "g5", "data-provider": "grData5" });
    const before = el.positions();
    set("grData5", { nodes: [...small.nodes, { id: "z" }], links: [...small.links, { source: "z", target: "e" }] });
    await el.updateComplete;
    const after = el.positions();
    expect(Object.keys(after)).toHaveLength(6);
    expect(after.a).toEqual(before.a);
    expect(el.shadowRoot!.querySelectorAll("circle.node").length).toBe(6);
  });

  it("forme de $graphPath acceptée, vide = idle", async () => {
    const el = await mount({ id: "g6", "data-provider": "grData6", layout: "tree" }, { edges: [["a", "b"], ["a", "c"]] });
    expect(el.shadowRoot!.querySelectorAll("circle.node").length).toBe(3);
    set("grData6", null);
    await el.updateComplete;
    expect((dp("g6State").get() as GraphState).status).toBe("idle");
    expect(el.shadowRoot!.querySelector(".empty")).not.toBeNull();
  });
});

describe("<sonic-graph> données identiques", () => {
  it("une republication à l'identique ne relance pas la simulation", async () => {
    set("grData7", small);
    const el = document.createElement("sonic-graph") as SonicGraph;
    el.setAttribute("data-provider", "grData7");
    document.body.appendChild(el);
    await el.updateComplete;
    el.settle(3000);
    const before = el.positions();
    set("grData7", JSON.parse(JSON.stringify(small)));
    await el.updateComplete;
    el.settle(3000);
    expect(el.positions()).toEqual(before);
    el.remove();
  });
});
