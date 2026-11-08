import { num } from "../../shared/media/control";
import type { ShaderErrorItem } from "./errors";
import {
  parseBufferFormat,
  type ShaderBufferFormat,
  type ShaderMouseMode,
  type ShaderPassId,
} from "./types";

/**
 * État publié par `sonic-shader` dans son DP de sortie (à côté de `time`, `frame`, `mouseX`…).
 * - `idle` : pas de programme (pas de source `image`, pas encore monté, hors écran avec
 *   `release-offscreen`, contexte WebGL perdu) ;
 * - `compiling` : compilation en cours ;
 * - `ready` : toutes les passes compilées, rendu actif ;
 * - `error` : compilation, édition de liens ou WebGL indisponible (`error`, `errors`).
 */
export type SonicShaderState = {
  status: "idle" | "compiling" | "ready" | "error";
  /** Premier message, lisible (`image, ligne 12 : 'foo' : undeclared identifier`), sinon `null`. */
  error: string | null;
  /** Détail : une entrée par erreur, passe et ligne de la source de l'utilisateur. */
  errors: ShaderErrorItem[];
  /** Passes compilées, dans l'ordre de rendu (vide hors `ready`). */
  passes: ShaderPassId[];
  /** Format réellement utilisé pour les buffers A–D (après repli éventuel). */
  activeBufferFormat: ShaderBufferFormat;
  /** Vrai si la boucle d'animation tourne (`play`, visibilité, survol, mouvement réduit). */
  playing: boolean;
};

export const SHADER_STATE_KEYS = [
  "status",
  "error",
  "errors",
  "passes",
  "activeBufferFormat",
  "playing",
] as const;

export const SHADER_IDLE: SonicShaderState = {
  status: "idle",
  error: null,
  errors: [],
  passes: [],
  activeBufferFormat: "rgba8",
  playing: false,
};

/** Sources GLSL pilotables par `params` (recompilation). */
export const SOURCE_KEYS = ["image", "bufferA", "bufferB", "bufferC", "bufferD", "common"] as const;
export type ShaderSourceKey = (typeof SOURCE_KEYS)[number];

/** Taille maximale acceptée pour une source reçue par DataProvider (caractères). */
export const MAX_SOURCE_CHARS = 200_000;

/** Réglages en direct lus dans le DP `params` (prioritaires sur les attributs). */
export type ShaderLiveParams = Partial<Record<ShaderSourceKey, string>> & {
  play?: boolean;
  playOnHover?: boolean;
  mouse?: boolean;
  mouseMode?: ShaderMouseMode;
  mouseSpeed?: number;
  hoverSpeed?: number;
  dprMax?: number;
  bufferFormat?: ShaderBufferFormat;
};

/** Booléen tolérant : `true/false`, `1/0`, `"true"/"false"`. Sinon `undefined`. */
export function flag(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v !== 0;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/**
 * Lit le DP `params` : `{ play, playOnHover, mouse, mouseMode, mouseSpeed, hoverSpeed, dprMax,
 * image, bufferA…bufferD, common, bufferFormat }`. Les valeurs sont bornées ; les valeurs invalides
 * sont ignorées (l'attribut reste en vigueur) et listées dans `invalid`.
 */
export function readShaderParams(v: unknown): { live: ShaderLiveParams; invalid: string[] } {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const live: ShaderLiveParams = {};
  const invalid: string[] = [];
  const has = (k: string) => p[k] !== undefined && p[k] !== null;

  for (const k of ["play", "playOnHover", "mouse"] as const) {
    if (!has(k)) continue;
    const b = flag(p[k]);
    if (b === undefined) invalid.push(k);
    else live[k] = b;
  }
  if (has("mouseMode")) {
    if (p.mouseMode === "direct" || p.mouseMode === "target") live.mouseMode = p.mouseMode;
    else invalid.push("mouseMode");
  }
  const ranges = { mouseSpeed: [0, 100], hoverSpeed: [0, 100], dprMax: [0.25, 4] } as const;
  for (const k of Object.keys(ranges) as (keyof typeof ranges)[]) {
    if (!has(k)) continue;
    const n = num(p[k], ranges[k][0], ranges[k][1]);
    if (n === undefined) invalid.push(k);
    else live[k] = n;
  }
  if (has("bufferFormat")) {
    const raw = String(p.bufferFormat).trim().toLowerCase();
    const fmt = parseBufferFormat(raw);
    // parseBufferFormat replie tout inconnu sur rgba8 : n'accepter que les valeurs reconnues.
    if (fmt !== "rgba8" || raw === "rgba8" || raw === "") live.bufferFormat = fmt;
    else invalid.push("bufferFormat");
  }
  for (const k of SOURCE_KEYS) {
    if (!has(k)) continue;
    const s = p[k];
    if (typeof s !== "string" || s.length > MAX_SOURCE_CHARS) invalid.push(k);
    // `image` vide (champ de saisie pas encore rempli) : l'attribut reste en vigueur.
    // Une passe buffer / `common` vide, elle, retire la passe.
    else if (k === "image" && !s.trim()) continue;
    else live[k] = s;
  }
  return { live, invalid };
}
