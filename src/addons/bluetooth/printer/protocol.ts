import type { SonicBytePipe } from "../../../shared/pipe/pipe";
import { concatBytes } from "../../../shared/pipe/bytes";
import { sleep } from "../../../shared/pipe/queue";

export type PaperType = "gap" | "black-mark" | "continuous";

export type PrinterStatus = {
  printing: boolean;
  cover: "closed" | "open" | "unknown";
  paper: "ok" | "out" | "unknown";
  overheated: boolean;
  lowBattery: boolean;
  charging: boolean;
};

export type PrinterInfo = { model: string | null; firmware: string | null; battery: number | null; status: PrinterStatus | null };

export type PrintJob = {
  /** Lignes emballées, `bytesPerRow` octets par ligne, 1 = noir. */
  data: Uint8Array;
  bytesPerRow: number;
  rows: number;
  density: number;
  paper: PaperType;
};

export const UNKNOWN_STATUS: PrinterStatus = { printing: false, cover: "unknown", paper: "unknown", overheated: false, lowBattery: false, charging: false };

/**
 * Dialogue avec l'appareil : envoi, et envoi suivi d'une attente de réponse. Les notifications BLE arrivent
 * en fragments : on accumule, puis on laisse un court délai de grâce après le premier fragment.
 */
export class PrinterLink {
  private buffer: Uint8Array = new Uint8Array(0);
  private waiter: (() => void) | null = null;
  private off: () => void;

  constructor(
    readonly pipe: SonicBytePipe,
    /** Facteur appliqué à tous les délais (0 dans les tests). */
    readonly timeScale = 1,
  ) {
    this.off = pipe.onBytes((data) => {
      this.buffer = concatBytes(this.buffer, data);
      const w = this.waiter;
      this.waiter = null;
      w?.();
    });
  }

  close(): void {
    this.off();
    this.waiter?.();
    this.waiter = null;
  }

  wait(ms: number): Promise<void> {
    return this.timeScale > 0 && ms > 0 ? sleep(ms * this.timeScale) : Promise.resolve();
  }

  send(data: ArrayLike<number>, opts?: { chunkSize?: number; gapMs?: number }): Promise<boolean> {
    return this.pipe.writeBytes(Uint8Array.from(data), opts);
  }

  /** Envoie puis attend une réponse (vide si rien n'arrive avant `timeoutMs`). `null` si l'envoi échoue. */
  async request(data: ArrayLike<number>, timeoutMs = 2000, until?: (buffer: Uint8Array) => boolean): Promise<Uint8Array | null> {
    this.buffer = new Uint8Array(0);
    if (!(await this.send(data))) return null;
    const deadline = Date.now() + timeoutMs * Math.max(this.timeScale, 0.01);
    for (;;) {
      if (this.buffer.length && (!until || until(this.buffer))) break;
      const left = deadline - Date.now();
      if (left <= 0 || !this.pipe.pipeReady) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.waiter === done) this.waiter = null;
          resolve();
        }, left);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        this.waiter = done;
      });
    }
    // Fragments de fin de réponse.
    if (!until) await this.wait(50);
    return this.buffer;
  }
}

export type PrinterProtocol = {
  readonly id: string;
  /** Lit modèle, micrologiciel, batterie, état. Ne lève pas : champs `null` si l'appareil ne répond pas. */
  info(link: PrinterLink): Promise<PrinterInfo>;
  /** Imprime une copie. Retourne `null` si tout va bien, sinon un message lisible. */
  print(link: PrinterLink, job: PrintJob, onProgress: (p: number) => void): Promise<string | null>;
  /** Avance le papier jusqu'à l'étiquette suivante. */
  feed(link: PrinterLink): Promise<boolean>;
};
