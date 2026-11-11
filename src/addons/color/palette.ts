import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { dispatch } from "../interactive";
import { MAX_COLORS, customPalette, harmony, oklchToHex, parseColorList, parseHex, rgbToOklch, sanitizeRule, type HarmonyRule, type PaletteColor } from "./core";

/** Règle d'harmonie, ou `custom` : la liste `colors` telle quelle. */
export type PaletteRule = HarmonyRule | "custom";
const sanitizePaletteRule = (v: unknown, fallback: PaletteRule): PaletteRule => {
  if (typeof v === "string" && ["custom", "perso", "libre"].includes(v.trim().toLowerCase())) return "custom";
  const r = sanitizeRule(v, "mono");
  return r === "mono" && sanitizeRule(v, "square") === "square" ? fallback : r;
};

export type PaletteState = {
  status: "ready";
  base: string;
  rule: PaletteRule;
  count: number;
  spread: number;
  step: number;
  /** Couleurs hex, dans l'ordre : teintes de la règle puis nuances. */
  colors: string[];
  items: PaletteColor[];
  /** Couleur choisie (hex) et son rang, ou `null` / -1. */
  selected: string | null;
  selectedIndex: number;
};

const num = (v: unknown, lo: number, hi: number): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

/**
 * Palette d'harmonie : `count` couleurs calculées depuis `base` selon une règle de théorie des couleurs
 * (`rule` : mono, analogous, complementary, split, triadic, tetradic, square), en OKLCH. Pastilles
 * cliquables : la couleur choisie part en action vers un store (`target`, `action`, `key`), comme
 * `sonic-action`. Réglages en direct par `params`, commandes par `control` ({ random, rotate } compteurs),
 * état complet dans `out-data-provider`. Palette libre : `rule="custom"` et `colors` (attribut ou `params.colors`,
 * jusqu'à 12 `#rrggbb`) — random / rotate en tournent alors toutes les teintes.
 */
