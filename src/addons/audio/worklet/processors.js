/**
 * Processeurs AudioWorklet de creative-stack (un seul fichier, sans import :
 * chargé tel quel par audioWorklet.addModule).
 *
 * - cs-osc     : oscillateur PolyBLEP (scie, carré, impulsion, triangle, sinus) avec synchro dure
 * - cs-ladder  : filtre « ladder » 4 pôles non linéaire (24 dB/oct, auto-oscillation)
 * - cs-fold    : wavefolder sinusoïdal suréchantillonné ×2, quantité modulable
 * - cs-karplus : corde pincée Karplus-Strong (excitation au front montant de `gate`)
 * - cs-modal   : banc de résonateurs 2 pôles (partiels modifiables à chaud, coefficients par bloc)
 */

const TAU = Math.PI * 2;

/** Correction PolyBLEP d'une discontinuité de hauteur 2 à la phase 0. */
function polyBlep(t, dt) {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** tanh rapide (Padé), borné. */
function softClip(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

const at = (arr, i) => (arr.length > 1 ? arr[i] : arr[0]);

class CsOsc extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency", defaultValue: 440, minValue: 0, maxValue: 22000, automationRate: "a-rate" },
      { name: "detune", defaultValue: 0, minValue: -9600, maxValue: 9600, automationRate: "a-rate" },
      { name: "syncHz", defaultValue: 0, minValue: 0, maxValue: 22000, automationRate: "a-rate" },
      { name: "pw", defaultValue: 0.5, minValue: 0.02, maxValue: 0.98, automationRate: "a-rate" },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.wave = o.wave || "sawtooth";
    this.phase = 0;
    this.mphase = 0;
    this.tri = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.alive = false;
      else if (e.data && e.data.wave) this.wave = e.data.wave;
    };
  }

  naive(p, pw) {
    switch (this.wave) {
      case "square":
      case "pulse":
        return p < pw ? 1 : -1;
      case "sine":
        return Math.sin(TAU * p);
      case "triangle":
        return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
      default:
        return 2 * p - 1;
    }
  }

  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return this.alive;
    const fr = params.frequency, dn = params.detune, sh = params.syncHz, pwA = params.pw;
    const wave = this.wave;
    for (let i = 0; i < out.length; i++) {
      const ratio = Math.pow(2, at(dn, i) / 1200);
      const dt = Math.min(0.5, (at(fr, i) * ratio) / sampleRate);
      const pw = wave === "square" ? 0.5 : at(pwA, i);
      const mdt = (at(sh, i) * ratio) / sampleRate;
      let p = this.phase;
      let y;
      // synchro dure : remise à zéro de la phase quand l'oscillateur maître boucle
      let reset = false;
      if (mdt > 0) {
        this.mphase += mdt;
        if (this.mphase >= 1) {
          this.mphase -= 1;
          reset = true;
        }
      }
      if (reset) {
        // si l'esclave vient de boucler (synchro quasi simultanée), la discontinuité part de sa valeur d'avant le bouclage
        const before = this.naive(p < dt ? p - dt + 1 : p, pw);
        const frac = mdt > 0 ? this.mphase / mdt : 0; // fraction d'échantillon écoulée depuis le reset
        p = frac * dt;
        const after = this.naive(p, pw);
        y = after + ((after - before) / 2) * polyBlep(p, dt);
        if (wave === "triangle") this.tri = after;
      } else if (wave === "sine") {
        y = Math.sin(TAU * p);
      } else if (wave === "triangle") {
        y = p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
      } else if (wave === "square" || wave === "pulse") {
        y = (p < pw ? 1 : -1) + polyBlep(p, dt) - polyBlep((p - pw + 1) % 1, dt);
      } else {
        y = 2 * p - 1 - polyBlep(p, dt);
      }
      out[i] = y;
      p += dt;
      if (p >= 1) p -= 1;
      this.phase = p;
    }
    return this.alive;
  }
}

