import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { pick, type HighlightCtx } from "./pick";
import { textures } from "./textures";

function ctxFor(content: THREE.Object3D): HighlightCtx {
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  content.updateMatrixWorld(true);
  return {
    content,
    activeCam: cam,
    raycaster: new THREE.Raycaster(),
    pointerNdc: new THREE.Vector2(),
    highlighted: null,
    prevEmissive: new THREE.Color(),
    prevEmissiveIntensity: 1,
  };
}

function box(name: string, z: number, parent: THREE.Object3D) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  m.name = name;
  m.position.z = z;
  parent.add(m);
  return m;
}

describe("pick : filtre pick-names", () => {
  it("ignore les nœuds décoratifs devant la cible", () => {
    const root = new THREE.Group();
    box("table", 2, root); // devant, non pickable
    box("m_10", 0, root);
    const ctx = ctxFor(root);
    expect(pick.hit(ctx, 0.5, 0.5)?.objectId).toBe("table");
    expect(pick.hit(ctx, 0.5, 0.5, "^(m_|hole_)")?.objectId).toBe("m_10");
  });

  it("accepte un nom porté par un ancêtre", () => {
    const root = new THREE.Group();
    const g = new THREE.Group();
    g.name = "m_3";
    root.add(g);
    box("", 0, g);
    const hit = pick.hit(ctxFor(root), 0.5, 0.5, "^m_");
    expect(hit).not.toBeNull();
  });

  it("renvoie null si rien ne correspond", () => {
    const root = new THREE.Group();
    box("table", 0, root);
    expect(pick.hit(ctxFor(root), 0.5, 0.5, "^m_")).toBeNull();
  });
});

describe("pick : survol", () => {
  it("surligne par défaut, pas quand highlight=false", () => {
    const root = new THREE.Group();
    const m = box("m_1", 0, root);
    const ctx = ctxFor(root);
    pick.setHoverAt(ctx, 0.5, 0.5);
    expect((m.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0x3b82f6);
    pick.clearHighlight(ctx);
    pick.setHoverAt(ctx, 0.5, 0.5, undefined, false);
    expect(ctx.highlighted).toBeNull();
    expect((m.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0);
  });
});

describe("textures procédurales", () => {
  it("génère des UV absents (sphérique pour marble, planaire sinon)", () => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6));
    sphere.geometry.deleteAttribute("uv");
    textures.ensureUv(sphere, "marble");
    const uv = sphere.geometry.getAttribute("uv");
    expect(uv.count).toBe(sphere.geometry.getAttribute("position").count);
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
    }

    const plane = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
    plane.geometry.deleteAttribute("uv");
    textures.ensureUv(plane, "wood");
    expect(plane.geometry.getAttribute("uv").count).toBe(4);
  });

  it("garde les UV existants", () => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    const before = m.geometry.getAttribute("uv");
    textures.ensureUv(m, "felt");
    expect(m.geometry.getAttribute("uv")).toBe(before);
  });

  it("reconnaît les matériaux tex:<kind>", () => {
    expect(textures.kindOf("tex:wood")).toBe("wood");
    expect(textures.kindOf("tex:inconnu")).toBeNull();
    expect(textures.kindOf("wood")).toBeNull();
  });
});
