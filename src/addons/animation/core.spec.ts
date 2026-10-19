import { describe, expect, it } from "vitest";
import { ClockCore } from "./clock-core";
import {
  applyState,
  compileTimeline,
  evaluate,
  labelAt,
  normalizeProgress,
  resolveEase,
  setsCrossed,
} from "./timeline-core";
import type { TimelineNode } from "./types";

const el = () => document.createElement("div");

describe("easing", () => {
  it("linear, easeIn, easeOut, easeInOut et cubic-bezier respectent les bornes", () => {
    for (const e of ["linear", "easeIn", "easeOut", "easeInOut", [0.25, 0.1, 0.25, 1]] as const) {
      const f = resolveEase(e as never);
      expect(f(0)).toBeCloseTo(0, 5);
      expect(f(1)).toBeCloseTo(1, 5);
    }
    expect(resolveEase("easeIn")(0.5)).toBeLessThan(0.5);
    expect(resolveEase("easeOut")(0.5)).toBeGreaterThan(0.5);
    expect(resolveEase([0, 0, 1, 1])(0.3)).toBeCloseTo(0.3, 3);
  });
});

describe("compileTimeline : durées", () => {
  const tw = (duration: number): TimelineNode => ({ type: "tween", targets: ["a"], props: { opacity: [0, 1] }, duration });

  it("seq additionne, par prend le plus long", () => {
    expect(compileTimeline({ type: "seq", nodes: [tw(1), tw(2)] }).duration).toBeCloseTo(3);
    expect(compileTimeline({ type: "par", nodes: [tw(1), tw(2)] }).duration).toBeCloseTo(2);
  });

  it("stagger répartit les cibles multiples d'un tween", () => {
    const root: TimelineNode = {
      type: "stagger",
      each: 0.1,
      nodes: [{ type: "tween", targets: ["list"], props: { opacity: [0, 1] }, duration: 0.5 }],
    };
    const c = compileTimeline(root, { countTargets: () => 5 });
    expect(c.duration).toBeCloseTo(0.5 + 4 * 0.1);
  });

  it("delay s'ajoute ; set et label étendent la durée sans la porter", () => {
    const c = compileTimeline({
      type: "seq",
      nodes: [
        { type: "tween", targets: ["a"], props: { opacity: [0, 1] }, duration: 1, delay: 0.5 },
        { type: "label", name: "fin" },
        { type: "set", at: 0.2, path: "x.y", value: 1 },
      ],
    });
    expect(c.duration).toBeCloseTo(1.7);
    expect(c.labels).toEqual([{ at: 1.5, name: "fin" }]);
    expect(c.sets[0].at).toBeCloseTo(1.7);
  });
});

describe("evaluate : le temps est une entrée", () => {
  it("interpole à t = 0, 0.5, 1 et reste sur l'état de départ avant le début", () => {
    const a = el();
    const c = compileTimeline({
      type: "seq",
      nodes: [{ type: "tween", targets: ["a"], props: { opacity: [0, 1], x: [10, 0] }, duration: 2, delay: 1 }],
    });
    const at = (t: number) => evaluate(c, t, () => [a]).get(a)!.props;
    expect(at(0)).toMatchObject({ opacity: 0, x: 10 });
    expect(at(1)).toMatchObject({ opacity: 0, x: 10 });
    expect(at(2).opacity).toBeCloseTo(0.5);
    expect(at(3)).toMatchObject({ opacity: 1, x: 0 });
    expect(at(99)).toMatchObject({ opacity: 1, x: 0 });
  });

  it("deux tweens sur la même propriété : le dernier démarré gagne", () => {
    const a = el();
    const c = compileTimeline({
      type: "seq",
      nodes: [
        { type: "tween", targets: ["a"], props: { opacity: [0, 1] }, duration: 1 },
        { type: "tween", targets: ["a"], props: { opacity: [1, 0] }, duration: 1 },
      ],
    });
    const at = (t: number) => evaluate(c, t, () => [a]).get(a)!.props.opacity;
    expect(at(0.5)).toBeCloseTo(0.5);
    expect(at(1.5)).toBeCloseTo(0.5);
    expect(at(2)).toBeCloseTo(0);
  });

  it("stagger : chaque cible démarre avec un décalage", () => {
    const els = [el(), el(), el()];
    const c = compileTimeline(
      { type: "stagger", each: 1, nodes: [{ type: "tween", targets: ["l"], props: { opacity: [0, 1] }, duration: 1 }] },
      { countTargets: () => 3 },
    );
    const r = evaluate(c, 1.5, () => els);
    expect(r.get(els[0])!.props.opacity).toBeCloseTo(1);
    expect(r.get(els[1])!.props.opacity).toBeCloseTo(0.5);
    expect(r.get(els[2])!.props.opacity).toBeCloseTo(0);
  });

  it("cible sans élément : ignorée sans exception", () => {
    const c = compileTimeline({ type: "tween", targets: ["absent"], props: { opacity: [0, 1] } });
    expect(evaluate(c, 0.2, () => []).size).toBe(0);
  });

  it("labels et sets franchis", () => {
    const c = compileTimeline({
      type: "seq",
      nodes: [
        { type: "label", name: "a" },
        { type: "set", at: 1, path: "p.q", value: 5 },
        { type: "tween", targets: ["x"], props: { opacity: [0, 1] }, duration: 1 },
        { type: "label", name: "b" },
      ],
    });
    expect(labelAt(c, 0.5)).toBe("a");
    expect(labelAt(c, 2)).toBe("b");
    expect(setsCrossed(c, -1, 0.9)).toEqual([]);
    expect(setsCrossed(c, 0.9, 1)).toHaveLength(1);
    expect(setsCrossed(c, 1, 2)).toEqual([]); // déjà franchi
    expect(setsCrossed(c, 2, 0)).toEqual([]); // à rebours
  });
});

