// Feu : flammes qui montent depuis le bas de l'image (bruit fractal déformé vers le haut), fond noir.
// À poser en fusion « screen » (mix-blend-mode) au-dessus d'une scène, ou comme fond.
// uParam0 vitesse, uParam1 hauteur des flammes (0,2..1,2), uParam2 couleur (0 braise orange → 1 flamme bleue),
// uParam3 largeur du foyer (0,1..1).
float fh12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

float fnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fh12(i), fh12(i + vec2(1.0, 0.0)), u.x), mix(fh12(i + vec2(0.0, 1.0)), fh12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float ffbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * fnoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void mainImage(out vec4 c, in vec2 p) {
  vec2 uv = p / iResolution.xy;
  float aspect = iResolution.x / iResolution.y;
  float t = iTime * max(0.0, uParam0);
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y);
  float n = ffbm(vec2(q.x * 3.0, q.y * 2.0 - t * 1.6));
  float n2 = ffbm(vec2(q.x * 6.0 + n, q.y * 4.0 - t * 2.4));
  float width = clamp(uParam3, 0.1, 1.0) * aspect * 0.5;
  float base = 1.0 - smoothstep(width * 0.3, width, abs(q.x + (n - 0.5) * 0.25));
  float h = clamp(uParam1, 0.2, 1.2);
  float flame = base * (1.0 - uv.y / h) + (n2 - 0.5) * 0.9 * (1.0 - uv.y / (h * 1.3));
  flame = clamp(flame * 1.6, 0.0, 1.0);
  vec3 warm = vec3(1.6, 0.55, 0.12) * flame + vec3(0.6, 0.55, 0.4) * pow(flame, 4.0);
  vec3 cold = vec3(0.25, 0.55, 1.6) * flame + vec3(0.5, 0.6, 0.7) * pow(flame, 4.0);
  vec3 col = mix(warm, cold, clamp(uParam2, 0.0, 1.0)) * flame;
  c = vec4(col, 1.0);
}
