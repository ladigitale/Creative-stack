import * as THREE from "three";
import { normalPixels, ormPixels, texHeights, type TexSpec } from "../../shared/monde/textures";

/**
 * Cartes tirées d'une texture procédurale : normales (relief éclairé), ORM (occlusion, rugosité, hauteur), et
 * parallaxe (creux qui se creusent avec l'angle de vue). Mêmes répétition, rotation et raccords que la couleur.
 */

const SIZE = 256;
const cache = new Map<string, THREE.DataTexture>();

function make(px: Uint8ClampedArray, t: TexSpec): THREE.DataTexture {
  const tx = new THREE.DataTexture(px, SIZE, SIZE, THREE.RGBAFormat);
  tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  tx.magFilter = THREE.LinearFilter;
  tx.minFilter = THREE.LinearMipmapLinearFilter;
  tx.generateMipmaps = true;
  tx.anisotropy = 8;
  tx.repeat.set(t.scale, t.scale);
  tx.center.set(0.5, 0.5);
  tx.rotation = (t.angle * Math.PI) / 180;
  tx.needsUpdate = true;
  return tx;
}

const tkey = (t: TexSpec) => `${t.kind}|${t.seed}|${t.scale}|${t.angle}`;

/** Carte de normales d'une texture (pente `relief`, arrondie au dixième pour partager le cache). */
export function normalMapOf(t: TexSpec, relief: number): THREE.DataTexture {
  const r = Math.round(relief * 10) / 10;
  const key = `n|${tkey(t)}|${r}`;
  let tx = cache.get(key);
  if (!tx) cache.set(key, (tx = make(normalPixels(texHeights(t, SIZE), SIZE, 0.5 + r * 2.5), t)));
  return tx;
}

/** Carte ORM d'une texture (usure arrondie au dixième). */
export function ormMapOf(t: TexSpec, wear: number): THREE.DataTexture {
  const w = Math.round(wear * 10) / 10;
  const key = `o|${tkey(t)}|${w}`;
  let tx = cache.get(key);
  if (!tx) cache.set(key, (tx = make(ormPixels(texHeights(t, SIZE), SIZE, w), t)));
  return tx;
}

/** Libère les cartes (changement de monde). */
export function disposeTexMaps() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

function resolveIncludes(src: string, depth = 0): string {
  if (depth > 8) return src;
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name: string) => resolveIncludes((THREE.ShaderChunk as Record<string, string>)[name] ?? "", depth + 1));
}

const PARALLAX = /* glsl */ `
uniform float pDepth;
vec2 parallaxUv(vec2 uv) {
  vec3 vpos = -vViewPosition;
  vec3 dp1 = dFdx(vpos), dp2 = dFdy(vpos);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 N = normalize(cross(dp1, dp2));
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float inv = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  mat3 TBN = mat3(T * inv, B * inv, N);
  vec3 V = normalize(vViewPosition);
  vec3 vt = normalize(V * TBN);
  const int STEPS = 14;
  float layer = 1.0 / float(STEPS);
  vec2 P = vt.xy / max(vt.z, 0.25) * pDepth;
  vec2 dUV = P * layer;
  vec2 cur = uv;
  float depthAt = 1.0 - textureGrad(roughnessMap, cur, duv1, duv2).b;
  float d = 0.0;
  for (int i = 0; i < STEPS; i++) {
    if (d >= depthAt) break;
    cur -= dUV;
    depthAt = 1.0 - textureGrad(roughnessMap, cur, duv1, duv2).b;
    d += layer;
  }
  vec2 prev = cur + dUV;
  float after = depthAt - d;
  float before = (1.0 - textureGrad(roughnessMap, prev, duv1, duv2).b) - d + layer;
  float w = after / (after - before + 1e-5);
  return mix(cur, prev, clamp(w, 0.0, 1.0));
}
`;

/**
 * Parallaxe sur une matière standard qui a une carte de couleur et une carte ORM (`roughnessMap`, hauteur en B) :
 * les uv de toutes ses cartes sont décalés selon la vue (recherche par couches, 14 pas). `depth` 0 à 1.
 */
export function applyParallax(m: THREE.MeshStandardMaterial, depth: number) {
  const amount = depth * 0.08;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.pDepth = { value: amount };
    const fs = resolveIncludes(sh.fragmentShader);
    const i = fs.indexOf("void main()");
    if (i < 0) return;
    const head = fs.slice(0, i);
    let body = fs.slice(i);
    // toutes les cartes partagent la même transformation d'uv (mêmes répétition et rotation)
    body = body.replace(/\bv(Map|NormalMap|RoughnessMap|AoMap|BumpMap|MetalnessMap)Uv\b/g, "pUv");
    body = body.replace(/void main\(\)\s*\{/, "void main() {\n  vec2 pUv = parallaxUv(vMapUv);");
    sh.fragmentShader = head + PARALLAX + body;
  };
  m.customProgramCacheKey = () => `parallax`;
  m.userData.parallax = amount;
}
