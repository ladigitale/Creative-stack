export type ShaderPassId =
  | "image"
  | "bufferA"
  | "bufferB"
  | "bufferC"
  | "bufferD";

/** Format interne des buffers A–D (Image = toujours le canvas RGBA8). */
export type ShaderBufferFormat = "rgba8" | "rgba16f" | "rgba32f";

export function parseBufferFormat(
  value: string | null | undefined,
): ShaderBufferFormat {
  const s = (value ?? "").trim().toLowerCase();
  if (s === "rgba16f" || s === "rgba16" || s === "half") return "rgba16f";
  if (s === "rgba32f" || s === "rgba32" || s === "float") return "rgba32f";
  return "rgba8";
}

/**
 * Hors viewport : libérer textures/FBO ?
 * - `true` / `false` — forcé
 * - `auto` (défaut) — libère sauf si une passe lit `self` (état conservé)
 */
export type ReleaseOffscreen = boolean | "auto";

export function parseReleaseOffscreen(
  value: string | null | undefined,
): ReleaseOffscreen {
  if (value == null) return "auto";
  const s = value.trim().toLowerCase();
  if (s === "auto") return "auto";
  if (s === "false" || s === "0") return false;
  // attribut booléen présent (`""`) ou `"true"`
  return true;
}

/** Au moins un canal `self` (feedback frame précédente). */
export function channelsUseSelf(
  channels: Iterable<readonly ChannelSource[]>,
): boolean {
  for (const chs of channels) {
    for (const c of chs) {
      if (c.kind === "self") return true;
    }
  }
  return false;
}

export function shouldReleaseWhenOffscreen(
  mode: ReleaseOffscreen,
  usesSelf: boolean,
): boolean {
  if (mode === false) return false;
  if (mode === true) return true;
  return !usesSelf;
}

export type ChannelSource =
  | { kind: "url"; url: string }
  | { kind: "buffer"; buffer: Exclude<ShaderPassId, "image"> }
  | { kind: "self" }
  | { kind: "none" }
  /** Élément page (`#id`) — upload live via `updateElementTextures`. */
  | { kind: "element"; key: string; el?: Element | null };

export type PassChannels = [
  ChannelSource,
  ChannelSource,
  ChannelSource,
  ChannelSource,
];

export type ShaderSources = {
  common: string;
  image: string;
  bufferA: string;
  bufferB: string;
  bufferC: string;
  bufferD: string;
};

export type ChannelUrls = [string, string, string, string];

export type PassChannelOverrides = Partial<
  Record<ShaderPassId, Partial<Record<0 | 1 | 2 | 3, string>>>
>;

/** Slot uniform `uParam0`…`uParam3`. */
export type ShaderParamSlot = 0 | 1 | 2 | 3;

/**
 * Mode pointeur → `iMouse.xy` :
 * - `direct` — position immédiate (compat ShaderToy)
 * - `target` — le pointeur est une cible ; poursuite exponentielle (vitesse ∝ distance)
 */
export type ShaderMouseMode = "direct" | "target";

/**
 * Quel `uParamN` animer au rollover / roll-out (effet on/off 0→1 / 1→0).
 * Accepte `0`…`3`, `"0"`…`"3"`, `"param0"`…`"param3"`, ou `""` (désactivé).
 */
export type ShaderHoverParam =
  | ShaderParamSlot
  | `${ShaderParamSlot}`
  | `param${ShaderParamSlot}`
  | "";

/**
 * API typée de `sonic-shader` (attributs / propriétés).
 * Les sources GLSL (`image`, `bufferA`…) se passent en propriétés JS.
 */
