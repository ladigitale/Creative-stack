/**
 * Code GLSL (WebGL 2) de la pile d'effets de post-traitement. Écrit pour ce dépôt (MIT), d'après la pile
 * `shader/library/pile-effets.glsl` et le Kuwahara anisotrope CPU de `sketch/prefilter.ts`.
 *
 * Chaque effet est une fonction `vec3 fx_<id>(vec2 uv, vec3 c, vec4 P[slots] [, sampler2D A])` :
 * - `uv` : coordonnée écran (0..1) ; `c` : couleur courante (sRGB, déjà passée par les effets précédents de la passe) ;
 * - `P` : réglages empaquetés (voir `post.ts`, `pack`) ; `A` : texture annexe (tenseur lissé, image floutée).
 * Communs : `tIn` (entrée de la passe), `tData` (normales xy, profondeur / far, identifiant), `uTexel` (1 / taille de
 * `tIn`), `uCss` (taille de l'écran en px CSS), `uPx` (texels de `tIn` par px CSS), `uTime`, `uDepthK` (profondeur
 * relative : 1 = distance du point visé).
 */
import { POST_FX, type PlanPass } from "./post";

export const HELPERS = /* glsl */ `
const float PI = 3.14159265;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p) { return vec2(h12(p), h12(p + vec2(57.31, 13.77))); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), f.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Tramage ordonné de Bayer 8×8 (récursif), seuils dans [0, 1).
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { a = mod(floor(a), 8.0); return bayer4(0.5 * a) * 0.25 + bayer2(a); }
// Bruit bleu procédural approché : bruit blanc passé-haut (moins la moyenne de ses voisins), recentré.
float blueN(vec2 p) {
  p = floor(p);
  float w = h12(p);
  float m = (h12(p + vec2(1.0, 0.0)) + h12(p - vec2(1.0, 0.0)) + h12(p + vec2(0.0, 1.0)) + h12(p - vec2(0.0, 1.0))) * 0.25;
  return clamp((w - m) * 0.9 + 0.5, 0.0, 0.999);
}
float dth(vec2 p, float pattern) { return pattern > 0.5 ? blueN(p) : bayer8(p) + 1.0 / 128.0; }
vec3 s2l(vec3 c) { c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 l2s(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLab(vec3 c) {
  c = s2l(c);
  vec3 lms = vec3(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)), dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)), dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
  return vec3(dot(lms, vec3(0.2104542553, 0.793617785, -0.0040720468)), dot(lms, vec3(1.9779984951, -2.428592205, 0.4505937099)), dot(lms, vec3(0.0259040371, 0.7827717662, -0.808675766)));
}
vec3 fromLab(vec3 L) {
  vec3 lms = vec3(L.x + 0.3963377774 * L.y + 0.2158037573 * L.z, L.x - 0.1055613458 * L.y - 0.0638541728 * L.z, L.x - 0.0894841775 * L.y - 1.291485548 * L.z);
  lms = lms * lms * lms;
  return clamp(l2s(vec3(4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z, -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z, -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.707614701 * lms.z)), 0.0, 1.0);
}
// Rotation de teinte autour de l'axe des gris (Rodrigues).
vec3 hueTurn(vec3 c, float a) { vec3 k = vec3(0.57735); float ca = cos(a); return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca); }
vec3 tapIn(vec2 uv) { return texture(tIn, uv).rgb; }
// Coordonnées des grilles (px CSS) : décalées de uGrid, la position de la caméra orthographique dans son plan, pour que
// pixels, trames et hachures restent accrochés au monde pendant un déplacement de la vue.
vec2 gpx(vec2 uv) { return uv * uCss + uGrid; }
vec2 pxUv(vec2 p) { return (p - uGrid) / uCss; }
// Données de la scène (cible éventuellement agrandie d'une marge en rendu pixel accroché à la grille).
vec4 dataAt(vec2 uv) { return texture(tData, uv * uDataXf.xy + uDataXf.zw); }
// Ton recentré sur la plage usuelle d'une scène (luminance 0,2..0,95) : 0 = ombre, 1 = lumière.
float tone(float l) { return clamp((l - 0.58) / 0.75 + 0.5, 0.0, 1.0); }
bool isBg(vec4 d) { return d.z <= 0.0 || d.z >= 0.999; }
float relDepth(vec4 d) { return isBg(d) ? 1e4 : d.z * uDepthK; }
// Masque d'un effet : M0 = (mix, mode, a, b), M1 = (douceur, inversé).
float fxMask(vec2 uv, vec4 M0, vec4 M1) {
  int mode = int(M0.y + 0.5);
  if (mode == 0) return M0.x;
  vec4 d = dataAt(uv);
  bool bg = isBg(d);
  float rel = bg ? 1e4 : d.z * uDepthK;
  float s = max(M1.x, 1e-3);
  float k;
  if (mode == 1) k = 1.0 - smoothstep(M0.z - s, M0.z + s, rel);
  else if (mode == 2) k = smoothstep(M0.z - s, M0.z + s, rel);
  else if (mode == 3) k = smoothstep(M0.z - s, M0.z + s, rel) * (1.0 - smoothstep(M0.w - s, M0.w + s, rel));
  else if (mode == 4) k = bg ? 0.0 : 1.0;
  else k = bg ? 1.0 : 0.0;
  if (M1.y > 0.5) k = 1.0 - k;
  return M0.x * k;
}
`;

