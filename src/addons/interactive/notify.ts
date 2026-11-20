import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { SonicToast } from "@supersoniks/concorde/toast";
import { listenDp } from "../../shared/audio/dp";

const tagName = "sonic-notify";

type Status = "success" | "error" | "warning" | "info";
const STATUSES: readonly string[] = ["success", "error", "warning", "info"];

export type NotifyMessage = { text: string; label?: string; status?: Status; preserve?: boolean };

/** Texte brut (le toast de Concorde interprète le HTML : un message venu du réseau ou d'un visiteur ne doit pas l'être). */
export function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Lit la valeur surveillée : texte, `{text|message|content|error, label?, status?, preserve?}`, ou tableau de
 * ceux-ci. Vide (null, "", false, objet sans texte) = rien à montrer.
 */
export function toMessages(v: unknown, fallback: Omit<NotifyMessage, "text"> = {}): NotifyMessage[] {
  if (v === null || v === undefined || v === false || v === "") return [];
  if (Array.isArray(v)) return v.flatMap((x) => toMessages(x, fallback));
  if (typeof v === "string" || typeof v === "number") return [{ ...fallback, text: String(v).slice(0, 500) }];
  if (typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  const raw = o.text ?? o.message ?? o.content ?? o.error;
  if (typeof raw !== "string" || !raw.trim()) return [];
  const status = typeof o.status === "string" && STATUSES.includes(o.status) ? (o.status as Status) : fallback.status;
  return [{
    text: raw.slice(0, 500),
    label: typeof o.label === "string" ? o.label.slice(0, 120) : fallback.label,
    status,
    preserve: typeof o.preserve === "boolean" ? o.preserve : fallback.preserve,
  }];
}

/**
 * Toast déclaratif : montre un toast Concorde quand la valeur du DataProvider `watch` change et n'est pas vide.
 *
 * - `watch` : chemin DP (ex. `poseState.error`, `jeu.notice`) ; texte, objet `{text, label, status, preserve}`
 *   ou tableau. La valeur présente au branchement n'est pas montrée (sauf `initial`), une même valeur répétée
 *   non plus : le store remet le champ à vide ou en écrit une nouvelle pour en montrer une autre.
 * - `status` (success | error | warning | info), `label`, `preserve` : valeurs par défaut.
 *
 * Pour les retours ponctuels (erreur, confirmation, astuce au moment utile) plutôt qu'un texte gris permanent.
 */
@customElement(tagName)
export class SonicNotify extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  @property({ type: String }) watch = "";
  @property({ type: String }) status = "";
  @property({ type: String }) label = "";
  @property({ type: Boolean }) preserve = false;
  @property({ type: Boolean }) initial = false;

  private off: (() => void) | null = null;
  private last: string | null = null;
  private primed = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.bind();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.off?.();
    this.off = null;
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("watch") && changed.get("watch") !== undefined) this.bind();
  }

  private bind(): void {
    this.off?.();
    this.off = null;
    this.last = null;
    this.primed = this.initial;
    const path = this.watch.trim();
    if (!path) return;
    this.off = listenDp(path, (v) => this.onValue(v));
    // listenDp ne relaie que les changements : la valeur présente est lue en premier, ignorée sauf `initial`.
    queueMicrotask(() => {
      this.primed = true;
    });
  }

  private onValue(v: unknown): void {
    let k: string;
    try {
      k = JSON.stringify(v) ?? "";
    } catch {
      return;
    }
    const empty = toMessages(v).length === 0;
    if (k === this.last) return;
    this.last = empty ? null : k;
    if (!this.primed || empty) return;
    const fallback = {
      status: STATUSES.includes(this.status) ? (this.status as Status) : undefined,
      label: this.label || undefined,
      preserve: this.preserve || undefined,
    };
    for (const m of toMessages(v, fallback)) {
      SonicToast.add({
        text: escapeText(m.text),
        ...(m.label ? { label: escapeText(m.label) } : {}),
        ...(m.status ? { status: m.status } : {}),
        ...(m.preserve ? { preserve: true } : {}),
      });
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [tagName]: SonicNotify;
  }
}
