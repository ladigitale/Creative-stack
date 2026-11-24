// Pixel art : l'image du canal 0 redessinée en vrais pixels d'une palette limitée.
// - Grille entière (cellules carrées) ; rendu le plus léger avec render-size = résolution d'art
//   et image-rendering: pixelated (une cellule = un pixel du canvas).
// - Couleur de cellule = échantillon le plus proche de la moyenne (net, pas de bouillie aux bords).
// - Pixel orphelin absorbé par ses voisins ; étalonnage OKLab (contraste, chroma,
//   ombres vers le bleu-violet, lumières légèrement chaudes).
// - Contours « sel-out » : côté sombre d'un bord franc, teinte plus sombre et plus froide, 1 pixel.
// - Palette en OKLab avec garde de teinte et de saturation ; tramage ordonné 4x4 par la meilleure
//   paire de couleurs (Yliluoma), seulement dans les dégradés : ni aplat ni bord tramés, jamais
//   entre couleurs trop éloignées. Palettes monochromes (gameboy, mac) : par luminance.
// Palettes (réglage 1) : 0 = couleurs du document (attribut colors, 8 au plus ; sans colors :
// niveaux OKLab automatiques), 1 pico8, 2 gameboy, 3 braise, 4 ocean, 5 terre, 6 pastel, 7 nord,
// 8 cga, 9 zx, 10 mac.
const vec3 PAL_RGB[84] = vec3[](vec3(.0000,.0000,.0000),vec3(.1137,.1686,.3255),vec3(.4941,.1451,.3255),vec3(.0000,.5294,.3176),vec3(.6706,.3216,.2118),vec3(.3725,.3412,.3098),vec3(.7608,.7647,.7804),vec3(1.0000,.9451,.9098),vec3(1.0000,.0000,.3020),vec3(1.0000,.6392,.0000),vec3(1.0000,.9255,.1529),vec3(.0000,.8941,.2118),vec3(.1608,.6784,1.0000),vec3(.5137,.4627,.6118),vec3(1.0000,.4667,.6588),vec3(1.0000,.8000,.6667),vec3(.0588,.2196,.0588),vec3(.1882,.3843,.1882),vec3(.5451,.6745,.0588),vec3(.6078,.7373,.0588),vec3(.0706,.0510,.1020),vec3(.2392,.0824,.1882),vec3(.4784,.1216,.1686),vec3(.7608,.2549,.1765),vec3(.9412,.5412,.1412),vec3(1.0000,.8196,.4000),vec3(1.0000,.9529,.8392),vec3(.0118,.0157,.3686),vec3(.0078,.2431,.5412),vec3(.0000,.4667,.7137),vec3(.0000,.5882,.7804),vec3(.2824,.7922,.8941),vec3(.6784,.9098,.9569),vec3(.9451,.9804,.9333),vec3(.1686,.1137,.0784),vec3(.3569,.2275,.1608),vec3(.5490,.3529,.2353),vec3(.7255,.5098,.3098),vec3(.8510,.7059,.5608),vec3(.9373,.8784,.7843),vec3(.4196,.4392,.3608),vec3(.6471,.6471,.5529),vec3(.2392,.2275,.2941),vec3(.4902,.5176,.6980),vec3(.5608,.6510,.7961),vec3(.8588,.9569,.6549),vec3(.8353,.9765,.8706),vec3(.9686,.8392,.8784),vec3(.9490,.7098,.8314),vec3(.9922,.9647,.9255),vec3(.1804,.2039,.2510),vec3(.2314,.2588,.3216),vec3(.2980,.3373,.4157),vec3(.8471,.8706,.9137),vec3(.9255,.9373,.9569),vec3(.5608,.7373,.7333),vec3(.5333,.7529,.8157),vec3(.3686,.5059,.6745),vec3(.7490,.3804,.4157),vec3(.8157,.5294,.4392),vec3(.9216,.7961,.5451),vec3(.6392,.7451,.5490),vec3(.7059,.5569,.6784),vec3(.0000,.0000,.0000),vec3(.3333,1.0000,1.0000),vec3(1.0000,.3333,1.0000),vec3(1.0000,1.0000,1.0000),vec3(.0000,.0000,.0000),vec3(.0000,.0000,.8431),vec3(.8431,.0000,.0000),vec3(.8431,.0000,.8431),vec3(.0000,.8431,.0000),vec3(.0000,.8431,.8431),vec3(.8431,.8431,.0000),vec3(.8431,.8431,.8431),vec3(.0000,.0000,1.0000),vec3(1.0000,.0000,.0000),vec3(1.0000,.0000,1.0000),vec3(.0000,1.0000,.0000),vec3(.0000,1.0000,1.0000),vec3(1.0000,1.0000,.0000),vec3(1.0000,1.0000,1.0000),vec3(.1059,.1059,.1059),vec3(.9490,.9412,.9020));
const vec3 PAL_LAB[84] = vec3[](vec3(.0000,.0000,.0000),vec3(.2997,-.0035,-.0748),vec3(.4169,.1300,-.0172),vec3(.5486,-.1203,.0511),vec3(.5438,.0978,.0766),vec3(.4619,.0063,.0152),vec3(.8176,.0005,-.0056),vec3(.9667,.0111,.0159),vec3(.6340,.2420,.0769),vec3(.7892,.0596,.1606),vec3(.9297,-.0434,.1838),vec3(.7979,-.2083,.1499),vec3(.7178,-.0737,-.1425),vec3(.5915,.0297,-.0509),vec3(.7421,.1721,-.0016),vec3(.8816,.0419,.0604),vec3(.3015,-.0653,.0488),vec3(.4478,-.0771,.0565),vec3(.6948,-.0893,.1401),vec3(.7441,-.0926,.1506),vec3(.1725,.0142,-.0234),vec3(.2688,.0697,-.0227),vec3(.3910,.1185,.0382),vec3(.5558,.1436,.0881),vec3(.7288,.0837,.1384),vec3(.8803,.0093,.1345),vec3(.9661,.0013,.0400),vec3(.2250,-.0106,-.1456),vec3(.3803,-.0288,-.1356),vec3(.5464,-.0603,-.1167),vec3(.6308,-.0804,-.0975),vec3(.7789,-.0970,-.0647),vec3(.8948,-.0527,-.0324),vec3(.9751,-.0136,.0124),vec3(.2455,.0162,.0221),vec3(.3829,.0365,.0404),vec3(.5158,.0496,.0617),vec3(.6509,.0439,.0850),vec3(.7935,.0260,.0603),vec3(.9124,.0064,.0353),vec3(.5349,-.0149,.0270),vec3(.7153,-.0100,.0322),vec3(.3584,.0114,-.0270),vec3(.6251,.0091,-.0693),vec3(.7206,-.0106,-.0591),vec3(.9308,-.0559,.0860),vec3(.9492,-.0462,.0236),vec3(.9064,.0388,-.0016),vec3(.8379,.0787,-.0181),vec3(.9758,.0034,.0148),vec3(.3244,-.0023,-.0228),vec3(.3792,-.0018,-.0289),vec3(.4523,-.0036,-.0350),vec3(.8993,-.0021,-.0162),vec3(.9513,-.0012,-.0073),vec3(.7629,-.0462,-.0119),vec3(.7746,-.0494,-.0379),vec3(.5944,-.0213,-.0743),vec3(.6061,.1163,.0319),vec3(.6929,.0756,.0596),vec3(.8549,.0092,.0888),vec3(.7683,-.0492,.0565),vec3(.6921,.0555,-.0287),vec3(.0000,.0000,.0000),vec3(.9150,-.1318,-.0354),vec3(.7401,.2303,-.1445),vec3(1.0000,.0000,.0000),vec3(.0000,.0000,.0000),vec3(.3974,-.0285,-.2739),vec3(.5521,.1977,.1106),vec3(.6169,.2414,-.1487),vec3(.7617,-.2056,.1578),vec3(.7960,-.1314,-.0346),vec3(.8510,-.0627,.1746),vec3(.8792,.0000,.0000),vec3(.4520,-.0325,-.3115),vec3(.6280,.2249,.1258),vec3(.7017,.2746,-.1692),vec3(.8664,-.2339,.1795),vec3(.9054,-.1494,-.0394),vec3(.9680,-.0714,.1986),vec3(1.0000,.0000,.0000),vec3(.2221,.0000,.0000),vec3(.9539,-.0017,.0133));
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
  float x = p.x, y = p.y;
  float a = mod(x, 2.0), b = mod(y, 2.0), c = floor(x / 2.0), d = floor(y / 2.0);
  float m2 = 2.0 * mod(a + b, 2.0) + b;
  float m1 = 2.0 * mod(c + d, 2.0) + d;
  return (4.0 * m2 + m1 + 0.5) / 16.0;
}

