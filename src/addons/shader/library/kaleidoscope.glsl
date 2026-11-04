// Kaléidoscope sur l'image du canal 0 (caméra, vidéo, image).
void mainImage(out vec4 c, in vec2 p){
  vec2 uv = p / iResolution.xy;
  vec2 q = uv - 0.5; q.x *= iResolution.x / iResolution.y;
  float n = max(2.0, floor(uParam0 + 0.5));
  float a = atan(q.y, q.x) + iTime * uParam1; float r = length(q);
  a = mod(a, 6.2831853 / n); a = abs(a - 3.1415926 / n);
  uv = 0.5 + r * vec2(cos(a) * iResolution.y / iResolution.x, sin(a));
  c = vec4(texture(iChannel0, uv).rgb, 1.0);
}
