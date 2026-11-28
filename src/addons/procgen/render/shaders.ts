/**
 * Shaders de procgen (GLSL 3, en clair). Un seul code de sommet pour la couleur et la profondeur d'ombre :
 * instances, vent, morph de clignement et skinning par **quaternions duaux** sont identiques dans les deux passes.
 *
 * Sorties couleur (MRT) : 0 = couleur éclairée, 1 = (normale vue xy, profondeur linéaire, identifiant d'objet) pour
 * les contours en post-traitement.
 */

import { ROLES } from "../style/roles";
import { HERBE_MAX_PUSH, herbeBendGLSL } from "../../../shared/monde/herbes";

/** Fleurs d'une prairie (couleurs de corolle), au plus. */
export const MEADOW_FLOWERS = 8;

export const MAX_BONES = 32;
/** Canaux d'expression au plus (par 4) et largeur de la texture des morphs d'expression. */
export const EXPR_SLOTS = 4;
export const EXPR_TEX_W = 1024;

const COMMON = /* glsl */ `
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0)), n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1)), n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm3(vec3 p) { return vnoise(p) * 0.55 + vnoise(p * 2.07 + 7.1) * 0.3 + vnoise(p * 4.13 + 3.3) * 0.15; }
`;

export const VERTEX = /* glsl */ `
precision highp float;
#define EXPR_SLOTS ${EXPR_SLOTS}
#define EXPR_TEX_W ${EXPR_TEX_W}
in float aRole;
in float aAO;
in float aObj;
#ifndef BLADE
in float aFlex;
in vec4 aSkinIdx;
in vec4 aSkinW;
in vec3 aMorph;
in float aBlend;
#endif
#ifdef USE_INSTANCING
in float aInstObj;
#endif
uniform float uSkinned;
uniform vec4 uDQ[${MAX_BONES * 2}];
uniform float uBlink;
#ifndef BLADE
// morphs d'expression (visage) : texture de décalages lue par numéro de sommet, poids par canal
uniform highp sampler2D uExprTex;
uniform vec4 uExprW[EXPR_SLOTS];
uniform vec2 uExprRange;
#endif
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform mat4 uShadowMatrix;
uniform mat4 uShadowMatrix2;
/** Eau (passe d'eau) : hauteur de houle (m), longueur d'onde dominante (m), type (1 = mer, 0 = pièce d'eau). */
uniform float uWaveAmp;
uniform float uWaveLen;
uniform float uWaterKind;
uniform float uPass;
out float vWave;
flat out float vRole;
flat out float vObj;
out float vAO;
/**
 * Eau : agitation propre à la surface, rapportée à la valeur de référence de son genre (mer 1, eau posée 0,3) :
 * flaque ≈ 0,1, bassin 0,4, mare 1, vasque de cascade 2 ; petit lac du terrain < 1. 1 sans réglage.
 */
out float vAgit;
out vec3 vNormalW;
out vec3 vPosW;
out vec3 vPosL;
out vec3 vNormL;
out float vViewZ;
out vec4 vShadow;
out vec4 vShadow2;
flat out float vVar;
out float vBlend;
#ifdef BLADE
// prairies : hauteur le long du brin, épi ou corolle, (rang de fleur + 1, valeur) par brin ; vent et ploiement
// (16 attributs au plus : pas de peau, de morph ni de souplesse dans cette variante)
in vec2 aBlade;
in vec2 aTint;
uniform vec2 uBladeWind;
uniform float uSway;
uniform vec4 uPush[${HERBE_MAX_PUSH}];
out float vBh;
out float vHead;
flat out vec2 vTint;
${herbeBendGLSL({ time: "uTime", wind: "uBladeWind", sway: "uSway", push: "uPush" })}
#endif
${COMMON}

#ifndef BLADE
void dqBlend(out vec4 r, out vec4 d) {
  ivec4 bi = ivec4(aSkinIdx + 0.5);
  vec4 r0 = uDQ[bi.x * 2];
  r = vec4(0.0); d = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    float w = aSkinW[k];
    if (w <= 0.0) continue;
    vec4 qr = uDQ[bi[k] * 2];
    vec4 qd = uDQ[bi[k] * 2 + 1];
    float s = dot(qr, r0) < 0.0 ? -w : w;
    r += qr * s; d += qd * s;
  }
  float l = length(r);
  r /= l; d /= l;
}
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
#endif

void main() {
  vec3 p = position;
  vec3 n = normal;
  #ifndef BLADE
  if (uSkinned > 0.5) {
    p += aMorph * uBlink;
    float ei = float(gl_VertexID) - uExprRange.x;
    if (ei >= 0.0 && ei < uExprRange.y) {
      int iv = int(ei), cnt = int(uExprRange.y);
      for (int c = 0; c < EXPR_SLOTS * 4; c++) {
        float w = uExprW[c / 4][c % 4];
        if (w == 0.0) continue;
        int t = c * cnt + iv;
        p += texelFetch(uExprTex, ivec2(t % EXPR_TEX_W, t / EXPR_TEX_W), 0).xyz * w;
      }
    }
    vec4 r, d;
    dqBlend(r, d);
    vec3 t = 2.0 * (r.w * d.xyz - d.w * r.xyz + cross(r.xyz, d.xyz));
    p = qrot(r, p) + t;
    n = qrot(r, n);
  }
  #endif
  vec4 local = vec4(p, 1.0);
  mat4 M = modelMatrix;
  #ifdef USE_INSTANCING
  M = modelMatrix * instanceMatrix;
  vec3 io = (M * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vVar = hash13(floor(io * 7.31) + 0.5);
  #else
  vVar = fract(aObj * 0.6180339 + 0.13);
  #endif
  vec4 wp = M * local;
  #ifdef BLADE
  vec3 root = (M * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float hgt = length(M[1].xyz);
  float kb = clamp(aBlade.x, 0.0, 1.0);
  kb *= kb;
  vec2 bw = herbeBend(root);
  wp.xz += bw * kb * hgt;
  wp.y -= dot(bw, bw) * kb * hgt * 0.35;
  vBh = aBlade.x;
  vHead = aBlade.y;
  vTint = aTint;
  #endif
  #ifndef BLADE
  if (aFlex > 0.0) {
    float ph = dot(wp.xz, vec2(0.35, 0.27)) + vVar * 6.28;
    float sw = sin(uTime * 1.7 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.25;
    wp.xz += sw * uWindDir * aFlex * uWind * 0.06;
    wp.y += sin(uTime * 2.3 + ph) * aFlex * uWind * 0.01;
  }
  #endif
  vWave = 0.0;
  // eau : houle de Gerstner (5 trains d'ondes, crêtes pointues, creux larges), amortie sur les hauts-fonds (la
  // profondeur relative est dans aAO pour la mer) ; la normale suit la surface déformée
  if (uPass > 0.5 && aRole > 12.5 && aRole < 13.5 && uWaveAmp > 0.0 && n.y > 0.5) {
    float damp = uWaterKind > 0.5 ? smoothstep(0.0, 0.3, aAO) : 1.0;
    vec3 d = vec3(0.0), nn = vec3(0.0, 1.0, 0.0);
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float ang = 0.45 + fi * 1.37 + sin(fi * 2.1) * 0.4;
      vec2 D = vec2(cos(ang), sin(ang));
      float L = uWaveLen * (1.0 - fi * 0.15) * (fi > 2.5 ? 0.45 : 1.0);
      float k = 6.2831 / L;
      float A = uWaveAmp * damp * (aFlex < 0.0 ? clamp(-aFlex / (uWaterKind > 0.5 ? 1.0 : 0.3), 0.05, 2.2) : 1.0) * (1.0 - fi * 0.16) * (fi > 2.5 ? 0.35 : 1.0);
      float Q = 0.55 / (k * A * 5.0 + 1e-4);
      Q = min(Q, 1.0);
      float c = sqrt(9.81 / k);
      float f = k * (dot(D, wp.xz) - c * uTime) + fi * 1.7;
      float cf = cos(f), sf = sin(f);
      d.xz += Q * A * D * cf;
      d.y += A * sf;
      nn.xz -= D * k * A * cf;
      nn.y -= Q * k * A * sf;
    }
    wp.xyz += d;
    n = normalize(nn);
    vWave = clamp(d.y / max(uWaveAmp * 1.6, 1e-3) * 0.5 + 0.5, 0.0, 1.0);
  }
  vPosW = wp.xyz;
  // repère des motifs des finis texturés : pose de repos (le motif suit le corps), décalé par instance
  vPosL = position;
  vNormL = normal;
  #ifdef USE_INSTANCING
  vPosL += vVar * 17.0;
  #endif
  vNormalW = normalize(mat3(M) * n);
  #ifdef BLADE
  // brins : normale tirée vers le haut (la prairie s'éclaire comme une masse, sans scintiller)
  vNormalW = normalize(mix(vNormalW, vec3(0.0, 1.0, 0.0), 0.6));
  #endif
  vRole = aRole;
  #ifdef USE_INSTANCING
  vObj = aInstObj;
  #else
  vObj = aObj;
  #endif
  vAO = aAO;
  vAgit = aFlex < 0.0 ? clamp(-aFlex / (uWaterKind > 0.5 ? 1.0 : 0.3), 0.05, 2.2) : 1.0;
  #ifdef BLADE
  vBlend = 0.0;
  #else
  vBlend = aBlend;
  #endif
  vShadow = uShadowMatrix * wp;
  vShadow2 = uShadowMatrix2 * wp;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const FRAGMENT = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outData;
flat in float vRole;
flat in float vObj;
in float vAO;
in float vAgit;
in vec3 vNormalW;
in vec3 vPosW;
in vec3 vPosL;
in vec3 vNormL;
in float vViewZ;
in vec4 vShadow;
in vec4 vShadow2;
in float vWave;
flat in float vVar;
in float vBlend;
#ifdef BLADE
in float vBh;
in float vHead;
flat in vec2 vTint;
uniform vec3 uBladeBase;
uniform vec3 uBladeTip;
uniform vec3 uFlowers[${MEADOW_FLOWERS}];
uniform float uFlowerHeads;
#endif
uniform vec3 uRoles[${ROLES.length}];
// fini par rôle : x = rugosité + 1 (0 : aucun fini, éclairage du style), y = métal, z = reflet de tissu, w = vernis
uniform vec4 uRoleMat[${ROLES.length}];
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uFogColor;
uniform float uFog;
uniform float uFogHeight;
uniform float uFar;
uniform float uFogNear;
uniform float uFogRange;
uniform float uShading;
uniform float uBands;
uniform float uBandSoft;
uniform float uBrush;
uniform float uAOStrength;
uniform float uTexture;
uniform float uNight;
uniform float uLamps;
uniform float uRim;
uniform float uTime;
uniform float uShadowOn;
uniform float uShadowStrength;
uniform sampler2D uShadowMap;
uniform vec2 uShadowTexel;
uniform float uShadowKernel;
uniform float uShadowBiasW;
uniform sampler2D uShadowMap2;
/** Passe d'eau : couleur et données (normale, profondeur / far) de la scène opaque, taille de la cible. */
uniform sampler2D tSceneColor;
uniform sampler2D tSceneData;
uniform vec2 uViewport;
uniform float uPass;
uniform float uWaterSplit;
uniform float uWaterKind;
uniform float uWaveAmp;
uniform float uWaveLen;
/** Hauteur relative de la houle (−1 creux … 1 crête) recalculée au pixel : les crêtes restent nettes et lisses quel que
 * soit le maillage (la valeur interpolée entre sommets dessinait des triangles d'écume qui filaient avec la vague). */
float waveCrest(vec2 p) {
  float h = 0.0, tot = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float ang = 0.45 + fi * 1.37 + sin(fi * 2.1) * 0.4;
    vec2 D = vec2(cos(ang), sin(ang));
    float L = uWaveLen * (1.0 - fi * 0.15) * (fi > 2.5 ? 0.45 : 1.0);
    float k = 6.2831 / L;
    float A = (1.0 - fi * 0.16) * (fi > 2.5 ? 0.35 : 1.0);
    h += A * sin(k * (dot(D, p) - sqrt(9.81 / k) * uTime) + fi * 1.7);
    tot += A;
  }
  return h / tot;
}
uniform float uShadowKernel2;
uniform float uShadowBiasW2;
uniform float uShadowOn2;
uniform float uIdBase;
uniform float uHighlight;
uniform float uGroundY;
uniform float uWaterY;
uniform vec4 uSwim[8];
uniform int uSwimN;
uniform vec4 uTurf;
uniform float uTurfW;
uniform float uDetail;
uniform float uEnv;
uniform vec4 uLightPos[12];
uniform vec4 uLightCol[12];
uniform float uLightCount;
// finis texturés : table par rôle (rangée 0 relief, profondeur, usure, occlusion ; rangée 1 couche + 1, répétitions
// par mètre, verre, ior), banque de hauteurs des motifs, interrupteur (0 aucun, 1 qualité basse, 2 haute)
uniform highp sampler2D uRoleFin;
uniform highp sampler2DArray uHeights;
uniform float uFinOn;
${COMMON}

vec2 axisUv(vec3 p, int a) { return a == 0 ? p.zy : a == 1 ? p.xz : p.xy; }
float finH(vec2 uv, vec2 gx, vec2 gy, float layer) { return textureGrad(uHeights, vec3(uv, layer), gx, gy).r; }

const vec2 POISSON[12] = vec2[](vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621), vec2(0.962, -0.195), vec2(0.473, -0.480),
  vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));
/** Ombre portée filtrée (PCF) d'une cascade ; -1 hors de sa carte. Flou et biais en mètres (voir setCascade). */
float shadowMapAt(sampler2D map, vec4 sc, float ndl, float soft, float kernel, float biasW) {
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return -1.0;
  // biais fixe en profondeur, plus grand sur les faces rasantes ; flou : rayon fixe en mètres
  float bias = biasW * mix(4.4, 1.0, clamp(ndl, 0.0, 1.0)) * mix(1.0, 2.5, step(1.5, soft));
  float a = hash13(vec3(gl_FragCoord.xy, 1.0)) * 6.2831;
  mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
  float s = 0.0;
  for (int i = 0; i < 12; i++) {
    float d = texture(map, c.xy + R * POISSON[i] * kernel * soft).r;
    s += c.z - bias > d ? 0.0 : 1.0;
  }
  return soft > 1.5 ? smoothstep(0.0, 1.0, s / 12.0) : s / 12.0;
}

/** Distance au bord de la carte (0 au bord, 0,5 au centre) : fondu entre cascades près du bord de la fine. */
float shadowEdge(vec4 sc) {
  vec2 c = sc.xy / sc.w * 0.5 + 0.5;
  return min(min(c.x, 1.0 - c.x), min(c.y, 1.0 - c.y));
}

/**
 * Ombre portée en deux cascades : la fine (autour de la cible) là où elle couvre le point, sinon la large (tout ce
 * que voit la caméra), avec un fondu sur les 8 % du bord de la fine ; hors des deux, éclairé.
 * soft élargit la pénombre et le biais (peau : ombres du nez, des sourcils, de la mâchoire en dégradé, sans arête
 * crénelée ni acné sur les courbes du visage).
 */
float shadowAt(vec4 sc, float ndl, float soft) {
  if (uShadowOn < 0.5) return 1.0;
  float near = shadowMapAt(uShadowMap, sc, ndl, soft, uShadowKernel, uShadowBiasW);
  if (uShadowOn2 < 0.5) return near < 0.0 ? 1.0 : near;
  float k = near < 0.0 ? 0.0 : smoothstep(0.0, 0.08, shadowEdge(sc));
  if (k >= 1.0) return near;
  float far = shadowMapAt(uShadowMap2, vShadow2, ndl, soft, uShadowKernel2, uShadowBiasW2);
  if (far < 0.0) far = 1.0;
  return near < 0.0 ? far : mix(far, near, k);
}

/** Variation de valeur procédurale selon le rôle (veinage du bois, taches de pierre, macro-variation du sol). */
float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 hash22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
/**
 * Poids d'une octave de bruit de fréquence freq (cycles/m) quand un pixel couvre fw mètres : 1 tant qu'elle
 * fait plus de ~3 pixels, 0 sous ~1,5 pixel. Équivalent procédural du mipmap : pas de moiré ni de scintillement,
 * la surface garde sa valeur moyenne au loin (et l'énergie perdue passe à une échelle plus grande, voir main).
 */
float octK(float freq, float fw) { return 1.0 - smoothstep(0.33, 0.66, freq * fw); }
/** Caustiques : réseau cellulaire (Voronoï, F2 − F1) dont les germes dérivent ; jamais de quadrillage régulier. */
float caustic(vec2 p, float t) {
  vec2 c = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 h = hash22(c + o);
      vec2 r = o + 0.5 + 0.42 * sin(t * (0.6 + 0.5 * h) + 6.2831 * h) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
  // filets lumineux fins (et non des cellules à facettes)
  float e = sqrt(d2) - sqrt(d1);
  return exp(-e * e * 90.0);
}

// ouvertures du sol au-dessus des fonds d'eau : A = (x, z, hx, hz), B = (cos lacet, sin lacet, forme, graine)
uniform vec4 uHoleA[16];
uniform vec4 uHoleB[16];
uniform int uHoleN;
// coques à flot : A = (x, z, demi-largeur, demi-longueur), B = (cos cap, sin cap) ; l'eau n'est jamais dessinée dans
// leur emprise (pas d'eau dans une barque, quelle que soit la vague)
uniform vec4 uHullA[12];
uniform vec4 uHullB[12];
uniform int uHullN;
bool inHull(vec2 p) {
  for (int i = 0; i < 12; i++) {
    if (i >= uHullN) break;
    vec4 a = uHullA[i], b = uHullB[i];
    vec2 d = p - a.xy;
    vec2 l = vec2(d.x * b.x - d.y * b.y, d.x * b.y + d.y * b.x) / a.zw;
    if (dot(l, l) < 1.0) return true;
  }
  return false;
}
bool inHole(vec2 p) {
  for (int i = 0; i < 16; i++) {
    if (i >= uHoleN) break;
    vec4 a = uHoleA[i], b = uHoleB[i];
    vec2 d = p - a.xy;
    vec2 l = vec2(d.x * b.x - d.y * b.y, d.x * b.y + d.y * b.x) / a.zw;
    // rond (1) ; ondulé comme la berge d'une mare (2, graine en w)
    float w = b.z > 1.5 ? 1.0 + 0.06 * sin(atan(l.y, l.x) * 3.0 + b.w) + 0.04 * sin(atan(l.y, l.x) * 5.0 + b.w * 2.0) : 1.0;
    if (b.z > 0.5 ? dot(l, l) < w * w : max(abs(l.x), abs(l.y)) < 1.0) return true;
  }
  return false;
}
float roleTexture(int role, vec3 p, vec3 n) {
  vec3 an = abs(n);
  float fw = length(fwidth(p));
  if (role == 8) {
    // bois : planches (largeur 13 cm, chacune sa teinte), joints sombres, veinage fin le long du fil (vertical sur
    // une face verticale : portes, palissades, poteaux ; selon x sur une face horizontale : platelages, tables)
    bool vert = an.y < 0.6;
    vec2 hz = normalize(vec2(-n.z, n.x) + vec2(1e-4, 0.0));
    float along = vert ? p.y : p.x;
    float across = vert ? dot(p.xz, hz) : p.z;
    float ac = across / 0.13, pl = floor(ac), fa = fract(ac);
    float tone = (hash12(vec2(pl, 7.0)) - 0.5) * 0.2;
    float seam = -0.3 * (1.0 - smoothstep(0.0, 0.05, min(fa, 1.0 - fa))) * octK(1.0 / 0.006, fw);
    float warp = fbm3(vec3(along * 0.7, across * 2.5, pl * 3.1));
    float veins = sin((across * 55.0 + warp * 7.0 + pl * 1.7)) * 0.5 * 0.1 * octK(9.0, fw);
    float fiber = (vnoise(vec3(along * 2.5, across * 120.0, pl)) - 0.5) * 0.08 * octK(120.0, fw);
    return tone * octK(4.0, fw) + seam + veins + fiber;
  }
  if (role == 9) { // écorce : fibres verticales serrées, crevasses
    float f = fbm3(vec3(p.x * 18.0, p.y * 2.4, p.z * 18.0)) * octK(18.0, fw);
    return (f - 0.5) * 0.3 + (vnoise(vec3(p.x * 50.0, p.y * 6.0, p.z * 50.0)) - 0.5) * 0.06 * octK(50.0, fw);
  }
  if (role == 4 || role == 5 || role == 6) { // pierre, enduit : grain fin d'abord, taches larges discrètes
    float f = (fbm3(p * 2.6) - 0.5) * 0.35 + (vnoise(p * 30.0) - 0.5) * 0.35 * octK(30.0, fw) + (vnoise(p * 85.0) - 0.5) * 0.3 * octK(85.0, fw);
    return f * (role == 4 ? 0.34 : 0.16);
  }
  if (role == 7) {
    // toiture en tuiles : rangs le long de la pente (16 cm exposés), tuiles de 21 cm posées en quinconce, chacune sa
    // nuance ; ombre du rang du dessus sur le haut de chaque tuile, lèvre claire en bas, joints fins, galbe léger
    vec2 hz = normalize(vec2(-n.z, n.x) + vec2(1e-4, 0.0));
    float sl = sqrt(max(0.04, 1.0 - n.y * n.y));
    float r = p.y / (0.16 * sl);
    float row = floor(r), fr = fract(r);
    float u = dot(p.xz, hz) / 0.21 + mod(row, 2.0) * 0.5;
    float col = floor(u), fu = fract(u);
    float kt = octK(1.0 / 0.16, fw);
    float tone = (hash12(vec2(col, row)) - 0.5) * 0.24 + (hash12(vec2(col * 0.37, row * 0.41)) - 0.5) * 0.06;
    float shade = -0.3 * smoothstep(0.78, 1.0, fr) + 0.07 * (1.0 - smoothstep(0.0, 0.1, fr));
    float joint = -0.22 * (1.0 - smoothstep(0.0, 0.05, min(fu, 1.0 - fu))) * octK(1.0 / 0.012, fw);
    float galbe = (sin(3.14159 * fu) - 0.64) * 0.1;
    float grain = (vnoise(p * 70.0) - 0.5) * 0.05 * octK(70.0, fw);
    // patine : coulures et lichens à grande échelle, discrets
    float age = (fbm3(vec3(p.x * 0.7, p.y * 1.6, p.z * 0.7)) - 0.5) * 0.12;
    return (tone + shade + joint + galbe) * kt + grain + age;
  }
  if (role <= 3) { // sol, herbe, chemin, chaussée : grandes plages + moucheture fine
    vec3 g = vec3(p.x, 0.0, p.z);
    float macro = fbm3(g * 0.35);
    float speck = vnoise(g * 26.0) * 0.6 + vnoise(g * 70.0) * 0.4;
    // touffes et mottes (~30 cm), moucheture fine effacée sous le pixel : le sol se lit sans faire grossier
    float clump = fbm3(g * 3.2);
    float fsp = 1.0 - smoothstep(0.004, 0.02, length(fwidth(p)));
    // grain fin de l'herbe (brins, ~1 et ~3 cm) plutôt que des taches : effacé dès qu'il tombe sous le pixel
    float fw = length(fwidth(p));
    float blades = (vnoise(g * 95.0) - 0.5) * (1.0 - smoothstep(0.002, 0.007, fw)) + (vnoise(g * 38.0) - 0.5) * 0.7 * (1.0 - smoothstep(0.005, 0.02, fw));
    return (macro - 0.5) * 0.4 + (clump - 0.5) * 0.12 + (speck - 0.5) * 0.16 * fsp + blades * 0.45;
  }
  if (role == 10 || role == 11) return (fbm3(p * 7.5) - 0.5) * 0.26 + (vnoise(p * 30.0) - 0.5) * 0.06;
  if (role >= 17 && role <= 19) { // tissus : trame fine (fils croisés), à peine de marbrure
    float weave = (sin(p.x * 420.0 + p.z * 37.0) * sin(p.y * 420.0 + p.x * 29.0)) * 0.5 + 0.5;
    // trame régulière : effacée dès qu'elle approche la taille du pixel (sinon moiré)
    weave = mix(0.5, weave, 1.0 - smoothstep(0.0012, 0.0025, length(fwidth(p))));
    // chiné (fils de teintes voisines, ~1 cm) : la matière se lit à distance moyenne sans motif régulier
    float fw = length(fwidth(p));
    float heather = (vnoise(p * 110.0) - 0.5) * (1.0 - smoothstep(0.002, 0.006, fw));
    // fils : stries courtes dans les deux sens du tissu (~1,5 cm), lisibles à mi-distance, effacées au loin
    float threads = (vnoise(vec3(p.x * 70.0, p.y * 14.0, p.z * 70.0)) + vnoise(vec3(p.x * 14.0, p.y * 70.0, p.z * 14.0)) - 1.0) * (1.0 - smoothstep(0.004, 0.012, fw));
    return (weave - 0.5) * 0.05 + heather * 0.09 + threads * 0.09 + (vnoise(p * 55.0) - 0.5) * 0.06 + (vnoise(p * 9.0) - 0.5) * 0.06;
  }
  if (role == 20) return (vnoise(p * 70.0) - 0.5) * 0.05 + (vnoise(p * 12.0) - 0.5) * 0.03; // cuir : grain serré
  if (role == 21) {
    // peau : nuances très douces (de larges taches font sale), grain et pores qui n'apparaissent que de près
    float fw = length(fwidth(p));
    float near = 1.0 - smoothstep(0.0006, 0.002, fw);
    float pores = smoothstep(0.62, 0.86, vnoise(p * 520.0)) * near;
    return (fbm3(p * 9.0) - 0.5) * 0.03 + (vnoise(p * 90.0) - 0.5) * 0.025 * (1.0 - smoothstep(0.002, 0.006, fw)) + (vnoise(p * 260.0) - 0.5) * 0.015 * near - pores * 0.004;
  }
  if (role == 22) return (vnoise(vec3(p.x * 90.0, p.y * 9.0, p.z * 90.0)) - 0.5) * 0.09 + (fbm3(p * 10.0) - 0.5) * 0.04; // cheveux : mèches claires et sombres
  if (role == 14) return (vnoise(vec3(p.x * 160.0, p.y * 4.0, p.z * 160.0)) - 0.5) * 0.08 + (fbm3(p * 6.0) - 0.5) * 0.1; // métal : brossé, patine
  if (role >= 32 || role == 26) return (vnoise(p * 40.0) - 0.5) * 0.05 + (fbm3(p * 5.0) - 0.5) * 0.06; // plastique, peint : grain, usure douce
  return (vnoise(p * 28.0) - 0.5) * 0.05 * octK(28.0, fw) + (vnoise(p * 80.0) - 0.5) * 0.03 * octK(80.0, fw);
}

void main() {
  int role = int(vRole + 0.5);
  // deux passes : l'eau est dessinée après la scène opaque, dont elle lit la couleur et la profondeur
  if (uWaterSplit > 0.5 && (uPass > 0.5) != (role == 13)) discard;
  // sol (objet 0, hors mer) ouvert au-dessus d'une piscine, d'une mare : on voit leur fond
  if (uHoleN > 0 && vObj < 0.5 && role != 13 && inHole(vPosW.xz)) discard;
  if (uHullN > 0 && role == 13 && inHull(vPosW.xz)) discard;
  vec3 base = uRoles[role];
  float texV = 0.0;
  #ifdef BLADE
  // dégradé du pied à la pointe ; fleurs : corolle colorée (la tige garde son dégradé), sinon variation de valeur
  vec3 tint = vTint.x > 0.5 ? uFlowers[int(vTint.x - 0.5)] : vec3(vTint.y);
  vec3 g = mix(uBladeBase, uBladeTip, smoothstep(0.0, 1.0, vBh));
  // prairie fleurie : les brins sans fleur gardent la pointe de la tige
  vec3 headCol = uFlowerHeads > 0.5 ? (vTint.x > 0.5 ? tint : uBladeTip) : uBladeTip * tint;
  base = mix(g * (uFlowerHeads > 0.5 ? vec3(1.0) : tint), headCol, vHead);
  #endif
  if (vBlend > 0.001) {
    float r2 = floor(vBlend + 0.0005);
    float k = clamp(vBlend - r2, 0.0, 1.0);
    k = smoothstep(0.15, 0.85, k + (vnoise(vPosW * 1.7) - 0.5) * 0.35);
    base = mix(base, uRoles[int(r2)], k);
  }
  // sol : roche sur les pentes, sable sur les berges (continu, bruité)
  if (role <= 2 || role == 29) {
    float slope = 1.0 - clamp(vNormalW.y, 0.0, 1.0);
    float rk = smoothstep(0.22, 0.42, slope + (vnoise(vPosW * 0.9) - 0.5) * 0.18);
    base = mix(base, uRoles[4] * 0.95, rk);
    if (uWaterY > -900.0) {
      float sh = 1.0 - smoothstep(0.05, 0.45, vPosW.y - uWaterY + (vnoise(vPosW * 1.3) - 0.5) * 0.25);
      base = mix(base, uRoles[2], sh * (1.0 - rk));
    }
  }
  // variation par objet / instance (± valeur, ± teinte) ; plus marquée sur les façades
  float var = vVar - 0.5;
  float vk = role == 5 ? 0.28 : role == 7 ? 0.2 : 0.1;
  base *= 1.0 + var * vk;
  base = mix(base, base * vec3(1.06, 1.0, 0.9), (vVar > 0.5 ? 1.0 : -0.6) * abs(var) * (role == 5 ? 0.9 : 0.1));
  // tissus, cuir, peau, cheveux : motif pris en repère local (il suit le corps animé au lieu de glisser dessus)
  vec3 tp = (role >= 17 && role <= 22) || role == 14 || role == 26 || role >= 32 ? vPosL : vPosW;
  texV = roleTexture(role, tp, vNormalW);
  // au loin, le grain fin s'efface (sous le pixel) : une variation de matière à grande échelle prend le relais pour
  // que la surface ne devienne pas plate (décor seulement : ni personnages, ni eau, ni verre, ni lumières)
  if (role <= 11 || role == 14 || role == 26 || role >= 32) {
    float far = smoothstep(0.015, 0.08, length(fwidth(tp)));
    texV += (fbm3(tp * 0.55 + 3.7) - 0.5) * 0.16 * far;
  }
  texV *= uTexture;
  // à l'ombre, le relief de la matière est plus doux (la part éclairée par le soleil le renforce, voir « lit »)
  base *= 1.0 + texV * 0.6;
  if (role == 1) {
    // herbe : plaques plus sèches (jaunies) et plus drues (vert sombre) : la teinte se lit mieux que la seule valeur
    float dry = smoothstep(0.4, 0.68, fbm3(vec3(vPosW.x, 0.0, vPosW.z) * 0.45));
    float lush = smoothstep(0.46, 0.74, fbm3(vec3(vPosW.x + 17.0, 0.0, vPosW.z - 9.0) * 0.8));
    // gazon entretenu (terrain de sport) : plaques très atténuées, bandes de tonte alternées
    float turf = uTurfW > 0.0 ? step(uTurf.x, vPosW.x) * step(vPosW.x, uTurf.z) * step(uTurf.y, vPosW.z) * step(vPosW.z, uTurf.w) : 0.0;
    float pk = 1.0 - 0.8 * turf;
    base = mix(base, base * vec3(1.22, 1.1, 0.66), min(1.0, dry * 1.5 * uTexture * pk));
    base = mix(base, base * vec3(0.7, 0.88, 0.74), min(1.0, lush * 1.3 * uTexture * pk));
    if (turf > 0.0) {
      float band = mod(floor((vPosW.x - uTurf.x) / uTurfW), 2.0);
      base *= mix(1.06, 0.88, band);
    }
  }
  vec3 N = normalize(vNormalW);
  if (!gl_FrontFacing) N = -N;
  // relief de détail procédural (pierre, enduit, toiture, bois, écorce, sol) : gradient d'un bruit, sans texture
  float bumpK = (role == 4 ? 0.55 : role == 5 || role == 6 ? 0.18 : role == 7 ? 0.0 : role == 8 || role == 9 ? 0.3 : role <= 3 ? 0.16 : 0.0) * uTexture * uDetail;
  if (bumpK > 0.0) {
    float fs = role == 7 ? 7.0 : role <= 3 ? 4.5 : 5.0;
    vec3 q = vPosW * fs;
    float n0 = fbm3(q);
    vec3 g = vec3(fbm3(q + vec3(0.05, 0.0, 0.0)) - n0, fbm3(q + vec3(0.0, 0.05, 0.0)) - n0, fbm3(q + vec3(0.0, 0.0, 0.05)) - n0) / 0.05;
    N = normalize(N - (g - N * dot(g, N)) * bumpK * 0.12);
    if (role <= 3) {
      // sol : petites mottes (~5 cm) en plus des ondulations, effacées quand elles passent sous le pixel
      float fk = 1.0 - smoothstep(0.003, 0.012, length(fwidth(vPosW)));
      vec3 q2 = vPosW * 48.0;
      float m0 = vnoise(q2);
      vec3 g2 = vec3(vnoise(q2 + vec3(0.1, 0.0, 0.0)) - m0, 0.0, vnoise(q2 + vec3(0.0, 0.0, 0.1)) - m0) / 0.1;
      N = normalize(N - (g2 - N * dot(g2, N)) * 0.025 * fk * uTexture * uDetail);
    }
  }
  // relief fin des personnages et accessoires (tissus, cuir, peau, cheveux, papier) : carte de hauteur procédurale
  // prise en repère local (elle ne glisse pas sur un corps qui bouge), appliquée par dérivées écran (bump sans UV,
  // Mikkelsen). Chaque échelle s'efface quand elle devient plus fine que le pixel (pas de moiré au loin).
  #ifndef BLADE
  float hK = (role >= 17 && role <= 19 ? 1.0 : role == 20 ? 0.9 : role == 21 ? 0.45 : role == 22 ? 1.0 : role == 28 ? 0.5 : role == 14 ? 0.9 : role == 26 || role >= 32 ? 0.7 : 0.0) * uTexture * uDetail;
  if (hK > 0.0) {
    vec3 q = vPosL;
    vec3 dpx = dFdx(vPosW), dpy = dFdy(vPosW);
    float fp = max(length(dpx), length(dpy));
    float fine = 1.0 - smoothstep(0.0018, 0.0055, fp);
    float mid = 1.0 - smoothstep(0.006, 0.03, fp);
    float h;
    if (role == 22) {
      // mèches : sillons fins le long des cheveux, puis ondulations larges (bruit non périodique : pas de moiré)
      float strand = 1.0 - smoothstep(0.0015, 0.005, fp);
      h = vnoise(vec3(q.x * 120.0, q.y * 14.0, q.z * 120.0)) * 0.006 * strand + fbm3(vec3(q.x * 30.0, q.y * 6.0, q.z * 30.0)) * 0.014 * mid;
    }
    else if (role == 21) {
      // peau : pores (creux fins, ~2 mm) et grain très serré de près, ondulations à peine marquées à mi-distance
      // (un visage bosselé fait sale)
      float pf = 1.0 - smoothstep(0.0005, 0.0016, fp);
      h = -smoothstep(0.62, 0.86, vnoise(q * 520.0)) * 0.00015 * pf + vnoise(q * 900.0) * 0.00012 * pf + vnoise(q * 220.0) * 0.0005 * fine + fbm3(q * 40.0) * 0.0012 * mid;
    }
    else if (role == 20) h = vnoise(q * 120.0) * 0.003 * fine + fbm3(vec3(q.x * 16.0, q.y * 42.0, q.z * 16.0)) * 0.012 * mid; // grain, plis du cuir
    else if (role == 28) h = vnoise(q * 90.0) * 0.001 * fine;
    else if (role == 14) h = vnoise(vec3(q.x * 300.0, q.y * 5.0, q.z * 300.0)) * 0.0007 * fine + fbm3(q * 11.0) * 0.006 * mid; // métal brossé, cabossé
    else if (role == 26 || role >= 32) h = vnoise(q * 140.0) * 0.0006 * fine + fbm3(q * 24.0) * 0.003 * mid; // plastique, peint : grain, ondulations
    else {
      // tissu : mailles (points en V en colonnes, ~7 mm) visibles de près seulement, sinon le motif régulier tombe sous
      // le pixel et moire ; à mi-distance un duvet de laine non périodique prend le relais ; plis et froissé
      float knitF = 1.0 - smoothstep(0.0011, 0.0022, fp);
      vec2 st = vec2((q.x + q.z) * 125.0, q.y * 150.0);
      float col = fract(st.x), row = fract(st.y + abs(col - 0.5) * 0.9);
      float knit = smoothstep(0.0, 0.35, row) * (1.0 - smoothstep(0.65, 1.0, row)) * (1.0 - abs(col - 0.5) * 1.2);
      float fuzz = fbm3(q * 85.0);
      float folds = fbm3(vec3(q.x * 8.0, q.y * 24.0, q.z * 8.0));
      h = knit * 0.003 * knitF + fuzz * 0.0045 * (1.0 - smoothstep(0.005, 0.02, fp)) + folds * 0.022 * mid + fbm3(q * 50.0) * 0.004 * mid;
    }
    // relief net mais sans assombrir les creux (les ombres de texture trop marquées font sale)
    h *= hK * 0.85;
    float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    if (abs(det) > 1e-12) N = normalize(abs(det) * N - sign(det) * (dhx * r1 + dhy * r2));
  }
  #endif
  // finis texturés (cartes tirées d'un motif du format monde) : relief, parallaxe, usure, occlusion des creux ; eau
  float finAO = 1.0, finWear = 0.0;
  vec4 fin2 = vec4(0.0);
  #ifndef BLADE
  if (uFinOn > 0.5) {
    vec3 dpx = dFdx(vPosW), dpy = dFdy(vPosW);
    vec3 dlx = dFdx(vPosL), dly = dFdy(vPosL);
    vec4 fin1 = texelFetch(uRoleFin, ivec2(role, 0), 0);
    fin2 = texelFetch(uRoleFin, ivec2(role, 1), 0);
    vec3 Vw = normalize(cameraPosition - vPosW);
    if (fin2.x > 0.5) {
      float layer = fin2.x - 1.0;
      vec3 an = abs(normalize(vNormL));
      vec3 p = vPosL * fin2.y, gx = dlx * fin2.y, gy = dly * fin2.y;
      int dom = an.x > an.y && an.x > an.z ? 0 : an.y > an.z ? 1 : 2;
      vec3 w = pow(an, vec3(4.0));
      w /= w.x + w.y + w.z;
      // empreinte du pixel dans le motif (tuiles) : au loin, ni parallaxe ni fondu (invisibles, coûteux)
      vec2 fux = axisUv(gx, dom), fuy = axisUv(gy, dom);
      float foot = max(length(fux), length(fuy));
      bool blend = uFinOn > 1.5 && max(w.x, max(w.y, w.z)) < 0.92 && foot < 0.1;
      float h = 0.0, dhx = 0.0, dhy = 0.0;
      if (blend) {
        // trois projections fondues (qualité haute : surfaces courbes)
        for (int a = 0; a < 3; a++) {
          if (w[a] < 0.02) continue;
          vec2 uv = axisUv(p, a), ux = axisUv(gx, a), uy = axisUv(gy, a);
          float h0 = finH(uv, ux, uy, layer);
          h += w[a] * h0;
          dhx += w[a] * (finH(uv + ux, ux, uy, layer) - h0);
          dhy += w[a] * (finH(uv + uy, ux, uy, layer) - h0);
        }
      } else {
        vec2 uv = axisUv(p, dom), ux = axisUv(gx, dom), uy = axisUv(gy, dom);
        float pk = fin1.y * (1.0 - smoothstep(0.015, 0.03, foot));
        if (pk > 0.0) {
          // parallaxe par couches (repère tangent tiré des dérivées écran, comme les finis de sonic-3d)
          vec3 Ng = normalize(cross(dpx, dpy));
          if (dot(Ng, Vw) < 0.0) Ng = -Ng;
          vec3 d2p = cross(dpy, Ng), d1p = cross(Ng, dpx);
          vec3 T = d2p * ux.x + d1p * uy.x, B = d2p * ux.y + d1p * uy.y;
          float inv = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-24));
          vec3 vt = normalize(vec3(dot(Vw, T * inv), dot(Vw, B * inv), dot(Vw, Ng)));
          int steps = uFinOn > 1.5 ? 14 : 6;
          float lay = 1.0 / float(steps);
          vec2 dUV = vt.xy / max(vt.z, 0.25) * pk * 0.08 * lay;
          vec2 cur = uv;
          float dAt = 1.0 - finH(cur, ux, uy, layer), d = 0.0;
          for (int i = 0; i < 14; i++) {
            if (i >= steps || d >= dAt) break;
            cur -= dUV;
            dAt = 1.0 - finH(cur, ux, uy, layer);
            d += lay;
          }
          vec2 prev = cur + dUV;
          float after = dAt - d, before = (1.0 - finH(prev, ux, uy, layer)) - d + lay;
          uv = mix(cur, prev, clamp(after / (after - before + 1e-5), 0.0, 1.0));
        }
        h = finH(uv, ux, uy, layer);
        dhx = finH(uv + ux, ux, uy, layer) - h;
        dhy = finH(uv + uy, ux, uy, layer) - h;
      }
      if (fin1.x > 0.0) {
        // relief : bosses de hauteur proportionnelle à la taille du motif (dérivées écran, sans repère tangent)
        float amp = fin1.x * 0.05 / max(fin2.y, 0.05);
        vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
        float det = dot(dpx, r1);
        vec3 grad = sign(det) * (dhx * amp * r1 + dhy * amp * r2);
        N = normalize(abs(det) * N - grad);
      }
      finAO = mix(1.0, 0.25 + 0.75 * pow(h, 0.6), fin1.w);
      finWear = fin1.z * h;
      base *= mix(1.0, finAO, 0.45);
    }
    if (fin2.z > 0.0 && fin2.w < 1.4) {
      // eau : rides qui défilent (gradient d'un bruit)
      vec3 q = vec3(vPosW.x * 2.3 + uTime * 0.35, uTime * 0.25, vPosW.z * 2.3 - uTime * 0.2);
      float n0 = vnoise(q);
      vec2 g = vec2(vnoise(q + vec3(0.07, 0.0, 0.0)) - n0, vnoise(q + vec3(0.0, 0.0, 0.07)) - n0) / 0.07;
      N = normalize(N - vec3(g.x, 0.0, g.y) * 0.12 * fin2.z);
    }
  }
  #endif
  // arêtes vives (courbure écran) : légère usure claire sur les saillants, lecture des volumes à petite échelle
  vec3 dn = fwidth(vNormalW);
  float edgeWear = clamp((dn.x + dn.y + dn.z) * 2.2, 0.0, 1.0) * uDetail;
  float ndl = dot(N, uSunDir);
  float sh = shadowAt(vShadow, ndl, role >= 21 && role <= 24 ? 6.0 : 1.0);
  float light;
  // touche de pinceau : plus fine (16 et 44 cycles/m) ; plus de taches de 15 cm qui déchirent les bandes d'ombre
  // personnages (tissus, cuir, peau, cheveux) : touche plus fine et plus légère, accrochée au corps (repère local :
  // ne glisse pas quand il bouge) ; sinon des taches de 6 cm déchiquettent les bandes d'ombre sur les vêtements
  bool chr = role >= 17 && role <= 25;
  vec3 bp = chr ? vPosL * 2.6 : vPosW;
  float brush = ((fbm3(bp * 16.0) - 0.5) * 0.75 + (vnoise(bp * 44.0) - 0.5) * 0.25) * uBrush * (chr ? 0.4 : 1.0);
  if (uShading < 0.5) light = clamp(ndl * 0.5 + 0.5, 0.0, 1.0) * 0.6 + 0.4;        // flat : lumière douce, sans bandes
  else if (uShading < 1.5) {                                                       // toon : bandes à seuil perturbé
    float x = clamp((ndl + brush * (role == 21 ? 0.25 : 1.0)) * 0.5 + 0.5, 0.0, 1.0);
    // personnages : ombre portée moins profonde (un visage passe vite au noir sous un chapeau ou une branche)
    x *= mix(1.0, chr ? 0.6 : 0.3, (1.0 - sh) * uShadowStrength);
    float k = x * uBands;
    // peau : transitions de bandes adoucies (un visage en marches dures paraît grossier)
    // vêtements : transitions adoucies aussi (une marche nette sur chaque pli fait des ombres en escalier)
    float bsoft = role == 21 ? max(uBandSoft, 0.32) : chr ? max(uBandSoft, 0.2) : uBandSoft;
    float q = (floor(k) + smoothstep(1.0 - max(bsoft * uBands, 0.001), 1.0, fract(k))) / uBands;
    light = clamp(q * uBands / (uBands - 1.0), 0.0, 1.0);
    // peau : dégradé continu (une bande, même adoucie, découpe le visage en plaques au bord déchiqueté), à peine
    // resserré pour garder la lecture peinte du style
    if (role == 21) {
      float c = clamp((x * uBands - 0.5) / (uBands - 1.0), 0.0, 1.0);
      light = mix(c * c * (3.0 - 2.0 * c), light, 0.15);
    }
  } else {
    light = clamp(ndl + brush * 0.5, 0.0, 1.0);
    light = mix(light, light * light * (3.0 - 2.0 * light), uShading < 2.5 ? 0.6 : 0.0);
  }
  float shadow = mix(1.0, sh, uShadowStrength * (chr ? 0.55 : 1.0));
  if (uShading > 0.5 && uShading < 1.5) shadow = 1.0; // déjà dans les bandes
  float ao = (role == 13 ? 1.0 : mix(1.0, vAO, uAOStrength * (chr ? 0.6 : 1.0))) * finAO;
  // contact au sol : assombrit le pied des objets
  float contact = 1.0 - (1.0 - smoothstep(0.0, 0.35, vPosW.y - uGroundY)) * 0.18 * uAOStrength * step(0.2, abs(N.y - 1.0));
  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5);
  // texture : relief plus marqué au soleil qu'à l'ombre (0,6 de la variation dans la part ambiante, 1,3 au soleil)
  vec3 lit = base * (amb * (chr ? 0.7 : 0.62) * ao * contact + uSun * light * shadow * mix(0.85, 1.0, ao) * (1.0 + texV * 0.7));
  vec3 Vv = normalize(cameraPosition - vPosW);
  if (role == 21) {
    // peau : diffusion sous la surface. La lumière déborde dans l'ombre (rougie : le rouge porte plus loin que le vert
    // et le bleu) et réchauffe le terminateur ; les creux restent un peu plus marqués
    vec3 wrapK = vec3(0.42, 0.2, 0.12);
    vec3 wrapL = clamp((vec3(ndl) + wrapK) / (1.0 + wrapK), 0.0, 1.0) - vec3(clamp(ndl, 0.0, 1.0));
    float term = exp(-pow(ndl * 2.6, 2.0));
    lit += base * uSun * (wrapL * 0.55 + vec3(0.2, 0.06, 0.025) * term) * mix(1.0, sh, uShadowStrength * 0.6);
    lit *= mix(1.0, 0.86, 1.0 - ao);
    // reflets : deux lobes (film gras net + peau plus mate), Fresnel du ciel sur les bords ; bandes : reflet plus discret
    if (uShading > 0.5) {
      vec3 Hs = normalize(uSunDir + Vv);
      float nh = max(dot(N, Hs), 0.0), nv = max(dot(N, Vv), 0.0);
      float F = 0.028 + 0.972 * pow(1.0 - max(dot(Vv, Hs), 0.0), 5.0);
      float a1 = 0.09, a2 = 0.2;
      float D1 = a1 / (3.14159 * pow(nh * nh * (a1 - 1.0) + 1.0, 2.0));
      float D2 = a2 / (3.14159 * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
      float spec = (D1 * 0.3 + D2 * 0.5) * 0.25 * max(ndl, 0.0) * F;
      float sk = uShading < 1.5 ? 0.55 : 1.0;
      lit += uSun * min(spec, 1.5) * sk * mix(1.0, sh, uShadowStrength) * ao;
      lit += mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * pow(1.0 - nv, 4.0) * 0.12 * sk * ao;
    }
  }
  if (role == 31 && uShading > 0.5) {
    // lèvres (seul usage de ce rôle sur un personnage) : humides, reflet net et un peu de lumière diffusée
    vec3 Hs = normalize(uSunDir + Vv);
    float nh = max(dot(N, Hs), 0.0), nv = max(dot(N, Vv), 0.0);
    float a = 0.05;
    float D = a / (3.14159 * pow(nh * nh * (a - 1.0) + 1.0, 2.0));
    lit += uSun * min(D * 0.25 * max(ndl, 0.0), 3.0) * 0.12 * mix(1.0, sh, uShadowStrength) * ao;
    lit += mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * pow(1.0 - nv, 4.0) * 0.1 * ao;
    lit += base * uSun * vec3(0.12, 0.03, 0.02) * exp(-pow(ndl * 2.6, 2.0));
  }
  if (role == 22 && uShading > 0.5) {
    // cheveux : reflets en bande le long des mèches (Kajiya-Kay), mèches supposées descendre du sommet du crâne ;
    // un reflet blanc net et un second, plus large, teinté par la couleur des cheveux
    // normale lisse (sans le relief des mèches) : sinon le reflet suit chaque bosse et fait des traînées grasses
    vec3 Ng0 = normalize(vNormalW) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 Tn = vec3(0.0, 1.0, 0.0) - Ng0 * Ng0.y;
    Tn = length(Tn) > 1e-3 ? normalize(Tn) : vec3(0.0, 0.0, 1.0);
    float jit = (vnoise(vec3(vPosL.x * 320.0, vPosL.y * 12.0, vPosL.z * 320.0)) - 0.5) * 0.3 + (vnoise(vec3(vPosL.x * 60.0, vPosL.y * 4.0, vPosL.z * 60.0)) - 0.5) * 0.12;
    vec3 Hs = normalize(uSunDir + Vv);
    float th1 = dot(normalize(Tn + Ng0 * (0.08 + jit)), Hs), th2 = dot(normalize(Tn - Ng0 * (0.12 - jit)), Hs);
    float s1 = pow(sqrt(max(0.0, 1.0 - th1 * th1)), 160.0), s2 = pow(sqrt(max(0.0, 1.0 - th2 * th2)), 28.0);
    float vis = smoothstep(-0.1, 0.4, ndl) * mix(1.0, sh, uShadowStrength) * ao;
    float hk = uShading < 1.5 ? 0.6 : 1.0;
    lit += (uSun * s1 * 0.07 + base * uSun * s2 * 0.22) * vis * hk;
  }
  if (chr || role == 31) {
    // personnages : lumière d'appoint venue de l'observateur (réflecteur de portrait) : le côté à l'ombre d'un visage
    // reste lisible au lieu de tomber dans le noir
    lit += base * (uSun * 0.16 + uAmbSky * 0.1) * max(dot(N, Vv), 0.0) * mix(0.6, 1.0, ao);
  }
  if (role == 23 || role == 24) {
    // yeux : globe humide. Blanc ombré vers les bords (il est rond), reflet net du soleil et du ciel sur la cornée
    float nv = max(dot(N, Vv), 0.0);
    if (role == 24) lit *= mix(0.78, 1.0, smoothstep(0.15, 0.75, nv));
    vec3 Hs = normalize(uSunDir + Vv);
    float nh = max(dot(N, Hs), 0.0);
    float a = 0.004;
    float D = a / (3.14159 * pow(nh * nh * (a - 1.0) + 1.0, 2.0));
    float F = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    lit += uSun * min(D * 0.25 * max(ndl, 0.0), 6.0) * 0.5 * mix(1.0, sh, uShadowStrength);
    lit += mix(uAmbGround, uAmbSky * 1.2, smoothstep(-0.2, 0.4, reflect(-Vv, N).y)) * F * 0.5;
  }
  lit *= 1.0 + edgeWear * 0.16 * (role >= 21 && role <= 25 ? 0.0 : 1.0);
  // lumières ponctuelles (feux, lampes, fenêtres) : chaudes, surtout la nuit
  vec3 pl = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    if (float(i) >= uLightCount) break;
    vec3 Ld = uLightPos[i].xyz - vPosW;
    float d = length(Ld);
    float r = uLightPos[i].w;
    float att = clamp(1.0 - d / r, 0.0, 1.0);
    att *= att;
    float flick = 1.0 + uLightCol[i].w * (sin(uTime * 11.0 + float(i) * 3.1) * 0.5 + sin(uTime * 17.3 + float(i)) * 0.3) * 0.18;
    float nl = uShading > 0.5 && uShading < 1.5 ? step(0.0, dot(N, Ld / max(d, 1e-3))) * 0.8 + 0.2 : clamp(dot(N, Ld / max(d, 1e-3)) * 0.8 + 0.2, 0.0, 1.0);
    pl += uLightCol[i].rgb * att * nl * flick;
  }
  lit += base * pl * (0.35 + uNight * 1.4) * ao;
  // contre-jour
  vec3 V = normalize(cameraPosition - vPosW);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * uRim;
  lit += uAmbSky * rim * 0.35 * ao;
  // fini du rôle : reflet du soleil (GGX), reflet du ciel selon la rugosité, métal qui teinte ses reflets, tissu, vernis
  vec4 rm = uRoleMat[role];
  if (rm.x > 0.5) {
    float rough = clamp((rm.x - 1.0) * (1.0 - finWear), 0.03, 1.0);
    float metal = rm.y;
    vec3 Hs = normalize(uSunDir + V);
    float nh = max(dot(N, Hs), 0.0), nv = max(dot(N, V), 0.0);
    float a2 = pow(rough * rough, 2.0);
    float Dg = a2 / (3.14159 * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
    vec3 F0 = mix(vec3(0.04), base, metal);
    vec3 Fs = F0 + (1.0 - F0) * pow(1.0 - max(dot(V, Hs), 0.0), 5.0);
    float sunSpec = Dg * 0.25 * max(ndl, 0.0);
    // style à bandes : reflet franc plutôt que dégradé
    if (uShading > 0.5 && uShading < 1.5) sunSpec = step(0.5, sunSpec * rough) * 2.0;
    vec3 R = reflect(-V, N);
    vec3 env = mix(uAmbGround * 0.8, uAmbSky * 1.35 + uSun * 0.15, smoothstep(-0.25, 0.35, R.y));
    // studio : pièce claire et neutre, deux boîtes à lumière (bandes nettes dans les reflets)
    if (uEnv > 0.5) env = mix(vec3(0.22), vec3(0.95), smoothstep(-0.3, 0.5, R.y)) + vec3(2.2) * smoothstep(0.93, 0.97, abs(R.x)) * step(0.0, R.y);
    else if (uEnv < -0.5) env = mix(uAmbGround, uAmbSky, 0.5) * 0.6;
    env = mix(env, mix(uAmbGround, uAmbSky, 0.5), rough);
    vec3 Fe = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - nv, 5.0);
    lit *= 1.0 - metal * 0.85;
    lit += uSun * Fs * sunSpec * shadow + env * Fe * (1.0 - rough * 0.7) * ao;
    lit += base * uAmbSky * rm.z * pow(1.0 - nv, 2.0) * 0.5 * ao;
    if (rm.w > 0.0) {
      float ac = 0.0064;
      float Dc = ac / (3.14159 * pow(nh * nh * (ac - 1.0) + 1.0, 2.0));
      float Fc = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
      lit += (uSun * Dc * 0.25 * max(ndl, 0.0) * shadow + env * Fc) * rm.w * 0.6;
    }
  }
  // verre, eau (fini du format) : rendu opaque, fond assombri teinté vu au travers, reflet de Fresnel du ciel et du soleil
  if (fin2.z > 0.0) {
    float nv = max(dot(N, V), 0.0);
    float f0 = pow((fin2.w - 1.0) / (fin2.w + 1.0), 2.0);
    float fr = f0 + (1.0 - f0) * pow(1.0 - nv, 5.0);
    vec3 R = reflect(-V, N);
    vec3 env = mix(uAmbGround * 0.7, mix(uFogColor, uAmbSky * 1.3, smoothstep(0.05, 0.7, R.y)), smoothstep(-0.2, 0.15, R.y));
    vec3 behind = base * mix(uAmbGround, uFogColor, 0.5) * 0.6 * ao;
    float rough = rm.x > 0.5 ? clamp(rm.x - 1.0, 0.02, 1.0) : 0.05;
    vec3 Hs = normalize(uSunDir + V);
    float nh = max(dot(N, Hs), 0.0);
    float a2 = pow(rough * rough, 2.0);
    float spec = min(a2 / (3.14159 * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0)) * 0.25 * max(ndl, 0.0), 40.0);
    vec3 glassCol = mix(behind, env, clamp(fr + 0.08, 0.0, 1.0)) + uSun * spec * fr * mix(1.0, sh, uShadowStrength);
    lit = mix(lit, glassCol, fin2.z);
  }
  // émissifs : lampes, feu, fenêtres allumées la nuit
  float emiss = 0.0;
  if (role == 16 || role == 30) emiss = 0.55 + uNight * uLamps * 1.4;
  else if (role == 15) emiss = uNight * uLamps * step(0.45, hash13(floor(vPosW * 1.7) + vObj)) * 1.1;
  if (role == 30) {
    if (N.y > 0.55) {
      // lave (nappe, coulée) : croûte sombre en plaques qui dérivent lentement, fissures incandescentes qui palpitent
      vec2 lp = vPosW.xz * 0.9 + vec2(uTime * 0.05, uTime * 0.03);
      float c1 = vnoise(vec3(lp, uTime * 0.04)), c2 = vnoise(vec3(lp * 2.6 + 4.0, uTime * 0.07));
      float crust = smoothstep(0.42, 0.62, c1 * 0.65 + c2 * 0.35);
      float crack = 1.0 - smoothstep(0.0, 0.07, abs(c1 - 0.52));
      vec3 hot = base * vec3(1.6, 1.05, 0.6) * (1.25 + 0.2 * sin(uTime * 2.1 + c2 * 9.0));
      vec3 cool = vec3(0.09, 0.06, 0.05) * (amb * 0.8 + uSun * 0.3 * max(ndl, 0.0));
      lit = mix(hot, cool, crust * (1.0 - crack));
      lit += hot * crack * crust * 0.6;
    } else lit = base * (1.2 + 0.25 * sin(uTime * 13.0 + vPosW.x * 9.0));
  }
  lit = mix(lit, base * (1.0 + emiss), clamp(emiss, 0.0, 1.0));
  // eau : surface transparente. Fond vu à travers (réfraction par la normale des vagues), lumière absorbée selon
  // l'épaisseur d'eau traversée (rouge d'abord : turquoise sur les hauts-fonds, bleu profond au large), caustiques
  // sur le fond, reflet du ciel selon l'angle (Fresnel), reflet du soleil, écume au bord et sur les crêtes
  if (role == 13) {
    vec3 Vd = normalize(vPosW - cameraPosition);
    vec3 Nw = N;
    // rides fines par-dessus la houle (deux couches qui dérivent), plus fortes sur la mer
    // rides : plus fortes sur la mer, presque rien dans une flaque (agitation propre à la surface)
    float rk = (uWaterKind > 0.5 ? 0.22 : 0.12) * vAgit;
    // rides : six petites vagues de directions variées (pente analytique : ni grille ni facettes, pas de dérive dans une
    // seule direction), vitesse de la dispersion en eau profonde, phase brouillée lentement pour casser la régularité
    vec2 rp = vPosW.xz;
    float fwW = length(fwidth(vPosW));
    float warp = vnoise(vec3(rp * 0.35, uTime * 0.05)) * 6.0;
    vec2 rg = vec2(0.0);
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float ang = fi * 2.39996 + 0.3;
      vec2 D = vec2(cos(ang), sin(ang));
      float L = 0.45 + fi * 0.3;
      float k = 6.2831 / L;
      float ph = k * dot(D, rp) - sqrt(9.81 * k) * 0.3 * uTime + fi * 1.3 + warp * (0.6 + fi * 0.15);
      rg += D * cos(ph) * 0.03 * octK(1.0 / L, fwW);
    }
    rg *= rk * 4.0;
    if (Nw.y > 0.3) Nw = normalize(Nw - vec3(rg.x, 0.0, rg.y));
    // lame d'eau verticale (chute, cascade) : filets d'écume qui défilent vers le bas ; jamais sur la mer (sa tranche
    // au bord du socle est verticale mais immobile)
    float fallK = uWaterKind > 0.5 ? 0.0 : 1.0 - smoothstep(0.35, 0.6, abs(N.y));
    // sans passe d'eau (monde infini, rendu de secours) : pas de scène à lire, eau opaque teintée par la profondeur
    bool see = uPass > 0.5;
    vec2 suv = gl_FragCoord.xy / uViewport;
    vec4 sd0 = see ? texture(tSceneData, suv) : vec4(0.0, 0.0, (vViewZ + 2.0 + 6.0 * vAO) / uFar, 0.0);
    float dS0 = sd0.z > 0.0 ? sd0.z * uFar : 1e4;
    float th0 = max(0.0, dS0 - vViewZ);
    // réfraction : décalage écran selon la pente de la surface, borné par l'épaisseur ; refusé s'il tombe sur un objet
    // placé devant l'eau
    // (rides seules, décalage de quelques pixels : la pente de la houle dédoublait les corps à moitié immergés)
    vec2 ruv = suv + (mat3(viewMatrix) * vec3(rg.x, 0.0, rg.y)).xy * vec2(-1.0, 1.0) * 0.08 * clamp(th0, 0.0, 0.6);
    vec4 sd = see ? texture(tSceneData, ruv) : sd0;
    float dS = sd.z > 0.0 ? sd.z * uFar : 1e4;
    if (dS < vViewZ) { ruv = suv; sd = sd0; dS = dS0; }
    float thick = max(0.0, dS - vViewZ);
    vec3 bottom = see ? texture(tSceneColor, ruv).rgb : base * amb * 0.5;
    // point du fond vu, profondeur verticale sous la surface
    vec3 bp = vPosW + Vd * min(thick, 60.0);
    float below = max(0.0, vPosW.y - bp.y);
    // caustiques projetées sur le fond, plus nettes près de la surface, effacées en profondeur et au loin
    // (parois verticales : la hauteur entre dans les coordonnées, sinon le motif s'étire en traînées)
    vec2 cp = bp.xz + vec2(bp.y * 1.3, -bp.y * 0.9);
    float cau = caustic(cp * 2.3, uTime * 0.7) * 0.6 + caustic(cp * 3.9 + 11.0, uTime * 0.9) * 0.4;
    // eau posée : trouble (mare) ou limpide (piscine) selon l'AO de ses sommets ; la mer garde l'AO pour sa profondeur
    float murk = uWaterKind > 0.5 ? 0.0 : clamp(1.0 - vAO, 0.0, 1.0);
    bottom *= 1.0 + cau * 0.28 * exp(-below * 0.7) * octK(2.7, fwW) * (sh * 0.7 + 0.3) * (1.0 - murk * 0.8);
    // absorption (m⁻¹, par canal) : l'eau d'une piscine reste claire, la mer verdit puis bleuit, la mare brunit
    vec3 absorb = uWaterKind > 0.5 ? vec3(0.42, 0.13, 0.085) : mix(vec3(0.3, 0.07, 0.045), vec3(1.7, 1.05, 2.0), murk);
    vec3 T = exp(-absorb * thick);
    vec3 deep = mix(base, vec3(0.24, 0.3, 0.15), murk * 0.75) * (amb * 0.62 + uSun * 0.35 * max(ndl, 0.0)) * 0.9;
    vec3 body = bottom * T + deep * (1.0 - T);
    // reflet : ciel (horizon → zénith) ; reflet du soleil net, étalé par les rides
    vec3 R = reflect(Vd, Nw);
    vec3 sky = mix(uFogColor, uAmbSky * 1.15, smoothstep(-0.05, 0.6, R.y));
    float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(Nw, -Vd), 0.0, 1.0), 5.0);
    vec3 col = mix(body, sky, F);
    col += uSun * pow(max(dot(R, uSunDir), 0.0), uWaterKind > 0.5 ? 220.0 : 500.0) * (uWaterKind > 0.5 ? 2.2 : 3.0) * mix(1.0, sh, uShadowStrength);
    // écume : liseré au contact du bord (épaisseur verticale faible), bouillonnant, et crêtes de la houle
    // liseré fin là où l'eau n'a que quelques centimètres (la houle le fait aller et venir), dentelé, jamais en plaque
    float edge = (1.0 - smoothstep(0.0, 0.05 + 0.06 * vnoise(vec3(vPosW.xz * 2.0, uTime * 0.3)), below)) * smoothstep(0.3, 0.6, vnoise(vec3(vPosW.xz * 5.0, uTime * 0.25)) * 0.7 + 0.3);
    // crêtes : seulement sur la mer agitée (vent, grande étendue), écume qui naît au sommet et reste posée sur l'eau
    // (motif fixe qui s'éteint lentement, il ne glisse pas avec la vague), en traînées fines plutôt qu'en taches
    float crest = 0.0;
    if (uWaterKind > 0.5 && uWaveAmp > 0.0) {
      float hc = waveCrest(vPosW.xz);
      float strong = smoothstep(0.25, 0.9, uWaveAmp * vAgit) * smoothstep(0.0, 0.3, vAO);
      vec2 fp = vPosW.xz * vec2(1.7, 0.9);
      float lace = vnoise(vec3(fp * 2.2, uTime * 0.05)) * 0.65 + vnoise(vec3(fp * 6.5, 7.0 + uTime * 0.08)) * 0.35;
      crest = smoothstep(0.5, 0.85, hc) * smoothstep(0.5, 0.72, lace) * strong * octK(6.5, fwW);
    }
    float foam = clamp(edge * (0.55 + 0.45 * vnoise(vec3(vPosW.xz * 6.0, uTime * 1.1))) * (uWaterKind > 0.5 ? 0.6 * smoothstep(0.45, 1.0, vAgit) : 0.35 * murk) + crest * 0.55, 0.0, 1.0);
    col = mix(col, (amb * 0.62 + uSun * mix(1.0, sh, uShadowStrength)) * 0.95, foam * 0.85);
    if (fallK > 0.0) {
      vec2 fp = vec2(vPosW.x * 3.0 + vPosW.z * 3.0, vPosW.y * 0.7 + uTime * 2.6);
      float streak = smoothstep(0.55, 0.85, vnoise(vec3(fp.x, fp.y, 0.0)) * 0.6 + vnoise(vec3(fp.x * 2.3, fp.y * 1.7, 3.0)) * 0.4);
      col = mix(col, (amb * 0.7 + uSun * 0.6) * 0.95, fallK * (0.25 + streak * 0.6));
    }
    lit = col;
    // nageurs : rides concentriques qui s'éloignent, écume autour du corps (plus forte quand on nage vite)
    for (int i = 0; i < 8; i++) {
      if (i >= uSwimN) break;
      vec4 sw = uSwim[i];
      if (sw.z < 0.0) {
        // plongeur : son corps se voit déjà à travers l'eau (réfraction) ; seules les bulles remontent devant sa tête
        vec2 fw = vec2(sin(sw.w), cos(sw.w));
        vec2 hb = vPosW.xz - (sw.xy + fw * 1.15);
        float bub = (1.0 - smoothstep(0.02, 0.07, length(hb + 0.12 * vec2(sin(uTime * 2.3), cos(uTime * 1.7)) * fract(uTime * 0.9))));
        bub += (1.0 - smoothstep(0.02, 0.05, length(hb - 0.1 * vec2(cos(uTime * 1.9), sin(uTime * 2.6)) * fract(uTime * 1.3 + 0.4))));
        lit = mix(lit, uSun * 0.95, clamp(bub, 0.0, 1.0) * 0.8);
        continue;
      }
      float r = length(vPosW.xz - sw.xy);
      if (r > 4.0) continue;
      float ring = sin(r * 13.0 - uTime * 7.0 + sw.w) * exp(-r * 1.3) * (0.45 + 0.55 * min(sw.z, 1.5));
      lit += uSun * max(ring, 0.0) * 0.16;
      float splash = (1.0 - smoothstep(0.12, 0.45 + 0.35 * min(sw.z, 1.5), r)) * (0.3 + 0.5 * min(sw.z, 1.2)) * (0.75 + 0.25 * vnoise(vec3(vPosW.xz * 9.0, uTime * 3.0)));
      lit = mix(lit, uSun * 0.95, clamp(splash, 0.0, 0.75));
    }
  }
  // brouillard profondeur + hauteur, couleur d'horizon
  float fz = clamp((vViewZ - uFogNear) / max(uFogRange, 1.0), 0.0, 3.0);
  float fd = 1.0 - exp(-pow(fz * uFog * 1.6, 1.6));
  float fh = exp(-max(vPosW.y - uGroundY, 0.0) * (1.0 + 3.0 / max(uFogHeight, 0.05)) * 0.15) * uFog * uFogHeight * 0.5;
  float fogK = clamp(fd + fh * fd * 2.0, 0.0, 0.92);
  lit = mix(lit, uFogColor, fogK);
  if (uHighlight > 0.5 && abs(vObj - uIdBase) < 0.5) lit = uHighlight > 1.5 ? mix(lit, vec3(1.0, 0.18, 0.12), 0.6) : mix(lit, vec3(1.0, 0.85, 0.45), 0.25);
  outColor = vec4(lit, 1.0);
  vec3 nv = normalize(mat3(viewMatrix) * N);
  outData = vec4(nv.xy * 0.5 + 0.5, vViewZ / uFar, fract(vObj * 0.0731 + 0.1));
  #ifdef BLADE
  // brins : identifiant réservé (1, jamais atteint par fract) : pas de contour dans la prairie
  outData.w = 1.0;
  #endif
}
`;

