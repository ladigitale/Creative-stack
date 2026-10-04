/**
 * Contrôleur d'une inférence : relie des DataProviders (entrée, sortie,
 * statut, déclencheur, consentement) au registre de modèles.
 *
 * Utilisé par l'élément `sonic-hugging-face-infer` et par l'API TypeScript
 * `createHuggingFace().infer()`. Aucune dépendance au moteur : tout passe par
 * le registre (qui délègue au worker).
 */
import {
  PublisherManager,
  type DataProvider,
} from "@supersoniks/concorde/core/utils/PublisherProxy";
import Objects from "@supersoniks/concorde/core/utils/Objects";
import {
  resolveStaticPublisherPath,
  type PublisherPathInput,
} from "@supersoniks/concorde/core/utils/dataProviderKey";
import {
  deriveStateKey,
  type DeriveState,
} from "@supersoniks/concorde/core/utils/derive";
import type { HfLoadPolicy, HfTrigger } from "./hf-config";
import { readResult, resultKey, writeResult } from "./hf-cache";
import {
  normalizeInput,
  realign,
  type HfNormalizedInput,
  type HfTextExtractor,
} from "./hf-input";
import type { HfErrorCode, HfProgress } from "./hf-protocol";
import {
  getHuggingFaceRegistry,
  HfError,
  type HfModelState,
  type HuggingFaceRegistry,
} from "./hf-registry";
import { validateCallOptions } from "./hf-schema";
import {
  attachMediaUrls,
  revokeMediaUrls,
} from "../../shared/mediaRef";
import {
  HF_POSITIONAL_ARGS,
  HF_TASK_INPUT_KIND,
  type HfDevice,
  type HfTask,
} from "./types";

const BYTES_PER_MIB = 1024 * 1024;
const IDLE_PRELOAD_TIMEOUT_MS = 5_000;
const VISIBLE_FALLBACK_DELAY_MS = 1_500;

/* ------------------------------------------------------------------ */
/* Statut publié                                                       */
/* ------------------------------------------------------------------ */

export type HfInferState =
  | "idle"
  | "empty"
  | "awaiting-consent"
  | "declined"
  | "downloading"
  | "loading"
  | "ready"
  | "running"
  | "done"
  | "invalid-input"
  | "error"
  | "unsupported";

export type HfInferStatus = {
  state: HfInferState;
  model: {
    alias: string;
    task: HfTask;
    repo: string;
    revision: string;
    label?: string;
    description?: string;
  };
  /** Connue AVANT le téléchargement ; `fromCache` = rien à télécharger. */
  size: {
    totalBytes: number | null;
    /** Arrondi, pour l'affichage (« 118 Mo »). */
    totalMB: number | null;
    fromCache: boolean;
  };
  progress?: HfProgress;
  backend?: HfDevice;
  persisted?: boolean;
  /** Éléments d'entrée ignorés (sortie alignée : `null` à leur place). */
  skipped?: number;
  warnings?: string[];
  timings?: { loadMs?: number; lastRunMs?: number };
  /** Vrai quand le résultat vient du cache (mémoire ou IndexedDB). */
  fromResultsCache?: boolean;
  error?: {
    code: HfErrorCode | "invalid-input" | "too-large";
    message: string;
  };
};

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export type HfInferControllerOptions = {
  model: string;
  input: PublisherPathInput;
  output: PublisherPathInput;
  status?: PublisherPathInput;
  /** Mode `demand` : chaque changement de valeur de ce DataProvider lance un calcul. */
  triggerProvider?: PublisherPathInput;
  /** Valeur vraie (`true`, `"accepted"`) = consentement donné ; `"declined"` = refus. */
  consentProvider?: PublisherPathInput;
  text?: HfTextExtractor;
  call?: Record<string, unknown>;
  /** Les options viennent d'un attribut / descripteur SDUI : validation stricte. */
  untrusted?: boolean;
  load?: HfLoadPolicy;
  trigger?: HfTrigger;
  debounceMs?: number;
  emptyValue?: unknown;
  onInvalid?: "keep" | "clear";
  maxItems?: number;
  maxChars?: number;
  timeoutMs?: number;
  persistResults?: boolean;
  resultsTtlMs?: number;
  /** Politique `visible` : résout quand l'élément est à l'écran. */
  whenVisible?: () => Promise<void>;
};

export type HfInferHandle = {
  /** Arrête les abonnements (le modèle reste chargé pour les autres instances). */
  stop(): void;
  /** Calcule maintenant sur l'entrée courante (mode `demand`). */
  run(): Promise<void>;
  /** Charge le modèle maintenant (politique `manual`, ou préchargement). */
  load(): Promise<void>;
  accept(): void;
  decline(): void;
};

