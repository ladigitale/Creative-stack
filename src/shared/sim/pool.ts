/**
 * Pool d'émetteurs indépendant du monde qui les porte : simulations gardées d'une lecture à l'autre (tant que la
 * définition ne change pas), ordres du DataProvider (`emit.<id>`), avance groupée, touches et fins de vie regroupées,
 * état publié. Le format monde (`EmitterSet`, sonic-3d / sonic-2d) et `sonic-procgen` n'apportent que le `SimWorld`
 * (boîtes, sol, eau, poses) et le dessin.
 */
import { Emitter, readOrder, type EmitterSpec, type Hit, type SimWorld } from "./emitter";

export type EmitStats = Record<string, { alive: number; emitted: number; dropped: number; expired: number; exited?: number; ms: number; near?: { id: number; x: number; y: number; z: number; d: number }[] }>;

type Slot = { sig: string; sim: Emitter; seeded: boolean };

/** Signature d'une définition : ce qui oblige à repartir de zéro si cela change. */
export function emitterSig(s: EmitterSpec): string {
  return JSON.stringify([s.model, s.variants, s.behavior, s.max, s.spawn, s.seed, s.flock?.altitude ?? null]);
}

export class EmitterPool {
  protected slots = new Map<string, Slot>();
  /** Simulations courantes, dans l'ordre de la définition. */
  sims: Emitter[] = [];
  private orderCounts = new Map<string, { n: number; clear: number; kill: number }>();
  protected unit = 1;
  private hits: Hit[] = [];
  onHits: ((hits: Hit[]) => void) | null = null;
  onExpire: ((e: { emitter: string; count: number }) => void) | null = null;
  /** Projectiles sortis de la scène (`events: ["exit"]`). */
  onExit: ((e: { emitter: string; count: number }) => void) | null = null;

  get active(): boolean {
    for (const s of this.sims) if (s.n > 0 || s.spec.rate > 0) return true;
    return false;
  }

  /** Simulation d'un émetteur par son nom. */
  sim(id: string): Emitter | null {
    return this.slots.get(id)?.sim ?? null;
  }

  /** Monte des définitions ; celles qui n'ont pas changé gardent leurs copies (réglages vivants recopiés). */
  protected mountSpecs(specs: readonly EmitterSpec[], world: () => SimWorld) {
    const next = new Map<string, Slot>();
    for (const spec of specs) {
      const sig = emitterSig(spec);
      const old = this.slots.get(spec.id);
      let slot: Slot;
      if (old && old.sig === sig) {
        // les réglages vivants (vitesse, cible, débit…) suivent la nouvelle lecture
        Object.assign(old.sim.spec, spec);
        slot = old;
      } else slot = { sig, sim: new Emitter(spec), seeded: false };
      next.set(spec.id, slot);
    }
    this.slots = next;
    this.sims = [...next.values()].map((s) => s.sim);
    for (const id of [...this.orderCounts.keys()]) if (!next.has(id)) this.orderCounts.delete(id);
    let w: SimWorld | null = null;
    for (const s of this.slots.values())
      if (!s.seeded) {
        s.seeded = true;
        s.sim.seed((w ??= world()));
      }
  }

  /**
   * Ordres `emit.<id>` : salve à chaque hausse de `n` (`count` copies), `clear` (compteur) vide le pool,
   * `kill: {n, ids}` retire des copies. La première lecture ne fait que mémoriser les compteurs.
   */
  protected ordersWith(spec: unknown, world: () => SimWorld): boolean {
    if (!spec || typeof spec !== "object") return false;
    let any = false;
    for (const [id, raw] of Object.entries(spec as Record<string, unknown>)) {
      const slot = this.slots.get(id);
      if (!slot || !raw || typeof raw !== "object") continue;
      const o = raw as { n?: unknown; clear?: unknown; kill?: { n?: unknown; ids?: unknown } };
      const n = typeof o.n === "number" ? o.n : 0;
      const clear = typeof o.clear === "number" ? o.clear : 0;
      const kill = o.kill && typeof o.kill === "object" && typeof o.kill.n === "number" ? o.kill.n : 0;
      const prev = this.orderCounts.get(id);
      this.orderCounts.set(id, { n, clear, kill });
      if (!prev) continue;
      if (clear > prev.clear) {
        slot.sim.clear();
        any = true;
      }
      if (kill > prev.kill && Array.isArray(o.kill!.ids)) {
        slot.sim.kill(o.kill!.ids.filter((v): v is number => typeof v === "number"));
        any = true;
      }
      if (n > prev.n) {
        const order = readOrder(raw, this.unit);
        // plusieurs hausses d'un coup : autant de salves (16 au plus)
        const salvos = Math.min(16, n - prev.n);
        for (let k = 0; k < salvos; k++) slot.sim.emit(order.count ?? 1, world(), order);
        any = true;
      }
    }
    return any;
  }

  /** Avance toutes les simulations de `dt` secondes dans `w` ; vrai si une copie a bougé. */
  protected stepWith(dt: number, w: SimWorld): boolean {
    this.hits.length = 0;
    let changed = false;
    for (const sim of this.sims) {
      const before = sim.expired, out = sim.exited;
      if (sim.advance(dt, w, this.hits)) changed = true;
      if (sim.expired > before && sim.spec.events.includes("expire")) this.onExpire?.({ emitter: sim.spec.id, count: sim.expired - before });
      if (sim.exited > out && sim.spec.events.includes("exit")) this.onExit?.({ emitter: sim.spec.id, count: sim.exited - out });
    }
    if (this.hits.length) this.onHits?.(this.hits.slice());
    return changed;
  }

  /** État publié ; `poseOf` situe la cible des copies les plus proches (`publish`). */
  protected statsWith(poseOf: (name: string) => { x: number; z: number } | null): EmitStats {
    const out: EmitStats = {};
    for (const s of this.sims) {
      const e: EmitStats[string] = { alive: s.n, emitted: s.emitted, dropped: s.dropped, expired: s.expired, ms: Math.round(s.ms * 100) / 100 };
      if (s.exited) e.exited = s.exited;
      if (s.spec.publish > 0) {
        const target = s.spec.flock?.seek || s.spec.flock?.flee || s.spec.from;
        const p = target ? poseOf(target) : null;
        if (p) e.near = s.near(p.x, p.z, s.spec.publish);
      }
      out[s.spec.id] = e;
    }
    return out;
  }

  dispose() {
    this.slots.clear();
    this.sims = [];
    this.orderCounts.clear();
  }
}
