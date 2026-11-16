// Niveaux d'une image (canal 0), en gris : luminosité, contraste, gamma, et égalisation de l'éclairage.
// Sert à préparer une photo avant un tramage ou une gravure (sonic-gcode source="#id" de ce shader).
// uParam0 luminosité (-1..1), uParam1 contraste (-1..1), uParam2 gamma (0.2..3 ; 1 neutre, < 1 éclaircit
// les tons moyens), uParam3 éclairage local (0..1) : divise par le fond (moyenne large) pour retirer ombres
// et dégradés lents ; un seuil ou un tramage garde alors le détail dans les zones sombres et claires.
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void mainImage(out vec4 o, in vec2 f) {
  vec2 uv = f / iResolution.xy;
  float v = lum(texture(iChannel0, uv).rgb);
  float k = clamp(uParam3, 0.0, 1.0);
  if (k > 0.0) {
    // Fond : moyenne de 3 anneaux de 12 points, jusqu'à 12 % du petit côté.
    float side = min(iChannelResolution[0].x, iChannelResolution[0].y);
    vec2 px = vec2(side) / iChannelResolution[0].xy;
    float bg = v;
    float n = 1.0;
    for (int r = 1; r <= 3; r++) {
      float rad = 0.04 * float(r);
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 0.5235988 + float(r) * 0.3;
        bg += lum(textureLod(iChannel0, clamp(uv + vec2(cos(a), sin(a)) * rad * px, 0.0, 1.0), 0.0).rgb);
        n += 1.0;
      }
    }
    bg /= n;
    float aplani = clamp(v / max(bg, 0.03) * 0.78, 0.0, 1.0);
    v = mix(v, aplani, k);
  }
  float c = clamp(uParam1, -1.0, 1.0);
  float factor = c >= 0.0 ? 1.0 + c * 3.0 : 1.0 + c;
  v = clamp((v - 0.5) * factor + 0.5 + clamp(uParam0, -1.0, 1.0) * 0.5, 0.0, 1.0);
  float g = uParam2 > 0.0 ? clamp(uParam2, 0.2, 3.0) : 1.0;
  v = pow(v, g);
  o = vec4(vec3(v), 1.0);
}