@customElement("sonic-palette")
export class SonicPalette extends LitElement {
  static styles = css`
    :host { display: inline-block; }
    :host([headless]) { display: none; }
    .sw { display: flex; gap: var(--palette-gap, 8px); flex-wrap: wrap; align-items: center; }
    .sw.column { flex-direction: column; flex-wrap: nowrap; }
    .sw.grid { display: grid; grid-template-columns: repeat(var(--palette-columns, 2), auto); justify-content: center; }
    button {
      all: unset; box-sizing: border-box; cursor: pointer; position: relative;
      width: var(--palette-size, 26px); height: var(--palette-size, 26px); border-radius: 50%;
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--sc-base-content, #000) 18%, transparent);
      transition: transform 0.12s ease;
    }
    .square button { border-radius: var(--sc-rounded, 6px); }
    button:hover { transform: scale(1.08); }
    button:focus-visible { outline: 2px solid var(--sc-primary, #2f6fdb); outline-offset: 2px; }
    button[aria-pressed="true"] {
      box-shadow: 0 0 0 2px var(--sc-base, #fff), 0 0 0 4px var(--sc-base-content, #000);
    }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;

  /** Couleur de base (`#rrggbb`). */
  @property({ type: String }) base = "#2f6fdb";
  @property({ type: String }) rule: string = "complementary";
  /** Couleurs de la palette libre (`rule="custom"`) : liste JSON ou `#a, #b…`. */
  @property({ type: String }) colors = "";
  /** Nombre de couleurs (1..12) ; 0 : celui de la règle (5 en monochrome). */
  @property({ type: Number }) count = 0;
  /** Écart des teintes voisines (analogue, complémentaire divisée, rectangle), en degrés. */
  @property({ type: Number }) spread = 30;
  /** Écart de clarté entre nuances d'une même teinte (0,04..0,4). */
  @property({ type: Number }) step = 0.14;
  /** Rang choisi au départ (-1 : aucun). */
  @property({ type: Number }) selected = -1;
  /** Store qui reçoit la couleur choisie, type d'action (défaut `set`) et clé du payload (défaut `color`). */
  @property({ type: String }) target = "";
  @property({ type: String }) action = "set";
  @property({ type: String }) key = "color";
  /** Champs ajoutés au payload (objet JSON), ex. `{"tool":"paint"}`. */
  @property({ type: String }) payload = "";
  /** Le choix suit la palette : quand elle change, la couleur au même rang est renvoyée au store. */
  @property({ type: Boolean }) follow = true;
  /** `row`, `column` ou `grid` (`columns` colonnes). */
  @property({ type: String }) direction: "row" | "column" | "grid" = "row";
  @property({ type: Number }) columns = 2;
  @property({ type: String }) shape: "circle" | "square" = "circle";
  /** Diamètre des pastilles (px). */
  @property({ type: Number, attribute: "swatch-size" }) swatchSize = 26;
  /** Aucune pastille : calcule et publie seulement. */
  @property({ type: Boolean, reflect: true }) headless = false;
  @property({ type: String }) params = "";
  @property({ type: String }) control = "";
  /**
   * La base tirée par `random` / `rotate` est aussi écrite dans `params` (action `set`, clé `base`) : toute la
   * palette tient alors dans ce store, qu'on peut enregistrer et restaurer (ex. `settings-from` de sonic-sketch).
   * En palette libre, ce sont les couleurs tournées qui y sont écrites (clé `colors`).
   */
  @property({ type: Boolean, attribute: "write-base" }) writeBase = false;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private live: Record<string, unknown> = {};
  private items: PaletteColor[] = [];
  private index = -1;
  private unsubs: (() => void)[] = [];
  private triggers = { random: new CounterTrigger(), rotate: new CounterTrigger() };
  /** Base effective après `random` / `rotate` (prioritaire tant que `base` / `params.base` ne changent pas). */
  private override: string | null = null;
  /** Couleurs libres effectives après `random` / `rotate` (prioritaires tant que `colors` ne change pas). */
  private overrideColors: string[] | null = null;

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected willUpdate(c: Map<string | number | symbol, unknown>): void {
    if (c.has("params") || c.has("control")) this.listen();
    if (c.has("base")) this.override = null;
    if (c.has("colors")) this.overrideColors = null;
    if (c.has("selected") && this.index < 0) this.index = Math.round(this.selected);
    if (["base", "rule", "colors", "count", "spread", "step", "selected"].some((k) => c.has(k))) this.recompute();
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.triggers.random.reset();
    this.triggers.rotate.reset();
    if (this.params) {
      this.unsubs.push(listenDp(this.params, (v) => {
        const next = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
        if (next.base !== this.live.base) this.override = null;
        if (JSON.stringify(next.colors) !== JSON.stringify(this.live.colors)) this.overrideColors = null;
        this.live = next;
        if (typeof next.selected === "number") this.index = Math.round(next.selected);
        this.recompute();
        this.requestUpdate();
      }));
    }
    if (this.control) {
      this.unsubs.push(listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        if ("random" in c && this.triggers.random.feed(c.random)) this.shiftHue(Math.random() * 360);
        if ("rotate" in c && this.triggers.rotate.feed(c.rotate)) this.shiftHue(30);
      }));
    }
  }

  /** Réglages effectifs : `params` puis attributs. */
  settings(): { base: string; rule: PaletteRule; count: number; spread: number; step: number } {
    const L = this.live;
    const base = this.override ?? (parseHex(L.base) ? String(L.base) : parseHex(this.base) ? this.base : "#2f6fdb");
    const rule = sanitizePaletteRule(L.rule, sanitizePaletteRule(this.rule, "complementary"));
    const count = Math.round(num(L.count, 0, MAX_COLORS) ?? num(this.count, 0, MAX_COLORS) ?? 0);
    return { base, rule, count, spread: num(L.spread, 5, 90) ?? num(this.spread, 5, 90) ?? 30, step: num(L.step, 0.04, 0.4) ?? num(this.step, 0.04, 0.4) ?? 0.14 };
  }

  /** Couleurs de la palette libre : rotation en cours, puis `params.colors`, puis l'attribut. */
  customColors(): string[] {
    if (this.overrideColors) return this.overrideColors;
    const live = parseColorList(this.live.colors);
    return live.length ? live : parseColorList(this.colors);
  }

  private shiftHue(deg: number): void {
    const s = this.settings();
    if (s.rule === "custom") {
      const cols = this.customColors();
      if (!cols.length) return;
      this.overrideColors = customPalette(cols, deg).map((c) => c.hex);
      if (this.writeBase && this.params) dispatch(this.params, { type: "set", payload: { colors: this.overrideColors } });
      this.recompute();
      this.requestUpdate();
      return;
    }
    const o = rgbToOklch(parseHex(s.base)!);
    this.override = oklchToHex({ ...o, h: o.h + deg });
    if (this.writeBase && this.params) dispatch(this.params, { type: "set", payload: { base: this.override } });
    this.recompute();
    this.requestUpdate();
  }

  /** Recalcule la palette ; si le choix suit (`follow`) et que sa couleur a changé, la renvoie au store. */
  private recompute(): void {
    const s = this.settings();
    const before = this.items[this.index]?.hex;
    if (s.rule === "custom") {
      const cols = this.customColors();
      // Sans couleurs, la palette libre retombe sur l'harmonie complémentaire de la base.
      this.items = cols.length ? customPalette(cols) : harmony({ base: s.base, rule: "complementary", count: s.count || undefined, spread: s.spread, step: s.step });
    } else this.items = harmony({ base: s.base, rule: s.rule, count: s.count || undefined, spread: s.spread, step: s.step });
    if (this.index >= this.items.length) this.index = this.items.length - 1;
    const after = this.items[this.index]?.hex;
    if (this.follow && after && after !== before) this.send(after);
    this.publish();
  }

  private send(hex: string): void {
    if (!this.target) return;
    let extra: Record<string, unknown> = {};
    if (this.payload) {
      try { const p = JSON.parse(this.payload); if (p && typeof p === "object" && !Array.isArray(p)) extra = p; } catch { /* payload invalide : ignoré */ }
    }
    dispatch(this.target, { type: this.action || "set", payload: { ...extra, [this.key || "color"]: hex } });
  }

  private pick(i: number): void {
    this.index = i;
    const hex = this.items[i]?.hex;
    if (hex) this.send(hex);
    this.publish();
    this.requestUpdate();
  }

  getState(): PaletteState {
    const s = this.settings();
    const sel = this.items[this.index]?.hex ?? null;
    return { status: "ready", ...s, count: this.items.length, colors: this.items.map((i) => i.hex), items: this.items, selected: sel, selectedIndex: sel ? this.index : -1 };
  }

  private publish(): void {
    if (this.outDataProvider) set(this.outDataProvider, this.getState());
  }

  private onKey(e: KeyboardEvent, i: number): void {
    const n = this.items.length;
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d || !n) return;
    e.preventDefault();
    const j = (i + d + n) % n;
    this.pick(j);
    (this.renderRoot.querySelectorAll("button")[j] as HTMLElement | undefined)?.focus();
  }

  render() {
    if (this.headless) return nothing;
    const dir = this.direction === "column" || this.direction === "grid" ? this.direction : "row";
    const vars = { "--palette-size": `${Math.max(12, Math.min(96, this.swatchSize || 26))}px`, "--palette-columns": String(Math.max(1, Math.min(12, Math.round(this.columns) || 2))) };
    return html`<div class="sw ${dir} ${this.shape === "square" ? "square" : ""}" role="group" aria-label="Palette" style=${styleMap(vars)}>
      ${this.items.map((c, i) => html`<button
        type="button"
        aria-label=${`Couleur ${i + 1} : ${c.hex}`}
        aria-pressed=${i === this.index ? "true" : "false"}
        title=${c.hex}
        style=${styleMap({ background: c.hex })}
        @click=${() => this.pick(i)}
        @keydown=${(e: KeyboardEvent) => this.onKey(e, i)}
      ></button>`)}
    </div>`;
  }
}

