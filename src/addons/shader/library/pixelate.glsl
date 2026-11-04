// Pixels : mosaïque avec joints, résolution réglable.
void mainImage(out vec4 c, in vec2 p){
  vec2 uv = p / iResolution.xy;
  float n = max(8.0, uParam0);
  vec2 cells = vec2(n, n * iResolution.y / iResolution.x);
  vec2 q = (floor(uv * cells) + 0.5) / cells;
  vec3 col = texture(iChannel0, q).rgb;
  vec2 f = fract(uv * cells) - 0.5;
  col *= smoothstep(0.5, 0.42, max(abs(f.x), abs(f.y)));
  c = vec4(col, 1.0);
}
