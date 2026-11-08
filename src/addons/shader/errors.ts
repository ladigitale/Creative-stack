import { GLSL_VERSION_300, SHADERTOY_FRAGMENT_BODY } from "./shadertoy-prelude";
import { ShaderCompileError, type ShaderPassError, type ShaderPassId } from "./types";

/** Une erreur lisible, rattachée à la source qui la contient. */
export type ShaderErrorItem = {
  /** Source fautive : une passe, `common`, `prelude` (code généré), `vertex`, ou `runtime` (contexte, textures…). */
  pass: ShaderPassId | "common" | "prelude" | "vertex" | "runtime";
  /** Ligne dans la source de l'utilisateur (1 = première ligne), `null` si inconnue. */
  line: number | null;
  /** Colonne quand le pilote la donne, sinon `null`. */
  column: number | null;
  message: string;
};

/** Lignes de code généré avant `common` dans la source fragment complète. */
const PRELUDE_LINES = countNewlines(GLSL_VERSION_300 + SHADERTOY_FRAGMENT_BODY);

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Ramène une ligne de la source fragment complète (`buildFragmentSource`) à la source de
 * l'utilisateur : la passe elle-même, ou `common` si l'erreur y est.
 */
export function mapGlslLine(
  fullLine: number,
  pass: ShaderPassId,
  common: string,
): { pass: ShaderErrorItem["pass"]; line: number } {
  if (fullLine <= PRELUDE_LINES) return { pass: "prelude", line: fullLine };
  const commonLines = common ? countNewlines(common + "\n") : 0;
  const rel = fullLine - PRELUDE_LINES;
  if (rel <= commonLines) return { pass: "common", line: rel };
  return { pass, line: rel - commonLines };
}

const ANGLE_RE = /^\s*(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/i;
const MESA_RE = /^\s*\d+:(\d+)\((\d+)\):\s*(error|warning)\s*:\s*(.*)$/i;
const NOISE_RE = /compilation terminated|compilation errors?\.\s*No code generated/i;

/** Découpe le journal d'un compilateur GLSL (formats ANGLE / Chrome / Firefox et Mesa). */
export function parseGlslInfoLog(
  infoLog: string,
  pass: ShaderPassId,
  common: string,
): ShaderErrorItem[] {
  const out: ShaderErrorItem[] = [];
  for (const raw of String(infoLog ?? "").split(/\r?\n/)) {
    const lineText = raw.trim();
    if (!lineText || NOISE_RE.test(lineText)) continue;
    let full: number | null = null;
    let column: number | null = null;
    let message = lineText;
    const a = ANGLE_RE.exec(lineText);
    const m = a ? null : MESA_RE.exec(lineText);
    if (a) {
      if (/^\s*WARNING/i.test(lineText)) continue;
      full = Number(a[1]);
      message = a[2].trim();
    } else if (m) {
      if (m[3].toLowerCase() === "warning") continue;
      full = Number(m[1]);
      column = Number(m[2]);
      message = m[4].trim();
    }
    if (full !== null && Number.isFinite(full) && full > 0) {
      const at = mapGlslLine(full, pass, common);
      out.push({ pass: at.pass, line: at.line, column, message });
    } else {
      out.push({ pass, line: null, column: null, message });
    }
  }
  if (!out.length) out.push({ pass, line: null, column: null, message: String(infoLog ?? "").trim() || "erreur de compilation" });
  return out;
}

/** Libellé lisible d'une source (pour `error`). */
function label(pass: ShaderErrorItem["pass"]): string {
  switch (pass) {
    case "bufferA": return "buffer A";
    case "bufferB": return "buffer B";
    case "bufferC": return "buffer C";
    case "bufferD": return "buffer D";
    default: return pass;
  }
}

export function formatErrorItem(e: ShaderErrorItem): string {
  if (e.pass === "runtime") return e.message;
  const where = e.line !== null ? `${label(e.pass)}, ligne ${e.line}${e.column !== null ? `:${e.column}` : ""}` : label(e.pass);
  return `${where} : ${e.message}`;
}

/**
 * Erreur levée par le runtime → `{ error, errors }` publiés dans l'état.
 * Une `ShaderCompileError` porte, dans `passErrors`, les erreurs de toutes les passes fautives.
 */
export function describeShaderError(
  err: unknown,
  common: string,
): { error: string; errors: ShaderErrorItem[] } {
  const errors: ShaderErrorItem[] = [];
  if (err instanceof ShaderCompileError) {
    const list: ShaderPassError[] = err.passErrors?.length
      ? err.passErrors
      : [{
          pass: err.pass === "link" ? "image" : err.pass,
          kind: err.pass === "link" ? "link" : /^Compile error/.test(err.message) ? "compile" : "other",
          message: err.message,
          infoLog: err.infoLog,
        }];
    for (const p of list) {
      const text = p.infoLog || p.message;
      if (p.pass === "vertex") {
        errors.push({ pass: "vertex", line: null, column: null, message: text });
      } else if (p.kind === "compile" && p.infoLog) {
        errors.push(...parseGlslInfoLog(p.infoLog, p.pass, common));
      } else if (p.kind === "link") {
        errors.push({ pass: p.pass, line: null, column: null, message: `édition de liens : ${text}` });
      } else {
        errors.push({ pass: p.pass, line: null, column: null, message: text });
      }
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ pass: "runtime", line: null, column: null, message });
  }
  return { error: errors.length ? formatErrorItem(errors[0]) : "erreur", errors };
}
