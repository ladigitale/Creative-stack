import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";

/** Copie JSON simple (les valeurs de DataProvider peuvent être des proxys). */
export function plain<T = unknown>(value: unknown): T {
  if (value === null || typeof value !== "object") return value as T;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value as T;
  }
}

type Listenable = {
  onAssign(h: (v: unknown) => void): void;
  offAssign(h: (v: unknown) => void): void;
  onInternalMutation?(h: VoidFunction): void;
  offInternalMutation?(h: VoidFunction): void;
  get?(): unknown;
};

const key = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(Math.random());
  }
};

/**
 * Écoute un DataProvider (chemin pointé accepté). Retourne la désinscription.
 *
 * Reçoit aussi les écritures d'une sous-clé (un bouton radio Concorde `formDataProvider="choix" name="x"`
 * écrit `choix.x` : Concorde ne prévient alors le parent que par `onInternalMutation`, jamais par
 * `onAssign`). Une mutation interne qui ne change pas la valeur n'est pas relayée : un écouteur qui
 * réécrit une clé de ce qu'il écoute ne boucle pas.
 */
export function listenDp(path: string, handler: (value: unknown) => void): () => void {
  const provider = dp(path) as unknown as Listenable;
  let last: string | null = null;
  let inside = false;
  const assigned = (v: unknown) => {
    const value = plain(v);
    last = key(value);
    handler(value);
  };
  const mutated = () => {
    if (inside || typeof provider.get !== "function") return;
    const value = plain(provider.get());
    const k = key(value);
    if (k === last) return;
    last = k;
    inside = true;
    try {
      handler(value);
    } finally {
      inside = false;
    }
  };
  provider.onAssign(assigned);
  provider.onInternalMutation?.(mutated);
  return () => {
    provider.offAssign(assigned);
    provider.offInternalMutation?.(mutated);
  };
}
