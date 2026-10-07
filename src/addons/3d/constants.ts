/** Modes caméra V1 (défaut : Orbit). */
export const Sonic3dCameraMode = {
  Orbit: "orbit",
  Perspective: "perspective",
  Ortho: "ortho",
} as const;
export type Sonic3dCameraMode =
  (typeof Sonic3dCameraMode)[keyof typeof Sonic3dCameraMode];

/** Seuil de changement form→orbit (évite de combattre autoRotate). */
export const ORBIT_CHANGE_EPSILON = 1e-4;

export const DEFAULT_OUT_INTERVAL_MS = 80;
export const MIN_OUT_INTERVAL_MS = 16;
/** Throttle capture canvas → `frameUrl` / `snapshot` (plus lourd que la télémétrie). */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 250;
export const MIN_SNAPSHOT_INTERVAL_MS = 80;
/** MIME / qualité JPEG pour `canvas.toBlob` (frameUrl / snapshot). */
export const SNAPSHOT_JPEG_MIME = "image/jpeg";
export const SNAPSHOT_JPEG_QUALITY = 0.85;

export const DEFAULT_FOV = 45;
export const DEFAULT_EXPOSURE = 1;
export const DEFAULT_MIN_DISTANCE = 0.5;
export const DEFAULT_MAX_DISTANCE = 50;
/** Polar Lit attrs (degrés). */
export const DEFAULT_MIN_POLAR_DEG = 8;
export const DEFAULT_MAX_POLAR_DEG = 172;
/** Polar runtime avant apply des attrs (= DEFAULT_MIN_POLAR_DEG). */
export const DEFAULT_MIN_POLAR_RAD =
  (DEFAULT_MIN_POLAR_DEG * Math.PI) / 180;

/**
 * Champs form → viewer (auto via `dataProvider` / ancêtre `formDataProvider`).
 */
export const FORM_CONTROL_KEYS = [
  "src",
  "asset",
  "camera",
  "fov",
  "exposure",
  "autoRotate",
  "minDistance",
  "maxDistance",
  "minPolar",
  "maxPolar",
  "distance",
  "yaw",
  "pitch",
] as const;

/**
 * Entrées « pures » : ne jamais les réécrire en out si form et out partagent le DP.
 * (`yaw` / `pitch` / `distance` restent publiables — télémétrie / two-way).
 */
export const FORM_INPUT_ONLY_KEYS = [
  "src",
  "asset",
  "camera",
  "fov",
  "exposure",
  "autoRotate",
  "minDistance",
  "maxDistance",
  "minPolar",
  "maxPolar",
] as const;

/**
 * Clés qui comptent comme consommateurs out (gate publication paresseuse).
 * yaw / pitch / distance exclus : un `sonic-audio-input name="yaw"` ne doit pas
 * activer la pub télémétrie (sinon boucle form ↔ out).
 */
export const OUT_CONSUMER_KEYS = [
  "time",
  "frame",
  "ready",
  "loading",
  "hovering",
  "pointerX",
  "pointerY",
  "camX",
  "camY",
  "camZ",
  "targetX",
  "targetY",
  "targetZ",
  "zoom",
  "hitX",
  "hitY",
  "hitZ",
  "hitObjectId",
  /** Canvas → ObjectURL (SonicMediaRef) pour chaînage shader. */
  "frameUrl",
  "snapshot",
  /** Pont live → sonic-shader (`{ element }`), publié une fois au ready. */
  "frameSource",
  "moving",
] as const;

export type Sonic3dFormControlKey = (typeof FORM_CONTROL_KEYS)[number];
