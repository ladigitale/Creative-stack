/**
 * Matériaux et géométries three.js : un `ShaderMaterial` maison (couleur MRT) et son jumeau de profondeur (ombres),
 * qui partagent le même objet d'uniformes. Les uniformes de style sont communs à toute la scène.
 */
import * as THREE from "three";
import type { Mesh } from "../geom/mesh";
import { DEPTH_FRAGMENT, FRAGMENT, MAX_BONES, VERTEX } from "./shaders";
import { ROLES } from "../style/roles";
import { exprUniforms } from "./expr";

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
    // direction du balancement au vent (xz) ; (1, 0,4) : direction historique
    uWindDir: { value: new THREE.Vector2(1, 0.4) },
    uShadowOn: { value: 0 },
    uShadowStrength: { value: 0.75 },
    uShadowMap: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
    /** Rayon du flou des ombres (fraction de la carte) et biais (profondeur), réglés en mètres par shadowPass. */
    uShadowKernel: { value: 1 / 2048 },
    uShadowBiasW: { value: 0.0005 },
    /** Cascade large (tout le visible) : carte, matrice, flou, biais ; uShadowOn2 = 0 quand la fine suffit. */
    uShadowMap2: { value: null },
    uShadowMatrix2: { value: new THREE.Matrix4() },
    uShadowKernel2: { value: 1 / 2048 },
    uShadowBiasW2: { value: 0.0005 },
    uShadowOn2: { value: 0 },
    uGroundY: { value: 0 },
    uWaterY: { value: -1000 },
    // nageurs (x, z, vitesse, phase) : rides et écume sur l'eau autour d'eux
    uSwim: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uSwimN: { value: 0 },
    // gazon d'un terrain de sport (x0, z0, x1, z1) et largeur des bandes de tonte (0 : aucun)
    uTurf: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTurfW: { value: 0 },
    uDetail: { value: 1 },
    uEnv: { value: 0 },
    uIdBase: { value: -1 },
    uHighlight: { value: 0 },
    uLightPos: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
    uLightCol: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
    uLightCount: { value: 0 },
    uRoleMat: { value: new Float32Array(ROLES.length * 4) },
    // finis texturés (voir finish-maps.ts) : rien tant que uFinOn = 0
    uRoleFin: { value: null },
    uHeights: { value: null },
    uFinOn: { value: 0 },
  };
}

export type MaterialPair = { color: THREE.ShaderMaterial; depth: THREE.ShaderMaterial; uniforms: Record<string, THREE.IUniform> };

/** Paire de matériaux ; `roles` (Float32Array 32×3, linéaire) propre à l'objet ou commun. */
export function makeMaterials(shared: Shared, roles: { value: Float32Array }, skinned = false): MaterialPair {
  const uniforms: Record<string, THREE.IUniform> = {
    ...shared,
    uRoles: roles,
    // finis par rôle : ceux du style (commun) sauf objet qui porte les siens
    uRoleMat: shared.uRoleMat ?? { value: new Float32Array(ROLES.length * 4) },
    uRoleFin: shared.uRoleFin ?? { value: null },
    uHeights: shared.uHeights ?? { value: null },
    uFinOn: shared.uFinOn ?? { value: 0 },
    uSkinned: { value: skinned ? 1 : 0 },
    uDQ: { value: skinned ? Array.from({ length: MAX_BONES * 2 }, (_, i) => new THREE.Vector4(0, 0, 0, i % 2 ? 0 : 1)) : [] },
    uBlink: { value: 0 },
    ...exprUniforms(),
  };
  if (!skinned) uniforms.uDQ = { value: Array.from({ length: MAX_BONES * 2 }, (_, i) => new THREE.Vector4(0, 0, 0, i % 2 ? 0 : 1)) };
  const color = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms, side: THREE.DoubleSide });
  const depth = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: DEPTH_FRAGMENT, uniforms, side: THREE.DoubleSide });
  return { color, depth, uniforms };
}

/** Géométrie three.js d'un maillage procgen. */
export function toGeometry(m: Mesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // maillage compacté (`compactMesh`) : copie directe de ses Float32Array (le rendu réécrit certains sommets : terrain
  // creusé, objets fusionnés déplacés ; le maillage de la scène, partagé par le cache, ne doit pas les voir)
  const f32 = (a: ArrayLike<number>, n: number) => (a instanceof Float32Array ? new THREE.BufferAttribute(a.slice(), n) : new THREE.Float32BufferAttribute(a as number[], n));
  g.setAttribute("position", f32(m.pos, 3));
  g.setAttribute("normal", f32(m.nrm, 3));
  g.setAttribute("aRole", new THREE.Float32BufferAttribute(m.role, 1));
  g.setAttribute("aAO", f32(m.ao, 1));
  g.setAttribute("aFlex", f32(m.flex, 1));
  g.setAttribute("aObj", new THREE.Float32BufferAttribute(m.obj, 1));
  const n = m.vertexCount;
  g.setAttribute("aSkinIdx", new THREE.Float32BufferAttribute(m.skin ?? new Array(n * 4).fill(0), 4));
  g.setAttribute("aSkinW", m.weight ? f32(m.weight, 4) : new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, k) => (k % 4 === 0 ? 1 : 0)), 4));
  g.setAttribute("aMorph", m.morph ? f32(m.morph, 3) : new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aBlend", m.blend ? f32(m.blend, 1) : new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(m.idx, 1) : new THREE.Uint16BufferAttribute(m.idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
