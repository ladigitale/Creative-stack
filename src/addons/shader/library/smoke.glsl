// Fumée de scène : brume qui monte et dérive, grise sur noir (à poser en fusion « screen »).
// Bruit de valeur fractal, déformé par lui-même ; plus dense en bas, plus claire près du sol.
float hsh(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), f.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return s;
}
void mainImage(out vec4 o, in vec2 f){
  vec2 uv = f / iResolution.xy;
  float asp = iResolution.x / iResolution.y;
  float t = iTime * uParam1;
  vec2 p = vec2(uv.x * asp, uv.y) * uParam2;
  // Deux passes de déformation : la fumée s'enroule au lieu de simplement glisser.
  vec2 q = vec2(fbm(p + vec2(0.0, -t * 0.6)), fbm(p + vec2(5.2, 1.3 - t * 0.5)));
  vec2 r = vec2(fbm(p + 2.0 * q + vec2(1.7, 9.2) + t * 0.15), fbm(p + 2.0 * q + vec2(8.3, 2.8) - t * 0.12));
  float n = fbm(p + 2.2 * r + vec2(0.0, -t));
  float d = smoothstep(0.30, 0.85, n);
  float low = mix(1.0, 0.45, uv.y);                 // plus dense près du sol
  float edge = smoothstep(0.0, 0.18, uv.x) * (1.0 - smoothstep(0.82, 1.0, uv.x));
  d *= uParam0 * low * (0.55 + 0.45 * edge);
  vec3 cool = vec3(0.80, 0.84, 0.92), warm = vec3(1.0, 0.86, 0.72);
  vec3 col = mix(cool, warm, uParam3) * (0.65 + 0.35 * n);
  o = vec4(col * d, 1.0);
}