export const DEPTH_FRAGMENT = /* glsl */ `
precision highp float;
flat in float vRole;
flat in float vObj;
in vec3 vPosW;
layout(location = 0) out vec4 outColor;
// ouvertures du sol au-dessus des fonds d'eau : A = (x, z, hx, hz), B = (cos lacet, sin lacet, forme, graine)
uniform vec4 uHoleA[16];
uniform vec4 uHoleB[16];
uniform int uHoleN;
bool inHole(vec2 p) {
  for (int i = 0; i < 16; i++) {
    if (i >= uHoleN) break;
    vec4 a = uHoleA[i], b = uHoleB[i];
    vec2 d = p - a.xy;
    vec2 l = vec2(d.x * b.x - d.y * b.y, d.x * b.y + d.y * b.x) / a.zw;
    // rond (1) ; ondulé comme la berge d'une mare (2, graine en w)
    float w = b.z > 1.5 ? 1.0 + 0.06 * sin(atan(l.y, l.x) * 3.0 + b.w) + 0.04 * sin(atan(l.y, l.x) * 5.0 + b.w * 2.0) : 1.0;
    if (b.z > 0.5 ? dot(l, l) < w * w : max(abs(l.x), abs(l.y)) < 1.0) return true;
  }
  return false;
}
// l'eau, transparente, ne porte pas d'ombre (son fond reste éclairé) ; le sol ouvert non plus
void main() {
  if (vRole > 12.5 && vRole < 13.5) discard;
  if (uHoleN > 0 && vObj < 0.5 && inHole(vPosW.xz)) discard;
  outColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
}
`;

