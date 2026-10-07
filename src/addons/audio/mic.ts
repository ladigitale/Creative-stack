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
};

/**
 * Micro : source audio pour un analyseur, un enregistreur, un patch…
 * N'est **jamais** envoyé vers les haut-parleurs, sauf avec `monitor` (effet Larsen).
 *
 * Démarrage : `active` (attribut ou DP `control`), `autostart` (au premier geste),
 * ou un bouton `sonic-audio-unlock start="mic"` / `sonic-media-start for="mic"`.
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

  /** DataProvider de pilotage : { active, monitor, gain, deviceId }. */
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
  };
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
    if (changed.has("monitor") || changed.has("gain")) this.wire();
    if (changed.has("deviceId") && changed.get("deviceId") !== undefined && this.stream) this.restart();
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

  /* ---------------------------------------------------------------- */

  private listenControl(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (!this.control) return;
    this.unsubs.push(
      listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        const m = bool(c.monitor);
        if (m !== undefined) this.monitor = m;
        const g = num(c.gain, 0, 4);
        if (g !== undefined) this.gain = g;
        if (typeof c.deviceId === "string" && c.deviceId !== this.deviceId) this.deviceId = c.deviceId;
        const a = bool(c.active);
        if (a !== undefined) this.setActive(a);
      }),
    );
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
    const res = await openStream(
      {
        audio: {
          deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
          echoCancellation: this.echoCancellation,
          noiseSuppression: this.noiseSuppression,
          autoGainControl: this.autoGain,
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
    this.out!.gain.setTargetAtTime(Math.max(0, this.gain), ac.currentTime, 0.02);
    try {
      this.out!.disconnect(engine.master);
    } catch {
      /* pas connecté */
    }
    if (this.monitor) this.out!.connect(engine.master);
    this.patch({ monitor: this.monitor });
  }

  private startMeter(): void {
    if (this.timer) clearInterval(this.timer);
    const hz = Math.min(60, Math.max(0, this.rate || 0));
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
