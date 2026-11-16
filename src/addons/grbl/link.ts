import { LineSplitter } from "../../shared/pipe/lines";
import type { SonicBytePipe } from "../../shared/pipe/pipe";
import { parseGrblLine, RX_BUFFER, type GrblMessage } from "./codec";

export type Ack = { ok: true } | { ok: false; code?: number; message: string; aborted?: boolean };

export type JobEnd = { line: number; message: string } | null;

type Inflight = { size: number; job: boolean; resolve?: (a: Ack) => void; timer?: ReturnType<typeof setTimeout> };
type Waiting = { text: string; resolve: (a: Ack) => void; timeoutMs: number };
type Job = { lines: string[]; next: number; acked: number; stopped: boolean; failed: JobEnd; onProgress: (acked: number, sent: number) => void; onEnd: (end: JobEnd) => void };

/**
 * Dialogue avec une machine GRBL au-dessus d'un canal d'octets : commandes ponctuelles avec accusé de
 * réception, et envoi d'un programme en flux. GRBL répond `ok` ou `error:n` à chaque ligne, dans l'ordre ;
 * on n'envoie une ligne que si elle tient dans son tampon de réception (comptage de caractères), ce qui
 * garde le planificateur plein sans jamais déborder.
 */
export class GrblLink {
  private off: () => void;
  private splitter = new LineSplitter(256);
  private inflight: Inflight[] = [];
  private used = 0;
  private waiting: Waiting[] = [];
  private job: Job | null = null;
  private encoder = new TextEncoder();
  private closed = false;

  constructor(
    readonly pipe: SonicBytePipe,
    private onMessage: (message: GrblMessage, raw: string) => void,
    /** Facteur des délais (0 dans les tests : pas d'attente de réponse). */
    readonly timeScale = 1,
  ) {
    this.off = pipe.onBytes((data) => {
      for (const line of this.splitter.push(data)) this.receive(line);
    });
  }

  close(): void {
    this.closed = true;
    this.off();
    this.reset("liaison fermée");
  }

  get busy(): boolean {
    return !!this.job;
  }

  get jobProgress(): { lines: number; sent: number; acked: number } | null {
    return this.job ? { lines: this.job.lines.length, sent: this.job.next, acked: this.job.acked } : null;
  }

  /** Commande temps réel : un octet, exécuté tout de suite par GRBL, sans `ok`. */
  realtime(byte: number): void {
    void this.pipe.writeBytes(Uint8Array.of(byte));
  }

  /** Envoie une ligne et attend son accusé de réception. Ne lève jamais. */
  command(text: string, timeoutMs = 10_000): Promise<Ack> {
    if (this.closed || !this.pipe.pipeReady) return Promise.resolve({ ok: false, message: "machine non connectée", aborted: true });
    return new Promise<Ack>((resolve) => {
      this.waiting.push({ text, resolve, timeoutMs });
      this.pump();
    });
  }

  /** Lance l'envoi d'un programme. `onEnd(null)` quand la dernière ligne est acquittée, sinon la ligne en cause. */
  startJob(lines: string[], onProgress: Job["onProgress"], onEnd: Job["onEnd"]): boolean {
    if (this.job || this.closed) return false;
    this.job = { lines, next: 0, acked: 0, stopped: false, failed: null, onProgress, onEnd };
    this.pump();
    return true;
  }

  /** N'envoie plus de nouvelles lignes du programme (les lignes déjà parties seront exécutées). */
  stopFeeding(): void {
    const job = this.job;
    if (!job) return;
    job.stopped = true;
    if (!this.inflight.some((e) => e.job)) {
      this.job = null;
      job.onEnd(job.failed ?? { line: job.acked + 1, message: "tâche arrêtée" });
    }
  }

  /** Oublie tout ce qui était en cours : après une remise à zéro de la machine, son tampon est vide. */
  reset(reason: string): void {
    const aborted: Ack = { ok: false, message: reason, aborted: true };
    for (const entry of this.inflight) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve?.(aborted);
    }
    this.inflight = [];
    this.used = 0;
    const waiting = this.waiting;
    this.waiting = [];
    for (const w of waiting) w.resolve(aborted);
    const job = this.job;
    this.job = null;
    if (job) job.onEnd(job.failed ?? { line: job.acked + 1, message: reason });
  }

  private receive(raw: string): void {
    const message = parseGrblLine(raw);
    if (message.type === "welcome") this.reset("machine réinitialisée");
    else if (message.type === "ok" || message.type === "error") this.acknowledge(message);
    this.onMessage(message, raw);
  }

  private acknowledge(message: { type: "ok" } | { type: "error"; code: number; message: string }): void {
    const entry = this.inflight.shift();
    if (!entry) return;
    this.used = Math.max(0, this.used - entry.size);
    if (entry.timer) clearTimeout(entry.timer);
    const ack: Ack = message.type === "ok" ? { ok: true } : { ok: false, code: message.code, message: message.message };
    if (entry.job && this.job) {
      const job = this.job;
      job.acked++;
      if (!ack.ok && !job.failed) {
        job.failed = { line: job.acked, message: ack.message };
        job.stopped = true;
      }
      job.onProgress(job.acked, job.next);
      const drained = !this.inflight.some((e) => e.job);
      if (drained && (job.failed || job.stopped || job.acked >= job.lines.length)) {
        this.job = null;
        job.onEnd(job.failed ?? (job.acked >= job.lines.length ? null : { line: job.acked + 1, message: "tâche arrêtée" }));
      }
    } else entry.resolve?.(ack);
    this.pump();
  }

  private pump(): void {
    for (;;) {
      const command = this.waiting[0];
      const job = !command && this.job && !this.job.stopped && this.job.next < this.job.lines.length ? this.job : null;
      const text = command ? command.text : job ? job.lines[job.next] : null;
      if (text === null) return;
      const size = text.length + 1;
      // Une ligne plus longue que le tampon part quand même s'il est vide.
      if (this.used + size > RX_BUFFER && this.inflight.length) return;
      const entry: Inflight = { size, job: !command };
      if (command) {
        this.waiting.shift();
        entry.resolve = command.resolve;
        if (this.timeScale > 0 && command.timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            const at = this.inflight.indexOf(entry);
            if (at < 0) return;
            this.inflight.splice(at, 1);
            this.used = Math.max(0, this.used - entry.size);
            entry.resolve?.({ ok: false, message: "pas de réponse de la machine" });
            this.pump();
          }, command.timeoutMs * this.timeScale);
        }
      } else if (job) job.next++;
      this.inflight.push(entry);
      this.used += size;
      void this.pipe.writeBytes(this.encoder.encode(text + "\n")).then((ok) => {
        if (!ok && !this.closed && this.inflight.includes(entry)) this.reset("transport déconnecté");
      });
    }
  }
}
