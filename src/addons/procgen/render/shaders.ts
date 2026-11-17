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
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform mat4 uShadowMatrix;
flat out float vRole;
flat out float vObj;
out float vAO;
out vec3 vNormalW;
out vec3 vPosW;
out vec3 vPosL;
out vec3 vNormL;
out float vViewZ;
out vec4 vShadow;
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
  #ifdef BLADE
  vBlend = 0.0;
  #else
  vBlend = aBlend;
  #endif
  vShadow = uShadowMatrix * wp;
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
in vec3 vNormalW;
in vec3 vPosW;
in vec3 vPosL;
in vec3 vNormL;
in float vViewZ;
in vec4 vShadow;
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
uniform float uIdBase;
uniform float uHighlight;
uniform float uGroundY;
uniform float uWaterY;
uniform float uDetail;
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
float shadowAt(vec4 sc, float ndl) {
  if (uShadowOn < 0.5) return 1.0;
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float bias = mix(0.0022, 0.0005, clamp(ndl, 0.0, 1.0));
  float a = hash13(vec3(gl_FragCoord.xy, 1.0)) * 6.2831;
  mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
  float s = 0.0;
  for (int i = 0; i < 12; i++) {
    float d = texture(uShadowMap, c.xy + R * POISSON[i] * uShadowTexel * 1.8).r;
    s += c.z - bias > d ? 0.0 : 1.0;
  }
  return s / 12.0;
}

/** Variation de valeur procédurale selon le rôle (veinage du bois, taches de pierre, macro-variation du sol). */
float roleTexture(int role, vec3 p, vec3 n) {
  vec3 an = abs(n);
  if (role == 8 || role == 9) { // bois, écorce : fibres étirées
    float f = fbm3(vec3(p.x * 9.0, p.y * 1.4, p.z * 9.0)) + fbm3(vec3(p.x * 1.4, p.y * 9.0, p.z * 1.4)) * an.y;
    return (f - 0.5) * 0.28;
  }
  if (role == 4 || role == 5 || role == 6) { // pierre, enduit
    float f = fbm3(p * 3.2) * 0.7 + vnoise(p * 17.0) * 0.3;
    return (f - 0.5) * (role == 4 ? 0.3 : 0.14);
  }
  if (role == 7) { // toitures : rangs de tuiles
    float rows = abs(fract(p.y * 7.0 + vnoise(p * 2.0) * 0.4) - 0.5);
    return (smoothstep(0.0, 0.18, rows) - 0.7) * 0.16 + (vnoise(p * 6.0) - 0.5) * 0.12;
  }
  if (role <= 3) { // sol, herbe, chemin, chaussée
    float macro = fbm3(vec3(p.x, 0.0, p.z) * 0.35);
    float speck = vnoise(vec3(p.x, 0.0, p.z) * 9.0);
    return (macro - 0.5) * 0.32 + (speck - 0.5) * 0.1;
  }
  if (role == 10 || role == 11) return (fbm3(p * 4.5) - 0.5) * 0.3;
  if (role >= 17 && role <= 20) return (vnoise(p * 40.0) - 0.5) * 0.06;
  if (role >= 32) return (vnoise(p * 28.0) - 0.5) * 0.03; // couleurs franches : plastique, caoutchouc, cuir peint
  return (vnoise(p * 8.0) - 0.5) * 0.06;
}

