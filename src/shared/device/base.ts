import { LitElement, css, html } from "lit";
import { property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../audio/dp";
import { CounterTrigger } from "../media/control";

/**
 * Socle des composants « appareil » (plein écran, pointer lock, wake lock, capteurs…).
 *
 * Convention creative-stack : composant sans rendu, état publié dans `<id>State` (ou
 * `out-data-provider`), pilotage par compteurs dans un DataProvider `control`
 * (`{ toggle: 3 }` puis `{ toggle: 4 }` déclenche une fois), et clic direct par `for="idBouton"`.
 *
 * Geste utilisateur : les API qui l'exigent (plein écran, pointer lock, vibration, partage,
 * permission des capteurs iOS) échouent sans geste. `for` appelle l'action **dans** le clic ;
 * un compteur écrit par un bouton SDUI marche aussi dans la fenêtre d'activation transitoire du
 * navigateur (quelques secondes sous Chrome et Firefox, plus courte sous Safari). Une commande
 * lancée par un minuteur ou un agent, sans geste, est refusée par le navigateur.
 */

export type DeviceStatus = "idle" | "requesting" | "ready" | "denied" | "error" | "unsupported";

export type DeviceBaseState = {
  status: DeviceStatus;
  /** Dernière erreur (message lisible), `null` si tout va bien. */
  error: string | null;
  /** L'API existe dans ce navigateur. */
  supported: boolean;
  /** Autorisée par la Permissions Policy de la page hôte (iframe) ; `"unknown"` si indétectable. */
  allowed: boolean | "unknown";
  /** La fonction est actuellement engagée (plein écran, verrou, vibration…). */
  active: boolean;
};

export type CommandArg = Record<string, unknown>;
export type CommandMap = Record<string, (arg: CommandArg) => unknown>;

type PolicyLike = { allowsFeature?: (name: string) => boolean; features?: () => string[] };

/**
 * La Permissions Policy de la page autorise-t-elle cette fonctionnalité ?
 * `"unknown"` quand l'API de lecture n'existe pas ou ne connaît pas le nom (évite aussi
 * l'avertissement « unrecognized feature » de Chrome).
 */
export function policyAllows(feature: string | null): boolean | "unknown" {
  if (!feature || typeof document === "undefined") return "unknown";
  const d = document as Document & { permissionsPolicy?: PolicyLike; featurePolicy?: PolicyLike };
  const policy = d.permissionsPolicy ?? d.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== "function") return "unknown";
  try {
    const known = typeof policy.features === "function" ? policy.features() : null;
    if (known && !known.includes(feature)) return "unknown";
    return policy.allowsFeature(feature);
  } catch {
    return "unknown";
  }
}

/** Erreur d'API navigateur → statut et message lisible (pour l'agent comme pour l'utilisateur). */
export function deviceError(e: unknown, what: string): { status: DeviceStatus; error: string } {
  const name = (e as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return { status: "denied", error: `${what} refusé : geste de l'utilisateur requis, permission refusée ou interdit par la page hôte` };
    case "NotSupportedError":
    case "TypeError":
      return { status: "unsupported", error: `${what} non disponible dans ce navigateur` };
    case "InvalidStateError":
      return { status: "error", error: `${what} impossible dans l'état actuel (page non visible ?)` };
    default:
      return { status: "error", error: e instanceof Error && e.message ? e.message : `${what} : erreur` };
  }
}

/** Cible lisible d'un élément : `div#scene`, `canvas.vue`, `body`. */
export function describeElement(el: Element | null | undefined): string | null {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return cls ? `${tag}.${cls}` : tag;
}

export abstract class DeviceElement<S extends DeviceBaseState> extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** DP de pilotage : compteurs `{ <commande>: n }` (ou `{ <commande>: { n, ...arguments } }`). */
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  /** Ids des éléments dont le clic lance la commande par défaut, dans le geste (`for="plein-ecran"`). */
  @property({ type: String, attribute: "for" }) targets = "";
  /** Publications par seconde au plus pour les valeurs continues (défaut 30). */
  @property({ type: Number }) rate = 30;

  protected abstract state: S;
  /** Nom de la fonctionnalité dans la Permissions Policy, `null` si elle n'en a pas. */
  protected abstract readonly feature: string | null;
  /** Commande lancée par `for` (clic direct). */
  protected readonly defaultCommand: string = "toggle";
  protected abstract commands(): CommandMap;

  private triggers = new Map<string, CounterTrigger>();
  private unsubControl: (() => void) | null = null;
  private lastJson = "";
  private lastPublish = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onClick, true);
  }

  disconnectedCallback(): void {
    document.removeEventListener("click", this.onClick, true);
    this.unsubControl?.();
    this.unsubControl = null;
    this.triggers.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("control")) {
      this.unsubControl?.();
      this.triggers.clear();
      this.unsubControl = this.control ? listenDp(this.control, (v) => this.onControl(v)) : null;
    }
  }

  getState(): S {
    return JSON.parse(JSON.stringify(this.state)) as S;
  }

  /** Lance une commande par son nom (public pour les tests et le pilotage direct). Ne lève jamais. */
  async run(name: string, arg: CommandArg = {}): Promise<boolean> {
    const fn = this.commands()[name];
    if (!fn) return false;
    try {
      const result = await fn(arg);
      // Une commande qui répond par un booléen dit elle-même si elle a abouti ; sinon : pas d'erreur publiée.
      return typeof result === "boolean" ? result : this.state.error === null;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Change l'état et publie (immédiatement par défaut). */
  protected patch(partial: Partial<S>, force = true): void {
    this.state = { ...this.state, ...partial };
    this.publish(force);
  }

  protected fail(e: unknown, what = this.localName.replace(/^sonic-/, "")): void {
    const { status, error } = deviceError(e, what);
    this.patch({ status, error, active: false } as Partial<S>);
  }

  protected emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /** Appelé après chaque publication réelle (remise à zéro de valeurs cumulées, par exemple). */
  protected onPublished(): void {}

  protected publish(force = false): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out) return;
    const json = JSON.stringify(this.state);
    if (json === this.lastJson) return;
    const now = performance.now();
    const gap = 1000 / Math.max(1, Math.min(60, this.rate));
    if (!force && now - this.lastPublish < gap) {
      // Trop tôt : dernier état publié à la fin de l'intervalle, jamais perdu.
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          this.publish(true);
        }, gap - (now - this.lastPublish));
      }
      return;
    }
    this.lastPublish = now;
    this.lastJson = json;
    set(out, this.getState());
    this.onPublished();
  }

  private onControl(v: unknown): void {
    if (!v || typeof v !== "object") return;
    const map = this.commands();
    for (const name of Object.keys(map)) {
      const raw = (v as Record<string, unknown>)[name];
      if (raw === undefined) continue;
      let trigger = this.triggers.get(name);
      if (!trigger) {
        trigger = new CounterTrigger();
        this.triggers.set(name, trigger);
      }
      if (trigger.feed(raw)) void this.run(name, raw && typeof raw === "object" ? (raw as CommandArg) : {});
    }
  }

  private onClick = (e: Event): void => {
    const ids = this.targets
      .split(/\s+/)
      .map((s) => s.replace(/^#/, ""))
      .filter(Boolean);
    if (!ids.length) return;
    const hit = e.composedPath().some((n) => n instanceof Element && !!n.id && ids.includes(n.id));
    // Appel synchrone dans le handler du clic : l'activation utilisateur est encore là.
    if (hit) void this.run(this.defaultCommand);
  };

  render() {
    return html``;
  }
}
