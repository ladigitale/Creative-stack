import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { halton, pickEngine, rasterFrames, readProcgenPhoto, roleMaterial, skinPositions, splitByRole } from "./photo";
import { ROLES } from "../style/roles";

describe("rendu soigné (procgen)", () => {
  it("réglages : absent = rien ; true ; render photo l'impose ; clés inconnues signalées", () => {
    expect(readProcgenPhoto(undefined, false)).toBeNull();
    expect(readProcgenPhoto(false, false)).toBeNull();
    const a = readProcgenPhoto(true, false)!;
    expect(a.moteur).toBe("auto");
    expect(a.force).toBe(false);
    expect(a.echantillons).toBe(200);
    expect(readProcgenPhoto(undefined, true)!.force).toBe(true);
    const bad: string[] = [];
    const b = readProcgenPhoto({ filtre: "peinture", moteur: "laser", foo: 1 }, false, (p) => bad.push(p))!;
    expect(b.filtre).toBe("peinture");
    expect(b.echantillons).toBe(4);
    expect(bad).toEqual(["photo.moteur", "photo.foo"]);
  });

  it("moteur : rayons sur ordinateur pour un modelé, raster pour les aplats, les pixels et le mobile", () => {
    const s = readProcgenPhoto(true, false)!;
    expect(pickEngine(s, { mobile: false, shading: "lit", pixel: 0 })).toBe("rayons");
    expect(pickEngine(s, { mobile: false, shading: "toon", pixel: 0 })).toBe("raster");
    expect(pickEngine(s, { mobile: true, shading: "lit", pixel: 0 })).toBe("raster");
    expect(pickEngine({ ...s, moteur: "rayons" }, { mobile: false, shading: "lit", pixel: 4 })).toBe("raster");
    expect(pickEngine({ ...s, moteur: "rayons" }, { mobile: true, shading: "toon", pixel: 0 })).toBe("rayons");
    // mobile : très réduit
    expect(rasterFrames(s, true)).toBe(8);
    expect(rasterFrames(s, false)).toBe(32);
  });

  it("suite de Halton recentrée", () => {
    expect(halton(0, 2)).toBeCloseTo(0, 5);
    expect(halton(1, 2)).toBeCloseTo(-0.25, 5);
    for (let i = 0; i < 64; i++) expect(Math.abs(halton(i, 3))).toBeLessThanOrEqual(0.5);
  });

  const quad = () => {
    // deux triangles : le premier en rôle 5 (mur), le second en rôle 14 (métal), fondu vers le rôle 7 sur un sommet
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setAttribute("aRole", new THREE.Float32BufferAttribute([5, 5, 5, 14], 1));
    g.setAttribute("aBlend", new THREE.Float32BufferAttribute([0, 0, 7.5, 0], 1));
    g.setIndex([0, 1, 2, 3, 0, 2]);
    return g;
  };

  it("découpe par rôle : géométries compactes, couleurs des rôles dans les sommets", () => {
    const roles = new Float32Array(ROLES.length * 3);
    roles.set([0.5, 0.4, 0.3], 5 * 3);
    roles.set([0.2, 0.2, 0.25], 14 * 3);
    roles.set([1, 0, 0], 7 * 3);
    const parts = splitByRole(quad(), roles);
    expect(parts.map((p) => p.role).sort((a, b) => a - b)).toEqual([5, 14]);
    const wall = parts.find((p) => p.role === 5)!;
    expect(wall.tris).toBe(1);
    expect(wall.geo.getAttribute("position").count).toBe(3);
    const col = wall.geo.getAttribute("color");
    expect(col.getX(0)).toBeCloseTo(0.5, 5);
    // sommet fondu à mi-chemin vers le rôle 7 (lissé)
    expect(col.getX(2)).toBeCloseTo(0.75, 5);
    expect(wall.geo.getAttribute("uv").count).toBe(3);
    const metal = parts.find((p) => p.role === 14)!;
    expect(metal.geo.getAttribute("position").count).toBe(3);
  });

  it("pose figée : quaternions duaux identité = géométrie de repos ; translation appliquée", () => {
    const g = quad();
    const n = 4;
    g.setAttribute("aSkinIdx", new THREE.Float32BufferAttribute(new Array(n * 4).fill(0), 4));
    g.setAttribute("aSkinW", new THREE.Float32BufferAttribute(Array.from({ length: n * 4 }, (_, k) => (k % 4 === 0 ? 1 : 0)), 4));
    const id = [new THREE.Vector4(0, 0, 0, 1), new THREE.Vector4(0, 0, 0, 0)];
    const a = skinPositions(g, id);
    expect(Array.from(a.pos)).toEqual(Array.from(g.getAttribute("position").array as Float32Array));
    // translation pure de (0, 2, 0) : partie duale = ½ t ⊗ r = (0, 1, 0, 0)
    const b = skinPositions(g, [new THREE.Vector4(0, 0, 0, 1), new THREE.Vector4(0, 1, 0, 0)]);
    expect(b.pos[1]).toBeCloseTo(2, 5);
    expect(b.pos[7]).toBeCloseTo(3, 5);
  });

  it("matière d'un rôle : fini du style, rugosité par défaut, lampes émissives", () => {
    const roleMat = new Float32Array(ROLES.length * 4);
    const metal = ROLES.indexOf("metal");
    roleMat.set([1.05, 1, 0, 0], metal * 4);
    const roles = new Float32Array(ROLES.length * 3).fill(0.5);
    const m = roleMaterial(metal, roleMat, roles, { night: 0, lamps: 0.6 });
    expect(m.metalness).toBe(1);
    expect(m.roughness).toBeCloseTo(0.05, 5);
    expect(m.vertexColors).toBe(true);
    const water = roleMaterial(ROLES.indexOf("water"), roleMat, roles, { night: 0, lamps: 0.6 });
    expect(water.roughness).toBeLessThan(0.1);
    const lamp = roleMaterial(ROLES.indexOf("lamp"), roleMat, roles, { night: 1, lamps: 1 });
    expect(lamp.emissive.r).toBeGreaterThan(0.5);
  });
});