// Étalonnage pixel art dans OKLab : contraste, chroma, ombres vers le bleu-violet, lumières vers le jaune.
vec3 grade(vec3 l){
  l.x = clamp((l.x - 0.5) * 1.12 + 0.5, 0.0, 1.0);
  l.yz *= 1.25;
  float s = l.x - 0.5;
  l.yz += s < 0.0 ? vec2(0.012, -0.045) * (-s) : vec2(0.003, 0.025) * s * (1.0 - s);
  return l;
}

vec2 gCell; // taille d'une cellule en pixels du canvas
vec3 tap(vec2 cell, vec2 f){ return texture(iChannel0, (cell + f) * gCell / iResolution.xy).rgb; }
// Couleur représentative : l'échantillon (3x3) le plus proche de la moyenne de la cellule.
vec3 repr(vec2 cell){
  vec3 s[9]; vec3 m = vec3(0.0);
  for (int i = 0; i < 9; i++){ s[i] = tap(cell, (vec2(float(i - (i / 3) * 3), float(i / 3)) + 0.5) / 3.0); m += s[i]; }
  m /= 9.0;
  vec3 best = s[4]; float bd = 1e9;
  for (int i = 0; i < 9; i++){ vec3 d = s[i] - m; float e = dot(d, d); if (e < bd){ bd = e; best = s[i]; } }
  return mix(best, m, 0.25);
}
vec3 quick(vec2 cell){ return 0.25 * (tap(cell, vec2(0.25)) + tap(cell, vec2(0.75, 0.25)) + tap(cell, vec2(0.25, 0.75)) + tap(cell, vec2(0.75))); }

