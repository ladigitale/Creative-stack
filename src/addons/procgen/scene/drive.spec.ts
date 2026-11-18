import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { m4Point } from "../core/math";
import { GENERATORS } from "../gen/index";
import { jointChain, posedAll } from "../gen/joints";
import { vehiclePartsModel } from "../gen/vehicle-parts";
import { partsBounds } from "../gen/parts";
import { motionFor } from "../rig/motion";
import { composeScene, type Recipe } from "./compose";
import { NavGrid } from "./nav";
import { DRIVE_AFFORDS, ObstacleSet, doorFor, followRoute, newDriveState, newRoute, obbOverlap, obstaclesOf, planRoute, roadRoute, seatFor, seatNames, sideApproach, stepDrive, steerPartValue, vehicleSpecOf, wheelPartValue } from "./drive";
import type { PathSpec } from "./terrain";

const build = (gen: string, params: Record<string, unknown>, seed = "s") => {
  const g = GENERATORS[gen];
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(1), vars: {} }, issues, "");
  return g.build(p as never, { rng: new Rng(seed), issues, path: "" });
};
const spec = (kind: string, scale = 1) => {
  const a = build("vehicle", { kind, variant: 0 });
  return vehicleSpecOf({ generator: "vehicle", params: { kind }, footprint: a.footprint, scale })!;
};
const run = (n: number, f: () => void) => {
  for (let i = 0; i < n; i++) f();
};

describe("conduite : gabarits, places, portières", () => {
  it("véhicules conduits et montures ; le wagon et le chien ne se conduisent pas", () => {
    for (const k of ["moderncar", "van", "bus", "truck", "tractor", "car", "carriage", "bicycle", "handcart", "rowboat", "sailboat", "balloon", "locomotive"]) expect(spec(k), k).toBeTruthy();
    expect(spec("rowboat").medium).toBe("water");
    expect(spec("locomotive").medium).toBe("rails");
    expect(spec("balloon").medium).toBe("air");
    expect(spec("moderncar").doors).toBe(true);
    expect(spec("bicycle").doors).toBe(false);
    expect(vehicleSpecOf({ generator: "vehicle", params: { kind: "wagon" }, footprint: { hx: 1, hz: 5, r: 5 }, scale: 1 })).toBeNull();
    expect(vehicleSpecOf({ generator: "animal", params: { species: "horse" }, footprint: { hx: 0.3, hz: 1.1, r: 1.1 }, scale: 1 })!.mount).toBe(true);
    expect(vehicleSpecOf({ generator: "animal", params: { species: "dog" }, footprint: { hx: 0.2, hz: 0.4, r: 0.4 }, scale: 1 })).toBeNull();
    // l'échelle agrandit l'empattement
    expect(spec("moderncar", 2).wheelbase).toBeCloseTo(spec("moderncar").wheelbase * 2);
  });

  it("places : conducteur d'abord, rangs, nom d'ancre ; portière la plus proche du même côté", () => {
    const car = build("vehicle", { kind: "moderncar", variant: 0 });
    const names = seatNames(Object.keys(car.anchors));
    expect(names).toEqual(["seat.driver", "seat.0", "seat.1", "seat.2"]);
    expect(seatFor("driver", names)).toBe("seat.driver");
    expect(seatFor(undefined, names)).toBe("seat.driver");
    expect(seatFor(1, names)).toBe("seat.1");
    expect(seatFor("seat.2", names)).toBe("seat.2");
    expect(seatFor(9, names)).toBeNull();
    const loc = Object.fromEntries(Object.entries(car.anchors).map(([k, a]) => [k, a.pos as [number, number, number]]));
    const parts = car.joints!.map((j) => j.name);
    expect(doorFor(loc["seat.driver"], loc, parts)!.door).toBe("door.fl");
    expect(doorFor(loc["seat.0"], loc, parts)!.door).toBe("door.fr");
    expect(doorFor(loc["seat.1"], loc, parts)!.door).toBe("door.rl");
    expect(doorFor(loc["seat.2"], loc, parts)!.door).toBe("door.rr");
    // sans portière : on monte à côté de la place, du côté d'où l'on vient
    const bike = build("vehicle", { kind: "bicycle", variant: 0 });
    expect(seatNames(Object.keys(bike.anchors))).toEqual(["seat.driver"]);
    expect(doorFor(bike.anchors["seat.driver"].pos as [number, number, number], {}, [])).toBeNull();
    expect(sideApproach([0, 0.9, -0.2], 0.3, [-3, 0])[0]).toBeLessThan(-0.5);
    // toutes les sortes conduites ont une place de conducteur
    for (const k of ["moderncar", "van", "bus", "truck", "tractor", "car", "carriage", "bicycle", "handcart", "rowboat", "sailboat", "balloon", "locomotive"]) expect(seatNames(Object.keys(build("vehicle", { kind: k, variant: 0 }).anchors))[0], k).toMatch(/^seat\.driver$/);
  });

  it("montures : ancre `seat.rider` sur le dos du cheval, à hauteur de garrot ; affords board et drive publiés", () => {
    const horse = build("animal", { species: "horse" });
    const seat = horse.anchors["seat.rider"];
    expect(seat).toBeTruthy();
    expect(seat.pos[1]).toBeGreaterThan(horse.height * 0.5);
    expect(seat.pos[1]).toBeLessThan(horse.height);
    expect(build("animal", { species: "dog" }).anchors["seat.rider"]).toBeUndefined();
    const recipe: Recipe = { size: [20, 20], ground: { relief: 0 }, layers: [{ id: "autos", gen: "vehicle", params: { kind: "moderncar" }, place: { at: [[0, 0]] } }], actors: { cheval: { gen: "animal", params: { species: "horse" }, at: [5, 5] } } };
    const m = composeScene({ recipe, seed: 1 });
    const car = m.objects.find((o) => o.id === "autos.0")!;
    expect(car.affords).toEqual(expect.arrayContaining(DRIVE_AFFORDS));
    expect(m.objects.find((o) => o.id === "cheval")!.affords).toEqual(expect.arrayContaining(DRIVE_AFFORDS));
    // le véhicule est un obstacle mobile de la grille (déplaçable sans recomposer)
    expect(m.nav!.free(0, 0)).toBe(false);
    m.nav!.dynClear("autos.0");
    expect(m.nav!.free(0, 0)).toBe(true);
    m.nav!.dynBox("autos.0", 5, -5, car.footprint.hx, car.footprint.hz, 0);
    expect(m.nav!.free(5, -5)).toBe(false);
  });
});

