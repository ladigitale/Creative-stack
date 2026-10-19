/** Convertisseurs d'attributs HTML tolérants (les agents écrivent `"true"`, `"false"`, du JSON en chaîne). */

/** Booléen : absent = faux ; `"false"` et `"0"` = faux ; toute autre valeur (y compris vide) = vrai. */
export const boolConverter = {
  fromAttribute(value: string | null): boolean {
    if (value === null) return false;
    const v = value.trim().toLowerCase();
    return v !== "false" && v !== "0";
  },
  toAttribute(value: boolean): string | null {
    return value ? "" : null;
  },
};

/** Objet JSON : chaîne invalide → `null` (pas d'exception au rendu). */
export const jsonConverter = {
  fromAttribute(value: string | null): unknown {
    if (value === null || value.trim() === "") return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  },
  toAttribute(value: unknown): string | null {
    return value == null ? null : JSON.stringify(value);
  },
};

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
