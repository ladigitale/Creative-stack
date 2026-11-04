// Plasma : ondes colorées, le clic déplace le centre.
vec3 pal(float t){ return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
void mainImage(out vec4 o, in vec2 f){
  vec2 p = (2.0 * f - iResolution.xy) / min(iResolution.x, iResolution.y);
  float t = iTime * uParam0;
  float s = uParam1;
  vec2 m = iMouse.z > 0.0 ? (2.0 * iMouse.xy - iResolution.xy) / min(iResolution.x, iResolution.y) : vec2(0.0);
  float v = sin(p.x * s + t) + sin(p.y * s * 1.3 - t * 1.1)
          + sin((p.x + p.y) * s * 0.7 + t * 0.7) + sin(length(p - m) * s * 1.6 - t * 1.4);
  vec3 col = pal(uParam2 + v * 0.15);
  col *= 0.75 + 0.25 * sin(v * 3.14159);
  o = vec4(col, 1.0);
}
