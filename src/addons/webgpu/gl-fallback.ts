import {
  parseChannelSource,
  ShaderToyRuntime,
  type FrameUniforms,
} from "../shader/gl-runtime";
import type { PassChannels, ShaderSources } from "../shader/types";
import type { WebGpuFrameState } from "./gpu-runtime";

/** GLSL image pass — même dialecte ShaderToy que sonic-shader. */
const FALLBACK_IMAGE = `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec4 c = texture(iChannel0, uv);
  float has = step(0.001, c.a + c.r + c.g + c.b);
  // Souris en UV (origine bas-gauche, comme fragCoord)
  vec2 muv = iMouse.xy / max(iResolution.xy, vec2(1.0));
  float m = length(uv - muv);
  // Halo souris toujours visible + mix global via uParam0
  float glow = exp(-m * 8.0) * (0.35 + 0.65 * uParam0);
  vec4 tint = vec4(0.15, 0.45, 0.95, 1.0);
  vec4 mixed = mix(c, tint, clamp(uParam0 * 0.35 + glow, 0.0, 1.0));
  float g = 0.15 + 0.25 * uv.y;
  vec4 grad = vec4(g, g * 0.85 + 0.08 * uParam0, 0.35 + 0.4 * uv.x, 1.0);
  fragColor = mix(grad, mixed, has);
}
`;

const EMPTY_SOURCES: ShaderSources = {
  common: "",
  image: FALLBACK_IMAGE,
  bufferA: "",
  bufferB: "",
  bufferC: "",
  bufferD: "",
};

/**
 * Fallback WebGL2 = wrapper de `ShaderToyRuntime` (même stack que sonic-shader).
 */
export class WebGl2FallbackRuntime {
  readonly backend = "webgl2" as const;
  readonly canvas: HTMLCanvasElement;
  private toy: ShaderToyRuntime;
  private channelUrls: [string, string, string, string] = ["", "", "", ""];
  private lastTime = 0;
  private disposed = false;
  private channelQueue: Promise<void> = Promise.resolve();
  private elementResolver: ((key: string) => Element | null) | null = null;

  private constructor(canvas: HTMLCanvasElement, toy: ShaderToyRuntime) {
    this.canvas = canvas;
    this.toy = toy;
    this.applySources();
  }

  static create(canvas: HTMLCanvasElement): WebGl2FallbackRuntime {
    const toy = new ShaderToyRuntime(canvas);
    return new WebGl2FallbackRuntime(canvas, toy);
  }

  setElementResolver(fn: ((key: string) => Element | null) | null) {
    this.elementResolver = fn;
    this.toy.setElementResolver(fn);
  }

  /** WGSL ignoré — effet GLSL fixe (canaux / params OK). */
  async setShader(_userBody: string): Promise<void> {
    this.assertAlive();
  }

  async setChannel(index: 0 | 1 | 2 | 3, url: string): Promise<void> {
    // sérialisé : évite applySources / ensureTextures en parallèle (rebuild Promise.all)
    this.channelQueue = this.channelQueue.then(() =>
      this.setChannelNow(index, url),
    );
    return this.channelQueue;
  }

  private async setChannelNow(
    index: 0 | 1 | 2 | 3,
    url: string,
  ): Promise<void> {
    this.assertAlive();
    const trimmed = url.trim();
    if (this.channelUrls[index] === trimmed) {
      if (trimmed.startsWith("#")) {
        this.toy.ensureElementTexture(trimmed);
        return;
      }
      // Même URL : s’assurer que la texture est bien chargée
      if (trimmed && !this.toy.getTextureSize(trimmed)) {
        await this.toy.ensureTextures([trimmed]);
      }
      return;
    }
    this.channelUrls[index] = trimmed;
    this.applySources();
    await this.ensureChannelAssets();
  }

  /** Applique les 4 canaux d’un coup (préféré au boot). */
  async setChannels(urls: [string, string, string, string]): Promise<void> {
    this.channelQueue = this.channelQueue.then(async () => {
      this.assertAlive();
      this.channelUrls = [
        urls[0].trim(),
        urls[1].trim(),
        urls[2].trim(),
        urls[3].trim(),
      ];
      this.applySources();
      await this.ensureChannelAssets();
    });
    return this.channelQueue;
  }

  getTextureSize(url: string): { width: number; height: number } | null {
    return this.toy.getTextureSize(url.trim());
  }

  resize(width: number, height: number) {
    this.assertAlive();
    this.toy.resize(width, height);
  }

  updateLiveChannels(resolveEl: (key: string) => Element | null) {
    this.assertAlive();
    this.toy.updateElementTextures(resolveEl);
  }

  draw(state: WebGpuFrameState) {
    this.assertAlive();
    if (this.toy.isLost) return;
    if (this.elementResolver) {
      this.toy.updateElementTextures(this.elementResolver);
    }
    const timeDelta =
      this.lastTime > 0 ? Math.max(0, state.time - this.lastTime) : 0;
    this.lastTime = state.time;
    const frame: FrameUniforms = {
      time: state.time,
      timeDelta,
      frame: Math.floor(state.frame),
      mouse: state.mouse,
      params: state.params,
    };
    this.toy.render(frame);
  }

  dispose(loseContext = true) {
    if (this.disposed) return;
    this.disposed = true;
    this.toy.dispose(loseContext);
  }

  private async ensureChannelAssets() {
    const urls = this.channelUrls.filter((u) => u && !u.startsWith("#"));
    if (urls.length) await this.toy.ensureTextures(urls);
    for (const key of this.channelUrls) {
      if (key.startsWith("#")) this.toy.ensureElementTexture(key);
    }
  }

  private applySources() {
    const channels = new Map([
      [
        "image" as const,
        [
          parseChannelSource(this.channelUrls[0], ""),
          parseChannelSource(this.channelUrls[1], ""),
          parseChannelSource(this.channelUrls[2], ""),
          parseChannelSource(this.channelUrls[3], ""),
        ] as PassChannels,
      ],
    ]);
    this.toy.setSources(EMPTY_SOURCES, channels);
  }

  private assertAlive() {
    if (this.disposed) throw new Error("WebGL2 fallback disposed");
  }
}
