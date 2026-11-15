import type { PipeWriteOptions, SonicBytePipe } from "./pipe";

/**
 * Canal d'octets en mémoire, pour les tests et les démos sans matériel : garde tout ce qui est écrit,
 * répond par un script (`respond`), simule une déconnexion (`pipeReady = false`).
 */
export class FakePipe implements SonicBytePipe {
  pipeReady = true;
  deviceName: string;
  /** Écritures reçues, une entrée par appel de `writeBytes`. */
  readonly writes: Uint8Array[] = [];
  readonly options: (PipeWriteOptions | undefined)[] = [];
  private listeners = new Set<(data: Uint8Array, channel: string) => void>();

  constructor(
    deviceName = "FAKE",
    /** Réponse de l'appareil à une écriture (`null` : silence). */
    public respond: (data: Uint8Array) => ArrayLike<number> | null = () => null,
  ) {
    this.deviceName = deviceName;
  }

  async writeBytes(data: Uint8Array, opts?: PipeWriteOptions): Promise<boolean> {
    if (!this.pipeReady) return false;
    this.writes.push(Uint8Array.from(data));
    this.options.push(opts);
    const answer = this.respond(data);
    if (answer) queueMicrotask(() => this.emit(Uint8Array.from(answer)));
    return true;
  }

  onBytes(cb: (data: Uint8Array, channel: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Simule une notification de l'appareil. */
  emit(data: Uint8Array, channel = "rx"): void {
    for (const cb of this.listeners) cb(data, channel);
  }
}