void main() {
  int role = int(vRole + 0.5);
  vec3 base = uRoles[role];
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
  base *= 1.0 + roleTexture(role, vPosW, vNormalW) * uTexture;
  vec3 N = normalize(vNormalW);
  if (!gl_FrontFacing) N = -N;
  // relief de détail procédural (pierre, enduit, toiture, bois, écorce, sol) : gradient d'un bruit, sans texture
  float bumpK = (role == 4 ? 0.55 : role == 5 || role == 6 ? 0.18 : role == 7 ? 0.35 : role == 8 || role == 9 ? 0.3 : role <= 3 ? 0.25 : 0.0) * uTexture * uDetail;
  if (bumpK > 0.0) {
    float fs = role == 7 ? 7.0 : role <= 3 ? 2.2 : 5.0;
    vec3 q = vPosW * fs;
    float n0 = fbm3(q);
    vec3 g = vec3(fbm3(q + vec3(0.05, 0.0, 0.0)) - n0, fbm3(q + vec3(0.0, 0.05, 0.0)) - n0, fbm3(q + vec3(0.0, 0.0, 0.05)) - n0) / 0.05;
    N = normalize(N - (g - N * dot(g, N)) * bumpK * 0.12);
  }
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
  float sh = shadowAt(vShadow, ndl);
  float light;
  float brush = (fbm3(vPosW * 6.0) - 0.5) * uBrush;
  if (uShading < 0.5) light = clamp(ndl * 0.5 + 0.5, 0.0, 1.0) * 0.6 + 0.4;        // flat : lumière douce, sans bandes
  else if (uShading < 1.5) {                                                       // toon : bandes à seuil perturbé
    float x = clamp((ndl + brush) * 0.5 + 0.5, 0.0, 1.0);
    x *= mix(1.0, 0.3, (1.0 - sh) * uShadowStrength);
    float k = x * uBands;
    float q = (floor(k) + smoothstep(1.0 - max(uBandSoft * uBands, 0.001), 1.0, fract(k))) / uBands;
    light = clamp(q * uBands / (uBands - 1.0), 0.0, 1.0);
  } else {
    light = clamp(ndl + brush * 0.5, 0.0, 1.0);
    light = mix(light, light * light * (3.0 - 2.0 * light), uShading < 2.5 ? 0.6 : 0.0);
  }
  float shadow = mix(1.0, sh, uShadowStrength);
  if (uShading > 0.5 && uShading < 1.5) shadow = 1.0; // déjà dans les bandes
  float ao = (role == 13 ? 1.0 : mix(1.0, vAO, uAOStrength)) * finAO;
  // contact au sol : assombrit le pied des objets
  float contact = 1.0 - (1.0 - smoothstep(0.0, 0.35, vPosW.y - uGroundY)) * 0.18 * uAOStrength * step(0.2, abs(N.y - 1.0));
  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5);
  vec3 lit = base * (amb * 0.62 * ao * contact + uSun * light * shadow * mix(0.85, 1.0, ao));
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
  if (role == 30) lit = base * (1.2 + 0.25 * sin(uTime * 13.0 + vPosW.x * 9.0));
  lit = mix(lit, base * (1.0 + emiss), clamp(emiss, 0.0, 1.0));
  // eau : Fresnel vers le ciel, reflets qui défilent
  if (role == 13) {
    lit *= mix(1.3, 0.55, vAO);
    float foam = 1.0 - smoothstep(0.0, 0.06 + 0.03 * sin(uTime * 1.3 + vPosW.x), vAO);
    lit = mix(lit, uSun * 0.95, foam * 0.7);
    float fr = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
    float ripple = vnoise(vec3(vPosW.x * 1.3 + uTime * 0.3, uTime * 0.2, vPosW.z * 1.3)) + vnoise(vec3(vPosW.x * 3.1 - uTime * 0.4, 0.0, vPosW.z * 3.7));
    lit = mix(lit, uFogColor, fr * 0.6) + uSun * smoothstep(1.5, 1.75, ripple) * 0.07;
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
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }
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
${COMMON}

vec4 dataAt(vec2 uv) { return texture(tData, uv); }

void main() {
  vec2 uv = vUv * uUvXf.xy + uUvXf.zw;
  if (uPixel > 0.5) uv = (floor(uv * uResolution / uPixel) + 0.5) * uPixel / uResolution;
  vec4 c = texture(tColor, uv);
  vec4 d = dataAt(uv);
  bool bg = d.z <= 0.0 || d.z >= 0.999;
  vec3 col;
  if (bg) {
    float t = clamp((vUv.y - uHorizonY) / max(1.0 - uHorizonY, 0.1), 0.0, 1.0);
    col = uSkyOn > 0.5 ? mix(uSkyHorizon, uSkyTop, pow(t, 0.7)) : uSkyHorizon;
    // particules devant le ciel (couleur prémultipliée ; rien d'autre n'écrit la couleur sans la profondeur)
    col = col * (1.0 - clamp(c.a, 0.0, 1.0)) + c.rgb;
  } else col = c.rgb;
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
    float edge = max(edgeS, edgeC * 0.6) * uOutlineStrength;
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
