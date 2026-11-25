// Pixel art v2 : l'image du canal 0 redessinée en vrais pixels d'une palette limitée.
// Ordre : couleur cible de chaque pixel d'art, puis tout se décide sur les couleurs de la palette.
// 1. Grille entière ; le plus léger : render-size = résolution d'art + image-rendering: pixelated.
// 2. Représentant : échantillon le plus proche de la moyenne, mêlé (lissage) à un Kuwahara anisotrope
//    à 4 secteurs orienté le long des bords (aplats nets, grain et bruit de photo effacés).
// 3. Étalonnage OKLab : contraste, chroma, ombres vers le bleu-violet, lumières légèrement chaudes.
// 4. Index de palette (OKLab, garde de teinte et de saturation ; gameboy et mac par luminance).
// 5. Nettoyage sur les index : un pixel seul de sa couleur prend celle de ses voisins s'ils s'accordent.
// 6. Contours « sel-out » : côté sombre d'un bord franc, la couleur d'un cran plus sombre de la palette.
// 7. Tramage de Knoll (4 candidates ramenées à 2 couleurs), motif 2×2 (25 / 50 / 75 %), seulement dans les
//    dégradés : ni aplat, ni bord, ni contour, jamais entre couleurs trop éloignées.
// Le même calcul est refait pour les 4 voisins : nettoyage et contours voient les index affichés.
// Réglages : uParam0 lignes de pixels ; uParam1 palette (partie entière : 0 = couleurs de l'attribut
// colors, 8 au plus, sans colors niveaux automatiques ; 1 pico8, 2 gameboy, 3 braise, 4 ocean, 5 terre,
// 6 pastel, 7 nord, 8 cga, 9 zx, 10 mac) + lissage (décimales, 0 à 0,99) ; uParam2 tramage ; uParam3 contours.
const vec3 PAL[84] = vec3[](vec3(.0000,.0000,.0000),vec3(.1137,.1686,.3255),vec3(.4941,.1451,.3255),vec3(.0000,.5294,.3176),vec3(.6706,.3216,.2118),vec3(.3725,.3412,.3098),vec3(.7608,.7647,.7804),vec3(1.0000,.9451,.9098),vec3(1.0000,.0000,.3020),vec3(1.0000,.6392,.0000),vec3(1.0000,.9255,.1529),vec3(.0000,.8941,.2118),vec3(.1608,.6784,1.0000),vec3(.5137,.4627,.6118),vec3(1.0000,.4667,.6588),vec3(1.0000,.8000,.6667),vec3(.0588,.2196,.0588),vec3(.1882,.3843,.1882),vec3(.5451,.6745,.0588),vec3(.6078,.7373,.0588),vec3(.0706,.0510,.1020),vec3(.2392,.0824,.1882),vec3(.4784,.1216,.1686),vec3(.7608,.2549,.1765),vec3(.9412,.5412,.1412),vec3(1.0000,.8196,.4000),vec3(1.0000,.9529,.8392),vec3(.0118,.0157,.3686),vec3(.0078,.2431,.5412),vec3(.0000,.4667,.7137),vec3(.0000,.5882,.7804),vec3(.2824,.7922,.8941),vec3(.6784,.9098,.9569),vec3(.9451,.9804,.9333),vec3(.1686,.1137,.0784),vec3(.3569,.2275,.1608),vec3(.5490,.3529,.2353),vec3(.7255,.5098,.3098),vec3(.8510,.7059,.5608),vec3(.9373,.8784,.7843),vec3(.4196,.4392,.3608),vec3(.6471,.6471,.5529),vec3(.2392,.2275,.2941),vec3(.4902,.5176,.6980),vec3(.5608,.6510,.7961),vec3(.8588,.9569,.6549),vec3(.8353,.9765,.8706),vec3(.9686,.8392,.8784),vec3(.9490,.7098,.8314),vec3(.9922,.9647,.9255),vec3(.1804,.2039,.2510),vec3(.2314,.2588,.3216),vec3(.2980,.3373,.4157),vec3(.8471,.8706,.9137),vec3(.9255,.9373,.9569),vec3(.5608,.7373,.7333),vec3(.5333,.7529,.8157),vec3(.3686,.5059,.6745),vec3(.7490,.3804,.4157),vec3(.8157,.5294,.4392),vec3(.9216,.7961,.5451),vec3(.6392,.7451,.5490),vec3(.7059,.5569,.6784),vec3(.0000,.0000,.0000),vec3(.3333,1.0000,1.0000),vec3(1.0000,.3333,1.0000),vec3(1.0000,1.0000,1.0000),vec3(.0000,.0000,.0000),vec3(.0000,.0000,.8431),vec3(.8431,.0000,.0000),vec3(.8431,.0000,.8431),vec3(.0000,.8431,.0000),vec3(.0000,.8431,.8431),vec3(.8431,.8431,.0000),vec3(.8431,.8431,.8431),vec3(.0000,.0000,1.0000),vec3(1.0000,.0000,.0000),vec3(1.0000,.0000,1.0000),vec3(.0000,1.0000,.0000),vec3(.0000,1.0000,1.0000),vec3(1.0000,1.0000,.0000),vec3(1.0000,1.0000,1.0000),vec3(.1059,.1059,.1059),vec3(.9490,.9412,.9020));
const int PAL_OFF[10] = int[](0,16,20,27,34,42,50,63,67,82);
const int PAL_CNT[10] = int[](16,4,7,7,8,8,13,4,15,2);
vec4 uColor(int i){ return i == 0 ? uColor0 : i == 1 ? uColor1 : i == 2 ? uColor2 : i == 3 ? uColor3 : i == 4 ? uColor4 : i == 5 ? uColor5 : i == 6 ? uColor6 : uColor7; }

vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 oklab(vec3 c){
  c = toLin(clamp(c, 0.0, 1.0));
  vec3 lms = vec3(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
                  dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
                  dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
  return vec3(dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
              dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
              dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}
vec3 fromOklab(vec3 l){
  vec3 lms = vec3(l.x + 0.3963377774 * l.y + 0.2158037573 * l.z,
                  l.x - 0.1055613458 * l.y - 0.0638541728 * l.z,
                  l.x - 0.0894841775 * l.y - 1.2914855480 * l.z);
  lms = lms * lms * lms;
  return toSrgb(vec3(dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
                     dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
                     dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010))));
}
float bayer4(vec2 p){
  p = mod(floor(p), 4.0);
  float a = mod(p.x, 2.0), b = mod(p.y, 2.0), c = floor(p.x / 2.0), d = floor(p.y / 2.0);
  return (4.0 * (2.0 * mod(a + b, 2.0) + b) + 2.0 * mod(c + d, 2.0) + d + 0.5) / 16.0;
}
// Rang 0..3 du motif 2×2 (0 2 / 3 1) : 1, 2 ou 3 cases sur 4 = 25, 50, 75 %.
int bayer2(vec2 p){
  p = mod(floor(p), 2.0);
  return p.x < 0.5 ? (p.y < 0.5 ? 0 : 3) : (p.y < 0.5 ? 2 : 1);
}
vec3 grade(vec3 l){
  l.x = clamp((l.x - 0.5) * 1.12 + 0.5, 0.0, 1.0);
  l.yz *= 1.25;
  float s = l.x - 0.5;
  l.yz += s < 0.0 ? vec2(0.012, -0.045) * (-s) : vec2(0.003, 0.025) * s * (1.0 - s);
  return l;
}

vec2 gCell;  // taille d'une cellule en pixels du canvas
float gLis;  // lissage 0..1
vec3 src(vec2 uv){ return texture(iChannel0, uv).rgb; }
// Échantillon (sur 3×3) le plus proche de la moyenne de la cellule : net, sans bouillie de bord.
vec3 nearMean(vec2 cell, vec2 cs){
  vec3 s[9]; vec3 m = vec3(0.0);
  for (int i = 0; i < 9; i++){ s[i] = src((cell + (vec2(float(i - (i / 3) * 3), float(i / 3)) + 0.5) / 3.0) * cs); m += s[i]; }
  m /= 9.0;
  vec3 best = s[4]; float bd = 1e9;
  for (int i = 0; i < 9; i++){ vec3 d = s[i] - m; float e = dot(d, d); if (e < bd){ bd = e; best = s[i]; } }
  return mix(best, m, 0.25);
}
// Kuwahara anisotrope (4 secteurs) : fenêtre elliptique étirée le long du bord, secteur le plus homogène favorisé.
vec3 kuwahara(vec2 cell, vec2 cs){
  vec2 c = (cell + 0.5) * cs;
  vec3 lw = vec3(0.299, 0.587, 0.114);
  float gx = dot(src(c + vec2(0.5 * cs.x, 0.0)) - src(c - vec2(0.5 * cs.x, 0.0)), lw);
  float gy = dot(src(c + vec2(0.0, 0.5 * cs.y)) - src(c - vec2(0.0, 0.5 * cs.y)), lw);
  float gm = length(vec2(gx, gy));
  vec2 t = gm > 1e-4 ? vec2(-gy, gx) / gm : vec2(1.0, 0.0);
  float an = clamp(gm * 6.0, 0.0, 0.85);
  float r = 0.5 + 1.5 * gLis;
  vec2 ax = t * r * (1.0 + an), ay = vec2(-t.y, t.x) * r / (1.0 + an);
  vec3 c0 = src(c), acc = vec3(0.0);
  float wt = 0.0;
  for (int k = 0; k < 4; k++){
    vec3 m = c0, s2 = c0 * c0;
    for (int j = 0; j < 6; j++){
      float a = (float(k) + 0.17 + 0.33 * float(j - (j / 3) * 3)) * 1.5707963;
      vec2 o = (ax * cos(a) + ay * sin(a)) * (j < 3 ? 0.45 : 0.9);
      vec3 v = src(c + o * cs);
      m += v; s2 += v * v;
    }
    m /= 7.0;
    vec3 va = abs(s2 / 7.0 - m * m);
    float w = 1.0 / (1.0 + pow(sqrt(va.r + va.g + va.b) * 40.0, 4.0));
    acc += m * w; wt += w;
  }
  return acc / wt;
}
// Couleur cible (OKLab étalonné) d'un pixel d'art.
vec3 target(vec2 cell){
  vec2 cs = gCell / iResolution.xy;
  vec3 a = nearMean(cell, cs);
  if (gLis > 0.01) a = mix(a, kuwahara(cell, cs), gLis);
  return grade(oklab(a));
}

