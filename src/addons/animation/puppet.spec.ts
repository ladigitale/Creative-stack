import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicPuppet } from "./puppet";
import type { Part } from "../../shared/puppet";

void SonicPuppet;

const W = 200;
const H = 300;
const j = (x: number, y: number) => ({ x: x / W, y: y / H, v: 1 });
const JOINTS = {
  nose: j(100, 40),
  leftEar: j(88, 38),
  rightEar: j(112, 38),
  leftShoulder: j(70, 90),
  rightShoulder: j(130, 90),
  leftElbow: j(60, 140),
  rightElbow: j(140, 140),
  leftWrist: j(58, 185),
  rightWrist: j(142, 185),
  leftIndex: j(56, 200),
  rightIndex: j(144, 200),
  leftPinky: j(60, 198),
  rightPinky: j(140, 198),
};

function pixels(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([120, 80, 60, 255], (y * W + x) * 4);
  };
  rect(72, 85, 128, 220);
  rect(86, 20, 114, 60);
  rect(55, 88, 72, 190);
  rect(128, 88, 145, 190);
  return d;
}

type Nodes = Record<string, { x: number; y: number; rz: number }>;
type Sprite = { name: string; shape: string; src: string; w: number; h: number; pivot: string; z: number; layer?: string };
const sprites = () => dp("rig.sprites").get() as Sprite[];
const nodes = () => dp("rig.nodes").get() as Nodes;
const status = () => dp("rig.status").get() as { phase: string; error: string; parts: string[]; missing: string[]; body: number };

class Testable extends SonicPuppet {
  protected readPixels() {
    return { data: pixels(), width: W, height: H };
  }
  protected encode(part: Part): string {
    return `data:image/png;base64,${part.name}`;
  }
}
if (!customElements.get("test-puppet")) customElements.define("test-puppet", Testable);

