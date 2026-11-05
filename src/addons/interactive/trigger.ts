import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { dispatch } from "./registry";
import { TriggerMachine, matchesRule, readPath, type TriggerRule } from "./trigger-core";

const tagName = "sonic-trigger";

/** Pas de la boucle qui confirme le maintien et le repos quand la valeur ne change plus. */
const POLL_MS = 100;
const MAX_PAYLOAD_CHARS = 2000;

export type TriggerState = {
  /** La condition est vraie à cet instant. */
  active: boolean;
  /** Un déclenchement est possible. */
  armed: boolean;
  /** Nombre de déclenchements depuis le chargement. */
  count: number;
  /** Dernière valeur lue. */
  value: unknown;
};

/**
 * Relie un capteur à une action : surveille une valeur d'un DataProvider (sortie d'un tracker, d'un micro, d'un
 * store…) et, quand la condition est vraie (seuil, égalité, valeur vraie) assez longtemps, envoie une action à un
 * `sonic-store`. Un seul déclenchement par franchissement (il faut repasser à faux pour le réarmer), avec un délai
 * de repos ; `mode="repeat"` répète à chaque repos tant que la condition tient. Le store décide de la suite
 * (compteur, alerte, journal, envoi dans une collecte). Pas d'évaluation de code : opérateurs fixes uniquement.
 */
@customElement(tagName)
export class SonicTrigger extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  /** DataProvider surveillé (son id, ou le `outputProvider` d'un tracker). */
  @property({ type: String })
  source = "";

  /** Chemin pointé dans la valeur (`labels.person`, `right.gesture`, `db`). Vide : la valeur entière. */
  @property({ type: String })
  key = "";

  @property({ type: String })
  equals = "";

  @property({ type: String })
  not = "";

  @property({ type: String })
  gt = "";

  @property({ type: String })
  gte = "";

  @property({ type: String })
  lt = "";

  @property({ type: String })
  lte = "";

  /** Valeur vraie (par défaut quand aucun opérateur n'est donné). */
  @property({ type: Boolean })
  truthy = false;

  /** Maintien : la condition doit durer ce temps (ms) avant de déclencher. */
  @property({ type: Number, attribute: "hold-ms" })
  holdMs = 0;

  /** Repos minimal entre deux déclenchements (ms). */
  @property({ type: Number, attribute: "cooldown-ms" })
  cooldownMs = 1000;

  /** `edge` (un par franchissement) ou `repeat`. */
  @property({ type: String })
  mode: "edge" | "repeat" = "edge";

  /** Id du `sonic-store` qui reçoit l'action. */
  @property({ type: String })
  target = "";

  /** Type de l'action envoyée au déclenchement. */
  @property({ type: String })
  type = "trigger";

  /** Type de l'action envoyée au retour à faux (après un déclenchement) ; vide : aucune. */
  @property({ type: String, attribute: "end-type" })
  endType = "";

  /** Charge utile fixe (JSON) ; `value` (valeur lue) et `count` (rang du déclenchement) y sont ajoutés. */
  @property({ type: String })
  payload = "";

  /** Suspend la surveillance sans la retirer. */
  @property({ type: Boolean })
  disabled = false;

  /** DataProvider où publier {active, armed, count, value}. */
  @property({ type: String, attribute: "state-provider" })
  stateProvider = "";

  private machine = new TriggerMachine({ holdMs: 0, cooldownMs: 1000, mode: "edge" });
  private unlisten: (() => void) | null = null;
  private timer: number | null = null;
  private data: unknown = undefined;
  private published = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.timer = window.setInterval(() => this.evaluate(), POLL_MS);
  }

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("source")) this.listen();
    if (changed.has("disabled") && this.disabled) this.machine.step(performance.now(), false);
  }

  render() {
    return html``;
  }

  private listen(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.data = undefined;
    const path = this.source.trim();
    if (!path) return;
    this.unlisten = listenDp(path, (v) => {
      this.data = v;
      this.evaluate();
    });
  }

  private rule(): TriggerRule {
    return { equals: this.equals, not: this.not, gt: this.gt, gte: this.gte, lt: this.lt, lte: this.lte, truthy: this.truthy };
  }

  /** Lit la valeur, avance la machine et émet les actions ; public pour les tests. */
  evaluate(now: number = performance.now()): void {
    this.machine.opts = {
      holdMs: Number(this.holdMs) || 0,
      cooldownMs: Number(this.cooldownMs) || 0,
      mode: this.mode === "repeat" ? "repeat" : "edge",
    };
    const value = readPath(this.data, this.key);
    const on = !this.disabled && matchesRule(value, this.rule());
    const events = this.machine.step(now, on);
    const target = this.target.trim();
    for (const ev of events) {
      if (!target) continue;
      if (ev === "fire") {
        dispatch(target, { type: this.type || "trigger", payload: this.buildPayload(value) });
      } else if (this.endType.trim()) {
        dispatch(target, { type: this.endType.trim(), payload: { value } });
      }
    }
    this.publish(value);
  }

  private buildPayload(value: unknown): Record<string, unknown> {
    let base: Record<string, unknown> = {};
    const raw = this.payload.trim();
    if (raw && raw.length <= MAX_PAYLOAD_CHARS) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
      } catch {
        /* charge utile illisible : ignorée */
      }
    }
    return { ...base, value: value ?? null, count: this.machine.count };
  }

  private publish(value: unknown): void {
    const sp = this.stateProvider.trim();
    if (!sp) return;
    const state: TriggerState = { active: this.machine.active, armed: this.machine.armed, count: this.machine.count, value: value ?? null };
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    set(sp, state);
  }
}
