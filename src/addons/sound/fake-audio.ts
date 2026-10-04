/**
 * Faux AudioContext minimal pour tester le moteur sous jsdom.
 * Enregistre les nœuds créés ; le temps avance via `advance()`.
 */
class FakeParam {
  value = 0;
  events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number) { this.events.push(["set", v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(["lin", v, t]); return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push(["exp", v, t]); return this; }
  setTargetAtTime(v: number, t: number) { this.events.push(["target", v, t]); this.value = v; return this; }
  cancelScheduledValues() { return this; }
}

class FakeNode {
  ctx: FakeAudioContext;
  outputs: unknown[] = [];
  constructor(ctx: FakeAudioContext) { this.ctx = ctx; }
  connect(n: unknown) { this.outputs.push(n); return n; }
  disconnect() { this.outputs = []; }
}

class FakeSource extends FakeNode {
  frequency = new FakeParam();
  detune = new FakeParam();
  playbackRate = new FakeParam();
  type = "sine";
  buffer: unknown = null;
  loop = false;
  startAt = -1;
  stopAt = -1;
  onended: (() => void) | null = null;
  start(t = 0) { this.startAt = t; this.ctx.sources.push(this); }
  stop(t = 0) { this.stopAt = t; }
}

export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8000;
  state = "suspended";
  destination = {};
  sources: FakeSource[] = [];
  gains: { gain: FakeParam }[] = [];
  createGain() { const n = Object.assign(new FakeNode(this), { gain: new FakeParam() }); n.gain.value = 1; this.gains.push(n); return n; }
  createOscillator() { return new FakeSource(this); }
  createBufferSource() { return new FakeSource(this); }
  createBiquadFilter() { return Object.assign(new FakeNode(this), { type: "lowpass", frequency: new FakeParam(), Q: new FakeParam() }); }
  createStereoPanner() { return Object.assign(new FakeNode(this), { pan: new FakeParam() }); }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(this), {
      threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(), release: new FakeParam(),
    });
  }
  createBuffer(_c: number, len: number) { const d = new Float32Array(len); return { getChannelData: () => d }; }
  async resume() { this.state = "running"; }
  async suspend() { this.state = "suspended"; }
  async close() { this.state = "closed"; }
  /** Avance l'horloge et termine les sources arrêtées. */
  advance(seconds: number) {
    this.currentTime += seconds;
    for (const s of this.sources.splice(0)) {
      if (s.stopAt <= this.currentTime) s.onended?.();
      else this.sources.push(s);
    }
  }
}
