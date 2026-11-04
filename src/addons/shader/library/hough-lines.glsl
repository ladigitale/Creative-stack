// Transformée de Hough des droites, en une passe (force brute le long de chaque droite).
// Entrée (canal 0) : une CARTE DE CONTOURS, par exemple un sonic-shader sobel en mode 0 (channel0="#contours").
// Sortie : l'espace de Hough. x = angle theta (0..pi), y = distance rho (-R..R) depuis le centre de l'image.
// Un point lumineux = une droite de l'image (theta, rho). Pas de détection de pics (il faudrait une seconde passe).
// Coût : 96 lectures par pixel de sortie : afficher en petit (par ex. 360 x 240).
void mainImage(out vec4 o, in vec2 p){
  vec2 uv = p / iResolution.xy;
  float asp = iChannelResolution[0].x / iChannelResolution[0].y;
  vec2 ext = vec2(asp, 1.0);
  float rmax = 0.5 * length(ext);
  float th = uv.x * 3.14159265;
  float rho = (uv.y * 2.0 - 1.0) * rmax;
  vec2 n = vec2(cos(th), sin(th));
  vec2 d = vec2(-n.y, n.x);
  float acc = 0.0;
  float cnt = 0.0;
  for (int k = 0; k < 96; k++) {
    float s = ((float(k) + 0.5) / 96.0 * 2.0 - 1.0) * rmax;
    vec2 q = (rho * n + s * d) / ext + 0.5;
    if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) {
      acc += dot(texture(iChannel0, q).rgb, vec3(0.3333));
      cnt += 1.0;
    }
  }
  float v = cnt > 8.0 ? acc / cnt : 0.0;
  v = clamp((v * uParam0 - uParam1) / max(1.0 - uParam1, 0.001), 0.0, 1.0);
  vec3 hot = vec3(clamp(v * 3.0, 0.0, 1.0), clamp(v * 3.0 - 1.0, 0.0, 1.0), clamp(v * 3.0 - 2.0, 0.0, 1.0));
  o = vec4(hot, 1.0);
}
