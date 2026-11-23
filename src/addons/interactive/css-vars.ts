import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";

const tagName = "sonic-css-vars";

const NAME = /^--sc-[a-z0-9-]{1,40}$/;
const REF = "var\\(--sc-[a-z0-9-]{1,40}\\)";
const HEX = "#[0-9a-f]{3,8}";
const COLOR = new RegExp(
  `^(${HEX}|rgba?\\(\\s*[0-9.,%\\s/]{3,40}\\)|hsla?\\(\\s*[0-9a-z.,%\\s/]{3,40}\\)|[a-z]{3,24}|${REF}` +
    `|color-mix\\(in srgb,\\s*(${REF}|${HEX})\\s+[0-9]{1,3}%,\\s*(${REF}|${HEX}|transparent)\\s*\\))$`,
  "i",
);

/** Vrai pour un nom de variable `--sc-*` et une valeur de couleur sans url(), sans dégradé, sans ; ni {}. */
export function isSafeVar(name: string, value: unknown): value is string | number {
  if (name === "color-scheme") return value === "light" || value === "dark" || value === "light dark";
  if (!NAME.test(name)) return false;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= 120 && COLOR.test(value.trim());
}

/**
 * Thème d'un artefact : applique à ses enfants les variables `--sc-*` (couleurs) lues dans un DataProvider.
 *
 * - `source` : chemin DP d'un objet `{"--sc-base": "#150a2e", "--sc-primary": "#ff7a1a", ...}` (typiquement la
 *   sortie d'un `sonic-jsonata` qui compose le thème depuis des réglages) ; `color-scheme` (light | dark) est
 *   aussi accepté.
 * - Seuls les noms `--sc-*` et des valeurs de couleur (#hex, rgb(), hsl(), nom, `var(--sc-*)`, `color-mix(in srgb, …)`)
 *   sont appliqués ; le reste est ignoré : jamais de style libre ni d'URL.
 *
 * Le composant est transparent (`display: contents`), le thème se transmet aux enfants par héritage CSS.
 */
@customElement(tagName)
export class SonicCssVars extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: String }) source = "";

  private off: (() => void) | null = null;
  private applied = new Set<string>();

  connectedCallback(): void {
    super.connectedCallback();
    this.bind();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.off?.();
    this.off = null;
    this.clear();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("source") && changed.get("source") !== undefined) this.bind();
  }

  private bind(): void {
    this.off?.();
    this.off = null;
    const path = this.source.trim();
    if (!path) {
      this.clear();
      return;
    }
    this.off = listenDp(path, (v) => this.apply(v));
    try {
      this.apply(plain((dp(path) as unknown as { get?: () => unknown }).get?.()));
    } catch {
      /* DP pas encore publié : le premier changement l'appliquera */
    }
  }

  private clear(): void {
    for (const n of this.applied) this.style.removeProperty(n);
    this.applied.clear();
  }

  private apply(v: unknown): void {
    const next = new Set<string>();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!isSafeVar(k, val)) continue;
        this.style.setProperty(k, typeof val === "string" ? val.trim() : String(val));
        next.add(k);
      }
    }
    for (const n of this.applied) if (!next.has(n)) this.style.removeProperty(n);
    this.applied = next;
  }

  render() {
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [tagName]: SonicCssVars;
  }
}
