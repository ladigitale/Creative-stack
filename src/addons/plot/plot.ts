import { LitElement, css, html, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { buildChart, type ChartModel, type Hit, type Mark, type Row } from "./layout";
import { normalizeSpec, type PlotSpec } from "./spec";

const tagName = "sonic-plot";

export type PlotState = {
  /** Élément survolé (ou ciblé au clavier) : null hors du graphique. */
  hover: { series: string; label: string; value: number; share?: number; row: Row | null } | null;
  /** Élément choisi par clic (re-clic pour retirer). */
  selected: { series: string; label: string; value: number; share?: number; row: Row | null } | null;
  count: number;
  error: string | null;
};

const pubHit = (h: Hit) => ({ series: h.seriesName, label: h.label, value: h.value, ...(h.share !== undefined ? { share: h.share } : {}), row: h.row });

/**
 * Graphiques déclaratifs en SVG, aux couleurs et à la typographie des design tokens Concorde
 * (`--sc-*`), alimentés par DataProvider : types `line`, `area`, `bar`, `barh`, `scatter`, `pie`,
 * `donut`, `histogram`, `heatmap`, `sparkline`.
 *
 * Données : `data-provider` (tableau de lignes, ou `{ rows | items | data }`). Descripteur : attributs
 * `type`, `x`, `y`… ou `spec` (objet / JSON), ou `spec-data-provider` (chemin DP). Le survol et le clic
 * sont publiés dans `out-data-provider` (`hover`, `selected`) pour piloter le reste de l'interface.
 * Aucun formateur fonction : formats nommés (`number`, `compact`, `percent`, `currency:EUR`, `date`…).
 */
@customElement(tagName)
export class SonicPlot extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      font-family: var(--sc-font-family-base, system-ui, sans-serif);
      color: var(--sc-base-content, currentColor);
      font-size: 12px;
    }
    .title {
      font-weight: 600;
      font-size: 13px;
      margin: 0 0 6px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      margin: 0 0 6px;
      padding: 0;
      list-style: none;
    }
    .legend li {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .legend i {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      display: inline-block;
    }
    svg {
      display: block;
      width: 100%;
      overflow: visible;
      outline: none;
    }
    svg:focus-visible {
      outline: 2px solid var(--sc-primary, currentColor);
      outline-offset: 2px;
    }
    .grid {
      stroke: var(--sc-base-300, #ddd);
      stroke-width: 1;
      shape-rendering: crispEdges;
    }
    .axis {
      stroke: var(--sc-base-400, #bbb);
      stroke-width: 1;
      shape-rendering: crispEdges;
    }
    text {
      fill: var(--sc-base-content, currentColor);
      font-size: 11px;
      opacity: 0.75;
    }
    text.title-axis {
      opacity: 0.9;
    }
    text.rule,
    text.slice {
      opacity: 0.9;
    }
    text.slice {
      fill: var(--sc-primary-content, #fff);
      font-weight: 600;
    }
    text.total {
      font-size: 15px;
      font-weight: 600;
      opacity: 1;
    }
    .sel {
      stroke: var(--sc-base-content, currentColor);
      stroke-width: 2;
      fill: none;
      pointer-events: none;
    }
    .wrap {
      position: relative;
    }
    .tip {
      position: absolute;
      pointer-events: none;
      z-index: 2;
      transform: translate(-50%, calc(-100% - 8px));
      background: var(--sc-base-900, #222);
      color: var(--sc-base, #fff);
      padding: 4px 8px;
      border-radius: var(--sc-rounded-sm, 4px);
      box-shadow: var(--sc-shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.3));
      white-space: nowrap;
      line-height: 1.35;
    }
    .tip b {
      font-weight: 600;
    }
    .ramp {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
    }
    .ramp span.bar {
      flex: 0 0 120px;
      height: 8px;
      border-radius: 4px;
      background: linear-gradient(90deg, color-mix(in oklab, var(--sc-primary) 8%, var(--sc-base-100)), var(--sc-primary));
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.6;
    }
  `;

  /** Descripteur complet (objet, ou JSON dans l'attribut). */
  @property({ type: Object })
  spec: unknown = null;

  @property({ type: String, attribute: "spec-data-provider" })
  specDataProvider = "";

  /** DP portant les lignes (tableau, ou objet { rows | items | data }). */
  @property({ type: String, attribute: "data-provider" })
  dataProvider = "";

  @property({ type: Array })
  data: unknown[] | null = null;

  @property({ type: String }) type = "";
  @property({ type: String }) x = "";
  /** Champs de valeur séparés par des virgules. */
  @property({ type: String }) y = "";
  @property({ type: String }) series = "";
  @property({ type: String }) value = "";
  @property({ type: String }) size = "";
  /** Titre du graphique (nom `heading` : `title` est déjà l'infobulle native du navigateur). */
  @property({ type: String }) heading = "";
  @property({ type: String, attribute: "x-label" }) xLabel = "";
  @property({ type: String, attribute: "y-label" }) yLabel = "";
  @property({ type: String }) curve = "";
  /** `sum`, `mean`, `count`, `min`, `max` : regroupe les lignes de même abscisse. */
  @property({ type: String }) aggregate = "";
  @property({ type: Boolean }) stack = false;
  @property({ type: Boolean }) points = false;
  @property({ type: Number }) bins = 0;
  @property({ type: Number }) height = 0;
  @property({ type: String, attribute: "format-x" }) formatX = "";
  @property({ type: String, attribute: "format-y" }) formatY = "";
  @property({ type: String, attribute: "format-value" }) formatValue = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  @state() private width = 0;
  @state() private rows: unknown = [];
  @state() private dpSpec: unknown = null;
  @state() private hover: Hit | null = null;
  @state() private selected: Hit | null = null;
  @state() private cursor = -1;

  private ro: ResizeObserver | null = null;
  private unsubs: (() => void)[] = [];
  private lastError: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w && w !== this.width) this.width = w;
    });
    this.ro.observe(this);
    this.width = Math.round(this.getBoundingClientRect().width) || this.width;
  }

  disconnectedCallback(): void {
    this.ro?.disconnect();
    this.ro = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected willUpdate(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("dataProvider") || changed.has("specDataProvider")) this.listen();
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.dataProvider) {
      this.unsubs.push(
        listenDp(this.dataProvider, (v) => {
          const o = v as Record<string, unknown> | null;
          this.rows = Array.isArray(v) ? v : o && typeof o === "object" ? (o.rows ?? o.items ?? o.data ?? []) : [];
          this.selected = null;
        }),
      );
    }
    if (this.specDataProvider) this.unsubs.push(listenDp(this.specDataProvider, (v) => (this.dpSpec = v)));
  }

  /** Descripteur effectif : spec (objet/JSON) < spec DP < attributs. */
  private effectiveSpec(): { spec: PlotSpec; errors: string[] } {
    let base: unknown = this.dpSpec ?? this.spec;
    if (typeof base === "string") {
      try {
        base = JSON.parse(base);
      } catch {
        return { spec: normalizeSpec({}).spec, errors: ["spec : JSON invalide"] };
      }
    }
    const o: Record<string, unknown> = { ...(base && typeof base === "object" ? (base as Record<string, unknown>) : {}) };
    if (this.type) o.type = this.type;
    if (this.x) o.x = this.x;
    if (this.y) o.y = this.y.split(",").map((s) => s.trim()).filter(Boolean);
    if (this.series) o.series = this.series;
    if (this.value) o.value = this.value;
    if (this.size) o.size = this.size;
    if (this.heading) o.title = this.heading;
    if (this.xLabel) o.xLabel = this.xLabel;
    if (this.yLabel) o.yLabel = this.yLabel;
    if (this.curve) o.curve = this.curve;
    if (this.aggregate) o.aggregate = this.aggregate;
    if (this.stack) o.stack = true;
    if (this.points) o.points = true;
    if (this.bins) o.bins = this.bins;
    if (this.height) o.height = this.height;
    if (this.formatX || this.formatY || this.formatValue) {
      o.format = { ...(o.format as object), ...(this.formatX && { x: this.formatX }), ...(this.formatY && { y: this.formatY }), ...(this.formatValue && { value: this.formatValue }) };
    }
    return normalizeSpec(o);
  }

  private model(spec: PlotSpec): ChartModel | null {
    if (this.width < 20) return null;
    const rows = this.data ?? this.rows;
    const h = spec.height ?? (spec.type === "sparkline" ? 40 : spec.type === "pie" || spec.type === "donut" ? Math.min(this.width, 320) : Math.max(180, Math.min(420, Math.round(this.width * 0.55))));
    return buildChart(spec, rows, this.width, h);
  }

  private publish(error: string | null): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out) return;
    const rows = this.data ?? this.rows;
    const s: PlotState = { hover: this.hover ? pubHit(this.hover) : null, selected: this.selected ? pubHit(this.selected) : null, count: Array.isArray(rows) ? rows.length : 0, error };
    set(out, s);
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("hover") || changed.has("selected") || changed.has("rows") || changed.has("data")) this.publish(this.lastError);
  }

  private svgPoint(e: PointerEvent): [number, number] {
    const el = this.renderRoot.querySelector("svg");
    const r = el?.getBoundingClientRect();
    return r ? [e.clientX - r.left, e.clientY - r.top] : [0, 0];
  }

  private onMove = (m: ChartModel) => (e: PointerEvent) => {
    const [x, y] = this.svgPoint(e);
    const h = m.pick(x, y);
    if (h !== this.hover) this.hover = h;
  };

  private onClick = (m: ChartModel) => (e: PointerEvent) => {
    const [x, y] = this.svgPoint(e);
    const h = m.pick(x, y);
    this.selected = h && this.selected && this.selected.row === h.row && this.selected.series === h.series && this.selected.label === h.label ? null : h;
  };

  private onKey = (m: ChartModel) => (e: KeyboardEvent) => {
    const n = m.hits.length;
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") this.cursor = (this.cursor + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") this.cursor = (this.cursor - 1 + n) % n;
    else if (e.key === "Enter" || e.key === " ") {
      if (this.cursor >= 0) this.selected = this.selected === m.hits[this.cursor] ? null : m.hits[this.cursor];
      e.preventDefault();
      return;
    } else if (e.key === "Escape") {
      this.cursor = -1;
      this.hover = null;
      return;
    } else return;
    e.preventDefault();
    this.hover = m.hits[this.cursor];
  };

  private mark(m: Mark): TemplateResult | typeof nothing {
    switch (m.k) {
      case "path":
        return svg`<path d=${m.d} fill=${m.fill ?? "none"} stroke=${m.stroke ?? "none"} stroke-width=${m.sw ?? 0} stroke-dasharray=${m.dash ?? nothing} opacity=${m.op ?? 1} stroke-linejoin="round" stroke-linecap="round" />`;
      case "rect":
        return svg`<rect x=${m.x} y=${m.y} width=${m.w} height=${m.h} rx=${m.r ?? 0} fill=${m.fill} />`;
      case "dot":
        return svg`<circle cx=${m.cx} cy=${m.cy} r=${m.r} fill=${m.fill} stroke="var(--sc-base, #fff)" stroke-width="1.5" />`;
      case "arc":
        return svg`<path d=${m.d} fill=${m.fill} stroke="var(--sc-base, #fff)" stroke-width="1" />`;
      case "text":
        return svg`<text x=${m.x} y=${m.y} text-anchor=${m.anchor ?? "start"} class=${m.cls ?? ""}>${m.text}</text>`;
    }
  }

  private marker(h: Hit | null): TemplateResult | typeof nothing {
    return h ? svg`<circle class="sel" cx=${h.x} cy=${h.y} r="7" />` : nothing;
  }

  render() {
    const { spec, errors } = this.effectiveSpec();
    this.lastError = errors.length ? errors.join(" ; ") : null;
    const m = this.model(spec);
    if (!m) return html`<div style="min-height:24px"></div>`;
    const isPie = spec.type === "pie" || spec.type === "donut";
    const spark = spec.type === "sparkline";
    const { inner } = m;
    const ax = m.xAxis, ay = m.yAxis;
    const tip = this.hover;
    return html`
      ${spec.title && !spark ? html`<div class="title" part="title">${spec.title}</div>` : nothing}
      ${m.legend.length && spec.legend !== false ? html`<ul class="legend" part="legend">${m.legend.map((l) => html`<li><i style="background:${l.color}"></i>${l.name}</li>`)}</ul>` : nothing}
      <div class="wrap">
      ${m.empty
        ? html`<div class="empty" style="height:${spec.height ?? 120}px" part="empty">Aucune donnée</div>`
        : html`<svg
            viewBox="0 0 ${m.width} ${m.height}"
            height=${m.height}
            role="img"
            aria-label=${m.summary}
            tabindex="0"
            @pointermove=${this.onMove(m)}
            @pointerleave=${() => (this.hover = null)}
            @click=${this.onClick(m)}
            @keydown=${this.onKey(m)}
            @blur=${() => (this.cursor = -1)}
          >
            ${m.gridY.map((y) => svg`<line class="grid" x1=${inner.x} x2=${inner.x + inner.w} y1=${y} y2=${y} />`)}
            ${m.gridX.map((x) => svg`<line class="grid" x1=${x} x2=${x} y1=${inner.y} y2=${inner.y + inner.h} />`)}
            ${m.marks.map((k) => this.mark(k))}
            ${!isPie && !spark && ax ? svg`<line class="axis" x1=${inner.x} x2=${inner.x + inner.w} y1=${inner.y + inner.h} y2=${inner.y + inner.h} />` : nothing}
            ${!isPie && !spark && ay ? svg`<line class="axis" x1=${inner.x} x2=${inner.x} y1=${inner.y} y2=${inner.y + inner.h} />` : nothing}
            ${ax ? ax.ticks.map((t) => svg`<text x=${t.pos} y=${inner.y + inner.h + 15} text-anchor="middle">${t.label}</text>`) : nothing}
            ${ay ? ay.ticks.map((t) => svg`<text x=${inner.x - 6} y=${t.pos + 4} text-anchor="end">${t.label}</text>`) : nothing}
            ${ax?.title ? svg`<text class="title-axis" x=${inner.x + inner.w / 2} y=${m.height - 3} text-anchor="middle">${ax.title}</text>` : nothing}
            ${ay?.title ? svg`<text class="title-axis" transform=${`translate(11 ${inner.y + inner.h / 2}) rotate(-90)`} text-anchor="middle">${ay.title}</text>` : nothing}
            ${m.overlay.map((k) => this.mark(k))}
            ${this.marker(this.selected)}${this.marker(tip)}
          </svg>`}
      ${tip
        ? html`<div class="tip" part="tooltip" style="left:${tip.x}px;top:${tip.y}px">
            ${m.legend.length || isPie ? html`<b>${tip.seriesName}</b> · ` : nothing}${tip.label} <b>${tip.valueLabel}</b>${tip.share !== undefined ? html` (${Math.round(tip.share * 1000) / 10} %)` : nothing}
          </div>`
        : nothing}
      </div>
      ${m.scale ? html`<div class="ramp" part="scale"><span>${m.scale.min}</span><span class="bar"></span><span>${m.scale.max}</span></div>` : nothing}
    `;
  }
}

export default SonicPlot;
