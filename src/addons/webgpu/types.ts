/**
 * Types publics de `sonic-webgpu`.
 * Glue DataProvider + SonicMediaRef (comme shader) ; `$mediaUrl` = helper jsonata côté expressions.
 */

/** Backend GPU actif (`auto` : ordre dépend du WGSL custom — voir `sonic-webgpu`). */
export type SonicWebGpuBackendPrefer = "auto" | "webgpu" | "webgl2";
export type SonicWebGpuBackend = "webgpu" | "webgl2" | "canvas2d";

/** Noyau métier — `particles` = compute (ce qui démarque de sonic-shader). */
export type SonicWebGpuKernel = "" | "image" | "particles";

export type SonicWebGpuConfig = {
  /** Corps WGSL : doit définir `fn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f`. */
  shader?: string;
  /**
   * `particles` — simulation compute (défaut démo utile).
   * `image` / `""` — passe fullscreen + canaux (proche shader).
   */
  kernel?: SonicWebGpuKernel;
  /**
   * `auto` (défaut) : meilleur backend dispo.
   */
  backend?: SonicWebGpuBackendPrefer;
  channel0?: string;
  channel1?: string;
  channel2?: string;
  channel3?: string;
  play?: boolean;
  mouse?: boolean;
  releaseOffscreen?: boolean;
  dprMax?: number;
  param0?: number;
  param1?: number;
  param2?: number;
  param3?: number;
  /**
   * Attracteur normalisé (0–1, origine haut-gauche) via dataProvider —
   * tracking vidéo / landmarks → particules sans pointer.
   */
  targetX?: number;
  targetY?: number;
  dataProvider?: string;
  outDataProvider?: string;
  /** DP de réglages en direct, prioritaires sur les attributs : `{ play, mouse, backend, dprMax, shader }`. */
  params?: string;
  outInterval?: number;
  /** Publie `frameUrl` + `snapshot` (SonicMediaRef) vers le out-DP. */
  frameOut?: boolean;
  aspectRatio?: string;
};

/** Sortie publiée / event `out`. */
export type SonicWebGpuOutput = {
  time: number;
  frame: number;
  mouseX: number;
  mouseY: number;
  hovering: boolean;
  param0: number;
  param1: number;
  param2: number;
  param3: number;
  backend?: SonicWebGpuBackend;
  /** ObjectURL du canvas (si `frame-out`). */
  frameUrl?: string;
  /** MediaRef du frame (si `frame-out`). */
  snapshot?: {
    url: string;
    width: number;
    height: number;
    mime: string;
  };
};

/** Erreur WGSL détaillée : ligne / colonne dans le corps `shader` de l'utilisateur (`null` si inconnue ou dans le prélude). */
export type WebGpuErrorItem = {
  line: number | null;
  column: number | null;
  message: string;
};

/**
 * État publié par `sonic-webgpu` dans son DP de sortie.
 * `idle` (pas encore de backend), `compiling` (démarrage du backend / compilation WGSL),
 * `ready` (rendu actif), `error` (aucun backend, WGSL invalide, texture…).
 */
export type SonicWebGpuState = {
  status: "idle" | "compiling" | "ready" | "error";
  error: string | null;
  errors: WebGpuErrorItem[];
  /** Backend réellement utilisé, `null` tant qu'aucun n'a démarré. */
  activeBackend: SonicWebGpuBackend | null;
  /** Essais de démarrage (`webgl2:ok`, `webgpu:no-navigator.gpu`…). */
  backendLog: string[];
  /** Bandeau affiché (repli WebGL2 qui ignore le WGSL, Canvas2D…), sinon `null`. */
  notice: string | null;
  /** Vrai si la boucle d'animation tourne. */
  playing: boolean;
};

export class WebGpuCompileError extends Error {
  constructor(
    message: string,
    public readonly infoLog?: string,
    /** Messages du compilateur, lignes ramenées au corps de l'utilisateur. */
    public readonly messages?: WebGpuErrorItem[],
  ) {
    super(message);
    this.name = "WebGpuCompileError";
  }
}

export function parseBackendPrefer(
  value: unknown,
): SonicWebGpuBackendPrefer {
  const s = String(value ?? "auto").trim().toLowerCase();
  if (s === "webgpu" || s === "webgl2" || s === "auto") return s;
  return "auto";
}

export function parseKernel(value: unknown): SonicWebGpuKernel {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "particles" || s === "image") return s;
  return "";
}
