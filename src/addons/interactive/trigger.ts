import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { bool, num } from "../../shared/media/control";
import { dispatch } from "./registry";
import { TriggerMachine, matchesRule, readPath, type TriggerRule } from "./trigger-core";
import { parseRange, parseScale, quantizeNote } from "./motion-core";
import type { SonicNoteEvent } from "../../shared/audio/contracts";

const tagName = "sonic-trigger";

/** Pas de la boucle qui confirme le maintien et le repos quand la valeur ne change plus. */
const POLL_MS = 100;
const MAX_PAYLOAD_CHARS = 2000;

/** Réglages effectifs (attributs, puis `params` : le dernier l'emporte). */
export type TriggerSettings = TriggerRule & {
  holdMs: number;
  cooldownMs: number;
  mode: "edge" | "repeat";
  disabled: boolean;
};

const RULE_KEYS = ["equals", "not", "gt", "gte", "lt", "lte"] as const;
const NUMERIC_KEYS = ["gt", "gte", "lt", "lte"] as const;
const MAX_MS = 3_600_000;

/**
 * Lit le DP `params` : `{ equals, not, gt, gte, lt, lte, truthy, holdMs, cooldownMs, mode, disabled }`.
 * Opérateurs : chaîne ou nombre (`""` ou `null` : opérateur retiré) ; durées bornées à 0..1 h.
 * `invalid` liste les clés reconnues mais refusées (signalées dans `error`).
 */
export function readTriggerParams(v: unknown): { settings: Partial<TriggerSettings>; invalid: string[] } {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: Partial<TriggerSettings> = {};
  const invalid: string[] = [];
  for (const k of RULE_KEYS) {
    if (!(k in p)) continue;
    const x = p[k];
    if (x === null || x === "") o[k] = "";
    else if (typeof x === "string" || (typeof x === "number" && Number.isFinite(x)) || typeof x === "boolean") o[k] = String(x);
    else invalid.push(k);
  }
  const truthy = bool(p.truthy); if (truthy !== undefined) o.truthy = truthy;
  const hold = num(p.holdMs, 0, MAX_MS); if (hold !== undefined) o.holdMs = hold;
  const cool = num(p.cooldownMs, 0, MAX_MS); if (cool !== undefined) o.cooldownMs = cool;
  if (p.mode === "edge" || p.mode === "repeat") o.mode = p.mode;
  else if (p.mode !== undefined && p.mode !== null && p.mode !== "") invalid.push("mode");
  const disabled = bool(p.disabled); if (disabled !== undefined) o.disabled = disabled;
  return { settings: o, invalid };
}

export type TriggerState = {
  /** `idle` : pas de source ou surveillance suspendue ; `ready` : surveillance active ; `error` : réglage invalide. */
  status: "idle" | "ready" | "error";
  /** Réglage invalide (seuil non numérique, mode inconnu, charge utile illisible…), sinon null. */
  error: string | null;
  disabled: boolean;
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
  settings: TriggerSettings;
};

