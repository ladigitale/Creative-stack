/**
 * Post-traitement ShaderToy dans le contexte Three de sonic-3d
 * (RenderTarget scène + DepthTexture → passes A–D → image).
 */
import * as THREE from "three";
import {
  isFrameSource,
} from "../../shared/mediaRef";
import {
  buildThreeFragmentSource,
  THREE_FULLSCREEN_VERTEX,
} from "../shader/shadertoy-prelude";
import {
  clampPostScale,
  type PostChannelSource,
  type PostChannels,
  type PostPassId,
  type PostSources,
} from "./post-channels";

export type PostFxUniforms = {
  time: number;
  timeDelta: number;
  frame: number;
  mouse: [number, number, number, number];
  params: [number, number, number, number];
  near: number;
  far: number;
};

export type PostFxConfig = {
  sources: PostSources;
  channels: Map<PostPassId, PostChannels>;
  scale: number;
};

export class PostFxCompileError extends Error {
  pass: string;
  infoLog: string;
  constructor(message: string, pass: string, infoLog = "") {
    super(message);
    this.name = "PostFxCompileError";
    this.pass = pass;
    this.infoLog = infoLog;
  }
}

type PingPong = {
  targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  index: number;
};

type PassMat = {
  material: THREE.RawShaderMaterial;
  uniforms: {
    iResolution: { value: THREE.Vector3 };
    iTime: { value: number };
    iTimeDelta: { value: number };
    iFrameRate: { value: number };
    iFrame: { value: number };
    iChannelTime: { value: Float32Array };
    iChannelResolution: { value: Float32Array };
    iMouse: { value: THREE.Vector4 };
    iDate: { value: THREE.Vector4 };
    iSampleRate: { value: number };
    iChannel0: { value: THREE.Texture | null };
    iChannel1: { value: THREE.Texture | null };
    iChannel2: { value: THREE.Texture | null };
    iChannel3: { value: THREE.Texture | null };
    uParam0: { value: number };
    uParam1: { value: number };
    uParam2: { value: number };
    uParam3: { value: number };
    uNear: { value: number };
    uFar: { value: number };
  };
};

const PASS_ORDER: PostPassId[] = [
  "bufferA",
  "bufferB",
  "bufferC",
  "bufferD",
  "image",
];

const BLACK = (() => {
  const d = new Uint8Array([0, 0, 0, 255]);
  const t = new THREE.DataTexture(d, 1, 1);
  t.needsUpdate = true;
  t.colorSpace = THREE.NoColorSpace;
  return t;
})();

function makeRT(
  w: number,
  h: number,
  withDepth: boolean,
): THREE.WebGLRenderTarget {
  if (withDepth) {
    const depth = new THREE.DepthTexture(w, h);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    // LinearFilter sur DepthTexture → sampling invalide / noir sur plusieurs GPU.
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthTexture: depth,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.generateMipmaps = false;
    return rt;
  }
  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.generateMipmaps = false;
  return rt;
}

function makePingPong(w: number, h: number): PingPong {
  return {
    targets: [makeRT(w, h, false), makeRT(w, h, false)],
    index: 0,
  };
}

function disposeRT(rt: THREE.WebGLRenderTarget) {
  rt.depthTexture?.dispose();
  rt.dispose();
}

/**
 * Pipeline post FX attaché à un WebGLRenderer Three.
 */
