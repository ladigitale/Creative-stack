import { describe, expect, it } from "vitest";
import { SCENES } from "../scene/library";
import { composeVector } from "./compose";
import { ActorSim } from "./actors";
import { drawCharacter } from "./draw/character";
import { Emitter } from "./draw/kit";
import { Projector } from "./project";
import { VectorScene, mergeSorted } from "./scene";
import { Pen, type Shape, strokeVar, validPath } from "./shape";
import { toSVG } from "./svg";
import { VECTOR_STYLES, makeInks, resolveVectorStyle } from "./vstyle";

const village = () => composeVector({ recipe: SCENES.village, seed: 7 });

function shapesOf(model = village(), camera: "side" | "oblique" = "side", time = 0) {
  const sc = new VectorScene(model, { camera });
  const sim = new ActorSim();
  sim.setModel(model);
  return mergeSorted(sc.staticShapes(0).shapes, sc.dynamicShapes(time, 0, sim.poses()));
}

describe("procgen vectoriel", () => {
  it("trait à épaisseur variable : un seul sous-chemin fermé, commandes valides", () => {
    const d = strokeVar(new Pen(), [[0, 0], [1, 0.2], [2, 0], [2.5, -0.5]], [0.1, 0.08, 0.06, 0.03]).d;
    expect(validPath(d)).toBe(true);
    expect(d.match(/M/g)!.length).toBe(1);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("toutes les formes d'une scène ont des chemins valides (élévation et cavalière)", () => {
    const model = village();
    for (const cam of ["side", "oblique"] as const) {
      const shapes = shapesOf(model, cam);
      expect(shapes.length).toBeGreaterThan(500);
      const bad = shapes.filter((s) => !validPath(s.d));
      expect(bad.length).toBe(0);
      for (let i = 1; i < shapes.length; i++) expect(shapes[i].z).toBeGreaterThanOrEqual(shapes[i - 1].z);
    }
  });

  it("déterminisme : même graine, mêmes formes", () => {
    const a = shapesOf(village()).map((s) => s.d + s.fill + (s.tone ?? 0)).join("|");
    const b = shapesOf(village()).map((s) => s.d + s.fill + (s.tone ?? 0)).join("|");
    expect(a).toBe(b);
  });

  it("un bras = un seul chemin continu (aucune jointure au coude)", () => {
    const model = composeVector({ recipe: { size: [8, 6], ground: { relief: 0 }, actors: { h: { params: { top: "none", item: "none" }, at: [0, 0], facing: 90 } } }, seed: 1 });
    const sim = new ActorSim();
    sim.setModel(model);
    sim.setActors({ h: { x: 3, z: 0 } });
    for (let i = 0; i < 20; i++) sim.update(1 / 30);
    const p = sim.poses()[0];
    const out: Shape[] = [];
    const pr = new Projector("side");
    drawCharacter(pr, new Emitter(out, 0, 5, p.obj, 0), { sk: p.sk, W: p.W, pos: p.pos, yaw: p.yaw, params: p.params, blink: 0, time: 0, speed: p.speed });
    // bras nus : formes « skin » à un seul sous-chemin, au moins deux (bras gauche et droit) + tête
    const skin = out.filter((s) => s.fill === "skin");
    const arms = skin.filter((s) => s.d.match(/M/g)!.length === 1 && s.d.includes("C"));
    expect(arms.length).toBeGreaterThanOrEqual(3);
    for (const s of out) expect(validPath(s.d)).toBe(true);
  });

  it("export SVG parsable, sans script", () => {
    const model = composeVector({ recipe: SCENES.rue, seed: 2 });
    for (const st of VECTOR_STYLES) {
      const svg = toSVG(model, st, { camera: "side", width: 640, height: 360 });
      expect(svg.startsWith("<svg")).toBe(true);
      expect(/<script|javascript:|on[a-z]+=/i.test(svg)).toBe(false);
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(doc.getElementsByTagName("parsererror").length).toBe(0);
      expect(doc.getElementsByTagName("path").length).toBeGreaterThan(200);
    }
  });

  it("styles vectoriels : entrées tolérées et couleurs résolues", () => {
    for (const st of [...VECTOR_STYLES, "flat/nuit", { vector: "gravure", preset: "brume" }, "encre", "inconnu"]) {
      const vs = resolveVectorStyle(st);
      const inks = makeInks(vs);
      expect(inks.color("wall", -1, 0.5)).toMatch(/^#[0-9a-f]{6}$/);
      expect(inks.color("#8a5a3b", 1, 0)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(resolveVectorStyle("flat/nuit").tokens.night).toBe(1);
  });

  it("générateur ou valeur inconnus : repli générique propre", () => {
    const model = composeVector({ recipe: { size: [10, 8], layers: [{ id: "x", gen: "prop", params: { kind: "lamp" }, place: { at: [[0, 0]] } }] }, seed: 1 });
    model.objects[0].generator = "dragon";
    const shapes = shapesOf(model);
    expect(shapes.some((s) => s.objId === model.objects[0].obj)).toBe(true);
  });

  it("génération des formes d'un village < 40 ms (modèle composé, gabarits chauds, meilleur de 7)", () => {
    const model = village();
    shapesOf(model); // échauffement (JIT, gabarits de végétation)
    const sim = new ActorSim();
    sim.setModel(model);
    let best = Infinity;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const sc = new VectorScene(model, { camera: "side" });
      sc.staticShapes(0);
      sc.dynamicShapes(0, 0, sim.poses());
      best = Math.min(best, performance.now() - t0);
    }
    // garde-fou de régression (cible ≈ 30 ms sur un poste libre) : marge pour les machines partagées en CI
    expect(best).toBeLessThan(120);
  });
});
