import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import type { SonicClock } from "./clock";
import type { SonicTimeline } from "./timeline";

const tick = () => new Promise((r) => setTimeout(r, 0));
let n = 0;
/** Identifiant de DataProvider unique par test (les DataProviders sont globaux). */
const id = (p: string) => `${p}-${++n}`;

/** rAF manuel + horloge contrôlée : le test décide de l'écoulement du temps. */
function fakeFrames() {
  let now = 1000;
  let nextId = 0;
  let queue = new Map<number, (t: number) => void>();
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    queue.set(++nextId, cb);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (rafId: number) => {
    queue.delete(rafId);
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
      const run = queue;
      queue = new Map();
      for (const cb of run.values()) cb(now);
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const descriptor = (timeSource: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    timeSource,
    ...extra,
    root: {
      type: "seq",
      nodes: [{ type: "tween", targets: ["box"], props: { opacity: [0, 1], "--n": [0, 10] }, duration: 1 }],
    },
  });

describe("sonic-clock", () => {
  it("publie son état dans le DataProvider et avance avec le temps injecté", async () => {
    const frames = fakeFrames();
    const dp = id("clk");
    document.body.innerHTML = `<sonic-clock dataProvider="${dp}" duration="4" mode="once" autoplay="true"></sonic-clock>`;
    const clock = document.querySelector("sonic-clock") as SonicClock;
    await clock.updateComplete;

    expect(get(`${dp}.playing`)).toBe(true);
    expect(get(`${dp}.duration`)).toBe(4);
    expect(get(`${dp}.t`)).toBe(0);

    frames.advance(1000);
    expect(get(`${dp}.t`)).toBeCloseTo(0.25, 5);
    expect(get(`${dp}.time`)).toBeCloseTo(1, 5);
    frames.advance(10000);
    expect(get(`${dp}.t`)).toBe(1);
    expect(get(`${dp}.playing`)).toBe(false);
  });

  it('autoplay="false" ne démarre pas', async () => {
    fakeFrames();
    const dp = id("clk");
    document.body.innerHTML = `<sonic-clock dataProvider="${dp}" autoplay="false"></sonic-clock>`;
    await (document.querySelector("sonic-clock") as SonicClock).updateComplete;
    expect(get(`${dp}.playing`)).toBe(false);
  });

  it("une écriture externe de t positionne l'horloge et la met en pause (anti-écho)", async () => {
    const frames = fakeFrames();
    const dp = id("clk");
    document.body.innerHTML = `<sonic-clock dataProvider="${dp}" duration="10" mode="loop" autoplay></sonic-clock>`;
    const clock = document.querySelector("sonic-clock") as SonicClock;
    await clock.updateComplete;
    frames.advance(1000);

    set(`${dp}.t`, 0.8); // slider, pair p2p…
    expect(clock.getState().t).toBeCloseTo(0.8);
    expect(clock.getState().playing).toBe(false);
    expect(get(`${dp}.playing`)).toBe(false);
    frames.advance(5000);
    expect(get(`${dp}.t`)).toBeCloseTo(0.8); // ne bouge plus

    set(`${dp}.playing`, true); // reprise pilotée par DataProvider
    frames.advance(1000);
    expect(get(`${dp}.t`)).toBeCloseTo(0.9, 5);
  });

  it("rate pilotable par DataProvider ; mode loop reboucle", async () => {
    const frames = fakeFrames();
    const dp = id("clk");
    document.body.innerHTML = `<sonic-clock dataProvider="${dp}" duration="1" mode="loop" autoplay></sonic-clock>`;
    await (document.querySelector("sonic-clock") as SonicClock).updateComplete;
    set(`${dp}.rate`, 2);
    frames.advance(250);
    expect(get(`${dp}.t`)).toBeCloseTo(0.5, 5);
    frames.advance(250); // tour complet : 1 → 0
    expect(get(`${dp}.t`)).toBeCloseTo(0, 5);
    frames.advance(250); // 750 ms à rate 2 = 1,5 tour → 0,5
    expect(get(`${dp}.t`)).toBeCloseTo(0.5, 5);
  });

  it("retrait de la page : plus aucune écriture", async () => {
    const frames = fakeFrames();
    const dp = id("clk");
    document.body.innerHTML = `<sonic-clock dataProvider="${dp}" duration="10" autoplay></sonic-clock>`;
    await (document.querySelector("sonic-clock") as SonicClock).updateComplete;
    document.body.innerHTML = "";
    const before = get(`${dp}.t`);
    frames.advance(3000);
    expect(get(`${dp}.t`)).toBe(before);
  });
});

describe("sonic-timeline", () => {
  it("lit un temps dans un DataProvider (slider) et applique l'état à t = 0, 0.5, 1", async () => {
    const dp = id("scrub");
    document.body.innerHTML = `
      <div id="box"></div>
      <sonic-timeline descriptor='${descriptor(`${dp}.t`)}'></sonic-timeline>`;
    const tl = document.querySelector("sonic-timeline") as SonicTimeline;
    await tl.updateComplete;
    const box = document.getElementById("box")!;

    expect(box.style.opacity).toBe("0"); // état de départ appliqué dès la configuration
    set(`${dp}.t`, 0.5);
    expect(Number(box.style.opacity)).toBeCloseTo(0.5);
    expect(box.style.getPropertyValue("--n")).toBe("5");
    set(`${dp}.t`, 1);
    expect(box.style.opacity).toBe("1");
    set(`${dp}.t`, 0);
    expect(box.style.opacity).toBe("0");
  });

  it("horloge + timeline : la timeline suit l'horloge sans rien d'autre qu'un timeSource", async () => {
    const frames = fakeFrames();
    const dp = id("clk");
    document.body.innerHTML = `
      <div id="box"></div>
      <sonic-clock dataProvider="${dp}" duration="2" autoplay></sonic-clock>
      <sonic-timeline time-source="${dp}.t" descriptor='${descriptor("ignored.t", { duration: 2 })}'></sonic-timeline>`;
    await (document.querySelector("sonic-timeline") as SonicTimeline).updateComplete;
    const box = document.getElementById("box")!;
    frames.advance(1000);
    expect(Number(box.style.opacity)).toBeCloseTo(1, 5); // t = 0.5 → temps 1 s sur un tween de 1 s
    frames.advance(1000);
    expect(box.style.opacity).toBe("1");
  });

  it("targets children: et @self ; groupes", async () => {
    const dp = id("scrub");
    document.body.innerHTML = `
      <ul id="list"><li>a</li><li>b</li></ul>
      <p data-anim-group="g">x</p><p data-anim-group="g">y</p>
      <sonic-timeline descriptor='${JSON.stringify({
        timeSource: `${dp}.t`,
        root: {
          type: "par",
          nodes: [
            { type: "tween", targets: ["children:list"], props: { opacity: [0, 1] }, duration: 1 },
            { type: "tween", targets: ["group:g"], props: { opacity: [1, 0] }, duration: 1 },
          ],
        },
      })}'></sonic-timeline>`;
    await (document.querySelector("sonic-timeline") as SonicTimeline).updateComplete;
    set(`${dp}.t`, 1);
    const lis = [...document.querySelectorAll("#list li")] as HTMLElement[];
    const ps = [...document.querySelectorAll("p")] as HTMLElement[];
    expect(lis.map((e) => e.style.opacity)).toEqual(["1", "1"]);
    expect(ps.map((e) => e.style.opacity)).toEqual(["0", "0"]);
  });

  it("cible apparue après la timeline (SDUI rendu en retard) : reprise automatique", async () => {
    const dp = id("scrub");
    document.body.innerHTML = `<sonic-timeline descriptor='${descriptor(`${dp}.t`)}'></sonic-timeline>`;
    await (document.querySelector("sonic-timeline") as SonicTimeline).updateComplete;
    set(`${dp}.t`, 1);
    const late = document.createElement("div");
    late.id = "box";
    document.body.appendChild(late);
    await tick();
    await tick();
    expect(late.style.opacity).toBe("1");
  });

  it("descripteur invalide : timeline muette, problèmes publiés, rien ne casse", async () => {
    const dp = id("scrub");
    const out = id("tl-out");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = `
      <div id="box"></div>
      <sonic-timeline out-data-provider="${out}" descriptor='${JSON.stringify({
        timeSource: `${dp}.t`,
        root: { type: "tween", targets: ["box"], props: { width: [0, 100] } },
      })}'></sonic-timeline>`;
    const tl = document.querySelector("sonic-timeline") as SonicTimeline;
    await tl.updateComplete;
    set(`${dp}.t`, 1);
    expect((document.getElementById("box") as HTMLElement).style.opacity).toBe("");
    expect(get(`${out}.status`)).toBe("error");
    expect(JSON.stringify(get(`${out}.issues`))).toContain("mise en page");
    expect(warn).toHaveBeenCalled();
  });

  it("publie progress, time et currentLabel ; descripteur lu depuis un DataProvider", async () => {
    const dp = id("scrub");
    const out = id("tl-out");
    const src = id("desc");
    set(src, {
      timeSource: `${dp}.t`,
      root: {
        type: "seq",
        nodes: [
          { type: "label", name: "debut" },
          { type: "tween", targets: ["box"], props: { opacity: [0, 1] }, duration: 2 },
          { type: "label", name: "fin" },
        ],
      },
    });
    document.body.innerHTML = `<div id="box"></div><sonic-timeline descriptor-dp="${src}" out-data-provider="${out}"></sonic-timeline>`;
    await (document.querySelector("sonic-timeline") as SonicTimeline).updateComplete;
    set(`${dp}.t`, 0.5);
    expect(get(`${out}.status`)).toBe("ready");
    expect(get(`${out}.duration`)).toBe(2);
    expect(get(`${out}.time`)).toBeCloseTo(1);
    expect(get(`${out}.currentLabel`)).toBe("debut");
    set(`${dp}.t`, 1);
    expect(get(`${out}.currentLabel`)).toBe("fin");
  });

  it("nœud set : écrit une fois en avançant, ne boucle pas", async () => {
    const dp = id("scrub");
    const target = id("flag");
    document.body.innerHTML = `<sonic-timeline descriptor='${JSON.stringify({
      timeSource: `${dp}.t`,
      duration: 1,
      root: { type: "seq", nodes: [{ type: "set", at: 0.5, path: `${target}.done`, value: 42 }] },
    })}'></sonic-timeline>`;
    await (document.querySelector("sonic-timeline") as SonicTimeline).updateComplete;
    set(`${dp}.t`, 0.4);
    expect(get(`${target}.done`)).toBeFalsy();
    set(`${dp}.t`, 0.6);
    expect(get(`${target}.done`)).toBe(42);
  });

  it("mouvement réduit : état final sans passer par les états intermédiaires", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    const dp = id("scrub");
    document.body.innerHTML = `<div id="box"></div><sonic-timeline descriptor='${descriptor(`${dp}.t`)}'></sonic-timeline>`;
    await (document.querySelector("sonic-timeline") as SonicTimeline).updateComplete;
    expect((document.getElementById("box") as HTMLElement).style.opacity).toBe("1");
  });

  it("lissage : converge vers la cible sans la dépasser", async () => {
    const frames = fakeFrames();
    const dp = id("scrub");
    document.body.innerHTML = `<div id="box"></div><sonic-timeline smooth="0.1" descriptor='${descriptor(`${dp}.t`)}'></sonic-timeline>`;
    await (document.querySelector("sonic-timeline") as SonicTimeline).updateComplete;
    const box = document.getElementById("box") as HTMLElement;
    set(`${dp}.t`, 1);
    expect(Number(box.style.opacity)).toBe(0); // pas de saut
    frames.advance(50);
    const mid = Number(box.style.opacity);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    for (let i = 0; i < 80; i++) frames.advance(50);
    expect(box.style.opacity).toBe("1");
  });

  it("un seul DataProvider de temps peut piloter deux timelines (sans écho)", async () => {
    const dp = id("scrub");
    document.body.innerHTML = `
      <div id="box"></div>
      <sonic-timeline descriptor='${descriptor(`${dp}.t`)}'></sonic-timeline>
      <sonic-timeline descriptor='${descriptor(`${dp}.t`)}'></sonic-timeline>`;
    for (const t of document.querySelectorAll("sonic-timeline")) await (t as SonicTimeline).updateComplete;
    set(`${dp}.t`, 0.5);
    expect(Number((document.getElementById("box") as HTMLElement).style.opacity)).toBeCloseTo(0.5);
    expect(get(`${dp}.t`)).toBe(0.5);
  });
});

