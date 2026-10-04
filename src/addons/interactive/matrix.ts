import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { Subscriber } from "@supersoniks/concorde/mixins";

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

/**
 * Rendu canvas d’une grille 2D (number[][] ou flat + cols) depuis dataProvider.
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

  @query("canvas") private canvas!: HTMLCanvasElement;

  private lastSig = "";

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

  render() {
    return html`<canvas></canvas>`;
  }
}

export default SonicMatrix;
