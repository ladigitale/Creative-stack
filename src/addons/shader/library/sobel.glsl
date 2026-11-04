// Contours de Sobel sur l'image du canal 0.
// Modes : 0 = contours blancs sur noir (sortie utilisable comme carte de contours
// par hough-lines / hough-circles), 1 = contours par-dessus l'image, 2 = direction du gradient en couleur.
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float L(vec2 uv){ return lum(texture(iChannel0, uv).rgb); }
void mainImage(out vec4 o, in vec2 p){
  vec2 uv = p / iResolution.xy;
  vec2 t = max(uParam0, 1.0) / iChannelResolution[0].xy;
  float a = L(uv + t * vec2(-1.0, -1.0)), b = L(uv + t * vec2(0.0, -1.0)), c = L(uv + t * vec2(1.0, -1.0));
  float d = L(uv + t * vec2(-1.0, 0.0)),                                   f = L(uv + t * vec2(1.0, 0.0));
  float g = L(uv + t * vec2(-1.0, 1.0)),  h = L(uv + t * vec2(0.0, 1.0)),  i = L(uv + t * vec2(1.0, 1.0));
  float gx = (c + 2.0 * f + i) - (a + 2.0 * d + g);
  float gy = (g + 2.0 * h + i) - (a + 2.0 * b + c);
  float m = clamp(length(vec2(gx, gy)) * uParam1, 0.0, 1.0);
  int mode = int(uParam2 + 0.5);
  vec3 base = texture(iChannel0, uv).rgb;
  vec3 col = vec3(m);
  if (mode == 1) col = mix(base * 0.6, vec3(1.0, 0.9, 0.2), m);
  if (mode == 2) {
    float h6 = atan(gy, gx) / 6.2831853 + 0.5;
    vec3 hue = clamp(abs(mod(h6 * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    col = hue * m;
  }
  o = vec4(col, 1.0);
}
