/**
 * Déclencheurs par compteur (convention creative-stack) : dans un DataProvider de
 * pilotage, `{ "snapshot": 3 }` puis `{ "snapshot": 4 }` déclenche l'action une fois.
 * La première valeur vue sert de référence (rien au chargement) ; une baisse
 * redéfinit la référence. Forme objet acceptée : `{ "n": 4, ... }`.
 */
export class CounterTrigger {
  private last: number | undefined;

  /** Retourne vrai si la valeur déclenche. */
  feed(value: unknown): boolean {
    const n = typeof value === "number" ? value : Number((value as { n?: unknown } | null)?.n);
    if (!Number.isFinite(n)) return false;
    const prev = this.last;
    this.last = n;
    return prev !== undefined && n > prev;
  }

  reset(): void {
    this.last = undefined;
  }
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function num(v: unknown, min: number, max: number): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}
