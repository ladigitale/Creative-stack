import { num } from "../../shared/media/control";
import type {
  SonicWebGpuBackendPrefer,
  SonicWebGpuState,
  WebGpuErrorItem,
} from "./types";
import { WebGpuCompileError } from "./types";

export const WEBGPU_STATE_KEYS = [
  "status",
  "error",
  "errors",
  "activeBackend",
  "backendLog",
  "notice",
  "playing",
] as const;

export const WEBGPU_IDLE: SonicWebGpuState = {
  status: "idle",
  error: null,
  errors: [],
  activeBackend: null,
  backendLog: [],
  notice: null,
  playing: false,
};

/** Taille maximale acceptée pour un corps WGSL reçu par DataProvider (caractères). */
export const MAX_WGSL_CHARS = 200_000;

/** Réglages en direct lus dans le DP `params` (prioritaires sur les attributs). */
export type WebGpuLiveParams = {
  play?: boolean;
  mouse?: boolean;
  backend?: SonicWebGpuBackendPrefer;
  dprMax?: number;
  shader?: string;
};

function flag(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v !== 0;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/**
 * Lit le DP `params` : `{ play, mouse, backend, dprMax, shader }`. Valeurs bornées ; une valeur
 * invalide est ignorée (l'attribut reste en vigueur) et listée dans `invalid`.
 */
export function readWebGpuParams(v: unknown): { live: WebGpuLiveParams; invalid: string[] } {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const live: WebGpuLiveParams = {};
  const invalid: string[] = [];
  const has = (k: string) => p[k] !== undefined && p[k] !== null;
  for (const k of ["play", "mouse"] as const) {
    if (!has(k)) continue;
    const b = flag(p[k]);
    if (b === undefined) invalid.push(k);
    else live[k] = b;
  }
  if (has("backend")) {
    const s = String(p.backend).trim().toLowerCase();
    if (s === "auto" || s === "webgpu" || s === "webgl2") live.backend = s;
    else invalid.push("backend");
  }
  if (has("dprMax")) {
    const n = num(p.dprMax, 0.25, 4);
    if (n === undefined) invalid.push("dprMax");
    else live.dprMax = n;
  }
  if (has("shader")) {
    if (typeof p.shader !== "string" || p.shader.length > MAX_WGSL_CHARS) invalid.push("shader");
    // Vide (champ de saisie pas encore rempli) : l'attribut reste en vigueur.
    else if (p.shader.trim()) live.shader = p.shader;
  }
  return { live, invalid };
}

function where(e: WebGpuErrorItem): string {
  return e.line !== null ? `ligne ${e.line}${e.column !== null ? `:${e.column}` : ""} : ` : "";
}

/** Erreur (compilation WGSL, démarrage, texture) → `{ error, errors }` de l'état. */
export function describeWebGpuError(err: unknown): { error: string; errors: WebGpuErrorItem[] } {
  if (err instanceof WebGpuCompileError) {
    const errors: WebGpuErrorItem[] = err.messages?.length
      ? err.messages.map((m) => ({ ...m }))
      : [{ line: null, column: null, message: err.infoLog || err.message }];
    const text = `${where(errors[0])}${errors[0].message}`;
    return { error: /^WGSL/i.test(text) ? text : `WGSL : ${text}`, errors };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: message, errors: [{ line: null, column: null, message }] };
}