describe("applyState", () => {
  it("opacité, transform, blur et variables CSS", () => {
    const a = el();
    applyState(a, { props: { opacity: 0.5, x: 4, y: 8, scale: 2, blur: 3, "--n": 7 } });
    expect(a.style.opacity).toBe("0.5");
    expect(a.style.transform).toContain("translate(4px, 8px)");
    expect(a.style.transform).toContain("scale(2)");
    expect(a.style.filter).toBe("blur(3px)");
    expect(a.style.getPropertyValue("--n")).toBe("7");
  });

  it("count et type écrivent du texte (jamais de HTML)", () => {
    const n = el();
    applyState(n, { props: {}, text: { mode: "count", value: 12.345, decimals: 1, prefix: "$", suffix: "k" } });
    expect(n.textContent).toBe("$12.3k");
    const t = el();
    t.textContent = "<b>salut</b>";
    applyState(t, { props: {}, text: { mode: "type", progress: 0.5 } });
    expect(t.textContent).toBe("<b>sal"); // 6 caractères sur 12
    expect(t.children.length).toBe(0);
    applyState(t, { props: {}, text: { mode: "type", progress: 1 } });
    expect(t.textContent).toBe("<b>salut</b>");
  });
});

describe("normalizeProgress", () => {
  it("clamp et wrap, valeurs invalides → 0", () => {
    expect(normalizeProgress(1.4)).toBe(1);
    expect(normalizeProgress(-3)).toBe(0);
    expect(normalizeProgress(1.25, "wrap")).toBeCloseTo(0.25);
    expect(normalizeProgress(-0.25, "wrap")).toBeCloseTo(0.75);
    expect(normalizeProgress("abc")).toBe(0);
    expect(normalizeProgress(NaN)).toBe(0);
  });
});

describe("ClockCore", () => {
  const make = (mode: "once" | "loop" | "pingpong", duration = 2) => {
    const c = new ClockCore();
    c.mode = mode;
    c.duration = duration;
    c.play();
    return c;
  };

  it("once : avance puis s'arrête à 1 ; play() rejoue depuis 0", () => {
    const c = make("once");
    c.advance(1);
    expect(c.t).toBeCloseTo(0.5);
    c.advance(5);
    expect(c.t).toBe(1);
    expect(c.playing).toBe(false);
    c.play();
    expect(c.t).toBe(0);
    expect(c.playing).toBe(true);
  });

  it("loop : reboucle", () => {
    const c = make("loop");
    c.advance(2.5);
    expect(c.t).toBeCloseTo(0.25);
    expect(c.playing).toBe(true);
  });

  it("pingpong : repart en sens inverse aux bornes", () => {
    const c = make("pingpong");
    c.advance(3); // 1.5 tour → 0.75 en descente
    expect(c.t).toBeCloseTo(0.5, 5);
    expect(c.direction).toBe(-1);
    c.advance(1);
    expect(c.t).toBeCloseTo(0, 5);
  });

  it("rate négatif : à rebours, once s'arrête à 0", () => {
    const c = make("once");
    c.t = 0.5;
    c.rate = -1;
    c.advance(1);
    expect(c.t).toBeCloseTo(0);
    expect(c.playing).toBe(false);
  });

  it("à l'arrêt ou dt invalide : rien ne bouge", () => {
    const c = new ClockCore();
    expect(c.advance(1)).toBe(false);
    c.play();
    expect(c.advance(0)).toBe(false);
    expect(c.advance(-1)).toBe(false);
    expect(c.t).toBe(0);
  });

  it("seek borne et ignore NaN ; snapshot expose time", () => {
    const c = new ClockCore();
    c.duration = 4;
    c.seek(2);
    expect(c.t).toBe(1);
    c.seek(NaN);
    expect(c.t).toBe(0);
    c.seek(0.25);
    expect(c.snapshot("o")).toMatchObject({ t: 0.25, time: 1, duration: 4, origin: "o" });
  });
});