/** Fonctions annexes partagées par plusieurs effets (incluses si l'un d'eux est présent). */
const SHARED: Record<string, string> = {
  geoEdge: /* glsl */ `
// Arêtes de la géométrie : x = silhouette (profondeur, objet), y = pli (normales).
vec2 geoEdge(vec2 uv, vec2 e) {
  vec4 d = dataAt(uv);
  vec4 a = dataAt(uv + vec2(e.x, 0.0)), b = dataAt(uv - vec2(e.x, 0.0));
  vec4 f = dataAt(uv + vec2(0.0, e.y)), g = dataAt(uv - vec2(0.0, e.y));
  float z = max(d.z, 1e-4);
  float dz = max(max(abs(a.z - d.z), abs(b.z - d.z)), max(abs(f.z - d.z), abs(g.z - d.z))) / z;
  float did = max(max(abs(a.w - d.w), abs(b.w - d.w)), max(abs(f.w - d.w), abs(g.w - d.w)));
  vec2 dn = abs(a.xy - b.xy) + abs(f.xy - g.xy);
  float sil = max(smoothstep(0.03, 0.08, dz), did > 0.002 ? 1.0 : 0.0);
  if (isBg(d) && isBg(a) && isBg(b) && isBg(f) && isBg(g)) sil = 0.0;
  return vec2(sil, smoothstep(0.3, 0.7, dn.x + dn.y) * (isBg(d) ? 0.0 : 1.0));
}`,
  sep: /* glsl */ `
// Absorbance d'un pixel par rapport au papier (Beer–Lambert).
vec3 absorb(vec3 c, vec3 paper) { return -log(max(c, 0.004) / max(paper, 0.05)); }`,
  kaTap: /* glsl */ `
// Échantillon du Kuwahara anisotrope, pré-tramé (Q = force, niveaux, motif, cellule) : la trame ordonnée remplace
// le Floyd–Steinberg (séquentiel) de la version CPU ; elle est appliquée à chaque échantillon, sans passe de plus.
vec3 kaTap(vec2 uv, vec4 Q) {
  vec3 c = texture(tIn, uv).rgb;
  if (Q.x <= 0.0) return c;
  float lv = max(Q.y - 1.0, 1.0);
  float t = dth(floor(gpx(uv) / max(Q.w, 1.0)), Q.z) - 0.5;
  return clamp(floor(c * lv + 0.5 + t * Q.x) / lv, 0.0, 1.0);
}`,
  iron: /* glsl */ `
vec3 iron(float t) {
  t = clamp(t, 0.0, 1.0) * 5.0;
  vec3 a = vec3(0.0, 0.0, 0.06), b = vec3(0.32, 0.0, 0.5), c = vec3(0.86, 0.08, 0.3), d = vec3(1.0, 0.55, 0.0), e = vec3(1.0, 0.93, 0.55);
  if (t < 1.0) return mix(a, b, t);
  if (t < 2.0) return mix(b, c, t - 1.0);
  if (t < 3.0) return mix(c, d, t - 2.0);
  if (t < 4.0) return mix(d, e, t - 3.0);
  return mix(e, vec3(1.0), t - 4.0);
}`,
};

/** Fonctions partagées requises par effet. */
const NEEDS: Record<string, string[]> = { "kuwahara-aniso": ["kaTap"], trichromie: ["sep"], riso: ["sep"], neon: ["geoEdge"], vitrail: ["geoEdge"], thermique: ["iron"] };