type CtrlPhase =
  | "idle"
  | "empty"
  | "invalid-input"
  | "waiting-model"
  | "running"
  | "done"
  | "error";

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function resolvePublisher(path: string): DataProvider {
  const parts = path.split(".");
  const root = parts.shift()!;
  let pub: DataProvider = PublisherManager.get(root);
  if (parts.length) pub = Objects.traverse(pub, parts) as DataProvider;
  return pub;
}

function isAccepted(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "accepted" ||
    value === "true" ||
    value === "1" ||
    value === "on"
  );
}

const MODEL_WAIT_STATES: Partial<Record<HfModelState["phase"], HfInferState>> = {
  checking: "loading",
  "awaiting-consent": "awaiting-consent",
  declined: "declined",
  downloading: "downloading",
  loading: "loading",
  ready: "ready",
  error: "error",
  unsupported: "unsupported",
  idle: "idle",
};

function toDeriveState(state: HfInferState, output: unknown): DeriveState {
  switch (state) {
    case "downloading":
    case "loading":
    case "running":
      return { status: "loading", error: null };
    case "done":
      return {
        status:
          output === null ||
          output === undefined ||
          (Array.isArray(output) && output.length === 0)
            ? "empty"
            : "ready",
        error: null,
      };
    case "error":
    case "invalid-input":
      return { status: "error", error: null };
    default:
      return { status: "empty", error: null };
  }
}

/* ------------------------------------------------------------------ */
/* Contrôleur                                                          */
/* ------------------------------------------------------------------ */

