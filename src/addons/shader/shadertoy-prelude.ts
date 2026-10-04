/**
 * ShaderToy-compatible GLSL ES 3.0 prelude (fragment body, sans `#version`).
 * - `sonic-shader` préfixe `#version 300 es` via `buildFragmentSource`.
 * - `sonic-3d` post passe le corps à Three `RawShaderMaterial` (GLSL3).
 */

export const GLSL_VERSION_300 = `#version 300 es
`;

/** Corps des uniforms / out (sans version). */
export const SHADERTOY_FRAGMENT_BODY = `precision highp float;
precision highp int;
precision mediump sampler2D;

uniform vec3      iResolution;
uniform float     iTime;
uniform float     iTimeDelta;
uniform float     iFrameRate;
uniform int       iFrame;
uniform float     iChannelTime[4];
uniform vec3      iChannelResolution[4];
uniform vec4      iMouse;
uniform vec4      iDate;
uniform float     iSampleRate;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform float     uParam0;
uniform float     uParam1;
uniform float     uParam2;
uniform float     uParam3;
/** Near / far caméra (0 dans sonic-shader standalone). */
uniform float     uNear;
uniform float     uFar;

out vec4 sonicFragColor;

/** Profondeur linéaire monde depuis une DepthTexture (0–1). */
float sonicLinearDepth(float d) {
  float z = d * 2.0 - 1.0;
  float n = max(uNear, 1e-4);
  float f = max(uFar, n + 1e-4);
  return (2.0 * n * f) / (f + n - z * (f - n));
}

`;

/** @deprecated Préférer SHADERTOY_FRAGMENT_BODY + buildFragmentSource. */
export const SHADERTOY_FRAGMENT_PRELUDE =
  GLSL_VERSION_300 + SHADERTOY_FRAGMENT_BODY;

export const SHADERTOY_FRAGMENT_EPILOGUE = `
void main() {
  mainImage(sonicFragColor, gl_FragCoord.xy);
}
`;

export const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/** Vertex Three RawShaderMaterial GLSL3 (fullscreen triangle via PlaneGeometry 2×2). */
export const THREE_FULLSCREEN_VERTEX = `precision highp float;
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function buildFragmentBody(common: string, userCode: string): string {
  return (
    SHADERTOY_FRAGMENT_BODY +
    (common ? common + "\n" : "") +
    userCode +
    "\n" +
    SHADERTOY_FRAGMENT_EPILOGUE
  );
}

/** Source fragment WebGL2 native (`sonic-shader`). */
export function buildFragmentSource(common: string, userCode: string): string {
  return GLSL_VERSION_300 + buildFragmentBody(common, userCode);
}

/** Source fragment pour Three RawShaderMaterial (GLSL3, sans #version). */
export function buildThreeFragmentSource(
  common: string,
  userCode: string,
): string {
  return buildFragmentBody(common, userCode);
}
