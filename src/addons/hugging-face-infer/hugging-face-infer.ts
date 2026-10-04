import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { onHuggingFaceConfig, type HfLoadPolicy, type HfTrigger } from "./hf-config";
import {
  createHfInferController,
  type HfInferHandle,
} from "./hf-controller";
import type { HfTextExtractor } from "./hf-input";
import { getHuggingFaceRegistry } from "./hf-registry";

type ElementOptions = {
  /** Champs à concaténer quand l'entrée est une liste d'objets : `"label + edito.sub_title"`. */
  text?: string | string[];
  /** Options d'appel du pipeline (validées selon la tâche du modèle). */
  call?: Record<string, unknown>;
};

/**
 * `sonic-hugging-face-infer` : 1 entrée → modèle Hugging Face (Transformers.js,
 * dans un worker) → 1 sortie (readonly).
 *
 * Le composant ne contient pas le moteur : Transformers.js n'est chargé qu'au
 * premier besoin, dans un worker, depuis une version figée (voir
 * `configureHuggingFace`). Le modèle doit figurer dans la liste blanche de
 * l'application (attribut `model` = alias).
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

  connectedCallback(): void {
    super.connectedCallback();
    this.offConfig = onHuggingFaceConfig(() => this.restart());
    // Premier branchement : `updated()` s'en charge (toutes les propriétés sont connues).
    if (this.hasUpdated) this.restart();
  }

  disconnectedCallback(): void {
    this.handle?.stop();
    this.handle = null;
    this.offConfig?.();
    this.offConfig = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.size && this.isConnected) this.restart();
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

  private restart(): void {
    this.handle?.stop();
    this.handle = null;
    if (!this.isConnected) return;
    if (!this.model || !this.inputProvider || !this.outputProvider) return;
    if (!getHuggingFaceRegistry()) {
      console.warn(
        "[sonic-hugging-face-infer] configureHuggingFace() n'a pas été appelé : composant inactif.",
      );
      return;
    }
    try {
      this.handle = createHfInferController({
        model: this.model,
        input: this.inputProvider,
        output: this.outputProvider,
        status: this.statusProvider || undefined,
        triggerProvider: this.triggerProvider || undefined,
        consentProvider: this.consentProvider || undefined,
        text: this.options?.text as HfTextExtractor | undefined,
        call: this.options?.call,
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
      console.error(err instanceof Error ? err.message : err);
    }
  }

  render() {
    return html`<slot></slot>`;
  }
}
