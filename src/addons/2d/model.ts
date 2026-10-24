/**
 * Partie pure de `sonic-2d` : description des sprites (attributs `sonic-sprite` ou liste en DataProvider),
 * calques et caméra 2.5D (parallaxe), test de toucher. Aucune dépendance à Pixi.
 *
 * Vocabulaire repris de `sonic-body` (shape, w, h, r, points, fill, stroke, line, angle en degrés, hidden) :
 * une même liste de DataProvider peut décrire les corps d'un `sonic-physics` et leurs sprites.
 */

export type SpriteShape = "box" | "circle" | "polygon" | "text" | "image";

export type SpriteSpec = {
  name: string;
  shape: SpriteShape;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  points: [number, number][];
  /** Coins arrondis d'une box. */
  radius: number;
  fill: string;
  stroke: string;
  line: number;
  /** Texte d'un sprite `text`. */
  text: string;
  fontSize: number;
  font: string;
  /** Image d'un sprite `image` : `data:image/…` ou `https://…`. */
  src: string;
  angle: number;
  opacity: number;
  layer: string;
  z: number;
  hidden: boolean;
};

export const SHAPES: SpriteShape[] = ["box", "circle", "polygon", "text", "image"];
export const MAX_SPRITES = 500;

const num = (v: unknown, d: number): number => {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: unknown): boolean => v === true || v === "" || v === "true" || v === 1 || v === "1";
const pair = (v: unknown): [number, number] | null => {
  if (Array.isArray(v) && v.length >= 2) return [num(v[0], 0), num(v[1], 0)];
  if (typeof v === "string" && v.trim()) {
    const p = v.trim().split(/[\s,]+/).map(Number);
    if (p.length >= 2 && p.every(Number.isFinite)) return [p[0], p[1]];
  }
  return null;
};
const points = (v: unknown): [number, number][] => {
  if (Array.isArray(v)) return v.map((p) => pair(p)).filter((p): p is [number, number] => !!p);
  if (typeof v !== "string") return [];
  return v
    .trim()
    .split(/\s+/)
    .map((p) => pair(p.replace(/,/g, " ")))
    .filter((p): p is [number, number] => !!p);
};
const norm = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[-_]/g, ""), v]));

/** Image autorisée : `data:image/…` ou `https://…` (pas de script, pas de `javascript:`). */
export function safeImageSrc(v: unknown): string {
  const s = String(v ?? "").trim();
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return "";
}

export function parseSprite(raw: Record<string, unknown>, fallbackName: string): { spec: SpriteSpec; errors: string[] } {
  const o = norm(raw);
  const errors: string[] = [];
  const name = String(o.name ?? o.id ?? "").trim() || fallbackName;
  const shapeRaw = String(o.shape ?? (o.src !== undefined ? "image" : o.text !== undefined ? "text" : o.r !== undefined ? "circle" : "box"));
  const shape = (SHAPES.includes(shapeRaw as SpriteShape) ? shapeRaw : "box") as SpriteShape;
  if (shapeRaw !== shape) errors.push(`${name} : forme "${shapeRaw}" inconnue (${SHAPES.join(", ")})`);
  const pts = points(o.points);
  if (shape === "polygon" && pts.length < 3) errors.push(`${name} : un polygon demande au moins 3 points`);
  const src = safeImageSrc(o.src);
  if (shape === "image" && !src) errors.push(`${name} : src doit être une image data:image/… ou une URL https://`);
  return {
    spec: {
      name,
      shape,
      x: num(o.x, 0),
      y: num(o.y, 0),
      w: Math.max(0.5, num(o.w, 40)),
      h: Math.max(0.5, num(o.h, 40)),
      r: Math.max(0.5, num(o.r, 20)),
      points: pts,
      radius: Math.max(0, num(o.radius, 0)),
      fill: String(o.fill ?? (shape === "text" ? "#ffffff" : "")),
      stroke: String(o.stroke ?? ""),
      line: Math.max(0, num(o.line, 1.5)),
      text: String(o.text ?? o.label ?? ""),
      fontSize: Math.max(4, num(o.fontsize, 24)),
      font: String(o.font ?? "system-ui, sans-serif"),
      src,
      angle: num(o.angle, 0),
      opacity: Math.max(0, Math.min(1, num(o.opacity, 1))),
      layer: String(o.layer ?? "").trim(),
      z: num(o.z, 0),
      hidden: bool(o.hidden),
    },
    errors,
  };
}

