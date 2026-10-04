/**
 * Prelude WGSL pour `sonic-webgpu`.
 * L’utilisateur fournit `fn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f`.
 */

export const DEFAULT_MAIN_IMAGE = `
fn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f {
  _ = fragCoord;
  let c = iChannel0(uv);
  if (c.a > 0.001 || c.r + c.g + c.b > 0.001) {
    return c;
  }
  let g = 0.15 + 0.25 * uv.y;
  return vec4f(g, g * 0.85 + 0.08 * u.params.x, 0.35 + 0.4 * uv.x, 1.0);
}
`.trim();

const PRELUDE = `
struct SonicUniforms {
  resolution: vec2f,
  time: f32,
  frame: f32,
  mouse: vec4f,
  params: vec4f,
}

@group(0) @binding(0) var<uniform> u: SonicUniforms;
@group(0) @binding(1) var channel0Tex: texture_2d<f32>;
@group(0) @binding(2) var channel1Tex: texture_2d<f32>;
@group(0) @binding(3) var channel2Tex: texture_2d<f32>;
@group(0) @binding(4) var channel3Tex: texture_2d<f32>;
@group(0) @binding(5) var texSampler: sampler;

fn iChannel0(uv: vec2f) -> vec4f {
  return textureSample(channel0Tex, texSampler, uv);
}
fn iChannel1(uv: vec2f) -> vec4f {
  return textureSample(channel1Tex, texSampler, uv);
}
fn iChannel2(uv: vec2f) -> vec4f {
  return textureSample(channel2Tex, texSampler, uv);
}
fn iChannel3(uv: vec2f) -> vec4f {
  return textureSample(channel3Tex, texSampler, uv);
}

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var out: VsOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = pos[vi] * 0.5 + vec2f(0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let fragCoord = vec2f(in.uv.x * u.resolution.x, in.uv.y * u.resolution.y);
  return mainImage(in.uv, fragCoord);
}
`.trim();

/** Assemble prelude + corps utilisateur (ou défaut). */
export function buildWgslSource(userBody: string): string {
  const body = userBody.trim() || DEFAULT_MAIN_IMAGE;
  if (!/\bfn\s+mainImage\s*\(/.test(body)) {
    throw new Error(
      "WGSL invalide : définir `fn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f`.",
    );
  }
  return `${PRELUDE}\n\n${body}\n`;
}
