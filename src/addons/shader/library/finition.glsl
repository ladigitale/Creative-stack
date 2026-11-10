// Finition d'une image (post-traitement) : effets indépendants de la résolution — le même réglage donne le
// même aspect à l'écran et dans un export ×4 (render-size). iChannel0 : l'image à finir (toile, export PNG).
// uParam0 effet : 0 aucun, 1 papier (grain et fibres), 2 trame ordonnée, 3 sérigraphie (repérage décalé,
// encres posterisées), 4 objectif (aberration chromatique et vignette). uParam1 intensité (0..1).
// uParam2 échelle du grain (millièmes du petit côté, 0.5..8).

float h12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), u.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

void mainImage(out vec4 o, in vec2 f) {
  vec2 uv = f / iResolution.xy;
  float side = min(iResolution.x, iResolution.y);
  float k = clamp(uParam1, 0.0, 1.0);
  float scale = clamp(uParam2, 0.5, 8.0);
  // Coordonnées du grain : en millièmes du petit côté, donc identiques à toute résolution.
  vec2 g = f / side * 1000.0 / scale;
  int fx = int(uParam0 + 0.5);
  vec3 c = texture(iChannel0, uv).rgb;

  if (fx == 1) {
    float grain = vn(g * 0.9) * 0.5 + vn(g * 3.1) * 0.3 + h12(floor(g * 2.0)) * 0.2;
    float fibre = vn(vec2(g.x * 0.12, g.y * 2.4));
    vec3 paper = c * (0.9 + 0.2 * grain) * (0.97 + 0.06 * fibre) * vec3(1.0, 0.985, 0.95);
    c = mix(c, paper, k);
  } else if (fx == 2) {
    vec2 cell = floor(g / 2.5);
    float levels = 4.0;
    float thr = bayer4(cell) - 0.5;
    vec3 q = floor((c + thr / (levels - 1.0)) * (levels - 1.0) + 0.5) / (levels - 1.0);
    c = mix(c, clamp(q, 0.0, 1.0), k);
  } else if (fx == 3) {
    vec2 px = vec2(side) / iResolution.xy;
    float d = 0.004 * k;
    vec3 s;
    s.r = texture(iChannel0, uv + vec2(d, 0.6 * d) * px).r;
    s.g = texture(iChannel0, uv + vec2(-0.7 * d, 0.3 * d) * px).g;
    s.b = texture(iChannel0, uv + vec2(0.2 * d, -d) * px).b;
    vec3 ink = floor(s * 5.0 + 0.5) / 5.0;
    float grain = vn(g * 1.7);
    ink *= 0.94 + 0.12 * grain;
    c = mix(c, ink, k);
  } else if (fx == 4) {
    vec2 dir = uv - 0.5;
    float a = 0.012 * k;
    c.r = texture(iChannel0, uv + dir * a).r;
    c.b = texture(iChannel0, uv - dir * a).b;
    float vig = 1.0 - smoothstep(0.35, 0.95, length(dir) * 1.25);
    c *= mix(1.0, 0.55 + 0.45 * vig, k);
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
