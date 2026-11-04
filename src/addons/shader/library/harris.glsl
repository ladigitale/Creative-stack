// Détecteur de coins de Harris (une passe, fenêtre gaussienne 5x5, k = 0,05).
// Pas de suppression des non-maxima (il faudrait une seconde passe) : les coins apparaissent comme des taches.
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float L(vec2 uv){ return lum(texture(iChannel0, uv).rgb); }
void mainImage(out vec4 o, in vec2 p){
  vec2 uv = p / iResolution.xy;
  vec2 t = max(uParam0, 1.0) / iChannelResolution[0].xy;
  float sxx = 0.0, syy = 0.0, sxy = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 q = uv + t * vec2(float(i), float(j));
      float ix = L(q + vec2(t.x, 0.0)) - L(q - vec2(t.x, 0.0));
      float iy = L(q + vec2(0.0, t.y)) - L(q - vec2(0.0, t.y));
      float w = exp(-float(i * i + j * j) / 4.0);
      sxx += w * ix * ix; syy += w * iy * iy; sxy += w * ix * iy;
    }
  }
  float det = sxx * syy - sxy * sxy;
  float tr = sxx + syy;
  float r = (det - 0.05 * tr * tr) * uParam1;
  float corner = smoothstep(uParam2, uParam2 + 0.25, r);
  vec3 base = texture(iChannel0, uv).rgb;
  o = vec4(mix(base * 0.55, vec3(1.0, 0.25, 0.1), corner), 1.0);
}