describe("conduite : braquage des roues avant (parties imbriquées)", () => {
  it("steer.f* parent de wheel.0.* : la roue braquée tourne aussi sur son axe", () => {
    const vm = vehiclePartsModel({ kind: "moderncar", variant: 0 });
    const J = vm.joints;
    const wl = J.find((j) => j.name === "wheel.0.l")!;
    expect(wl.parent).toBe("steer.fl");
    const st = J.find((j) => j.name === "steer.fl")!;
    expect(st.initial).toBe(0.5);
    // point avant de la roue gauche : braquée à gauche (valeur > 0,5), il part vers +x
    const front: [number, number, number] = [wl.pivot[0], wl.pivot[1], wl.pivot[2] + 0.3];
    const at = (steer: number, spin = 0) => m4Point(jointChain(J, wl, (n) => (n === "steer.fl" ? steer : n === wl.name ? spin : 0)), front);
    expect(at(0.5)[0]).toBeCloseTo(front[0], 5);
    expect(at(1)[0]).toBeGreaterThan(front[0] + 0.1);
    expect(at(0)[0]).toBeLessThan(front[0] - 0.1);
    // la rotation de la roue reste autour de son centre, même braquée
    const c = m4Point(jointChain(J, wl, (n) => (n === "steer.fl" ? 1 : 0.25)), wl.pivot);
    expect(Math.hypot(c[0] - wl.pivot[0], c[2] - wl.pivot[2])).toBeLessThan(1e-6);
    // vectoriel : la roue braquée dépasse un peu de la caisse
    const w0 = partsBounds(posedAll(J.filter((j) => j.name.startsWith("wheel.0") || j.name.startsWith("steer")), { "steer.fl": 0.5, "steer.fr": 0.5 }));
    const w1 = partsBounds(posedAll(J.filter((j) => j.name.startsWith("wheel.0") || j.name.startsWith("steer")), { "steer.fl": 1, "steer.fr": 1 }));
    expect(w1.max[0]).toBeGreaterThan(w0.max[0]);
    // valeurs pilotées par la conduite
    expect(steerPartValue(0)).toBe(0.5);
    expect(steerPartValue(0.3)).toBeLessThan(0.5);
    expect(wheelPartValue(2 * Math.PI * 0.33 * 2.25, 0.33)).toBeCloseTo(0.25);
  });

  it("vans, bus, camions et tracteurs braquent aussi ; les autres essieux tournent d'un bloc", () => {
    for (const kind of ["van", "bus", "truck", "tractor"]) {
      const names = vehiclePartsModel({ kind, variant: 0 }).joints.map((j) => j.name);
      expect(names, kind).toEqual(expect.arrayContaining(["steer.fl", "steer.fr", "wheel.0.l", "wheel.0.r", "wheel.1"]));
    }
  });
});

