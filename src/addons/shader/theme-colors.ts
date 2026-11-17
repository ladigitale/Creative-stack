/**
 * Couleurs du thème pour `sonic-shader colors="--sc-base-50 --sc-accent #ff0080"` :
 * chaque entrée (jeton CSS `--…` ou couleur littérale) devient `uColor0`…`uColor7` (vec4 RGBA 0..1, sRGB).
 */

export const MAX_SHADER_COLORS = 8;

/** Entrées de l'attribut : séparées par espaces ou virgules, hors parenthèses (`rgb(1, 2, 3)` reste entier). */
export function parseColorList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(value ?? "")) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, MAX_SHADER_COLORS);
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function channel(raw: string, max: number): number {
  const s = raw.trim();
  if (s.endsWith("%")) return clamp01(parseFloat(s) / 100);
  return clamp01(parseFloat(s) / max);
}

/**
 * Couleur CSS résolue → RGBA 0..1. Formats rendus par `getComputedStyle` : `rgb()` / `rgba()`
 * (virgules ou espaces, alpha après `/`), `color(srgb r g b / a)`, et `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`.
 * `null` si le format n'est pas reconnu (l'appelant tente alors un canvas).
 */
export function parseCssColor(input: string): [number, number, number, number] | null {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  const fn = /^(rgba?|color)\((.*)\)$/.exec(s);
  if (!fn) return null;
  let body = fn[2].trim();
  let alpha = 1;
  const slash = body.split("/");
  if (slash.length === 2) {
    body = slash[0];
    alpha = channel(slash[1], 1);
  }
  if (fn[1] === "color") {
    const parts = body.trim().split(/\s+/);
    if (parts[0] !== "srgb" || parts.length < 4) return null;
    return [channel(parts[1], 1), channel(parts[2], 1), channel(parts[3], 1), alpha];
  }
  const parts = body.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  if (parts.length >= 4 && slash.length === 1) alpha = channel(parts[3], 1);
  return [channel(parts[0], 255), channel(parts[1], 255), channel(parts[2], 255), alpha];
}

let ctx2d: CanvasRenderingContext2D | null | undefined;

/** Repli pour les formats que `parseCssColor` ne lit pas (oklch, lab…) : le navigateur convertit. */
function viaCanvas(color: string): [number, number, number, number] | null {
  if (ctx2d === undefined) {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      ctx2d = c.getContext("2d", { willReadFrequently: true });
    } catch {
      ctx2d = null;
    }
  }
  if (!ctx2d) return null;
  ctx2d.clearRect(0, 0, 1, 1);
  ctx2d.fillStyle = "#000";
  ctx2d.fillStyle = color;
  ctx2d.fillRect(0, 0, 1, 1);
  const d = ctx2d.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
}

/**
 * Résout les entrées dans le contexte de `probe` (un élément du composant : il hérite des
 * jetons du thème là où le shader est posé). Retourne 8 × RGBA à plat et une signature.
 */
export function resolveColors(entries: string[], probe: HTMLElement): { values: Float32Array; sig: string } {
  const values = new Float32Array(MAX_SHADER_COLORS * 4);
  const seen: string[] = [];
  entries.forEach((entry, i) => {
    probe.style.color = "";
    probe.style.color = entry.startsWith("--") ? `var(${entry})` : entry;
    const computed = getComputedStyle(probe).color;
    seen.push(computed);
    const rgba = parseCssColor(computed) ?? viaCanvas(computed) ?? [0, 0, 0, 1];
    values.set(rgba, i * 4);
  });
  return { values, sig: seen.join("|") };
}