/** Clé de l'apparence : un changement recrée le dessin, pas la position (comme un corps physique). */
export function visualKey(s: SpriteSpec): string {
  const { name: _n, x: _x, y: _y, angle: _a, ...visual } = s;
  void _n;
  void _x;
  void _y;
  void _a;
  return JSON.stringify(visual);
}

/* ------------------------------------------------------------------ calques et caméra */

export type Layer = {
  name: string;
  /** 1 : suit la caméra (le monde) ; 0 : fixe à l'écran (interface) ; entre les deux : parallaxe (décor lointain). */
  parallax: number;
  /** Tri par y (vue de 3/4, isométrique) : plus bas = devant. */
  sortY: boolean;
};

export const DEFAULT_LAYER = "monde";

/** `"ciel:0 montagnes:0.3 monde:1:y hud:0"` → calques du fond vers l'avant. Vide : un seul calque `monde`. */
export function parseLayers(v: string): { layers: Layer[]; errors: string[] } {
  const errors: string[] = [];
  const layers: Layer[] = [];
  for (const tok of v.trim().split(/\s+/).filter(Boolean)) {
    const [name, p, flag] = tok.split(":");
    if (!name || layers.some((l) => l.name === name)) {
      errors.push(`calque "${tok}" ignoré (nom vide ou en double)`);
      continue;
    }
    const parallax = p === undefined || p === "" ? 1 : Number(p);
    if (!Number.isFinite(parallax)) errors.push(`calque ${name} : parallaxe "${p}" invalide`);
    layers.push({ name, parallax: Number.isFinite(parallax) ? Math.max(0, parallax) : 1, sortY: flag === "y" });
  }
  if (!layers.length) layers.push({ name: DEFAULT_LAYER, parallax: 1, sortY: false });
  return { layers, errors };
}

export type Camera = { x: number; y: number; zoom: number };

/** Caméra par défaut : centre de la scène, zoom 1. */
export const defaultCamera = (w: number, h: number): Camera => ({ x: w / 2, y: h / 2, zoom: 1 });

export function readCamera(v: unknown, base: Camera): Camera {
  if (!v || typeof v !== "object") return base;
  const o = v as Record<string, unknown>;
  return { x: num(o.x, base.x), y: num(o.y, base.y), zoom: Math.max(0.05, num(o.zoom, base.zoom)) };
}

/**
 * Transformation d'un calque : écran = position + échelle × monde.
 * Parallaxe p : le calque suit la caméra à p près, et son zoom vaut 1 + (zoom - 1) × p.
 */
export function layerTransform(p: number, cam: Camera, w: number, h: number): { x: number; y: number; scale: number } {
  const cx = w / 2;
  const cy = h / 2;
  const scale = 1 + (cam.zoom - 1) * p;
  const ox = cx + p * (cam.x - cx);
  const oy = cy + p * (cam.y - cy);
  return { x: cx - scale * ox, y: cy - scale * oy, scale };
}

/** Point de l'écran (unités de scène) → point du calque. */
export function screenToLayer(sx: number, sy: number, p: number, cam: Camera, w: number, h: number): [number, number] {
  const t = layerTransform(p, cam, w, h);
  return [(sx - t.x) / t.scale, (sy - t.y) / t.scale];
}

/** Le point local (repère du sprite, centré) est-il dans sa forme ? */
export function hitShape(s: SpriteSpec, lx: number, ly: number, textSize?: [number, number]): boolean {
  switch (s.shape) {
    case "circle":
      return lx * lx + ly * ly <= s.r * s.r;
    case "polygon": {
      let inside = false;
      const p = s.points;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const [xi, yi] = p[i];
        const [xj, yj] = p[j];
        if (yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    case "text": {
      const [tw, th] = textSize ?? [s.w, s.h];
      return Math.abs(lx) <= tw / 2 && Math.abs(ly) <= th / 2;
    }
    default:
      return Math.abs(lx) <= s.w / 2 && Math.abs(ly) <= s.h / 2;
  }
}