int palCount(int p){
  if (p >= 1 && p <= 10) return PAL_CNT[p - 1];
  int n = 0;
  for (int i = 0; i < 8; i++){ if (uColor(i).a > 0.0) n++; else break; }
  return n;
}
vec3 palRgb(int p, int i){ return p >= 1 ? PAL_RGB[PAL_OFF[p - 1] + i] : uColor(i).rgb; }
vec3 palLab(int p, int i){ return p >= 1 ? PAL_LAB[PAL_OFF[p - 1] + i] : oklab(uColor(i).rgb); }

// Écart perçu : OKLab, plus une pénalité de teinte (une couleur franche ne glisse pas vers une teinte voisine terne).
float perr(vec3 l, vec3 q){
  vec3 d = (q - l) * vec3(0.85, 1.0, 1.0);
  float e = dot(d, d);
  float c1 = length(l.yz), c2 = length(q.yz);
  if (c1 > 0.03 && c2 > 0.03){ float h = 1.0 - dot(l.yz / c1, q.yz / c2); e += 0.6 * h * h * c1; }
  float lost = max(c1 - c2, 0.0); // une couleur saturée ne devient pas grise (ni un mélange grisâtre)
  return e + 1.4 * lost * lost;
}
// Meilleur mélange de deux couleurs de la palette (tramage ordonné à la Yliluoma) : pour chaque paire,
// la proportion t qui approche le mieux la couleur, pénalisée par le contraste du mélange (k) ;
// k très grand = couleur la plus proche seule (pas de tramage).
void bestPair(int p, int n, vec3 l, float k, float maxGap, out int i1, out int i2, out float t){
  float best = 1e9; i1 = 0; i2 = 0; t = 0.0;
  for (int i = 0; i < 16; i++){
    if (i >= n) break;
    vec3 a = palLab(p, i);
    float e0 = perr(l, a);
    if (e0 < best){ best = e0; i1 = i; i2 = i; t = 0.0; }
    for (int j = 0; j < 16; j++){
      if (j >= n) break;
      if (j <= i) continue;
      vec3 ab = palLab(p, j) - a;
      float ab2 = max(dot(ab, ab), 1e-6);
      if (ab2 > maxGap * maxGap) continue; // jamais de damier entre couleurs étrangères (noir / blanc pour un gris absent)
      float tt = clamp(floor(dot(l - a, ab) / ab2 * 8.0 + 0.5) / 8.0, 0.0, 1.0);
      if (tt <= 0.0 || tt >= 1.0) continue;
      float e = perr(l, a + ab * tt) + k * ab2 * tt * (1.0 - tt);
      if (e < best){ best = e; i1 = i; i2 = j; t = tt; }
    }
  }
}

