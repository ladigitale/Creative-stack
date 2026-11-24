import { customElement, property } from "lit/decorators.js";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { DeviceElement, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { listenDp, plain } from "../../shared/audio/dp";
import type { LaserOp } from "./toolpath";
import { FAMILIES, getPattern, patternParams, PATTERNS, type ParamSpec } from "./patterns";

const tagName = "sonic-laser-pattern";

export type PatternState = DeviceBaseState & {
  pattern: string;
  label: string;
  description: string;
  /** Paramètres effectifs (bornés) et leur description, pour construire un formulaire. */
  params: Record<string, number>;
  specs: ParamSpec[];
  /** SVG en millimètres réels : à donner à `sonic-gcode svg-from="<id>State"`. */
  svg: string;
  widthMm: number;
  heightMm: number;
  /** Réglages par couleur propres au modèle (grille d'essais), sinon `null`. */
  ops: LaserOp[] | null;
  notes: string[];
  seq: number;
  /** Modèles disponibles, avec leur famille (`families` : libellés). */
  catalog: { id: string; label: string; description: string; family: string }[];
  families: { id: string; label: string }[];
};

/**
 * Modèle paramétrique pour la découpe et la gravure laser : objets (boîte à encoches, engrenages, puzzle, tampon,
 * porte-clés, pendentif, dessous de verre, règle), motifs génératifs gravés au trait (arbre, corail, spirographe,
 * guilloché, rosace, Truchet, labyrinthe, champ de flux, harmonographe, ondes, motif répété), grille d'essais. Publie un SVG en millimètres réels
 * (noir = gravure, bleu = marquage, rouge = découpe) dans son état, lu par `sonic-gcode svg-from`.
 *
 * - `pattern` : identifiant du modèle ; `params` (DP) : `{ largeur: 60, … }` ; `control` (DP) : `{ pattern, params }`
 *   prioritaire. Les valeurs sont bornées et arrondies au pas du modèle (`specs`).
 */
@customElement(tagName)
export class SonicLaserPattern extends DeviceElement<PatternState> {
  @property({ type: String }) pattern = "pendentif";
  @property({ type: String }) params = "";

  protected feature = null;
  protected readonly defaultCommand = "build";
  protected state: PatternState = {
    status: "idle", error: null, supported: true, allowed: "unknown", active: false,
    pattern: "", label: "", description: "", params: {}, specs: [], svg: "", widthMm: 0, heightMm: 0, ops: null, notes: [], seq: 0,
    catalog: PATTERNS.map((p) => ({ id: p.id, label: p.label, description: p.description, family: p.family ?? "objets" })),
    families: FAMILIES,
  };

  private live: { pattern?: string; params?: Record<string, unknown> } = {};
  private fromParams: Record<string, unknown> = {};
  private offs: (() => void)[] = [];
  private lastKey = "";

  protected commands(): CommandMap {
    return { build: () => this.build(true) };
  }

  disconnectedCallback(): void {
    this.offs.forEach((o) => o());
    this.offs = [];
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    if (changed.has("control") || changed.has("params")) {
      this.offs.forEach((o) => o());
      this.offs = [];
      if (this.control) {
        const read = (v: unknown) => {
          const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
          this.live = { pattern: typeof o.pattern === "string" ? o.pattern : undefined, params: o.params && typeof o.params === "object" ? (o.params as Record<string, unknown>) : undefined };
          this.build(false);
        };
        read(plain(get(this.control)));
        this.offs.push(listenDp(this.control, read));
      }
      if (this.params) {
        const read = (v: unknown) => {
          this.fromParams = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
          this.build(false);
        };
        read(plain(get(this.params)));
        this.offs.push(listenDp(this.params, read));
      }
    }
    if (changed.has("pattern") || changed.has("params") || changed.has("control")) this.build(false);
  }

  build(force: boolean): boolean {
    const id = this.live.pattern || this.pattern;
    const def = getPattern(id);
    if (!def) {
      this.patch({ status: "error", error: `modèle inconnu : ${id} (connus : ${PATTERNS.map((p) => p.id).join(", ")})` });
      return false;
    }
    const params = patternParams(def, { ...this.fromParams, ...(this.live.params ?? {}) });
    const key = JSON.stringify([id, params]);
    if (!force && key === this.lastKey) return true;
    this.lastKey = key;
    try {
      const out = def.build(params);
      this.patch({
        status: "ready", error: null, active: true, pattern: def.id, label: def.label, description: def.description, params, specs: def.params,
        svg: out.svg, widthMm: Math.round(out.widthMm * 10) / 10, heightMm: Math.round(out.heightMm * 10) / 10, ops: out.ops ?? null, notes: out.notes, seq: this.state.seq + 1,
      });
      return true;
    } catch (e) {
      this.patch({ status: "error", error: e instanceof Error ? e.message : "modèle impossible à construire" });
      return false;
    }
  }
}

export default SonicLaserPattern;
