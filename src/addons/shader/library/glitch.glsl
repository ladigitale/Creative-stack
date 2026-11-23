// Glitch : bandes décalées, canaux RVB séparés, blocs corrompus, lignes de balayage.
// Même algorithme que l'effet `glitch` de la pile post de procgen, pour une image du canal 0.
// uParam0 quantité (0 = image propre), uParam1 bandes, uParam2 décalage RVB (px), uParam3 vitesse (0 = figé).
float gh12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void mainImage(out vec4 c, in vec2 p){
  vec2 uv = p / iResolution.xy;
  float amount = clamp(uParam0, 0.0, 1.0);
  float bands = clamp(uParam1, 4.0, 80.0);
  float t = floor(iTime * uParam3 * 8.0);
  float by = floor(uv.y * bands);
  float on = step(1.0 - amount * 0.6, gh12(vec2(by, t)));
  float shift = (gh12(vec2(by * 1.7, t + 5.1)) - 0.5) * 0.2 * on * amount;
  float bb = floor(uv.y * bands * 0.25);
  float big = step(1.0 - amount * 0.25, gh12(vec2(bb, t + 2.0)));
  shift += (gh12(vec2(bb, t + 9.0)) - 0.5) * 0.12 * big;
  vec2 u = vec2(fract(uv.x + shift), uv.y);
  vec2 s = vec2(uParam2 / iResolution.x, 0.0) * (0.35 + on + big) * step(0.001, amount);
  vec3 col = vec3(texture(iChannel0, u + s).r, texture(iChannel0, u).g, texture(iChannel0, u - s).b);
  vec2 blk = floor(uv * vec2(bands * 0.5, bands));
  if (gh12(blk + t * 1.3) > 1.0 - amount * 0.07) {
    vec2 g = vec2(48.0, 32.0);
    col = texture(iChannel0, (floor(u * g) + 0.5) / g).brg;
  }
  c = vec4(col * (1.0 - 0.18 * on * step(0.5, fract(p.y * 0.5))), 1.0);
}
