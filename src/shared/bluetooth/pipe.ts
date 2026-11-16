/**
 * Canal d'octets bidirectionnel, quel que soit le transport (Bluetooth aujourd'hui, série demain).
 * Les pilotes (imprimantes, UART, capteurs) ne connaissent que ce contrat.
 */
export type PipeWriteOptions = {
  /** Alias du canal d'écriture (défaut `tx`). */
  channel?: string;
  /** Écriture avec accusé de réception (défaut : sans, si la caractéristique le permet). */
  response?: boolean;
  /** Taille des morceaux et délai entre deux morceaux, pour cet envoi. */
  chunkSize?: number;
  gapMs?: number;
};

export type SonicBytePipe = {
  readonly pipeReady: boolean;
  /** Nom annoncé de l'appareil (détection de modèle par les pilotes). */
  readonly deviceName: string;
  /** Profil de transport effectivement ouvert (`luck`, `niimbot`…), quand le transport en connaît plusieurs. */
  readonly pipeProfile?: string;
  /** Écrit en file, par morceaux. Ne lève jamais : `false` si déconnecté, refusé ou interrompu. */
  writeBytes(data: Uint8Array, opts?: PipeWriteOptions): Promise<boolean>;
  /** Notifications reçues ; retourne la désinscription. */
  onBytes(cb: (data: Uint8Array, channel: string) => void): () => void;
};

export function isBytePipe(el: unknown): el is SonicBytePipe {
  if (!el || typeof el !== "object") return false;
  const o = el as SonicBytePipe;
  return typeof o.writeBytes === "function" && typeof o.onBytes === "function" && typeof o.pipeReady === "boolean";
}