/**
 * Relie un capteur à une action : surveille une valeur d'un DataProvider (sortie d'un tracker, d'un micro, d'un
 * store…) et, quand la condition est vraie (seuil, égalité, valeur vraie) assez longtemps, envoie une action à un
 * `sonic-store`. Un seul déclenchement par franchissement (il faut repasser à faux pour le réarmer), avec un délai
 * de repos ; `mode="repeat"` répète à chaque repos tant que la condition tient. Le store décide de la suite
 * (compteur, alerte, journal, envoi dans une collecte). Pas d'évaluation de code : opérateurs fixes uniquement.
 * Condition et minutage réglables en direct par le DP `params` (prioritaire sur les attributs).
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

  /** DataProvider où publier l'état {status, error, active, armed, count, value…}. */
  @property({ type: String, attribute: "state-provider" })
  stateProvider = "";

  /** Même rôle que `state-provider` (convention des autres composants) ; les deux peuvent coexister. */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  /** DP de réglages en direct : `{ equals, not, gt, gte, lt, lte, truthy, holdMs, cooldownMs, mode, disabled }`. */
  @property({ type: String })
  params = "";

  private machine = new TriggerMachine({ holdMs: 0, cooldownMs: 1000, mode: "edge" });
  private unlisten: (() => void) | null = null;
  private timer: number | null = null;
  private data: unknown = undefined;
  private published = "";
  private velData: unknown = undefined;
  private unlistenVel: (() => void) | null = null;
  private emitCount = 0;
  private live: Partial<TriggerSettings> = {};
  private liveInvalid: string[] = [];
  private unlistenParams: (() => void) | null = null;
  private held: string | number | null = null;
  /** Dernière note émise (nombre MIDI) et dernière vélocité, publiées dans l'état. */
  lastNote: number | null = null;
  lastVel = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.listenVelocity();
    this.listenParams();
    this.initEmit();
    this.timer = window.setInterval(() => this.evaluate(), POLL_MS);
  }

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.unlistenVel?.();
    this.unlistenVel = null;
    this.unlistenParams?.();
    this.unlistenParams = null;
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
    if (changed.has("params") && changed.get("params") !== undefined && this.isConnected) this.listenParams();
    if (changed.has("disabled") && this.settings().disabled) this.suspend();
    if (changed.has("stateProvider") || changed.has("outDataProvider")) {
      this.published = "";
      this.publish(readPath(this.data, this.key));
    }
  }

  /** Réglages effectifs (attributs, puis `params`). */
  settings(): TriggerSettings {
    const s = { ...this.rule(), holdMs: this.holdMs, cooldownMs: this.cooldownMs, mode: this.mode, disabled: this.disabled, ...this.live };
    return {
      ...s,
      holdMs: Math.max(0, Number(s.holdMs) || 0),
      cooldownMs: Math.max(0, Number(s.cooldownMs) || 0),
      mode: s.mode === "repeat" ? "repeat" : "edge",
      disabled: !!s.disabled,
      truthy: !!s.truthy,
    };
  }

  /** Coupe un épisode en cours (suspension) : relâche la note tenue. */
  private suspend(): void {
    this.machine.step(performance.now(), false);
    this.emitEnd();
  }

  private listenParams(): void {
    this.unlistenParams?.();
    this.unlistenParams = null;
    this.live = {};
    this.liveInvalid = [];
    const path = this.params.trim();
    if (!path) return;
    this.unlistenParams = listenDp(path, (v) => {
      const wasDisabled = this.settings().disabled;
      const { settings, invalid } = readTriggerParams(v);
      this.live = settings;
      this.liveInvalid = invalid;
      if (!wasDisabled && this.settings().disabled) this.suspend();
      this.evaluate();
    });
  }

  /** Premier problème de réglage, ou null. */
  private configError(s: TriggerSettings): string | null {
    if (this.liveInvalid.length) return `params : valeur refusée pour ${this.liveInvalid.join(", ")}`;
    for (const k of NUMERIC_KEYS) {
      if (s[k] !== "" && !Number.isFinite(Number(s[k]))) return `${k} : nombre attendu (reçu "${s[k]}")`;
    }
    if (this.mode !== "edge" && this.mode !== "repeat" && this.live.mode === undefined) return `mode inconnu : "${String(this.mode)}" (edge | repeat)`;
    const raw = this.payload.trim();
    if (raw) {
      if (raw.length > MAX_PAYLOAD_CHARS) return `payload trop long (> ${MAX_PAYLOAD_CHARS} caractères) : ignoré`;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "payload : objet JSON attendu, ignoré";
      } catch {
        return "payload : JSON illisible, ignoré";
      }
    }
    return null;
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
    const s = this.settings();
    this.machine.opts = { holdMs: s.holdMs, cooldownMs: s.cooldownMs, mode: s.mode };
    const value = readPath(this.data, this.key);
    const on = !s.disabled && matchesRule(value, s);
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

  /** État courant (aussi publié dans `state-provider` / `out-data-provider`). */
  getState(): TriggerState {
    const settings = this.settings();
    const error = this.configError(settings);
    const status: TriggerState["status"] = error ? "error" : !this.source.trim() || settings.disabled ? "idle" : "ready";
    return {
      status, error, disabled: settings.disabled,
      active: this.machine.active, armed: this.machine.armed, count: this.machine.count,
      value: readPath(this.data, this.key) ?? null, note: this.lastNote, vel: this.lastVel, settings,
    };
  }

  private publish(value: unknown): void {
    const targets = [...new Set([this.stateProvider.trim(), this.outDataProvider.trim()].filter(Boolean))];
    if (!targets.length) return;
    const state: TriggerState = { ...this.getState(), value: value ?? null };
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    for (const t of targets) set(t, state);
  }
}
