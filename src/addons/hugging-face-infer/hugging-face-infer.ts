import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { onHuggingFaceConfig, type HfLoadPolicy, type HfTrigger } from "./hf-config";
import {
  createHfInferController,
  type HfInferHandle,
} from "./hf-controller";
import type { HfTextExtractor } from "./hf-input";
import { HfError, getHuggingFaceRegistry } from "./hf-registry";

type ElementOptions = {
  /** Champs à concaténer quand l'entrée est une liste d'objets : `"label + edito.sub_title"`. */
  text?: string | string[];
  /** Options d'appel du pipeline (validées selon la tâche du modèle). */
  call?: Record<string, unknown>;
};

/** Réglages lus dans le DataProvider `params`. */
export type HfInferParams = { model?: string; options?: ElementOptions | null };

/**
 * Statut publié dans `statusProvider` quand le composant ne peut pas démarrer (configuration absente,
 * modèle manquant ou hors liste blanche, chemins incohérents, options illisibles).
 */
export type HfInferConfigErrorStatus = {
  state: "error";
  status: "error";
  model: { alias: string };
  size: { totalBytes: null; totalMB: null; fromCache: false };
  error: { code: "config" | HfError["code"]; message: string };
};

/**
 * `sonic-hugging-face-infer` : 1 entrée → modèle Hugging Face (Transformers.js,
 * dans un worker) → 1 sortie (readonly).
 *
 * Le composant ne contient pas le moteur : Transformers.js n'est chargé qu'au
 * premier besoin, dans un worker, depuis une version figée (voir
 * `configureHuggingFace`). Le modèle doit figurer dans la liste blanche de
 * l'application (attribut `model` = alias).
 *
 * Pilotage : le DataProvider `params` (`{ model, options }`) remplace les attributs `model` et `options`
 * et redémarre le contrôleur quand il change. Les erreurs de configuration sont publiées dans
 * `statusProvider` (`{ state: "error", status: "error", error: { code, message } }`).
 */
@customElement("sonic-hugging-face-infer")
export default class SonicHuggingFaceInfer extends LitElement {
  static styles = [
    css`
      :host {
        display: contents;
      }
    `,
  ];

  /** Alias du modèle (liste blanche de l'application). */
  @property({ type: String })
  model = "";

  /** DataProvider d'entrée : texte, liste de textes, liste d'objets (+ `options.text`), image, audio. */
  @property({ type: String })
  inputProvider = "";

  /** DataProvider de sortie (readonly). */
  @property({ type: String })
  outputProvider = "";

  /** DataProvider optionnel où publier le statut détaillé (taille, progression, backend…). */
  @property({ type: String })
  statusProvider = "";

  /** Mode `demand` : chaque changement de ce DataProvider lance un calcul. */
  @property({ type: String })
  triggerProvider = "";

  /** DataProvider (ex. case à cocher d'un formulaire) qui donne le consentement. */
  @property({ type: String })
  consentProvider = "";

  /** `{"text": …, "call": {…}}` */
  @property({ type: Object })
  options: ElementOptions | null = null;

  /** DataProvider de réglages en direct : `{ model, options }` (l'emporte sur les attributs). */
  @property({ type: String })
  params = "";

  /** `auto` | `idle` | `visible` | `first-use` | `consent` | `manual` */
  @property({ type: String })
  load: HfLoadPolicy | "" = "";

  /** `mutation` | `demand` */
  @property({ type: String })
  trigger: HfTrigger | "" = "";

  @property({ type: Number })
  debounce: number | null = null;

  /** Valeur publiée quand l'entrée est vide (JSON). Défaut : `null`. */
  @property({ type: Object })
  emptyValue: unknown = null;

  /** Entrée invalide : garder le dernier résultat (`keep`) ou vider (`clear`). */
  @property({ type: String })
  onInvalid: "keep" | "clear" = "keep";

  @property({ type: Number })
  maxItems: number | null = null;

  @property({ type: Number })
  maxChars: number | null = null;

  @property({ type: Number })
  timeoutMs: number | null = null;

  /** Mémoriser les résultats en IndexedDB (ex. embeddings d'un catalogue stable). */
  @property({ type: Boolean })
  persistResults = false;

  /** Durée de validité des résultats mémorisés (ms). */
  @property({ type: Number })
  resultsTtl: number | null = null;

