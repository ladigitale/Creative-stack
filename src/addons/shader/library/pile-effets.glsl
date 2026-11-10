// Pile d'effets cumulables pour finir une image (post-traitement), appliqués dans un ordre fixe :
// géométrie → lumière → couleur → matière. Indépendant de la résolution : le même réglage donne le même
// aspect à l'écran et dans un export ×4 (render-size). iChannel0 : l'image à traiter.
// uParam0 : masque des effets actifs, somme de 2^i pour chaque effet i :
//   géométrie  0 miroir, 1 kaléido, 2 tourbillon, 3 ondes, 4 pixels
//   lumière    5 prisme, 6 halo, 7 flou, 8 encre (contours)
//   couleur    9 éclat, 10 teinte, 11 bichromie, 12 sépia, 13 aplats, 14 négatif, 15 thermique
//   matière   16 papier, 17 trame, 18 points, 19 hachures, 20 balayage, 21 grain, 22 vignette
// uParam1 intensité (0..1), uParam2 échelle du grain (millièmes du petit côté, 0.5..8), uParam3 teinte (0..1).

const float PI = 3.14159265;

bool fxOn(int i) {
  return mod(floor((uParam0 + 0.5) / exp2(float(i))), 2.0) >= 1.0;
}

float h12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), u.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Rotation de teinte autour de l'axe des gris (formule de Rodrigues).
vec3 hueTurn(vec3 c, float a) {
  vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

// Couleur pure d'une teinte h (0..1).
vec3 hueColor(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

vec3 tap(vec2 uv) {
  return texture(iChannel0, clamp(uv, 0.0, 1.0)).rgb;
}

void mainImage(out vec4 o, in vec2 f) {
  vec2 R = iResolution.xy;
  float side = min(R.x, R.y);
  float k = clamp(uParam1, 0.0, 1.0);
  float scale = clamp(uParam2, 0.5, 8.0);
  float hue = fract(uParam3);
  // Grain : en millièmes du petit côté (identique à toute résolution).
  vec2 g = f / side * 1000.0 / scale;
  // Un millième du petit côté, en coordonnées de texture.
  vec2 mil = vec2(side / 1000.0) / R;

  // --- Géométrie : p centré, petit côté = 1.
  vec2 p = (f / R - 0.5) * R / side;
  if (fxOn(0)) p.x = -abs(p.x);
  if (fxOn(1)) {
    float s = 2.0 * PI / 6.0;
    float a = mod(atan(p.y, p.x), s);
    // L'intensité fait tourner le secteur échantillonné ; décalé du centre pour mêler plusieurs formes.
    a = abs(a - 0.5 * s) + k * 2.0 * PI;
    p = length(p) * 1.15 * vec2(cos(a), sin(a)) + vec2(-0.12, 0.04);
  }
  if (fxOn(2)) {
    float a = (1.0 - smoothstep(0.0, 0.7, length(p))) * (1.0 + 3.0 * k);
    p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
  }
  if (fxOn(3)) p += (0.004 + 0.012 * k) * vec2(sin(p.y * 38.0), sin(p.x * 38.0));
  if (fxOn(4)) {
    float cell = mix(0.006, 0.04, k);
    p = (floor(p / cell) + 0.5) * cell;
  }
  vec2 uv = p * side / R + 0.5;

  // --- Lumière.
  vec3 c = tap(uv);
  if (fxOn(5)) {
    vec2 d = (uv - 0.5) * (0.004 + 0.016 * k);
    c.r = tap(uv + d).r;
    c.b = tap(uv - d).b;
  }
  if (fxOn(6) || fxOn(7)) {
    vec3 b = vec3(0.0);
    float rr = 10.0 + 14.0 * k;
    for (int i = 0; i < 12; i++) {
      float a = float(i) * PI / 6.0;
      b += tap(uv + vec2(cos(a), sin(a)) * rr * mil);
      b += tap(uv + vec2(cos(a + 0.26), sin(a + 0.26)) * rr * 0.45 * mil);
    }
    b /= 24.0;
    if (fxOn(7)) c = mix(c, b, 0.4 + 0.6 * k);
    if (fxOn(6)) c = 1.0 - (1.0 - c) * (1.0 - b * b * (0.5 + 0.7 * k));
  }
  if (fxOn(8)) {
    vec2 e = 1.6 * mil;
    float gx = luma(tap(uv + vec2(e.x, 0.0))) - luma(tap(uv - vec2(e.x, 0.0)));
    float gy = luma(tap(uv + vec2(0.0, e.y))) - luma(tap(uv - vec2(0.0, e.y)));
    float edge = smoothstep(0.05, 0.2, length(vec2(gx, gy)));
    c *= 1.0 - edge * (0.5 + 0.45 * k);
  }

  // --- Couleur.
  if (fxOn(9)) {
    float l = luma(c);
    c = mix(vec3(l), c, 1.2 + 0.8 * k);
    c = (c - 0.5) * (1.1 + 0.4 * k) + 0.5;
    c = clamp(c, 0.0, 1.0);
  }
  if (fxOn(10)) c = clamp(hueTurn(c, hue * 2.0 * PI), 0.0, 1.0);
  if (fxOn(11)) {
    float l = smoothstep(0.05, 0.95, luma(c));
    vec3 dark = hueColor(hue) * 0.28;
    vec3 light = mix(vec3(1.0, 0.98, 0.94), hueColor(hue + 0.5), 0.22);
    c = mix(c, mix(dark, light, l), 0.6 + 0.4 * k);
  }
  if (fxOn(12)) {
    float l = luma(c);
    c = mix(c, vec3(l * 1.08 + 0.04, l * 0.9 + 0.02, l * 0.68), 0.6 + 0.4 * k);
  }
  if (fxOn(13)) {
    float lv = floor(mix(7.0, 2.0, k) + 0.5);
    c = floor(c * lv + 0.5) / lv;
  }
  if (fxOn(14)) c = 1.0 - c;
  if (fxOn(15)) {
    float t = luma(c);
    vec3 th = t < 0.25 ? mix(vec3(0.02, 0.0, 0.12), vec3(0.25, 0.05, 0.6), t / 0.25)
      : t < 0.5 ? mix(vec3(0.25, 0.05, 0.6), vec3(0.85, 0.1, 0.45), (t - 0.25) / 0.25)
      : t < 0.75 ? mix(vec3(0.85, 0.1, 0.45), vec3(1.0, 0.6, 0.05), (t - 0.5) / 0.25)
      : mix(vec3(1.0, 0.6, 0.05), vec3(1.0, 1.0, 0.8), (t - 0.75) / 0.25);
    c = mix(c, th, 0.6 + 0.4 * k);
  }

  // --- Matière.
  if (fxOn(16)) {
    float grain = vn(g * 0.9) * 0.5 + vn(g * 3.1) * 0.3 + h12(floor(g * 2.0)) * 0.2;
    float fibre = vn(vec2(g.x * 0.12, g.y * 2.4));
    vec3 paper = c * (0.9 + 0.2 * grain) * (0.97 + 0.06 * fibre) * vec3(1.0, 0.985, 0.95);
    c = mix(c, paper, 0.5 + 0.5 * k);
  }
  if (fxOn(17)) {
    float lv = 4.0;
    float thr = bayer4(floor(g / 2.5)) - 0.5;
    vec3 q = floor((c + thr / (lv - 1.0)) * (lv - 1.0) + 0.5) / (lv - 1.0);
    c = mix(c, clamp(q, 0.0, 1.0), 0.5 + 0.5 * k);
  }
  if (fxOn(18)) {
    float cs = 7.0;
    vec2 q = mat2(0.7071, -0.7071, 0.7071, 0.7071) * g / cs;
    float d = length(fract(q) - 0.5);
    float r = sqrt(clamp(1.0 - luma(c), 0.0, 1.0)) * 0.62;
    float dotm = 1.0 - smoothstep(r - 0.06, r + 0.06, d);
    vec3 ink = clamp(c * 0.8, 0.0, 1.0);
    vec3 ht = mix(vec3(0.98, 0.97, 0.94), ink, dotm);
    c = mix(c, ht, 0.6 + 0.4 * k);
  }
  if (fxOn(19)) {
    float l = luma(c);
    float w = 0.16;
    float h1 = step(fract((g.x + g.y) / 5.0), w) * step(l, 0.78);
    float h2 = step(fract((g.x - g.y) / 5.0), w) * step(l, 0.52);
    float h3 = step(fract(g.x / 3.5), w) * step(l, 0.28);
    float hatch = max(max(h1, h2), h3);
    vec3 paper = vec3(0.97, 0.95, 0.9);
    c = mix(c, mix(paper, c * 0.35, hatch), 0.6 + 0.4 * k);
  }
  if (fxOn(20)) c *= 1.0 - (0.12 + 0.25 * k) * (0.5 + 0.5 * cos(g.y * PI / 2.0));
  if (fxOn(21)) c += (h12(floor(g * 2.0) + 0.37) - 0.5) * (0.06 + 0.16 * k);
  if (fxOn(22)) {
    float vig = 1.0 - smoothstep(0.3, 0.95, length((f / R - 0.5) * R / side) * 1.15);
    c *= mix(1.0, 0.35 + 0.65 * vig, 0.5 + 0.5 * k);
  }

  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
