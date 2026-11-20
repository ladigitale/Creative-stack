import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, bool, num } from "../../shared/media/control";
import type { LumaEdge } from "../../shared/media/luma";
import { MorseDecoder, morseEncode, morseNormalize, morseTimeline, type MorseStep } from "../../shared/media/morse";

const tagName = "sonic-morse";

export type MorseSettings = {
  /** Durée du point en ms. */
  unit: number;
  /** ms retirés à chaque éclat émis (et ajoutés au silence qui suit). */
  trim: number;
  /** Ajuste l'unité de réception aux durées observées. */
  autoUnit: boolean;
  /** Silence, en unités, qui termine un message reçu. */
  endUnits: number;
  /** ms pendant lesquels la réception reste coupée après une émission. */
  guardMs: number;
};

export type MorseState = {
  status: "idle" | "sending" | "receiving";
  /** État commandé de la lampe. */
  on: boolean;
  tx: { text: string; signs: string; chars: number; total: number; progress: number; queue: number };
  rx: { text: string; signs: string; unit: number };
  /** Dernier message reçu en entier. */
  lastReceived: string;
  /** Dernier message émis en entier. */
  lastSent: string;
  sent: number;
  received: number;
  settings: MorseSettings;
};

/**
 * Morse par la lumière, dans les deux sens.
 *
 * - Émission : à chaque hausse du compteur `send-from`, le texte lu dans `text-from` est émis en
 *   allumant et éteignant le booléen `drive` (ex. `lampe.torch`, `lampe` étant le DP `adjust` d'une
 *   `sonic-camera` : la torche du téléphone). Les messages s'enchaînent dans l'ordre.
 * - Réception : `source` = DP d'état d'une `sonic-luma` ; ses fronts sont décodés en texte. Un
 *   silence de `end-units` unités termine le message.
 * - Réception coupée pendant l'émission et `guard-ms` après : la lampe éclaire aussi sa propre caméra.
 *
 * Actions vers le store `target` : `morse:sent {text}` et `morse:message {text, unit}`.
 */
