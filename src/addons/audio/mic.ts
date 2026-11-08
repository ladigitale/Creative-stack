import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import type { SonicAudioSource } from "../../shared/audio/contracts";
import { listenDp } from "../../shared/audio/dp";
import {
  listDevices,
  onFirstGesture,
  openStream,
  stopStream,
  type CaptureStatus,
  type MediaDeviceInfoLite,
} from "../../shared/media/capture";
import { bool, num } from "../../shared/media/control";

const tagName = "sonic-mic";

/** Réglages effectifs (attributs, puis `control` : le dernier l'emporte). */
export type MicSettings = {
  monitor: boolean;
  gain: number;
  /** Micro demandé (`""` = celui par défaut). */
  deviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGain: boolean;
  rate: number;
};

/** Lit les réglages du DP `control` (clés absentes ou invalides ignorées), valeurs bornées. */
export function readMicControl(v: unknown): Partial<MicSettings> {
  const c = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: Partial<MicSettings> = {};
  const m = bool(c.monitor); if (m !== undefined) o.monitor = m;
  const g = num(c.gain, 0, 4); if (g !== undefined) o.gain = g;
  if (typeof c.deviceId === "string") o.deviceId = c.deviceId;
  const ec = bool(c.echoCancellation); if (ec !== undefined) o.echoCancellation = ec;
  const ns = bool(c.noiseSuppression); if (ns !== undefined) o.noiseSuppression = ns;
  const ag = bool(c.autoGain); if (ag !== undefined) o.autoGain = ag;
  const r = num(c.rate, 0, 60); if (r !== undefined) o.rate = r;
  return o;
}

export type MicState = {
  status: CaptureStatus;
  error: string | null;
  active: boolean;
  /** Niveau efficace 0..1, crête 0..1, niveau en dBFS (si le son est actif). */
  rms: number;
  peak: number;
  db: number;
  monitor: boolean;
  deviceId: string | null;
  devices: MediaDeviceInfoLite[];
  /** Réglages effectifs (attributs, puis `control`). */
  settings: MicSettings;
};

/**
 * Micro : source audio pour un analyseur, un enregistreur, un patch…
 * N'est **jamais** envoyé vers les haut-parleurs, sauf avec `monitor` (effet Larsen).
 *
 * Démarrage : `active` (attribut ou DP `control`), `autostart` (au premier geste),
 * ou un bouton `sonic-audio-unlock start="mic"` / `sonic-media-start for="mic"`.
 *
 * DP `control` : `{ active, monitor, gain, deviceId, echoCancellation, noiseSuppression, autoGain, rate }`,
 * prioritaire sur les attributs (clé retirée : retour à l'attribut). Changer de micro ou de traitement
 * (écho, bruit, gain auto) rouvre le flux proprement s'il est actif ; gain, monitor et rate s'appliquent en direct.
 */
@customElement(tagName)
export class SonicMic extends LitElement implements SonicAudioSource {
  static styles = css`
    :host {
      display: none;
    }
  `;

  @property({ type: Boolean })
  active = false;

  /** Demande le micro au premier geste sur la page. */
  @property({ type: Boolean })
  autostart = false;

  /** Écoute dans les haut-parleurs (casque recommandé). */
  @property({ type: Boolean })
  monitor = false;

  @property({ type: Number })
  gain = 1;

  @property({ type: String, attribute: "device-id" })
  deviceId = "";

  @property({ type: Boolean, attribute: "echo-cancellation" })
  echoCancellation = false;

  @property({ type: Boolean, attribute: "noise-suppression" })
  noiseSuppression = false;

  @property({ type: Boolean, attribute: "auto-gain" })
  autoGain = false;

  /** Mises à jour du niveau par seconde (défaut 15, 0 = pas de niveau). */
  @property({ type: Number })
  rate = 15;

