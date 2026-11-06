import { describe, expect, it } from "vitest";
import { PhysicsWorld } from "./core";
import { RAGDOLL_DEFAULTS, parseRagdollOptions, planRagdoll, ragdollBones, ragdollPose } from "./ragdoll";
import { wrap180 } from "../../shared/skeleton";

const world = () => new PhysicsWorld({ width: 800, height: 600, scale: 50, gravity: [0, 9.8], bounds: "walls", collideMin: 0, outMargin: 50 });
const opts = (o: Record<string, string> = {}) => parseRagdollOptions({ name: "r", x: "400", y: "150", ...o }, "r");
const human = () => planRagdoll(ragdollBones("humain", []).bones, opts());
function load(w: PhysicsWorld, plan: ReturnType<typeof planRagdoll>) {
  w.syncSet(new Set(), plan.bodies);
  w.setJoints(plan.joints);
}
const run = (w: PhysicsWorld, s: number) => { for (let i = 0; i < Math.round(s * 60); i++) w.step(1 / 60); };

describe("plan", () => {
  it("un corps par os, un pivot par os non racine", () => {
    const plan = human();
    expect(plan.errors).toEqual([]);
    expect(plan.bodies.length).toBe(13);
    expect(plan.joints.length).toBe(12);
    expect(plan.bodies.every((b) => b.name.startsWith("r."))).toBe(true);
    expect(plan.bodyOf.get("tete")).toBe("r.tete");
    expect(plan.joints.every((j) => j.type === "revolute" && j.lower !== null && j.upper !== null)).toBe(true);
  });
  it("les membres ne se cognent pas entre eux", () => {
    expect(human().bodies.every((b) => b.group === "ragdoll" && b.collides === "default")).toBe(true);
    const free = planRagdoll(ragdollBones("humain", []).bones, opts({ "self-collide": "" }));
    expect(free.bodies.every((b) => b.group === "" && b.collides === "all")).toBe(true);
  });
  it("les attributs d'os remplacent le préréglage", () => {
    const { bones } = ragdollBones("humain", [{ name: "tete", length: "80", min: "-30", max: "30" }, { name: "queue", parent: "bassin", length: "40" }]);
    expect(bones.find((b) => b.name === "tete")).toMatchObject({ length: 80, min: -30, max: 30, parent: "torse" });
    expect(bones.some((b) => b.name === "queue")).toBe(true);
    const plan = planRagdoll(bones, opts());
    const j = plan.joints.find((x) => x.b === "r.tete")!;
    expect([j.lower, j.upper]).toEqual([-30, 30]);
  });
  it("signale les erreurs de description", () => {
    expect(ragdollBones("inconnu", []).errors[0]).toContain("inconnu");
    expect(ragdollBones("", [{ length: "3" }]).errors[0]).toContain("sans nom");
    const plan = planRagdoll([{ name: "a", parent: "b", length: 10, angle: 0, at: 1, offset: 0, min: -180, max: 180 }], opts());
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.bodies).toEqual([]);
  });
  it("options bornées", () => {
    const o = parseRagdollOptions({ scale: "9999", limit: "-4", density: "x" }, "n");
    expect(o.scale).toBe(20);
    expect(o.limit).toBe(1);
    expect(o.density).toBe(RAGDOLL_DEFAULTS.density);
    expect(o.name).toBe("n");
  });
});

describe("simulation", () => {
  it("la pose de repos redonne rz = 0", () => {
    const w = world();
    const plan = human();
    load(w, plan);
    const pose = ragdollPose(plan, (n) => w.bodyState(n));
    expect(pose.length).toBe(13);
    for (const b of pose) expect(Math.abs(b.rz)).toBeLessThan(0.02);
    const torse = pose.find((b) => b.name === "torse")!;
    expect(torse.length).toBe(110);
  });

  it("tombe, reste d'un seul tenant et s'arrête au sol", () => {
    const w = world();
    const plan = human();
    load(w, plan);
    run(w, 6);
    const pose = ragdollPose(plan, (n) => w.bodyState(n));
    const by = new Map(pose.map((b) => [b.name, b]));
    // Chaque os reste accroché au bout de son parent (aux écarts de pivot près).
    for (const spec of plan.rig.specs) {
      if (!spec.parent) continue;
      const c = by.get(spec.name)!, p = by.get(spec.parent)!;
      const anchorX = p.x + (p.x2 - p.x) * spec.at, anchorY = p.y + (p.y2 - p.y) * spec.at;
      const along = Math.hypot(c.x - anchorX, c.y - anchorY);
      expect(along).toBeLessThan(Math.abs(spec.offset) + 8);
    }
    const lowest = Math.max(...pose.map((b) => Math.max(b.y, b.y2)));
    expect(lowest).toBeGreaterThan(560);
    expect(lowest).toBeLessThanOrEqual(602);
    const asleep = plan.bodies.every((b) => !w.bodyState(b.name)!.awake || Math.hypot(w.bodyState(b.name)!.vx, w.bodyState(b.name)!.vy) < 20);
    expect(asleep).toBe(true);
  });

  it("respecte les limites d'angle", () => {
    const w = world();
    const { bones } = ragdollBones("humain", [{ name: "tete", min: "-25", max: "25" }]);
    const plan = planRagdoll(bones, opts({ y: "100" }));
    load(w, plan);
    let worst = 0;
    for (let i = 0; i < 360; i++) {
      w.step(1 / 60);
      if (i % 6) continue;
      const pose = ragdollPose(plan, (n) => w.bodyState(n));
      const t = pose.find((b) => b.name === "tete")!, torse = pose.find((b) => b.name === "torse")!;
      worst = Math.max(worst, Math.abs(wrap180(t.angle - torse.angle - (plan.rest.find((r) => r.name === "tete")!.angle - plan.rest.find((r) => r.name === "torse")!.angle))));
    }
    expect(worst).toBeLessThan(30);
  });

  it("s'endort au sol en quelques secondes (pas de frétillement)", () => {
    const w = world();
    const plan = human();
    load(w, plan);
    let sleepAt = -1;
    for (let i = 0; i < 60 * 14 && sleepAt < 0; i++) {
      w.step(1 / 60);
      if (plan.bodies.every((b) => !w.bodyState(b.name)!.awake)) sleepAt = (i + 1) / 60;
    }
    expect(sleepAt).toBeGreaterThan(0);
    expect(sleepAt).toBeLessThan(14);
  });

  it("pas d'auto-collision : un pantin ne se bloque pas sur lui-même", () => {
    const w = world();
    const plan = human();
    load(w, plan);
    const events: string[] = [];
    for (let i = 0; i < 240; i++) for (const e of w.step(1 / 60)) if (e.type === "collide" && e.a.startsWith("r.") && e.b.startsWith("r.")) events.push(`${e.a}/${e.b}`);
    expect(events).toEqual([]);
  });

  it("une rotation initiale tourne le pantin autour de sa racine", () => {
    const flat = planRagdoll(ragdollBones("humain", []).bones, opts({ angle: "90" }));
    const w = world();
    load(w, flat);
    const t = ragdollPose(flat, (n) => w.bodyState(n)).find((b) => b.name === "torse")!;
    expect(Math.abs(t.x2 - t.x)).toBeGreaterThan(80);
    expect(Math.abs(t.y2 - t.y)).toBeLessThan(15);
  });
});