int gN;           // couleurs de la palette
vec3 gLab[16];    // palette en OKLab (luminance seule pour gameboy et mac)
float perr(vec3 l, vec3 q){
  vec3 d = (q - l) * vec3(0.85, 1.0, 1.0);
  float e = dot(d, d);
  float c1 = length(l.yz), c2 = length(q.yz);
  if (c1 > 0.03 && c2 > 0.03){ float h = 1.0 - dot(l.yz / c1, q.yz / c2); e += 0.6 * h * h * c1; }
  float lost = max(c1 - c2, 0.0); // une couleur saturée ne devient pas grise
  return e + 1.4 * lost * lost;
}
int nearest(vec3 l){
  int b = 0; float be = 1e9;
  for (int i = 0; i < 16; i++){
    if (i >= gN) break;
    float e = perr(l, gLab[i]);
    if (e < be){ be = e; b = i; }
  }
  return b;
}
// Un cran plus sombre dans la palette, au plus près de la même teinte (contour sel-out).
int rampDown(int i0){
  vec3 s = gLab[i0];
  int b = i0; float bs = 1e9;
  for (int i = 0; i < 16; i++){
    if (i >= gN) break;
    vec3 q = gLab[i];
    if (q.x > s.x - 0.04) continue;
    float sc = abs(q.x - (s.x - 0.2)) * 1.5 + length(q.yz - s.yz * 0.8);
    if (sc < bs){ bs = sc; b = i; }
  }
  return b;
}

// Pente qui se poursuit des deux côtés, dans le même sens (0 pour un bord, un aplat ou du bruit).
float pente(vec3 a, vec3 b){
  float la = length(a), lb = length(b);
  return la * lb > 1e-8 ? max(dot(a, b), 0.0) / (la * lb) * min(la, lb) : 0.0;
}

