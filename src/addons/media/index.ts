/**
 * Addon media : caméra, lecteur vidéo, bouton d'invite. Sources d'images pour
 * `sonic-shader` (Concorde), son routable vers le moteur audio partagé.
 */
export { SonicScreen, type ScreenState } from "./screen";
export { SonicCamera, type CameraState } from "./camera";
export { SonicVideo, type VideoState, type VideoStatus } from "./video";
export { SonicMediaStart } from "./start";
export { SonicMediaRecorder, type MediaRecorderState } from "./recorder";
export { SonicMediaDownload } from "./download";
export { pickMime, extensionFor } from "../../shared/media/record";
export { VideoFrames } from "../../shared/media/frames";
export { safeMediaUrl } from "../../shared/media/urls";
export { captureError, type CaptureStatus } from "../../shared/media/capture";