export type SonicShaderConfig = {
  /** GLSL pass Image (requis). */
  image: string;
  bufferA?: string;
  bufferB?: string;
  bufferC?: string;
  bufferD?: string;
  common?: string;

  channel0?: string;
  channel1?: string;
  channel2?: string;
  channel3?: string;

  imageCh0?: string;
  imageCh1?: string;
  imageCh2?: string;
  imageCh3?: string;
  bufferACh0?: string;
  bufferACh1?: string;
  bufferACh2?: string;
  bufferACh3?: string;
  bufferBCh0?: string;
  bufferBCh1?: string;
  bufferBCh2?: string;
  bufferBCh3?: string;
  bufferCCh0?: string;
  bufferCCh1?: string;
  bufferCCh2?: string;
  bufferCCh3?: string;
  bufferDCh0?: string;
  bufferDCh1?: string;
  bufferDCh2?: string;
  bufferDCh3?: string;

  /** Boucle RAF (défaut `true`). Pause hors viewport / `prefers-reduced-motion`. */
  play?: boolean;
  /**
   * Si `true`, n’anime que pendant le hover (ou tant que le param hover n’a pas
   * fini sa transition). Utile avec beaucoup d’instances.
   */
  playOnHover?: boolean;

  /** Active le suivi pointeur → `iMouse` (défaut `true`). */
  mouse?: boolean;
  mouseMode?: ShaderMouseMode;
  /** Vitesse de poursuite en mode `target` (1/s, défaut `8`). */
  mouseSpeed?: number;

  /**
   * Anime `uParamN` : `1` au rollover, `0` au roll-out
   * (easing via `hoverSpeed`). Le shader lit `uParamN` pour mixer l’effet.
   */
  hoverParam?: ShaderHoverParam;
  /** Vitesse d’easing hover on/off (1/s, défaut `10`). */
  hoverSpeed?: number;

  param0?: number;
  param1?: number;
  param2?: number;
  param3?: number;

  /**
   * Publisher id. Champs `param0`…`param3`, optionnel `mouseSpeed` / `hoverSpeed`.
   * Canaux `channel0`… / `imageCh0`… / `bufferACh0`… : string URL **ou**
   * `SonicMediaRef` (`url` / `blobUrl`). Sinon ancêtre `dataProvider` / `formDataProvider`.
   */
  dataProvider?: string;
  /**
   * Publisher de sortie (défaut : même que `dataProvider`).
   * Écrit `mouseX`/`mouseY`/`hovering`/`frame` (+ samples si `sample`).
   * `param0…` : écrits si `out-data-provider` est séparé ; sur DP partagé
   * avec le form, seul le slot `hover-param` est réécrit.
   * Publication **paresseuse** : aucun set / readPixels tant qu’aucun champ
   * n’a de listener et qu’aucun event `out` n’est branché.
   */
  outDataProvider?: string;
  /**
   * Active le sample couleur sous le pointeur → `sampleR`… / `sampleLuma`.
   * Le `readPixels` ne tourne que s’il existe un consommateur out (DP ou event).
   */
  sample?: boolean;
  /** Intervalle de publication ms (défaut 80). */
  outInterval?: number;

  /** Active l’extraction de patches / singularités. */
  extract?: boolean;
  extractInterval?: number;
  /** `image` \| `buffer-a`… */
  extractSource?: string;
  /** `none` \| `buffer-a`… */
  extractMask?: string;
  extractThreshold?: number;
  extractMax?: number;
  extractPatch?: number;
  extractBitmaps?: boolean;
  extractDataProvider?: string;

  aspectRatio?: string;
  dprMax?: number;

  /**
   * Format des buffers A–D : `rgba8` (défaut) \| `rgba16f` \| `rgba32f`.
   * Requis pour des valeurs signées / hors [0,1] (ex. tenseur Harris).
   * Repli auto en `rgba8` si `EXT_color_buffer_float` manque.
   */
  bufferFormat?: ShaderBufferFormat;

  /**
   * Hors viewport : libère textures/FBO, sans loseContext.
   * `auto` (défaut) : ne libère pas si une passe lit `self`.
   * Le slot navigateur est libéré au disconnect.
   */
  releaseOffscreen?: ReleaseOffscreen;
};

/** Parse `hover-param` → slot ou `null` si désactivé / invalide. */
export function parseHoverParam(
  value: string | number | null | undefined,
): ShaderParamSlot | null {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (value === 0 || value === 1 || value === 2 || value === 3) return value;
    return null;
  }
  const s = value.trim().toLowerCase();
  if (s === "0" || s === "param0") return 0;
  if (s === "1" || s === "param1") return 1;
  if (s === "2" || s === "param2") return 2;
  if (s === "3" || s === "param3") return 3;
  return null;
}

