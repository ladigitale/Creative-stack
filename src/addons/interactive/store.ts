import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import jsonata from "jsonata";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { registerInteractiveHelpers } from "./helpers";
import {
  dispatch as registryDispatch,
  registerStore,
  unregisterStore,
  type SonicActionMessage,
  type StoreHandle,
} from "./registry";

const tagName = "sonic-store";

const DEFAULT_MAX_STATE_BYTES = 256 * 1024;
const DEFAULT_BUDGET_MS = 8;

type HistoryEntry = unknown;

/**
 * Store déclaratif : state' = reducer($state, $action, $env) via JSONata.
 * Opt-in : `@supersoniks/concorde/interactive`.
 */
@customElement(tagName)
export class SonicStore extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  /** Identifiant du store (obligatoire pour dispatch). */
  @property({ type: String })
  id = "";

  /** DataProvider où publier l’état (défaut = id). */
  @property({ type: String })
  dataProvider = "";

  /** État initial (JSON attribut / objet). */
  @property({ type: Object })
  initial: unknown = null;

  /** Expression JSONata du reducer. */
  @property({ type: String })
  reducer = "";

  @property({ type: Number, attribute: "max-state-bytes" })
  maxStateBytes = DEFAULT_MAX_STATE_BYTES;

  @property({ type: Number, attribute: "budget-ms" })
  budgetMs = DEFAULT_BUDGET_MS;

  /** Taille max de l’historique undo (0 = off). */
  @property({ type: Number })
  history = 0;

  private state: unknown = null;
  private queue: SonicActionMessage[] = [];
  private draining = false;
  private compiled: ReturnType<typeof jsonata> | null = null;
  private historyStack: HistoryEntry[] = [];
  private lastError: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.bootstrap();
  }

  disconnectedCallback(): void {
    if (this.id) unregisterStore(this.id);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (
      changed.has("id") ||
      changed.has("reducer") ||
      changed.has("initial") ||
      changed.has("dataProvider")
    ) {
      const prevId = changed.get("id");
      if (typeof prevId === "string" && prevId && prevId !== this.id) {
        unregisterStore(prevId);
      }
      this.bootstrap();
    }
  }

  private dpId(): string {
    return (this.dataProvider || this.id || "").trim();
  }

  /** Action optionnelle après bootstrap (ex. `view` pour peindre la grille). */
  @property({ type: String, attribute: "boot-action" })
  bootAction = "";

  private bootstrap(): void {
    if (!this.id) return;
    this.compileReducer();
    this.state = this.clone(this.initial);
    this.historyStack = [];
    this.lastError = null;
    this.publish();
    const handle: StoreHandle = {
      id: this.id,
      dispatch: (action) => this.enqueue(action),
      getState: () => this.state,
      reset: () => this.reset(),
    };
    registerStore(handle);
    const boot = (this.bootAction || "").trim();
    if (boot) this.enqueue({ type: boot, t: performance.now() });
  }

  private compileReducer(): void {
    this.compiled = null;
    const src = (this.reducer || "").trim();
    if (!src) return;
    if (src.length > 32_768) {
      this.fail("reducer trop long (max 32 Ko)");
      return;
    }
    try {
      const expr = jsonata(src);
      registerInteractiveHelpers(expr);
      // Désactiver impureté
      expr.assign("random", () => {
        throw new Error("$random interdit dans un reducer (utiliser $rand)");
      });
      expr.assign("now", () => {
        throw new Error("$now interdit dans un reducer (utiliser $action.t)");
      });
      this.compiled = expr;
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private enqueue(action: SonicActionMessage): void {
    if (action.type === "@reset") {
      this.reset();
      return;
    }
    if (action.type === "@undo") {
      this.undo();
      return;
    }
    this.queue.push(action);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const action = this.queue.shift()!;
        await this.apply(action);
      }
    } finally {
      this.draining = false;
    }
  }

  private async apply(action: SonicActionMessage): Promise<void> {
    if (!this.compiled) return;
    const started = performance.now();
    const env = {
      width: typeof window !== "undefined" ? window.innerWidth : 0,
      height: typeof window !== "undefined" ? window.innerHeight : 0,
      now: action.t ?? started,
    };
    const bindings = {
      state: this.state,
      action: {
        type: action.type,
        payload: action.payload ?? null,
        t: action.t ?? started,
        dt: action.dt ?? null,
      },
      env,
    };
    try {
      const expr = this.compiled;
      // Bindings → $state, $action, $env (purs ; pas de $random / $now)
      const result = await expr.evaluate(this.state, {
        state: this.state,
        action: bindings.action,
        env,
      });
      const elapsed = performance.now() - started;
      if (elapsed > this.budgetMs) {
        this.fail(`budget ${this.budgetMs}ms dépassé (${elapsed.toFixed(1)}ms)`);
        return;
      }
      if (result === undefined) return;
      const encoded = JSON.stringify(result);
      if (encoded !== undefined && encoded.length > this.maxStateBytes) {
        this.fail(`état trop gros (max ${this.maxStateBytes} octets)`);
        return;
      }
      if (this.history > 0) {
        this.historyStack.push(this.clone(this.state));
        if (this.historyStack.length > this.history) this.historyStack.shift();
      }
      this.state = result;
      this.lastError = null;
      this.publish();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private reset(): void {
    this.state = this.clone(this.initial);
    this.historyStack = [];
    this.lastError = null;
    this.publish();
  }

  private undo(): void {
    if (!this.historyStack.length) return;
    this.state = this.historyStack.pop();
    this.publish();
  }

  private publish(): void {
    const id = this.dpId();
    if (!id) return;
    const payload =
      this.state && typeof this.state === "object"
        ? { ...(this.state as object), lastError: this.lastError }
        : { value: this.state, lastError: this.lastError };
    set(id, payload as never);
  }

  private fail(message: string): void {
    this.lastError = message;
    this.dispatchEvent(
      new CustomEvent("error", {
        detail: { message },
        bubbles: true,
        composed: true,
      }),
    );
    this.publish();
  }

  private clone(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return v;
    }
  }

  /** API élément : dispatch manuel. */
  dispatchAction(action: SonicActionMessage): void {
    registryDispatch(this.id, action);
  }

  render() {
    return html``;
  }
}

export default SonicStore;
