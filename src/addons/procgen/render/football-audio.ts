/**
 * Ambiance sonore du mode football, entièrement générée (Web Audio, aucun fichier) : rumeur de la foule qui monte
 * quand le ballon approche d'un but, « ooh » sur une occasion, clameur au but, chants rythmés avec tambour pendant les
 * temps calmes, sifflet de l'arbitre (coup d'envoi, faute, mi-temps, fin), frappes selon leur puissance, rebonds,
 * poteau qui sonne, filet, tacles. Au ralenti, tout passe derrière un filtre (son étouffé de ralenti télévisé).
 *
 * Le contexte audio n'est créé qu'au premier geste de l'utilisateur (règle des navigateurs) ; avant, tout est muet.
 */

type Ctx = AudioContext;

export class FootballAudio {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private muffle: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private bed: { gain: GainNode; chatter: GainNode; hi: BiquadFilterNode } | null = null;
  private excite = 0.3;
  private chantT = 12;
  private enabled = true;
  private disposed = false;
  private volume = 0.8;

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
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    // bus : filtre de ralenti → compresseur → volume
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master = c.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.muffle = c.createBiquadFilter();
    this.muffle.type = "lowpass";
    this.muffle.frequency.value = 18000;
    this.muffle.connect(comp).connect(this.master).connect(c.destination);
    // bruit blanc partagé (2 s, en boucle)
    const n = c.sampleRate * 2;
    this.noise = c.createBuffer(1, n, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    // rumeur de fond : grave (murmure de milliers de voix) + bavardage modulé (voix qui se lèvent et retombent)
    const src = this.loop();
    const low = c.createBiquadFilter();
    low.type = "bandpass";
    low.frequency.value = 420;
    low.Q.value = 0.6;
    const gain = c.createGain();
    gain.gain.value = 0.25;
    src.connect(low).connect(gain).connect(this.muffle);
    const src2 = this.loop();
    const hi = c.createBiquadFilter();
    hi.type = "bandpass";
    hi.frequency.value = 1100;
    hi.Q.value = 1.4;
    const chatter = c.createGain();
    chatter.gain.value = 0.06;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoG = c.createGain();
    lfoG.gain.value = 0.03;
    lfo.connect(lfoG).connect(chatter.gain);
    lfo.start();
    src2.connect(hi).connect(chatter).connect(this.muffle);
    this.bed = { gain, chatter, hi };
  }