export const FX_GLSL: Record<string, string> = {
  "kuwahara-aniso": /* glsl */ `
vec3 fx_kuwahara_aniso(vec2 uv, vec3 c0, vec4 P[2], sampler2D A) {
  vec3 T = texture(A, uv).xyz;
  float e = T.x, f = T.y, g = T.z;
  float disc = sqrt(max((e - g) * (e - g) + 4.0 * f * f, 0.0));
  float l1 = 0.5 * (e + g + disc), l2 = 0.5 * (e + g - disc);
  // direction des formes : vecteur propre de la plus petite valeur propre ; anisotropie (λ1 − λ2) / (λ1 + λ2)
  vec2 t = vec2(l1 - e, -f);
  t = dot(t, t) > 1e-14 ? normalize(t) : vec2(0.0, 1.0);
  float an = l1 + l2 > 1e-9 ? (l1 - l2) / (l1 + l2) : 0.0;
  float alpha = P[0].w;
  float r = max(P[0].x * uPx, 1.5);
  float a = min(r * (alpha + an) / alpha, r * (1.0 + alpha) / alpha), b = r * alpha / (alpha + an);
  int NS = P[0].y > 6.0 ? 8 : 4;
  float q = P[0].z;
  const float zeta = 0.33;
  float sn = sin(PI / float(NS));
  float eta = (zeta + cos(PI / float(NS))) / (sn * sn);
  vec4 m[8];
  vec3 s[8];
  vec2 cs[8];
  for (int k = 0; k < 8; k++) {
    m[k] = vec4(0.0);
    s[k] = vec3(0.0);
    float ang = 2.0 * PI * float(k) / float(NS);
    cs[k] = vec2(cos(ang), sin(ang));
  }
  float ex = sqrt(a * a * t.x * t.x + b * b * t.y * t.y), ey = sqrt(a * a * t.y * t.y + b * b * t.x * t.x);
  float stp = max(1.0, max(ex, ey) / 9.0);
  int nx = int(ceil(ex / stp)), ny = int(ceil(ey / stp));
  for (int j = -ny; j <= ny; j++) {
    for (int i = -nx; i <= nx; i++) {
      vec2 d = vec2(float(i), float(j)) * stp;
      float u = (d.x * t.x + d.y * t.y) / a, v = (-d.x * t.y + d.y * t.x) / b;
      float d2 = u * u + v * v;
      if (d2 > 1.0) continue;
      vec3 col = kaTap(uv + d * uTexel, P[1]);
      float gs = exp(-3.125 * d2);
      for (int k = 0; k < 8; k++) {
        if (k >= NS) break;
        float px = u * cs[k].x + v * cs[k].y, py = -u * cs[k].y + v * cs[k].x;
        float z = px + zeta - eta * py * py;
        if (z <= 0.0) continue;
        float w = z * z * gs;
        m[k] += vec4(col * w, w);
        s[k] += col * col * w;
      }
    }
  }
  vec3 o = vec3(0.0);
  float ow = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= NS || m[k].w <= 0.0) continue;
    vec3 mu = m[k].rgb / m[k].w;
    vec3 va = max(s[k] / m[k].w - mu * mu, 0.0);
    float wk = 1.0 / (1.0 + pow(255.0 * sqrt(va.r + va.g + va.b), q * 0.5));
    o += mu * wk;
    ow += wk;
  }
  return ow > 0.0 ? o / ow : c0;
}`,
  kuwahara: /* glsl */ `
vec3 fx_kuwahara(vec2 uv, vec3 c0, vec4 P[1]) {
  float r = max(P[0].x * uPx, 1.0);
  int n = int(min(ceil(r), 5.0));
  float st = r / float(n);
  vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0), s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
  for (int j = -n; j <= n; j++) {
    for (int i = -n; i <= n; i++) {
      vec3 x = tapIn(uv + vec2(float(i), float(j)) * st * uTexel);
      vec3 x2 = x * x;
      if (i <= 0 && j <= 0) { m0 += x; s0 += x2; }
      if (i >= 0 && j <= 0) { m1 += x; s1 += x2; }
      if (i <= 0 && j >= 0) { m2 += x; s2 += x2; }
      if (i >= 0 && j >= 0) { m3 += x; s3 += x2; }
    }
  }
  float cnt = float((n + 1) * (n + 1));
  m0 /= cnt; m1 /= cnt; m2 /= cnt; m3 /= cnt;
  vec3 v0 = s0 / cnt - m0 * m0, v1 = s1 / cnt - m1 * m1, v2 = s2 / cnt - m2 * m2, v3 = s3 / cnt - m3 * m3;
  float a = v0.r + v0.g + v0.b, b = v1.r + v1.g + v1.b, c = v2.r + v2.g + v2.b, d = v3.r + v3.g + v3.b;
  vec3 best = m0; float bv = a;
  if (b < bv) { bv = b; best = m1; }
  if (c < bv) { bv = c; best = m2; }
  if (d < bv) best = m3;
  return best;
}`,
  huile: /* glsl */ `
vec3 fx_huile(vec2 uv, vec3 c, vec4 P[2]) {
  vec2 e = P[0].y / uCss;
  float hl = luma(tapIn(uv - vec2(e.x, 0.0))), hr = luma(tapIn(uv + vec2(e.x, 0.0)));
  float hd = luma(tapIn(uv - vec2(0.0, e.y))), hu = luma(tapIn(uv + vec2(0.0, e.y)));
  vec2 g = vec2(hr - hl, hu - hd);
  vec2 dir = dot(g, g) > 1e-6 ? normalize(vec2(-g.y, g.x)) : vec2(0.70710678);
  vec2 p = gpx(uv);
  // stries de brosse : bruit étiré le long des formes, dont on prend la pente en travers
  vec2 nd = vec2(-dir.y, dir.x);
  float s0 = vnoise(vec2(dot(p, dir) * 0.08, dot(p, nd) * 0.32));
  float s1 = vnoise(vec2(dot(p, dir) * 0.08, dot(p, nd) * 0.32 + 0.6));
  // pente de pâte bornée : les contours francs font un bourrelet, pas un trait noir
  vec2 gs = g / (0.12 + length(g)) * 0.12;
  vec2 tilt = -gs * P[0].x * 6.0 + nd * (s1 - s0) * P[0].w * 1.1;
  vec3 N = normalize(vec3(tilt, 1.0));
  vec3 L = normalize(vec3(cos(P[0].z), sin(P[0].z), 0.85));
  float diff = dot(N, L) - L.z;
  float spec = pow(max(reflect(-L, N).z, 0.0), 28.0) * P[1].x;
  return c * (1.0 + diff * 0.6) + vec3(spec * 0.35);
}`,
  aquarelle: /* glsl */ `
vec3 fx_aquarelle(vec2 uv, vec3 c0, vec4 P[2]) {
  vec2 p = gpx(uv);
  float sc = P[1].x;
  vec2 wob = (vec2(vnoise(p / (38.0 * sc)), vnoise(p / (38.0 * sc) + 31.7)) - 0.5) * P[1].y * 6.0 * sc;
  vec2 u2 = uv + wob / uCss;
  vec3 c = tapIn(u2);
  vec3 b1 = vec3(0.0), b2 = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * PI / 4.0 + 0.39;
    vec2 o = vec2(cos(a), sin(a)) / uCss;
    b1 += tapIn(u2 + o * 2.5 * sc);
    b2 += tapIn(u2 + o * 7.0 * sc);
  }
  b1 /= 8.0;
  b2 /= 8.0;
  vec3 wash = mix(c, b1, P[0].x * 0.8);
  // le pigment s'accumule au bord des lavis : bande foncée du côté sombre d'un contour (différence de flous)
  float dog = luma(b1) - luma(b2);
  float edge = smoothstep(0.01, 0.1, -dog) + smoothstep(0.02, 0.14, dog) * 0.35;
  wash *= 1.0 - edge * P[0].y * 0.32;
  wash = mix(wash, vec3(1.0), 0.07);
  float gr = vnoise(p * 0.5 / sc) * 0.6 + vnoise(p * 1.4 / sc) * 0.4;
  wash *= 1.0 - (gr - 0.45) * P[0].z * 0.45 * (1.0 - luma(wash));
  float fib = vnoise(p * 0.9) * 0.5 + vnoise(vec2(p.x * 0.08, p.y * 0.9)) * 0.5;
  vec3 paper = vec3(0.99, 0.975, 0.945) * (1.0 - (fib - 0.5) * 0.1);
  return wash * mix(vec3(1.0), paper, P[0].w);
}`,
  bichromie: /* glsl */ `
vec3 fx_bichromie(vec2 uv, vec3 c, vec4 P[3]) {
  float l = clamp((luma(c) - 0.58) * P[1].w / 0.75 + 0.5 + P[0].w, 0.0, 1.0);
  // encre sombre dans les ombres, seconde encre dans les demi-tons, papier dans les lumières
  float k1 = 1.0 - smoothstep(0.08, 0.6, l);
  float k2 = clamp(1.0 - abs(l - 0.52) / 0.42, 0.0, 1.0);
  return P[2].rgb * mix(vec3(1.0), P[1].rgb, k2) * mix(vec3(1.0), P[0].rgb, k1);
}`,
  trichromie: /* glsl */ `
vec3 fx_trichromie(vec2 uv, vec3 c, vec4 P[8]) {
  vec3 A = absorb(c, P[3].rgb);
  vec3 k = clamp(vec3(dot(P[0].xyz, A), dot(P[1].xyz, A), dot(P[2].xyz, A)), 0.0, 1.0);
  if (P[3].w > 1.5) {
    float lv = P[3].w - 1.0;
    vec2 px = floor(gpx(uv));
    vec3 t = vec3(dth(px, P[7].y), dth(px.yx + vec2(3.0, 5.0), P[7].y), dth(vec2(px.x + px.y, px.y - px.x) + 7.0, P[7].y)) - 0.5;
    k = clamp(floor(k * lv + 0.5 + t * P[7].x) / lv, 0.0, 1.0);
  }
  return P[3].rgb * exp(-(k.x * P[4].xyz + k.y * P[5].xyz + k.z * P[6].xyz));
}`,
  riso: /* glsl */ `
vec3 fx_riso(vec2 uv, vec3 c0, vec4 P[10]) {
  vec2 p = gpx(uv);
  vec3 paper = P[3].rgb;
  float dotS = P[8].z;
  vec3 ab = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    if (float(i) >= P[8].w) break;
    vec2 off = i == 0 ? P[7].xy : i == 1 ? P[7].zw : P[8].xy;
    vec3 A = absorb(tapIn(uv + off / uCss), paper);
    float k = clamp(dot(P[i].xyz, A), 0.0, 1.0);
    // densité d'encre irrégulière (tambour), plus forte au milieu des aplats
    k *= 0.86 + 0.26 * vnoise(p * 0.011 + float(i) * 7.3);
    float scr;
    if (dotS > 0.5) {
      float ang = 0.2618 + float(i) * 0.5236;
      vec2 q = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * p / dotS;
      float d = length(fract(q) - 0.5);
      float r = sqrt(k / PI) * 1.05;
      float aa = 0.8 / (dotS * uPx);
      scr = 1.0 - smoothstep(r - aa, r + aa, d);
    } else {
      // grain du tambour : seuil marbré (bruit lissé) et fin (bruit bleu), les aplats restent pleins
      vec2 gp = p + float(i) * 37.0;
      float t = 0.5 + (vnoise(gp * 0.9) - 0.5) * 0.55 + (blueN(gp) - 0.5) * 0.35;
      scr = smoothstep(t - 0.18, t + 0.18, k * 1.08);
    }
    k = mix(k, scr, P[3].w);
    ab += k * P[4 + i].xyz;
  }
  return paper * exp(-ab);
}`,
  cmjn: /* glsl */ `
vec4 cmyk(vec3 c, float gcr) {
  vec3 cmy = 1.0 - c;
  float k = min(cmy.r, min(cmy.g, cmy.b)) * gcr;
  return vec4((cmy - k) / max(1.0 - k, 1e-3), k);
}
vec3 fx_cmjn(vec2 uv, vec3 c0, vec4 P[2]) {
  vec2 p = gpx(uv);
  float s = P[0].x;
  vec3 o = P[1].rgb;
  float aa = 0.6 / (s * uPx);
  for (int ch = 0; ch < 4; ch++) {
    float a = (ch == 0 ? 15.0 : ch == 1 ? 75.0 : ch == 2 ? 0.0 : 45.0) * PI / 180.0 + P[0].y;
    mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
    vec2 q = R * p / s;
    vec2 cell = floor(q) + 0.5;
    vec3 c = tapIn(pxUv(transpose(R) * cell * s));
    vec4 k = cmyk(c, P[0].z);
    float v = ch == 0 ? k.x : ch == 1 ? k.y : ch == 2 ? k.z : k.w;
    // aire du point = part d'encre (r = √(v / π))
    float r = sqrt(clamp(v, 0.0, 1.0) / PI);
    float cov = 1.0 - smoothstep(r - aa, r + aa, length(q - cell));
    vec3 ink = ch == 0 ? vec3(0.0, 0.63, 0.89) : ch == 1 ? vec3(0.9, 0.05, 0.52) : ch == 2 ? vec3(1.0, 0.92, 0.05) : vec3(0.13, 0.12, 0.14);
    o *= mix(vec3(1.0), ink, cov * (v > 0.002 ? 1.0 : 0.0));
  }
  return o;
}`,
  degrade: /* glsl */ `
vec3 fx_degrade(vec2 uv, vec3 c, vec4 P[9]) {
  // luminance perçue, recentrée sur la plage usuelle d'une scène (0,25..0,95)
  float l = clamp((toLab(c).x - 0.6) * P[8].y / 0.7 + 0.5 + P[8].z, 0.0, 1.0);
  int nS = int(P[8].x + 0.5);
  float x = l * float(nS - 1);
  int i = int(min(floor(x), float(nS - 2)));
  return fromLab(mix(P[i].xyz, P[i + 1].xyz, x - float(i)));
}`,
  palette: /* glsl */ `
vec3 fx_palette(vec2 uv, vec3 c, vec4 P[33]) {
  vec3 lab = toLab(c);
  float t = dth(floor(gpx(uv) / max(P[32].w, 1.0)), P[32].z);
  if (P[32].x < 0.0) {
    // luminance projetée sur la palette rangée du plus sombre au plus clair
    int n = int(-P[32].x + 0.5);
    float x = clamp((lab.x - 0.2) / 0.72, 0.0, 1.0) * float(n - 1);
    float fi = floor(x + (t - 0.5) * P[32].y + 0.5);
    return P[16 + int(clamp(fi, 0.0, float(n - 1)))].rgb;
  }
  int nC = int(P[32].x + 0.5);
  float d1 = 1e9, d2 = 1e9;
  int i1 = 0, i2 = 0;
  for (int i = 0; i < 16; i++) {
    if (i >= nC) break;
    vec3 dd = lab - P[i].xyz;
    dd.x *= 1.4;
    float d = dot(dd, dd);
    if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = i; } else if (d < d2) { d2 = d; i2 = i; }
  }
  float m = sqrt(d1) / max(sqrt(d1) + sqrt(d2), 1e-6);
  return P[16 + (t < m * P[32].y ? i2 : i1)].rgb;
}`,
  cyanotype: /* glsl */ `
vec3 fx_cyanotype(vec2 uv, vec3 c, vec4 P[1]) {
  float l = clamp((luma(c) - 0.5) * P[0].x + 0.5, 0.0, 1.0);
  vec3 deep = mix(vec3(0.09, 0.22, 0.42), vec3(0.02, 0.1, 0.26), P[0].z);
  vec3 mid = vec3(0.16, 0.42, 0.67);
  vec3 paper = mix(vec3(0.93, 0.95, 0.96), vec3(0.97, 0.94, 0.86), P[0].y);
  vec3 o = l < 0.55 ? mix(deep, mid, l / 0.55) : mix(mid, paper, smoothstep(0.55, 1.0, l));
  return o * (1.0 + (vnoise(gpx(uv) * 0.6) - 0.5) * 0.06);
}`,
  sepia: /* glsl */ `
vec3 fx_sepia(vec2 uv, vec3 c, vec4 P[1]) {
  float l = clamp((luma(c) - 0.5) * P[0].y + 0.5, 0.0, 1.0);
  l = P[0].z + l * (1.0 - P[0].z);
  vec3 dark = mix(vec3(0.15, 0.14, 0.13), vec3(0.2, 0.11, 0.05), P[0].x);
  vec3 mid = mix(vec3(0.55, 0.52, 0.48), vec3(0.63, 0.44, 0.26), P[0].x);
  vec3 light = mix(vec3(0.95, 0.94, 0.91), vec3(0.98, 0.92, 0.79), P[0].x);
  return l < 0.5 ? mix(dark, mid, l * 2.0) : mix(mid, light, l * 2.0 - 1.0);
}`,
  points: /* glsl */ `
vec3 fx_points(vec2 uv, vec3 c0, vec4 P[3]) {
  vec2 p = gpx(uv);
  float s = P[0].x, a = P[0].y;
  mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec2 q = R * p / s;
  vec2 base = floor(q - 0.5);
  float aa = 0.8 / (s * uPx);
  // couleur : aplat éclairci de l'image, points de sa couleur pleine (Ben-Day) ; sinon encre sur papier
  bool colorMode = P[0].z > 0.5;
  vec3 o = colorMode ? mix(c0, vec3(1.0), 0.5) : P[2].rgb;
  vec3 ink = colorMode ? clamp(c0 * 0.92, 0.0, 1.0) : P[1].rgb;
  float k = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 cell = base + vec2(float(i), float(j)) + 0.5;
      float l = luma(tapIn(pxUv(transpose(R) * cell * s)));
      // aire du point = part d'encre (les points se touchent dans les ombres)
      float v = colorMode ? 0.25 + 0.6 * clamp(1.0 - l, 0.0, 1.0) : 1.0 - tone(l);
      float r = sqrt(v / PI) * 1.08;
      k = max(k, 1.0 - smoothstep(r - aa, r + aa, length(q - cell)));
    }
  }
  return mix(o, ink, k);
}`,
  lignes: /* glsl */ `
vec3 fx_lignes(vec2 uv, vec3 c, vec4 P[3]) {
  vec2 p = gpx(uv);
  float s = P[0].x, a = P[0].y;
  float y = dot(p, vec2(-sin(a), cos(a))) / s + (vnoise(p * 0.03) - 0.5) * P[0].z * 1.6;
  float d = abs(fract(y) - 0.5) * 2.0;
  float w = (1.0 - tone(luma(c))) * 1.04;
  float aa = 1.2 / (s * uPx);
  return mix(P[2].rgb, P[1].rgb, 1.0 - smoothstep(w - aa, w + aa, d));
}`,
  hachures: /* glsl */ `
float hatchLine(vec2 p, float a, float s, float wob, float w, float aa) {
  float y = dot(p, vec2(-sin(a), cos(a))) / s + (vnoise(p * 0.05 + a * 10.0) - 0.5) * wob;
  float d = abs(fract(y) - 0.5) * 2.0;
  return 1.0 - smoothstep(w - aa, w + aa, d);
}
vec3 fx_hachures(vec2 uv, vec3 c, vec4 P[3]) {
  vec2 p = gpx(uv);
  float s = P[0].x, a = P[0].y, wob = P[0].w;
  int L = int(P[0].z + 0.5);
  float l = luma(c);
  float k = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= L) break;
    float t = 0.8 - float(i) * (0.68 / float(L));
    float g = clamp((t - l) / 0.2, 0.0, 1.0);
    if (g <= 0.0) continue;
    float ang = a + (i == 1 ? PI * 0.5 : i == 2 ? PI * 0.25 : i == 3 ? -PI * 0.25 : 0.0);
    float si = s * (i >= 2 ? 0.75 : 1.0);
    k = max(k, hatchLine(p, ang, si, wob, 0.06 + 0.26 * g, 1.2 / (si * uPx)));
  }
  return mix(P[2].rgb, P[1].rgb, k);
}`,
  "1bit": /* glsl */ `
vec3 fx_1bit(vec2 uv, vec3 c, vec4 P[3]) {
  float l = clamp((luma(c) - 0.5) * P[0].z + 0.5 - P[0].w, 0.0, 1.0);
  float t = dth(floor(gpx(uv) / max(P[0].x, 1.0)), P[0].y);
  return l > t ? P[2].rgb : P[1].rgb;
}`,
  lino: /* glsl */ `
vec3 fx_lino(vec2 uv, vec3 c0, vec4 P[3]) {
  vec2 p = gpx(uv);
  vec2 e = 2.5 / uCss;
  float lr = luma(tapIn(uv + vec2(e.x, 0.0))), ll = luma(tapIn(uv - vec2(e.x, 0.0)));
  float lu = luma(tapIn(uv + vec2(0.0, e.y))), ld = luma(tapIn(uv - vec2(0.0, e.y)));
  float lx = lr - ll, ly = lu - ld;
  vec2 g = vec2(lx, ly);
  float gl = length(g);
  float ang = P[0].z;
  // gouges le long des formes (perpendiculaires au gradient), angle fixe dans les zones sans direction
  if (gl > 0.015) ang = mix(ang, atan(g.x, -g.y), smoothstep(0.015, 0.08, gl));
  ang = floor(ang / (PI / 8.0) + 0.5) * (PI / 8.0);
  vec2 nrm = vec2(-sin(ang), cos(ang));
  float l = (luma(c0) * 2.0 + lr + ll + lu + ld) / 6.0 + (vnoise(p * 0.12) - 0.5) * 0.2 * P[0].w;
  float y = dot(p, nrm) / P[0].y;
  float d = abs(fract(y) - 0.5) * 2.0;
  float along = dot(p, vec2(nrm.y, -nrm.x));
  float wv = clamp((l - P[0].x + 0.25) / 0.5, 0.0, 1.0);
  wv += (vnoise(vec2(along * 0.07, floor(y) * 3.1)) - 0.5) * 1.2 * wv * (1.0 - wv);
  float aa = 1.2 / (P[0].y * uPx);
  float pk = wv <= 0.02 ? 0.0 : wv >= 0.98 ? 1.0 : smoothstep(1.0 - wv - aa, 1.0 - wv + aa, d);
  return mix(P[1].rgb, P[2].rgb, pk);
}`,
  pointillisme: /* glsl */ `
vec3 fx_pointillisme(vec2 uv, vec3 c0, vec4 P[2]) {
  vec2 p = gpx(uv) / P[0].x;
  vec2 ip = floor(p);
  vec3 col = P[1].rgb;
  float aa = 1.0 / (P[0].x * uPx);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 hh = h22(ip + o);
      vec2 ctr = ip + o + 0.5 + (hh - 0.5) * 0.8;
      float rad = 0.5 + 0.28 * hh.x;
      float k = 1.0 - smoothstep(rad - aa, rad + aa, length(p - ctr));
      if (k <= 0.0) continue;
      vec3 lab = toLab(tapIn(pxUv(ctr * P[0].x)));
      vec2 jit = (h22(ip + o + 31.0) - 0.5) * 0.09 * P[0].y;
      lab.yz = lab.yz * P[0].z + jit;
      lab.x += (hh.y - 0.5) * 0.1 * P[0].y;
      col = mix(col, fromLab(lab), k);
    }
  }
  return col;
}`,
  vitrail: /* glsl */ `
vec3 fx_vitrail(vec2 uv, vec3 c0, vec4 P[2]) {
  vec2 p = gpx(uv) / P[0].x;
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0, d2 = 8.0;
  vec2 best = ip;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 pt = o + 0.15 + 0.7 * h22(ip + o);
      float d = length(pt - fp);
      if (d < d1) { d2 = d1; d1 = d; best = ip + pt; } else if (d < d2) d2 = d;
    }
  }
  vec3 lab = toLab(tapIn(pxUv(best * P[0].x)));
  lab.yz *= 1.3;
  lab.x = mix(lab.x, 0.3 + lab.x * 0.62, 0.5);
  vec3 glass = fromLab(lab);
  glass *= 1.0 + P[0].z * (0.3 - d1 * 0.55);
  glass *= 0.93 + 0.14 * vnoise(gpx(uv) * 0.22);
  float lw = P[0].y;
  float lead = 1.0 - smoothstep(lw, lw + 0.05, d2 - d1);
  // le plomb suit aussi les silhouettes de la scène : les formes restent lisibles
  lead = max(lead, geoEdge(uv, vec2(1.2) / uCss).x * smoothstep(0.0, 0.05, lw));
  return mix(glass, P[1].rgb, lead);
}`,
  bloom: /* glsl */ `
vec3 fx_bloom(vec2 uv, vec3 c, vec4 P[2], sampler2D A) {
  return c + texture(A, uv).rgb * P[0].x * P[1].rgb;
}`,
  halo: /* glsl */ `
vec3 fx_halo(vec2 uv, vec3 c, vec4 P[2], sampler2D A) {
  vec3 b = texture(A, uv).rgb;
  return 1.0 - (1.0 - c) * (1.0 - clamp(b * b * P[0].x * 1.8 * P[1].rgb, 0.0, 1.0));
}`,
  aberration: /* glsl */ `
vec3 fx_aberration(vec2 uv, vec3 c, vec4 P[1]) {
  vec2 dir = P[0].y > 0.5 ? (uv - 0.5) * 2.0 : vec2(1.0, 0.0);
  vec2 o = dir * P[0].x / uCss;
  return vec3(tapIn(uv + o).r, c.g, tapIn(uv - o).b);
}`,
  miniature: /* glsl */ `
vec3 fx_miniature(vec2 uv, vec3 c, vec4 P[2], sampler2D A) {
  float rel = relDepth(dataAt(uv));
  float dz = abs(log(max(rel, 1e-3) / P[0].x));
  float coc = smoothstep(P[0].y * 0.4, P[0].y * 1.6 + 0.08, dz) * P[0].z;
  vec3 o = mix(c, texture(A, uv).rgb, coc);
  return mix(vec3(luma(o)), o, P[0].w);
}`,
  brume: /* glsl */ `
vec3 fx_brume(vec2 uv, vec3 c, vec4 P[2]) {
  vec4 d = dataAt(uv);
  float f = isBg(d) ? P[0].z : 1.0 - exp(-max(d.z * uDepthK - P[0].x, 0.0) * P[0].y);
  return mix(c, P[1].rgb, clamp(f, 0.0, 1.0));
}`,
  grain: /* glsl */ `
vec3 fx_grain(vec2 uv, vec3 c, vec4 P[1]) {
  vec2 p = floor(gpx(uv) / P[0].y);
  float fr = P[0].w > 0.5 ? floor(uTime * 24.0) : 0.0;
  float g = h12(p + fr * 17.13) + h12(p * 1.37 + 91.7 + fr * 3.1) - 1.0;
  vec3 gc = vec3(g, h12(p + 41.3 + fr) + h12(p + 3.3 + fr) - 1.0, h12(p + 77.9 + fr) + h12(p + 8.1 + fr) - 1.0);
  float l = luma(c);
  float w = 1.0 - pow(abs(2.0 * l - 1.0), 2.0) * 0.7;
  return c + mix(vec3(g), gc, P[0].z) * P[0].x * 0.2 * w;
}`,
  vignette: /* glsl */ `
vec3 fx_vignette(vec2 uv, vec3 c, vec4 P[2]) {
  vec2 q = uv - 0.5;
  float asp = uCss.x / uCss.y;
  float rr = length(q * vec2(asp, 1.0)) / (0.5 * sqrt(asp * asp + 1.0));
  float re = length(q) / 0.70710678;
  float r = mix(re, rr, P[0].y);
  float v = smoothstep(1.0 - P[0].z, 1.05, r);
  return mix(c, P[1].rgb, v * P[0].x);
}`,
  fuite: /* glsl */ `
vec3 fx_fuite(vec2 uv, vec3 c, vec4 P[3]) {
  float t = uTime * P[0].z;
  float a = P[0].y + sin(t * 0.3) * 0.3 * step(0.001, P[0].z);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 q = (uv - 0.5) * vec2(uCss.x / uCss.y, 1.0);
  float edge = dot(q, dir);
  float n = vnoise(vec2(dot(q, vec2(-dir.y, dir.x)) * 3.0 + t * 0.4, t * 0.2 + 3.0));
  float k = smoothstep(0.05, 0.8, edge + (n - 0.5) * 0.35);
  vec3 lc = mix(P[2].rgb, P[1].rgb, smoothstep(0.25, 0.75, edge + n * 0.2));
  return 1.0 - (1.0 - c) * (1.0 - lc * k * P[0].x);
}`,
  neon: /* glsl */ `
vec3 fx_neon(vec2 uv, vec3 c, vec4 P[3]) {
  vec2 e = P[0].x / uCss;
  vec2 ed = geoEdge(uv, e);
  float le = length(vec2(luma(tapIn(uv + vec2(e.x, 0.0))) - luma(tapIn(uv - vec2(e.x, 0.0))), luma(tapIn(uv + vec2(0.0, e.y))) - luma(tapIn(uv - vec2(0.0, e.y)))));
  ed.y = max(ed.y, smoothstep(0.08, 0.25, le) * 0.6);
  vec2 gl = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * PI / 4.0 + 0.3;
    vec2 o = vec2(cos(a), sin(a)) * P[0].x / uCss;
    gl += geoEdge(uv + o * 3.5, e) * 0.65 + geoEdge(uv + o * 8.0, e) * 0.35;
  }
  gl /= 8.0;
  vec3 tint = normalize(c + 0.03) * 1.3;
  vec3 c1 = mix(P[1].rgb, tint, P[0].w), c2 = mix(P[2].rgb, tint, P[0].w);
  vec3 o = c * (1.0 - P[0].z) * 0.9;
  o += c1 * (ed.x * 0.95 + gl.x * P[0].y * 0.8) + c2 * (ed.y * 0.8 + gl.y * P[0].y * 0.6);
  return o + vec3(0.22) * ed.x * ed.x;
}`,
  thermique: /* glsl */ `
vec3 fx_thermique(vec2 uv, vec3 c, vec4 P[1]) {
  vec4 d = dataAt(uv);
  bool bg = isBg(d);
  float rel = bg ? 4.0 : d.z * uDepthK;
  float heat = luma(c);
  // proche = plus chaud (autour du point visé), ciel froid
  heat = mix(heat, heat * 0.6 + (1.0 - smoothstep(0.6, 1.8, rel)) * 0.45, P[0].y);
  if (bg) heat *= 0.3;
  return iron((heat - 0.58) * P[0].x + 0.5);
}`,
  glitch: /* glsl */ `
vec3 fx_glitch(vec2 uv, vec3 c0, vec4 P[2]) {
  float t = floor(uTime * P[0].w * 8.0) + P[1].x * 13.7;
  float bands = P[0].y;
  float by = floor(uv.y * bands);
  float on = step(1.0 - P[0].x * 0.6, h12(vec2(by, t)));
  float shift = (h12(vec2(by * 1.7, t + 5.1)) - 0.5) * 0.2 * on * P[0].x;
  float bb = floor(uv.y * bands * 0.25);
  float big = step(1.0 - P[0].x * 0.25, h12(vec2(bb, t + 2.0)));
  shift += (h12(vec2(bb, t + 9.0)) - 0.5) * 0.12 * big;
  vec2 u = vec2(fract(uv.x + shift), uv.y);
  vec2 s = vec2(P[0].z / uCss.x, 0.0) * (0.35 + on + big);
  vec3 col = vec3(tapIn(u + s).r, tapIn(u).g, tapIn(u - s).b);
  vec2 blk = floor(uv * vec2(bands * 0.5, bands));
  if (h12(blk + t * 1.3) > 1.0 - P[0].x * 0.07) {
    vec2 g = vec2(48.0, 32.0);
    col = tapIn((floor(u * g) + 0.5) / g).brg;
  }
  return col * (1.0 - 0.18 * on * step(0.5, fract(uv.y * uCss.y * 0.5)));
}`,
  crt: /* glsl */ `
vec3 fx_crt(vec2 uv, vec3 c0, vec4 P[2]) {
  vec2 q = uv * 2.0 - 1.0;
  float k = P[0].x * 0.2;
  vec2 u = q * (1.0 + k * dot(q, q)) / (1.0 + k) * 0.5 + 0.5;
  if (u.x < 0.0 || u.y < 0.0 || u.x > 1.0 || u.y > 1.0) return vec3(0.0);
  vec3 col = tapIn(u);
  vec2 hp = vec2(1.5 / uCss.x, 0.0);
  vec3 bl = (tapIn(u - hp) + tapIn(u + hp) + 0.5 * (tapIn(u - 2.0 * hp) + tapIn(u + 2.0 * hp))) / 3.0;
  col = mix(col, max(col, bl), P[0].w * 0.8);
  float sl = 0.5 + 0.5 * cos(u.y * uCss.y / 3.0 * 2.0 * PI);
  col *= mix(1.0, 0.6 + 0.55 * sl, P[0].y);
  float ph = mod(floor(u.x * uCss.x), 3.0);
  vec3 m = ph < 0.5 ? vec3(1.0, 0.4, 0.4) : ph < 1.5 ? vec3(0.4, 1.0, 0.4) : vec3(0.4, 0.4, 1.0);
  col *= mix(vec3(1.0), m * 1.4, P[0].z);
  vec2 vq = u * (1.0 - u.yx);
  col *= mix(1.0, pow(clamp(vq.x * vq.y * 16.0, 0.0, 1.0), 0.25), 0.85);
  col *= 1.0 + P[1].x * 0.07 * sin(uTime * 377.0) + P[1].x * 0.04 * sin(u.y * 4.0 - uTime * 8.0);
  return col;
}`,
  decoupe: /* glsl */ `
float dcLevel(vec2 uv, float n) {
  vec2 e = 1.5 / uCss;
  vec3 c = (tapIn(uv) * 2.0 + tapIn(uv + vec2(e.x, 0.0)) + tapIn(uv - vec2(e.x, 0.0)) + tapIn(uv + vec2(0.0, e.y)) + tapIn(uv - vec2(0.0, e.y))) / 6.0;
  return min(floor(clamp((toLab(c).x - 0.25) / 0.7, 0.0, 1.0) * n), n - 1.0);
}
vec3 fx_decoupe(vec2 uv, vec3 c, vec4 P[2]) {
  float n = P[0].x;
  float lev = dcLevel(uv, n);
  vec3 lab = toLab(c);
  vec3 q = vec3(0.25 + 0.7 * (lev + 0.6) / n, floor(lab.yz / 0.03 + 0.5) * 0.03 * P[1].x);
  vec3 col = fromLab(q);
  vec2 dir = vec2(cos(P[0].z), sin(P[0].z));
  float sh = 0.0;
  for (int i = 1; i <= 4; i++) {
    vec2 o = dir * P[0].y * float(i) / 4.0 / uCss;
    sh += dcLevel(uv - o, n) > lev ? 1.0 : 0.0;
  }
  col *= 1.0 - sh * 0.32;
  vec2 p = gpx(uv);
  float fib = vnoise(p * 0.7 + lev * 13.1) * 0.6 + vnoise(vec2(p.x * 0.1, p.y * 1.1) + lev * 7.7) * 0.4;
  return col * (1.0 - (fib - 0.5) * 0.14 * P[0].w);
}`,
  kaleido: /* glsl */ `
vec3 fx_kaleido(vec2 uv, vec3 c, vec4 P[2]) {
  vec2 ctr = P[1].xy;
  float asp = uCss.x / uCss.y;
  vec2 p = (uv - ctr) * vec2(asp, 1.0);
  float r = length(p) / P[0].z;
  float seg = 2.0 * PI / P[0].x;
  float a = mod(atan(p.y, p.x) + P[0].y, seg);
  a = abs(a - seg * 0.5);
  vec2 u = ctr + r * vec2(cos(a), sin(a)) / vec2(asp, 1.0);
  u = 1.0 - abs(1.0 - mod(u, 2.0));
  return tapIn(u);
}`,
  pixel: /* glsl */ `
vec3 fx_pixel(vec2 uv, vec3 c, vec4 P[1]) {
  float s = P[0].x;
  return tapIn(pxUv((floor(gpx(uv) / s) + 0.5) * s));
}`,
  couleur: /* glsl */ `
vec3 fx_couleur(vec2 uv, vec3 c, vec4 P[2]) {
  c *= exp2(P[0].x);
  c = (c - 0.5) * P[0].y + 0.5;
  c = mix(vec3(luma(c)), c, P[0].z);
  if (P[0].w != 0.0) c = hueTurn(c, P[0].w);
  c *= vec3(1.0 + P[1].x * 0.12, 1.0 + P[1].x * 0.02, 1.0 - P[1].x * 0.14);
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / P[1].y));
}`,
};

