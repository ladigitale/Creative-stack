import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { Subscriber } from "@supersoniks/concorde/mixins";
import { dispatch, type SonicActionMessage } from "./registry";

const tagName = "sonic-matrix";

type Palette = Record<string, string>;

function pathGet(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: any = obj;
  for (const p of path.split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export type MatrixCell = { row: number; col: number };

/** Cases traversées entre deux cases (incluses), sans saut, dans l'ordre du trajet (Bresenham). */
export function cellsBetween(a: MatrixCell, b: MatrixCell): MatrixCell[] {
  const out: MatrixCell[] = [];
  let x = a.col;
  let y = a.row;
  const dx = Math.abs(b.col - x);
  const dy = -Math.abs(b.row - y);
  const sx = x < b.col ? 1 : -1;
  const sy = y < b.row ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 1024; guard++) {
    out.push({ row: y, col: x });
    if (x === b.col && y === b.row) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** `paint-value` : nombre si l'attribut en est un, sinon texte ; vide : absent. */
function readPaintValue(v: string): number | string | undefined {
  const t = (v ?? "").trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

/**
 * Rendu canvas d’une grille 2D (number[][] ou flat + cols) depuis dataProvider.
 *
 * Interaction (optionnelle) : `emit="cell"` envoie `matrix:cell` {row, col, value, index, stroke, first} au store
 * `target` au clic d'une case (le défilement de la page reste libre). `paint` : appuyer puis glisser peint les cases
 * traversées, une action par case nouvelle du geste (pas de doublon), `paint` = `paint-value` dans le payload si
 * renseigné ; capture du pointeur et `touch-action: none` seulement dans ce mode.
 */
@customElement(tagName)
export class SonicMatrix extends Subscriber(LitElement) {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      max-width: 100%;
      line-height: 0;
    }
    canvas {
      display: block;
      width: 100%;
      height: auto;
      image-rendering: pixelated;
    }
    :host([emit="cell"]) canvas,
    :host([paint]) canvas {
      cursor: pointer;
    }
    :host([paint]) canvas {
      touch-action: none;
      user-select: none;
    }
  `;

  /** Clé vers la matrice dans le DP. */
  @property({ type: String })
  key = "grid";

  @property({ type: Number })
  cols = 0;

  @property({ type: Object })
  palette: Palette = {
    "0": "transparent",
    "1": "#00f0f0",
    "2": "#0000f0",
    "3": "#f0a000",
    "4": "#f0f000",
    "5": "#00f000",
    "6": "#a000f0",
    "7": "#f00000",
  };

  /** Taille cellule px, ou `auto`. */
  @property({ type: String })
  cell = "24";

  @property({ type: Number })
  gap = 1;

  @property({ type: Number })
  radius = 2;

  /** Clé couche fantôme optionnelle. */
  @property({ type: String, attribute: "ghost-key" })
  ghostKey = "";

  @property({ type: String, attribute: "label-key" })
  labelKey = "";

  /** Store qui reçoit les actions `matrix:cell`. */
  @property({ type: String })
  target = "";

  /** `cell` : un clic sur une case envoie `matrix:cell`. */
  @property({ type: String, reflect: true })
  emit = "";

  /** Glisser pour peindre : une action `matrix:cell` par case traversée (implique `emit="cell"`). */
  @property({ type: Boolean, reflect: true })
  paint = false;

  /** Valeur à peindre, recopiée dans `payload.paint` (nombre si possible). */
  @property({ type: String, attribute: "paint-value" })
  paintValue = "";

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  @query("canvas") private canvas!: HTMLCanvasElement;

  private lastSig = "";
  /** Geste de peinture en cours : pointeur, cases déjà envoyées, dernière case. */
  private stroke: { id: number; seen: Set<number>; last: MatrixCell | null } | null = null;
  private strokeCount = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute("role", "img");
  }

  protected updated(): void {
    this.draw();
  }

  private readGrid(): number[][] {
    const props = this.props as Record<string, unknown> | undefined;
    const raw = props ? pathGet(props, this.key) : undefined;
    if (Array.isArray(raw) && Array.isArray(raw[0])) {
      return raw as number[][];
    }
    if (Array.isArray(raw) && this.cols > 0) {
      const flat = raw as number[];
      const out: number[][] = [];
      for (let i = 0; i < flat.length; i += this.cols) {
        out.push(flat.slice(i, i + this.cols).map((n) => Number(n) || 0));
      }
      return out;
    }
    return [];
  }

  private readGhost(): number[][] | null {
    if (!this.ghostKey) return null;
    const props = this.props as Record<string, unknown> | undefined;
    const raw = props ? pathGet(props, this.ghostKey) : undefined;
    if (Array.isArray(raw) && Array.isArray(raw[0])) return raw as number[][];
    return null;
  }

  private colorFor(v: number, ghost = false): string {
    const c = this.palette?.[String(v)] ?? this.palette?.[v] ?? "#888";
    if (!ghost) return c;
    if (c === "transparent") return c;
    return c.startsWith("var(") ? c : `${c}66`;
  }

  private draw(): void {
    const grid = this.readGrid();
    const ghost = this.readGhost();
    const h = grid.length;
    const w = h ? grid[0].length : 0;
    if (!w || !h || !this.canvas) return;

    const sig = JSON.stringify({ grid, ghost, palette: this.palette, cell: this.cell, gap: this.gap });
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const hostW = this.clientWidth || w * 24;
    const cellPx =
      this.cell === "auto" ? Math.max(1, Math.floor(hostW / w)) : Math.max(1, Number(this.cell) || 24);
    const gap = Math.max(0, this.gap);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = w * cellPx;
    const cssH = h * cellPx;
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const paint = (mat: number[][], ghostLayer: boolean) => {
      for (let y = 0; y < mat.length; y++) {
        const row = mat[y];
        for (let x = 0; x < row.length; x++) {
          const v = Number(row[x]) || 0;
          if (!v && !ghostLayer) continue;
          if (!v) continue;
          ctx.fillStyle = this.colorFor(v, ghostLayer);
          const px = x * cellPx + gap;
          const py = y * cellPx + gap;
          const s = cellPx - gap * 2;
          if (this.radius > 0) {
            const r = Math.min(this.radius, s / 2);
            ctx.beginPath();
            ctx.roundRect(px, py, s, s, r);
            ctx.fill();
          } else {
            ctx.fillRect(px, py, s, s);
          }
        }
      }
    };

    if (ghost) paint(ghost, true);
    paint(grid, false);

    if (this.labelKey) {
      const props = this.props as Record<string, unknown> | undefined;
      const label = props ? pathGet(props, this.labelKey) : undefined;
      if (label != null) this.setAttribute("aria-label", String(label));
    }
  }

  /** Case sous un point écran (null hors de la grille). Public pour les tests. */
  cellAt(clientX: number, clientY: number): MatrixCell | null {
    const grid = this.readGrid();
    const h = grid.length;
    const w = h ? grid[0].length : 0;
    if (!w || !h || !this.canvas) return null;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const col = Math.floor(((clientX - r.left) / r.width) * w);
    const row = Math.floor(((clientY - r.top) / r.height) * h);
    if (col < 0 || row < 0 || col >= w || row >= h) return null;
    return { row, col };
  }

  private send(cell: MatrixCell, first: boolean): void {
    const grid = this.readGrid();
    const w = grid[0]?.length ?? 0;
    const value = Number(grid[cell.row]?.[cell.col]) || 0;
    const payload: Record<string, unknown> = { row: cell.row, col: cell.col, value, index: cell.row * w + cell.col, stroke: this.strokeCount, first };
    const pv = readPaintValue(this.paintValue);
    if (pv !== undefined) payload.paint = pv;
    const action: SonicActionMessage = { type: "matrix:cell", payload };
    if (this.target) dispatch(this.target, action);
    if (this.dispatchEventFlag) this.dispatchEvent(new CustomEvent("sonic-action", { detail: action, bubbles: true, composed: true }));
  }

  /** Envoie les cases de `from` à `to` pas encore vues dans le geste. */
  private paintTo(to: MatrixCell): void {
    const s = this.stroke;
    if (!s) return;
    const w = this.readGrid()[0]?.length ?? 0;
    const path = s.last ? cellsBetween(s.last, to) : [to];
    for (const c of path) {
      const i = c.row * w + c.col;
      if (s.seen.has(i)) continue;
      s.seen.add(i);
      this.send(c, s.seen.size === 1);
    }
    s.last = to;
  }

  private onClick = (e: MouseEvent) => {
    if (this.paint || this.emit.trim() !== "cell") return;
    const cell = this.cellAt(e.clientX, e.clientY);
    if (!cell) return;
    this.strokeCount++;
    this.send(cell, true);
  };

  private onDown = (e: PointerEvent) => {
    if (!this.paint) return;
    if (e.button != null && e.button !== 0) return;
    const cell = this.cellAt(e.clientX, e.clientY);
    if (!cell) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* pointeur déjà relâché */
    }
    this.strokeCount++;
    this.stroke = { id: e.pointerId, seen: new Set(), last: null };
    this.paintTo(cell);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.stroke || e.pointerId !== this.stroke.id) return;
    const cell = this.cellAt(e.clientX, e.clientY);
    if (cell) this.paintTo(cell);
  };

  private onUp = (e: PointerEvent) => {
    if (this.stroke && e.pointerId === this.stroke.id) this.stroke = null;
  };

  disconnectedCallback(): void {
    this.stroke = null;
    super.disconnectedCallback();
  }

  render() {
    return html`<canvas
      @click=${this.onClick}
      @pointerdown=${this.onDown}
      @pointermove=${this.onMove}
      @pointerup=${this.onUp}
      @pointercancel=${this.onUp}
    ></canvas>`;
  }
}

export default SonicMatrix;