/**
 * Snapshot publié vers `dataProvider` / `outDataProvider` (et event `out`).
 * Coords souris normalisées 0–1 ; samples en 0–1 si `sample` actif.
 */
export type SonicShaderOutput = {
  time: number;
  frame: number;
  /** Pointeur X normalisé (0–1), ou 0.5 si pas encore de pointeur. */
  mouseX: number;
  mouseY: number;
  /** 1 si survol, sinon 0. */
  hovering: number;
  param0: number;
  param1: number;
  param2: number;
  param3: number;
  /** Présents si `sample` : couleur lue sous le pointeur (ou centre). */
  sampleR?: number;
  sampleG?: number;
  sampleB?: number;
  sampleA?: number;
  /** Luminance Rec.709. */
  sampleLuma?: number;
};

/** Pass source pour lecture extract (Image ou buffer). */
export type ShaderExtractPass = ShaderPassId;

/** ROI manuel ou détecté — coords normalisées 0–1, origine bas-gauche (ShaderToy). */
export type ShaderRoi = {
  id?: string;
  /** Centre (si w/h absents) ou coin bas-gauche (si w/h présents). */
  x: number;
  y: number;
  /** Largeur normalisée ; si absente → patch carré `patch` px autour du point. */
  w?: number;
  /** Hauteur normalisée. */
  h?: number;
  /** Taille patch en px drawing-buffer si w/h absents (défaut composant). */
  patch?: number;
  source?: "manual" | "detect";
};

export type ShaderExtractItem = {
  id: string;
  /** Rectangle normalisé 0–1 (coin bas-gauche + taille). */
  x: number;
  y: number;
  w: number;
  h: number;
  meanR: number;
  meanG: number;
  meanB: number;
  meanA: number;
  meanLuma: number;
  /** Présent si `extract-bitmaps` — alias `url` pour SonicMediaRef. */
  blobUrl?: string;
  /** Alias de `blobUrl` (chaînage `$mediaUrl` / canaux shader). */
  url?: string;
  /** Score détection (canal R du mask), si `source:"detect"`. */
  score?: number;
  source: "manual" | "detect";
};

export type ShaderExtractOutput = {
  frame: number;
  time: number;
  items: ShaderExtractItem[];
};

export type FindPeaksOptions = {
  /** Seuil 0–1 sur canal R (défaut 0.5). */
  threshold?: number;
  /** Nombre max de peaks (défaut 8). */
  maxCount?: number;
  /** Distance min entre peaks en px (défaut 16). */
  minDistance?: number;
};

export type ShaderPeak = {
  x: number;
  y: number;
  score: number;
};

export type ReadRectResult = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `Uint8Array` (RGBA8) ou `Float32Array` (buffers flottants). */
  data: Uint8Array | Float32Array;
};

/** Parse `extract-source` / `extract-mask` → pass id ou null. */
export function parseExtractPass(
  value: string | null | undefined,
): ShaderPassId | null {
  if (value === "" || value === null || value === undefined) return null;
  const s = value.trim().toLowerCase();
  if (s === "none" || s === "off" || s === "false") return null;
  if (s === "image") return "image";
  if (s === "buffer-a" || s === "buffera" || s === "a") return "bufferA";
  if (s === "buffer-b" || s === "bufferb" || s === "b") return "bufferB";
  if (s === "buffer-c" || s === "bufferc" || s === "c") return "bufferC";
  if (s === "buffer-d" || s === "bufferd" || s === "d") return "bufferD";
  return null;
}

/**
 * NMS simple sur canal R (RGBA row-major, origine bas-gauche comme WebGL).
 * Retourne peaks triés par score décroissant.
 * Accepte Uint8 (0–255) ou Float32 (scores déjà dans ~[0,1]).
 */
