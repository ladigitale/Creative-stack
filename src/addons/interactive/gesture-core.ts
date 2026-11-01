/**
 * Suivi de gestes multipoints, sans DOM (testable) : `sonic-gesture` lui passe les pointeurs
 * (coordonnées en px relatives à la zone) et dispatche les actions renvoyées.
 *
 * Compatibilité : tap, double-tap, long-press, swipe-*, drag (déplacement cumulé en fraction de
 * la zone) gardent leur sens. Nouveau, à la demande : pan (delta en px), pinch (échelle et
 * rotation à deux doigts), drag-end / pan-end, position {x, y, u, v} sur tap / double-tap / long-press.
 */

export type GesturePoint = { id: number; x: number; y: number; t: number };

export type GestureOptions = {
  swipeThreshold: number;
  longPressMs: number;
  doubleTapMs: number;
  /** Ancien mode : `drag` {dx, dy} cumulés en fraction de la zone (1 doigt), + `drag-end`. */
  drag: boolean;
  /** `pan` {dx, dy} en px depuis l'événement précédent (centre des doigts), + `pan-end`. Supprime les swipes. */
  pan: boolean;
  /** `pinch-start` / `pinch` {scale, dScale, rotation, dRotation, cx, cy} / `pinch-end` à deux doigts. */
  pinch: boolean;
  width: number;
  height: number;
};

export type GestureAction = { type: string; payload?: Record<string, unknown> };

/** Distance au-delà de laquelle un appui n'est plus un tap ni un appui long (px). */
export const MOVE_TOLERANCE_PX = 10;

