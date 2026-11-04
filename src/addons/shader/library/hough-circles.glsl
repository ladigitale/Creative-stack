// Transformée de Hough des cercles de rayon fixe, en une passe.
// Entrée (canal 0) : une CARTE DE CONTOURS (sonic-shader sobel en mode 0, channel0="#contours").
// Chaque pixel de sortie est un centre candidat : son score est la moyenne des contours sur le cercle
// de rayon uParam0 (en hauteurs d'image) autour de lui. Pic lumineux = centre d'un cercle de ce rayon.
// Coût : 64 lectures par pixel.
void mainImage(out vec4 o, in vec2 p){
  vec2 uv = p / iResolution.xy;
  float asp = iChannelResolution[0].x / iChannelResolution[0].y;
  vec2 ext = vec2(asp, 1.0);
  vec2 c = (uv - 0.5) * ext;
  float r = max(uParam0, 0.01);
  float acc = 0.0;
  for (int k = 0; k < 64; k++) {
    float a = (float(k) + 0.5) / 64.0 * 6.2831853;
    vec2 q = (c + r * vec2(cos(a), sin(a))) / ext + 0.5;
    if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) acc += dot(texture(iChannel0, q).rgb, vec3(0.3333));
  }
  float v = clamp((acc / 64.0) * uParam1 - uParam2, 0.0, 1.0);
  vec3 edges = vec3(dot(texture(iChannel0, uv).rgb, vec3(0.3333)));
  vec3 hot = vec3(clamp(v * 3.0, 0.0, 1.0), clamp(v * 3.0 - 1.0, 0.0, 1.0), clamp(v * 3.0 - 2.0, 0.0, 1.0));
  o = vec4(max(hot, edges * 0.35 * step(0.5, uParam3)), 1.0);
}