  private handle: HfInferHandle | null = null;
  private offConfig: (() => void) | null = null;
  private visible: Promise<void> | null = null;
  private fromParams: HfInferParams = {};
  private paramsKey = "{}";
  private offParams: (() => void) | null = null;
  private paramsError: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.offConfig = onHuggingFaceConfig(() => this.restart());
    if (this.hasUpdated) this.listenParams();
    // Premier branchement : `updated()` s'en charge (toutes les propriétés sont connues).
    if (this.hasUpdated) this.restart();
  }

  disconnectedCallback(): void {
    this.handle?.stop();
    this.handle = null;
    this.offConfig?.();
    this.offConfig = null;
    this.offParams?.();
    this.offParams = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("params")) this.listenParams();
    if (changed.size && this.isConnected) this.restart();
  }

  /** Modèle et options effectifs (attributs, remplacés par `params`). */
  get effective(): { model: string; options: ElementOptions | null } {
    return {
      model: this.fromParams.model ?? this.model,
      options: this.fromParams.options !== undefined ? this.fromParams.options : this.options,
    };
  }

  private listenParams(): void {
    this.offParams?.();
    this.offParams = null;
    this.fromParams = {};
    this.paramsKey = "{}";
    this.paramsError = null;
    if (!this.params || !this.isConnected) return;
    let first = true;
    this.offParams = listenDp(this.params, (v) => {
      const { params, error } = readHfParams(v);
      const key = JSON.stringify(params) + (error ?? "");
      if (key === this.paramsKey) return;
      this.paramsKey = key;
      this.fromParams = params;
      this.paramsError = error;
      // Premier appel (synchrone) : `updated()` redémarre juste après.
      if (!first) this.restart();
    });
    first = false;
  }

  /** Calcule maintenant sur l'entrée courante. */
  run(): Promise<void> {
    return this.handle?.run() ?? Promise.resolve();
  }

  /** Charge le modèle maintenant. */
  loadModel(): Promise<void> {
    return this.handle?.load() ?? Promise.resolve();
  }

  accept(): void {
    this.handle?.accept();
  }

  decline(): void {
    this.handle?.decline();
  }

  private whenVisible = (): Promise<void> => {
    if (!this.visible) {
      this.visible = new Promise((resolve) => {
        // `display: contents` : on observe le parent.
        const target = this.parentElement ?? this;
        if (typeof IntersectionObserver === "undefined") return resolve();
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(target);
      });
    }
    return this.visible;
  };

  /** Publie une erreur de configuration dans `statusProvider` (et, si demandé, en console). */
  private configError(code: HfInferConfigErrorStatus["error"]["code"], message: string, log?: "warn" | "error"): void {
    if (log) console[log](`[sonic-hugging-face-infer] ${message}`);
    if (!this.statusProvider) return;
    const status: HfInferConfigErrorStatus = {
      state: "error",
      status: "error",
      model: { alias: this.effective.model },
      size: { totalBytes: null, totalMB: null, fromCache: false },
      error: { code, message },
    };
    set(this.statusProvider, status);
  }

  private restart(): void {
    this.handle?.stop();
    this.handle = null;
    if (!this.isConnected) return;
    const { model, options } = this.effective;
    if (this.paramsError) return this.configError("config", this.paramsError, "warn");
    if (!model) return this.configError("config", "modèle manquant (attribut model ou params.model)");
    if (!this.inputProvider) return this.configError("config", "inputProvider manquant");
    if (!this.outputProvider) return this.configError("config", "outputProvider manquant");
    if (!getHuggingFaceRegistry()) {
      return this.configError("config", "configureHuggingFace() n'a pas été appelé : composant inactif.", "warn");
    }
    try {
      this.handle = createHfInferController({
        model,
        input: this.inputProvider,
        output: this.outputProvider,
        status: this.statusProvider || undefined,
        triggerProvider: this.triggerProvider || undefined,
        consentProvider: this.consentProvider || undefined,
        text: options?.text as HfTextExtractor | undefined,
        call: options?.call,
        untrusted: true,
        load: this.load || undefined,
        trigger: this.trigger || undefined,
        debounceMs: this.debounce ?? undefined,
        emptyValue: this.emptyValue,
        onInvalid: this.onInvalid,
        maxItems: this.maxItems ?? undefined,
        maxChars: this.maxChars ?? undefined,
        timeoutMs: this.timeoutMs ?? undefined,
        persistResults: this.persistResults,
        resultsTtlMs: this.resultsTtl ?? undefined,
        whenVisible: this.whenVisible,
      });
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).replace(/^\[sonic-hugging-face-infer\]\s*/, "");
      this.configError(err instanceof HfError ? err.code : "config", message, "error");
    }
  }

  render() {
    return html`<slot></slot>`;
  }
}

/**
 * Lit `{ model, options }` dans une valeur de DataProvider. `options` accepte un objet ou du JSON ;
 * une forme illisible donne une erreur de configuration.
 */
export function readHfParams(v: unknown): { params: HfInferParams; error: string | null } {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return { params: {}, error: null };
  const p = v as Record<string, unknown>;
  const params: HfInferParams = {};
  if (typeof p.model === "string" && p.model.trim()) params.model = p.model.trim();
  else if (p.model !== undefined && p.model !== null && p.model !== "") return { params, error: "params.model doit être un alias (texte)" };
  let o = p.options;
  if (typeof o === "string") {
    if (!o.trim()) o = undefined;
    else {
      try { o = JSON.parse(o); } catch { return { params, error: "params.options : JSON illisible" }; }
    }
  }
  if (o === null) params.options = null;
  else if (o !== undefined) {
    if (typeof o !== "object" || Array.isArray(o)) return { params, error: "params.options doit être un objet { text, call }" };
    const opts = o as Record<string, unknown>;
    if (opts.call !== undefined && (typeof opts.call !== "object" || opts.call === null || Array.isArray(opts.call))) {
      return { params, error: "params.options.call doit être un objet" };
    }
    params.options = opts as ElementOptions;
  }
  return { params, error: null };
}
