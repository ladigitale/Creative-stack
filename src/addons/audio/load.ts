import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";

const tagName = "sonic-audio-load";

export type AudioLoadState = {
  status: "idle" | "ready" | "unsupported";
  /** Charge moyenne du rendu audio sur l'intervalle (0..1 ; 1 = le moteur n'a plus de marge). */
  average: number;
  /** Charge maximale sur l'intervalle (0..1+). */
  peak: number;
  /** Part des blocs rendus en retard (craquements). */
  underrun: number;
  /** Nombre de mises à jour reçues. */
  updates: number;
};

type CapacityEvent = Event & { averageLoad?: number; peakLoad?: number; underrunRatio?: number };
type RenderCapacity = EventTarget & { start(opts?: { updateInterval?: number }): void; stop(): void };

/**
 * Charge du moteur audio (« Render Capacity » de Chrome) publiée en DataProvider,
 * pour afficher un indicateur ou réduire la polyphonie / les effets quand elle sature.
 * `status: "unsupported"` si le navigateur ne la mesure pas.
 */
@customElement(tagName)
export class SonicAudioLoad extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Intervalle de mesure (s, 0.5..10). */
  @property({ type: Number })
  interval = 1;

  /** DataProvider de l'état (défaut : `<id>State`, sinon `audioLoad`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private capacity: RenderCapacity | null = null;
  private unsubscribe: (() => void) | null = null;
  private state: AudioLoadState = { status: "idle", average: 0, peak: 0, underrun: 0, updates: 0 };

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = AudioEngine.get().onChange(() => this.start());
    this.start();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stop();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("interval") && this.capacity) {
      this.stop();
      this.start();
    }
  }

  private onUpdate = (e: Event) => {
    const ev = e as CapacityEvent;
    this.state = {
      status: "ready",
      average: round(ev.averageLoad),
      peak: round(ev.peakLoad),
      underrun: round(ev.underrunRatio),
      updates: this.state.updates + 1,
    };
    this.publish();
  };

  private start(): void {
    if (this.capacity) return;
    const engine = AudioEngine.get();
    const ac = engine.context as (BaseAudioContext & { renderCapacity?: RenderCapacity }) | null;
    if (!engine.supported || (ac && !ac.renderCapacity)) {
      this.state = { ...this.state, status: "unsupported" };
      this.publish();
      return;
    }
    if (!ac?.renderCapacity) {
      this.publish();
      return;
    }
    this.capacity = ac.renderCapacity;
    this.capacity.addEventListener("update", this.onUpdate);
    try {
      this.capacity.start({ updateInterval: Math.min(10, Math.max(0.5, this.interval || 1)) });
    } catch {
      this.stop();
      this.state = { ...this.state, status: "unsupported" };
    }
    this.publish();
  }

  private stop(): void {
    if (!this.capacity) return;
    this.capacity.removeEventListener("update", this.onUpdate);
    try {
      this.capacity.stop();
    } catch {
      /* déjà arrêtée */
    }
    this.capacity = null;
  }

  getState(): AudioLoadState {
    return { ...this.state };
  }

  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "audioLoad")).trim();
    if (out) set(out, this.getState());
  }

  render() {
    return html``;
  }
}

function round(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

export default SonicAudioLoad;
