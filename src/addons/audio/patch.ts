import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine, resolveAudioElement } from "../../shared/audio/engine";
import { isAudioSink, isAudioSource, type SonicInstrument, type SonicNoteEvent } from "../../shared/audio/contracts";
import { toMidi } from "../../shared/audio/notes";
import { listenDp, plain } from "../../shared/audio/dp";
import { compilePatch, domToPatchNodes, type CompiledPatch, type PatchNode } from "./patch/compile";
import { PATCH_LIBRARY } from "./patch/library";
import { PatchRuntime } from "./patch/runtime";
import "./modules-elements";

const tagName = "sonic-patch";
const MAX_SEEN_IDS = 512;

export type PatchState = {
  status: "idle" | "ready" | "error" | "unsupported";
  preset: string | null;
  voices: number;
  /** Notes jouées depuis le chargement. */
  played: number;
  /** sonic-audio-input : branché (true) ou en attente de sa source (false). */
  inputs: Record<string, boolean>;
  errors: string[];
  warnings: string[];
};

/**
 * Instrument modulaire : compile ses modules enfants (ou un preset de la
 * bibliothèque) et crée un graphe WebAudio par note.
 *
 * Pilotage : `events` (DP : liste d'événements) + `trigger` (DP : valeur qui change),
 * `sonic-param source="…"` pour les valeurs continues. État dans `out-data-provider`.
 */
@customElement(tagName)
export class SonicPatch extends LitElement implements SonicInstrument {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Patch de la bibliothèque (`synth/lead`, `drums/kit`…). */
  @property({ type: String })
  preset = "";

  /** Valeurs des paramètres exposés (`{"cutoff": 900}`). */
  @property({ type: Object })
  params: Record<string, number> | null = null;

  @property({ type: Number })
  poly = 8;

  @property({ type: String })
  steal: "oldest" | "quietest" | "same-note" = "oldest";

  /** Part de la vélocité dans le volume (0..1). */
  @property({ type: Number, attribute: "vel-sense" })
  velSense = 0.6;

  /** Volume de sortie du patch. */
  @property({ type: Number })
  gain = 0.6;

  /** Tempo pour les durées en fraction (`3/16`) et les LFO synchronisés. */
  @property({ type: Number })
  bpm = 120;

  /** Durée par défaut d'une note sans `durS` (s). */
  @property({ type: Number, attribute: "dur-s" })
  durS = 0.3;

  /** Module global de sortie (défaut : dernier module global, sinon la somme des voix). */
  @property({ type: String })
  out = "";

  /** Destination : `master` (défaut), `#id` d'un élément qui reçoit du son, ou `none`. */
  @property({ type: String })
  output = "master";

  /** DataProvider : liste d'événements à jouer. */
  @property({ type: String })
  events = "";

  /** DataProvider : chaque changement de valeur rejoue `events`. */
  @property({ type: String })
  trigger = "";

  /** Noms → notes (`{"kick": 36}`) pour les événements `sample`. */
  @property({ type: Object, attribute: "notes-map" })
  notesMap: Record<string, string | number> | null = null;

  /** DataProvider de l'état (défaut : `<id>State`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private compiled: CompiledPatch | null = null;
  private runtime: PatchRuntime | null = null;
  private observer: MutationObserver | null = null;
  private unsubs: (() => void)[] = [];
  private paramUnsubs: (() => void)[] = [];
  private unsubscribeEngine: (() => void) | null = null;
  private recompileQueued = false;
  private seen: string[] = [];
  private lastEventsJson = "";
  private latestEvents: SonicNoteEvent[] = [];
  private lastTrigger: string | undefined;
  private runtimeErrors: string[] = [];
  private played = 0;
  private pending: { events: SonicNoteEvent[]; at: number }[] = [];

  /** Compilation courante (tests, outils). */
  get compiledPatch(): CompiledPatch | null {
    return this.compiled;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.observer = new MutationObserver(() => this.queueRecompile());
    this.observer.observe(this, { childList: true, subtree: true, attributes: true });
    this.unsubscribeEngine = AudioEngine.get().onChange(() => this.ensureRuntime());
    this.inputClock = setInterval(() => this.wireInputs(), 400);
    this.recompile();
  }

  disconnectedCallback(): void {
    this.observer?.disconnect();
    this.unsubscribeEngine?.();
    if (this.inputClock) clearInterval(this.inputClock);
    for (const u of [...this.unsubs, ...this.paramUnsubs]) u();
    this.unsubs = [];
    this.paramUnsubs = [];
    this.runtime?.dispose();
    this.runtime = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    const structural = ["preset", "poly", "steal", "velSense", "gain", "bpm", "out", "output"];
    if (structural.some((k) => changed.has(k)) && changed.size && this.isConnected && this.compiled) this.queueRecompile();
    if (changed.has("params") && this.runtime) this.applyParams();
    if (changed.has("events") || changed.has("trigger")) this.listenEvents();
  }

  /* ---------------------------------------------------------------- */
  /* SonicInstrument                                                   */
  /* ---------------------------------------------------------------- */