export function createHfInferController(
  options: HfInferControllerOptions,
  registryOverride?: HuggingFaceRegistry,
): HfInferHandle {
  const registry = registryOverride ?? getHuggingFaceRegistry();
  if (!registry) {
    throw new HfError(
      "not-allowed",
      "[sonic-hugging-face-infer] configureHuggingFace() n'a pas été appelé.",
    );
  }
  const model = registry.model(options.model);
  const task = model.task;
  const defaults = registry.resolvedConfig.defaults;
  const policy = options.load ?? defaults.load;
  const trigger = options.trigger ?? defaults.trigger;
  const debounceMs = options.debounceMs ?? defaults.debounceMs;
  const emptyValue = options.emptyValue ?? null;
  const onInvalid = options.onInvalid ?? "keep";
  // Un descripteur SDUI peut abaisser les limites, jamais les relever.
  const limit = (value: number | undefined, max: number) =>
    value === undefined ? max : options.untrusted ? Math.min(value, max) : value;
  const maxItems = limit(options.maxItems, defaults.maxItems);
  const maxChars = limit(options.maxChars, defaults.maxChars);
  const timeoutMs = limit(options.timeoutMs, defaults.timeoutMs);
  const persistResults = options.persistResults ?? false;
  const runtimeVersion = registry.resolvedConfig.runtime.version;

  const inputPath = resolveStaticPublisherPath(options.input);
  const outputPath = resolveStaticPublisherPath(options.output);
  if (
    inputPath === outputPath ||
    outputPath.startsWith(inputPath + ".") ||
    inputPath.startsWith(outputPath + ".")
  ) {
    throw new Error(
      `[sonic-hugging-face-infer] la sortie "${outputPath}" chevauche l'entrée "${inputPath}".`,
    );
  }
  const statusPath = options.status
    ? resolveStaticPublisherPath(options.status)
    : null;
  const outputPub = resolvePublisher(outputPath);
  const statePub = PublisherManager.get(deriveStateKey(outputPath));
  const statusPub = statusPath ? resolvePublisher(statusPath) : null;

  // Options d'appel : défauts du modèle + options de l'instance. Les options
  // non fiables (SDUI) sont validées ; une erreur est publiée dans le statut.
  let callError: string | null = null;
  let call: Record<string, unknown> = { ...(model.defaults ?? {}) };
  try {
    const instanceCall = options.untrusted
      ? (validateCallOptions(task, options.call) as Record<string, unknown>)
      : (options.call ?? {});
    call = { ...call, ...instanceCall };
  } catch (err) {
    callError = err instanceof Error ? err.message : String(err);
  }
  const positional = (HF_POSITIONAL_ARGS as Partial<Record<HfTask, string>>)[task];
  const batch = task === "feature-extraction" && !!call.pooling && call.pooling !== "none";

  let ctrl: CtrlPhase = "idle";
  let modelState: HfModelState = registry.state(options.model);
  let lastError: HfInferStatus["error"];
  let lastRunMs: number | undefined;
  let skipped: number | undefined;
  let warnings: string[] | undefined;
  let fromResultsCache = false;
  let lastOutput: unknown = undefined;
  let mediaUrls: string[] = [];
  let generation = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingManual = false;
  let modelRequested = false;

  const currentState = (): HfInferState => {
    switch (ctrl) {
      case "empty":
        return "empty";
      case "invalid-input":
        return "invalid-input";
      case "running":
        return "running";
      case "done":
        return "done";
      case "error":
        return "error";
      default:
        return MODEL_WAIT_STATES[modelState.phase] ?? "idle";
    }
  };

  const publishStatus = () => {
    if (stopped) return;
    const state = currentState();
    statePub.set(toDeriveState(state, lastOutput));
    if (!statusPub) return;
    const modelError =
      !["done", "running", "empty", "invalid-input"].includes(state) &&
      modelState.error
        ? modelState.error
        : undefined;
    const status: HfInferStatus = {
      state,
      model: {
        alias: model.alias,
        task,
        repo: model.repo,
        revision: model.revision,
        label: model.label,
        description: model.description,
      },
      // Toujours un objet (jamais null) : les liaisons `size.totalMB` restent stables.
      size: {
        totalBytes: modelState.size?.totalBytes ?? null,
        totalMB:
          modelState.size?.totalBytes == null
            ? null
            : Math.round(modelState.size.totalBytes / BYTES_PER_MIB),
        fromCache: modelState.size?.fromCache ?? false,
      },
      progress: modelState.progress,
      backend: modelState.backend,
      persisted: modelState.persisted,
      skipped,
      warnings,
      timings: { loadMs: modelState.loadMs, lastRunMs },
      fromResultsCache,
      error: lastError ?? modelError,
    };
    statusPub.set(JSON.parse(JSON.stringify(status)) as never);
  };

  const setOutput = (value: unknown) => {
    revokeMediaUrls(mediaUrls);
    mediaUrls = [];
    const enriched = attachMediaUrls(value, mediaUrls);
    lastOutput = enriched;
    outputPub.set(enriched as never);
  };

  const ensureModel = async (reason: HfLoadPolicy) => {
    modelRequested = true;
    await registry.ensureLoaded(options.model, reason);
  };

  /* ---------------- calcul ---------------- */

  type ReadyInput = Extract<HfNormalizedInput, { kind: "ok" }>;

  /** Validation + cache — sort si terminé (early exit). */
  const prepareCompute = async (
    gen: number,
  ): Promise<{ input: ReadyInput; key: string } | null> => {
    if (callError) {
      ctrl = "error";
      lastError = { code: "invalid-input", message: callError };
      publishStatus();
      return null;
    }

    const value = resolvePublisher(inputPath).get();
    const input = normalizeInput(value, {
      kind: HF_TASK_INPUT_KIND[task],
      text: options.text,
      maxItems,
      maxChars,
    });

    if (input.kind === "empty") {
      ctrl = "empty";
      skipped = undefined;
      warnings = undefined;
      setOutput(emptyValue);
      publishStatus();
      return null;
    }
    if (input.kind === "invalid") {
      ctrl = "invalid-input";
      lastError = { code: input.code, message: input.message };
      if (onInvalid === "clear") setOutput(emptyValue);
      publishStatus();
      return null;
    }
    if (positional && (call[positional] === undefined || call[positional] === "")) {
      ctrl = "invalid-input";
      lastError = {
        code: "invalid-input",
        message: `options.call.${positional} est requis pour la tâche "${task}".`,
      };
      publishStatus();
      return null;
    }

    skipped = input.skipped || undefined;
    warnings = input.warnings.length ? input.warnings : undefined;

    const key = await resultKey({
      payloads: input.payloads,
      positions: input.positions,
      length: input.length,
      many: input.many,
      alias: model.alias,
      repo: model.repo,
      revision: model.revision,
      options: model.options,
      runtime: runtimeVersion,
      call,
    });
    if (gen !== generation || stopped) return null;
    const cached = await readResult(key, persistResults, options.resultsTtlMs);
    if (gen !== generation || stopped) return null;
    if (cached.hit) {
      ctrl = "done";
      fromResultsCache = true;
      setOutput(cached.value);
      publishStatus();
      return null;
    }

    if (policy === "manual" && modelState.phase !== "ready") {
      ctrl = "waiting-model";
      pendingManual = true;
      publishStatus();
      return null;
    }

    return { input, key };
  };

  const runInference = async (
    gen: number,
    input: ReadyInput,
    key: string,
  ): Promise<void> => {
    ctrl = "waiting-model";
    publishStatus();
    try {
      await ensureModel(policy);
    } catch (err) {
      if (gen !== generation || stopped) return;
      ctrl = "waiting-model";
      if (lastOutput === undefined) setOutput(emptyValue);
      if (!(err instanceof HfError) || err.code === "runtime")
        lastError = {
          code: err instanceof HfError ? err.code : "runtime",
          message: err instanceof Error ? err.message : String(err),
        };
      publishStatus();
      return;
    }
    if (gen !== generation || stopped) return;

    ctrl = "running";
    publishStatus();
    const t0 = performance.now();
    try {
      const results = await registry.run(
        {
          alias: model.alias,
          inputs: input.payloads,
          call,
          positional,
          batch,
        },
        timeoutMs,
      );
      if (gen !== generation || stopped) return;
      const output = input.many ? realign(input, results) : (results[0] ?? null);
      lastRunMs = Math.round(performance.now() - t0);
      ctrl = "done";
      setOutput(output);
      publishStatus();
      void writeResult(key, output, persistResults, defaults.resultsCacheBytes);
    } catch (err) {
      if (gen !== generation || stopped) return;
      ctrl = "error";
      lastError = {
        code: err instanceof HfError ? err.code : "runtime",
        message: err instanceof Error ? err.message : String(err),
      };
      publishStatus();
    }
  };

  const compute = async (): Promise<void> => {
    if (stopped) return;
    const gen = ++generation;
    lastError = undefined;
    fromResultsCache = false;
    const prepared = await prepareCompute(gen);
    if (!prepared || gen !== generation || stopped) return;
    await runInference(gen, prepared.input, prepared.key);
  };

  const schedule = (delay = debounceMs) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void compute();
    }, delay);
  };

  /* ---------------- abonnements ---------------- */

  const unsubscribers: Array<() => void> = [];
  const watch = (path: string, handler: () => void) => {
    const pub = resolvePublisher(path);
    pub.onInternalMutation(handler);
    unsubscribers.push(() => pub.offInternalMutation(handler));
  };

  unsubscribers.push(
    registry.subscribe(options.model, (state) => {
      modelState = state;
      publishStatus();
      if (state.phase === "ready" && pendingManual) {
        pendingManual = false;
        schedule(0);
      }
    }),
  );

  if (trigger === "mutation") {
    watch(inputPath, () => schedule());
  } else {
    // État initial publié (vide / idle) sans calcul.
    publishStatus();
  }

  if (options.triggerProvider) {
    const triggerPath = resolveStaticPublisherPath(options.triggerProvider);
    let first = true;
    let previous = "";
    watch(triggerPath, () => {
      const current = JSON.stringify(resolvePublisher(triggerPath).get() ?? null);
      if (first) {
        first = false;
        previous = current;
        return;
      }
      if (current === previous) return;
      previous = current;
      if (current !== "null") schedule(0);
    });
  }

  if (options.consentProvider) {
    const consentPath = resolveStaticPublisherPath(options.consentProvider);
    watch(consentPath, () => {
      const value = resolvePublisher(consentPath).get();
      if (isAccepted(value)) registry.accept(options.model);
      else if (value === "declined") registry.decline(options.model);
    });
  }

  /* ---------------- préchargement selon la politique ---------------- */

  const preload = (reason: HfLoadPolicy) => {
    if (stopped || modelRequested) return;
    ensureModel(reason).catch(() => {
      /* l'état du modèle porte l'erreur */
    });
  };
  if (policy === "auto") preload("auto");
  else if (policy === "idle") {
    const ric = (
      globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    ).requestIdleCallback;
    if (ric) ric(() => preload("idle"), { timeout: IDLE_PRELOAD_TIMEOUT_MS });
    else setTimeout(() => preload("idle"), VISIBLE_FALLBACK_DELAY_MS);
  } else if (policy === "visible") {
    if (options.whenVisible) options.whenVisible().then(() => preload("visible"));
    else setTimeout(() => preload("visible"), VISIBLE_FALLBACK_DELAY_MS);
  } else {
    // first-use / consent / manual : on peut déjà connaître la taille (en-têtes seulement).
    registry.inspect(options.model).catch(() => undefined);
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      revokeMediaUrls(mediaUrls);
      mediaUrls = [];
    },
    run() {
      if (timer) clearTimeout(timer);
      timer = null;
      return compute();
    },
    async load() {
      await ensureModel("manual");
    },
    accept() {
      registry.accept(options.model);
    },
    decline() {
      registry.decline(options.model);
    },
  };
}
