import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GenActor, GenKit } from "./bridge";

describe("pont procgen → monde (sonic-3d)", () => {
  it("construit un personnage, le met en cache, applique les rôles du format", () => {
    const kit = new GenKit(null, "doux");
    const a = kit.build({ id: "character", params: { top: "tee", bottom: "shorts" }, seed: "1" }, true);
    expect(a.asset?.skeleton).toBeTruthy();
    expect(kit.build({ id: "character", params: { top: "tee", bottom: "shorts" }, seed: "1" }, true)).toBe(a);
    const base = kit.roles(a.asset!, undefined);
    const red = kit.roles(a.asset!, { maillot: "#ff0000" });
    const i = 17 * 3; // cloth1
    expect(red[i]).toBeGreaterThan(base[i] - 1e-6);
    expect(red[i]).toBeGreaterThan(red[i + 1] * 2);
  });

  it("générateur inconnu : problème, pas d'exception", () => {
    const kit = new GenKit("bd", "doux");
    const r = kit.build({ id: "dragon", params: {}, seed: "1" }, false);
    expect(r.asset).toBeNull();
    expect(r.issues[0].message).toContain("dragon");
  });

  it("acteur : la foulée suit la distance parcourue, les os du format s'ajoutent à la pose", () => {
    const kit = new GenKit(null, "doux");
    const { asset } = kit.build({ id: "character", params: {}, seed: "2" }, true);
    const actor = new GenActor(kit, asset!, { maillot: "#2563eb" }, "s");
    const holder = new THREE.Object3D();
    holder.add(actor.object);
    const dq = () => (actor.mesh.material as THREE.ShaderMaterial).uniforms.uDQ.value.map((v: THREE.Vector4) => v.toArray()).flat() as number[];
    const drive = { clip: "idle", bones: new Map<string, [number, number, number]>(), rootOff: [0, 0, 0] as [number, number, number] };
    actor.update(0.016, holder, drive);
    const rest = dq();
    for (let k = 0; k < 20; k++) {
      holder.position.x += 0.06;
      holder.updateMatrixWorld();
      actor.update(0.016, holder, drive);
    }
    const walk = dq();
    expect(walk.some((v, i) => Math.abs(v - rest[i]) > 1e-3)).toBe(true);
    actor.update(0.016, holder, { ...drive, bones: new Map([["thigh.r", [-1.2, 0, 0]]]) });
    const kick = dq();
    expect(kick.some((v, i) => Math.abs(v - walk[i]) > 1e-2)).toBe(true);
    actor.setGlow(0.6, "#facc15");
    expect((actor.mesh.material as THREE.ShaderMaterial).uniforms.uGlow.value).toBeCloseTo(0.6);
    actor.dispose();
  });

  it("décor instancié : un appel de dessin (+ contour) pour toutes les copies", () => {
    const kit = new GenKit("bd", "toon");
    const { asset } = kit.build({ id: "rock", params: {}, seed: "3" }, false);
    const mats = [new THREE.Matrix4().toArray(), new THREE.Matrix4().makeTranslation(3, 0, 0).toArray()];
    const g = kit.instanced(asset!, mats, "r~decor");
    const ims = g.children as THREE.InstancedMesh[];
    expect(ims.length).toBe(2);
    expect(ims.every((m) => m.count === 2)).toBe(true);
  });
});

describe("sprite vectoriel procgen (monde2d)", async () => {
  const { GenSprite } = await import("./vector/sprite");
  it("personnage : animé, ancre au sol dans le canvas, rôles du format", () => {
    const s = new GenSprite({ id: "character", params: { top: "tee" }, seed: "1" }, { view: "plongee", pxPerM: 40, resolution: 2, style: "flat" });
    expect(s.animated).toBe(true);
    expect(s.issues).toEqual([]);
    expect(s.anchor[0]).toBeGreaterThan(0);
    expect(s.anchor[0]).toBeLessThan(s.canvas.width);
    expect(s.anchor[1]).toBeGreaterThan(0);
    expect(s.anchor[1]).toBeLessThanOrEqual(s.canvas.height);
    s.setRoles({ maillot: "#ff0000", inconnu: "#00ff00" });
  });
  it("décor et générateur inconnu", () => {
    expect(new GenSprite({ id: "building", params: {}, seed: "2" }, { view: "profil", pxPerM: 20, resolution: 1, style: "ligne-claire" }).animated).toBe(false);
    const x = new GenSprite({ id: "dragon", params: {}, seed: "2" }, { view: "profil", pxPerM: 20, resolution: 1, style: "flat" });
    expect(x.asset).toBeNull();
    expect(x.issues[0].message).toContain("dragon");
    expect(x.draw(0.1, null)).toBe(false);
  });
});
