import type { SceneRuntime } from "./runtime";

export type PlaybackHost = {
  play: boolean;
  ready: boolean;
  inView: boolean;
  runtime: SceneRuntime | null;
  playOnHover: boolean;
  hovering: boolean;
  autoRotate: boolean;
  playOffscreen: boolean;
  /** Nombre de consommateurs live (`registerFrameConsumer`). */
  frameConsumerCount: number;
  raf: number;
  drawFrame: (now: number) => void;
};

/** Hors écran : jouer si `play-offscreen` ou au moins un consommateur live. */
export function wantsOffscreenPlay(host: {
  playOffscreen: boolean;
  frameConsumerCount: number;
}): boolean {
  return !!host.playOffscreen || host.frameConsumerCount > 0;
}

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function shouldAnimate(host: PlaybackHost): boolean {
  if (!host.play) return false;
  if (!host.ready) return false;
  if (!host.inView && !wantsOffscreenPlay(host)) return false;
  if (!host.runtime) return false;
  if (prefersReducedMotion()) return false;
  if (host.playOnHover) return host.hovering;
  return true;
}

function syncAutoRotate(host: PlaybackHost) {
  const on =
    host.autoRotate &&
    host.play &&
    !prefersReducedMotion() &&
    (!host.playOnHover || host.hovering);
  host.runtime?.setAutoRotate(!!on);
}

function stopLoop(host: PlaybackHost) {
  if (host.raf) {
    cancelAnimationFrame(host.raf);
    host.raf = 0;
  }
}

function startLoop(host: PlaybackHost, loop: () => void) {
  if (!host.raf) {
    host.raf = requestAnimationFrame(loop);
  }
}

function syncPlayback(host: PlaybackHost, loop: () => void) {
  syncAutoRotate(host);
  if (shouldAnimate(host)) {
    startLoop(host, loop);
  } else {
    stopLoop(host);
    if (host.ready) host.runtime?.render();
  }
}

export const playback = {
  prefersReducedMotion,
  shouldAnimate,
  wantsOffscreenPlay,
  syncAutoRotate,
  syncPlayback,
  stopLoop,
} as const;