void mainImage(out vec4 o, in vec2 frag){
  float lines = clamp(uParam0, 16.0, 480.0);
  gCell = vec2(max(1.0, floor(iResolution.y / lines + 0.5)));
  vec2 cell = floor(frag / gCell);
  int p = int(clamp(floor(uParam1 + 0.5), 0.0, 10.0));
  float dith = clamp(uParam2, 0.0, 1.0), edge = clamp(uParam3, 0.0, 1.0);

  vec3 c = oklab(repr(cell));
  vec3 nb[4];
  nb[0] = oklab(quick(cell + vec2(1.0, 0.0)));
  nb[1] = oklab(quick(cell - vec2(1.0, 0.0)));
  nb[2] = oklab(quick(cell + vec2(0.0, 1.0)));
  nb[3] = oklab(quick(cell - vec2(0.0, 1.0)));

  // Pixel orphelin : différent de ses 4 voisins qui, eux, s'accordent → il prend leur couleur.
  vec3 nm = 0.25 * (nb[0] + nb[1] + nb[2] + nb[3]);
  float spread = 0.0, own = 1e9;
  for (int i = 0; i < 4; i++){ spread = max(spread, length(nb[i] - nm)); own = min(own, length(nb[i] - c)); }
  if (spread < 0.035 && own > 0.03 && length(c - nm) < 0.16) c = nm;

  // Contour : côté sombre d'un bord franc, en teinte plus sombre et plus froide de la couleur.
  bool outline = false;
  if (edge > 0.0){
    float th = mix(0.32, 0.07, edge);
    for (int i = 0; i < 4; i++){
      vec3 d = nb[i] - c;
      if (length(d * vec3(1.6, 1.0, 1.0)) > th && d.x > mix(0.16, 0.06, edge)) outline = true;
    }
  }
  // Aplat, bord ou dégradé ? Un dégradé change des deux côtés du pixel (±3 pixels d'art), un bord d'un seul,
  // un aplat de nulle part : on ne trame que les dégradés (jamais un fond uni ni le halo d'un bord).
  vec2 h3 = vec2(3.0, 0.0);
  vec3 c0 = oklab(tap(cell, vec2(0.5)));
  float gx = min(length(oklab(tap(cell + h3.xy, vec2(0.5))) - c0), length(c0 - oklab(tap(cell - h3.xy, vec2(0.5)))));
  float gy = min(length(oklab(tap(cell + h3.yx, vec2(0.5))) - c0), length(c0 - oklab(tap(cell - h3.yx, vec2(0.5)))));
  float grad = smoothstep(0.003, 0.014, max(gx, gy));
  vec3 g = grade(c);
  if (outline){ g.x *= 0.5; g.yz = g.yz * 0.8 + vec2(0.01, -0.03); }

  vec3 rgb;
  int n = palCount(p);
  float b = bayer4(cell);
  if (n >= 2){
    // Palettes monochromes (gameboy, mac) : luminance seule, étalée sur la palette, tramage entre crans voisins.
    bool mono = p == 2 || p == 10;
    int i1 = 0, i2 = 0; float t = 0.0;
    if (mono){
      float lo = palLab(p, 0).x, hi = palLab(p, n - 1).x;
      float x = mix(lo, hi, smoothstep(0.08, 0.92, g.x));
      for (int i = 0; i < 15; i++){
        if (i >= n - 1) break;
        float a = palLab(p, i).x, c = palLab(p, i + 1).x;
        if (x >= a && x <= c){ i1 = i; i2 = i + 1; t = (x - a) / max(c - a, 1e-4); }
      }
      if (x > palLab(p, n - 1).x){ i1 = n - 1; i2 = n - 1; }
      float s = max(dith * grad, 1e-3);
      t = clamp((t - 0.5) / s + 0.5, 0.0, 1.0);
    } else {
      // Pas de tramage sur un contour ; plus le tramage est fort, moins le contraste du mélange coûte.
      float s = outline ? 0.0 : dith * grad;
      bestPair(p, n, g, s > 0.0 ? 0.08 * pow(40.0, 1.0 - s) : 1e6, mix(0.22, 0.46, s), i1, i2, t);
    }
    t = t < 0.13 ? 0.0 : (t > 0.87 ? 1.0 : t);
    rgb = palRgb(p, b < t ? i2 : i1);
  } else {
    // Sans palette : niveaux OKLab (luminance 7 crans, chroma 5) tramés.
    vec3 lv = vec3(6.0, 10.0, 10.0);
    vec3 q = g * lv + vec3(0.0, 5.0, 5.0);
    q = floor(q + mix(vec3(0.5), vec3(b), dith));
    rgb = fromOklab((q - vec3(0.0, 5.0, 5.0)) / lv);
  }
  o = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
