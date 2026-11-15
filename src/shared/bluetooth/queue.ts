/**
 * File d'opérations sérialisées : une seule opération GATT à la fois (Chrome refuse les opérations
 * concurrentes), découpe en morceaux, délai entre morceaux, abandon à la déconnexion.
 */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function chunks(data: Uint8Array, size: number): Uint8Array[] {
  const n = Math.max(1, Math.floor(size));
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += n) out.push(data.subarray(i, Math.min(data.length, i + n)));
  return out;
}

export class OpQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  /** Opérations en attente ou en cours. */
  pending = 0;

  /** Enchaîne une opération. Résout `null` si la file a été vidée entre-temps ou si l'opération échoue. */
  run<T>(op: () => Promise<T>): Promise<T | null> {
    const mine = this.epoch;
    this.pending++;
    const next = this.tail.then(async () => {
      try {
        return mine === this.epoch ? await op() : null;
      } catch {
        return null;
      } finally {
        this.pending--;
      }
    });
    this.tail = next;
    return next;
  }

  /** Vrai tant que la file n'a pas été vidée depuis `token()`. */
  alive(token: number): boolean {
    return token === this.epoch;
  }

  token(): number {
    return this.epoch;
  }

  /** Abandonne tout ce qui n'a pas commencé (déconnexion). */
  clear(): void {
    this.epoch++;
  }
}
