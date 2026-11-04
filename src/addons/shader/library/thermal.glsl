// Fausse caméra thermique : luminance -> palette chaud/froid.
void mainImage(out vec4 c, in vec2 p){
  vec2 uv = p / iResolution.xy;
  vec3 col = texture(iChannel0, uv).rgb;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 t = clamp(vec3(1.6 * l - 0.3, sin(3.14159 * l) * 1.1, 1.0 - 1.8 * l), 0.0, 1.0);
  c = vec4(mix(col, t, uParam0), 1.0);
}
