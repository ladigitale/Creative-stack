/**
 * Matériaux et géométries three.js : un `ShaderMaterial` maison (couleur MRT) et son jumeau de profondeur (ombres),
 * qui partagent le même objet d'uniformes. Les uniformes de style sont communs à toute la scène.
 */
import * as THREE from "three";
import type { Mesh } from "../geom/mesh";
import { DEPTH_FRAGMENT, FRAGMENT, MAX_BONES, VERTEX } from "./shaders";

export type Shared = Record<string, THREE.IUniform>;

export function sharedUniforms(): Shared {
  return {
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
    uSun: { value: new THREE.Color(1, 0.95, 0.85) },
    uAmbSky: { value: new THREE.Color(0.6, 0.7, 0.8) },
    uAmbGround: { value: new THREE.Color(0.5, 0.45, 0.4) },
    uFogColor: { value: new THREE.Color(0.85, 0.85, 0.82) },
    uFog: { value: 0.5 },
    uFogHeight: { value: 0.3 },
    uFar: { value: 100 },
    uFogNear: { value: 0 },
    uFogRange: { value: 100 },
    uShading: { value: 1 },
    uBands: { value: 3 },
    uBandSoft: { value: 0.08 },
    uBrush: { value: 0.3 },
    uAOStrength: { value: 0.8 },
    uTexture: { value: 0.6 },
    uNight: { value: 0 },
    uLamps: { value: 0.6 },
    uRim: { value: 0.25 },
    uTime: { value: 0 },
    uWind: { value: 1 },
    uShadowOn: { value: 0 },
    uShadowStrength: { value: 0.75 },
    uShadowMap: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
    uGroundY: { value: 0 },
    uWaterY: { value: -1000 },
    uIdBase: { value: -1 },
    uHighlight: { value: 0 },
    uLightPos: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
    uLightCol: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
    uLightCount: { value: 0 },
  };
}

export type MaterialPair = { color: THREE.ShaderMaterial; depth: THREE.ShaderMaterial; uniforms: Record<string, THREE.IUniform> };

/** Paire de matériaux ; `roles` (Float32Array 32×3, linéaire) propre à l'objet ou commun. */
export function makeMaterials(shared: Shared, roles: { value: Float32Array }, skinned = false): MaterialPair {
  const uniforms: Record<string, THREE.IUniform> = {
    ...shared,
    uRoles: roles,
    uSkinned: { value: skinned ? 1 : 0 },
    uDQ: { value: skinned ? Array.from({ length: MAX_BONES * 2 }, (_, i) => new THREE.Vector4(0, 0, 0, i % 2 ? 0 : 1)) : [] },
    uBlink: { value: 0 },
  };
  if (!skinned) uniforms.uDQ = { value: Array.from({ length: MAX_BONES * 2 }, (_, i) => new THREE.Vector4(0, 0, 0, i % 2 ? 0 : 1)) };
  const color = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms, side: THREE.DoubleSide });
  const depth = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: DEPTH_FRAGMENT, uniforms, side: THREE.DoubleSide });
  return { color, depth, uniforms };
}

/** Géométrie three.js d'un maillage procgen. */
export function toGeometry(m: Mesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(m.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(m.nrm, 3));
  g.setAttribute("aRole", new THREE.Float32BufferAttribute(m.role, 1));
  g.setAttribute("aAO", new THREE.Float32BufferAttribute(m.ao, 1));
  g.setAttribute("aFlex", new THREE.Float32BufferAttribute(m.flex, 1));
  g.setAttribute("aObj", new THREE.Float32BufferAttribute(m.obj, 1));
  const n = m.vertexCount;
  g.setAttribute("aSkinIdx", new THREE.Float32BufferAttribute(m.skin ?? new Array(n * 4).fill(0), 4));
  g.setAttribute("aSkinW", new THREE.Float32BufferAttribute(m.weight ?? new Array(n * 4).fill(0).map((_, k) => (k % 4 === 0 ? 1 : 0)), 4));
  g.setAttribute("aMorph", new THREE.Float32BufferAttribute(m.morph ?? new Array(n * 3).fill(0), 3));
  g.setAttribute("aBlend", new THREE.Float32BufferAttribute(m.blend ?? new Array(n).fill(0), 1));
  g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(m.idx, 1) : new THREE.Uint16BufferAttribute(m.idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
