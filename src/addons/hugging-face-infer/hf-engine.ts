/**
 * Moteur d'inférence vu du thread principal.
 *
 * `HfEngine` est l'interface ; `HfWorkerEngine` la réalise avec un Web Worker
 * (le seul endroit où Transformers.js est chargé). Les tests, ou une
 * application qui veut son propre transport, peuvent fournir un autre moteur.
 */
import type {
  HfErrorCode,
  HfInspectResult,
  HfLoadResult,
  HfModelRef,
  HfProgress,
  HfRunRequest,
  HfWorkerEnv,
  HfWorkerRequest,
  HfWorkerResponse,
} from "./hf-protocol";
import type { HfDevice } from "./types";
import { buildHfWorkerSource } from "./hf-worker-runtime";

export interface HfEngine {
  configure(env: HfWorkerEnv): Promise<void>;
  inspect(model: HfModelRef): Promise<HfInspectResult>;
  load(
    model: HfModelRef,
    devices: HfDevice[],
    onProgress: (progress: HfProgress) => void,
  ): Promise<HfLoadResult>;
  run(request: HfRunRequest): Promise<unknown[]>;
  clear(model?: HfModelRef): Promise<void>;
  dispose(): void;
}

export class HfEngineError extends Error {
  constructor(
    public readonly code: HfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HfEngineError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type WorkerRequestBody = HfWorkerRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;

export class HfWorkerEngine implements HfEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly progressListeners = new Map<
    string,
    (progress: HfProgress) => void
  >();
  private fatal: HfEngineError | null = null;

  constructor(private readonly createWorker: () => Worker) {}

  /** Worker « blob » qui importe Transformers.js depuis une URL figée. */
  static fromUrl(libraryUrl: string): HfWorkerEngine {
    let blobUrl: string | null = null;
    const engine = new HfWorkerEngine(() => {
      const source = buildHfWorkerSource(libraryUrl);
      blobUrl = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
      return new Worker(blobUrl, { type: "module", name: "concorde-hf" });
    });
    const dispose = engine.dispose.bind(engine);
    engine.dispose = () => {
      dispose();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    return engine;
  }

  private ensureWorker(): Worker {
    if (this.fatal) throw this.fatal;
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.addEventListener("message", (event: MessageEvent) =>
      this.onMessage(event.data as HfWorkerResponse),
    );
    worker.addEventListener("error", (event: ErrorEvent) => {
      this.failAll(
        new HfEngineError(
          "runtime",
          `Worker Hugging Face : ${event.message || "erreur de chargement (CSP worker-src / script-src ?)"}`,
        ),
      );
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(msg: HfWorkerResponse): void {
    if ("type" in msg) {
      if (msg.type === "progress") {
        this.progressListeners.get(msg.alias)?.(msg.progress);
      } else if (msg.type === "fatal") {
        this.failAll(new HfEngineError("runtime", msg.message));
      }
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new HfEngineError(msg.error.code, msg.error.message));
  }

  private failAll(error: HfEngineError): void {
    this.fatal = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request<R>(body: WorkerRequestBody): Promise<R> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      return Promise.reject(err);
    }
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      worker.postMessage({ ...body, id });
    });
  }

  async configure(env: HfWorkerEnv): Promise<void> {
    await this.request({ type: "configure", env });
  }

  inspect(model: HfModelRef): Promise<HfInspectResult> {
    return this.request({ type: "inspect", model });
  }

  async load(
    model: HfModelRef,
    devices: HfDevice[],
    onProgress: (progress: HfProgress) => void,
  ): Promise<HfLoadResult> {
    this.progressListeners.set(model.alias, onProgress);
    try {
      return await this.request({ type: "load", model, devices });
    } finally {
      this.progressListeners.delete(model.alias);
    }
  }

  run(request: HfRunRequest): Promise<unknown[]> {
    return this.request({ type: "run", request });
  }

  async clear(model?: HfModelRef): Promise<void> {
    await this.request({ type: "clear", model });
  }

  dispose(): void {
    this.failAll(new HfEngineError("runtime", "Moteur arrêté."));
    this.worker?.terminate();
    this.worker = null;
  }
}