void mainImage(out vec4 o, in vec2 frag){
  float lines = clamp(uParam0, 16.0, 480.0);
  gCell = vec2(max(1.0, floor(iResolution.y / lines + 0.5)));
  vec2 cell = floor(frag / gCell);
  int p = int(clamp(floor(uParam1 + 0.001), 0.0, 10.0));
  gLis = clamp(fract(uParam1 + 0.001) * 1.0101, 0.0, 1.0);
  float dith = clamp(uParam2, 0.0, 1.0), edge = clamp(uParam3, 0.0, 1.0);

  vec3 c[5];
  c[0] = target(cell);
  c[1] = target(cell + vec2(1.0, 0.0));
  c[2] = target(cell - vec2(1.0, 0.0));
  c[3] = target(cell + vec2(0.0, 1.0));
  c[4] = target(cell - vec2(0.0, 1.0));
  // Aplat, bord ou dégradé, sur les couleurs cibles (déjà lissées : le grain d'une photo n'est pas un
  // dégradé) : un dégradé change des deux côtés du pixel et dans le même sens ; un bord d'un seul côté,
  // un aplat nulle part, le bruit dans tous les sens.
  float gx = pente(c[1] - c[0], c[0] - c[2]), gy = pente(c[3] - c[0], c[0] - c[4]);
  float grad = smoothstep(0.0015, 0.006, max(gx, gy));

  // Palette
  gN = 0;
  if (p >= 1) gN = PAL_CNT[p - 1];
  else for (int i = 0; i < 8; i++){ if (uColor(i).a > 0.0) gN++; else break; }
  if (gN < 2){
    // Sans palette : niveaux OKLab (luminance 7 crans, chroma 5) tramés.
    vec3 lv = vec3(6.0, 10.0, 10.0);
    vec3 q = floor(c[0] * lv + vec3(0.0, 5.0, 5.0) + mix(vec3(0.5), vec3(bayer4(cell)), dith));
    o = vec4(clamp(fromOklab((q - vec3(0.0, 5.0, 5.0)) / lv), 0.0, 1.0), 1.0);
    return;
  }
  bool mono = p == 2 || p == 10;
  float lo = 1e9, hi = -1e9;
  for (int i = 0; i < 16; i++){
    if (i >= gN) break;
    gLab[i] = oklab(p >= 1 ? PAL[PAL_OFF[p - 1] + i] : uColor(i).rgb);
    lo = min(lo, gLab[i].x); hi = max(hi, gLab[i].x);
  }
  if (mono){
    for (int i = 0; i < 16; i++){ if (i >= gN) break; gLab[i] = vec3(gLab[i].x, 0.0, 0.0); }
    for (int k = 0; k < 5; k++) c[k] = vec3(mix(lo, hi, smoothstep(0.08, 0.92, c[k].x)), 0.0, 0.0);
  }
  int idx[5];
  for (int k = 0; k < 5; k++) idx[k] = nearest(c[k]);
  int i0 = idx[0];

  // Nettoyage sur les index : seul de sa couleur parmi 4 voisins qui s'accordent (3 sur 4) → leur couleur.
  bool orphan = false;
  if (idx[1] != i0 && idx[2] != i0 && idx[3] != i0 && idx[4] != i0){
    for (int k = 1; k < 5; k++){
      int n = 0;
      for (int j = 1; j < 5; j++) if (idx[j] == idx[k]) n++;
      if (n >= 3){
        if (length(c[0] - gLab[idx[k]]) < 0.18){ i0 = idx[k]; c[0] = gLab[i0]; orphan = true; }
        break;
      }
    }
  }

  // Contour : côté sombre d'un bord franc (sur les couleurs cibles), couleur d'un cran plus sombre.
  bool outline = false;
  if (edge > 0.0){
    float th = mix(0.32, 0.07, edge);
    for (int k = 1; k < 5; k++){
      vec3 d = c[k] - c[0];
      int op = k == 1 ? 2 : k == 2 ? 1 : k == 3 ? 4 : 3;  // voisin opposé : un bord n'a qu'un côté (le bruit en a deux)
      if (idx[k] != i0 && length(d * vec3(1.6, 1.0, 1.0)) > th && d.x > mix(0.16, 0.06, edge) && length(c[op] - c[0]) < 0.5 * th) outline = true;
    }
  }
  if (outline) i0 = rampDown(i0);

  // Tramage de Knoll : 4 candidates par diffusion d'erreur locale, rangées par luminance, motif 2×2.
  int outI = i0;
  float s = (outline || orphan) ? 0.0 : dith * grad;
  if (s > 0.0){
    int cand[4];
    vec3 e = vec3(0.0);
    float gap = mix(0.2, 0.42, s);
    for (int k = 0; k < 4; k++){
      int ik = nearest(c[0] + e * s);
      if (length(gLab[ik] - c[0]) > gap) ik = i0;
      cand[k] = ik;
      e += c[0] - gLab[ik];
    }
    // Deux couleurs par motif au plus (pixel art) : la cible et la première autre candidate.
    int i2 = i0;
    for (int k = 0; k < 4; k++) if (i2 == i0 && cand[k] != i0) i2 = cand[k];
    for (int k = 0; k < 4; k++) if (cand[k] != i0 && cand[k] != i2) cand[k] = perr(gLab[cand[k]], gLab[i0]) < perr(gLab[cand[k]], gLab[i2]) ? i0 : i2;
    // Le motif n'est gardé que s'il approche mieux la cible que la couleur seule, son contraste compté
    // (pénalité de Yliluoma, d'autant plus faible que le tramage est fort) : pas de motif pour rien.
    int nq = 0;
    for (int k = 0; k < 4; k++) if (cand[k] == i2 && i2 != i0) nq++;
    if (nq > 0){
      float q = float(nq) / 4.0;
      vec3 d = gLab[i2] - gLab[i0];
      float pen = 0.08 * pow(40.0, 1.0 - s) * dot(d, d) * q * (1.0 - q);
      if (perr(c[0], mix(gLab[i0], gLab[i2], q)) + pen >= perr(c[0], gLab[i0])) for (int k = 0; k < 4; k++) cand[k] = i0;
    }
    for (int a = 0; a < 3; a++){
      for (int b = 0; b < 3; b++){
        if (b >= 3 - a) break;
        if (gLab[cand[b]].x > gLab[cand[b + 1]].x){ int tmp = cand[b]; cand[b] = cand[b + 1]; cand[b + 1] = tmp; }
      }
    }
    outI = cand[bayer2(cell)];
  }
  o = vec4(clamp(p >= 1 ? PAL[PAL_OFF[p - 1] + outI] : uColor(outI).rgb, 0.0, 1.0), 1.0);
}
