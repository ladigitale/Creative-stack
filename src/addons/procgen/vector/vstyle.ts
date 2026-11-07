/**
 * Styles vectoriels et résolution des couleurs.
 *
 * Un style vectoriel = une **manière de dessiner** (`ligne-claire`, `flat`, `gravure`, `affiche`, `papier-decoupe`)
 * posée sur une **palette** procgen (jetons OKLCH de `style/style.ts` : `gouache`, `nuit`, `crepuscule`…).
 * Entrées acceptées : `"flat"`, `"flat/nuit"`, `{ vector: "gravure", preset: "brume", hue: 10 }`, ou des jetons 3D
 * (`StyleTokens`, style vectoriel déduit).
 *
 * Couleur finale d'une forme = rôle (ou #hex) → palette → ton (ombre bleutée vers le ciel, lumière chaude vers le
 * soleil, jamais un simple assombrissement) → perspective atmosphérique (vers l'horizon) → réduction de palette
 * (`affiche`).
 */
import { Issues, suggest } from "../core/schema";
import { type LCH, hexToOklch, hexToRgb, mixLch, oklchToHex, rgbToHex } from "../style/color";
import { ROLES, type Role } from "../style/roles";
import { DEFAULT_STYLE, STYLE_PRESETS, type StyleTokens, resolveColors, resolveStyle } from "../style/style";

export const VECTOR_STYLES = ["ligne-claire", "flat", "gravure", "affiche", "papier-decoupe"] as const;
export type VectorStyleName = (typeof VECTOR_STYLES)[number];

export type VectorStyle = {
  name: VectorStyleName;
  tokens: StyleTokens;
  /** Contour principal (px à l'écran, 0 = aucun) ; couleur : encre ou matière assombrie. */
  outline: number;
  outlineColor: "ink" | "darker";
  /** Poids des traits intérieurs (détails) relatif au contour. */
  interior: number;
  /** Force des tons ombre / lumière (0 = aplat unique). */
  tones: number;
  /** Ombres portées en aplat : opacité. */
  shadows: number;
  /** Hachures (gravure) : densité ; trame de points (affiche). */
  hatch: number;
  halftone: number;
  /** Réduction de palette (nombre de couleurs, 0 = palette complète). */
  posterize: number;
  /** Ombre douce entre plans (papier découpé), px. */
  papercut: number;
  /** Perspective atmosphérique (0 … 1) et parallaxe au pan (0 … 1). */
  haze: number;
  parallax: number;
  /** Fond papier (gravure, papier découpé) : grain fin. */
  paper: number;
  /** Lavis : toutes les couleurs tirées vers le papier (gravure aquarellée). */
  wash: number;
};

const BASE: Record<VectorStyleName, Omit<VectorStyle, "name" | "tokens"> & { preset?: Partial<StyleTokens> }> = {
  "ligne-claire": { outline: 1.5, outlineColor: "ink", interior: 0.55, tones: 0.35, shadows: 0.16, hatch: 0, halftone: 0, posterize: 0, papercut: 0, haze: 0.4, parallax: 0.35, paper: 0, wash: 0, preset: { chroma: 1.08 } },
  flat: { outline: 0, outlineColor: "darker", interior: 0.5, tones: 1, shadows: 0.32, hatch: 0, halftone: 0, posterize: 0, papercut: 0, haze: 0.6, parallax: 0.45, paper: 0, wash: 0 },
  gravure: { outline: 1.25, outlineColor: "ink", interior: 0.6, tones: 0.15, shadows: 0.5, hatch: 1, halftone: 0, posterize: 0, papercut: 0, haze: 0.3, parallax: 0.3, paper: 0.6, wash: 0.36, preset: { chroma: 0.5, contrast: 1.0 } },
  affiche: { outline: 0, outlineColor: "darker", interior: 0.4, tones: 1, shadows: 0.5, hatch: 0, halftone: 0.7, posterize: 9, papercut: 0, haze: 0.75, parallax: 0.5, paper: 0.2, wash: 0, preset: { chroma: 1.2, contrast: 1.12 } },
  "papier-decoupe": { outline: 0, outlineColor: "darker", interior: 0.35, tones: 0.55, shadows: 0.12, hatch: 0, halftone: 0, posterize: 0, papercut: 9, haze: 0.55, parallax: 0.6, paper: 0.5, wash: 0.08, preset: { chroma: 0.85 } },
};

