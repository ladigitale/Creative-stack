import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { dispatch } from "./registry";
import { TriggerMachine, matchesRule, readPath, type TriggerRule } from "./trigger-core";
import { parseRange, parseScale, quantizeNote } from "./motion-core";
import type { SonicNoteEvent } from "../../shared/audio/contracts";

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
  /** Dernière note MIDI émise (null sans émission) et sa vélocité. */
  note: number | null;
  vel: number;
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

  /**
   * Sortie MIDI directe : `note` (note de durée `dur-s`) ou `noteOn` (tenue jusqu'au retour à faux, puis noteOff).
   * Vide : aucune. À brancher sur `events` / `trigger` d'un `sonic-midi` (ou de tout instrument via un DP).
   */
  @property({ type: String })
  emit: "" | "note" | "noteOn" = "";

  /** DataProvider qui reçoit la liste d'événements (`events` de sonic-midi). */
  @property({ type: String, attribute: "emit-provider" })
  emitProvider = "";

  /** DataProvider compteur incrémenté après chaque émission (`trigger` de sonic-midi). */
  @property({ type: String, attribute: "emit-trigger" })
  emitTrigger = "";

  /** Note fixe (nom « C4 » ou numéro MIDI) quand `note-key` est vide. */
  @property({ type: String })
  note = "60";

  /** Chemin d'une valeur 0..1 dans la source qui choisit la hauteur (calée sur `note-range` et `scale`). */
  @property({ type: String, attribute: "note-key" })
  noteKey = "";

  /** Plage de notes MIDI « bas,haut » pour `note-key`. */
  @property({ type: String, attribute: "note-range" })
  noteRange = "48,72";

  /** Gamme en demi-tons depuis la note basse : « 0,2,4,7,9 » ; vide : chromatique. */
  @property({ type: String })
  scale = "";

  /** DataProvider dont une valeur 0..1 donne la vélocité (sortie de `sonic-motion`). */
  @property({ type: String, attribute: "vel-source" })
  velSource = "";

  /** Chemin de la vélocité dans `vel-source`. */
  @property({ type: String, attribute: "vel-key" })
  velKey = "vel";

  /** Vélocité minimale (0..1), et valeur par défaut sans `vel-source`. */
  @property({ type: Number, attribute: "vel-min" })
  velMin = 0.3;

  /** Durée (s) des notes `emit="note"`. */
  @property({ type: Number, attribute: "dur-s" })
  durS = 0.25;

  /** Canal MIDI (1..16) ; 0 : celui de sonic-midi. */
  @property({ type: Number })
  ch = 0;

  /** DataProvider où publier {active, armed, count, value}. */
  @property({ type: String, attribute: "state-provider" })
  stateProvider = "";

  private machine = new TriggerMachine({ holdMs: 0, cooldownMs: 1000, mode: "edge" });
  private unlisten: (() => void) | null = null;
  private timer: number | null = null;
  private data: unknown = undefined;
  private published = "";
  private velData: unknown = undefined;
  private unlistenVel: (() => void) | null = null;
  private emitCount = 0;
  private held: string | number | null = null;
  /** Dernière note émise (nombre MIDI) et dernière vélocité, publiées dans l'état. */
  lastNote: number | null = null;
  lastVel = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.listenVelocity();
    this.initEmit();
    this.timer = window.setInterval(() => this.evaluate(), POLL_MS);
  }

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.unlistenVel?.();
    this.unlistenVel = null;
    if (this.held !== null) this.emitEvents([{ type: "noteOff", note: this.held }]);
    this.held = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("source")) this.listen();
    if (changed.has("velSource")) this.listenVelocity();
    if (changed.has("emitTrigger")) this.initEmit();
    if (changed.has("disabled") && this.disabled) {
      this.machine.step(performance.now(), false);
      this.emitEnd();
    }
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

  private listenVelocity(): void {
    this.unlistenVel?.();
    this.unlistenVel = null;
    this.velData = undefined;
    const path = this.velSource.trim();
    if (!path) return;
    this.unlistenVel = listenDp(path, (v) => {
      this.velData = v;
    });
  }

  /** Le compteur part de 0 : sonic-midi mémorise sa première valeur sans rien envoyer. */
  private initEmit(): void {
    const t = this.emitTrigger.trim();
    if (t) set(t, this.emitCount);
  }

  private velocity(): number {
    const floor = Math.min(1, Math.max(0, Number(this.velMin) || 0));
    if (!this.velSource.trim()) return floor > 0 ? floor : 0.8;
    // Même DataProvider que la source : sa valeur vient d'arriver, le cache de vel-source n'est pas encore à jour.
    const fresh = this.velSource.trim() === this.source.trim() ? this.data : this.velData;
    const raw = readPath(fresh, this.velKey.trim() || "vel");
    const n = typeof raw === "number" ? raw : Number(raw);
    const v = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
    return Math.round((floor + (1 - floor) * v) * 1000) / 1000;
  }

  private pickNote(source: unknown): string | number {
    const key = this.noteKey.trim();
    if (!key) {
      const n = Number(this.note);
      return Number.isFinite(n) && String(this.note).trim() !== "" ? Math.round(n) : this.note.trim() || 60;
    }
    const raw = readPath(source, key);
    const v = typeof raw === "number" ? raw : Number(raw);
    const [lo, hi] = parseRange(this.noteRange) ?? [48, 72];
    return quantizeNote(v, lo, hi, parseScale(this.scale));
  }

  private emitEvents(list: SonicNoteEvent[]): void {
    const p = this.emitProvider.trim();
    if (!p || !list.length) return;
    set(p, list);
    const t = this.emitTrigger.trim();
    if (t) set(t, ++this.emitCount);
  }

  private emitFire(source: unknown): void {
    if (!this.emit) return;
    if (this.held !== null) this.emitEvents([{ type: "noteOff", note: this.held }]);
    const note = this.pickNote(source);
    const vel = this.velocity();
    const ch = Math.round(Number(this.ch) || 0);
    const ev: SonicNoteEvent = this.emit === "noteOn" ? { type: "noteOn", note, vel } : { type: "note", note, vel, durS: Number(this.durS) > 0 ? Number(this.durS) : 0.25 };
    if (ch >= 1 && ch <= 16) (ev as SonicNoteEvent & { ch?: number }).ch = ch;
    this.held = this.emit === "noteOn" ? note : null;
    if (typeof note === "number") this.lastNote = note;
    this.lastVel = vel;
    this.emitEvents([ev]);
  }

  private emitEnd(): void {
    if (this.held === null) return;
    const note = this.held;
    this.held = null;
    this.emitEvents([{ type: "noteOff", note }]);
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
      if (ev === "fire") this.emitFire(this.data);
      else this.emitEnd();
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
    const state: TriggerState = { active: this.machine.active, armed: this.machine.armed, count: this.machine.count, value: value ?? null, note: this.lastNote, vel: this.lastVel };
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    set(sp, state);
  }
}
