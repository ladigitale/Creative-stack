import { AnchorEngine, type EngineOptions, type EngineResult } from "./core/engine";
import type { Gray } from "./core/image";
import { ANCHOR_WORKER_SOURCE } from "./worker-source";

/**
 * Exécute le moteur d'ancrage dans un Web Worker (script en blob:, compatible CSP des artefacts) : l'analyse ne
 * fige plus l'affichage. Une seule image à la fois : tant qu'un calcul tourne, `busy` est vrai et l'appelant saute
 * les images suivantes. Sans Worker (tests, refus CSP, plantage), repli définitif sur le fil principal.
 */
export class EngineRunner {
  private worker: Worker | null = null;
  private url: string | null = null;
  private main = new AnchorEngine();
  private seq = 0;
  private pending: { id: number; resolve: (r: EngineResult) => void; reject: (e: Error) => void } | null = null;
  private refs: unknown[] = [];
  /** Moteur réellement utilisé. */
  engine: "worker" | "main" = "main";

  constructor(private useWorker = true) {}

  get busy(): boolean {
    return this.pending !== null;
  }

  static supported(): boolean {
    return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function";
  }

  setReferences(list: unknown[]): number {
    this.refs = list;
    const n = this.main.setReferences(list);
    if (this.worker) this.worker.postMessage({ type: "refs", list });
    return n;
  }

  reset(): void {
    this.main.reset();
    this.worker?.postMessage({ type: "reset" });
  }

  process(gray: Gray, opts: Partial<EngineOptions>): Promise<EngineResult> {
    if (this.useWorker && EngineRunner.supported()) {
      try {
        const w = this.ensure();
        const id = ++this.seq;
        const copy = gray.data.slice();
        return new Promise<EngineResult>((resolve, reject) => {
          this.pending = { id, resolve, reject };
          w.postMessage({ type: "frame", id, width: gray.width, height: gray.height, data: copy.buffer, opts }, [copy.buffer]);
        });
      } catch {
        this.fallback();
      }
    }
    this.engine = "main";
    try {
      return Promise.resolve(this.main.process(gray, opts));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  dispose(): void {
    this.pending?.reject(new Error("arrêté"));
    this.pending = null;
    this.stop();
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    this.url = URL.createObjectURL(new Blob([ANCHOR_WORKER_SOURCE], { type: "text/javascript" }));
    const w = new Worker(this.url, { name: "sonic-anchor" });
    w.onmessage = (e: MessageEvent<{ type: string; id?: number; result?: EngineResult; error?: string }>) => {
      const m = e.data;
      if (m.type !== "frame" || !this.pending || m.id !== this.pending.id) return;
      const p = this.pending;
      this.pending = null;
      this.engine = "worker";
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result!);
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      const p = this.pending;
      this.pending = null;
      this.fallback();
      p?.reject(new Error("worker indisponible, analyse sur le fil principal"));
    };
    w.postMessage({ type: "refs", list: this.refs });
    this.worker = w;
    return w;
  }

  private fallback(): void {
    this.useWorker = false;
    this.stop();
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
