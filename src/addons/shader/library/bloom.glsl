// Bloom : halo lumineux autour des zones claires de l'image du canal 0 (néons, soleil, étincelles).
// Passe de clarté (seuil) puis flou par échantillonnage en spirale dorée, ajouté à l'image.
// uParam0 seuil (0..1), uParam1 intensité (0..3), uParam2 rayon (en millièmes du petit côté), uParam3 teinte du halo
// (0 = couleur d'origine, 1 = blanc chaud).
vec3 bright(vec2 uv, float th) {
  vec3 col = texture(iChannel0, uv).rgb;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  return col * smoothstep(th, th + 0.15, l);
}

void mainImage(out vec4 c, in vec2 p) {
  vec2 uv = p / iResolution.xy;
  vec3 base = texture(iChannel0, uv).rgb;
  float th = clamp(uParam0, 0.0, 1.0);
  float radius = max(1.0, uParam2) * 0.001 * min(iResolution.x, iResolution.y);
  vec2 px = 1.0 / iResolution.xy;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 32; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 32.0);
    float a = fi * 2.39996323;
    vec2 o = vec2(cos(a), sin(a)) * r * radius * px;
    float w = 1.0 - r * 0.7;
    acc += bright(uv + o, th) * w;
    wsum += w;
  }
  vec3 glow = acc / wsum;
  glow = mix(glow, vec3(dot(glow, vec3(0.333))) * vec3(1.0, 0.92, 0.8), clamp(uParam3, 0.0, 1.0));
  c = vec4(base + glow * uParam1, 1.0);
}