type Tracked = { x: number; y: number };

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export class GestureTracker {
  private pointers = new Map<number, Tracked>();
  private start = { x: 0, y: 0, t: 0 };
  private lastCentroid = { x: 0, y: 0 };
  private total = { dx: 0, dy: 0 };
  private multi = false;
  private moved = false;
  private longFired = false;
  private panned = false;
  private lastTap = -Infinity;
  private base: { d: number; a: number; scale: number; rotation: number } | null = null;
  /** Échelle et rotation cumulées depuis le début du geste (1 et 0 au repos). */
  scale = 1;
  rotation = 0;

  get size(): number {
    return this.pointers.size;
  }

  get active(): boolean {
    return this.pointers.size > 0;
  }

  /** Vrai tant qu'un appui long peut encore se déclencher (un seul doigt, immobile). */
  canLongPress(): boolean {
    return this.pointers.size === 1 && !this.multi && !this.moved && !this.longFired;
  }

  /** Appelé par le minuteur d'appui long. */
  longPress(o: GestureOptions): GestureAction[] {
    if (!this.canLongPress()) return [];
    this.longFired = true;
    return [{ type: "long-press", payload: this.position(this.start.x, this.start.y, o) }];
  }

  /** Position publique : px dans la zone et fraction (u, v). */
  position(x: number, y: number, o: GestureOptions): Record<string, number> {
    return {
      x: round(x),
      y: round(y),
      u: round(o.width ? x / o.width : 0, 4),
      v: round(o.height ? y / o.height : 0, 4),
    };
  }

  private centroid(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const p of this.pointers.values()) {
      x += p.x;
      y += p.y;
    }
    const n = this.pointers.size || 1;
    return { x: x / n, y: y / n };
  }

  private pair(): { d: number; a: number } | null {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return null;
    return { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  private rebase(): void {
    const p = this.pair();
    this.base = p && p.d > 0 ? { d: p.d, a: p.a, scale: this.scale, rotation: this.rotation } : null;
  }

  down(p: GesturePoint, o: GestureOptions): GestureAction[] {
    if (this.pointers.has(p.id)) return [];
    this.pointers.set(p.id, { x: p.x, y: p.y });
    const out: GestureAction[] = [];
    if (this.pointers.size === 1) {
      this.start = { x: p.x, y: p.y, t: p.t };
      this.multi = false;
      this.moved = false;
      this.longFired = false;
      this.scale = 1;
      this.rotation = 0;
      this.total = { dx: 0, dy: 0 };
      this.base = null;
      this.panned = false;
    } else {
      this.multi = true;
      if (o.pinch && this.pointers.size === 2) {
        this.rebase();
        const c = this.centroid();
        out.push({ type: "pinch-start", payload: { cx: round(c.x), cy: round(c.y) } });
      }
    }
    this.lastCentroid = this.centroid();
    return out;
  }

  move(p: GesturePoint, o: GestureOptions): GestureAction[] {
    const tracked = this.pointers.get(p.id);
    if (!tracked) return [];
    tracked.x = p.x;
    tracked.y = p.y;
    const out: GestureAction[] = [];
    const c = this.centroid();

    if (o.pinch && this.pointers.size >= 2 && this.base) {
      const pair = this.pair();
      if (pair && pair.d > 0) {
        const scale = this.base.scale * (pair.d / this.base.d);
        const rotation = this.base.rotation + normalizeAngle(pair.a - this.base.a);
        const dScale = scale / this.scale;
        const dRotation = rotation - this.rotation;
        this.scale = scale;
        this.rotation = rotation;
        if (dScale !== 1 || dRotation !== 0) {
          out.push({
            type: "pinch",
            payload: { scale: round(scale, 4), dScale: round(dScale, 5), rotation: round(rotation, 4), dRotation: round(dRotation, 5), cx: round(c.x), cy: round(c.y) },
          });
        }
      }
    }

    const dx = c.x - this.lastCentroid.x;
    const dy = c.y - this.lastCentroid.y;
    this.lastCentroid = c;
    this.total.dx += dx;
    this.total.dy += dy;
    if (Math.hypot(p.x - this.start.x, p.y - this.start.y) > MOVE_TOLERANCE_PX || this.multi) this.moved = true;

    if (o.pan && (dx !== 0 || dy !== 0)) {
      this.panned = true;
      out.push({ type: "pan", payload: { dx: round(dx), dy: round(dy), x: round(c.x), y: round(c.y) } });
    }
    if (o.drag && this.pointers.size === 1 && !this.multi) {
      out.push({
        type: "drag",
        payload: { dx: o.width ? (p.x - this.start.x) / o.width : 0, dy: o.height ? (p.y - this.start.y) / o.height : 0 },
      });
    }
    return out;
  }

  up(p: GesturePoint, o: GestureOptions): GestureAction[] {
    if (!this.pointers.has(p.id)) return [];
    const tracked = this.pointers.get(p.id)!;
    tracked.x = p.x;
    tracked.y = p.y;
    this.pointers.delete(p.id);
    const out: GestureAction[] = [];

    if (this.base && this.pointers.size < 2) {
      out.push({ type: "pinch-end", payload: { scale: round(this.scale, 4), rotation: round(this.rotation, 4) } });
      this.base = null;
    } else if (o.pinch && this.pointers.size >= 2) {
      this.rebase();
    }
    if (this.pointers.size > 0) {
      // Évite un saut de pan quand un doigt se lève.
      this.lastCentroid = this.centroid();
      return out;
    }

    const dx = p.x - this.start.x;
    const dy = p.y - this.start.y;
    const dist = Math.hypot(dx, dy);
    const dt = Math.max(1, p.t - this.start.t);

    if (o.pan && this.panned) {
      out.push({
        type: "pan-end",
        payload: { dx: round(this.total.dx), dy: round(this.total.dy), vx: round((this.total.dx / dt) * 1000), vy: round((this.total.dy / dt) * 1000) },
      });
    }
    if (o.drag && !this.multi && this.moved) {
      out.push({
        type: "drag-end",
        payload: { dx: o.width ? dx / o.width : 0, dy: o.height ? dy / o.height : 0, ...this.position(p.x, p.y, o) },
      });
    }
    if (this.multi || this.longFired) return out;

    if (dist >= o.swipeThreshold) {
      if (!o.pan) {
        const type = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "swipe-right" : "swipe-left") : dy > 0 ? "swipe-down" : "swipe-up";
        out.push({ type });
      }
      return out;
    }
    if (dt < o.longPressMs) {
      const pos = this.position(this.start.x, this.start.y, o);
      if (p.t - this.lastTap < o.doubleTapMs) {
        out.push({ type: "double-tap", payload: pos });
        this.lastTap = -Infinity;
      } else {
        out.push({ type: "tap", payload: pos });
        this.lastTap = p.t;
      }
    }
    return out;
  }

  /** Molette (souris, pavé tactile) : même action `pinch`, source "wheel". */
  wheel(deltaY: number, x: number, y: number): GestureAction {
    const dScale = Math.exp(-deltaY * 0.0015);
    this.scale *= dScale;
    return { type: "pinch", payload: { source: "wheel", scale: round(this.scale, 4), dScale: round(dScale, 5), rotation: round(this.rotation, 4), dRotation: 0, cx: round(x), cy: round(y) } };
  }

  /** Annule tout (pointercancel, déconnexion). */
  cancel(): GestureAction[] {
    const out: GestureAction[] = [];
    if (this.base) out.push({ type: "pinch-end", payload: { scale: round(this.scale, 4), rotation: round(this.rotation, 4) } });
    this.pointers.clear();
    this.base = null;
    return out;
  }

  /** État publié dans `state-provider`. */
  state(): Record<string, unknown> {
    const c = this.centroid();
    return {
      active: this.active,
      pointers: this.pointers.size,
      scale: round(this.scale, 4),
      rotation: round(this.rotation, 4),
      panX: round(this.total.dx),
      panY: round(this.total.dy),
      x: round(c.x),
      y: round(c.y),
    };
  }
}

/** Fusionne les actions continues d'une même image (pan : somme ; pinch : produit ; drag : dernière). */
export function coalesce(actions: GestureAction[]): GestureAction[] {
  const out: GestureAction[] = [];
  for (const a of actions) {
    const prev = out[out.length - 1];
    if (prev && prev.type === a.type && a.payload && prev.payload) {
      if (a.type === "pan") {
        prev.payload = { ...a.payload, dx: round(Number(prev.payload.dx) + Number(a.payload.dx)), dy: round(Number(prev.payload.dy) + Number(a.payload.dy)) };
        continue;
      }
      if (a.type === "pinch") {
        prev.payload = {
          ...a.payload,
          dScale: round(Number(prev.payload.dScale) * Number(a.payload.dScale), 5),
          dRotation: round(Number(prev.payload.dRotation) + Number(a.payload.dRotation), 5),
        };
        continue;
      }
      if (a.type === "drag") {
        prev.payload = a.payload;
        continue;
      }
    }
    out.push({ ...a, payload: a.payload ? { ...a.payload } : undefined });
  }
  return out;
}

/** Types émis à chaque mouvement : regroupés par image avant dispatch. */
export const CONTINUOUS = new Set(["pan", "pinch", "drag"]);