class CsLadder extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency", defaultValue: 1000, minValue: 10, maxValue: 22000, automationRate: "a-rate" },
      { name: "detune", defaultValue: 0, minValue: -9600, maxValue: 9600, automationRate: "a-rate" },
      { name: "resonance", defaultValue: 0.3, minValue: 0, maxValue: 1.2, automationRate: "a-rate" },
      { name: "drive", defaultValue: 1, minValue: 0.1, maxValue: 10, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.s = [0, 0, 0, 0];
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.alive = false;
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    if (!out) return this.alive;
    const s = this.s;
    const fr = params.frequency, dn = params.detune, rs = params.resonance, dr = params.drive;
    for (let i = 0; i < out.length; i++) {
      const x0 = input ? input[i] : 0;
      const fc = Math.min(0.45, (at(fr, i) * Math.pow(2, at(dn, i) / 1200)) / sampleRate);
      // suréchantillonnage ×2 : stable jusqu'à l'aigu
      const g = 1 - Math.exp((-TAU * fc) / 2);
      const k = at(rs, i) * 4;
      const drive = at(dr, i);
      let y = 0;
      for (let os = 0; os < 2; os++) {
        const u = softClip(drive * x0 - k * s[3]);
        s[0] += g * (u - softClip(s[0]));
        s[1] += g * (softClip(s[0]) - softClip(s[1]));
        s[2] += g * (softClip(s[1]) - softClip(s[2]));
        s[3] += g * (softClip(s[2]) - softClip(s[3]));
        y = s[3];
      }
      // compense la perte de niveau due à la résonance
      out[i] = (y * (1 + at(rs, i) * 0.8)) / Math.max(1, Math.sqrt(drive));
    }
    if (!input) {
      // entrée débranchée : laisser mourir la résonance
      if (Math.abs(s[3]) < 1e-6 && Math.abs(s[0]) < 1e-6) s[0] = s[1] = s[2] = s[3] = 0;
    }
    return this.alive;
  }
}

class CsFold extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "amount", defaultValue: 2, minValue: 0, maxValue: 12, automationRate: "a-rate" },
      { name: "bias", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.prev = 0;
    this.lp = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.alive = false;
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    if (!out) return this.alive;
    const am = params.amount, bi = params.bias;
    const mix = params.mix[0];
    for (let i = 0; i < out.length; i++) {
      const x = input ? input[i] : 0;
      const a = Math.max(0.0001, at(am, i));
      const b = at(bi, i);
      // ×2 : point intermédiaire interpolé, puis moyenne (anti-repliement simple)
      const mid = (x + this.prev) * 0.5;
      const y1 = Math.sin((Math.PI / 2) * (mid * a + b));
      const y2 = Math.sin((Math.PI / 2) * (x * a + b));
      this.prev = x;
      const y = (y1 + y2) * 0.5;
      // retire la composante continue introduite par bias
      this.lp += 0.0005 * (y - this.lp);
      out[i] = mix * (y - this.lp) + (1 - mix) * x;
    }
    return this.alive;
  }
}

class CsKarplus extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency", defaultValue: 220, minValue: 20, maxValue: 8000, automationRate: "a-rate" },
      { name: "detune", defaultValue: 0, minValue: -9600, maxValue: 9600, automationRate: "a-rate" },
      { name: "gate", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" },
      { name: "decay", defaultValue: 1.5, minValue: 0.02, maxValue: 30, automationRate: "k-rate" },
      { name: "damp", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.buf = new Float32Array(Math.ceil(sampleRate / 20) + 4);
    this.w = 0;
    this.burst = 0;
    this.burstLp = 0;
    this.lastGate = 0;
    this.prevOut = 0;
    this.seed = 0x12345678;
    this.energy = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.alive = false;
    };
  }

  noise() {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  }

  process(inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return this.alive;
    const ext = inputs[0] && inputs[0][0];
    const buf = this.buf;
    const n = buf.length;
    const decay = params.decay[0];
    const damp = params.damp[0];
    const bright = 1 - damp * 0.9;
    let energy = 0;
    for (let i = 0; i < out.length; i++) {
      const f = Math.max(20, at(params.frequency, i) * Math.pow(2, at(params.detune, i) / 1200));
      const gate = at(params.gate, i);
      if (gate > 0.5 && this.lastGate <= 0.5) this.burst = Math.max(2, Math.round(sampleRate / f));
      this.lastGate = gate;
      const delay = Math.min(n - 3, sampleRate / f - 0.5);
      // lecture fractionnaire (interpolation linéaire)
      let r = this.w - delay;
      if (r < 0) r += n;
      const i0 = Math.floor(r);
      const fr = r - i0;
      const a = buf[i0 % n];
      const b = buf[(i0 + 1) % n];
      const y = a + (b - a) * fr;
      // filtre de boucle : moyenne pondérée (clarté) + atténuation pour `decay` s à -60 dB
      const g = Math.pow(10, -3 / (decay * f));
      const lp = bright * y + (1 - bright) * this.prevOut;
      this.prevOut = lp;
      let excite = 0;
      if (this.burst > 0) {
        this.burstLp += bright * (this.noise() - this.burstLp);
        excite = this.burstLp;
        this.burst--;
      }
      if (ext) excite += ext[i];
      buf[this.w] = lp * g + excite;
      this.w = (this.w + 1) % n;
      out[i] = y;
      energy += y * y;
    }
    this.energy = energy;
    return this.alive;
  }
}

/**
 * Banc modal : N résonateurs à 2 pôles (zéros en ±1, gain ≈ 1 au pic) sommés.
 * Fréquence, désaccord et Q sont k-rate : les coefficients ne sont recalculés
 * que lorsqu'ils changent (au plus une fois par bloc de 128 échantillons).
 * Message `{ ratios, gains, cents }` : nouveaux partiels sans recréer le nœud.
 * Entrée muette et résonance éteinte : le bloc n'est pas calculé.
 */
