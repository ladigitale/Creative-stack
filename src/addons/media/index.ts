/**
 * Addon media : caméra, lecteur vidéo, bouton d'invite. Sources d'images pour
 * `sonic-shader` (Concorde), son routable vers le moteur audio partagé.
 */
export { SonicScreen, type ScreenState } from "./screen";
export { SonicCamera, type CameraState } from "./camera";
export { SonicVideo, type VideoState, type VideoStatus } from "./video";
export { SonicFrameSync, type FrameSyncMode, type FrameSyncState } from "./frame-sync";
export { SonicLuma, type LumaSettings, type LumaState } from "./luma";
export { SonicStill, type StillState, type StillStatus } from "./still";
export { SonicFileOpen, fileKind, type FileOpenState, type FileKind } from "./file-open";
export { SonicMediaStart } from "./start";
export { SonicMediaRecorder, type MediaRecorderState } from "./recorder";
export { SonicMediaDownload } from "./download";
export { pickMime, extensionFor } from "../../shared/media/record";
export { FrameRing, type RingSlot } from "../../shared/media/frame-ring";
export { VideoFrames, type FrameInfo, type FrameListener } from "../../shared/media/frames";
export { LumaDetector, LUMA_DEFAULTS, measureLuma, parseRegion, type LumaDetectorOptions, type LumaEdge, type LumaMeasure } from "../../shared/media/luma";
export {
  CONTROLS,
  TrackAdjuster,
  describeCapabilities,
  normalizeAdjust,
  type CameraAdjustState,
  type CameraCapabilities,
  type ControlDescriptor,
  type ControlKey,
  type ControlValue,
} from "../../shared/media/track-controls";
export { safeMediaUrl } from "../../shared/media/urls";
export { captureError, type CaptureStatus } from "../../shared/media/capture";