  private loop(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 1.5);
    return s;
  }

  private get ok(): boolean {
    return !!this.ctx && this.ctx.state === "running" && this.enabled;
  }

  /** Une image : tension du jeu (0 … 1, ballon près d'un but, occasion), ralenti, temps calme pour les chants. */
  update(dt: number, excite: number, slow: boolean, calm: boolean) {
    if (!this.ok || !this.bed) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.excite += (excite - this.excite) * Math.min(1, dt * 1.5);
    this.bed.gain.gain.setTargetAtTime(0.16 + 0.3 * this.excite, t, 0.3);
    this.bed.hi.frequency.setTargetAtTime(900 + 700 * this.excite, t, 0.4);
    this.muffle!.frequency.setTargetAtTime(slow ? 700 : 18000, t, slow ? 0.08 : 0.25);
    this.chantT -= dt;
    if (calm && this.chantT <= 0) {
      this.chant();
      this.chantT = 22 + Math.random() * 18;
    }
  }

  /* ---------------- foule ---------------- */

  /** Voix en masse : bruit coloré par des formants de voyelle, enveloppe montée puis tenue puis chute. */
  private crowd(level: number, attack: number, hold: number, release: number, formants: [number, number][], sweep = 0) {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(level, t + attack);
    out.gain.setValueAtTime(level, t + attack + hold);
    out.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    out.connect(this.muffle!);
    const end = t + attack + hold + release + 0.1;
    for (const [f, g] of formants) {
      const s = this.loop();
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 2.2;
      bp.frequency.setValueAtTime(f, t);
      if (sweep) bp.frequency.linearRampToValueAtTime(f * (1 + sweep), t + attack + hold * 0.6);
      const gg = c.createGain();
      gg.gain.value = g;
      s.connect(bp).connect(gg).connect(out);
      s.stop(end);
    }
  }

  /** « Ooooh » : occasion manquée, arrêt, poteau. */
  ooh(k = 1) {
    this.crowd(0.5 * k, 0.25, 0.5, 1.1, [[380, 1], [760, 0.7], [2400, 0.15]], 0.25);
  }
  /** Clameur du but : explosion puis tenue, longue. */
  roar() {
    this.crowd(0.9, 0.12, 3.2, 3.5, [[650, 1], [1150, 0.8], [2600, 0.35], [300, 0.6]], 0.15);
    this.horns();
  }
  /** Sifflets de la foule (faute) : voix aiguës. */
  boo() {
    this.crowd(0.28, 0.3, 0.8, 1, [[300, 1], [600, 0.6]], -0.1);
  }
  /** Applaudissements : rafales de claquements. */
  applause(dur = 2.5, level = 0.35) {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const s = this.loop();
    const hp = c.createBiquadFilter();
    hp.type = "bandpass";
    hp.frequency.value = 2200;
    hp.Q.value = 0.7;
    const g = c.createGain();
    // grain des claquements : bruit d'amplitude rapide
    const am = c.createOscillator();
    am.type = "square";
    am.frequency.value = 23;
    const amG = c.createGain();
    amG.gain.value = level * 0.35;
    am.connect(amG).connect(g.gain);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(hp).connect(g).connect(this.muffle!);
    am.start(t);
    am.stop(t + dur + 0.1);
    s.stop(t + dur + 0.1);
  }
  /** Chant de tribune : clap-clap-clapclapclap sur un tambour, deux fois. */
  private chant() {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t0 = c.currentTime + 0.05;
    const beat = 0.32;
    const pattern = [0, 1, 2, 2.5, 3, 4.5, 5, 6, 6.5, 7];
    for (let r = 0; r < 2; r++)
      for (const b of pattern) {
        const t = t0 + (r * 8 + b) * beat;
        this.clap(t, 0.22);
        if (b % 1 === 0 && b % 2 === 0) this.drum(t, 0.35);
      }
    // voix qui portent le chant
    this.crowd(0.18, 0.4, beat * 14, 0.8, [[520, 1], [1040, 0.5]]);
  }
  private clap(t: number, level: number) {
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500;
    bp.Q.value = 0.9;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    s.connect(bp).connect(g).connect(this.muffle!);
    s.start(t, Math.random());
    s.stop(t + 0.2);
  }
  private drum(t: number, level: number) {
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const o = c.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.25);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g).connect(this.muffle!);
    o.start(t);
    o.stop(t + 0.5);
  }
  /** Cornes de supporters après un but. */
  private horns() {
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    for (let k = 0; k < 4; k++) {
      const t = c.currentTime + 0.4 + k * 0.45 + Math.random() * 0.2;
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = 233 + Math.random() * 40;
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1400;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.05);
      g.gain.setValueAtTime(0.07, t + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(lp).connect(g).connect(this.muffle!);
      o.start(t);
      o.stop(t + 1);
    }
  }

  /* ---------------- jeu ---------------- */

  /** Sifflet de l'arbitre : `blasts` coups (durées en s), trille de la bille. */
  whistle(blasts: number[] = [0.35]) {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    let t = c.currentTime + 0.02;
    for (const d of blasts) {
      const o = c.createOscillator();
      o.frequency.value = 2950;
      const o2 = c.createOscillator();
      o2.frequency.value = 3240;
      // la bille qui roule dans le sifflet : modulation d'amplitude rapide
      const trill = c.createOscillator();
      trill.frequency.value = 34;
      const tg = c.createGain();
      tg.gain.value = 0.05;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.setValueAtTime(0.12, t + d);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.06);
      trill.connect(tg).connect(g.gain);
      const g2 = c.createGain();
      g2.gain.value = 0.4;
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(this.muffle!);
      for (const x of [o, o2, trill]) {
        x.start(t);
        x.stop(t + d + 0.1);
      }
      t += d + 0.18;
    }
  }

  /** Frappe du ballon : coup sourd (cuir), plus clair et plus fort selon la puissance. */
  kick(power: number) {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const k = Math.max(0.15, Math.min(1, power / 28));
    const o = c.createOscillator();
    o.frequency.setValueAtTime(170 + 60 * k, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 + 0.45 * k, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(this.muffle!);
    o.start(t);
    o.stop(t + 0.16);
    // claquement du cuir
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const gn = c.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(0.08 + 0.2 * k, t + 0.002);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    s.connect(hp).connect(gn).connect(this.muffle!);
    s.start(t, Math.random());
    s.stop(t + 0.05);
  }
  /** Rebond sur la pelouse. */
  bounce(speed: number) {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const k = Math.max(0.05, Math.min(0.5, speed / 20));
    const o = c.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.06);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(k, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(this.muffle!);
    o.start(t);
    o.stop(t + 0.1);
  }
  /** Poteau : métal creux qui résonne (partiels inharmoniques). */
  post() {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    for (const [f, a, d] of [[520, 0.2, 1.4], [1310, 0.12, 0.9], [2210, 0.08, 0.6], [3170, 0.05, 0.4]] as const) {
      const o = c.createOscillator();
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(a, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(this.muffle!);
      o.start(t);
      o.stop(t + d + 0.05);
    }
    this.kick(18);
  }
  /** Filet qui se tend. */
  net() {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(2500, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.35);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    s.connect(bp).connect(g).connect(this.muffle!);
    s.start(t, Math.random());
    s.stop(t + 0.5);
  }
  /** Contact : tacle, chute (choc sourd dans l'herbe). */
  thud(level = 0.35) {
    if (!this.ok) return;
    // contexte fermé entre-temps (son programmé avec un délai, recomposition du match) : rien à jouer
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 380;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    s.connect(lp).connect(g).connect(this.muffle!);
    s.start(t, Math.random());
    s.stop(t + 0.3);
  }
}
