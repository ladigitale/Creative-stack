import * as THREE from "three";

const WEBGL_UNAVAILABLE_MSG =
  "WebGL indisponible — sonic-3d nécessite WebGL.";

/** Crée un WebGLRenderer ou lève si WebGL indisponible (jsdom / GPU). */
export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2") || probe.getContext("webgl");
  if (!gl || typeof (gl as WebGLRenderingContext).getParameter !== "function") {
    throw new Error(WEBGL_UNAVAILABLE_MSG);
  }
  const rendererOpts = {
    canvas,
    antialias: true,
    alpha: false,
    /**
     * Requis pour `toBlob` / snapshot async après `render()` (pont shader via DP).
     */
    preserveDrawingBuffer: true,
    powerPreference: "high-performance" as const,
  };
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer(rendererOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${WEBGL_UNAVAILABLE_MSG} (${msg})`);
  }
  if (!renderer.getContext()) {
    renderer.dispose();
    throw new Error(WEBGL_UNAVAILABLE_MSG);
  }
  return renderer;
}
