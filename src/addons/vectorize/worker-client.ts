import { trace, type RGBA, type TraceOptions, type TraceResult } from "./trace";
import { VECTORIZE_WORKER_SOURCE } from "./worker-source";

/**
 * Exécute le tracé dans un Web Worker (script en blob:, compatible CSP des artefacts) pour ne pas
 * figer la page. Une demande arrivée pendant un calcul l'interrompt (le worker est recréé) : seul le
 * dernier réglage compte. Sans Worker disponible (tests, vieux navigateurs), repli sur le fil principal.
 */
export class TraceRunner {
  private worker: Worker | null = null;
  private url: string | null = null;
  private busy: { id: number; reject: (e: Error) => void } | null = null;
  private seq = 0;
  /** Dernier moteur utilisé. */
  engine: "worker" | "main" = "main";

  constructor(private useWorker = true) {}

  static supported(): boolean {
    return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function";
  }

  run(img: RGBA, opts: TraceOptions): Promise<TraceResult> {
    if (!this.useWorker || !TraceRunner.supported()) return this.main(img, opts);
    if (this.busy) {
      this.busy.reject(new SupersededError());
      this.busy = null;
      this.stop();
    }
    let w: Worker;
    try {
      w = this.ensure();
    } catch {
      this.useWorker = false;
      return this.main(img, opts);
    }
    const id = ++this.seq;
    const copy = new Uint8ClampedArray(img.data);
    return new Promise<TraceResult>((resolve, reject) => {
      this.busy = { id, reject };
      w.onmessage = (e: MessageEvent<{ id: number; result?: TraceResult; error?: string }>) => {
        if (e.data.id !== id) return;
        this.busy = null;
        this.engine = "worker";
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.result!);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        this.busy = null;
        this.stop();
        // Worker refusé (CSP…) ou planté : on bascule définitivement sur le fil principal.
        this.useWorker = false;
        this.main(img, opts).then(resolve, reject);
      };
      w.postMessage({ id, width: img.width, height: img.height, data: copy.buffer, opts }, [copy.buffer]);
    });
  }

  dispose(): void {
    this.busy?.reject(new SupersededError());
    this.busy = null;
    this.stop();
  }

  private main(img: RGBA, opts: TraceOptions): Promise<TraceResult> {
    this.engine = "main";
    try {
      return Promise.resolve(trace(img, opts));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    this.url = URL.createObjectURL(new Blob([VECTORIZE_WORKER_SOURCE], { type: "text/javascript" }));
    this.worker = new Worker(this.url, { name: "sonic-vectorize" });
    return this.worker;
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

/** Calcul abandonné au profit d'un plus récent. */
export class SupersededError extends Error {
  constructor() {
    super("remplacé par un calcul plus récent");
    this.name = "SupersededError";
  }
}