describe("conduite : modèle bicyclette et commande directe", () => {
  it("accélère, freine en douceur, recule, ne dépasse pas sa vitesse", () => {
    const sp = spec("moderncar");
    const s = newDriveState(0, 0, 0);
    run(60, () => stepDrive(sp, s, { throttle: 1, steer: 0, brake: 0 }, 1 / 30));
    expect(s.speed).toBeGreaterThan(5);
    expect(s.speed).toBeLessThan(sp.maxSpeed + 1e-6);
    expect(s.z).toBeGreaterThan(2);
    expect(Math.abs(s.x)).toBeLessThan(1e-6);
    run(200, () => stepDrive(sp, s, { throttle: 1, steer: 0, brake: 0 }, 1 / 30));
    expect(s.speed).toBeCloseTo(sp.maxSpeed, 1);
    const v = s.speed;
    stepDrive(sp, s, { throttle: 0, steer: 0, brake: 1 }, 1 / 30);
    expect(s.speed).toBeLessThan(v);
    expect(s.speed).toBeGreaterThan(v - 1);
    run(200, () => stepDrive(sp, s, { throttle: 0, steer: 0, brake: 1 }, 1 / 30));
    expect(s.speed).toBe(0);
    run(90, () => stepDrive(sp, s, { throttle: -1, steer: 0, brake: 0 }, 1 / 30));
    expect(s.speed).toBeLessThan(0);
    expect(s.speed).toBeGreaterThanOrEqual(-sp.reverse - 1e-6);
  });

  it("braquage : `steer` > 0 tourne à droite (cap décroissant), rayon ≈ empattement / tan(braquage)", () => {
    const sp = spec("moderncar");
    const s = newDriveState(0, 0, 0);
    run(300, () => stepDrive(sp, s, { throttle: 0.3, steer: 1, brake: 0 }, 1 / 60));
    expect(s.yaw).toBeLessThan(-0.5);
    expect(s.x).toBeLessThan(0);
    expect(s.steer).toBeGreaterThan(0.2);
    // tourne à gauche
    const t = newDriveState(0, 0, 0);
    run(300, () => stepDrive(sp, t, { throttle: 0.3, steer: -1, brake: 0 }, 1 / 60));
    expect(t.yaw).toBeGreaterThan(0.5);
    expect(t.x).toBeGreaterThan(0);
    // les roues tournent avec la distance parcourue
    expect(t.dist).toBeGreaterThan(1);
  });

  it("collision : arrêt net contre l'emprise, l'obstacle est nommé", () => {
    const sp = spec("moderncar");
    const wall = new ObstacleSet([{ id: "maisons.0", x: 0, z: 8, hx: 4, hz: 1, yaw: 0 }]);
    const s = newDriveState(0, 0, 0);
    let hit: string | null = null;
    run(200, () => {
      const r = stepDrive(sp, s, { throttle: 1, steer: 0, brake: 0 }, 1 / 30, (x, z, yaw) => wall.hit({ x, z, hx: sp.hx, hz: sp.hz, yaw }));
      hit ||= r.hit;
    });
    expect(hit).toBe("maisons.0");
    expect(s.speed).toBe(0);
    expect(s.z + sp.hz).toBeLessThanOrEqual(7.05);
    expect(s.z + sp.hz).toBeGreaterThan(6);
    expect(obbOverlap({ x: 0, z: 0, hx: 1, hz: 2, yaw: 0.4 }, { x: 1.5, z: 1.5, hx: 0.3, hz: 0.3, yaw: 0 })).toBe(true);
    expect(obbOverlap({ x: 0, z: 0, hx: 1, hz: 2, yaw: 0 }, { x: 3, z: 0, hx: 0.5, hz: 0.5, yaw: 0.7 })).toBe(false);
  });

  it("emprises : bâtiments, tronçons de clôture, pas l'herbe ni les ballons ; les arbres par leur tronc", () => {
    const recipe: Recipe = { size: [30, 20], ground: { relief: 0 }, layers: [
      { id: "maisons", gen: "building", place: { at: [[0, 6]] }, params: { floors: 1 } },
      { id: "herbes", gen: "grass", place: { at: [[3, 0]] } },
      { id: "ballons", gen: "ball.soccer", place: { at: [[-3, 0]] } },
      { id: "arbres", gen: "tree", place: { at: [[-8, -5]] } },
    ] };
    const m = composeScene({ recipe, seed: 2 });
    const obs = obstaclesOf(m.objects);
    expect(obs.some((o) => o.id === "maisons.0")).toBe(true);
    expect(obs.some((o) => o.id.startsWith("herbes") || o.id.startsWith("ballons"))).toBe(false);
    const tree = obs.find((o) => o.id === "arbres.0")!;
    expect(tree.hx).toBeLessThanOrEqual(0.31);
  });
});

