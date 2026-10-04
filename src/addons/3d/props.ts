import { LitElement } from "lit";
import { property } from "lit/decorators.js";
import {
  DEFAULT_EXPOSURE,
  DEFAULT_FOV,
  DEFAULT_MAX_DISTANCE,
  DEFAULT_MAX_POLAR_DEG,
  DEFAULT_MIN_DISTANCE,
  DEFAULT_MIN_POLAR_DEG,
  DEFAULT_OUT_INTERVAL_MS,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  Sonic3dCameraMode,
} from "./constants";
import type { Sonic3dAsset } from "./types";

/** Attributs / propriétés Lit de `sonic-3d`. */
export class Sonic3dProps extends LitElement {
  @property() src = "";
  @property({ attribute: false }) asset: Sonic3dAsset | null = null;
  @property({ reflect: true })
  camera: Sonic3dCameraMode = Sonic3dCameraMode.Orbit;
  @property({ type: Number }) fov = DEFAULT_FOV;
  @property({ type: Number }) exposure = DEFAULT_EXPOSURE;
  @property({ type: Number, attribute: "min-distance" })
  minDistance = DEFAULT_MIN_DISTANCE;
  @property({ type: Number, attribute: "max-distance" })
  maxDistance = DEFAULT_MAX_DISTANCE;
  @property({ type: Number, attribute: "min-polar" })
  minPolar = DEFAULT_MIN_POLAR_DEG;
  @property({ type: Number, attribute: "max-polar" })
  maxPolar = DEFAULT_MAX_POLAR_DEG;
  @property({ type: Boolean, attribute: "auto-rotate" }) autoRotate = false;
  @property({ type: Boolean }) fit = true;
  @property({ type: Boolean }) pick = false;
  @property({ type: Boolean, reflect: true }) play = true;
  @property({ type: Boolean, attribute: "play-on-hover" }) playOnHover = false;
  /**
   * Garde le RAF / runtime hors viewport (pont live `#id`).
   * Aussi auto si un consommateur a appelé `registerFrameConsumer`.
   */
  @property({ type: Boolean, attribute: "play-offscreen" })
  playOffscreen = false;
  @property({ type: Boolean, attribute: "release-offscreen" })
  releaseOffscreen = true;
  /**
   * Inertie OrbitControls (`dampingFactor`). `0` = pas d’inertie.
   * Défaut `0.08`.
   */
  @property({ type: Number }) damping = 0.08;
  @property({ type: Number, attribute: "dpr-max" }) dprMax = 2;
  @property({ type: String, attribute: "aspect-ratio" }) aspectRatio = "";
  @property({ type: String }) dataProvider = "";
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";
  @property({ type: Number, attribute: "out-interval" })
  outInterval = DEFAULT_OUT_INTERVAL_MS;
  @property({ type: Number, attribute: "snapshot-interval" })
  snapshotInterval = DEFAULT_SNAPSHOT_INTERVAL_MS;
  /** Publie `frameUrl` / `snapshot` (canvas) pour chaînage shader / jsonata. */
  @property({ type: Boolean, attribute: "frame-out" }) frameOut = false;

  /* —— Post FX (Lot 2) : passes ShaderToy dans le contexte Three —— */
  @property({ attribute: "post-image" }) postImage = "";
  @property({ attribute: "post-buffer-a" }) postBufferA = "";
  @property({ attribute: "post-buffer-b" }) postBufferB = "";
  @property({ attribute: "post-buffer-c" }) postBufferC = "";
  @property({ attribute: "post-buffer-d" }) postBufferD = "";
  @property({ attribute: "post-common" }) postCommon = "";
  @property({ attribute: "post-image-ch0" }) postImageCh0 = "";
  @property({ attribute: "post-image-ch1" }) postImageCh1 = "";
  @property({ attribute: "post-image-ch2" }) postImageCh2 = "";
  @property({ attribute: "post-image-ch3" }) postImageCh3 = "";
  @property({ attribute: "post-buffer-a-ch0" }) postBufferACh0 = "";
  @property({ attribute: "post-buffer-a-ch1" }) postBufferACh1 = "";
  @property({ attribute: "post-buffer-a-ch2" }) postBufferACh2 = "";
  @property({ attribute: "post-buffer-a-ch3" }) postBufferACh3 = "";
  @property({ attribute: "post-buffer-b-ch0" }) postBufferBCh0 = "";
  @property({ attribute: "post-buffer-b-ch1" }) postBufferBCh1 = "";
  @property({ attribute: "post-buffer-b-ch2" }) postBufferBCh2 = "";
  @property({ attribute: "post-buffer-b-ch3" }) postBufferBCh3 = "";
  @property({ attribute: "post-buffer-c-ch0" }) postBufferCCh0 = "";
  @property({ attribute: "post-buffer-c-ch1" }) postBufferCCh1 = "";
  @property({ attribute: "post-buffer-c-ch2" }) postBufferCCh2 = "";
  @property({ attribute: "post-buffer-c-ch3" }) postBufferCCh3 = "";
  @property({ attribute: "post-buffer-d-ch0" }) postBufferDCh0 = "";
  @property({ attribute: "post-buffer-d-ch1" }) postBufferDCh1 = "";
  @property({ attribute: "post-buffer-d-ch2" }) postBufferDCh2 = "";
  @property({ attribute: "post-buffer-d-ch3" }) postBufferDCh3 = "";
  @property({ type: Number }) param0 = 0;
  @property({ type: Number }) param1 = 0;
  @property({ type: Number }) param2 = 0;
  @property({ type: Number }) param3 = 0;
  /** Échelle des cibles post (0.25–1, défaut 1). */
  @property({ type: Number, attribute: "post-scale" }) postScale = 1;
}
