// Transition entre deux images : iChannel0 (départ) → iChannel1 (arrivée), pilotée par l'avancement.
// uParam0 avancement 0..1 ; uParam1 type : 0 fondu, 1 volet, 2 cercle, 3 dissolution, 4 pixels, 5 glissement,
// 6 zoom, 7 losanges ; uParam2 douceur du bord (0..0,5).
float th12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

float tnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(th12(i), th12(i + vec2(1.0, 0.0)), u.x), mix(th12(i + vec2(0.0, 1.0)), th12(i + vec2(1.0, 1.0)), u.x), u.y);
}

void mainImage(out vec4 c, in vec2 p) {
  vec2 uv = p / iResolution.xy;
  float t = clamp(uParam0, 0.0, 1.0);
  int kind = int(floor(uParam1 + 0.5));
  float soft = clamp(uParam2, 0.001, 0.5);
  float aspect = iResolution.x / iResolution.y;
  vec2 ua = uv, ub = uv;
  float m = t;
  if (kind == 1) {
    // volet de gauche à droite, bord adouci
    m = smoothstep(uv.x - soft, uv.x, t * (1.0 + soft));
  } else if (kind == 2) {
    float d = length((uv - 0.5) * vec2(aspect, 1.0)) / length(vec2(aspect, 1.0) * 0.5);
    m = smoothstep(d - soft, d, t * (1.0 + soft));
  } else if (kind == 3) {
    float n = tnoise(uv * 12.0) * 0.65 + tnoise(uv * 40.0) * 0.35;
    m = smoothstep(n - soft, n, t * (1.0 + soft));
  } else if (kind == 4) {
    // pixels qui grossissent jusqu'au milieu puis s'affinent sur l'arrivée
    float k = 1.0 - abs(t * 2.0 - 1.0);
    float cells = mix(iResolution.y, 12.0, k);
    vec2 g = vec2(cells * aspect, cells);
    ua = ub = (floor(uv * g) + 0.5) / g;
    m = step(0.5, t);
  } else if (kind == 5) {
    float e = t * t * (3.0 - 2.0 * t);
    ua = uv + vec2(e, 0.0);
    ub = uv - vec2(1.0 - e, 0.0);
    m = step(1.0 - e, uv.x);
  } else if (kind == 6) {
    float e = t * t * (3.0 - 2.0 * t);
    ua = (uv - 0.5) / (1.0 + e * 1.5) + 0.5;
    ub = (uv - 0.5) * (1.0 + (1.0 - e) * 0.5) + 0.5;
    m = e;
  } else if (kind == 7) {
    vec2 q = fract(uv * vec2(aspect, 1.0) * 8.0) - 0.5;
    float d = (abs(q.x) + abs(q.y)) * 2.0;
    float sweep = t * 2.0 - uv.x * 0.8;
    m = smoothstep(d - soft, d, sweep);
  }
  vec4 a = texture(iChannel0, clamp(ua, 0.0, 1.0));
  vec4 b = texture(iChannel1, clamp(ub, 0.0, 1.0));
  c = vec4(mix(a.rgb, b.rgb, clamp(m, 0.0, 1.0)), 1.0);
}