export const POST_VERTEX = /* glsl */ `
precision highp float;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const POST_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tColor;
uniform sampler2D tData;
uniform vec2 uTexel;
uniform float uOutline;
uniform float uOutlineStrength;
/** Contours effacés avec la profondeur (début, fin, en part de uFar) : monde infini, contours fondus dans le brouillard. */
uniform vec2 uOutlineFade;
uniform vec3 uInk;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform float uSkyOn;
uniform float uHorizonY;
uniform float uGrain;
uniform float uPaper;
uniform float uVignette;
uniform float uTime;
uniform float uPixel;
uniform vec2 uResolution;
// écran → cible de rendu (marge et reste sous-texel du rendu pixel accroché au monde ; identité sinon)
uniform vec4 uUvXf;
// rendu soigné (render/photo.ts) : image tracée ou accumulée, poids du fondu ; brume reposée sur l'image tracée
uniform sampler2D tPhoto;
uniform float uPhotoMix;
uniform float uPhotoFog;
uniform vec3 uFogColor;
uniform vec4 uFogK;
// occlusion ambiante en espace écran (profondeur linéaire de tData) : force, pixels par mètre (perspective à 1 m,
// orthographique), distance lointaine de la caméra
uniform float uAo;
uniform float uAoFocal;
uniform float uAoOrtho;
uniform float uFarP;
${COMMON}
const vec2 AO_DISK[12] = vec2[](vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621), vec2(0.962, -0.195), vec2(0.473, -0.480),
  vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));

vec4 dataAt(vec2 uv) { return texture(tData, uv); }

void main() {
  vec2 uv = vUv * uUvXf.xy + uUvXf.zw;
  if (uPixel > 0.5) uv = (floor(uv * uResolution / uPixel) + 0.5) * uPixel / uResolution;
  vec4 c = texture(tColor, uv);
  vec4 d = dataAt(uv);
  bool bg = d.z <= 0.0 || d.z >= 0.999;
  if (uPhotoMix > 0.0 && !bg) {
    vec3 p = texture(tPhoto, uv).rgb;
    if (uPhotoFog > 0.5) {
      // uFogK = (far, début, étendue, densité) : la brume de profondeur de la scène (sans la part en hauteur)
      float fz = clamp((d.z * uFogK.x - uFogK.y) / max(uFogK.z, 1.0), 0.0, 3.0);
      p = mix(p, uFogColor, clamp(1.0 - exp(-pow(fz * uFogK.w * 1.6, 1.6)), 0.0, 0.92));
    }
    c.rgb = mix(c.rgb, p, uPhotoMix);
  }
  // Le ciel est peint ici, sous la scène : la cible est effacée en noir transparent et un objet écrit alpha = 1.
  // Couleur prémultipliée par la couverture : particules devant le ciel, et bords de silhouette en anticrénelage
  // (MSAA : un pixel à moitié couvert vaut la moitié de sa couleur, alpha 0,5). Sans ce mélange, ces bords
  // prenaient du noir (liseré sombre autour des arbres, des brins et du bout du terrain contre le ciel).
  float t = clamp((vUv.y - uHorizonY) / max(1.0 - uHorizonY, 0.1), 0.0, 1.0);
  vec3 sky = uSkyOn > 0.5 ? mix(uSkyHorizon, uSkyTop, pow(t, 0.7)) : uSkyHorizon;
  vec3 col = sky * (1.0 - clamp(c.a, 0.0, 1.0)) + c.rgb;
  // occlusion ambiante : un voisin plus proche de la caméra de quelques centimètres couvre ce point (plis, aisselles,
  // cou, jonctions au sol) ; rayon d'environ 20 cm ramené en pixels selon la profondeur
  if (uAo > 0.0 && !bg && d.w < 0.999) {
    float zm = d.z * uFarP;
    float ppm = uAoOrtho > 0.0 ? uAoOrtho : uAoFocal / max(zm, 0.05);
    float radPx = clamp(0.2 * ppm, 2.0, 48.0);
    float a = hash13(vec3(gl_FragCoord.xy, 3.0)) * 6.2831;
    mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
    // paires de voisins opposés : seule la courbure (creux) compte, un plan incliné vu en biais ne s'assombrit pas.
    // Seuil proportionnel à la distance : la profondeur stockée en demi-flottant a des paliers de quelques
    // centimètres au loin (sinon bandes et rayures sur le sol et les murs)
    float occ = 0.0;
    float q = max(0.012, zm * 0.004);
    for (int i = 0; i < 6; i++) {
      vec2 o = R * AO_DISK[i] * radPx * uTexel;
      vec4 s1 = dataAt(uv + o), s2 = dataAt(uv - o);
      if (s1.z <= 0.0 || s1.z >= 0.999 || s2.z <= 0.0 || s2.z >= 0.999) continue;
      float a1 = (d.z - s1.z) * uFarP, a2 = (d.z - s2.z) * uFarP;
      float dz = (a1 + a2) * 0.5;
      occ += smoothstep(q, q * 5.0, dz) * (1.0 - smoothstep(0.3, 0.6, max(a1, a2)));
    }
    col *= 1.0 - uAo * 0.55 * (occ / 6.0);
  }
  // contours : silhouette (profondeur, identifiant) plus épaisse que les plis (normales)
  if (uOutlineStrength > 0.0 && uOutline > 0.0) {
    float edgeS = 0.0, edgeC = 0.0;
    vec2 px = uTexel * max(uPixel, 1.0);
    bool blade = d.w > 0.999;
    for (int k = 0; k < 2; k++) {
      float r = k == 0 ? uOutline : uOutline * 0.55;
      vec4 a = dataAt(uv + vec2(r, 0.0) * px), b = dataAt(uv - vec2(r, 0.0) * px);
      vec4 e = dataAt(uv + vec2(0.0, r) * px), f = dataAt(uv - vec2(0.0, r) * px);
      float z = max(d.z, 1e-4);
      if (k == 0) {
        float dz = max(max(abs(a.z - d.z), abs(b.z - d.z)), max(abs(e.z - d.z), abs(f.z - d.z))) / z;
        float did = max(max(abs(a.w - d.w), abs(b.w - d.w)), max(abs(e.w - d.w), abs(f.w - d.w)));
        blade = blade || max(max(a.w, b.w), max(e.w, f.w)) > 0.999;
        bool nearBg = a.z <= 0.0 || b.z <= 0.0 || e.z <= 0.0 || f.z <= 0.0 || a.z >= 0.999 || b.z >= 0.999 || e.z >= 0.999 || f.z >= 0.999;
        edgeS = max(smoothstep(0.035, 0.09, dz), (did > 0.002 ? 1.0 : 0.0) * smoothstep(0.004, 0.02, dz + 0.004));
        if (nearBg && !bg) edgeS = 1.0;
      } else {
        vec2 dn = abs(a.xy - b.xy) + abs(e.xy - f.xy);
        edgeC = smoothstep(0.35, 0.7, dn.x + dn.y);
      }
    }
    float edge = max(edgeS, edgeC * 0.6) * uOutlineStrength * (1.0 - smoothstep(uOutlineFade.x, uOutlineFade.y, d.z));
    // prairies (identifiant 1) : ni silhouette ni pli sur les brins ni à leur contact (des milliers de traits sinon)
    if (blade) edge = 0.0;
    if (!bg) {
      vec3 ink = mix(col * 0.32, uInk, 0.35);
      col = mix(col, ink, edge);
    }
  }
  // papier, grain, vignette
  if (uPaper > 0.0) {
    float fib = vnoise(vec3(gl_FragCoord.xy * 0.9, 1.0)) * 0.6 + vnoise(vec3(gl_FragCoord.xy * 0.13, 3.0)) * 0.4;
    col *= 1.0 - (fib - 0.5) * 0.16 * uPaper;
    col = mix(col, col * vec3(1.03, 1.0, 0.94), uPaper * 0.5);
  }
  if (uGrain > 0.0) col += (hash13(vec3(gl_FragCoord.xy, floor(uTime * 24.0))) - 0.5) * 0.06 * uGrain;
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * uVignette * 1.2;
  // linéaire → sRGB
  col = max(col, 0.0);
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
  outColor = vec4(col, 1.0);
}
`;