export function findPeaks(
  data: Uint8Array | Float32Array,
  width: number,
  height: number,
  options: FindPeaksOptions = {},
): ShaderPeak[] {
  const threshold = Math.max(0, Math.min(1, options.threshold ?? 0.5));
  const maxCount = Math.max(0, Math.floor(options.maxCount ?? 8));
  const minDistance = Math.max(1, Math.floor(options.minDistance ?? 16));
  if (maxCount === 0 || width < 1 || height < 1 || data.length < width * height * 4) {
    return [];
  }
  const isFloat = data instanceof Float32Array;
  const thr = isFloat ? threshold : threshold * 255;
  const toScore = (v: number) => (isFloat ? v : v / 255);
  const candidates: ShaderPeak[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      const v = data[i];
      if (v < thr) continue;
      // Local max 3×3
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const j = ((y + dy) * width + (x + dx)) * 4;
          if (data[j] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) candidates.push({ x, y, score: toScore(v) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked: ShaderPeak[] = [];
  const minDist2 = minDistance * minDistance;
  for (const c of candidates) {
    if (picked.length >= maxCount) break;
    let ok = true;
    for (const p of picked) {
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      if (dx * dx + dy * dy < minDist2) {
        ok = false;
        break;
      }
    }
    if (ok) picked.push(c);
  }
  return picked;
}

/** Clamp + convertit un ROI normalisé en pixels drawing-buffer. */
export function roiToPixels(
  roi: ShaderRoi,
  bufW: number,
  bufH: number,
  defaultPatchPx: number,
  maxPatchPx = 128,
): { x: number; y: number; w: number; h: number } | null {
  if (bufW < 1 || bufH < 1) return null;
  const hasSize =
    typeof roi.w === "number" &&
    typeof roi.h === "number" &&
    Number.isFinite(roi.w) &&
    Number.isFinite(roi.h) &&
    roi.w > 0 &&
    roi.h > 0;
  let px: number;
  let py: number;
  let pw: number;
  let ph: number;
  if (hasSize) {
    px = Math.floor(roi.x * bufW);
    py = Math.floor(roi.y * bufH);
    pw = Math.max(1, Math.round(roi.w! * bufW));
    ph = Math.max(1, Math.round(roi.h! * bufH));
  } else {
    const patch = Math.min(
      maxPatchPx,
      Math.max(1, Math.floor(roi.patch ?? defaultPatchPx)),
    );
    const cx = roi.x * bufW;
    const cy = roi.y * bufH;
    pw = patch;
    ph = patch;
    px = Math.floor(cx - patch / 2);
    py = Math.floor(cy - patch / 2);
  }
  // Clamp dans le buffer
  if (px < 0) {
    pw += px;
    px = 0;
  }
  if (py < 0) {
    ph += py;
    py = 0;
  }
  if (px + pw > bufW) pw = bufW - px;
  if (py + ph > bufH) ph = bufH - py;
  if (pw < 1 || ph < 1) return null;
  pw = Math.min(pw, maxPatchPx);
  ph = Math.min(ph, maxPatchPx);
  return { x: px, y: py, w: pw, h: ph };
}

export function meanRgba(data: Uint8Array | Float32Array): {
  r: number;
  g: number;
  b: number;
  a: number;
  luma: number;
} {
  const n = Math.floor(data.length / 4);
  if (n < 1) return { r: 0, g: 0, b: 0, a: 0, luma: 0 };
  const isFloat = data instanceof Float32Array;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    r += data[o];
    g += data[o + 1];
    b += data[o + 2];
    a += data[o + 3];
  }
  const scale = isFloat ? n : n * 255;
  r /= scale;
  g /= scale;
  b /= scale;
  a /= scale;
  return {
    r,
    g,
    b,
    a,
    luma: 0.2126 * r + 0.7152 * g + 0.0722 * b,
  };
}

/** Convertit un buffer RGBA (byte ou float 0–1) en Uint8 pour canvas / blob. */
export function rgbaToUint8(
  data: Uint8Array | Float32Array,
): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
  }
  return out;
}

export class ShaderCompileError extends Error {
  constructor(
    message: string,
    public readonly pass: ShaderPassId | "vertex" | "link",
    public readonly infoLog: string,
  ) {
    super(message);
    this.name = "ShaderCompileError";
  }
}