export class PostFxPipeline {
  private renderer: THREE.WebGLRenderer;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private buffers = new Map<Exclude<PostPassId, "image">, PingPong>();
  private passes = new Map<PostPassId, PassMat>();
  private channels = new Map<PostPassId, PostChannels>();
  private activePasses: PostPassId[] = [];
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quadMesh: THREE.Mesh;
  private width = 0;
  private height = 0;
  private scale = 1;
  private urlTextures = new Map<string, THREE.Texture>();
  private loader = new THREE.TextureLoader();
  private elementResolver: ((key: string) => Element | null) | null = null;
  private elementTextures = new Map<string, THREE.CanvasTexture>();
  private elementLastSeq = new Map<string, number>();
  private enabled = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const geo = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    this.quadScene.add(this.quadMesh);
    // PlaneGeometry face +Z ; ortho à z=0 regarde -Z → face arrière culée → noir.
    this.quadCam.position.set(0, 0, 1);
    this.quadCam.lookAt(0, 0, 0);
  }

  get isEnabled() {
    return this.enabled;
  }

  setElementResolver(fn: ((key: string) => Element | null) | null) {
    this.elementResolver = fn;
  }

  /**
   * Compile / (re)configure. `image` vide → désactive (rendu direct).
   * Lève `PostFxCompileError` si une passe échoue.
   */
  setConfig(config: PostFxConfig | null) {
    this.clearPasses();
    if (!config?.sources.image.trim()) {
      this.enabled = false;
      this.disposeTargets();
      return;
    }
    this.scale = clampPostScale(config.scale);
    this.channels = config.channels;
    const sources = config.sources;
    for (const pass of PASS_ORDER) {
      const code =
        pass === "image"
          ? sources.image
          : pass === "bufferA"
            ? sources.bufferA
            : pass === "bufferB"
              ? sources.bufferB
              : pass === "bufferC"
                ? sources.bufferC
                : sources.bufferD;
      if (!code.trim()) continue;
      try {
        this.passes.set(pass, this.compilePass(sources.common, code, pass));
        this.activePasses.push(pass);
      } catch (err) {
        this.clearPasses();
        this.enabled = false;
        this.disposeTargets();
        if (err instanceof PostFxCompileError) throw err;
        throw new PostFxCompileError(
          err instanceof Error ? err.message : String(err),
          pass,
        );
      }
    }
    this.enabled = this.activePasses.includes("image");
    if (!this.enabled) {
      this.clearPasses();
      this.disposeTargets();
    } else if (this.width > 0 && this.height > 0) {
      this.ensureTargets(this.width, this.height);
    }
  }

  resize(pixelW: number, pixelH: number) {
    const w = Math.max(1, Math.round(pixelW * this.scale));
    const h = Math.max(1, Math.round(pixelH * this.scale));
    if (w === this.width && h === this.height && this.sceneRT) return;
    if (this.enabled) this.ensureTargets(w, h);
    else {
      this.width = w;
      this.height = h;
    }
  }

  /**
   * Rend la scène 3D dans le RT, puis les passes post vers le canvas.
   */
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    frame: PostFxUniforms,
  ) {
    if (this.enabled && !this.sceneRT) {
      const size = new THREE.Vector2();
      this.renderer.getDrawingBufferSize(size);
      if (size.x >= 1 && size.y >= 1) this.ensureTargets(size.x, size.y);
    }
    if (!this.enabled || !this.sceneRT || this.width < 1 || this.height < 1) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    this.updateElementTextures();

    for (const pass of this.activePasses) {
      if (pass === "image") continue;
      this.drawPass(pass, frame, false);
    }
    this.drawPass("image", frame, true);
  }

  dispose() {
    this.clearPasses();
    this.disposeTargets();
    for (const t of this.urlTextures.values()) t.dispose();
    this.urlTextures.clear();
    for (const t of this.elementTextures.values()) t.dispose();
    this.elementTextures.clear();
    this.quadMesh.geometry.dispose();
    (this.quadMesh.material as THREE.Material).dispose();
  }

  private compilePass(
    common: string,
    userCode: string,
    pass: PostPassId,
  ): PassMat {
    const fragmentShader = buildThreeFragmentSource(common, userCode);
    const uniforms: PassMat["uniforms"] = {
      iResolution: { value: new THREE.Vector3(1, 1, 1) },
      iTime: { value: 0 },
      iTimeDelta: { value: 0 },
      iFrameRate: { value: 60 },
      iFrame: { value: 0 },
      iChannelTime: { value: new Float32Array(4) },
      iChannelResolution: { value: new Float32Array(12) },
      iMouse: { value: new THREE.Vector4() },
      iDate: { value: new THREE.Vector4() },
      iSampleRate: { value: 44100 },
      iChannel0: { value: BLACK },
      iChannel1: { value: BLACK },
      iChannel2: { value: BLACK },
      iChannel3: { value: BLACK },
      uParam0: { value: 0 },
      uParam1: { value: 0 },
      uParam2: { value: 0 },
      uParam3: { value: 0 },
      uNear: { value: 0 },
      uFar: { value: 0 },
    };
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: THREE_FULLSCREEN_VERTEX,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const log = this.validateGlsl(fragmentShader, pass);
    if (log) {
      material.dispose();
      throw new PostFxCompileError(`Compile error (${pass}): ${log}`, pass, log);
    }
    return { material, uniforms };
  }

  private validateGlsl(fragmentBody: string, pass: PostPassId): string | null {
    void pass;
    const gl = this.renderer.getContext();
    if (!gl) return null;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) return "Unable to create shader";
    gl.shaderSource(vs, `#version 300 es\n${THREE_FULLSCREEN_VERTEX}`);
    gl.shaderSource(fs, `#version 300 es\n${fragmentBody}`);
    gl.compileShader(vs);
    gl.compileShader(fs);
    let log = "";
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      log += gl.getShaderInfoLog(vs) || "vertex compile failed";
    }
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      log += gl.getShaderInfoLog(fs) || "fragment compile failed";
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const trimmed = log.trim();
    return trimmed || null;
  }

  private ensureTargets(w: number, h: number) {
    const ww = Math.max(1, Math.round(w));
    const hh = Math.max(1, Math.round(h));
    this.disposeTargets();
    this.sceneRT = makeRT(ww, hh, true);
    for (const pass of this.activePasses) {
      if (pass === "image") continue;
      this.buffers.set(pass, makePingPong(ww, hh));
    }
    // disposeTargets remettait width/height à 0 → iResolution nul → écran noir.
    this.width = ww;
    this.height = hh;
  }

  private disposeTargets() {
    if (this.sceneRT) {
      disposeRT(this.sceneRT);
      this.sceneRT = null;
    }
    for (const pp of this.buffers.values()) {
      disposeRT(pp.targets[0]);
      disposeRT(pp.targets[1]);
    }
    this.buffers.clear();
  }

  private clearPasses() {
    for (const p of this.passes.values()) p.material.dispose();
    this.passes.clear();
    this.activePasses = [];
  }

  private drawPass(
    pass: PostPassId,
    frame: PostFxUniforms,
    toScreen: boolean,
  ) {
    const pm = this.passes.get(pass);
    if (!pm) return;
    const channels =
      this.channels.get(pass) ||
      ([
        { kind: "scene" },
        { kind: "none" },
        { kind: "none" },
        { kind: "none" },
      ] as PostChannels);

    const res = pm.uniforms.iChannelResolution.value;
    for (let i = 0; i < 4; i++) {
      const tex = this.resolveChannel(pass, channels[i]);
      const u = pm.uniforms[
        `iChannel${i}` as "iChannel0" | "iChannel1" | "iChannel2" | "iChannel3"
      ];
      u.value = tex;
      const img = tex.image as { width?: number; height?: number } | undefined;
      const tw =
        (tex as THREE.Texture & { source?: { data?: { width?: number } } })
          .image?.width ||
        img?.width ||
        this.width ||
        1;
      const th =
        (tex as THREE.Texture & { source?: { data?: { height?: number } } })
          .image?.height ||
        img?.height ||
        this.height ||
        1;
      // RenderTargets expose width/height on the target, not texture.image
      let rw = tw;
      let rh = th;
      if (tex === this.sceneRT?.texture) {
        rw = this.width;
        rh = this.height;
      } else if (tex === this.sceneRT?.depthTexture) {
        rw = this.width;
        rh = this.height;
      } else {
        for (const [id, pp] of this.buffers) {
          void id;
          if (tex === pp.targets[0].texture || tex === pp.targets[1].texture) {
            rw = this.width;
            rh = this.height;
            break;
          }
        }
      }
      res[i * 3] = rw;
      res[i * 3 + 1] = rh;
      res[i * 3 + 2] = 1;
    }

    pm.uniforms.iResolution.value.set(this.width, this.height, 1);
    pm.uniforms.iTime.value = frame.time;
    pm.uniforms.iTimeDelta.value = frame.timeDelta;
    pm.uniforms.iFrameRate.value =
      frame.timeDelta > 0 ? 1 / frame.timeDelta : 60;
    pm.uniforms.iFrame.value = frame.frame;
    pm.uniforms.iMouse.value.set(
      frame.mouse[0],
      frame.mouse[1],
      frame.mouse[2],
      frame.mouse[3],
    );
    const d = new Date();
    pm.uniforms.iDate.value.set(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours() * 3600 +
        d.getMinutes() * 60 +
        d.getSeconds() +
        d.getMilliseconds() * 0.001,
    );
    pm.uniforms.uParam0.value = frame.params[0];
    pm.uniforms.uParam1.value = frame.params[1];
    pm.uniforms.uParam2.value = frame.params[2];
    pm.uniforms.uParam3.value = frame.params[3];
    pm.uniforms.uNear.value = frame.near;
    pm.uniforms.uFar.value = frame.far;

    this.quadMesh.material = pm.material;

    if (toScreen) {
      this.renderer.setRenderTarget(null);
    } else {
      const pp = this.buffers.get(pass as Exclude<PostPassId, "image">);
      if (!pp) return;
      const write = 1 - pp.index;
      this.renderer.setRenderTarget(pp.targets[write]);
      this.renderer.clear();
    }
    this.renderer.render(this.quadScene, this.quadCam);
    if (!toScreen) {
      const pp = this.buffers.get(pass as Exclude<PostPassId, "image">);
      if (pp) pp.index = 1 - pp.index;
    }
  }

  private resolveChannel(
    pass: PostPassId,
    source: PostChannelSource,
  ): THREE.Texture {
    if (source.kind === "none") return BLACK;
    if (source.kind === "scene") {
      return this.sceneRT?.texture ?? BLACK;
    }
    if (source.kind === "depth") {
      return this.sceneRT?.depthTexture ?? BLACK;
    }
    if (source.kind === "url") {
      return this.getUrlTexture(source.url);
    }
    if (source.kind === "element") {
      return this.getElementTexture(source.key) ?? BLACK;
    }
    const bufferId =
      source.kind === "self"
        ? pass === "image"
          ? null
          : pass
        : source.buffer;
    if (!bufferId) return BLACK;
    const pp = this.buffers.get(bufferId);
    if (!pp) return BLACK;
    return pp.targets[pp.index].texture;
  }

  private getUrlTexture(url: string): THREE.Texture {
    let t = this.urlTextures.get(url);
    if (t) return t;
    t = this.loader.load(url);
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = true;
    this.urlTextures.set(url, t);
    return t;
  }

  private getElementTexture(key: string): THREE.Texture | null {
    const el = this.elementResolver?.(key) ?? null;
    if (!el) return null;
    let canvas: HTMLCanvasElement | null = null;
    let seq = -1;
    if (isFrameSource(el)) {
      canvas = el.getFrameCanvas();
      seq = el.frameSeq;
    } else if (el instanceof HTMLCanvasElement) {
      canvas = el;
      seq = (this.elementLastSeq.get(key) ?? 0) + 1;
    } else if (el instanceof HTMLVideoElement) {
      if (el.readyState < 2) return this.elementTextures.get(key) ?? null;
      // CanvasTexture from video via temporary — use VideoTexture
      let vt = this.elementTextures.get(key) as THREE.VideoTexture | undefined;
      if (!vt) {
        vt = new THREE.VideoTexture(el);
        vt.colorSpace = THREE.NoColorSpace;
        this.elementTextures.set(key, vt as unknown as THREE.CanvasTexture);
      }
      vt.needsUpdate = true;
      return vt;
    } else if (el instanceof HTMLImageElement) {
      let it = this.urlTextures.get(key);
      if (!it && el.complete && el.naturalWidth > 0) {
        it = new THREE.Texture(el);
        it.needsUpdate = true;
        it.colorSpace = THREE.NoColorSpace;
        it.flipY = true;
        this.urlTextures.set(key, it);
      }
      return it ?? null;
    }
    if (!canvas || canvas.width < 1) return this.elementTextures.get(key) ?? null;
    let ct = this.elementTextures.get(key);
    if (!ct) {
      ct = new THREE.CanvasTexture(canvas);
      ct.colorSpace = THREE.NoColorSpace;
      ct.flipY = false;
      this.elementTextures.set(key, ct);
    } else if (ct.image !== canvas) {
      ct.image = canvas;
    }
    const last = this.elementLastSeq.get(key);
    if (last !== seq) {
      ct.needsUpdate = true;
      this.elementLastSeq.set(key, seq);
    }
    return ct;
  }

  private updateElementTextures() {
    for (const [key, tex] of this.elementTextures) {
      if (tex instanceof THREE.VideoTexture) {
        tex.needsUpdate = true;
        continue;
      }
      void this.getElementTexture(key);
    }
  }
}