  schedule(events: SonicNoteEvent[]): void {
    const rt = this.runtime;
    const ac = AudioEngine.get().context;
    if (!Array.isArray(events)) return;
    if (!rt || !ac) {
      // Le geste qui déverrouille le son déclenche souvent la première note :
      // on la garde un instant au lieu de la perdre.
      if (AudioEngine.get().supported && !this.compiled?.errors.length) {
        this.pending.push({ events, at: performance.now() });
        if (this.pending.length > 16) this.pending.shift();
      }
      return;
    }
    const now = ac.currentTime;
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.id !== undefined) {
        const id = String(ev.id);
        if (this.seen.includes(id)) continue;
        this.seen.push(id);
        if (this.seen.length > MAX_SEEN_IDS) this.seen.shift();
      }
      const type = ev.type ?? "note";
      const when = typeof ev.when === "number" && Number.isFinite(ev.when) ? ev.when : now + 0.005;
      if (when < now - 0.05) continue;
      const t = Math.max(when, now);
      if (type === "param") {
        const [module, param] = String(ev.path ?? "").split(/\.(?=[^.]+$)/);
        const value = Number(ev.value);
        if (module && param && Number.isFinite(value)) rt.setParam(module, param, value, Number(ev.rampS) || 0.02, t);
        continue;
      }
      let midi: number | null = null;
      if (ev.note !== undefined) {
        midi = toMidi(ev.note);
        if (midi === null) {
          this.warnOnce(`note invalide : ${JSON.stringify(ev.note)}`);
          continue;
        }
      } else if (ev.sample !== undefined && this.notesMap?.[ev.sample] !== undefined) {
        midi = toMidi(this.notesMap[ev.sample]);
      }
      if (type === "noteOff") {
        rt.noteOff(midi, t);
        continue;
      }
      const vel = Math.min(1, Math.max(0, typeof ev.vel === "number" ? ev.vel : 0.8));
      const dur = type === "noteOn" ? null : typeof ev.durS === "number" && ev.durS > 0 ? ev.durS : this.durS;
      const ok = rt.noteOn(midi, vel, t, dur, ev.sample !== undefined ? String(ev.sample) : null);
      if (ok) this.played++;
      if (!ok) this.warnOnce(`aucun sonic-voice pour ${ev.sample !== undefined ? `sample "${ev.sample}"` : `note ${String(ev.note)}`}`);
    }
  }

  allNotesOff(): void {
    this.runtime?.allNotesOff();
  }

  /** Entrée audio (SonicAudioSink) : le premier sonic-audio-input du patch, pour `output="#ce-patch"` d'une autre source. */
  getAudioInput(): AudioNode | null {
    const first = this.runtime?.inputs()[0];
    return first ? (this.runtime?.inputNode(first.name) ?? null) : null;
  }

  /** Sortie audio du patch (pour un analyseur, un enregistreur…). */
  getAudioOutput(): AudioNode | null {
    return this.runtime?.output ?? null;
  }

  /** Raccourcis JS. */
  noteOn(note: string | number, vel = 0.8): void {
    this.schedule([{ type: "noteOn", note, vel }]);
  }

  noteOff(note: string | number): void {
    this.schedule([{ type: "noteOff", note }]);
  }

  /* ---------------------------------------------------------------- */
  /* Compilation                                                       */
  /* ---------------------------------------------------------------- */

  private queueRecompile(): void {
    if (this.recompileQueued) return;
    this.recompileQueued = true;
    queueMicrotask(() => {
      this.recompileQueued = false;
      this.recompile();
    });
  }

  private nodes(): PatchNode[] {
    if (this.preset) {
      const lib = PATCH_LIBRARY[this.preset];
      if (lib) return lib.nodes.map((nd) => plain<PatchNode>(nd));
    }
    return domToPatchNodes(this);
  }

  private recompile(): void {
    this.compiled = compilePatch(this.nodes(), { out: this.out || undefined });
    if (this.preset && !PATCH_LIBRARY[this.preset]) {
      this.compiled.errors.unshift(`preset "${this.preset}" inconnu (${Object.keys(PATCH_LIBRARY).join(", ")})`);
    } else if (this.preset && this.children.length) {
      this.compiled.warnings.push("preset et modules enfants : les enfants sont ignorés");
    }
    for (const w of this.compiled.warnings) console.warn(`[sonic-patch${this.id ? "#" + this.id : ""}] ${w}`);
    for (const e of this.compiled.errors) console.warn(`[sonic-patch${this.id ? "#" + this.id : ""}] ${e}`);
    this.runtime?.dispose();
    this.runtime = null;
    this.ensureRuntime();
    this.publish();
  }

  private ensureRuntime(): void {
    const engine = AudioEngine.get();
    if (this.runtime || !this.compiled || this.compiled.errors.length || !engine.context || !engine.master) {
      this.publish();
      return;
    }
    this.runtimeErrors = [];
    this.runtime = new PatchRuntime(engine.context, this.compiled, {
      bpm: this.bpm,
      poly: Math.max(1, Math.min(32, Math.round(this.poly))),
      steal: this.steal,
      velSense: Math.min(1, Math.max(0, this.velSense)),
      gain: Math.max(0, this.gain),
      onVoices: () => this.publish(),
    });
    const dest = this.resolveOutput(engine.master);
    if (dest) this.runtime.output.connect(dest);
    this.applyParams();
    this.listenParams();
    this.wireInputs();
    const fresh = this.pending.filter((p) => performance.now() - p.at < 500);
    this.pending = [];
    for (const p of fresh) this.schedule(p.events.map((e) => ({ ...e, when: undefined })));
    this.publish();
  }

  private inputClock: ReturnType<typeof setInterval> | null = null;
  private inputsState: Record<string, boolean> = {};

  /** Branche les sonic-audio-input sur leur source dès qu'elle est prête (micro activé, vidéo chargée…). */
  private wireInputs(): void {
    const rt = this.runtime;
    const next: Record<string, boolean> = {};
    if (rt) {
      for (const { name, source } of rt.inputs()) {
        if (source === "master") {
          this.warnOnce(`${name} : source "master" interdite (boucle de larsen)`);
          next[name] = false;
          continue;
        }
        if (source === "none" || source === "in") {
          next[name] = true;
          continue;
        }
        const el = resolveAudioElement(this, source);
        if (el === this) {
          this.warnOnce(`${name} : un patch ne peut pas être sa propre source`);
          next[name] = false;
          continue;
        }
        const node = isAudioSource(el) ? el.getAudioOutput() : null;
        rt.attachInput(name, node);
        next[name] = !!node;
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(this.inputsState)) {
      this.inputsState = next;
      this.publish();
    }
  }

  private resolveOutput(master: AudioNode): AudioNode | null {
    const out = (this.output || "master").trim();
    if (out === "none") return null;
    if (out === "master") return master;
    const el = resolveAudioElement(this, out);
    const input = isAudioSink(el) ? el.getAudioInput() : null;
    if (!input) {
      this.runtimeErrors.push(`output "${out}" introuvable ou pas encore prêt : sortie vers le master`);
      return master;
    }
    return input;
  }

  private applyParams(): void {
    const rt = this.runtime;
    if (!rt || !this.compiled) return;
    const values = this.params ?? {};
    for (const p of this.compiled.params) {
      const v = p.expose && typeof values[p.expose] === "number" ? values[p.expose] : p.value;
      if (typeof v === "number") rt.setParam(p.module, p.param, clamp(v, p.min, p.max), 0);
    }
  }

  private listenParams(): void {
    for (const u of this.paramUnsubs) u();
    this.paramUnsubs = [];
    for (const p of this.compiled?.params ?? []) {
      if (!p.source) continue;
      this.paramUnsubs.push(
        listenDp(p.source, (v) => {
          const n = Number(v);
          if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return;
          this.runtime?.setParam(p.module, p.param, clamp(n, p.min, p.max), p.rampS);
        }),
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Événements par DataProvider                                       */
  /* ---------------------------------------------------------------- */

  private listenEvents(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.lastEventsJson = "";
    this.lastTrigger = undefined;
    if (this.events) {
      this.unsubs.push(
        listenDp(this.events, (v) => {
          const list = Array.isArray(v) ? (v as SonicNoteEvent[]) : [];
          this.latestEvents = list;
          if (this.trigger) return;
          const json = JSON.stringify(list);
          if (json === this.lastEventsJson) {
            // même liste : seuls les événements d'id nouveau sont joués (dédoublonnage)
            return;
          }
          this.lastEventsJson = json;
          this.schedule(list);
        }),
      );
    }
    if (this.trigger) {
      this.unsubs.push(
        listenDp(this.trigger, (v) => {
          // DataProvider pas encore rempli : pas une valeur de référence.
          if (v === null || v === undefined || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length)) return;
          const key = JSON.stringify(v);
          if (this.lastTrigger === undefined) {
            this.lastTrigger = key; // première valeur : référence
            return;
          }
          if (key === this.lastTrigger) return;
          this.lastTrigger = key;
          this.schedule(this.latestEvents);
        }),
      );
    }
  }

  /* ---------------------------------------------------------------- */

  private warned = new Set<string>();
  private warnOnce(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.runtimeErrors.push(msg);
    console.warn(`[sonic-patch${this.id ? "#" + this.id : ""}] ${msg}`);
    this.publish();
  }

  getState(): PatchState {
    const engine = AudioEngine.get();
    const errors = [...(this.compiled?.errors ?? [])];
    return {
      status: !engine.supported ? "unsupported" : errors.length ? "error" : this.runtime ? "ready" : "idle",
      preset: this.preset || null,
      voices: this.runtime?.voiceCount ?? 0,
      played: this.played,
      inputs: { ...this.inputsState },
      errors,
      warnings: [...(this.compiled?.warnings ?? []), ...this.runtimeErrors],
    };
  }

  private publishQueued = false;
  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      set(out, this.getState());
    });
  }

  render() {
    return html`<slot></slot>`;
  }
}

function clamp(v: number, min: number | null, max: number | null): number {
  let n = v;
  if (min !== null) n = Math.max(min, n);
  if (max !== null) n = Math.min(max, n);
  return n;
}

export default SonicPatch;
