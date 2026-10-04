/**
 * Registre des modèles (thread principal, un seul par page).
 *
 * - un seul chargement par alias, partagé par toutes les instances ;
 * - taille et présence en cache connues AVANT téléchargement ;
 * - consentement (mémorisé par alias + révision, révocable) ;
 * - garde-fous : économie de données, réseau lent, gros modèle, quota ;
 * - choix WebGPU / WASM selon le plafond `allowWasmUpToMB`.
 */
import {
  getHuggingFaceConfig,
  onHuggingFaceConfig,
  type HfLoadPolicy,
  type HfResolvedConfig,
} from "./hf-config";
import { HfEngineError, HfWorkerEngine, type HfEngine } from "./hf-engine";
import type {
  HfErrorCode,
  HfModelRef,
  HfProgress,
  HfRunRequest,
} from "./hf-protocol";
import type { HfDevice } from "./types";

export type HfModelPhase =
  | "idle"
  | "checking"
  | "awaiting-consent"
  | "declined"
  | "downloading"
  | "loading"
  | "ready"
  | "error"
  | "unsupported";

export type HfModelState = {
  phase: HfModelPhase;
  /** Connue avant téléchargement (serveur, sinon `sizeBytes` déclarée). */
  size: { totalBytes: number | null; fromCache: boolean } | null;
  progress?: HfProgress;
  backend?: HfDevice;
  persisted?: boolean;
  loadMs?: number;
  error?: { code: HfErrorCode; message: string };
};

type Entry = {
  state: HfModelState;
  listeners: Set<(state: HfModelState) => void>;
  inspect?: Promise<HfModelState["size"]>;
  loading?: Promise<void>;
  consent?: { promise: Promise<boolean>; resolve: (accepted: boolean) => void };
};

const CONSENT_PREFIX = "concorde-hf-consent:";
const MB = 1024 * 1024;

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

type NetworkInformationLike = { saveData?: boolean; effectiveType?: string };

function constrainedNetwork(): boolean {
  const connection = (
    globalThis.navigator as Navigator & { connection?: NetworkInformationLike }
  )?.connection;
  if (!connection) return false;
  return (
    connection.saveData === true ||
    connection.effectiveType === "slow-2g" ||
    connection.effectiveType === "2g"
  );
}

export class HfError extends Error {
  constructor(
    public readonly code: HfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HfError";
  }
}

export class HuggingFaceRegistry {
  private readonly entries = new Map<string, Entry>();
  private engine: HfEngine | null = null;
  private configured: Promise<void> | null = null;

  constructor(private config: HfResolvedConfig) {}

  /* ---------------- configuration / moteur ---------------- */

  get resolvedConfig(): HfResolvedConfig {
    return this.config;
  }

  private getEngine(): HfEngine {
    if (this.engine) return this.engine;
    const runtime = this.config.runtime;
    if (runtime.source === "engine") this.engine = runtime.engine;
    else if (runtime.source === "worker")
      this.engine = new HfWorkerEngine(runtime.createWorker);
    else this.engine = HfWorkerEngine.fromUrl(runtime.url);
    return this.engine;
  }

  private async ready(): Promise<HfEngine> {
    const engine = this.getEngine();
    if (!this.configured) {
      const runtime = this.config.runtime;
      const wasmPaths =
        runtime.source === "engine"
          ? undefined
          : (runtime.wasmPaths ??
            (runtime.source === "cdn"
              ? new URL(".", runtime.url).href
              : undefined));
      this.configured = engine.configure({
        cacheKey: `concorde-hf-${runtime.version}`,
        remoteHost: this.config.remoteHost,
        remotePathTemplate: this.config.remotePathTemplate,
        wasmPaths,
        logLevel: this.config.logLevel,
      });
    }
    await this.configured;
    return engine;
  }

  dispose(): void {
    this.engine?.dispose();
    this.engine = null;
    this.configured = null;
    this.entries.clear();
  }

  /* ---------------- modèles ---------------- */

