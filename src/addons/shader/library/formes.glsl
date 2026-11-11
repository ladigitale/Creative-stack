// Formes génératives à vectoriser (sonic-vectorize → sonic-sketch import-from). Image fixe (iTime non lu) :
// chaque réglage donne une image nette en aplats de quelques couleurs très distinctes sur fond noir (le
// vide : import-skip="#000000"), recolorées ensuite par la palette (import-colors-from).
// iChannel1 facultatif : bande de couleurs (une colonne de pixels par couleur, ex. image SVG de N×1) ; la
// couleur d'index i est alors la i-ème de la bande (modulo sa largeur) : aperçu et formes aux couleurs de la palette.
// uParam0 motif : 0 cellules, 1 courbes de niveau, 2 rosace, 3 entrelacs (Truchet), 4 taches,
// 5 rayures ondulées, 6 spirale, 7 écailles, 8 labyrinthe, 9 bouquet, 10 triangles, 11 damier ondulé,
// 12 ondes (interférences).
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
  } else if (motif == 5) {
    // Rayures ondulées : bandes déformées par un bruit, séparées par un trait vide.
    float w = fbm(uv * 2.0 + seed * 1.3, seed) * 1.6;
    float t = (uv.y + 0.18 * sin(uv.x * 6.0 + seed) + w * 0.25) * dens * 2.2;
    if (fract(t) > 0.14) idx = int(mod(floor(t) + 100.0, nf));
  } else if (motif == 6) {
    // Spirale : bras logarithmiques.
    float r = length(uv) + 1e-4;
    float a = atan(uv.y, uv.x);
    // Nombre de bras multiple du nombre de couleurs : pas de couture à l'angle ±π.
    float arms = nf * floor(1.0 + dens * 0.25);
    float t = (a / 6.2831853) * arms + log(r) * (1.2 + 0.25 * mod(seed, 5.0)) * 2.0;
    if (r < 0.62 && fract(t) > 0.16) idx = int(mod(floor(t) + 100.0, nf));
  } else if (motif == 7) {
    // Écailles : rangées de disques décalées, chaque rangée recouvre celle du dessus ; joint vide.
    vec2 p = uv * dens * 2.4;
    float j = floor(p.y);
    for (int dy = -1; dy <= 1; dy++) {
      float row = j + float(dy);
      float off = mod(row, 2.0) * 0.5;
      float cx = floor(p.x - off + 0.5) + off;
      vec2 ctr = vec2(cx, row);
      float d = length(p - ctr);
      if (d < 0.7) idx = d < 0.62 ? int(hash1(ctr, seed + 2.0) * nf) : -1;
    }
  } else if (motif == 8) {
    // Labyrinthe : diagonales épaisses de Truchet, une couleur par case.
    vec2 p = uv * dens * 2.6;
    vec2 g = floor(p);
    vec2 fr = fract(p);
    float s = hash1(g, seed) > 0.5 ? fr.x - fr.y : fr.x + fr.y - 1.0;
    if (abs(s) < 0.22) idx = int(hash1(g + 0.37, seed + 4.0) * nf);
  } else if (motif == 9) {
    // Bouquet : fleurs éparses à pétales, cœur d'une autre couleur.
    for (int i = 0; i < 18; i++) {
      vec2 c = (hash2(vec2(float(i), 11.0), seed) - 0.5) * 0.9;
      float sz = (0.08 + 0.09 * hash1(vec2(float(i), 5.0), seed)) * (4.0 / (2.0 + dens * 0.4));
      vec2 d = uv - c;
      float r = length(d) / sz;
      float a = atan(d.y, d.x);
      float k = 5.0 + floor(hash1(vec2(float(i), 2.0), seed) * 4.0);
      float pet = 0.65 + 0.35 * cos(k * a);
      if (r < 0.32) idx = int(mod(float(i) + 1.0, nf));
      else if (r < pet && r > 0.4) idx = int(mod(float(i), nf));
    }
  } else if (motif == 10) {
    // Triangles : pavage triangulaire, joints vides.
    vec2 p = uv * dens * 2.4;
    vec2 q = vec2(p.x - p.y * 0.57735, p.y * 1.1547);
    vec2 g = floor(q);
    vec2 fr = fract(q);
    float up = step(fr.x + fr.y, 1.0);
    float e = up > 0.5 ? min(min(fr.x, fr.y), 1.0 - fr.x - fr.y) : min(min(1.0 - fr.x, 1.0 - fr.y), fr.x + fr.y - 1.0);
    if (e > 0.06) idx = int(hash1(g + up * 0.5, seed + 6.0) * nf);
  } else if (motif == 11) {
    // Damier ondulé : damier déformé par un bruit.
    vec2 p = uv * dens * 1.8;
    p += vec2(fbm(p * 0.6 + seed, seed), fbm(p * 0.6 - seed, seed + 1.0)) * 1.4;
    vec2 g = floor(p);
    vec2 fr = fract(p);
    if (min(min(fr.x, fr.y), min(1.0 - fr.x, 1.0 - fr.y)) > 0.07) idx = int(mod(g.x + g.y * 2.0 + 64.0, nf));
  } else if (motif == 12) {
    // Ondes : interférences de trois sources circulaires.
    float v = 0.0;
    for (int i = 0; i < 3; i++) {
      vec2 c = (hash2(vec2(float(i), 21.0), seed) - 0.5) * 0.9;
      v += sin(length(uv - c) * dens * 9.0);
    }
    float t = (v + 3.0) / 6.0 * (nf + 0.999);
    if (fract(t) > 0.12) idx = int(min(floor(t), nf - 1.0));
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

  if (idx < 0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float pw = floor(iChannelResolution[1].x + 0.5);
  if (pw >= 1.0) {
    float k = mod(float(idx), pw);
    o = vec4(texture(iChannel1, vec2((k + 0.5) / pw, 0.5)).rgb, 1.0);
  } else {
    o = vec4(bandColor(idx), 1.0);
  }
}