const fnName = (id: string) => "fx_" + id.replace(/-/g, "_");

/** Uniformes communs d'une passe de la pile. */
const PASS_HEAD = /* glsl */ `precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tIn;
uniform sampler2D tData;
uniform vec2 uTexel;
uniform vec2 uCss;
uniform float uPx;
uniform float uTime;
uniform float uDepthK;
uniform vec2 uGrid;
uniform vec4 uDataXf;
`;

/**
 * Fragment d'une passe : les effets de la passe dans l'ordre, chacun mélangé à la couleur courante selon son
 * intensité et son masque. Code propre à la suite d'effets (mis en cache par `PlanPass.key`).
 */
export function passFragment(pass: Pick<PlanPass, "stages" | "aux">): string {
  const ids = pass.stages.map((s) => s.fx);
  const needs = new Set(ids.flatMap((id) => NEEDS[id] ?? []));
  const uni: string[] = [];
  const body: string[] = [];
  pass.stages.forEach((s, k) => {
    const def = POST_FX[s.fx];
    uni.push(`uniform vec4 uF${k}[${def.slots}];`, `uniform vec4 uM${k}[2];`);
    const withAux = pass.aux && k === 0;
    body.push(`  { float m = fxMask(uv, uM${k}[0], uM${k}[1]); if (m > 0.0) c = mix(c, ${fnName(s.fx)}(uv, c, uF${k}${withAux ? ", tAux" : ""}), m); }`);
  });
  if (pass.aux) uni.push("uniform sampler2D tAux;");
  return [
    PASS_HEAD,
    uni.join("\n"),
    HELPERS,
    ...[...needs].map((k) => SHARED[k]),
    ...[...new Set(ids)].map((id) => FX_GLSL[id]),
    "void main() {",
    "  vec2 uv = vUv;",
    "  vec3 c = texture(tIn, uv).rgb;",
    ...body,
    "  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);",
    "}",
  ].join("\n");
}

