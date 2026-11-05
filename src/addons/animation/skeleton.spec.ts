import { afterEach, describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { HUMAN_PRESET, SonicSkeleton, parseAim, parseBone } from "./skeleton";

void SonicSkeleton;

type Nodes = Record<string, { x: number; y: number; rz: number; ease?: { ms: number; curve: string } }>;
const nodesOf = (id: string) => dp(`${id}.nodes`).get() as Nodes;
const bonesOf = (id: string) => dp(`${id}.bones`).get() as Record<string, { x: number; y: number; x2: number; y2: number; angle: number; length: number }>;

async function mount(attrs: Record<string, string>, bones: Array<Record<string, string>> = []) {
  const el = document.createElement("sonic-skeleton") as SonicSkeleton;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const b of bones) {
    const be = document.createElement("sonic-bone");
    for (const [k, v] of Object.entries(b)) be.setAttribute(k, v);
    el.appendChild(be);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  await Promise.resolve();
  return el;
}

type J = [number, number, number?];
/** Sortie de tracker de pose minimale : `joints.<nom> = {x, y, v}`. */
const pose = (joints: Record<string, J>, present = 1) => ({
  present,
  joints: Object.fromEntries(Object.entries(joints).map(([k, [x, y, v]]) => [k, { x, y, z: 0, v: v ?? 1 }])),
});
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("parseAim / parseBone", () => {
  it("alternatives, groupes, syntaxe invalide ignorée", () => {
    expect(parseAim("a>b")).toEqual([[["a"], ["b"]]]);
    expect(parseAim(" a + b > c | d>e ")).toEqual([[["a", "b"], ["c"]], [["d"], ["e"]]]);
    expect(parseAim("a>b>c")).toEqual([]);
    expect(parseAim("a>")).toEqual([]);
    expect(parseAim(undefined)).toEqual([]);
  });
  it("valeurs par défaut, noms attachés, os sans nom", () => {
    const { config } = parseBone({ name: "b", attach: "x, y b", length: "abc" });
    expect(config).toMatchObject({ nodes: ["b", "x", "y"], spec: { length: 100, angle: 0, at: 1, offset: 0, parent: null } });
    expect(parseBone({ length: "3" }).error).toContain("sans nom");
  });
});

describe("sonic-skeleton : os déclarés", () => {
  it("repos : un nœud par os (x, y, rz = 0) et l'état des os", async () => {
    const el = await mount({ "nodes-out": "rig1", x: "200", y: "50" }, [{ name: "haut", length: "100" }, { name: "bas", parent: "haut", length: "80" }]);
    expect(el.getState()).toMatchObject({ bones: ["haut", "bas"], errors: [], present: 0 });
    expect(nodesOf("rig1")).toEqual({ haut: { x: 200, y: 50, rz: 0 }, bas: { x: 200, y: 150, rz: 0 } });
    expect(bonesOf("rig1").bas).toMatchObject({ x2: 200, y2: 230, length: 80 });
    expect(dp("rig1.present").get()).toBe(0);
  });

  it("angle-from : valeur d'un DataProvider → rotation (échelle, décalage) ; republié seulement si elle change", async () => {
    set("ctl", 0);
    const el = await mount({ "nodes-out": "rig2", x: "0", y: "0" }, [{ name: "a", length: "100", "angle-from": "ctl", "angle-scale": "2", "angle-offset": "10" }]);
    set("ctl", 40); // 40 × 2 + 10 = 90°
    await flush();
    expect(nodesOf("rig2").a.rz).toBeCloseTo(Math.PI / 2, 4);
    expect(bonesOf("rig2").a.x2).toBeCloseTo(-100, 1);
    expect(el.getState().present).toBe(1);
    expect(el.solveAt(performance.now())).toBe(false); // rien n'a changé
    set("ctl", "pas un nombre");
    await flush();
    expect(nodesOf("rig2").a.rz).toBe(0); // valeur invalide : retour au repos
  });

  it("os attachés : plusieurs noms de nœuds pour un même os", async () => {
    await mount({ "nodes-out": "rig3", x: "5", y: "6" }, [{ name: "a", attach: "bras gant" }]);
    const n = nodesOf("rig3");
    expect(n.bras).toEqual(n.a);
    expect(n.gant).toEqual(n.a);
  });

  it("erreurs de déclaration publiées dans l'état, les autres os continuent", async () => {
    const el = await mount({ "nodes-out": "rig4" }, [{ name: "ok" }, { name: "ok" }, { name: "orphelin", parent: "absent" }, { name: "autre" }]);
    const st = el.getState();
    expect(st.bones).toEqual(["ok", "autre"]);
    expect(st.errors.join("|")).toContain('os "ok" déclaré deux fois');
    expect(st.errors.join("|")).toContain('parent "absent" inconnu');
    expect(Object.keys(nodesOf("rig4"))).toEqual(["ok", "autre"]);
  });

  it("les os ajoutés ou retirés dans le DOM sont pris en compte", async () => {
    const el = await mount({ "nodes-out": "rig5" }, [{ name: "a" }]);
    const b = document.createElement("sonic-bone");
    b.setAttribute("name", "b");
    el.appendChild(b);
    await flush();
    expect(el.getState().bones).toEqual(["a", "b"]);
    b.remove();
    await flush();
    expect(el.getState().bones).toEqual(["a"]);
  });

  it("sans nodes-out : rien n'est écrit", async () => {
    const el = await mount({}, [{ name: "a" }]);
    expect(el.solveAt(0)).toBe(false);
  });
});

describe("sonic-skeleton : pose", () => {
  const arm: Array<Record<string, string>> = [{ name: "bras", length: "100", aim: "leftShoulder>leftElbow" }, { name: "avant", parent: "bras", length: "80", aim: "leftElbow>leftWrist" }];

  it("aim : la direction mesurée (articulation → articulation) oriente l'os, l'enfant suit sa propre mesure", async () => {
    const el = await mount({ "nodes-out": "rig6", source: "pose6", aspect: "1", smooth: "0", x: "0", y: "0" }, arm);
    set("pose6", pose({ leftShoulder: [0.5, 0.5], leftElbow: [0.4, 0.5], leftWrist: [0.4, 0.6] }));
    await flush();
    const n = nodesOf("rig6");
    expect(n.bras.rz).toBeCloseTo(Math.PI / 2, 3); // vers la gauche de l'écran
    expect(n.avant.rz).toBeCloseTo(0, 3); // l'avant-bras pend
    expect(bonesOf("rig6").avant.angle).toBeCloseTo(0, 1);
    expect(el.getState().present).toBe(1);
  });

  it("aspect : une image 2:1 change l'angle d'un vecteur non vertical", async () => {
    await mount({ "nodes-out": "rig7", source: "pose7", aspect: "2", smooth: "0", x: "0", y: "0" }, arm.slice(0, 1));
    set("pose7", pose({ leftShoulder: [0.5, 0.5], leftElbow: [0.45, 0.55] }));
    await flush();
    // dx = -0,05 × 2 = -0,1 ; dy = 0,05 → angle ≈ 63,4° (45° si aspect 1)
    expect(nodesOf("rig7").bras.rz * (180 / Math.PI)).toBeCloseTo(63.43, 1);
  });

  it("articulation peu visible ou absente : l'os reste au repos ; present 0 si tout est perdu", async () => {
    const el = await mount({ "nodes-out": "rig8", source: "pose8", aspect: "1", smooth: "0", "min-visibility": "0.5" }, arm.slice(0, 1));
    set("pose8", pose({ leftShoulder: [0.5, 0.5], leftElbow: [0.4, 0.5, 0.2] }));
    await flush();
    expect(nodesOf("rig8").bras.rz).toBe(0);
    expect(el.getState().present).toBe(0);
    set("pose8", pose({}, 0)); // `present: 0`
    await flush();
    expect(el.getState().present).toBe(0);
  });

  it("perte : direction gardée hold-ms puis retour au repos, interpolé par le rendu (ease), pas republié ensuite", async () => {
    const el = await mount({ "nodes-out": "rig9", source: "pose9", aspect: "1", smooth: "0", "hold-ms": "500", "ease-ms": "250" }, arm.slice(0, 1));
    set("pose9", pose({ leftShoulder: [0.5, 0.5], leftElbow: [0.4, 0.5] }));
    await flush();
    const t0 = performance.now();
    set("pose9", pose({}, 0));
    await flush();
    el.solveAt(t0 + 100);
    expect(nodesOf("rig9").bras.rz).toBeCloseTo(Math.PI / 2, 3); // encore tenu
    expect(el.solveAt(t0 + 900)).toBe(true);
    const rest = nodesOf("rig9").bras;
    expect(rest.rz).toBe(0);
    expect(rest.ease).toEqual({ ms: 250, curve: "inOut" });
    expect(el.solveAt(t0 + 1200)).toBe(false); // inchangé : le rendu termine son interpolation
  });

  it("lissage : la direction n'est plus un saut", async () => {
    const el = await mount({ "nodes-out": "rig10", source: "pose10", aspect: "1", smooth: "0.9", x: "0", y: "0" }, arm.slice(0, 1));
    const t = performance.now();
    set("pose10", pose({ leftShoulder: [0.5, 0.5], leftElbow: [0.5, 0.6] }));
    await flush();
    el.solveAt(t + 33);
    set("pose10", pose({ leftShoulder: [0.5, 0.5], leftElbow: [0.4, 0.5] }));
    await flush();
    el.solveAt(t + 66);
    const a = Math.abs(bonesOf("rig10").bras.angle);
    expect(a).toBeGreaterThan(0.5);
    expect(a).toBeLessThan(89);
  });

  it("racine : suit le milieu des joints de root, étiré sur la scène", async () => {
    await mount({ "nodes-out": "rig11", source: "pose11", root: "leftHip+rightHip", width: "800", height: "400", smooth: "0", "hold-ms": "300" }, [{ name: "racine", length: "10" }]);
    set("pose11", pose({ leftHip: [0.4, 0.5], rightHip: [0.6, 0.5] }));
    await flush();
    expect(nodesOf("rig11").racine).toMatchObject({ x: 400, y: 200 });
  });
});

describe("sonic-skeleton : preset humain", () => {
  it("13 os, noms stables, hiérarchie valide", async () => {
    const el = await mount({ "nodes-out": "rigH1", preset: "humain" });
    const st = el.getState();
    expect(st.errors).toEqual([]);
    expect(st.bones).toHaveLength(HUMAN_PRESET.length);
    for (const n of ["bassin", "torse", "tete", "bras-gauche", "avant-bras-droit", "main-gauche", "cuisse-droite", "mollet-gauche"]) expect(st.bones).toContain(n);
  });

  it("repos : debout, bras et jambes pendants, tête au-dessus du torse, épaules de chaque côté", async () => {
    await mount({ "nodes-out": "rigH2", preset: "humain", x: "400", y: "300" });
    const b = bonesOf("rigH2");
    expect(b.bassin).toMatchObject({ x: 400, y: 300 });
    expect(b.torse.y2).toBeCloseTo(190, 1); // 300 - 110
    expect(b.tete.y2).toBeCloseTo(140, 1);
    expect(b["bras-gauche"].x).toBeLessThan(400); // épaule gauche = côté gauche de l'écran
    expect(b["bras-droit"].x).toBeGreaterThan(400);
    expect(b["bras-gauche"].y).toBeCloseTo(190, 1);
    expect(b["bras-gauche"].y2).toBeGreaterThan(b["bras-gauche"].y); // pend
    expect(b["cuisse-gauche"].x).toBeLessThan(400);
    expect(b["mollet-gauche"].y2).toBeGreaterThan(b["cuisse-gauche"].y2);
    for (const n of Object.values(nodesOf("rigH2"))) expect(n.rz).toBe(0);
  });

  it("branché sur une pose : la racine suit les hanches, le bras levé tourne, le reste au repos", async () => {
    const el = await mount({ "nodes-out": "rigH3", preset: "humain", source: "poseH3", aspect: "1", width: "800", height: "450", smooth: "0" });
    set(
      "poseH3",
      pose({
        leftHip: [0.45, 0.6],
        rightHip: [0.55, 0.6],
        leftShoulder: [0.43, 0.35],
        rightShoulder: [0.57, 0.35],
        leftElbow: [0.35, 0.28], // coude à gauche et plus haut que l'épaule
      }),
    );
    await flush();
    const n = nodesOf("rigH3");
    expect(n.bassin).toMatchObject({ x: 400, y: 270 });
    expect(n.torse.rz).toBeCloseTo(0, 3); // buste droit
    expect(Math.abs(n["bras-gauche"].rz)).toBeGreaterThan(1.5); // bras tendu côté gauche / levé
    expect(n["bras-droit"].rz).toBe(0); // pas de mesure pour ce bras
    expect(el.getState().present).toBe(1);
  });

  it("des enfants sonic-bone de même nom modifient le preset (longueur, limites, nouvel os)", async () => {
    const el = await mount({ "nodes-out": "rigH4", preset: "humain", x: "400", y: "300" }, [{ name: "torse", length: "150" }, { name: "chapeau", parent: "tete", length: "20", angle: "0" }]);
    const b = bonesOf("rigH4");
    expect(b.torse.length).toBe(150);
    expect(b.torse.y2).toBeCloseTo(150, 1);
    expect(b.tete.length).toBe(50); // le reste du preset est conservé
    expect(el.getState().bones).toContain("chapeau");
    expect(el.getState().errors).toEqual([]);
  });

  it("rest : pose de repos à la racine fixe, inchangée quand la racine suit une pose", async () => {
    const el = await mount({ "nodes-out": "rigR", preset: "humain", x: "100", y: "50", source: "poseR", width: "800", height: "450" });
    const rest = () => dp("rigR.rest").get() as Record<string, { x: number; y: number; angle: number; length: number }>;
    const first = JSON.parse(JSON.stringify(rest()));
    expect(Object.keys(first)).toHaveLength(HUMAN_PRESET.length);
    expect(first.bassin).toMatchObject({ x: 100, y: 50 });
    set("poseR", pose({ leftHip: [0.5, 0.6], rightHip: [0.5, 0.6] }));
    await flush();
    el.solveAt(performance.now());
    expect(bonesOf("rigR").bassin).toMatchObject({ x: 400, y: 270 });
    expect(rest()).toEqual(first);
  });

  it("scale : tout le squelette, décalages compris", async () => {
    await mount({ "nodes-out": "rigH5", preset: "humain", x: "0", y: "0", scale: "2" });
    expect(bonesOf("rigH5").torse.length).toBe(220);
  });

  it("preset inconnu : erreur lisible, os du DOM conservés", async () => {
    const el = await mount({ "nodes-out": "rigH6", preset: "chat" }, [{ name: "a" }]);
    expect(el.getState().errors[0]).toContain('preset "chat" inconnu');
    expect(el.getState().bones).toEqual(["a"]);
  });
});

describe("sonic-skeleton : photo posable (fit, rest=pose, angle-add-from)", () => {
  const body = {
    leftHip: [0.45, 0.6],
    rightHip: [0.55, 0.6],
    leftShoulder: [0.43, 0.35],
    rightShoulder: [0.57, 0.35],
    leftElbow: [0.40, 0.5], // bras légèrement écarté, vers le bas
    leftWrist: [0.38, 0.62],
  } as Record<string, J>;
  const attrs = (id: string, extra: Record<string, string> = {}) => ({
    "nodes-out": id, preset: "humain", source: `pose_${id}`, aspect: "1", width: "800", height: "450", smooth: "0", ...extra,
  });
  const restOf = (id: string) => dp(`${id}.rest`).get() as Record<string, { x: number; y: number; x2: number; y2: number; angle: number; length: number }>;

  it("fit : l'échelle suit la longueur mesurée du torse (hanches → épaules)", async () => {
    await mount(attrs("rigF1", { fit: "true" }));
    set("pose_rigF1", pose(body));
    await flush();
    const torso = Math.hypot(0, (0.6 - 0.35) * 450); // 112.5 unités
    expect(bonesOf("rigF1").torse.length).toBeCloseTo(torso, 1);
    expect(bonesOf("rigF1")["bras-gauche"].length).toBeCloseTo((65 * torso) / 110, 1); // les autres os suivent
  });

  it("rest=pose : le repos publié est la pose mesurée, pas le repos du preset", async () => {
    await mount(attrs("rigF2", { rest: "pose", fit: "true" }));
    set("pose_rigF2", pose(body));
    await flush();
    const r = restOf("rigF2");
    expect(r.bassin).toMatchObject({ x: 400, y: 270 });
    expect(r["bras-gauche"].angle).not.toBeCloseTo(180, 0); // le bras mesuré n'est pas vertical
    expect(r["bras-gauche"].angle).toBeCloseTo(bonesOf("rigF2")["bras-gauche"].angle, 1); // = pose courante (aucun ajout)
  });

  it("angle-add-from : rotation ajoutée par-dessus la pose mesurée ; le rest reste la pose mesurée", async () => {
    set("ajout", 0);
    await mount(attrs("rigF3", { rest: "pose", fit: "true" }), [{ name: "bras-gauche", "angle-add-from": "ajout" }]);
    set("pose_rigF3", pose(body));
    await flush();
    const before = bonesOf("rigF3")["bras-gauche"].angle;
    const restBefore = JSON.parse(JSON.stringify(restOf("rigF3")));
    set("ajout", 30);
    await flush();
    const after = bonesOf("rigF3")["bras-gauche"].angle;
    let diff = after - before;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    expect(diff).toBeCloseTo(30, 0);
    expect(restOf("rigF3")).toEqual(restBefore);
  });

  it("angle-add-from : les enfants suivent le parent qui tourne", async () => {
    set("ajout2", 0);
    await mount(attrs("rigF4", { rest: "pose", fit: "true" }), [{ name: "bras-gauche", "angle-add-from": "ajout2" }]);
    set("pose_rigF4", pose(body));
    await flush();
    const f0 = bonesOf("rigF4")["avant-bras-gauche"];
    set("ajout2", 25);
    await flush();
    const f1 = bonesOf("rigF4")["avant-bras-gauche"];
    expect(f1.x).not.toBeCloseTo(f0.x, 0); // l'origine de l'avant-bras (coude) a bougé avec le bras
    const bras = bonesOf("rigF4")["bras-gauche"];
    expect(f1.x).toBeCloseTo(bras.x2, 1); // il reste attaché au bout du bras
    expect(f1.y).toBeCloseTo(bras.y2, 1);
  });

  it("pose figée : le repos et l'échelle restent ceux de la dernière mesure", async () => {
    await mount(attrs("rigF5", { rest: "pose", fit: "true", "hold-ms": "0" }));
    set("pose_rigF5", pose(body));
    await flush();
    const rest = JSON.parse(JSON.stringify(restOf("rigF5")));
    set("pose_rigF5", pose({}, 0)); // plus de mesure
    await flush();
    expect(restOf("rigF5")).toEqual(rest);
  });
});

describe("exemple marionnette", () => {
  type N = { tagName: string; attributes?: Record<string, string>; nodes?: N[] };
  it("chaque sprite porte le nom d'un os du preset ; le squelette écrit là où sonic-2d lit", async () => {
    const doc = (await import("./examples/marionnette.sdui.json")).default as unknown as { nodes: N[] };
    const all: N[] = [];
    const walk = (x: { nodes?: N[] }) => (x.nodes ?? []).forEach((c) => (all.push(c), walk(c)));
    walk(doc);
    const bones = new Set(HUMAN_PRESET.map((b) => b.name));
    const sprites = all.filter((n) => n.tagName === "sonic-sprite").map((n) => n.attributes!.name);
    expect(sprites.length).toBe(bones.size);
    for (const s of sprites) expect(bones.has(s), s).toBe(true);
    const skeleton = all.find((n) => n.tagName === "sonic-skeleton")!.attributes!;
    const scene = all.find((n) => n.tagName === "sonic-2d")!.attributes!;
    expect(scene.dataProvider).toBe(skeleton["nodes-out"]);
    expect(skeleton.source).toBe(all.find((n) => n.tagName === "sonic-pose-tracker")!.attributes!.id);
    for (const sp of all.filter((n) => n.tagName === "sonic-sprite")) expect(sp.attributes!.pivot, sp.attributes!.name).toMatch(/^[\d.]+,[\d.]+$/);
  });
});

describe("exemple bras souple", () => {
  type N = { tagName: string; attributes?: Record<string, string>; nodes?: N[] };
  it("un maillage lié aux os déclarés : le squelette écrit rest et bones là où sonic-2d lit", async () => {
    const doc = (await import("./examples/bras-souple.sdui.json")).default as unknown as { nodes: N[] };
    const all: N[] = [];
    const walk = (x: { nodes?: N[] }) => (x.nodes ?? []).forEach((c) => (all.push(c), walk(c)));
    walk(doc);
    const skeleton = all.find((n) => n.tagName === "sonic-skeleton")!;
    const scene = all.find((n) => n.tagName === "sonic-2d")!.attributes!;
    expect(scene.dataProvider).toBe(skeleton.attributes!["nodes-out"]);
    const mesh = all.find((n) => n.tagName === "sonic-sprite")!.attributes!;
    expect(mesh.shape).toBe("mesh");
    expect(mesh.src).toMatch(/^data:image\/svg\+xml;base64,/);
    const el = await mount(skeleton.attributes!, (skeleton.nodes ?? []).map((b) => b.attributes!));
    expect(el.getState().errors).toEqual([]);
    expect(Object.keys(dp("rig.rest").get() as object)).toEqual(["epaule", "coude"]);
    // les sliders écrivent là où angle-from lit
    for (const b of skeleton.nodes!) expect(b.attributes!["angle-from"]).toMatch(/^bras\./);
    for (const i of all.filter((n) => n.tagName === "sonic-input")) expect(i.attributes!.formDataProvider).toBe("bras");
  });
});