/** Style vectoriel par défaut pour un préréglage 3D (quand on reçoit des jetons de `ProcgenView`). */
const FROM_3D: Record<string, VectorStyleName> = { encre: "gravure", papier: "papier-decoupe", bd: "ligne-claire", lowpoly: "flat", pixel: "affiche", neon: "affiche" };

export function resolveVectorStyle(input: unknown, issues?: Issues): VectorStyle {
  let name: VectorStyleName = "flat";
  let tokensIn: unknown = undefined;
  const over: Record<string, unknown> = {};
  if (typeof input === "string") {
    const [a, b] = input.split("/");
    if ((VECTOR_STYLES as readonly string[]).includes(a)) {
      name = a as VectorStyleName;
      tokensIn = b;
    } else if (STYLE_PRESETS[a]) {
      name = FROM_3D[a] ?? "flat";
      tokensIn = a;
    } else issues?.add({ path: "style", code: "unknown", message: `style vectoriel « ${a} » inconnu`, didYouMean: suggest(a, [...VECTOR_STYLES]), hint: VECTOR_STYLES.join(", ") });
  } else if (input && typeof input === "object") {
    const o = { ...(input as Record<string, unknown>) };
    const v = o.vector;
    delete o.vector;
    if (typeof v === "string") {
      if ((VECTOR_STYLES as readonly string[]).includes(v)) name = v as VectorStyleName;
      else issues?.add({ path: "style.vector", code: "unknown", message: `style vectoriel « ${v} » inconnu`, didYouMean: suggest(v, [...VECTOR_STYLES]), hint: VECTOR_STYLES.join(", ") });
    } else if (typeof o.preset === "string") name = FROM_3D[o.preset] ?? "flat";
    for (const k of Object.keys(BASE.flat)) if (k in o && k !== "preset") {
      over[k] = o[k];
      delete o[k];
    }
    // jetons déjà résolus (StyleTokens) ou partiels
    tokensIn = "roles" in o && "palette" in o && "shading" in o ? null : o;
    if (tokensIn === null) {
      const full = o as unknown as StyleTokens;
      return finish(name, full, over);
    }
  }
  const b = BASE[name];
  let tokens: StyleTokens;
  if (typeof tokensIn === "string" && tokensIn) tokens = resolveStyle({ ...(b.preset ?? {}), preset: tokensIn }, issues);
  else if (tokensIn && typeof tokensIn === "object") tokens = resolveStyle({ ...(b.preset ?? {}), ...(tokensIn as Record<string, unknown>) }, issues);
  else tokens = resolveStyle({ ...(b.preset ?? {}) }, issues);
  return finish(name, tokens, over);
}

function finish(name: VectorStyleName, tokens: StyleTokens, over: Record<string, unknown>): VectorStyle {
  const { preset: _p, ...b } = BASE[name];
  const s: VectorStyle = { name, tokens, ...b };
  for (const [k, v] of Object.entries(over)) {
    const n = Number(v);
    if (k === "outlineColor" && (v === "ink" || v === "darker")) s.outlineColor = v;
    else if (Number.isFinite(n) && typeof (s as Record<string, unknown>)[k] === "number") (s as Record<string, unknown>)[k] = n;
  }
  return s;
}

/* ---------------- couleurs ---------------- */

const lin2s = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export type Inks = {
  sky: { top: string; horizon: string; sun: string };
  /** Couleur résolue d'une peinture (rôle ou #hex), ton, profondeur 0..1. */
  color(paint: string, tone?: number, depth?: number, obj?: Record<string, string>): string;
  ink: string;
  paper: string;
  shadow: string;
  night: number;
};

