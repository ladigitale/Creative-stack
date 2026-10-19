import { describe, expect, it } from "vitest";
import { collectSduiIds, validateSduiAnimation, validateTimelineDescriptor } from "./validate";

const ok = {
  timeSource: "clock-main.t",
  root: {
    type: "seq",
    nodes: [{ type: "tween", targets: ["title"], props: { opacity: [0, 1], y: [24, 0] }, duration: 0.6, ease: "easeOut" }],
  },
};

describe("validateTimelineDescriptor", () => {
  it("accepte un descripteur correct", () => {
    expect(validateTimelineDescriptor(ok)).toEqual([]);
  });

  it("chaque erreur porte path, field, message et fix non vides", () => {
    const bad = [
      { ...ok, root: { type: "tween", targets: ["a"], props: { width: [0, 100] } } }, // propriété non animable
      { ...ok, root: { type: "tween", targets: ["a"], props: { y: ["24px", "0"] } } }, // unités
      { ...ok, root: { type: "tween", targets: [], props: { opacity: [0, 1] } } }, // cibles vides
      { ...ok, root: { type: "tween", targets: ["a"], props: { opacity: [0, 1] }, ease: "bounce" } },
      { ...ok, root: { type: "wobble" } },
      { ...ok, outOfRange: "loop" },
      { ...ok, smooth: -1 },
      { timeSource: "x.t" },
      { ...ok, root: { type: "seq", nodes: [] } },
      { ...ok, root: { type: "set", path: "clock-main.t", value: 0 } }, // boucle sur le DP du temps
      { ...ok, root: { type: "label" } },
      null,
    ];
    for (const d of bad) {
      const issues = validateTimelineDescriptor(d);
      expect(issues.length, JSON.stringify(d)).toBeGreaterThan(0);
      for (const i of issues) {
        expect(i.path).toBeTruthy();
        expect(i.field).toBeTruthy();
        expect(i.message).toBeTruthy();
        expect(i.fix).toBeTruthy();
      }
    }
  });

  it("propose les propriétés autorisées pour une propriété de mise en page", () => {
    const [i] = validateTimelineDescriptor({ ...ok, root: { type: "tween", targets: ["a"], props: { top: [0, 10] } } });
    expect(i.message).toContain("mise en page");
    expect(i.fix).toContain("opacity");
  });

  it("limites : profondeur, nombre de cibles, durée", () => {
    let deep: unknown = { type: "tween", targets: ["a"], props: { opacity: [0, 1] } };
    for (let i = 0; i < 9; i++) deep = { type: "seq", nodes: [deep] };
    expect(validateTimelineDescriptor({ ...ok, root: deep }).some((i) => i.field === "depth")).toBe(true);

    const many = Array.from({ length: 201 }, (_, i) => `n${i}`);
    expect(
      validateTimelineDescriptor({ ...ok, root: { type: "tween", targets: many, props: { opacity: [0, 1] } } }).some(
        (i) => i.field === "targets",
      ),
    ).toBe(true);

    expect(validateTimelineDescriptor({ ...ok, duration: 601 }).some((i) => i.field === "duration")).toBe(true);
  });

  it("cible inconnue : signalée quand les ids sont fournis, avec la correction à appliquer", () => {
    const issues = validateTimelineDescriptor(ok, { knownIds: ["autre"] });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("title");
    expect(issues[0].fix).toContain('"nodeId": "title"');
    // children:, group: et @self ne cassent pas la vérification
    const root = {
      type: "par",
      nodes: [
        { type: "tween", targets: ["children:autre", "group:g", "@self"], props: { opacity: [0, 1] } },
      ],
    };
    expect(validateTimelineDescriptor({ ...ok, root }, { knownIds: ["autre"] })).toEqual([]);
  });
});

describe("validateSduiAnimation", () => {
  const sdui = (clocks: number, descriptor?: unknown) => ({
    nodes: [
      { tagName: "h1", nodeId: "title", attributes: { id: "title" }, textContent: "Hello" },
      ...Array.from({ length: clocks }, () => ({ tagName: "sonic-clock", attributes: { dataProvider: "clock-main", mode: "loop" } })),
      {
        tagName: "sonic-timeline",
        attributes: { descriptor: JSON.stringify(descriptor ?? ok) },
      },
    ],
  });

  it("document valide", () => {
    expect(validateSduiAnimation(sdui(1))).toEqual([]);
  });

  it("deux horloges sur le même DataProvider", () => {
    const issues = validateSduiAnimation(sdui(2));
    expect(issues.some((i) => i.message.includes("Deux horloges"))).toBe(true);
  });

  it("cible absente du document, JSON invalide, recette inconnue, descripteur manquant", () => {
    const missing = validateSduiAnimation(
      sdui(1, { ...ok, root: { type: "tween", targets: ["ghost"], props: { opacity: [0, 1] } } }),
    );
    expect(missing.some((i) => i.message.includes("ghost"))).toBe(true);

    const badJson = validateSduiAnimation({ nodes: [{ tagName: "sonic-timeline", attributes: { descriptor: "{oops" } }] });
    expect(badJson[0].message).toContain("JSON");

    const badRecipe = validateSduiAnimation({ nodes: [{ tagName: "sonic-animate", attributes: { recipe: "explode" } }] });
    expect(badRecipe[0].fix).toContain("reveal");

    const none = validateSduiAnimation({ nodes: [{ tagName: "sonic-timeline", attributes: {} }] });
    expect(none[0].field).toBe("descriptor");
  });

  it("collectSduiIds lit nodeId, attributes.id et data-node-id, y compris dans nodeById", () => {
    const ids = collectSduiIds({
      nodes: [{ nodeId: "a", nodes: [{ attributes: { id: "b" } }] }],
      nodeById: { c: { attributes: { "data-node-id": "c" } } },
    });
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });
});
