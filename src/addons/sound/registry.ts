import type { SoundEngine } from "./engine";

const engines = new Map<string, SoundEngine>();

export function registerEngine(engine: SoundEngine): void {
  engines.set(engine.id, engine);
}

export function unregisterEngine(engine: SoundEngine): void {
  if (engines.get(engine.id) === engine) engines.delete(engine.id);
}

/** Moteur par id ; sans id, le premier moteur déclaré. */
export function getSoundEngine(id?: string): SoundEngine | undefined {
  if (id) return engines.get(id);
  return engines.values().next().value;
}

/** Joue un son sur un moteur (défaut : le premier `sonic-sound` de la page). */
export function playSound(
  name: string,
  opts: { pitch?: number; vol?: number; engine?: string } = {},
): boolean {
  return getSoundEngine(opts.engine)?.play(name, opts) ?? false;
}
