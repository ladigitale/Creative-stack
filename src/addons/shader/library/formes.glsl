// Formes génératives à vectoriser (sonic-vectorize → sonic-sketch import-from). Image fixe (iTime non lu) :
// chaque réglage donne une image nette en aplats de quelques couleurs très distinctes sur fond noir (le
// vide : import-skip="#000000"), recolorées ensuite par la palette (import-colors-from).
// uParam0 motif : 0 cellules, 1 courbes de niveau, 2 rosace, 3 entrelacs (Truchet), 4 taches.
// uParam1 graine. uParam2 densité (1..10). uParam3 nombre de couleurs (2..6).

float hash1(vec2 p, float s) {
  return fract(sin(dot(p, vec2(12.9898, 78.233)) + s * 7.31) * 43758.5453);
}

vec2 hash2(vec2 p, float s) {
  vec2 q = vec2(dot(p, vec2(127.1, 311.7)) + s * 17.13, dot(p, vec2(269.5, 183.3)) + s * 31.7);
  return fract(sin(q) * 43758.5453);
}

float vnoise(vec2 p, float s) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash1(i, s);
  float b = hash1(i + vec2(1.0, 0.0), s);
  float c = hash1(i + vec2(0.0, 1.0), s);
  float d = hash1(i + vec2(1.0, 1.0), s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p, float s) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p, s);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

// Couleurs d'index très écartées : la vectorisation les sépare sans ambiguïté.
vec3 bandColor(int i) {
  if (i == 0) return vec3(1.0, 0.0, 0.0);
  if (i == 1) return vec3(0.0, 0.8, 0.0);
  if (i == 2) return vec3(0.0, 0.0, 1.0);
  if (i == 3) return vec3(1.0, 1.0, 0.0);
  if (i == 4) return vec3(1.0, 0.0, 1.0);
  return vec3(0.0, 1.0, 1.0);
}

void mainImage(out vec4 o, in vec2 f) {
  // Carré centré : -0.5..0.5 sur le petit côté.
  vec2 uv = (f - 0.5 * iResolution.xy) / min(iResolution.x, iResolution.y);
  int motif = int(uParam0 + 0.5);
  float seed = floor(uParam1 + 0.5);
  float dens = clamp(uParam2, 1.0, 10.0);
  int n = int(clamp(uParam3 + 0.5, 2.0, 6.0));
  float nf = float(n);
  int idx = -1;

  if (motif == 0) {
    // Cellules de Voronoï séparées par un joint vide.
    vec2 p = uv * dens * 2.0;
    vec2 g = floor(p);
    vec2 fr = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    vec2 best = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 c = vec2(float(x), float(y));
        vec2 r = c + hash2(g + c, seed) - fr;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; best = g + c; }
        else if (d < d2) { d2 = d; }
      }
    }
    if (sqrt(d2) - sqrt(d1) > 0.08) idx = int(hash1(best, seed + 3.0) * nf);
  } else if (motif == 1) {
    // Courbes de niveau d'un bruit : bandes séparées par un trait vide.
    float t = fbm(uv * dens * 1.5 + seed * 3.1, seed) * (nf + 1.0);
    float k = floor(t);
    if (k >= 1.0 && fract(t) > 0.12) idx = int(mod(k - 1.0, nf));
  } else if (motif == 2) {
    // Rosace : pétales en anneaux concentriques.
    float r = length(uv) * 2.0;
    float a = atan(uv.y, uv.x);
    float k = floor(2.0 + dens);
    float petal = 0.55 + 0.35 * cos(k * a + seed * 0.7);
    if (r < petal) {
      float t = r / petal * nf;
      if (t < 1.0 || fract(t) > 0.1) idx = int(min(floor(t), nf - 1.0));
    }
  } else if (motif == 3) {
    // Entrelacs de Truchet : arcs de quart de cercle, une couleur par arc.
    vec2 p = uv * dens * 2.0;
    vec2 g = floor(p);
    vec2 fr = fract(p) - 0.5;
    if (hash1(g, seed) > 0.5) fr.x = -fr.x;
    float da = abs(length(fr - vec2(0.5)) - 0.5);
    float db = abs(length(fr + vec2(0.5)) - 0.5);
    if (min(da, db) < 0.16) idx = int(hash1(g + (da < db ? vec2(0.3) : vec2(0.7)), seed + 5.0) * nf);
  } else {
    // Taches : champ de métaballes en anneaux.
    float v = 0.0;
    for (int i = 0; i < 12; i++) {
      vec2 c = (hash2(vec2(float(i), 3.0), seed) - 0.5) * 0.85;
      float rad = 0.03 + 0.06 * hash1(vec2(float(i), 7.0), seed);
      vec2 d = uv - c;
      v += rad * rad / max(dot(d, d), 1e-5);
    }
    v *= dens * 0.25;
    if (v > 1.0) {
      float t = log2(v) * nf / 3.0;
      if (t < 1.0 || fract(t) > 0.1) idx = int(min(floor(t), nf - 1.0));
    }
  }

  o = idx < 0 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(bandColor(idx), 1.0);
}
