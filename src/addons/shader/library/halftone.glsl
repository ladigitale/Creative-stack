// Similigravure : points dont la taille suit la luminance, grille inclinée.
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void mainImage(out vec4 o, in vec2 p){
  float s = max(3.0, uParam0);
  float a = uParam1;
  mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 q = (R * p) / s;
  vec2 g = floor(q) + 0.5;
  vec2 f = fract(q) - 0.5;
  vec2 centre = (g * s) * R;          // R est orthonormale : v * R = transpose(R) * v
  vec3 src = texture(iChannel0, clamp(centre / iResolution.xy, 0.0, 1.0)).rgb;
  float r = sqrt(1.0 - lum(src)) * 0.7071;
  float m = 1.0 - smoothstep(r - 0.1, r, length(f));
  vec3 ink = mix(vec3(0.0), src, uParam2);
  o = vec4(mix(vec3(1.0), ink, m), 1.0);
}
