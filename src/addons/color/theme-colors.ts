import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { deriveTheme, sanitizeMode, type Theme } from "./theme";

/**
 * Thème d'interface calculé depuis une couleur de fond : `sonic-theme-colors` publie dans `out-data-provider`
 * l'objet `{ "--sc-base": "#…", "--sc-primary": "#…", …, "color-scheme": "dark" }` (plus `base` et `mode`
 * effectifs). Branché sur `sonic-css-vars source="…"`, il habille toute l'interface.
 *
 * Réglages en direct par `params` (DP objet) sinon attributs : `mode` (`dark` | `light`, ou `sombre` | `clair`),
 * `base` (fond du mode courant) ou `baseDark` / `baseLight` (un fond par mode, qui se mémorise en changeant de
 * mode), `rule` (`split`, `complementary`, `analogous`, `triadic`).
 */
@customElement("sonic-theme-colors")
export class SonicThemeColors extends LitElement {
  static styles = css`:host { display: none; }`;

  @property({ type: String }) base = "";
  @property({ type: String, attribute: "base-dark" }) baseDark = "";
  @property({ type: String, attribute: "base-light" }) baseLight = "";
  @property({ type: String }) mode = "";
  @property({ type: String }) rule = "split";
  @property({ type: String }) params = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private live: Record<string, unknown> = {};
  private off: (() => void) | null = null;
  private last = "";

  disconnectedCallback(): void {
    this.off?.();
    this.off = null;
    super.disconnectedCallback();
  }

  protected willUpdate(c: Map<string | number | symbol, unknown>): void {
    if (c.has("params")) this.listen();
    if (["base", "baseDark", "baseLight", "mode", "rule", "outDataProvider"].some((k) => c.has(k))) this.publish();
  }

  private listen(): void {
    this.off?.();
    this.off = null;
    this.live = {};
    if (!this.params) return;
    this.off = listenDp(this.params, (v) => {
      this.live = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      this.publish();
    });
  }

  /** Réglages effectifs : `params` puis attributs ; le fond est celui du mode (`baseDark` / `baseLight`), sinon `base`. */
  theme(): Theme {
    const L = this.live;
    const mode = sanitizeMode(L.mode) ?? sanitizeMode(this.mode);
    const own = mode === "light" ? [L.baseLight, this.baseLight] : mode === "dark" ? [L.baseDark, this.baseDark] : [];
    const base = [...own, L.base, this.base].find((v) => typeof v === "string" && v.trim() !== "");
    return deriveTheme({ base, mode, rule: L.rule ?? this.rule });
  }

  private publish(): void {
    if (!this.outDataProvider) return;
    const t = this.theme();
    const out = { ...t.vars, base: t.base, mode: t.mode };
    const key = JSON.stringify(out);
    if (key === this.last) return;
    this.last = key;
    set(this.outDataProvider, out);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sonic-theme-colors": SonicThemeColors;
  }
}
