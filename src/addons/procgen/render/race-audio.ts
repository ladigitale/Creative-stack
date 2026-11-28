/**
 * Son du mode course, entièrement généré (Web Audio, aucun fichier) : moteur de la voiture suivie (deux dents de scie
 * filtrées, régime qui monte et retombe à chaque rapport), crissement des pneus quand l'adhérence lâche, roulement sur
 * l'herbe, bips du compte à rebours, chocs.
 *
 * Le contexte audio n'est créé qu'au premier geste de l'utilisateur (règle des navigateurs) ; avant, tout est muet.
 */
export class RaceAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: { a: OscillatorNode; b: OscillatorNode; gain: GainNode; lp: BiquadFilterNode } | null = null;
  private skid: { gain: GainNode; bp: BiquadFilterNode } | null = null;
  private rumble: { gain: GainNode } | null = null;
  private enabled: boolean;
  private disposed = false;
  private volume = 0.55;

  constructor(enabled = true) {
    this.enabled = enabled;
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", this.unlock, { passive: true });
      window.addEventListener("keydown", this.unlock);
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.1);
  }

  dispose() {
    this.disposed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("pointerdown", this.unlock);
      window.removeEventListener("keydown", this.unlock);
    }
    void this.ctx?.close();
    this.ctx = null;
  }

  private unlock = () => {
    if (this.disposed) return;
    if (!this.ctx) {
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AC = w.AudioContext ?? w.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch {
        return;
      }
      this.build();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  };

  private build() {
    const c = this.ctx;
    if (!c) return;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.master = c.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    comp.connect(this.master).connect(c.destination);
    const n = c.sampleRate * 2;
    this.noise = c.createBuffer(1, n, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    // moteur
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    lp.Q.value = 2;
    const gain = c.createGain();
    gain.gain.value = 0;
    const a = c.createOscillator(), b = c.createOscillator();
    a.type = "sawtooth";
    b.type = "square";
    a.frequency.value = 50;
    b.frequency.value = 25;
    const bg = c.createGain();
    bg.gain.value = 0.35;
    a.connect(lp);
    b.connect(bg).connect(lp);
    lp.connect(gain).connect(comp);
    a.start();
    b.start();
    this.engine = { a, b, gain, lp };
    // pneus
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1900;
    bp.Q.value = 6;
    const sg = c.createGain();
    sg.gain.value = 0;
    src.connect(bp).connect(sg).connect(comp);
    src.start();
    this.skid = { gain: sg, bp };
    // roulement hors piste
    const src2 = c.createBufferSource();
    src2.buffer = this.noise;
    src2.loop = true;
    const lp2 = c.createBiquadFilter();
    lp2.type = "lowpass";
    lp2.frequency.value = 260;
    const rg = c.createGain();
    rg.gain.value = 0;
    src2.connect(lp2).connect(rg).connect(comp);
    src2.start();
    this.rumble = { gain: rg };
  }

  /** Une image : vitesse (m/s), part de la pointe, accélérateur, glisse (m/s²), hors piste. */
  update(speed: number, top: number, throttle: number, slip: number, off: boolean) {
    const c = this.ctx;
    if (!c || !this.engine) return;
    const t = c.currentTime;
    const v = Math.abs(speed);
    // cinq rapports : le régime remonte de 0,45 à 1 dans chacun
    const r = Math.min(0.999, v / Math.max(1, top));
    const gear = Math.min(4, Math.floor(r * 5));
    const inGear = r * 5 - gear;
    const rpm = v < 0.5 ? 0.18 : 0.42 + 0.55 * inGear + gear * 0.03;
    const f = 34 + rpm * 140;
    this.engine.a.frequency.setTargetAtTime(f, t, 0.04);
    this.engine.b.frequency.setTargetAtTime(f / 2, t, 0.04);
    this.engine.lp.frequency.setTargetAtTime(500 + rpm * 1400 + throttle * 600, t, 0.05);
    this.engine.gain.gain.setTargetAtTime(0.07 + 0.1 * Math.max(0, throttle) + 0.05 * rpm, t, 0.06);
    const sk = Math.min(1, Math.max(0, slip - 1.5) / 9) * Math.min(1, v / 6);
    this.skid!.gain.gain.setTargetAtTime(sk * 0.22, t, 0.05);
    this.skid!.bp.frequency.setTargetAtTime(1500 + sk * 900, t, 0.08);
    this.rumble!.gain.gain.setTargetAtTime(off ? Math.min(0.4, v / 40) : 0, t, 0.08);
  }

  /** Bip du compte à rebours (aigu au départ). */
  beep(go: boolean) {
    const c = this.ctx;
    if (!c || !this.master) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = "square";
    o.frequency.value = go ? 880 : 440;
    const t = c.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (go ? 0.6 : 0.25));
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.7);
  }

  /** Choc (contre le décor ou une autre voiture) : force 0 … 1. */
  thud(k: number) {
    const c = this.ctx;
    if (!c || !this.master || !this.noise) return;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 380 + k * 500;
    const g = c.createGain();
    const t = c.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15 + 0.4 * k, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    s.connect(lp).connect(g).connect(this.master);
    s.start(t);
    s.stop(t + 0.35);
  }
}