class CsModal extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency", defaultValue: 220, minValue: 0, maxValue: 22000, automationRate: "k-rate" },
      { name: "detune", defaultValue: 0, minValue: -9600, maxValue: 9600, automationRate: "k-rate" },
      { name: "q", defaultValue: 40, minValue: 1, maxValue: 1000, automationRate: "k-rate" },
    ];
  }

  constructor(options) {
    super();
    this.n = 0;
    this.lastF = -1;
    this.lastQ = -1;
    this.idle = false;
    this.alive = true;
    this.configure((options && options.processorOptions) || {});
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.alive = false;
      else if (e.data && typeof e.data === "object") this.configure(e.data);
    };
  }

  configure(o) {
    const ratios = Array.isArray(o.ratios) && o.ratios.length ? o.ratios.slice(0, 32) : [1, 2, 3, 4, 5, 6];
    const n = ratios.length;
    const old = { y1: this.y1, y2: this.y2, n: this.n };
    this.ratios = Float64Array.from(ratios, Number);
    this.gains = Float64Array.from(ratios, (_, i) => {
      const g = Array.isArray(o.gains) ? Number(o.gains[i]) : NaN;
      return Number.isFinite(g) ? g : 1 / Math.sqrt(i + 1);
    });
    this.mul = Float64Array.from(ratios, (_, i) => {
      const c = Array.isArray(o.cents) ? Number(o.cents[i]) : 0;
      return Math.pow(2, (Number.isFinite(c) ? c : 0) / 1200);
    });
    this.a1 = new Float64Array(n);
    this.a2 = new Float64Array(n);
    this.b = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.y2 = new Float64Array(n);
    // garde la résonance en cours des partiels conservés (pas de clic au changement)
    if (old.y1) for (let k = 0; k < Math.min(n, old.n); k++) {
      this.y1[k] = old.y1[k];
      this.y2[k] = old.y2[k];
    }
    this.x1 = this.x1 || 0;
    this.x2 = this.x2 || 0;
    this.n = n;
    this.lastF = -1;
  }

  coefficients(f, q) {
    const nyq = sampleRate * 0.49;
    for (let k = 0; k < this.n; k++) {
      const fk = f * this.ratios[k] * this.mul[k];
      if (!(fk > 0) || fk >= nyq) {
        this.a1[k] = this.a2[k] = this.b[k] = 0;
        continue;
      }
      const r = Math.exp((-Math.PI * (fk / q)) / sampleRate);
      this.a1[k] = 2 * r * Math.cos((TAU * fk) / sampleRate);
      this.a2[k] = r * r;
      this.b[k] = (1 - r * r) * 0.5;
    }
    this.lastF = f;
    this.lastQ = q;
  }

  process(inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return this.alive;
    const input = inputs[0] && inputs[0][0];
    const n = this.n;
    let peakIn = 0;
    if (input) for (let i = 0; i < input.length; i++) {
      const a = input[i] < 0 ? -input[i] : input[i];
      if (a > peakIn) peakIn = a;
    }
    if (peakIn < 1e-7 && this.idle) {
      out.fill(0);
      return this.alive;
    }
    const f = params.frequency[0] * Math.pow(2, params.detune[0] / 1200);
    const q = params.q[0];
    if (f !== this.lastF || q !== this.lastQ) this.coefficients(f, q);
    const { a1, a2, b, gains, y1, y2 } = this;
    const makeup = Math.sqrt(q) * 0.5;
    let x1 = this.x1, x2 = this.x2;
    let energy = 0;
    for (let i = 0; i < out.length; i++) {
      const x = input ? input[i] : 0;
      const dx = x - x2;
      let sum = 0;
      for (let k = 0; k < n; k++) {
        const y = b[k] * dx + a1[k] * y1[k] - a2[k] * y2[k];
        y2[k] = y1[k];
        y1[k] = y;
        sum += gains[k] * y;
      }
      x2 = x1;
      x1 = x;
      const o = sum * makeup;
      out[i] = o;
      energy += o * o;
    }
    this.x1 = x1;
    this.x2 = x2;
    // résonance éteinte : états remis à zéro (évite les nombres dénormalisés) et blocs suivants sautés
    this.idle = peakIn < 1e-7 && energy < 1e-12;
    if (this.idle) {
      y1.fill(0);
      y2.fill(0);
      this.x1 = this.x2 = 0;
    }
    return this.alive;
  }
}

registerProcessor("cs-osc", CsOsc);
registerProcessor("cs-ladder", CsLadder);
registerProcessor("cs-fold", CsFold);
registerProcessor("cs-karplus", CsKarplus);
registerProcessor("cs-modal", CsModal);