describe("sonic-animate", () => {
  it("reveal avec time-source : enfants cachés au départ, visibles à t = 1", async () => {
    const dp = id("scrub");
    document.body.innerHTML = `
      <sonic-animate recipe="reveal" time-source="${dp}.t" stagger="0.2" duration="1">
        <h2 id="a">Titre</h2><p id="b">Texte</p>
      </sonic-animate>`;
    const animate = document.querySelector("sonic-animate") as HTMLElement & { updateComplete: Promise<boolean> };
    await animate.updateComplete;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    expect(a.style.opacity).toBe("0");
    expect(b.style.opacity).toBe("0");
    set(`${dp}.t`, 1);
    expect(a.style.opacity).toBe("1");
    expect(b.style.opacity).toBe("1");
    set(`${dp}.t`, 0.5); // durée totale 1.2 s : a est presque fini, b a à peine commencé
    expect(Number(a.style.opacity)).toBeGreaterThan(Number(b.style.opacity));
  });

  it("trigger=load : joue avec l'horloge locale puis reste à l'état final", async () => {
    const frames = fakeFrames();
    document.body.innerHTML = `<sonic-animate recipe="fade" trigger="load" duration="1"><p id="p">x</p></sonic-animate>`;
    const animate = document.querySelector("sonic-animate") as HTMLElement & { updateComplete: Promise<boolean> };
    await animate.updateComplete;
    const p = document.getElementById("p")!;
    expect(p.style.opacity).toBe("0");
    frames.advance(16); // déclenche le start() différé
    frames.advance(500);
    expect(Number(p.style.opacity)).toBeGreaterThan(0);
    expect(Number(p.style.opacity)).toBeLessThan(1);
    frames.advance(2000);
    expect(p.style.opacity).toBe("1");
  });

  it("count-up : compteur de texte, jamais de HTML", async () => {
    const dp = id("scrub");
    document.body.innerHTML = `
      <sonic-animate recipe="count-up" time-source="${dp}.t" from="0" to="1200" text-suffix=" €" duration="1">
        <span id="n">0</span>
      </sonic-animate>`;
    await (document.querySelector("sonic-animate") as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    set(`${dp}.t`, 1);
    expect(document.getElementById("n")!.textContent).toBe("1200 €");
  });

  it("recette inconnue : avertissement, enfants intacts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = `<sonic-animate recipe="explode"><p id="p">x</p></sonic-animate>`;
    await (document.querySelector("sonic-animate") as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    expect((document.getElementById("p") as HTMLElement).style.opacity).toBe("");
    expect(warn).toHaveBeenCalled();
  });
});
