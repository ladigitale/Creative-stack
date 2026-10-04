/**
 * AudioEngine : un seul AudioContext par page, partagé par tous les addons
 * (et par tous les bundles autonomes, via un singleton sur `window`).
 *
 * - créé et repris dans le geste utilisateur lui-même (exigence iOS Safari) ;
 * - master : volume → limiteur (toujours actif) → sortie ;
 * - suspendu quand l'onglet est caché ;
 * - état publié dans le DataProvider `audio`.
 */
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";

export type AudioEngineState = {
  supported: boolean;
  /** Le navigateur a autorisé le son. */
  ready: boolean;
  state: string;
  sampleRate: number;
  /** Latence de sortie estimée en s (pour caler un visuel sur le son entendu). */
  latencyS: number;
  volume: number;
  muted: boolean;
};

type ContextFactory = () => BaseAudioContext;
type Listener = (engine: AudioEngine) => void;

const GLOBAL_KEY = "__creativeStackAudioEngine";
const GESTURES = ["pointerdown", "keydown", "touchend"] as const;
export const AUDIO_DP = "audio";

function nativeCtor(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class AudioEngine {
  private static factory: ContextFactory | null = null;

  /** Moteur de la page (créé au premier appel). */
  static get(): AudioEngine {
    const w = (typeof window !== "undefined" ? window : globalThis) as unknown as Record<string, AudioEngine | undefined>;
    let engine = w[GLOBAL_KEY];
    if (!engine) {
      engine = new AudioEngine();
      w[GLOBAL_KEY] = engine;
    }
    return engine;
  }

  /** Tests : impose une fabrique de contexte (OfflineAudioContext, faux contexte…). */
  static setContextFactory(factory: ContextFactory | null): void {
    AudioEngine.factory = factory;
  }

  /** Tests : détruit le moteur courant. */
  static reset(): void {
    const w = (typeof window !== "undefined" ? window : globalThis) as unknown as Record<string, AudioEngine | undefined>;
    w[GLOBAL_KEY]?.dispose();
    delete w[GLOBAL_KEY];
  }

  private ac: BaseAudioContext | null = null;
  private masterIn: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private listeners = new Set<Listener>();
  private unlocked = false;
  private volume = 0.8;
  private muted = false;

  private constructor() {
    if (typeof window === "undefined") return;
    for (const ev of GESTURES) window.addEventListener(ev, this.onGesture, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.publish();
  }

  get supported(): boolean {
    return Boolean(AudioEngine.factory || nativeCtor());
  }

  get ready(): boolean {
    return this.unlocked;
  }

  /** Contexte audio (null avant le premier geste). */
  get context(): BaseAudioContext | null {
    return this.ac;
  }

  /** Entrée du master (null avant le premier geste). */
  get master(): AudioNode | null {
    return this.masterIn;
  }

  /** Appelé à chaque changement (déverrouillage, état, volume). Retourne la désinscription. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Crée et reprend le contexte. À appeler depuis un geste utilisateur. */
  unlock(): Promise<void> {
    if (!this.ac) {
      const make = AudioEngine.factory ?? (() => new (nativeCtor()!)());
      if (!AudioEngine.factory && !nativeCtor()) return Promise.resolve();
      this.ac = make();
      this.buildMaster();
      (this.ac as AudioContext).onstatechange = () => this.refresh();
    }
    const ac = this.ac as AudioContext;
    // resume() appelé de façon synchrone dans le geste (iOS).
    const resumed =
      ac.state !== "running" && typeof ac.resume === "function" && !(typeof document !== "undefined" && document.hidden)
        ? ac.resume().catch(() => undefined)
        : Promise.resolve();
    return resumed.then(() => this.refresh());
  }

  setMaster(opts: { volume?: number; muted?: boolean }): void {
    if (typeof opts.volume === "number" && Number.isFinite(opts.volume)) {
      this.volume = Math.min(1, Math.max(0, opts.volume));
    }
    if (typeof opts.muted === "boolean") this.muted = opts.muted;
    this.applyMaster();
    this.emit();
  }

  getState(): AudioEngineState {
    const ac = this.ac as AudioContext | null;
    return {
      supported: this.supported,
      ready: this.unlocked,
      state: ac?.state ?? "closed",
      sampleRate: ac?.sampleRate ?? 0,
      latencyS: (ac?.outputLatency || 0) + (ac?.baseLatency || 0),
      volume: this.volume,
      muted: this.muted,
    };
  }

  private buildMaster(): void {
    const ac = this.ac!;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    limiter.connect(ac.destination);
    const master = ac.createGain();
    master.connect(limiter);
    this.limiter = limiter;
    this.masterIn = master;
    this.applyMaster(true);
  }

  private applyMaster(immediate = false): void {
    const g = this.masterIn?.gain;
    if (!g || !this.ac) return;
    const target = this.muted ? 0 : this.volume;
    if (immediate) g.setValueAtTime(target, this.ac.currentTime);
    else g.setTargetAtTime(target, this.ac.currentTime, 0.02);
  }

  private refresh(): void {
    const running = (this.ac as AudioContext | null)?.state === "running" || (this.ac !== null && !("resume" in this.ac));
    if (running && !this.unlocked) {
      this.unlocked = true;
      if (typeof window !== "undefined") {
        for (const ev of GESTURES) window.removeEventListener(ev, this.onGesture, { capture: true });
      }
    }
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      try {
        l(this);
      } catch (e) {
        console.warn("[creative-stack] AudioEngine listener", e);
      }
    }
    this.publish();
  }

  private publish(): void {
    try {
      set(AUDIO_DP, this.getState());
    } catch {
      /* DataProvider indisponible (tests purs) */
    }
  }

  private onGesture = (): void => {
    void this.unlock();
  };

  private onVisibility = (): void => {
    const ac = this.ac as AudioContext | null;
    if (!ac || typeof ac.suspend !== "function") return;
    if (document.hidden) void ac.suspend().then(() => this.emit());
    else if (this.unlocked) void ac.resume().then(() => this.emit());
  };

  private dispose(): void {
    if (typeof window !== "undefined") {
      for (const ev of GESTURES) window.removeEventListener(ev, this.onGesture, { capture: true });
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    const ac = this.ac as AudioContext | null;
    if (ac && typeof ac.close === "function") void ac.close().catch(() => undefined);
    this.limiter?.disconnect();
    this.ac = null;
    this.masterIn = null;
    this.limiter = null;
    this.listeners.clear();
  }
}

/** Résout une référence de flux : `master`, `#id` (élément exposant getAudioInput/getAudioOutput). */
export function resolveAudioElement(host: Element, ref: string): Element | null {
  const id = ref.trim().replace(/^#/, "");
  if (!id || id === "master") return null;
  const root = host.getRootNode() as Document | ShadowRoot;
  return (root.getElementById?.(id) ?? document.getElementById(id)) as Element | null;
}
