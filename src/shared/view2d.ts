/**
 * Vue 2D commune aux toiles navigables (`sonic-sketch`, `sonic-paint navigable`) : centre du monde, zoom et
 * rotation, et les gestes qui la font bouger (molette, glisser, deux doigts avec rotation, clavier).
 * Mêmes formules et mêmes gestes partout : passer d'une toile à l'autre ne change pas la prise en main.
 */

export type View2D = {
  /** Point du monde au centre de l'écran. */
  x: number;
  y: number;
  /** Pixels d'écran par unité du monde. */
  zoom: number;
  /** Rotation de la vue en radians (sens horaire à l'écran, y vers le bas). */
  rotation: number;
};

/** Matrice affine écran ← monde : `[a, b, c, d, e, f]` (même ordre que `ctx.setTransform`). */
export type Affine = [number, number, number, number, number, number];

export const ROTATE_STEP = Math.PI / 12;

/** Angle ramené dans ]-π, π]. */
export function normAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  const t = 2 * Math.PI;
  let r = a % t;
  if (r <= -Math.PI) r += t;
  if (r > Math.PI) r -= t;
  return r;
}

export function clampZoomTo(z: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(z) ? z : 1));
}

/** Lit une vue `{ x, y, zoom, rotation }` (champs absents ou invalides : ceux de `base`). */
export function sanitizeView2D(v: unknown, base: View2D, min: number, max: number): View2D {
  if (!v || typeof v !== "object") return { ...base };
  const o = v as Record<string, unknown>;
  const n = (k: string, d: number) => (o[k] !== "" && o[k] !== null && o[k] !== undefined && Number.isFinite(Number(o[k])) ? Number(o[k]) : d);
  return { x: n("x", base.x), y: n("y", base.y), zoom: clampZoomTo(n("zoom", base.zoom), min, max), rotation: normAngle(n("rotation", base.rotation)) };
}

/** Écran (px, origine en haut à gauche de la zone w × h) → monde. */
export function screenToWorld(v: View2D, sx: number, sy: number, w: number, h: number): [number, number] {
  const dx = sx - w / 2, dy = sy - h / 2;
  const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
  return [v.x + (dx * c + dy * s) / v.zoom, v.y + (-dx * s + dy * c) / v.zoom];
}

export function worldToScreen(v: View2D, wx: number, wy: number, w: number, h: number): [number, number] {
  const dx = (wx - v.x) * v.zoom, dy = (wy - v.y) * v.zoom;
  const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
  return [w / 2 + dx * c - dy * s, h / 2 + dx * s + dy * c];
}

/** Matrice écran ← monde pour `ctx.setTransform(...)`. */
export function viewMatrix(v: View2D, w: number, h: number): Affine {
  const c = Math.cos(v.rotation) * v.zoom, s = Math.sin(v.rotation) * v.zoom;
  return [c, s, -s, c, w / 2 - (c * v.x - s * v.y), h / 2 - (s * v.x + c * v.y)];
}

