// Tramage ordonné (matrice de Bayer 8x8) : réduit l'image à quelques niveaux.
float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a){ return bayer4(0.5 * a) * 0.25 + bayer2(a); }
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void mainImage(out vec4 o, in vec2 p){
  float size = max(1.0, floor(uParam0 + 0.5));
  vec2 cell = floor(p / size);
  vec2 uv = (cell + 0.5) * size / iResolution.xy;
  vec3 src = texture(iChannel0, uv).rgb;
  float levels = max(2.0, floor(uParam1 + 0.5));
  float thr = bayer8(cell) - 0.5;
  vec3 v = mix(vec3(lum(src)), src, uParam2);
  vec3 q = floor((v + thr / (levels - 1.0)) * (levels - 1.0) + 0.5) / (levels - 1.0);
  o = vec4(clamp(q, 0.0, 1.0), 1.0);
}
