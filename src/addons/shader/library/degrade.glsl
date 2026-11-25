// Dégradé vivant (« mesh gradient ») aux couleurs du thème : quatre taches de couleur qui dérivent lentement et
// se fondent, avec un grain léger. Couleurs : attribut `colors` (uColor0..3, ex. "--sc-base-50 --sc-accent
// --sc-deco-1 --sc-deco-2") ; sans attribut, une palette douce par défaut.
// uParam0 vitesse (0 = figé), uParam1 grain (0..0,2), uParam2 étalement des taches (0,2..1,5).
float dh12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec3 pal(int i) {
  vec4 k = i == 0 ? uColor0 : i == 1 ? uColor1 : i == 2 ? uColor2 : uColor3;
  if (k.a > 0.0) return k.rgb;
  return i == 0 ? vec3(0.98, 0.95, 0.9) : i == 1 ? vec3(0.98, 0.55, 0.45) : i == 2 ? vec3(0.45, 0.6, 0.98) : vec3(0.98, 0.85, 0.35);
}

void mainImage(out vec4 c, in vec2 p) {
  vec2 uv = p / iResolution.xy;
  float aspect = iResolution.x / iResolution.y;
  vec2 q = vec2(uv.x * aspect, uv.y);
  float t = iTime * uParam0 * 0.15;
  float spread = clamp(uParam2, 0.2, 1.5);
  vec3 col = pal(0);
  float total = 1.0;
  for (int i = 1; i < 4; i++) {
    float fi = float(i);
    vec2 center = vec2(aspect * (0.5 + 0.42 * sin(t * (0.7 + 0.23 * fi) + fi * 2.1)), 0.5 + 0.42 * cos(t * (0.5 + 0.31 * fi) + fi * 1.3));
    float d = length(q - center);
    float w = exp(-d * d / (0.18 * spread * spread));
    col += pal(i) * w * 2.0;
    total += w * 2.0;
  }
  col /= total;
  col += (dh12(p + fract(iTime) * 100.0) - 0.5) * clamp(uParam1, 0.0, 0.2);
  c = vec4(col, 1.0);
}