  hasModel(alias: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.config.models, alias);
  }

  model(alias: string): HfModelRef & {
    devices: readonly HfDevice[];
    sizeBytes?: number;
    label?: string;
    description?: string;
    defaults?: Record<string, unknown>;
  } {
    if (!this.hasModel(alias)) {
      const known = Object.keys(this.config.models);
      throw new HfError(
        "not-allowed",
        `[sonic-hugging-face-infer] modèle "${alias}" hors liste blanche` +
          (known.length ? ` (disponibles : ${known.join(", ")}).` : "."),
      );
    }
    const def = this.config.models[alias];
    return {
      alias,
      task: def.task,
      repo: def.repo,
      revision: def.revision,
      options: def.options ?? {},
      devices: def.devices ?? ["webgpu", "wasm"],
      sizeBytes: def.sizeBytes,
      label: def.label,
      description: def.description,
      defaults: def.defaults as Record<string, unknown> | undefined,
    };
  }

  private entry(alias: string): Entry {
    let entry = this.entries.get(alias);
    if (!entry) {
      entry = { state: { phase: "idle", size: null }, listeners: new Set() };
      this.entries.set(alias, entry);
    }
    return entry;
  }

  state(alias: string): HfModelState {
    return this.entry(alias).state;
  }

  subscribe(alias: string, listener: (state: HfModelState) => void): () => void {
    const entry = this.entry(alias);
    entry.listeners.add(listener);
    listener(entry.state);
    return () => entry.listeners.delete(listener);
  }

  private update(alias: string, patch: Partial<HfModelState>): void {
    const entry = this.entry(alias);
    entry.state = { ...entry.state, ...patch };
    for (const listener of entry.listeners) listener(entry.state);
  }

  /** Taille et présence en cache, sans rien télécharger d'autre que des en-têtes. */
  inspect(alias: string): Promise<HfModelState["size"]> {
    const entry = this.entry(alias);
    if (!entry.inspect) {
      const model = this.model(alias);
      entry.inspect = (async () => {
        this.update(alias, { phase: "checking" });
        let totalBytes: number | null = model.sizeBytes ?? null;
        let fromCache = false;
        try {
          const engine = await this.ready();
          const result = await engine.inspect(model);
          totalBytes = result.totalBytes ?? totalBytes;
          fromCache = result.cached;
        } catch {
          /* taille déclarée à défaut */
        }
        const size = { totalBytes, fromCache };
        this.update(alias, { size, phase: "idle" });
        return size;
      })();
    }
    return entry.inspect;
  }

  /* ---------------- consentement ---------------- */

  private consentKey(alias: string): string {
    return `${CONSENT_PREFIX}${alias}@${this.model(alias).revision}`;
  }

  storedConsent(alias: string): "accepted" | "declined" | null {
    const value = storage()?.getItem(this.consentKey(alias));
    return value === "accepted" || value === "declined" ? value : null;
  }

  accept(alias: string): void {
    try {
      storage()?.setItem(this.consentKey(alias), "accepted");
    } catch {
      /* stockage indisponible : consentement pour la session seulement */
    }
    const entry = this.entry(alias);
    entry.consent?.resolve(true);
    entry.consent = undefined;
    if (entry.state.phase === "declined") this.update(alias, { phase: "idle" });
  }

  decline(alias: string): void {
    try {
      storage()?.setItem(this.consentKey(alias), "declined");
    } catch {
      /* idem */
    }
    const entry = this.entry(alias);
    entry.consent?.resolve(false);
    entry.consent = undefined;
    this.update(alias, { phase: "declined" });
  }

  revokeConsent(alias: string): void {
    try {
      storage()?.removeItem(this.consentKey(alias));
    } catch {
      /* idem */
    }
    if (this.entry(alias).state.phase === "declined")
      this.update(alias, { phase: "idle" });
  }

  private askConsent(alias: string): Promise<boolean> {
    const stored = this.storedConsent(alias);
    if (stored) return Promise.resolve(stored === "accepted");
    const entry = this.entry(alias);
    if (!entry.consent) {
      let resolve!: (accepted: boolean) => void;
      const promise = new Promise<boolean>((r) => (resolve = r));
      entry.consent = { promise, resolve };
    }
    this.update(alias, { phase: "awaiting-consent" });
    return entry.consent.promise;
  }

  /* ---------------- chargement ---------------- */

  /**
   * Charge le modèle selon la politique. Résout quand il est prêt ; rejette
   * (`HfError`) si refusé, non supporté, quota insuffisant ou erreur.
   * `policy = "manual"` signifie « appel explicite » : pas de demande de consentement.
   */
  ensureLoaded(alias: string, policy: HfLoadPolicy): Promise<void> {
    const entry = this.entry(alias);
    if (entry.state.phase === "ready") return Promise.resolve();
    if (entry.loading) return entry.loading;
    const loading = this.load(alias, policy).finally(() => {
      if (this.entry(alias).loading === loading) entry.loading = undefined;
    });
    entry.loading = loading;
    return loading;
  }

  private async load(alias: string, policy: HfLoadPolicy): Promise<void> {
    const model = this.model(alias);
    const defaults = this.config.defaults;
    const size = await this.inspect(alias);
    const cached = size?.fromCache === true;
    const totalBytes = size?.totalBytes ?? null;

    if (!cached && policy !== "manual") {
      const stored = this.storedConsent(alias);
      // Refus mémorisé, ou refus de la session si le stockage est indisponible.
      if (stored === "declined" || this.entry(alias).state.phase === "declined") {
        this.update(alias, { phase: "declined" });
        throw new HfError("declined", "Chargement du modèle refusé par l'utilisateur.");
      }
      const tooBig = totalBytes !== null && totalBytes > defaults.consentAboveMB * MB;
      const mustAsk = policy === "consent" || tooBig || constrainedNetwork();
      if (mustAsk && stored !== "accepted") {
        const accepted = await this.askConsent(alias);
        if (!accepted) {
          this.update(alias, { phase: "declined" });
          throw new HfError("declined", "Chargement du modèle refusé par l'utilisateur.");
        }
      }
    }

    const knownSize = totalBytes ?? model.sizeBytes ?? null;
    const devices = model.devices.filter(
      (d) =>
        d !== "wasm" ||
        knownSize === null ||
        knownSize <= defaults.allowWasmUpToMB * MB,
    );
    if (!devices.length) {
      this.update(alias, {
        phase: "unsupported",
        error: { code: "unsupported", message: "Aucune exécution autorisée pour ce modèle." },
      });
      throw new HfError("unsupported", "Aucune exécution autorisée pour ce modèle.");
    }

    if (!cached && totalBytes) {
      const estimate = await globalThis.navigator?.storage
        ?.estimate?.()
        .catch(() => null);
      if (estimate?.quota !== undefined) {
        const free = estimate.quota - (estimate.usage ?? 0);
        if (free < totalBytes * 1.2) {
          const message = `Espace de stockage insuffisant (${Math.round(free / MB)} Mo libres, ${Math.round(totalBytes / MB)} Mo nécessaires).`;
          this.update(alias, { phase: "error", error: { code: "quota", message } });
          throw new HfError("quota", message);
        }
      }
    }

    this.update(alias, {
      phase: cached ? "loading" : "downloading",
      error: undefined,
      progress: undefined,
    });
    try {
      const engine = await this.ready();
      const result = await engine.load(model, devices, (progress) =>
        this.update(alias, { phase: "downloading", progress }),
      );
      let persisted: boolean | undefined;
      if (defaults.persist && !cached) {
        persisted = await globalThis.navigator?.storage
          ?.persist?.()
          .catch(() => false);
      }
      this.update(alias, {
        phase: "ready",
        backend: result.backend,
        loadMs: result.loadMs,
        persisted,
        size: { totalBytes: knownSize, fromCache: cached },
      });
    } catch (err) {
      const code: HfErrorCode =
        err instanceof HfEngineError ? err.code : "runtime";
      const message = err instanceof Error ? err.message : String(err);
      this.update(alias, {
        phase: code === "unsupported" ? "unsupported" : "error",
        error: { code, message },
      });
      throw new HfError(code, message);
    }
  }

  /* ---------------- calcul ---------------- */

  async run(request: HfRunRequest, timeoutMs: number): Promise<unknown[]> {
    const engine = await this.ready();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new HfError("timeout", `Calcul trop long (> ${timeoutMs} ms), abandonné.`),
          ),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([engine.run(request), timeout]);
    } catch (err) {
      if (err instanceof HfError) throw err;
      if (err instanceof HfEngineError) throw new HfError(err.code, err.message);
      throw new HfError("runtime", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- nettoyage ---------------- */

  async clearModel(alias: string): Promise<void> {
    const model = this.model(alias);
    const engine = await this.ready();
    await engine.clear(model);
    const entry = this.entry(alias);
    entry.inspect = undefined;
    this.update(alias, { phase: "idle", size: null, backend: undefined, progress: undefined });
  }

  async clearAll(): Promise<void> {
    const engine = await this.ready();
    await engine.clear();
    for (const alias of this.entries.keys()) {
      this.entry(alias).inspect = undefined;
      this.update(alias, { phase: "idle", size: null, backend: undefined, progress: undefined });
    }
  }
}

/* ---------------- singleton ---------------- */

let registry: HuggingFaceRegistry | null = null;

onHuggingFaceConfig((config) => {
  registry?.dispose();
  registry = new HuggingFaceRegistry(config);
});

/** Registre de la page (null tant que `configureHuggingFace` n'a pas été appelé). */
export function getHuggingFaceRegistry(): HuggingFaceRegistry | null {
  if (!registry) {
    const config = getHuggingFaceConfig();
    if (config) registry = new HuggingFaceRegistry(config);
  }
  return registry;
}
