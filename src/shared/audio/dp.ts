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

/** Écoute un DataProvider (chemin pointé accepté). Retourne la désinscription. */
export function listenDp(path: string, handler: (value: unknown) => void): () => void {
  const provider = dp(path);
  const wrapped = (v: unknown) => handler(plain(v));
  provider.onAssign(wrapped);
  return () => provider.offAssign(wrapped);
}