@customElement(tagName)
export class SonicMorse extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Durée du point en ms (défaut 300). Les deux appareils doivent s'accorder, sauf `auto-unit`. */
  @property({ type: Number })
  unit = 300;

  /** ms retirés à chaque éclat émis et ajoutés au silence suivant (lampe lente à s'éteindre). */
  @property({ type: Number })
  trim = 0;

  /** Chemin du booléen de DataProvider à allumer / éteindre (ex. `lampe.torch`). */
  @property({ type: String })
  drive = "";

  /** Chemin du texte à émettre. */
  @property({ type: String, attribute: "text-from" })
  textFrom = "";

  /** Chemin d'un compteur : chaque hausse émet le texte de `text-from`. */
  @property({ type: String, attribute: "send-from" })
  sendFrom = "";

  /** DataProvider d'état d'une `sonic-luma` (ex. `sondeState`). */
  @property({ type: String })
  source = "";

  /** Store qui reçoit `morse:sent` et `morse:message`. */
  @property({ type: String })
  target = "";

  /** Ajuste l'unité de réception aux durées observées. */
  @property({ type: Boolean, attribute: "auto-unit" })
  autoUnit = false;

  /** Silence, en unités, qui termine un message reçu (défaut 12). */
  @property({ type: Number, attribute: "end-units" })
  endUnits = 12;

  /** ms de réception coupée après une émission (défaut 800). */
  @property({ type: Number, attribute: "guard-ms" })
  guardMs = 800;

  /** DataProvider de réglages en direct {unit, trim, autoUnit, endUnits, guardMs}. */
  @property({ type: String })
  params = "";

  /** DataProvider de pilotage : `{cancel: compteur}` arrête l'émission et vide la file. */
  @property({ type: String })
  control = "";

  /** DataProvider de sortie (défaut `<id>State`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private live: Partial<MorseSettings> = {};
  private unsubs: (() => void)[] = [];
  private sendTrigger = new CounterTrigger();
  private cancelTrigger = new CounterTrigger();
  private queue: string[] = [];
  private steps: MorseStep[] = [];
  private stepIndex = 0;
  private stepAt = 0;
  private txTimer: ReturnType<typeof setTimeout> | null = null;
  private txText = "";
  private txChars = 0;
  private lampOn = false;
  private guardUntil = 0;
  private decoder = new MorseDecoder();
  private lastEdge = 0;
  private rxTimer: ReturnType<typeof setTimeout> | null = null;
  private silentSince = 0;
  private lastReceived = "";
  private lastSent = "";
  private sent = 0;
  private received = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.applySettings();
    this.publish();
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.stopTx();
    if (this.rxTimer) clearTimeout(this.rxTimer);
    this.rxTimer = null;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (["params", "control", "textFrom", "sendFrom", "source"].some((k) => c.has(k))) this.listen();
    this.applySettings();
  }

  settings(): MorseSettings {
    const base: MorseSettings = {
      unit: num(this.unit, 20, 5000) ?? 300,
      trim: num(this.trim, 0, 2000) ?? 0,
      autoUnit: Boolean(this.autoUnit),
      endUnits: num(this.endUnits, 8, 100) ?? 12,
      guardMs: num(this.guardMs, 0, 10000) ?? 800,
    };
    return { ...base, ...this.live };
  }

  getState(): MorseState {
    const sending = this.txTimer !== null;
    const total = morseNormalize(this.txText).length;
    return {
      status: sending ? "sending" : this.decoder.text || this.decoder.signs ? "receiving" : "idle",
      on: this.lampOn,
      tx: {
        text: this.txText,
        signs: morseEncode(this.txText),
        chars: this.txChars,
        total,
        progress: total ? Math.round((this.txChars / total) * 100) / 100 : 0,
        queue: this.queue.length,
      },
      rx: { text: this.decoder.text, signs: this.decoder.signs, unit: Math.round(this.decoder.unit) },
      lastReceived: this.lastReceived,
      lastSent: this.lastSent,
      sent: this.sent,
      received: this.received,
      settings: this.settings(),
    };
  }

  /** Met `text` dans la file d'émission (émis tout de suite si rien n'est en cours). */
  send(text: string): void {
    const clean = morseNormalize(text);
    if (!clean) return;
    this.queue.push(clean);
    if (this.txTimer === null) this.next();
    else this.publish();
  }

  /** Arrête l'émission en cours et vide la file. */
  cancel(): void {
    this.queue = [];
    this.stopTx();
    this.publish();
  }

  /* ------------------------------- émission ------------------------------- */

  private next(): void {
    const text = this.queue.shift();
    if (text === undefined) {
      this.publish();
      return;
    }
    const s = this.settings();
    this.txText = text;
    this.txChars = 0;
    this.steps = morseTimeline(text, s.unit, s.trim);
    this.stepIndex = 0;
    this.stepAt = performance.now();
    this.resetRx();
    this.step();
  }

  /** Applique le pas courant puis programme le suivant sur l'horloge absolue (pas de dérive cumulée). */
  private step(): void {
    const cur = this.steps[this.stepIndex];
    if (!cur) {
      this.finish();
      return;
    }
    this.stepAt += cur.ms;
    this.txTimer = setTimeout(() => {
      this.txChars = cur.chars;
      this.stepIndex++;
      this.step();
    }, Math.max(0, this.stepAt - performance.now()));
    this.lamp(cur.on);
    this.publish();
  }

  private finish(): void {
    this.txTimer = null;
    this.lamp(false);
    this.guardUntil = performance.now() + this.settings().guardMs;
    this.lastSent = this.txText;
    this.sent++;
    this.txChars = morseNormalize(this.txText).length;
    const target = this.target.trim();
    if (target) dispatch(target, { type: "morse:sent", payload: { text: this.txText } });
    this.dispatchEvent(new CustomEvent("morse-sent", { detail: { text: this.txText }, bubbles: true, composed: true }));
    if (this.queue.length) this.next();
    else this.publish();
  }

  private stopTx(): void {
    if (this.txTimer) clearTimeout(this.txTimer);
    const was = this.txTimer !== null;
    this.txTimer = null;
    this.steps = [];
    if (was || this.lampOn) {
      this.lamp(false);
      this.guardUntil = performance.now() + this.settings().guardMs;
    }
  }

  /** Écrit l'état de la lampe dans le booléen `drive` (clé d'un objet de DataProvider, ou DataProvider entier). */
  private lamp(on: boolean): void {
    this.lampOn = on;
    const path = this.drive.trim();
    if (!path) return;
    const cut = path.lastIndexOf(".");
    if (cut < 0) {
      set(path, on);
      return;
    }
    const name = path.slice(0, cut);
    const key = path.slice(cut + 1);
    const cur = dp(name).get();
    set(name, { ...(cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {}), [key]: on });
  }

  /* ------------------------------- réception ------------------------------ */

  private resetRx(): void {
    this.decoder.reset();
    if (this.rxTimer) clearTimeout(this.rxTimer);
    this.rxTimer = null;
  }

  /** Front vu par la sonde. Ignoré pendant l'émission et juste après. */
  feedEdge(edge: LumaEdge): void {
    if (this.txTimer !== null || performance.now() < this.guardUntil) return;
    if (edge.on) {
      if (this.rxTimer) clearTimeout(this.rxTimer);
      this.rxTimer = null;
      if (edge.dur > 0) this.decoder.silence(edge.dur);
    } else {
      this.decoder.light(edge.dur);
      this.silentSince = performance.now();
      this.watchSilence();
    }
    this.publish();
  }

  /** Pendant un silence : clôt la lettre à 2 unités, le mot à 5, le message à `endUnits`. */
  private watchSilence(): void {
    if (this.rxTimer) clearTimeout(this.rxTimer);
    const unit = this.decoder.unit;
    const end = this.settings().endUnits;
    const marks = [2, 5, end].map((u) => u * unit);
    const tick = () => {
      const quiet = performance.now() - this.silentSince;
      this.decoder.silence(quiet);
      if (quiet >= end * unit) {
        this.rxTimer = null;
        this.complete();
        return;
      }
      this.publish();
      const nextMark = marks.find((m) => m > quiet) ?? end * unit;
      this.rxTimer = setTimeout(tick, Math.max(10, nextMark - quiet + 5));
    };
    this.rxTimer = setTimeout(tick, marks[0] + 5);
  }

  private complete(): void {
    const text = this.decoder.text.trim();
    const unit = Math.round(this.decoder.unit);
    this.decoder.text = "";
    this.decoder.signs = "";
    if (text) {
      this.lastReceived = text;
      this.received++;
      const target = this.target.trim();
      if (target) dispatch(target, { type: "morse:message", payload: { text, unit } });
      this.dispatchEvent(new CustomEvent("morse-message", { detail: { text, unit }, bubbles: true, composed: true }));
    }
    this.publish();
  }

  /* -------------------------------- câblage ------------------------------- */

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.sendTrigger.reset();
    this.cancelTrigger.reset();
    this.live = {};
    if (this.params) {
      this.unsubs.push(
        listenDp(this.params, (v) => {
          this.live = readParams(v);
          this.applySettings();
          this.publish();
        }),
      );
    }
    if (this.control) {
      this.unsubs.push(
        listenDp(this.control, (v) => {
          if (this.cancelTrigger.feed((v as { cancel?: unknown } | null)?.cancel)) this.cancel();
        }),
      );
    }
    if (this.sendFrom) {
      // Référence prise tout de suite : un compteur à 0 n'est pas toujours annoncé à l'abonnement.
      this.sendTrigger.feed(dp(this.sendFrom).get());
      this.unsubs.push(
        listenDp(this.sendFrom, (v) => {
          if (!this.sendTrigger.feed(v)) return;
          // Texte relu au moment de l'envoi : il peut arriver dans la même publication que le compteur.
          const text = this.textFrom ? dp(this.textFrom).get() : "";
          this.send(typeof text === "string" ? text : "");
        }),
      );
    }
    if (this.source) {
      this.lastEdge = 0;
      const since = performance.now();
      this.unsubs.push(
        listenDp(this.source, (v) => {
          const events = (v as { events?: LumaEdge[] } | null)?.events;
          if (!Array.isArray(events)) return;
          const newest = events.length ? events[events.length - 1].n : 0;
          if (newest < this.lastEdge) this.lastEdge = 0; // sonde remise à zéro
          for (const e of events) {
            if (e.n <= this.lastEdge) continue;
            this.lastEdge = e.n;
            if (e.t >= since) this.feedEdge(e); // les fronts d'avant le branchement ne comptent pas
          }
        }),
      );
    }
  }

  private applySettings(): void {
    const s = this.settings();
    this.decoder.opts.autoUnit = s.autoUnit;
    if (this.decoder.opts.unit !== s.unit) this.decoder.setUnit(s.unit);
  }

  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }
}

function readParams(v: unknown): Partial<MorseSettings> {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: Partial<MorseSettings> = {};
  const unit = num(p.unit, 20, 5000);
  if (unit !== undefined) out.unit = unit;
  const trim = num(p.trim, 0, 2000);
  if (trim !== undefined) out.trim = trim;
  const autoUnit = bool(p.autoUnit);
  if (autoUnit !== undefined) out.autoUnit = autoUnit;
  const endUnits = num(p.endUnits, 8, 100);
  if (endUnits !== undefined) out.endUnits = endUnits;
  const guardMs = num(p.guardMs, 0, 10000);
  if (guardMs !== undefined) out.guardMs = guardMs;
  return out;
}

export default SonicMorse;
