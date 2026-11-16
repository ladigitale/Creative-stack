/**
 * Lecture des gestes de `sonic-procgen` (pure, testable sans DOM) : un pointeur à la fois ou deux doigts.
 *
 * - un doigt (ou bouton gauche) sur le vide : `orbit` (l'hôte choisit tourner ou déplacer selon la caméra) ;
 * - un doigt sur l'objet saisissable (`canDrag` → `"drag"`) : `dragStart` au-delà de 4 px, puis `drag`, `dragEnd` ;
 *   `"refuse"` : `refused` au-delà de 4 px, puis orbite ;
 * - deux doigts : `pan` (déplacement du milieu) et `zoom` (écart), en même temps ; jamais de tap ensuite ;
 * - bouton droit : `pan` ;
 * - tap : moins de 6 px et 400 ms, un seul pointeur du début à la fin.
 */

export const TAP_MAX_MOVE_PX = 6;
export const TAP_MAX_MS = 400;
export const DRAG_START_PX = 4;

export type GestureCmd =
  | { kind: "orbit"; dx: number; dy: number; button: number; shift: boolean }
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "zoom"; amount: number }
  | { kind: "dragStart"; x: number; y: number }
  | { kind: "drag"; x: number; y: number }
  | { kind: "dragEnd"; x: number; y: number }
  | { kind: "dragCancel" }
  | { kind: "refused"; x: number; y: number }
  | { kind: "tap"; x: number; y: number };

type Mode = "idle" | "pending" | "dragPending" | "refusePending" | "drag" | "orbit" | "pan" | "two";

export class Gesture {
  private pts = new Map<number, { x: number; y: number }>();
  private mode: Mode = "idle";
  private main = -1;
  private start = { x: 0, y: 0, t: 0 };
  private moved = 0;
  private multi = false;
  private button = 0;
  private two: { cx: number; cy: number; d: number } | null = null;

  /** Geste en cours (au moins un pointeur posé). */
  get active(): boolean {
    return this.pts.size > 0;
  }
  get dragging(): boolean {
    return this.mode === "drag";
  }

  /** `canDrag` n'est appelé que pour le premier pointeur, bouton gauche. */
  down(id: number, x: number, y: number, button: number, t: number, canDrag: () => "drag" | "refuse" | null): GestureCmd[] {
    this.pts.set(id, { x, y });
    if (this.pts.size === 1) {
      this.main = id;
      this.start = { x, y, t };
      this.moved = 0;
      this.multi = false;
      this.button = button;
      const can = button === 0 ? canDrag() : null;
      this.mode = button === 2 ? "pan" : can === "drag" ? "dragPending" : can === "refuse" ? "refusePending" : "pending";
      return [];
    }
    this.multi = true;
    // un objet déjà en route reste au premier doigt ; sinon deux doigts = vue
    if (this.mode === "drag") return [];
    if (this.pts.size === 2) {
      this.mode = "two";
      this.two = this.pair();
    }
    return [];
  }

  move(id: number, x: number, y: number, shift = false): GestureCmd[] {
    const prev = this.pts.get(id);
    if (!prev) return [];
    this.pts.set(id, { x, y });
    if (this.mode === "two") {
      if (this.pts.size < 2 || !this.two) return [];
      const p = this.pair();
      const out: GestureCmd[] = [];
      const dx = p.cx - this.two.cx, dy = p.cy - this.two.cy;
      if (dx || dy) out.push({ kind: "pan", dx, dy });
      if (p.d !== this.two.d) out.push({ kind: "zoom", amount: (this.two.d - p.d) * 3 });
      this.two = p;
      return out;
    }
    if (id !== this.main) return [];
    const dx = x - prev.x, dy = y - prev.y;
    this.moved = Math.max(this.moved, Math.hypot(x - this.start.x, y - this.start.y));
    switch (this.mode) {
      case "dragPending":
        if (this.moved < DRAG_START_PX) return [];
        this.mode = "drag";
        return [{ kind: "dragStart", x: this.start.x, y: this.start.y }, { kind: "drag", x, y }];
      case "drag":
        return [{ kind: "drag", x, y }];
      case "refusePending":
        if (this.moved < DRAG_START_PX) return [];
        this.mode = "orbit";
        return [{ kind: "refused", x: this.start.x, y: this.start.y }, { kind: "orbit", dx: x - this.start.x, dy: y - this.start.y, button: this.button, shift }];
      case "pending":
        if (this.moved < DRAG_START_PX) return [];
        this.mode = "orbit";
        return [{ kind: "orbit", dx: x - this.start.x, dy: y - this.start.y, button: this.button, shift }];
      case "orbit":
        return [{ kind: "orbit", dx, dy, button: this.button, shift }];
      case "pan":
        if (this.moved < DRAG_START_PX) return [];
        return [{ kind: "pan", dx, dy }];
      default:
        return [];
    }
  }

  up(id: number, x: number, y: number, t: number): GestureCmd[] {
    if (!this.pts.has(id)) return [];
    this.pts.delete(id);
    const out: GestureCmd[] = [];
    if (this.mode === "drag" && id === this.main) {
      out.push({ kind: "dragEnd", x, y });
      this.mode = this.pts.size ? "two" : "idle";
      this.two = this.pts.size >= 2 ? this.pair() : null;
    } else if (this.mode === "two") {
      // un doigt levé : le geste reste une manipulation de vue jusqu'au dernier doigt (aucun tap)
      this.two = this.pts.size >= 2 ? this.pair() : null;
    } else if (id === this.main && !this.multi && t - this.start.t < TAP_MAX_MS && Math.hypot(x - this.start.x, y - this.start.y) < TAP_MAX_MOVE_PX && this.moved < TAP_MAX_MOVE_PX && this.button === 0) {
      out.push({ kind: "tap", x, y });
    }
    if (!this.pts.size) this.reset();
    return out;
  }

  /** Geste repris par le navigateur : ni tap ni pose. */
  cancel(id: number): GestureCmd[] {
    if (!this.pts.has(id)) return [];
    this.pts.delete(id);
    const out: GestureCmd[] = this.mode === "drag" && id === this.main ? [{ kind: "dragCancel" }] : [];
    if (out.length) this.mode = this.pts.size ? "two" : "idle";
    if (!this.pts.size) this.reset();
    return out;
  }

  private reset() {
    this.mode = "idle";
    this.main = -1;
    this.two = null;
    this.multi = false;
  }

  private pair() {
    const [a, b] = [...this.pts.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }
}