async function mount(attrs: Record<string, string> = {}) {
  const el = document.createElement("test-puppet") as Testable;
  const base = { mode: "pieces", pose: "pz", capture: "app.hold", "nodes-out": "rig", drive: "anim.nodes", "drive-prefix": "d_", width: "800", height: "600", "settle-ms": "0", "timeout-ms": "50" };
  for (const [k, v] of Object.entries({ ...base, ...attrs })) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

beforeEach(() => {
  set("pz", { present: 1, frameSeq: 5, joints: JOINTS });
  set("app", { hold: false });
  set("anim", { nodes: {} });
  set("rig", { sprites: [], nodes: {}, status: {} });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("sonic-puppet", () => {
  it("à la prise de vue : une pièce par os mesuré, pivot sur l'articulation, nœuds au repos sur la photo", async () => {
    const el = await mount();
    set("app.hold", true);
    expect(el.getPhase()).toBe("waiting");
    el.poll(performance.now() + 1000);
    expect(el.getPhase()).toBe("ready");
    const names = sprites().map((s) => s.name);
    for (const n of ["torse", "tete", "bras-gauche", "avant-bras-gauche", "main-gauche", "bras-droit", "avant-bras-droit", "main-droite"]) expect(names).toContain(n);
    expect(names).not.toContain("cuisse-gauche"); // hanches absentes : seules les pièces vues existent
    expect(status().phase).toBe("ready");
    expect(status().missing).toContain("cuisse-gauche");
    const s = Math.min(800 / W, 600 / H); // 2 : l'image de 200 × 300 tient dans 800 × 600
    const ox = (800 - W * s) / 2;
    const arm = sprites().find((x) => x.name === "bras-gauche")!;
    expect(arm.shape).toBe("image");
    expect(arm.src.startsWith("data:image/png;base64,")).toBe(true);
    // l'épaule gauche est en (70, 90) dans l'image : nœud au repos = position dans la scène, rz = 0
    expect(nodes()["bras-gauche"].x).toBeCloseTo(ox + 70 * s, 1);
    expect(nodes()["bras-gauche"].y).toBeCloseTo(90 * s, 1);
    expect(nodes()["bras-gauche"].rz).toBe(0);
    const [px, py] = arm.pivot.split(",").map(Number);
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThan(1);
    expect(py).toBeGreaterThan(0);
    expect(py).toBeLessThan(1);
  });

  it("la timeline pilote : rz ajouté à la pose, les enfants suivent, retour au repos à 0", async () => {
    const el = await mount();
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    const rest = { ...nodes() };
    set("anim.nodes", { d_bras_gauche: { rz: 0.5 } });
    await Promise.resolve();
    const n = nodes();
    expect(n["bras-gauche"].rz).toBeCloseTo(0.5, 3);
    expect(n["avant-bras-gauche"].rz).toBeCloseTo(0.5, 3);
    expect(n["avant-bras-gauche"].x).not.toBeCloseTo(rest["avant-bras-gauche"].x, 1); // le coude a bougé
    expect(n["bras-gauche"].x).toBeCloseTo(rest["bras-gauche"].x, 3); // l'épaule non
    expect(n["bras-droit"].rz).toBe(0);
    set("anim.nodes", { d_bras_gauche: { rz: 0 } });
    await Promise.resolve();
    expect(nodes()["avant-bras-gauche"].x).toBeCloseTo(rest["avant-bras-gauche"].x, 3);
  });

  it("le bassin peut décaler tout le corps (x, y en unités de scène)", async () => {
    const el = await mount();
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    const x0 = nodes()["torse"].x;
    set("anim.nodes", { d_bassin: { x: 12, y: -6, rz: 0 } });
    await Promise.resolve();
    expect(nodes()["torse"].x).toBeCloseTo(x0 + 12, 2);
  });

  it("attend que la pose corresponde à l'image figée (frameSeq), puis mesure", async () => {
    const held = document.createElement("div");
    held.id = "held";
    Object.assign(held, { frameSeq: 7 });
    document.body.appendChild(held);
    const el = await mount({ frame: "#held", "timeout-ms": "100000" });
    set("app.hold", true);
    el.poll(performance.now() + 1000); // pose de l'image 5, image figée 7 : on attend
    expect(el.getPhase()).toBe("waiting");
    set("pz", { present: 1, frameSeq: 7, joints: JOINTS });
    el.poll(performance.now() + 1000);
    expect(el.getPhase()).toBe("ready");
  });

  it("passé le délai, utilise la dernière pose même sans correspondance", async () => {
    const held = document.createElement("div");
    held.id = "held";
    Object.assign(held, { frameSeq: 7 });
    document.body.appendChild(held);
    const el = await mount({ frame: "#held", "timeout-ms": "10" });
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    expect(el.getPhase()).toBe("ready");
  });

  it("refaire la photo (capture faux) efface pièces et nœuds", async () => {
    const el = await mount();
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    expect(sprites().length).toBeGreaterThan(3);
    set("app.hold", false);
    expect(el.getPhase()).toBe("idle");
    expect(sprites()).toEqual([]);
    expect(nodes()).toEqual({});
  });

  it("erreur lisible sans pose ou sans épaules", async () => {
    set("pz", { present: 0, frameSeq: 5, joints: JOINTS });
    const el = await mount();
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    expect(el.getPhase()).toBe("error");
    expect(status().error).toBe("pose");
    set("app.hold", false);
    set("pz", { present: 1, frameSeq: 5, joints: { nose: j(100, 40) } });
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    expect(status().error).toBe("corps");
  });

  it("calque des sprites : attribut layer", async () => {
    const el = await mount({ layer: "monde" });
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    expect(sprites().every((s) => s.layer === "monde")).toBe(true);
  });
});

describe("sonic-puppet : armature libre", () => {
  // Un quadrupède dessiné : points posés à la main, aucun tracker de pose.
  const CAT = {
    nuque: j(60, 100),
    croupe: j(150, 110),
    museau: j(30, 90),
    pataAvAttache: j(62, 140),
    pataAvPied: j(62, 190),
    pataArAttache: j(148, 145),
    pataArPied: j(150, 195),
    queueBout: j(190, 80),
  };
  const ARMATURE = JSON.stringify([
    { name: "corps", from: "croupe", to: "nuque", radius: 0.3, z: 1 },
    { name: "tete", parent: "corps", cap: "corps", from: "nuque", to: "museau", radius: 0.25, z: 2 },
    { name: "patte-av", parent: "corps", cap: "corps", from: "pataAvAttache", to: "pataAvPied", radius: 0.12, z: 0 },
    { name: "patte-ar", parent: "corps", cap: "corps", from: "pataArAttache", to: "pataArPied", radius: 0.12, z: 0 },
    { name: "queue", parent: "corps", from: "croupe", to: "queueBout", radius: 0.1, z: 0 },
  ]);

  it("découpe et anime une armature quelconque (animal), clés de pilotage dérivées des noms d'os", async () => {
    set("pz", { present: 1, frameSeq: 5, joints: CAT });
    const el = await mount({ armature: ARMATURE, unit: "nuque,croupe" });
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    expect(status().error ?? "").toBe("");
    const names = sprites().map((s) => s.name);
    for (const n of ["corps", "tete", "patte-av", "patte-ar"]) expect(names).toContain(n);
    const x0 = nodes()["patte-ar"].x;
    const root = nodes()["corps"].x;
    set("anim.nodes", { d_corps: { rz: 0.4 } });
    await Promise.resolve();
    expect(nodes()["tete"].rz).toBeCloseTo(0.4, 3); // les enfants suivent
    expect(nodes()["patte-ar"].x).not.toBeCloseTo(x0, 1);
    expect(nodes()["corps"].x).toBeCloseTo(root, 3); // la racine de la chaîne reste sur son articulation
  });

  it("armature illisible ou sans unité de mesure : erreur explicite, rien de publié", async () => {
    set("pz", { present: 1, frameSeq: 5, joints: CAT });
    const bad = await mount({ armature: "{pas du json", unit: "nuque,croupe" });
    set("app.hold", true);
    bad.poll(performance.now() + 1000);
    expect(status().phase).toBe("error");
    expect(status().error).toBe("armature");
    document.body.innerHTML = "";
    set("app.hold", false);
    const noUnit = await mount({ armature: ARMATURE });
    set("app.hold", true);
    noUnit.poll(performance.now() + 1000);
    expect(status().error).toBe("corps");
  });
});

describe("sonic-puppet : mode skin (déformation pondérée)", () => {
  type Frame = { x: number; y: number; x2: number; y2: number; angle: number; length: number; radius?: number; rz?: number };
  const rest = () => dp("rig.rest").get() as Record<string, Frame>;
  const bones = () => dp("rig.bones").get() as Record<string, Frame>;

  it("publie la pose de repos mesurée et la pose courante au format sonic-skeleton, sans pièces", async () => {
    const el = await mount({ mode: "skin" });
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    expect(el.getPhase()).toBe("ready");
    expect(sprites()).toEqual([]);
    const s = Math.min(800 / W, 600 / H);
    const ox = (800 - W * s) / 2;
    const r = rest();
    expect(Object.keys(r)).toContain("bras-gauche");
    expect(Object.keys(r)).not.toContain("bassin"); // racine sans segment
    expect(r["bras-gauche"].x).toBeCloseTo(ox + 70 * s, 1); // épaule gauche mesurée (70, 90)
    expect(r["bras-gauche"].y).toBeCloseTo(90 * s, 1);
    expect(r["bras-gauche"].x2).toBeCloseTo(ox + 60 * s, 1); // coude (60, 140)
    expect(r["bras-gauche"].radius).toBeGreaterThan(0);
    // l'os pointe vers le bas : angle ~ 0 (légèrement penché vers l'extérieur)
    expect(Math.abs(r["bras-gauche"].angle)).toBeLessThan(15);
    expect(dp("rig.present").get()).toBe(1);
    expect(bones()["bras-gauche"].x).toBeCloseTo(r["bras-gauche"].x, 3); // pas d'animation : courant = repos
    expect(bones()["bras-gauche"].angle).toBeCloseTo(r["bras-gauche"].angle, 1);
  });

  it("la timeline fait tourner les os : angle courant = repos + rz, les enfants suivent, le repos ne change pas", async () => {
    const el = await mount({ mode: "skin" });
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    const r0 = JSON.parse(JSON.stringify(rest()));
    set("anim.nodes", { d_bras_gauche: { rz: 0.5 } });
    await Promise.resolve();
    const b = bones();
    const dAngle = ((b["bras-gauche"].angle - r0["bras-gauche"].angle + 540) % 360) - 180;
    expect(dAngle).toBeCloseTo((0.5 * 180) / Math.PI, 1);
    expect(b["avant-bras-gauche"].x).not.toBeCloseTo(r0["avant-bras-gauche"].x, 1);
    expect(b["bras-gauche"].x).toBeCloseTo(r0["bras-gauche"].x, 3);
    expect(rest()["avant-bras-gauche"].x).toBeCloseTo(r0["avant-bras-gauche"].x, 3);
    // la longueur des os se conserve
    expect(b["avant-bras-gauche"].length).toBeCloseTo(r0["avant-bras-gauche"].length, 3);
    expect(Math.hypot(b["bras-gauche"].x2 - b["bras-gauche"].x, b["bras-gauche"].y2 - b["bras-gauche"].y)).toBeCloseTo(r0["bras-gauche"].length, 1);
  });

  it("refaire la photo efface repos et os", async () => {
    const el = await mount({ mode: "skin" });
    set("app.hold", true);
    el.poll(performance.now() + 1000);
    set("app.hold", false);
    await Promise.resolve();
    expect(rest()).toEqual({});
    expect(bones()).toEqual({});
    expect(dp("rig.present").get()).toBe(0);
  });
});