export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-300;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Rectangle du monde (aligné sur les axes) qui contient tout l'écran, rotation comprise. */
export function visibleBounds(v: View2D, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const pts = [screenToWorld(v, 0, 0, w, h), screenToWorld(v, w, 0, w, h), screenToWorld(v, 0, h, w, h), screenToWorld(v, w, h, w, h)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** Glisse la vue de (dx, dy) pixels d'écran : le contenu suit le doigt. */
export function panView(v: View2D, dx: number, dy: number): View2D {
  const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
  return { ...v, x: v.x - (dx * c + dy * s) / v.zoom, y: v.y - (-dx * s + dy * c) / v.zoom };
}

/** Zoom ×`factor` et rotation de `dAngle` en gardant fixe le point du monde sous (sx, sy). */
export function transformAt(v: View2D, factor: number, dAngle: number, sx: number, sy: number, w: number, h: number, min: number, max: number): View2D {
  const [wx, wy] = screenToWorld(v, sx, sy, w, h);
  const next: View2D = { x: 0, y: 0, zoom: clampZoomTo(v.zoom * factor, min, max), rotation: normAngle(v.rotation + dAngle) };
  const [ox, oy] = screenToWorld(next, sx, sy, w, h);
  return { ...next, x: wx - ox, y: wy - oy };
}

/** Facteur de zoom d'un événement molette (Ctrl + molette et pincement du pavé : plus fort). */
export function wheelFactor(e: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  const k = e.ctrlKey ? 0.01 : 0.0018;
  return Math.exp(-Math.max(-300, Math.min(300, e.deltaY * unit)) * k);
}

/** Cadre une boîte du monde dans l'écran w × h (marge en fraction), rotation conservée. */
export function fitBox(b: { x: number; y: number; w: number; h: number } | null, w: number, h: number, rotation: number, min: number, max: number, margin = 0.08): View2D | null {
  if (!b || (b.w <= 0 && b.h <= 0)) return null;
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  const bw = b.w * c + b.h * s, bh = b.w * s + b.h * c;
  const zw = (w * (1 - 2 * margin)) / Math.max(bw, 1e-12);
  const zh = (h * (1 - 2 * margin)) / Math.max(bh, 1e-12);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2, zoom: clampZoomTo(Math.min(zw, zh), min, max), rotation: normAngle(rotation) };
}

type Pt = { x: number; y: number };
type Pinch = { cx: number; cy: number; d: number; a: number };

/**
 * Gestes de vue partagés : deux doigts (déplacer + zoomer + tourner autour des doigts), glisser pour déplacer
 * (Espace, bouton du milieu ou outil main), molette (zoom sous le curseur), clavier (+ − 0, R / Maj+R).
 * L'hôte garde la main sur le dessin : `down` lui dit si un geste de vue commence.
 */
export class ViewGestures {
  private pointers = new Map<number, Pt>();
  private pinch: Pinch | null = null;
  private panId: number | null = null;
  private panLast: Pt = { x: 0, y: 0 };

  constructor(private readonly host: {
    view(): View2D;
    setView(v: View2D, settled: boolean): void;
    size(): { w: number; h: number };
    zoomRange(): [number, number];
    fit(): void;
  }) {}

  get active(): boolean {
    return this.pinch !== null || this.panId !== null;
  }

  get count(): number {
    return this.pointers.size;
  }

  private pinchOf(): Pinch {
    const [a, b] = [...this.pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), a: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  /** Un pointeur se pose. `pan` : glisser déplace la vue. Retourne `"pinch"` quand un geste à deux doigts commence. */
  down(id: number, p: Pt, pan: boolean): "pinch" | "pan" | "none" {
    this.pointers.set(id, p);
    if (this.pointers.size === 2) {
      this.panId = null;
      this.pinch = this.pinchOf();
      return "pinch";
    }
    if (this.pointers.size === 1 && pan) {
      this.panId = id;
      this.panLast = p;
      return "pan";
    }
    return "none";
  }

  /** Un pointeur bouge. Retourne vrai si c'était un geste de vue (l'hôte ne dessine pas). */
  move(id: number, p: Pt): boolean {
    if (!this.pointers.has(id)) return false;
    this.pointers.set(id, p);
    const { w, h } = this.host.size();
    const [min, max] = this.host.zoomRange();
    if (this.pinch && this.pointers.size >= 2) {
      const g = this.pinchOf();
      let v = panView(this.host.view(), g.cx - this.pinch.cx, g.cy - this.pinch.cy);
      v = transformAt(v, g.d / this.pinch.d, normAngle(g.a - this.pinch.a), g.cx, g.cy, w, h, min, max);
      this.pinch = g;
      this.host.setView(v, false);
      return true;
    }
    if (this.panId === id) {
      this.host.setView(panView(this.host.view(), p.x - this.panLast.x, p.y - this.panLast.y), false);
      this.panLast = p;
      return true;
    }
    return false;
  }

  /** Un pointeur se lève. Retourne vrai s'il faisait partie d'un geste de vue. */
  up(id: number): boolean {
    if (!this.pointers.has(id)) return false;
    this.pointers.delete(id);
    const was = this.pinch !== null || this.panId === id;
    if (this.pinch && this.pointers.size < 2) this.pinch = null;
    if (this.panId === id) this.panId = null;
    if (was && !this.active) this.host.setView(this.host.view(), true);
    return was;
  }

  /** Après un geste à deux doigts, le doigt restant ne dessine pas : vrai tant qu'il reste des doigts d'un geste. */
  holds(id: number): boolean {
    return this.pointers.has(id);
  }

  reset(): void {
    this.pointers.clear();
    this.pinch = null;
    this.panId = null;
  }

  wheel(e: WheelEvent, p: Pt): void {
    const { w, h } = this.host.size();
    const [min, max] = this.host.zoomRange();
    this.host.setView(transformAt(this.host.view(), wheelFactor(e), 0, p.x, p.y, w, h, min, max), false);
  }

  zoomBy(factor: number): void {
    const { w, h } = this.host.size();
    const [min, max] = this.host.zoomRange();
    this.host.setView(transformAt(this.host.view(), factor, 0, w / 2, h / 2, w, h, min, max), true);
  }

  rotateBy(dAngle: number): void {
    const { w, h } = this.host.size();
    const [min, max] = this.host.zoomRange();
    this.host.setView(transformAt(this.host.view(), 1, dAngle, w / 2, h / 2, w, h, min, max), true);
  }

  straighten(): void {
    this.rotateBy(-this.host.view().rotation);
  }

  /** Clavier (toile active) : + − zoom, 0 cadrer, R / Maj+R tourner de 15°. Retourne vrai si la touche est prise. */
  key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === "+" || e.key === "=") this.zoomBy(1.6);
    else if (e.key === "-") this.zoomBy(1 / 1.6);
    else if (e.key === "0") this.host.fit();
    else if (e.key === "r" || e.key === "R") this.rotateBy(e.shiftKey ? -ROTATE_STEP : ROTATE_STEP);
    else return false;
    return true;
  }
}
