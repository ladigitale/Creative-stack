/**
 * État standard de `sonic-3d` (`status` / `error`, cf. PLAN.md « Principes » 6).
 *
 * Publié tout de suite à chaque transition (chargement, prêt, échec) dans le
 * `out-data-provider`, même sans boucle de rendu : un échec de chargement laisse
 * la scène non prête, la télémétrie périodique ne tourne donc pas.
 */

export type Sonic3dStatus = "idle" | "loading" | "ready" | "error";

type Leaf = { set: (v: unknown) => void };

export type StatusHost = {
  status: Sonic3dStatus;
  errorMessage: string;
  outPublisher: unknown;
  bindOutPublisher: () => void;
  /** Vrai pendant notre propre écriture : le DP partagé ne relance pas le form. */
  writingStatus?: boolean;
  /** Dernier couple publié (évite de réécrire la même valeur). */
  lastStatusSig?: string;
};

function errorOf(host: StatusHost): string | null {
  return host.status === "error" ? host.errorMessage || "Erreur inconnue." : null;
}

function set(host: StatusHost, status: Sonic3dStatus) {
  host.status = status;
  const error = errorOf(host);
  if (!host.outPublisher) host.bindOutPublisher();
  const pub = host.outPublisher as Record<string, Leaf> | null;
  if (!pub) return;
  const sig = `${status}\n${error ?? ""}`;
  if (sig === host.lastStatusSig) return;
  host.lastStatusSig = sig;
  host.writingStatus = true;
  try {
    pub.status?.set(status);
    pub.error?.set(error);
  } catch {
    /* leaf manquant */
  } finally {
    host.writingStatus = false;
  }
}

export const status = { set, errorOf } as const;
