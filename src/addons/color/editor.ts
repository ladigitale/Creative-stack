import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { dispatch } from "../interactive";
import {
  HARMONY_RULES, MAX_COLORS, oklchToHex, oklchToSrgb, parseColorList, parseHex, rgbToOklch, sanitizeRule, suggestPalette, toHex,
  type HarmonyRule, type Oklch,
} from "./core";

export type PaletteEditorState = {
  status: "ready";
  id: string;
  name: string;
  colors: string[];
  locked: boolean[];
  count: number;
  selected: number;
  rule: HarmonyRule;
  /** Le nombre de couleurs verrouillées. */
  lockedCount: number;
};

const RULE_LABELS: Record<HarmonyRule, string> = {
  mono: "Monochrome", analogous: "Analogue", complementary: "Complémentaire", split: "Divisée",
  triadic: "Triade", tetradic: "Rectangle", square: "Carré",
};
const MAX_CHROMA = 0.37;
const MAX_NAME = 60;
const DEFAULT_COLORS = ["#2f6fdb", "#e0a526", "#d1495b", "#3d9970", "#2b2d42"];

/** Texte lisible (noir ou blanc) sur une couleur. */
const ink = (hex: string): string => (rgbToOklch(parseHex(hex) ?? [0, 0, 0]).l > 0.62 ? "#111" : "#fff");

/**
 * Éditeur de palette : chaque couleur se choisit (carré clarté × saturation à la teinte donnée, bande des teintes,
 * code hex), leur nombre (1..12), et une aide propose les couleurs non verrouillées selon une règle d'harmonie
 * (`suggestPalette` : la première couleur verrouillée sert de base, sinon la couleur sélectionnée ; chaque nouvelle
 * demande donne une variante). Palette chargée depuis `params` (`dp` ou `dp.clé` : `{id, name, colors, locked,
 * rule}`, rechargée quand cet objet change), commandes par `control` ({ suggest, save, add, remove } compteurs),
 * état dans `out-data-provider`. Enregistrer envoie `{type: save-action, payload: {id, name, colors}}` au store
 * `save-to`.
 */
