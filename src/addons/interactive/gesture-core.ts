/**
 * Suivi de gestes multipoints, sans DOM (testable) : `sonic-gesture` lui passe les pointeurs
 * (coordonnées en px relatives à la zone) et dispatche les actions renvoyées.
 *
 * Compatibilité : tap, double-tap, long-press, swipe-*, drag (déplacement cumulé en fraction de
 * la zone) gardent leur sens. Nouveau, à la demande : pan (delta en px), pinch (échelle et
 * rotation à deux doigts), drag-end / pan-end, position {x, y, u, v} sur tap / double-tap / long-press.
 * `dragEvents` : glisser continu d'un doigt `drag:start` / `drag:move` (au plus `rate` par seconde) / `drag:end`,
 * en px et en fraction bornée (nx, ny), avec vitesse ; les swipes sont alors remplacés par `drag:end`.
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
  /** `drag:start` / `drag:move` / `drag:end` (glisser continu d'un doigt, px + fraction, vitesse). */
  dragEvents?: boolean;
  /** `drag:move` par seconde au plus (1..120, défaut 30). */
  rate?: number;
  width: number;
  height: number;
};

export type GestureAction = { type: string; payload?: Record<string, unknown> };

/** Distance au-delà de laquelle un appui n'est plus un tap ni un appui long (px). */
export const MOVE_TOLERANCE_PX = 10;

type Tracked = { x: number; y: number };

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Point public : px dans la zone (non bornés) et fraction bornée 0..1 (nx, ny). */
export function normPoint(x: number, y: number, width: number, height: number): { x: number; y: number; nx: number; ny: number } {
  return {
    x: round(x),
    y: round(y),
    nx: round(width ? clamp01(x / width) : 0, 4),
    ny: round(height ? clamp01(y / height) : 0, 4),
  };
}

/** Fenêtre de calcul de la vitesse d'un glisser (ms). */
const VELOCITY_WINDOW_MS = 100;

export type DragState = { active: boolean; x: number; y: number; nx: number; ny: number; dx: number; dy: number; vx: number; vy: number };
const IDLE_DRAG: DragState = { active: false, x: 0, y: 0, nx: 0, ny: 0, dx: 0, dy: 0, vx: 0, vy: 0 };

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
  /** Glisser continu (`dragEvents`). */
  private dragging = false;
  private dragDone = false;
  private lastDragMove = -Infinity;
  private pendingDrag: Record<string, unknown> | null = null;
  private samples: Array<{ x: number; y: number; t: number }> = [];
  private dragInfo: DragState = { ...IDLE_DRAG };
  private lastOpts: GestureOptions | null = null;
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
    this.lastOpts = o;
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
      this.dragging = false;
      this.dragDone = false;
      this.pendingDrag = null;
      this.lastDragMove = -Infinity;
      this.samples = [{ x: p.x, y: p.y, t: p.t }];
    } else {
      this.multi = true;
      // Un deuxième doigt interrompt le glisser d'un doigt.
      if (this.dragging) out.push(...this.endDrag(o, true));
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
    this.lastOpts = o;
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
    if (o.dragEvents && this.pointers.size === 1 && !this.multi) out.push(...this.dragMove(p, o));
    return out;
  }

  private velocity(): { vx: number; vy: number } {
    const s = this.samples;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const a = s[0];
    const b = s[s.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: round(((b.x - a.x) / dt) * 1000), vy: round(((b.y - a.y) / dt) * 1000) };
  }

  private sample(p: GesturePoint): void {
    this.samples.push({ x: p.x, y: p.y, t: p.t });
    while (this.samples.length > 2 && p.t - this.samples[0].t > VELOCITY_WINDOW_MS) this.samples.shift();
  }

  private dragPayload(x: number, y: number, o: GestureOptions): Record<string, unknown> {
    const v = this.velocity();
    const pt = normPoint(x, y, o.width, o.height);
    const payload = { ...pt, dx: round(x - this.start.x), dy: round(y - this.start.y), vx: v.vx, vy: v.vy };
    this.dragInfo = { active: this.dragging, ...payload };
    return payload;
  }

  private dragMove(p: GesturePoint, o: GestureOptions): GestureAction[] {
    this.sample(p);
    const out: GestureAction[] = [];
    if (!this.dragging) {
      if (this.dragDone || Math.hypot(p.x - this.start.x, p.y - this.start.y) <= MOVE_TOLERANCE_PX) return out;
      this.dragging = true;
      out.push({ type: "drag:start", payload: normPoint(this.start.x, this.start.y, o.width, o.height) });
    }
    const payload = this.dragPayload(p.x, p.y, o);
    const rate = Math.min(120, Math.max(1, Number(o.rate) || 30));
    if (p.t - this.lastDragMove >= 1000 / rate - 0.5) {
      this.lastDragMove = p.t;
      this.pendingDrag = null;
      out.push({ type: "drag:move", payload });
    } else {
      this.pendingDrag = payload;
    }
    return out;
  }

  /** Termine le glisser : dernier `drag:move` retenu par la cadence, puis `drag:end` (`cancelled` si interrompu). */
  private endDrag(o: GestureOptions, cancelled: boolean, last?: GesturePoint): GestureAction[] {
    if (!this.dragging) return [];
    const out: GestureAction[] = [];
    if (last) {
      this.sample(last);
      const moved = this.dragInfo.x !== round(last.x) || this.dragInfo.y !== round(last.y);
      if (moved) this.pendingDrag = this.dragPayload(last.x, last.y, o);
    }
    if (this.pendingDrag) out.push({ type: "drag:move", payload: this.pendingDrag });
    this.pendingDrag = null;
    this.dragging = false;
    this.dragDone = true;
    const end: Record<string, unknown> = { ...this.dragInfo, start: normPoint(this.start.x, this.start.y, o.width, o.height) };
    delete end.active;
    if (cancelled) end.cancelled = true;
    this.dragInfo = { ...this.dragInfo, active: false };
    out.push({ type: "drag:end", payload: end });
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
    const dragged = this.dragging || this.dragDone;
    if (this.dragging) out.push(...this.endDrag(o, false, p));
    if (this.multi || this.longFired) return out;

    if (dist >= o.swipeThreshold) {
      if (!o.pan && !dragged) {
        const type = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "swipe-right" : "swipe-left") : dy > 0 ? "swipe-down" : "swipe-up";
        const start = normPoint(this.start.x, this.start.y, o.width, o.height);
        out.push({ type, payload: { ...start, dx: round(dx), dy: round(dy), start, end: normPoint(p.x, p.y, o.width, o.height) } });
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
  cancel(o?: GestureOptions): GestureAction[] {
    const out: GestureAction[] = [];
    const opts = o ?? this.lastOpts;
    if (this.dragging && opts) out.push(...this.endDrag(opts, true));
    this.dragging = false;
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
      drag: { ...this.dragInfo },
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
      if (a.type === "drag" || a.type === "drag:move") {
        prev.payload = a.payload;
        continue;
      }
    }
    out.push({ ...a, payload: a.payload ? { ...a.payload } : undefined });
  }
  return out;
}

/** Types émis à chaque mouvement : regroupés par image avant dispatch. */
export const CONTINUOUS = new Set(["pan", "pinch", "drag", "drag:move"]);
