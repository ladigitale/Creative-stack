/**
 * Types publics de `sonic-3d`.
 *
 * Contrat d’asset volontairement neutre (URL / blob) pour brancher plus tard
 * fetch, upload ou exports HF sans coupler le viewer à la source.
 */

import type {
  Sonic3dCameraMode,
  Sonic3dFormControlKey,
} from "./constants";

export type { Sonic3dCameraMode, Sonic3dFormControlKey };

/** Kind d’asset 3D (extension / hint — le loader se base surtout sur l’URL). */
export type Sonic3dAssetKind = "gltf" | "glb" | "obj" | "ply" | "url";

/**
 * Asset publié vers / lu depuis un dataProvider.
 * `url` suffit pour glTF/GLB ; `blob` permet un branchement auto (ex. HF).
 */
export type Sonic3dAsset = {
  kind?: Sonic3dAssetKind;
  url?: string;
  blob?: Blob;
  /** Morph targets optionnels (clip weights 0–1). */
  morphTargets?: Record<string, number>;
};

/**
 * API typée de `sonic-3d` (attributs / propriétés).
 */
export type Sonic3dConfig = {
  /** URL glTF / GLB. Vide → cube de démo. */
  src?: string;
  /**
   * Asset structuré (prioritaire sur `src` si `url` / `blob` présents).
   * Peut aussi arriver via dataProvider (`asset` ou `src`).
   */
  asset?: Sonic3dAsset | null;

  camera?: Sonic3dCameraMode;
  /** FOV perspective (deg, défaut 45). */
  fov?: number;
  /** Exposition renderer (défaut 1). */
  exposure?: number;
  /** Distance orbit mini (défaut 0.5). */
  minDistance?: number;
  /** Distance orbit maxi (défaut 50). `0` / ∞ désactive le plafond. */
  maxDistance?: number;
  /** Polar mini en degrés (défaut 8). */
  minPolar?: number;
  /** Polar maxi en degrés (défaut 172). */
  maxPolar?: number;
  /** Rotation auto orbit (désactivée si prefers-reduced-motion). */
  autoRotate?: boolean;
  /** Fit caméra sur le bbox après load (défaut true). */
  fit?: boolean;
  /** Active le raycast au clic → hit* + event `pick`. */
  pick?: boolean;

  /** Boucle RAF (défaut true). Pause hors viewport / reduced-motion. */
  play?: boolean;
  /** N’anime (autoRotate / RAF) que pendant le hover. */
  playOnHover?: boolean;
  /** Libère le renderer hors viewport (défaut true). */
  releaseOffscreen?: boolean;
  /**
   * Garde RAF / runtime hors viewport (pont live).
   * Aussi auto via `registerFrameConsumer`.
   */
  playOffscreen?: boolean;
  /** Inertie OrbitControls (défaut 0.08, 0 = off). */
  damping?: number;
  dprMax?: number;
  aspectRatio?: string;

  /**
   * Publisher entrée : `src`, `asset`, `fov`, `exposure`, `autoRotate`…
   * Sinon ancêtre `dataProvider` / `formDataProvider`.
   */
  dataProvider?: string;
  /**
   * Publisher de sortie (défaut = dataProvider).
   * Publication paresseuse — rien tant qu’aucun consommateur.
   */
  outDataProvider?: string;
  /** Intervalle de publication ms (défaut 80). */
  outInterval?: number;
  /**
   * Intervalle capture canvas → `frameUrl` / `snapshot` (défaut 250).
   * Uniquement si `frame-out` ou un consommateur écoute ces champs.
   */
  snapshotInterval?: number;
  /**
   * Force la publication canvas (`frameUrl` + `snapshot`) même sans
   * listener dédié — utile pour chaîner via `sonic-jsonata`.
   */
  frameOut?: boolean;
};

/** MediaRef canvas publié sur `snapshot` (ObjectURL + dimensions). */
export type Sonic3dSnapshot = {
  url: string;
  width: number;
  height: number;
  mime?: string;
  blob?: Blob;
};

/**
 * Snapshot publié vers `outDataProvider` (et event `out`).
 * Coords pointeur normalisées 0–1 ; hit en espace monde.
 */
export type Sonic3dOutput = {
  time: number;
  frame: number;
  ready: number;
  loading: number;
  hovering: number;
  pointerX: number;
  pointerY: number;
  camX: number;
  camY: number;
  camZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  fov: number;
  zoom: number;
  distance: number;
  yaw: number;
  pitch: number;
  /** 1 si la caméra bouge (orbit / inertie / autoRotate), sinon 0. */
  moving?: number;
  /** Présents après un pick réussi. */
  hitX?: number;
  hitY?: number;
  hitZ?: number;
  hitObjectId?: string;
  bboxMinX?: number;
  bboxMinY?: number;
  bboxMinZ?: number;
  bboxMaxX?: number;
  bboxMaxY?: number;
  bboxMaxZ?: number;
  /**
   * ObjectURL du canvas (JPEG), publié seulement si un consommateur écoute
   * `frameUrl` / `snapshot`. Alias pratique de `snapshot.url`.
   */
  frameUrl?: string;
  /** MediaRef du canvas (url + dimensions) — chaînable vers `sonic-shader`. */
  snapshot?: Sonic3dSnapshot;
  /**
   * Pont live (Lot 1) : `{ element: sonic-3d }` pour `channel0` sans JPEG.
   * Publié une fois au ready si un lecteur écoute `frameSource`.
   */
  frameSource?: { element: Element };
};