@customElement("sonic-palette-editor")
export class SonicPaletteEditor extends LitElement {
  static styles = css`
    :host { display: block; color: var(--sc-base-content, #222); font: inherit; }
    * { box-sizing: border-box; }
    .strip { display: flex; gap: 6px; align-items: stretch; }
    .slot { position: relative; flex: 1 1 0; min-width: 0; height: var(--palette-editor-swatch, 56px); border-radius: var(--sc-rounded, 8px);
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--sc-base-content, #000) 14%, transparent); transition: flex-grow .15s ease; }
    .slot[aria-current="true"] { flex-grow: 1.6; box-shadow: 0 0 0 2px var(--sc-base, #fff), 0 0 0 4px var(--sc-base-content, #000); }
    .pick { all: unset; position: absolute; inset: 0; cursor: pointer; border-radius: inherit; }
    .pick:focus-visible { outline: 2px solid var(--sc-primary, #2f6fdb); outline-offset: 3px; }
    .hex { position: absolute; left: 6px; bottom: 5px; font: 600 10px/1 ui-monospace, monospace; letter-spacing: .04em; pointer-events: none; opacity: .85; }
    .lock { all: unset; position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; }
    .lock:hover { background: color-mix(in oklab, currentColor 18%, transparent); }
    .lock:focus-visible { outline: 2px solid currentColor; }
    .lock[aria-pressed="false"] { opacity: .45; }
    .slot:not(:hover):not([aria-current="true"]) .lock[aria-pressed="false"] { opacity: 0; }
    .add { all: unset; flex: 0 0 36px; display: grid; place-items: center; cursor: pointer; border-radius: var(--sc-rounded, 8px);
      border: 1px dashed color-mix(in oklab, var(--sc-base-content, #000) 30%, transparent); }
    .add:hover { background: color-mix(in oklab, var(--sc-base-content, #000) 6%, transparent); }
    .add:focus-visible { outline: 2px solid var(--sc-primary, #2f6fdb); }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .label { font: 600 9px/1.2 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; opacity: .55; }
    .picker { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 14px; margin-top: 16px; }
    @container (max-width: 440px) { .picker { grid-template-columns: 1fr; } }
    .wrap { container-type: inline-size; }
    .area { position: relative; touch-action: none; cursor: crosshair; border-radius: var(--sc-rounded, 8px); overflow: hidden; height: 150px; }
    .area canvas, .hue canvas { display: block; width: 100%; height: 100%; }
    .hue { position: relative; touch-action: none; cursor: ew-resize; height: 18px; border-radius: 9px; overflow: hidden; margin-top: 10px; }
    .knob { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; pointer-events: none;
      box-shadow: 0 0 0 2px #fff, 0 0 0 3px rgb(0 0 0 / .45), 0 1px 4px rgb(0 0 0 / .3); }
    .hue .knob { top: 50%; }
    .side { display: flex; flex-direction: column; gap: 10px; }
    .preview { height: 54px; border-radius: var(--sc-rounded, 8px); display: flex; align-items: flex-end; padding: 6px 8px; font: 600 11px/1 ui-monospace, monospace; }
    input[type="text"] { all: unset; box-sizing: border-box; width: 100%; padding: 7px 9px; border-radius: var(--sc-rounded, 8px);
      background: color-mix(in oklab, var(--sc-base-content, #000) 6%, transparent); font: inherit; }
    input[type="text"].mono { font: 13px/1.2 ui-monospace, monospace; }
    input[type="text"]:focus-visible { outline: 2px solid var(--sc-primary, #2f6fdb); }
    .vals { display: grid; grid-template-columns: auto 1fr; gap: 3px 8px; font: 11px/1.4 ui-monospace, monospace; }
    .vals span:nth-child(odd) { opacity: .55; }
    .btn { all: unset; cursor: pointer; padding: 7px 12px; border-radius: var(--sc-rounded, 8px); font-weight: 500; text-align: center;
      background: color-mix(in oklab, var(--sc-base-content, #000) 7%, transparent); display: inline-flex; gap: 6px; align-items: center; }
    .btn:hover { background: color-mix(in oklab, var(--sc-base-content, #000) 12%, transparent); }
    .btn:focus-visible { outline: 2px solid var(--sc-primary, #2f6fdb); }
    .btn[disabled] { opacity: .4; pointer-events: none; }
    .btn.primary { background: var(--sc-primary, #2f6fdb); color: var(--sc-primary-content, #fff); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 999px; font-size: .85em;
      background: color-mix(in oklab, var(--sc-base-content, #000) 6%, transparent); }
    .chip[aria-pressed="true"] { background: var(--sc-base-content, #222); color: var(--sc-base, #fff); }
    .chip:focus-visible { outline: 2px solid var(--sc-primary, #2f6fdb); }
    .help { font-size: .82em; opacity: .65; margin: 0; }
    section { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
    .stepper { display: inline-flex; align-items: center; gap: 2px; }
    .stepper .btn { padding: 4px 10px; }
    .stepper output { min-width: 72px; text-align: center; font-variant-numeric: tabular-nums; }
    @media (prefers-reduced-motion: reduce) { .slot { transition: none; } }
  `;

