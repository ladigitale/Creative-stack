import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, bool, num } from "../../shared/media/control";
import type { LumaEdge } from "../../shared/media/luma";
import { MorseDecoder, morseEncode, morseNormalize, morseTimeline, type MorseStep } from "../../shared/media/morse";
import { FAST_START_EXTRA, FastDecoder, buildFastTable, fastSigns, fastTimeline, type FastTable } from "../../shared/media/fastcode";

const tagName = "sonic-morse";

export type MorseCodec = "morse" | "fast";

export type MorseSettings = {
  /** Code : morse, ou code rapide (durées 1/2/3, table de phrases, contrôle). */
  codec: MorseCodec;
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
  /** Nombre minimal de caractères d'un message reçu ; en dessous il est écarté. */
  minChars: number;
  /** Durée du signal de début, en unités (0 : pas de signal de début). */
  startUnits: number;
  /** Pseudo de cet appareil, émis en tête des messages du code rapide (doit figurer dans `roster`). */
  identity: string;
};

export type MorseState = {
  status: "idle" | "sending" | "receiving";
  /** État commandé de la lampe. */
  on: boolean;
  tx: {
    text: string;
    signs: string;
    /** Partie du texte déjà émise, et partie restante. */
    done: string;
    rest: string;
    chars: number;
    total: number;
    /** Avancement 0..1, et le même en pourcentage entier. */
    progress: number;
    percent: number;
    /** Durée totale du message en ms, durée déjà émise, secondes restantes et avancement dans le temps (0..100). */
    duration: number;
    elapsed: number;
    remaining: number;
    timePercent: number;
    queue: number;
  };
  /** `codec` : code du message en cours de réception, reconnu à son signal de début (`""` : pas encore connu). */
  rx: { text: string; signs: string; unit: number; codec: MorseCodec | ""; speaker: string };
  codec: MorseCodec;
  /** Dernier message reçu en entier. */
  lastReceived: string;
  /** Dernier message émis en entier. */
  lastSent: string;
  sent: number;
  received: number;
  /** Messages reçus écartés car trop courts (`min-chars`). */
  dropped: number;
  /** Messages du code rapide rejetés : contrôle, étalonnage, durée illisible ou silence en plein message. */
  errors: number;
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
 *   Un éclat n'est compté que si son allumage a été vu hors de cette période.
 * - Signal de début (`start-units`, 5 unités par défaut) : chaque message émis commence par un éclat
 *   plus long qu'un trait, et rien n'est décodé tant que ce signal n'a pas été vu. Une lumière
 *   parasite ne devient donc pas un message. `start-units="0"` sur les deux appareils le retire.
 * - Un message reçu de moins de `min-chars` caractères est écarté : une lettre seule est presque
 *   toujours un reflet ou un passage devant la caméra.
 *
 * - `codec="fast"` : code rapide. Chaque intervalle, éclat ou silence, dure 1, 2 ou 3 unités et porte de
 *   l'information ; un arbre de code unique couvre les caractères (fréquences du français), la fin de
 *   message et une table de phrases (« OUI », « CA VA ? » : un seul symbole). Après le signal de début,
 *   un silence de 3 unités étalonne le récepteur ; 3 chiffres de contrôle (base 3) terminent le message,
 *   qui est livré dès qu'il est complet, sans attendre de silence. Un message dont le contrôle échoue est
 *   rejeté (`errors`). `phrases` (tableau JSON de textes) remplace la table : à l'identique sur les deux
 *   appareils, sinon les messages à phrases sont rejetés. Même `unit` et `start-units` des deux côtés.
 *   `codec` ne règle que l'émission : le récepteur reconnaît le code de chaque message à son signal de
 *   début (l'éclat du code rapide dure 2 unités de plus que celui du morse), les deux se mélangent.
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

  /** ms de réception coupée après une émission (défaut 1500 : la lampe s'éteint en retard et la caméra aussi). */
  @property({ type: Number, attribute: "guard-ms" })
  guardMs = 1500;

  /** Nombre minimal de caractères d'un message reçu (défaut 2) ; en dessous il est écarté. */
  @property({ type: Number, attribute: "min-chars" })
  minChars = 2;

  /**
   * Durée du signal de début en unités (défaut 5, 0 pour s'en passer). Émis avant chaque message et
   * exigé en réception : même valeur sur les deux appareils.
   */
  @property({ type: Number, attribute: "start-units" })
  startUnits = 5;

  /** Code : `morse` (défaut) ou `fast`. Le même sur les deux appareils. */
  @property({ type: String })
  codec: MorseCodec = "morse";

  /**
   * Table de phrases du code rapide : tableau JSON de textes (ou de couples [texte, poids]). Absent : table
   * par défaut. Les deux appareils doivent avoir la même.
   */
  @property({ type: String })
  phrases = "";

  /**
   * Liste partagée des pseudos (tableau JSON de textes, 26 au plus). Avec elle, chaque message du code
   * rapide commence par l'identifiant de son émetteur (2 intervalles jusqu'à 8 pseudos, 3 au-delà) et le
   * récepteur lit le pseudo (`rx.speaker`, `speaker` du message reçu). Même liste sur tous les appareils.
   */
  @property({ type: String })
  roster = "";

  /** Pseudo de cet appareil dans `roster` (vide ou inconnu : anonyme). Réglable aussi via `params`. */
  @property({ type: String })
  identity = "";

  /** DataProvider de réglages en direct {codec, unit, trim, autoUnit, endUnits, guardMs, minChars, startUnits}. */
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
  private fastDecoder = new FastDecoder();
  private rxCodec: MorseCodec | null = null;
  private startMs = 0;
  private tableKey: string | null = null;
  private fastTable: FastTable = buildFastTable();
  private lastEdge = 0;
  private rxTimer: ReturnType<typeof setTimeout> | null = null;
  private silentSince = 0;
  private lastReceived = "";
  private lastSent = "";
  private sent = 0;
  private received = 0;
  private dropped = 0;
  private errors = 0;
  /** L'allumage de l'éclat en cours a été vu en réception (hors émission et garde). */
  private rxOpen = false;
  /** Le signal de début du message en cours a été vu. */
  private rxStarted = false;

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
      codec: this.codec === "fast" ? "fast" : "morse",
      unit: num(this.unit, 20, 5000) ?? 300,
      trim: num(this.trim, 0, 2000) ?? 0,
      autoUnit: Boolean(this.autoUnit),
      endUnits: num(this.endUnits, 8, 100) ?? 12,
      guardMs: num(this.guardMs, 0, 10000) ?? 1500,
      minChars: Math.round(num(this.minChars, 1, 20) ?? 2),
      startUnits: startUnits(this.startUnits) ?? 5,
      identity: String(this.identity ?? ""),
    };
    const all = { ...base, ...this.live };
    // Le code rapide s'étalonne sur le signal de début : il en faut un.
    if (all.codec === "fast" && all.startUnits === 0) all.startUnits = 5;
    return all;
  }

  /** Table de phrases du code rapide, reconstruite si `phrases` a changé. */
  private table(): FastTable {
    const key = `${this.phrases.trim()}@${this.roster.trim()}`;
    if (key !== this.tableKey) {
      this.tableKey = key;
      this.fastTable = buildFastTable(parsePhrases(this.phrases.trim()), parseRoster(this.roster.trim()));
      this.fastDecoder.setTable(this.fastTable);
    }
    return this.fastTable;
  }

  getState(): MorseState {
    const sending = this.txTimer !== null;
    const total = this.txText.length;
    const chars = Math.min(this.txChars, total);
    const progress = total ? chars / total : 0;
    const duration = this.steps.reduce((a, st) => a + st.ms, 0);
    const elapsed = sending ? this.steps.slice(0, this.stepIndex).reduce((a, st) => a + st.ms, 0) : duration;
    return {
      status: sending ? "sending" : this.listening() ? "receiving" : "idle",
      on: this.lampOn,
      tx: {
        text: this.txText,
        signs: this.settings().codec === "fast" ? fastSigns(this.txText, this.table(), this.settings().identity) : morseEncode(this.txText),
        done: this.txText.slice(0, chars),
        rest: this.txText.slice(chars),
        chars,
        total,
        progress: Math.round(progress * 100) / 100,
        percent: Math.round(progress * 100),
        duration: Math.round(duration),
        elapsed: Math.round(elapsed),
        remaining: Math.max(0, Math.ceil((duration - elapsed) / 1000)),
        timePercent: duration ? Math.round((elapsed / duration) * 100) : 0,
        queue: this.queue.length,
      },
      rx:
        this.rxCodec === "fast"
          ? { text: this.fastDecoder.text, signs: "", unit: Math.round(this.fastDecoder.unit), codec: "fast", speaker: this.fastDecoder.speaker }
          : { text: this.decoder.text, signs: this.decoder.signs, unit: Math.round(this.decoder.unit), codec: this.rxCodec ?? "", speaker: "" },
      codec: this.settings().codec,
      lastReceived: this.lastReceived,
      lastSent: this.lastSent,
      sent: this.sent,
      received: this.received,
      dropped: this.dropped,
      errors: this.errors,
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
    this.steps =
      s.codec === "fast" ? fastTimeline(text, s.unit, s.trim, s.startUnits, this.table(), s.identity) : morseTimeline(text, s.unit, s.trim, s.startUnits);
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
    this.txChars = this.txText.length;
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

  /** Caractères lisibles du message en cours de réception, lettre en cours comprise. */
  private heard(): number {
    return this.decoder.text.replace(/[\s?]/g, "").length + (this.decoder.signs ? 1 : 0);
  }

  /** Un message est en cours de réception : signal de début vu, ou assez de caractères sans signal de début. */
  private listening(): boolean {
    const s = this.settings();
    return s.startUnits > 0 ? this.rxStarted : this.heard() >= s.minChars;
  }

  private resetRx(): void {
    this.decoder.reset();
    this.fastDecoder.reset();
    this.rxCodec = null;
    this.rxOpen = false;
    this.rxStarted = false;
    if (this.rxTimer) clearTimeout(this.rxTimer);
    this.rxTimer = null;
  }

  /** Front vu par la sonde. Ignoré pendant l'émission et juste après. */
  feedEdge(edge: LumaEdge): void {
    if (this.txTimer !== null || performance.now() < this.guardUntil) {
      this.rxOpen = false;
      return;
    }
    const start = this.settings().startUnits;
    if (edge.on) {
      this.rxOpen = true;
      if (this.rxTimer) clearTimeout(this.rxTimer);
      this.rxTimer = null;
      if (start === 0) {
        if (edge.dur > 0) this.decoder.silence(edge.dur);
      } else if (this.rxStarted && edge.dur > 0) {
        if (this.rxCodec === null) {
          // Premier silence après le signal de début : 3 unités dans les deux codes, le rapport éclat de
          // début / silence dit le code (S/3 en morse, (S+2)/3 en rapide) quelle que soit l'unité.
          this.rxCodec = this.startMs / edge.dur >= (start + 1) / 3 ? "fast" : "morse";
          if (this.rxCodec === "fast") this.fastDecoder.start(this.startMs, start + FAST_START_EXTRA);
        }
        if (this.rxCodec === "fast") {
          // Le silence qui vient de finir est un intervalle du code (étalonnage compris).
          if (this.feedFast(false, edge.dur)) return;
        } else this.decoder.silence(edge.dur);
      }
    } else {
      // Extinction sans allumage vu : fin de notre propre éclat, ou sonde tout juste branchée.
      if (!this.rxOpen) return;
      this.rxOpen = false;
      if (start > 0 && edge.dur >= (start - 1) * this.decoder.unit) {
        // Signal de début : un nouveau message commence, ce qui précède est oublié.
        this.decoder.text = "";
        this.decoder.signs = "";
        this.fastDecoder.reset();
        this.rxStarted = true;
        this.rxCodec = null;
        this.startMs = edge.dur;
      } else if (start > 0 && !this.rxStarted) {
        return; // lumière sans signal de début : pas un message
      } else if (this.rxCodec === "fast") {
        if (this.feedFast(true, edge.dur)) return;
      } else {
        this.decoder.light(edge.dur);
      }
      this.silentSince = performance.now();
      this.watchSilence();
    }
    this.publish();
  }

  /**
   * Intervalle vu en code rapide. Renvoie vrai si le message est fini (livré ou rejeté) : la suite du
   * front n'a plus rien à traiter.
   */
  private feedFast(lit: boolean, ms: number): boolean {
    const r = this.fastDecoder.feed(lit, ms);
    if (r === "more") return false;
    const text = this.fastDecoder.text.trim();
    const unit = Math.round(this.fastDecoder.unit);
    const speaker = this.fastDecoder.speaker;
    const ok = r === "done";
    this.fastDecoder.reset();
    this.rxStarted = false;
    this.rxCodec = null;
    if (this.rxTimer) clearTimeout(this.rxTimer);
    this.rxTimer = null;
    if (!ok) this.errors++;
    else if (text.replace(/\s/g, "").length < this.settings().minChars) this.dropped++;
    else {
      this.lastReceived = text;
      this.received++;
      const target = this.target.trim();
      if (target) dispatch(target, { type: "morse:message", payload: { text, unit, speaker } });
      this.dispatchEvent(new CustomEvent("morse-message", { detail: { text, unit, speaker }, bubbles: true, composed: true }));
    }
    this.publish();
    return true;
  }

  /** Pendant un silence : clôt la lettre à 2 unités, le mot à 5, le message à `endUnits`. */
  private watchSilence(): void {
    if (this.rxTimer) clearTimeout(this.rxTimer);
    const unit = this.decoder.unit;
    const end = this.settings().endUnits;
    const fast = this.rxCodec === "fast";
    const marks = (fast ? [end] : [2, 5, end]).map((u) => u * unit);
    const tick = () => {
      const quiet = performance.now() - this.silentSince;
      if (!fast) this.decoder.silence(quiet);
      if (quiet >= end * unit) {
        this.rxTimer = null;
        if (fast) {
          // Silence en plein message : il est perdu.
          if (this.rxStarted) this.errors++;
          this.fastDecoder.reset();
          this.rxStarted = false;
          this.rxCodec = null;
          this.publish();
        } else this.complete();
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
    const enough = this.heard() >= this.settings().minChars;
    this.decoder.text = "";
    this.decoder.signs = "";
    this.rxStarted = false;
    this.rxCodec = null;
    if (text && !enough) this.dropped++;
    if (text && enough) {
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
    if (s.codec === "fast") this.table();
    this.decoder.opts.autoUnit = s.autoUnit;
    if (this.decoder.opts.unit !== s.unit) this.decoder.setUnit(s.unit);
  }

  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }
}

/** Signal de début : 0 (aucun) ou au moins 4 unités, pour rester plus long qu'un trait. */
function startUnits(v: unknown): number | undefined {
  const n = num(v, 0, 20);
  if (n === undefined) return undefined;
  return n === 0 ? 0 : Math.max(4, n);
}

/** Table de phrases en JSON : tableau de textes ou de couples [texte, poids] ; autre chose : table par défaut. */
function parsePhrases(raw: string): (string | [string, number])[] | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return undefined;
    const out: (string | [string, number])[] = [];
    for (const e of v) {
      if (typeof e === "string") out.push(e);
      else if (Array.isArray(e) && typeof e[0] === "string") out.push([e[0], Number(e[1])]);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Liste de pseudos en JSON : tableau de textes ; autre chose : pas d'identifiant. */
function parseRoster(raw: string): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : undefined;
  } catch {
    return undefined;
  }
}

function readParams(v: unknown): Partial<MorseSettings> {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: Partial<MorseSettings> = {};
  if (p.codec === "fast" || p.codec === "morse") out.codec = p.codec;
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
  const minChars = num(p.minChars, 1, 20);
  if (minChars !== undefined) out.minChars = Math.round(minChars);
  const start = startUnits(p.startUnits);
  if (start !== undefined) out.startUnits = start;
  if (typeof p.identity === "string") out.identity = p.identity;
  return out;
}

export default SonicMorse;