/** Résout les couleurs d'un style vectoriel (mémoïsées). */
export function makeInks(vs: VectorStyle): Inks {
  const c = resolveColors(vs.tokens);
  const toHex = (arr: ArrayLike<number>, i = 0) => rgbToHex([lin2s(arr[i]), lin2s(arr[i + 1]), lin2s(arr[i + 2])]);
  const roleHex: Record<string, string> = {};
  ROLES.forEach((r, i) => (roleHex[r] = toHex(c.roles, i * 3)));
  const sky = { top: toHex(c.skyTop), horizon: toHex(c.skyHorizon), sun: toHex(c.sun) };
  const paperL = hexToOklch(roleHex.paper);
  if (vs.wash > 0) {
    sky.top = oklchToHex(mixLch(hexToOklch(sky.top), paperL, Math.min(1, vs.wash * 1.6)));
    sky.horizon = oklchToHex(mixLch(hexToOklch(sky.horizon), paperL, Math.min(1, vs.wash * 1.6)));
  }
  const skyL = hexToOklch(sky.horizon), sunL = hexToOklch(sky.sun), ambL = hexToOklch(toHex(c.ambientSky));
  const night = vs.tokens.night;
  // palette réduite (affiche) : couleurs clés de la scène
  let poster: LCH[] | null = null;
  if (vs.posterize > 0) {
    const keys: Role[] = ["wall", "roof", "leaf", "grass", "ink", "accent", "paper", "water", "stone", "wood", "skin", "cloth1"];
    const base = [sky.top, sky.horizon, ...keys.slice(0, Math.max(3, vs.posterize)).map((k) => roleHex[k])].map(hexToOklch);
    poster = [];
    for (const p0 of base) {
      const p: LCH = [p0[0], p0[1] * 1.35, p0[2]];
      poster.push(p);
      poster.push([p[0] - 0.16, p[1] * 0.9, mixHue(p[2], ambL[2], 0.3)]);
    }
  }
  const cache = new Map<string, string>();
  const ink = roleHex.ink;
  const shadowHex = oklchToHex([Math.max(0.12, ambL[0] * 0.45), Math.min(0.08, ambL[1] + 0.03), ambL[2]]);
  const SPECIAL: Record<string, string> = { sun: sky.sun, horizon: sky.horizon, skytop: sky.top, shadow: shadowHex };
  const self: Inks = {
    sky,
    ink,
    paper: roleHex.paper,
    shadow: shadowHex,
    night,
    color(paint, tone = 0, depth = 0, obj) {
      if (!paint || paint === "none") return "none";
      const key = `${paint}|${tone}|${Math.round(depth * 20)}|${obj ? obj[paint] ?? "" : ""}`;
      const hit = cache.get(key);
      if (hit) return hit;
      let hex = obj?.[paint] ?? (paint[0] === "#" ? paint : SPECIAL[paint] ?? roleHex[paint] ?? roleHex.accent);
      let lch = hexToOklch(hex);
      const tn = tone * vs.tones;
      if (tn < 0) {
        // ombre : plus sombre, teinte tirée vers l'ambiance du ciel, chroma légèrement relevée sur les tons chauds
        const k = -tn;
        lch = [lch[0] - 0.1 * k, lch[1] * (1 - 0.1 * k) + 0.008 * k, mixHue(lch[2], ambL[2], 0.12 * k)];
      } else if (tn > 0) lch = [lch[0] + 0.06 * tn, lch[1] * (1 + 0.05 * tn), mixHue(lch[2], sunL[2], 0.15 * tn)];
      if (depth > 0 && vs.haze > 0) lch = mixLch(lch, skyL, Math.min(0.85, vs.haze * depth ** 1.15 * 0.8));
      if (vs.wash > 0 && paint !== "ink") lch = mixLch(lch, paperL, vs.wash);
      if (poster) {
        let best = poster[0], bd = Infinity;
        for (const p of poster) {
          const dh = Math.abs(((p[2] - lch[2] + 540) % 360) - 180) / 180;
          const d = (p[0] - lch[0]) ** 2 * 4 + (p[1] - lch[1]) ** 2 * 6 + dh * dh * Math.min(p[1], lch[1]) * 8;
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        lch = best;
      }
      hex = oklchToHex([Math.max(0.03, Math.min(0.99, lch[0])), Math.max(0, lch[1]), lch[2]]);
      cache.set(key, hex);
      return hex;
    },
  };
  return self;
}

function mixHue(a: number, b: number, t: number) {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (a + d * t + 360) % 360;
}

/** Couleurs propres d'un personnage (asset.colors) passées par la palette (nuit, chroma). */
export function objectInks(vs: VectorStyle, colors: Partial<Record<Role, string>> | undefined): Record<string, string> | undefined {
  if (!colors) return undefined;
  const c = resolveColors(vs.tokens, colors);
  const out: Record<string, string> = {};
  for (const k of Object.keys(colors)) {
    const i = ROLES.indexOf(k as Role);
    if (i >= 0) out[k] = rgbToHex([lin2s(c.roles[i * 3]), lin2s(c.roles[i * 3 + 1]), lin2s(c.roles[i * 3 + 2])]);
  }
  return out;
}

export { DEFAULT_STYLE, hexToRgb };