  /** DataProvider de pilotage : { active, monitor, gain, deviceId, echoCancellation, noiseSuppression, autoGain, rate }. */
  @property({ type: String })
  control = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private out: GainNode | null = null;
  private meter: AnalyserNode | null = null;
  private meterData: Float32Array<ArrayBuffer> | null = null;
  private state: MicState = {
    status: "idle", error: null, active: false, rms: 0, peak: 0, db: -100, monitor: false, deviceId: null, devices: [],
    settings: { monitor: false, gain: 1, deviceId: "", echoCancellation: false, noiseSuppression: false, autoGain: false, rate: 15 },
  };
  private fromControl: Partial<MicSettings> = {};
  private restartQueued = false;
  private wantActive = false;
  private opening = false;
  private token = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: (() => void)[] = [];
  private cancelGesture: (() => void) | null = null;
  private unsubscribeEngine: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeEngine = AudioEngine.get().onChange(() => this.wire());
    this.lastSettings = this.settings();
    this.state = { ...this.state, settings: this.lastSettings };
    this.publish();
  }

  disconnectedCallback(): void {
    this.cancelGesture?.();
    this.cancelGesture = null;
    this.unsubscribeEngine?.();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.close("idle");
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("active")) this.setActive(this.active);
    if (changed.has("autostart")) {
      this.cancelGesture?.();
      this.cancelGesture = this.autostart ? onFirstGesture(() => this.start()) : null;
    }
    const keys = ["monitor", "gain", "deviceId", "echoCancellation", "noiseSuppression", "autoGain", "rate"];
    if (keys.some((k) => changed.has(k) && changed.get(k) !== undefined)) {
      // Attribut modifié : même chemin qu'un réglage du DP (le recouvrement `control` reste prioritaire).
      this.applySettings();
    } else if (changed.has("monitor") || changed.has("gain")) this.wire();
    if (changed.has("control")) this.listenControl();
  }

  /* ---------------------------------------------------------------- */
  /* API (sonic-media-start, sonic-audio-unlock start="…")             */
  /* ---------------------------------------------------------------- */

  start(): void {
    this.setActive(true);
  }

  stop(): void {
    this.setActive(false);
  }

  getState(): MicState {
    return { ...this.state, devices: [...this.state.devices] };
  }

  getAudioOutput(): AudioNode | null {
    return this.out;
  }

  /** Réglages effectifs, bornés. */
  settings(): MicSettings {
    const a: MicSettings = {
      monitor: !!this.monitor,
      gain: Number.isFinite(this.gain) ? Math.min(4, Math.max(0, this.gain)) : 1,
      deviceId: this.deviceId || "",
      echoCancellation: !!this.echoCancellation,
      noiseSuppression: !!this.noiseSuppression,
      autoGain: !!this.autoGain,
      rate: Number.isFinite(this.rate) ? Math.min(60, Math.max(0, this.rate)) : 15,
    };
    return { ...a, ...this.fromControl };
  }

  /* ---------------------------------------------------------------- */

  private lastSettings: MicSettings | null = null;

  private listenControl(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (Object.keys(this.fromControl).length) {
      this.fromControl = {};
      this.applySettings();
    }
    if (!this.control) return;
    this.unsubs.push(
      listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        this.fromControl = readMicControl(v);
        this.applySettings();
        const a = bool((v as Record<string, unknown>).active);
        if (a !== undefined) this.setActive(a);
      }),
    );
  }

  /** Compare aux réglages précédemment appliqués et n'applique que ce qui a changé. */
  private applySettings(): void {
    const s = this.settings();
    const before = this.lastSettings ?? s;
    this.lastSettings = s;
    const reopen =
      s.deviceId !== before.deviceId || s.echoCancellation !== before.echoCancellation || s.noiseSuppression !== before.noiseSuppression || s.autoGain !== before.autoGain;
    if (reopen && (this.stream || this.opening)) this.queueRestart();
    if (s.monitor !== before.monitor || s.gain !== before.gain) this.wire();
    if (s.rate !== before.rate && this.meter) this.startMeter();
    if (JSON.stringify(s) !== JSON.stringify(this.state.settings)) this.patch({ settings: s });
  }

  /** Plusieurs réglages changés d'un coup : une seule réouverture du flux. */
  private queueRestart(): void {
    if (this.restartQueued) return;
    this.restartQueued = true;
    queueMicrotask(() => {
      this.restartQueued = false;
      if (this.isConnected && (this.stream || this.opening)) this.restart();
    });
  }

  private setActive(on: boolean): void {
    this.wantActive = on;
    if (on && !this.stream && !this.opening) void this.open();
    if (!on && (this.stream || this.opening)) this.close("idle");
  }

  private restart(): void {
    this.close("idle");
    if (this.wantActive) void this.open();
  }

  private async open(): Promise<void> {
    const token = ++this.token;
    this.opening = true;
    this.patch({ status: "requesting", error: null });
    // Le geste qui demande le micro active aussi le son (même geste : exigence iOS).
    void AudioEngine.get().unlock();
    const settings = this.settings();
    const res = await openStream(
      {
        audio: {
          deviceId: settings.deviceId ? { exact: settings.deviceId } : undefined,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGain,
        },
      },
      "micro",
    );
    if (token !== this.token) {
      if ("stream" in res) stopStream(res.stream);
      return;
    }
    this.opening = false;
    if (!("stream" in res)) {
      this.patch({ status: res.status, error: res.error, active: false });
      return;
    }
    if (!this.wantActive) {
      stopStream(res.stream);
      return;
    }
    this.stream = res.stream;
    const track = res.stream.getAudioTracks()[0];
    track?.addEventListener("ended", () => {
      if (this.stream === res.stream) this.close("error", "le micro a été déconnecté");
    });
    this.patch({
      status: "ready",
      error: null,
      active: true,
      deviceId: track?.getSettings().deviceId ?? null,
      devices: await listDevices("audioinput"),
    });
    this.wire();
  }

  private close(status: CaptureStatus, error: string | null = null): void {
    this.token++;
    this.opening = false;
    stopStream(this.stream);
    this.stream = null;
    for (const n of [this.source, this.out, this.meter]) {
      try {
        n?.disconnect();
      } catch {
        /* ok */
      }
    }
    this.source = null;
    this.out = null;
    this.meter = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.patch({ status, error, active: false, rms: 0, peak: 0, db: -100 });
  }

  /** Graphe audio : source → gain (sortie) → [master si monitor] ; mesure de niveau. */
  private wire(): void {
    const engine = AudioEngine.get();
    const ac = engine.context;
    if (!this.stream || !ac || !engine.master) return;
    if (!this.source) {
      this.source = (ac as AudioContext).createMediaStreamSource(this.stream);
      this.out = ac.createGain();
      this.meter = ac.createAnalyser();
      this.meter.fftSize = 1024;
      this.meterData = new Float32Array(new ArrayBuffer(this.meter.fftSize * 4));
      this.source.connect(this.out);
      this.out.connect(this.meter);
      // L'analyseur doit être tiré par la destination pour être calculé : sortie muette.
      const sink = ac.createGain();
      sink.gain.value = 0;
      this.meter.connect(sink).connect(ac.destination);
      this.startMeter();
    }
    const { gain, monitor } = this.settings();
    this.out!.gain.setTargetAtTime(gain, ac.currentTime, 0.02);
    try {
      this.out!.disconnect(engine.master);
    } catch {
      /* pas connecté */
    }
    if (monitor) this.out!.connect(engine.master);
    this.patch({ monitor });
  }

  private startMeter(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const hz = this.settings().rate;
    if (!hz) return;
    this.timer = setInterval(() => {
      const m = this.meter;
      const d = this.meterData;
      if (!m || !d) return;
      m.getFloatTimeDomainData(d);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < d.length; i++) {
        sum += d[i] * d[i];
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / d.length);
      this.patch({
        rms: +rms.toFixed(4),
        peak: +peak.toFixed(4),
        db: rms > 0 ? +Math.max(-100, 20 * Math.log10(rms)).toFixed(1) : -100,
      });
    }, 1000 / hz);
  }

  private patch(p: Partial<MicState>): void {
    this.state = { ...this.state, ...p };
    this.publish();
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
    return html``;
  }
}

export default SonicMic;