describe("conduite : itinéraire et arrivée", () => {
  it("vers une cible : suit l'itinéraire, freine en douceur, s'arrête dans le rayon d'arrivée", () => {
    const sp = spec("moderncar");
    const s = newDriveState(0, 0, 0);
    const r = newRoute([[0, 0], [0, 20], [15, 25]], 1, 8);
    let done = false, t = 0, maxDecel = 0, prev = 0;
    for (; t < 40 && !done; t += 1 / 30) {
      const f = followRoute(sp, s, r, 1 / 30);
      done = f.done;
      stepDrive(sp, s, f.input, 1 / 30);
      maxDecel = Math.max(maxDecel, (prev - s.speed) * 30);
      prev = s.speed;
    }
    expect(done).toBe(true);
    expect(Math.hypot(s.x - 15, s.z - 25)).toBeLessThan(2.5);
    expect(maxDecel).toBeLessThan(sp.brake + 1);
    expect(Math.abs(s.speed)).toBeLessThan(0.4);
  });

  it("cible derrière : manœuvre (marche arrière) puis arrivée", () => {
    const sp = spec("moderncar");
    const s = newDriveState(0, 0, 0);
    const r = newRoute([[0, 0], [1, -6]], 1, 5);
    let done = false, backed = false;
    for (let t = 0; t < 60 && !done; t += 1 / 30) {
      const f = followRoute(sp, s, r, 1 / 30);
      done = f.done;
      if (f.input.throttle < 0) backed = true;
      stepDrive(sp, s, f.input, 1 / 30);
    }
    expect(backed).toBe(true);
    expect(done).toBe(true);
  });

  it("routes de la recette : l'itinéraire emprunte le réseau quand il rapproche ; sinon la grille élargie", () => {
    const roads: PathSpec[] = [
      { id: "r1", kind: "road", width: 4, sidewalk: 0, points: [[-40, 0], [40, 0]] },
      { id: "r2", kind: "road", width: 4, sidewalk: 0, points: [[30, 0], [30, 40]] },
      { id: "sentier", kind: "path", width: 1.2, sidewalk: 0, points: [[-40, 2], [30, 38]] },
    ];
    const rr = roadRoute(roads, [-38, 1], [29, 38], 2)!;
    expect(rr.pts.some(([x, z]) => Math.abs(x - 30) < 0.5 && z > 10 && z < 30)).toBe(true);
    // le vélo peut prendre le sentier (plus court), pas la voiture
    const sp = spec("moderncar");
    const car = planRoute(sp, [-38, 1], [29, 38], { roads })!;
    expect(car.some(([x, z]) => Math.abs(x - 30) < 0.5 && z > 10 && z < 30)).toBe(true);
    const bike = planRoute(spec("bicycle"), [-38, 1], [29, 38], { roads })!;
    expect(bike.some(([x, z]) => Math.abs(x - 30) < 0.5 && z > 10 && z < 30)).toBe(false);
    // grille : contourne un mur, à distance du gabarit
    const g = new NavGrid(40, 40, 0.5);
    g.blockBox(0, 0, 8, 0.5, 0, 0.25);
    const p = planRoute(sp, [0, -10], [0, 10], { nav: g })!;
    expect(p.length).toBeGreaterThan(2);
    for (const [x, z] of p) expect(Math.abs(z) > 1.2 || Math.abs(x) > 8.5).toBe(true);
  });

  it("bateau : par l'eau seulement ; cible à terre introuvable = null", () => {
    const sp = spec("rowboat");
    const water = (x: number, z: number) => x < 0 || (z > 5 && z < 9);
    const p = planRoute(sp, [-10, -10], [15, 7], { water, bounds: { x0: -20, z0: -20, x1: 20, z1: 20 } })!;
    expect(p).toBeTruthy();
    for (const [x, z] of p.slice(1, -1)) expect(water(x, z)).toBe(true);
    // cible au bord : on accoste au plus près ; loin de toute eau : pas de passage
    const q = planRoute(sp, [-10, -10], [2, -15], { water, bounds: { x0: -20, z0: -20, x1: 20, z1: 20 } })!;
    expect(water(...q[q.length - 1])).toBe(true);
    expect(planRoute(sp, [-10, -10], [15, -15], { water, bounds: { x0: -20, z0: -20, x1: 20, z1: 20 } })).toBeNull();
  });

  it("monture : au pas elle tourne sur place ; au galop plus vite qu'une vache", () => {
    const horse = vehicleSpecOf({ generator: "animal", params: { species: "horse" }, footprint: { hx: 0.3, hz: 1.1, r: 1.1 }, scale: 1 })!;
    const cow = vehicleSpecOf({ generator: "animal", params: { species: "cow" }, footprint: { hx: 0.4, hz: 1.1, r: 1.1 }, scale: 1 })!;
    expect(horse.maxSpeed).toBeGreaterThan(cow.maxSpeed);
    const s = newDriveState(0, 0, 0);
    run(60, () => stepDrive(horse, s, { throttle: 0, steer: 1, brake: 0 }, 1 / 30));
    expect(s.yaw).toBeLessThan(-0.3);
    expect(Math.hypot(s.x, s.z)).toBeLessThan(0.05);
  });

  it("poses à bord : mains au volant, cavalier à califourchon (pieds sous le bassin, écartés)", () => {
    const hero = build("character", {});
    const mo = motionFor(hero);
    if (mo.kind !== "humanoid") throw new Error("humanoïde attendu");
    const base = { speed: 0, phase: 0, time: 0, actionTime: 1, actionWeight: 1, mood: "neutral", turn: 0, seed: 1, seatY: mo.legLength * 0.55 };
    const sk = hero.skeleton!;
    const ride = mo.pose({ ...base, action: "ride", seatFoot: { y: base.seatY - mo.legLength * 0.78, spread: 0.3, fwd: 0.05 } });
    const W = sk.world(ride.pose);
    const foot = sk.headOf(W, "foot.l");
    expect(foot[1]).toBeLessThan(0);
    expect(Math.abs(foot[0])).toBeGreaterThan(0.2);
    const drive = mo.pose({ ...base, action: "drive", seatFoot: { y: base.seatY - 0.3, spread: 0.12, fwd: 0.4 } });
    const W2 = sk.world(drive.pose);
    const hand = sk.headOf(W2, "hand.r");
    expect(hand[2]).toBeGreaterThan(0.2);
  });
});
