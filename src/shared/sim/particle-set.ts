/**
 * Systèmes de particules d'un monde, indépendants du rendu : naissances continues à leur source, salves sur ordre
 * (`fx.<id>`), enchaînements (`then`), traînées et impacts des émetteurs, lumières. Le rendu ne fait que dessiner les
 * tampons (forme close du mouvement).
 */
import type { Monde } from "../monde/format";
import type { Emitter, Hit } from "./emitter";
import { ParticleSystem, readFx, type ParticleSpec, type V3 } from "./particles";

type Pose = { x: number; y: number; z: number; ry: number };

export type ParticleLight = { color: string; intensity: number; radius: number; at: V3 };

function sigOf(s: ParticleSpec): string {
  return JSON.stringify([s.max, s.seed]);
}

export class ParticleSet {
  systems: ParticleSystem[] = [];
  private byId = new Map<string, ParticleSystem>();
  private orders = new Map<string, number>();
  vent: V3 = [0, 0, 0];
  private unit = 1;
  /** Horloge des particules (s), avancée par `step`. */
  now = 0;
  poseOf: ((name: string) => Pose | null) | null = null;

  get active(): boolean {
    for (const s of this.systems) if (s.alive(this.now)) return true;
    return false;
  }

  set(m: Monde) {
    this.unit = m.unit;
    this.vent = m.vent;
    const next = new Map<string, ParticleSystem>();
    for (const spec of m.particles) {
      const old = this.byId.get(spec.id);
      // même tampon : les grains en vol continuent, les réglages suivent la nouvelle lecture
      if (old && sigOf(old.spec) === sigOf(spec)) {
        Object.assign(old.spec, spec);
        next.set(spec.id, old);
      } else next.set(spec.id, new ParticleSystem(spec));
    }
    this.byId = next;
    this.systems = [...next.values()];
    for (const id of [...this.orders.keys()]) if (!next.has(id)) this.orders.delete(id);
  }

  get(id: string): ParticleSystem | undefined {
    return this.byId.get(id);
  }

  /** Source d'un système : instance suivie (avec `offset` dans son repère), sinon point. */
  private source(s: ParticleSpec): { at: V3; yaw: number } {
    const p = s.from ? this.poseOf?.(s.from) : null;
    const [ox, oy, oz] = s.offset;
    if (p) {
      const c = Math.cos(p.ry), sn = Math.sin(p.ry);
      return { at: [p.x + ox * c + oz * sn, p.y + oy, p.z - ox * sn + oz * c], yaw: p.ry };
    }
    return { at: [s.at[0] + ox, s.at[1] + oy, s.at[2] + oz], yaw: 0 };
  }

  /** Ordres `fx.<id>` : une salve à chaque hausse de `n` (la première lecture mémorise le compteur). */
  applyOrders(spec: unknown): boolean {
    if (!spec || typeof spec !== "object") return false;
    let any = false;
    for (const [id, raw] of Object.entries(spec as Record<string, unknown>)) {
      const sys = this.byId.get(id);
      if (!sys || !raw || typeof raw !== "object") continue;
      const n = typeof (raw as { n?: unknown }).n === "number" ? (raw as { n: number }).n : 0;
      const prev = this.orders.get(id);
      this.orders.set(id, n);
      if (prev === undefined || n <= prev) continue;
      const o = readFx(raw, this.unit);
      const src = this.source(sys.spec);
      for (let k = 0; k < Math.min(8, n - prev); k++) this.burst(sys, o.at ?? src.at, o, o.at ? 0 : src.yaw);
      any = true;
    }
    return any;
  }

  private burst(sys: ParticleSystem, at: V3, o: { scale?: number; color?: string; count?: number } = {}, yaw = 0) {
    sys.burstAt(this.now, at, o, yaw);
    if (sys.spec.then) sys.pending.push({ t: this.now + sys.spec.life[1] * 0.6, at: [...at] as V3, scale: o.scale ?? 1 });
  }

  /** Salve d'un système au point d'impact d'un émetteur (`burst` de l'émetteur). */
  impact(id: string, hit: Hit) {
    const sys = this.byId.get(id);
    if (sys) this.burst(sys, [hit.x, hit.y, hit.z]);
  }

  /** Traînées : chaque copie d'un émetteur sème `rate` grains par seconde là où elle passe. */
  trail(id: string, em: Emitter, dt: number) {
    const sys = this.byId.get(id);
    if (!sys || !em.n) return;
    const rate = sys.spec.rate > 0 ? sys.spec.rate : 30;
    const per = rate * dt;
    for (let i = 0; i < em.n; i++) {
      // tirage par copie : une fraction de grain se joue au hasard (pas d'accumulateur par copie)
      let k = Math.floor(per);
      if (Math.random() < per - k) k++;
      if (k > 0) sys.spawn(k, this.now, [em.px[i], em.py[i], em.pz[i]], em.heading(i), 1, 0, [em.vx[i] * 0.2, em.vy[i] * 0.2, em.vz[i] * 0.2]);
    }
  }

  /** Avance l'horloge : naissances continues, enchaînements arrivés à échéance. */
  step(dt: number) {
    this.now += dt;
    for (const sys of this.systems) {
      const s = sys.spec;
      if (s.rate > 0 && !this.trailed.has(s.id)) {
        const src = this.source(s);
        // nappe : population déjà en place au premier pas, plutôt qu'une vague de naissances simultanées
        if (s.mode === "nappe" && !sys.filled) sys.prefill(sys.steady(), this.now, src.at, src.yaw);
        sys.continuous(dt, this.now, src.at, src.yaw);
      }
      if (sys.pending.length) {
        const due = sys.pending.filter((p) => p.t <= this.now);
        if (due.length) {
          sys.pending = sys.pending.filter((p) => p.t > this.now);
          const next = this.byId.get(s.then);
          if (next && next !== sys) for (const p of due) next.burstAt(this.now, p.at, { scale: p.scale });
        }
      }
    }
  }

  /** Systèmes servant de traînée à un émetteur : pas de naissance continue à leur propre source. */
  trailed = new Set<string>();

  /** Lumières des systèmes qui en portent (4 au plus) : intensité selon l'âge de la dernière salve. */
  lights(): ParticleLight[] {
    const out: ParticleLight[] = [];
    for (const sys of this.systems) {
      const l = sys.spec.light;
      if (!l) continue;
      let k: number, at: V3;
      if (sys.spec.rate > 0) {
        k = 0;
        at = this.source(sys.spec).at;
      } else {
        const age = this.now - sys.lastBurst;
        const life = Math.max(0.05, sys.spec.life[1]);
        if (age > life) continue;
        k = age / life;
        at = sys.lastBurstAt;
      }
      const intensity = l.intensity[0] + (l.intensity[1] - l.intensity[0]) * k;
      if (intensity <= 0.01) continue;
      out.push({ color: l.color, intensity, radius: l.radius, at });
      if (out.length >= 4) break;
    }
    return out;
  }

  dispose() {
    this.systems = [];
    this.byId.clear();
    this.orders.clear();
  }
}