  /** Palette à éditer : `dp` ou `dp.clé` d'un objet `{id, name, colors, locked, rule}`. */
  @property({ type: String }) params = "";
  @property({ type: String }) control = "";
  /** Couleurs de départ sans `params` (liste JSON ou `#a, #b…`). */
  @property({ type: String }) colors = "";
  @property({ type: String }) name = "";
  /** Règle d'harmonie de l'aide (défaut analogous). */
  @property({ type: String }) rule = "analogous";
  @property({ type: String, attribute: "save-to" }) saveTo = "";
  @property({ type: String, attribute: "save-action" }) saveAction = "savePalette";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  @state() private cols: string[] = [];
  @state() private locked: boolean[] = [];
  @state() private sel = 0;
  @state() private label = "";
  @state() private harmonyRule: HarmonyRule = "analogous";
  /** Couleur sélectionnée en OKLCH : garde la teinte quand la saturation tombe à 0. */
  @state() private cur: Oklch = { l: 0.6, c: 0.15, h: 250 };
  private palId = "";
  private variant = 0;
  private loaded = "";
  private unsubs: (() => void)[] = [];
  private triggers = { suggest: new CounterTrigger(), save: new CounterTrigger(), add: new CounterTrigger(), remove: new CounterTrigger() };
  private drawnArea = "";
  private drawnHue = "";
  @query(".area canvas") private areaCanvas?: HTMLCanvasElement;
  @query(".hue canvas") private hueCanvas?: HTMLCanvasElement;

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.cols.length) this.load({ colors: this.colors, name: this.name, rule: this.rule });
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected willUpdate(c: PropertyValues): void {
    if (c.has("params") || c.has("control")) this.listen();
    if ((c.has("colors") || c.has("name")) && !this.params) this.load({ colors: this.colors, name: this.name, rule: this.rule });
    if (c.has("rule") && c.get("rule") !== undefined) this.harmonyRule = sanitizeRule(this.rule, "analogous");
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const t of Object.values(this.triggers)) t.reset();
    if (this.params) {
      const [dp, key] = this.params.split(/\.(.*)/s);
      this.unsubs.push(listenDp(dp, (v) => {
        const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
        const p = key ? o[key] : o;
        const sig = JSON.stringify(p ?? null);
        if (sig === this.loaded) return;
        this.loaded = sig;
        if (p && typeof p === "object") this.load(p as Record<string, unknown>);
      }));
    }
    if (this.control) {
      this.unsubs.push(listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        if ("suggest" in c && this.triggers.suggest.feed(c.suggest)) this.suggest();
        if ("save" in c && this.triggers.save.feed(c.save)) this.save();
        if ("add" in c && this.triggers.add.feed(c.add)) this.addColor();
        if ("remove" in c && this.triggers.remove.feed(c.remove)) this.removeColor(this.sel);
      }));
    }
  }

  /** Charge une palette `{id, name, colors, locked, rule}`. */
  load(p: Record<string, unknown>): void {
    const cols = parseColorList(p.colors);
    this.cols = cols.length ? cols : [...DEFAULT_COLORS];
    const lk = Array.isArray(p.locked) ? p.locked : [];
    this.locked = this.cols.map((_, i) => lk[i] === true);
    this.palId = typeof p.id === "string" ? p.id.slice(0, 80) : "";
    this.label = typeof p.name === "string" ? p.name.slice(0, MAX_NAME) : "";
    if (p.rule !== undefined) this.harmonyRule = sanitizeRule(p.rule, "analogous");
    else this.harmonyRule = sanitizeRule(this.rule, "analogous");
    this.variant = 0;
    this.select(0);
  }

  getState(): PaletteEditorState {
    return {
      status: "ready", id: this.palId, name: this.label, colors: [...this.cols], locked: [...this.locked], count: this.cols.length,
      selected: this.sel, rule: this.harmonyRule, lockedCount: this.locked.filter(Boolean).length,
    };
  }

  private publish(): void {
    if (this.outDataProvider) set(this.outDataProvider, this.getState());
  }

  protected updated(): void {
    this.publish();
    this.draw();
  }

  select(i: number): void {
    this.sel = Math.max(0, Math.min(this.cols.length - 1, i));
    this.cur = rgbToOklch(parseHex(this.cols[this.sel]) ?? [0.5, 0.5, 0.5]);
  }

  /** Couleur du rang sélectionné. */
  setColor(o: Oklch): void {
    this.cur = { l: Math.min(1, Math.max(0, o.l)), c: Math.min(MAX_CHROMA, Math.max(0, o.c)), h: ((o.h % 360) + 360) % 360 };
    const cols = [...this.cols];
    cols[this.sel] = oklchToHex(this.cur);
    this.cols = cols;
  }

  toggleLock(i: number): void {
    const lk = [...this.locked];
    lk[i] = !lk[i];
    this.locked = lk;
  }

  /** Propose les couleurs non verrouillées ; une nouvelle demande donne une autre variante. */
  suggest(): void {
    this.cols = suggestPalette({ colors: this.cols, locked: this.locked, rule: this.harmonyRule, anchor: this.sel, variant: this.variant++ });
    this.cur = rgbToOklch(parseHex(this.cols[this.sel])!);
  }

  addColor(): void {
    if (this.cols.length >= MAX_COLORS) return;
    // La nouvelle couleur est proposée par l'aide, à partir des couleurs existantes gardées.
    const cols = [...this.cols, this.cols[this.cols.length - 1]];
    const keep = cols.map((_, i) => i < this.cols.length);
    const next = suggestPalette({ colors: cols, locked: keep, rule: this.harmonyRule, variant: this.variant });
    this.cols = next;
    this.locked = [...this.locked, false];
    this.select(next.length - 1);
  }

  removeColor(i: number): void {
    if (this.cols.length <= 1) return;
    this.cols = this.cols.filter((_, k) => k !== i);
    this.locked = this.locked.filter((_, k) => k !== i);
    this.select(Math.min(i, this.cols.length - 1));
  }

  setCount(n: number): void {
    n = Math.max(1, Math.min(MAX_COLORS, Math.round(n)));
    while (this.cols.length < n) this.addColor();
    while (this.cols.length > n) this.removeColor(this.cols.length - 1);
  }

  /** Envoie la palette au store `save-to`. */
  save(): void {
    if (!this.saveTo || !this.cols.length) return;
    dispatch(this.saveTo, { type: this.saveAction || "savePalette", payload: { id: this.palId, name: this.label.trim(), colors: [...this.cols] } });
  }

  // --- dessin ---

  private draw(): void {
    const a = this.areaCanvas, hc = this.hueCanvas;
    const h = Math.round(this.cur.h * 2) / 2;
    if (a) {
      const w = 96, ht = 64, key = `${h}`;
      if (key !== this.drawnArea || a.width !== w) {
        a.width = w; a.height = ht;
        const ctx = a.getContext("2d");
        if (ctx) {
          const img = ctx.createImageData(w, ht);
          for (let y = 0; y < ht; y++) {
            const l = 1 - y / (ht - 1);
            for (let x = 0; x < w; x++) {
              const { rgb, inGamut } = oklchToSrgb({ l, c: (x / (w - 1)) * MAX_CHROMA, h });
              const k = (y * w + x) * 4;
              // Hors gamut : grisé, la couleur obtenue sera la plus proche affichable.
              const f = inGamut ? 1 : 0.35;
              img.data[k] = (rgb[0] * f + 0.5 * (1 - f)) * 255;
              img.data[k + 1] = (rgb[1] * f + 0.5 * (1 - f)) * 255;
              img.data[k + 2] = (rgb[2] * f + 0.5 * (1 - f)) * 255;
              img.data[k + 3] = 255;
            }
          }
          ctx.putImageData(img, 0, 0);
          this.drawnArea = key;
        }
      }
    }
    if (hc && this.drawnHue !== "ok") {
      hc.width = 180; hc.height = 1;
      const ctx = hc.getContext("2d");
      if (ctx) {
        const img = ctx.createImageData(180, 1);
        for (let x = 0; x < 180; x++) {
          const rgb = parseHex(oklchToHex({ l: 0.72, c: 0.14, h: x * 2 }))!;
          img.data.set([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, 255], x * 4);
        }
        ctx.putImageData(img, 0, 0);
        this.drawnHue = "ok";
      }
    }
  }

  private drag(e: PointerEvent, apply: (fx: number, fy: number) => void): void {
    const el = e.currentTarget as HTMLElement;
    const at = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      apply(Math.min(1, Math.max(0, (ev.clientX - r.left) / (r.width || 1))), Math.min(1, Math.max(0, (ev.clientY - r.top) / (r.height || 1))));
    };
    el.setPointerCapture?.(e.pointerId);
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    e.preventDefault();
  }

  private areaKey(e: KeyboardEvent): void {
    const d = e.shiftKey ? 0.05 : 0.01;
    const o = { ...this.cur };
    if (e.key === "ArrowUp") o.l += d; else if (e.key === "ArrowDown") o.l -= d;
    else if (e.key === "ArrowRight") o.c += d * 0.4; else if (e.key === "ArrowLeft") o.c -= d * 0.4; else return;
    e.preventDefault();
    this.setColor(o);
  }

  private hueKey(e: KeyboardEvent): void {
    const d = e.shiftKey ? 15 : 2;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") this.setColor({ ...this.cur, h: this.cur.h + d });
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") this.setColor({ ...this.cur, h: this.cur.h - d });
    else return;
    e.preventDefault();
  }

  private onHex(e: Event): void {
    const input = e.target as HTMLInputElement;
    const v = input.value.trim();
    const rgb = parseHex(v.startsWith("#") ? v : `#${v}`);
    if (!rgb) { input.value = this.cols[this.sel]; return; }
    const cols = [...this.cols];
    cols[this.sel] = toHex(rgb);
    this.cols = cols;
    this.cur = rgbToOklch(rgb);
  }

  private lockIcon(on: boolean) {
    return html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      ${svg`<rect x="5" y="11" width="14" height="10" rx="2"></rect>`}
      ${on ? svg`<path d="M8 11V7a4 4 0 0 1 8 0v4"></path>` : svg`<path d="M8 11V7a4 4 0 0 1 7.5-2"></path>`}
    </svg>`;
  }

  render() {
    const n = this.cols.length;
    const hex = this.cols[this.sel] ?? "#000000";
    const nLocked = this.locked.filter(Boolean).length;
    const free = n - (nLocked || 1);
    return html`<div class="wrap">
      <div class="strip" role="group" aria-label="Couleurs de la palette">
        ${this.cols.map((c, i) => html`<div class="slot" style="background:${c};color:${ink(c)}" aria-current=${i === this.sel ? "true" : "false"}>
          <button class="pick" aria-pressed=${i === this.sel ? "true" : "false"} aria-label="Couleur ${i + 1} : ${c}${this.locked[i] ? ", verrouillée" : ""}"
            @click=${() => this.select(i)}></button>
          <span class="hex">${c.slice(1).toUpperCase()}</span>
          <button class="lock" aria-pressed=${this.locked[i] ? "true" : "false"} title=${this.locked[i] ? "Déverrouiller" : "Verrouiller : l'aide la garde"}
            aria-label="${this.locked[i] ? "Déverrouiller" : "Verrouiller"} la couleur ${i + 1}" @click=${() => this.toggleLock(i)}>${this.lockIcon(!!this.locked[i])}</button>
        </div>`)}
        ${n < MAX_COLORS ? html`<button class="add" aria-label="Ajouter une couleur" title="Ajouter une couleur" @click=${() => this.addColor()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${svg`<path d="M12 5v14M5 12h14"></path>`}</svg></button>` : nothing}
      </div>

      <div class="picker">
        <div>
          <div class="area" tabindex="0" role="slider" aria-label="Clarté et saturation" aria-valuetext="clarté ${Math.round(this.cur.l * 100)} %, saturation ${this.cur.c.toFixed(2)}"
            @pointerdown=${(e: PointerEvent) => this.drag(e, (fx, fy) => this.setColor({ ...this.cur, c: fx * MAX_CHROMA, l: 1 - fy }))} @keydown=${this.areaKey}>
            <canvas></canvas>
            <span class="knob" style="left:${(this.cur.c / MAX_CHROMA) * 100}%;top:${(1 - this.cur.l) * 100}%;background:${hex}"></span>
          </div>
          <div class="hue" tabindex="0" role="slider" aria-label="Teinte" aria-valuemin="0" aria-valuemax="360" aria-valuenow=${Math.round(this.cur.h)}
            @pointerdown=${(e: PointerEvent) => this.drag(e, (fx) => this.setColor({ ...this.cur, h: fx * 359.9 }))} @keydown=${this.hueKey}>
            <canvas></canvas>
            <span class="knob" style="left:${(this.cur.h / 360) * 100}%;background:${oklchToHex({ l: 0.72, c: 0.14, h: this.cur.h })}"></span>
          </div>
        </div>
        <div class="side">
          <div class="preview" style="background:${hex};color:${ink(hex)}">Couleur ${this.sel + 1}</div>
          <input type="text" class="mono" aria-label="Code hex" maxlength="7" spellcheck="false" .value=${hex} @change=${this.onHex}>
          <div class="vals">
            <span>Clarté</span><span>${Math.round(this.cur.l * 100)} %</span>
            <span>Satur.</span><span>${this.cur.c.toFixed(3)}</span>
            <span>Teinte</span><span>${Math.round(this.cur.h)}°</span>
          </div>
          <button class="btn" ?disabled=${n <= 1} @click=${() => this.removeColor(this.sel)}>Retirer</button>
        </div>
      </div>

      <section>
        <div class="row" style="justify-content:space-between">
          <span class="label">Nombre</span>
          <span class="stepper">
            <button class="btn" aria-label="Une couleur de moins" ?disabled=${n <= 1} @click=${() => this.setCount(n - 1)}>−</button>
            <output aria-live="polite">${n} couleur${n > 1 ? "s" : ""}</output>
            <button class="btn" aria-label="Une couleur de plus" ?disabled=${n >= MAX_COLORS} @click=${() => this.setCount(n + 1)}>+</button>
          </span>
        </div>
      </section>

      <section>
        <span class="label">Aide · harmonie</span>
        <div class="chips" role="group" aria-label="Règle d'harmonie">
          ${HARMONY_RULES.map((r) => html`<button class="chip" aria-pressed=${r === this.harmonyRule ? "true" : "false"} @click=${() => { this.harmonyRule = r; this.variant = 0; }}>${RULE_LABELS[r]}</button>`)}
        </div>
        <div class="row">
          <button class="btn primary" ?disabled=${free <= 0} @click=${() => this.suggest()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg`<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"></path><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"></path>`}</svg>
            ${this.variant ? "Autre proposition" : "Proposer les couleurs libres"}</button>
          ${nLocked ? html`<button class="btn" @click=${() => { this.locked = this.cols.map(() => false); }}>Tout déverrouiller</button>` : nothing}
        </div>
        <p class="help">${nLocked
          ? `${nLocked} couleur${nLocked > 1 ? "s" : ""} verrouillée${nLocked > 1 ? "s" : ""} : l'aide propose les ${free} autre${free > 1 ? "s" : ""}.`
          : "Verrouille les couleurs à garder ; sans verrou, la couleur sélectionnée sert de base."}</p>
      </section>

      <section>
        <label class="label" for="nom">Nom</label>
        <input id="nom" type="text" maxlength=${MAX_NAME} placeholder="Ma palette" .value=${this.label}
          @input=${(e: Event) => { this.label = (e.target as HTMLInputElement).value.slice(0, MAX_NAME); }}>
      </section>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sonic-palette-editor": SonicPaletteEditor;
  }
}
