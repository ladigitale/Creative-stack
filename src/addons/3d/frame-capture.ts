import { revokeMediaUrls } from "../../shared/mediaRef";
import {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  MIN_SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_JPEG_MIME,
  SNAPSHOT_JPEG_QUALITY,
} from "./constants";
import { publisherFieldHasListener } from "./publisher-listen";
import type { Sonic3dSnapshot } from "./types";

export type FrameCaptureHost = {
  outPublisher: {
    _proxies_?: Map<string, { hasListener?: () => boolean }>;
  } | null;
  runtime: {
    renderer: { domElement: HTMLCanvasElement };
  } | null;
  snapshotInterval: number;
  frameOut: boolean;
  snapshotBusy: boolean;
  lastSnapshotAt: number;
  frameUrls: string[];
  snapshotSeq: number;
};

const FRAME_KEYS = ["frameUrl", "snapshot"] as const;

function wantsFrameCapture(host: FrameCaptureHost): boolean {
  if (!host.outPublisher) return false;
  if (host.frameOut) return true;
  for (const key of FRAME_KEYS) {
    if (publisherFieldHasListener(host.outPublisher, key)) return true;
  }
  return false;
}

function mediaFromBlob(
  canvas: HTMLCanvasElement,
  blob: Blob,
): Sonic3dSnapshot {
  const url = URL.createObjectURL(blob);
  return {
    url,
    blob,
    width: canvas.width,
    height: canvas.height,
    mime: blob.type || SNAPSHOT_JPEG_MIME,
  };
}

function canvasToMedia(
  canvas: HTMLCanvasElement,
): Promise<Sonic3dSnapshot | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }
    const onBlob = (blob: Blob | null) => {
      if (!blob) {
        resolve(null);
        return;
      }
      resolve(mediaFromBlob(canvas, blob));
    };
    try {
      canvas.toBlob(onBlob, SNAPSHOT_JPEG_MIME, SNAPSHOT_JPEG_QUALITY);
    } catch {
      resolve(null);
    }
  });
}

function writeFrameFields(host: FrameCaptureHost, media: Sonic3dSnapshot) {
  const pub = host.outPublisher as Record<
    string,
    { set: (v: unknown) => void }
  > | null;
  if (!pub) return;
  try {
    pub.frameUrl.set(media.url);
  } catch {
    /* leaf manquant */
  }
  try {
    pub.snapshot.set(media);
  } catch {
    /* leaf manquant */
  }
}

/**
 * Si un consommateur écoute `frameUrl` / `snapshot`, capture le canvas
 * (throttlé, async). Révoque l’ObjectURL précédent.
 */
function maybeCapture(host: FrameCaptureHost, now: number) {
  if (host.snapshotBusy) return;
  if (!host.runtime) return;
  if (!wantsFrameCapture(host)) return;
  const interval = Math.max(
    MIN_SNAPSHOT_INTERVAL_MS,
    Number.isFinite(host.snapshotInterval) && host.snapshotInterval > 0
      ? host.snapshotInterval
      : DEFAULT_SNAPSHOT_INTERVAL_MS,
  );
  if (now - host.lastSnapshotAt < interval) return;
  host.lastSnapshotAt = now;
  host.snapshotBusy = true;
  const seq = ++host.snapshotSeq;
  const canvas = host.runtime.renderer.domElement;
  void canvasToMedia(canvas).then((media) => {
    host.snapshotBusy = false;
    if (!media || seq !== host.snapshotSeq) {
      if (media) revokeMediaUrls([media.url]);
      return;
    }
    revokeMediaUrls(host.frameUrls);
    host.frameUrls = [media.url];
    writeFrameFields(host, media);
  });
}

function revokeAll(host: FrameCaptureHost) {
  host.snapshotSeq++;
  host.snapshotBusy = false;
  revokeMediaUrls(host.frameUrls);
  host.frameUrls = [];
}

export const frameCapture = {
  wantsFrameCapture,
  maybeCapture,
  revokeAll,
  FRAME_KEYS,
} as const;
