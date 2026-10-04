import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SoundEngine } from "./engine";
import { registerEngine, unregisterEngine } from "./registry";
import type { SoundState } from "./types";

const tagName = "sonic-sound";

type Unsub = () => void;

function plain(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * Système son léger pour jeux et interfaces, entièrement piloté par DataProvider.
 *
 * - `bank` / `bank-provider` : banque (bruitages + musiques) en JSON
 * - `control` : DataProvider de pilotage (musique, volumes, pause, compteurs `play`)
 * - `out-data-provider` : état complet publié (déverrouillage, position musicale, erreurs…)
 */
@customElement(tagName)
export class SonicSound extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  /** Identifiant du moteur (pour `sonic-sfx engine="…"`). */
  @property({ type: String })
  id = "";

  /** Banque inline (objet { sfx, songs }). */
  @property({ type: Object })
  bank: unknown = null;

  /** DataProvider contenant une banque ; fusionnée par-dessus `bank`. */
  @property({ type: String, attribute: "bank-provider" })
  bankProvider = "";

  /** DataProvider de pilotage (chemins pointés acceptés : `game.sound`). */
  @property({ type: String })
  control = "";

  /** DataProvider où publier l'état (défaut : `<id>State`, ou `soundState`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  /** Polyphonie maximale des bruitages. */
  @property({ type: Number, attribute: "max-voices" })
  maxVoices = 32;

  private engine: SoundEngine | null = null;
  private unsubs: Unsub[] = [];
  private providedBank: unknown = null;

  /** Accès au moteur (tests, intégrations JS). */
  get soundEngine(): SoundEngine | null {
    return this.engine;
  }

  private outId(): string {
    return (this.outDataProvider || (this.id ? `${this.id}State` : "soundState")).trim();
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.boot();
  }

  disconnectedCallback(): void {
    this.teardown();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (!this.engine) return;
    if (changed.has("id") || changed.has("outDataProvider")) {
      this.teardown();
      this.boot();
      return;
    }
    if (changed.has("maxVoices")) this.engine.maxVoices = this.maxVoices;
    if (changed.has("bank")) this.pushBank();
    if (changed.has("bankProvider") || changed.has("control")) this.subscribe();
  }

  private boot(): void {
    const out = this.outId();
    this.engine = new SoundEngine({
      id: this.id || "default",
      maxVoices: this.maxVoices,
      onState: (state: SoundState) => set(out, state),
    });
    registerEngine(this.engine);
    this.pushBank();
    this.subscribe();
  }

  private teardown(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.engine) {
      unregisterEngine(this.engine);
      this.engine.destroy();
    }
    this.engine = null;
  }

  private subscribe(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.providedBank = null;
    if (this.bankProvider) {
      this.unsubs.push(
        this.listen(this.bankProvider, (v) => {
          this.providedBank = plain(v);
          this.pushBank();
        }),
      );
    }
    if (this.control) {
      this.unsubs.push(this.listen(this.control, (v) => this.engine?.applyControl(plain(v))));
    }
  }

  private listen(id: string, handler: (v: unknown) => void): Unsub {
    const provider = dp(id);
    provider.onAssign(handler);
    return () => provider.offAssign(handler);
  }

  private pushBank(): void {
    if (!this.engine) return;
    const inline = (plain(this.bank) ?? {}) as Record<string, Record<string, unknown>>;
    const provided = (this.providedBank ?? {}) as Record<string, Record<string, unknown>>;
    const isEmpty = (o: object) => !o || Object.keys(o).length === 0;
    this.engine.setBank(
      isEmpty(inline) && isEmpty(provided)
        ? null
        : {
            sfx: { ...(inline.sfx ?? {}), ...(provided.sfx ?? {}) },
            songs: { ...(inline.songs ?? {}), ...(provided.songs ?? {}) },
          },
    );
  }

  render() {
    return html``;
  }
}

export default SonicSound;