export const POST_STACK_VERTEX = /* glsl */ `precision highp float;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Tenseur de structure (gradients de Sobel des trois canaux) : (E, F, G) = (Σgx², Σgx·gy, Σgy²). */
export const AUX_TENSOR = /* glsl */ `precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tSrc;
uniform vec2 uStep;
void main() {
  vec2 e = uStep;
  vec3 tl = texture(tSrc, vUv + vec2(-e.x, e.y)).rgb, t = texture(tSrc, vUv + vec2(0.0, e.y)).rgb, tr = texture(tSrc, vUv + e).rgb;
  vec3 l = texture(tSrc, vUv - vec2(e.x, 0.0)).rgb, r = texture(tSrc, vUv + vec2(e.x, 0.0)).rgb;
  vec3 bl = texture(tSrc, vUv - e).rgb, b = texture(tSrc, vUv - vec2(0.0, e.y)).rgb, br = texture(tSrc, vUv + vec2(e.x, -e.y)).rgb;
  vec3 gx = (tr + 2.0 * r + br - tl - 2.0 * l - bl) * 0.25;
  vec3 gy = (tl + 2.0 * t + tr - bl - 2.0 * b - br) * 0.25;
  outColor = vec4(dot(gx, gx), dot(gx, gy), dot(gy, gy), 1.0);
}
`;

/** Flou gaussien séparable (une direction) ; au-delà de 16 pas de part et d'autre, échantillons espacés (filtrage linéaire). */
export const AUX_BLUR = /* glsl */ `precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tSrc;
uniform vec2 uStep;
uniform float uSigma;
void main() {
  float s = max(uSigma, 0.5);
  float st = max(1.0, 2.5 * s / 16.0);
  int n = int(ceil(2.5 * s / st));
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -n; i <= n; i++) {
    float x = float(i) * st;
    float w = exp(-0.5 * x * x / (s * s));
    acc += texture(tSrc, vUv + uStep * x) * w;
    ws += w;
  }
  outColor = acc / ws;
}
`;

/** Réduction (4 échantillons bilinéaires = 16 texels) et seuil à genou doux des hautes lumières. */
export const AUX_EXTRACT = /* glsl */ `precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tSrc;
uniform vec2 uStep;
uniform float uThreshold;
void main() {
  vec3 c = (texture(tSrc, vUv + uStep * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + uStep * vec2(1.0, -1.0)).rgb + texture(tSrc, vUv + uStep * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + uStep * vec2(1.0, 1.0)).rgb) * 0.25;
  if (uThreshold > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    float knee = 0.2;
    float sk = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
    sk = sk * sk / (4.0 * knee + 1e-4);
    c *= max(sk, l - uThreshold) / max(l, 1e-4);
  }
  outColor = vec4(c, 1.0);
}
`;

/** Copie (agrandissement d'une dernière passe à demi-résolution vers l'écran). */
export const COPY = /* glsl */ `precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tSrc;
void main() { outColor = vec4(texture(tSrc, vUv).rgb, 1.0); }
`;
