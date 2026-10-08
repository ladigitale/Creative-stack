/**
 * Compatibilité SDUI avec Concorde classique (5.x).
 *
 * La branche `4.9.98-visual-stack.*` de Concorde ajoutait au cœur trois comportements
 * utilisés par les artefacts déclaratifs. Concorde 5.x ne les a pas ; on les ajoute ici
 * **sans fork ni redéfinition** : les classes enregistrées par Concorde sont complétées
 * au chargement (prototype), et rien ne change quand les nouveaux attributs sont absents.
 *
 * - `sonic-if` : mode attributs `dataProvider` + `key` + `equals` / `not` / `truthy` / `gt` / `lt`.
 * - `sonic-value` : `format="00000"` (pad) ou `format="intl:fr-FR[:currency:EUR|:percent]"`.
 * - `sonic-value` : une valeur texte qui commence par `[` ou `{` sans être du JSON
 *   (« [Espace] pause ») ne fait plus planter le setter `props` du Subscriber.
 *
 * Les classes sont lues dans `customElements` (pas via l'import) : en mode bundle autonome,
 * c'est la classe de Concorde core de la page qui est complétée, pas la copie embarquée.
 */
import { html, nothing, type ReactiveController, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { HTML, PublisherManager } from "@supersoniks/concorde/utils";
import "@supersoniks/concorde/if";
import "@supersoniks/concorde/value";

const PATCHED_IF = Symbol.for("creative-stack.compat.if");
const PATCHED_VALUE = Symbol.for("creative-stack.compat.value");
const PATCHED_PROPS = Symbol.for("creative-stack.compat.props");

type Publisher = {
  get(): unknown;
  onAssign(handler: (v: unknown) => void, directHandlerCall?: boolean): void;
  offAssign(handler: (v: unknown) => void): void;
  onInternalMutation(handler: VoidFunction): void;
  offInternalMutation(handler: VoidFunction): void;
};

type LitHost = HTMLElement & {
  requestUpdate(): void;
  render(): unknown;
};

/** Lecture d'un chemin `a.b.c` (tolère les valeurs manquantes). */
export function pathGet(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const p of path.split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// sonic-if
// ---------------------------------------------------------------------------

export type IfRule = {
  key: string;
  equals: string;
  not: string;
  truthy: boolean;
  gt: string;
  lt: string;
};

/** Même sémantique que visual-stack : la première règle renseignée l'emporte. */
export function evaluateIf(root: unknown, rule: IfRule): boolean {
  const value = pathGet(root, rule.key);
  if (rule.equals !== "") return String(value) === rule.equals;
  if (rule.not !== "") return String(value) !== rule.not;
  if (rule.gt !== "") return Number(value) > Number(rule.gt);
  if (rule.lt !== "") return Number(value) < Number(rule.lt);
  return Boolean(value);
}

const IF_ATTRS = ["dataprovider", "key", "equals", "not", "truthy", "gt", "lt"];

type IfState = {
  rule: IfRule | null;
  publisher: Publisher | null;
  update: VoidFunction;
  observer: MutationObserver | null;
};

const ifStates = new WeakMap<HTMLElement, IfState>();

function readIfRule(el: HTMLElement): IfRule {
  return {
    key: el.getAttribute("key") ?? "",
    equals: el.getAttribute("equals") ?? "",
    not: el.getAttribute("not") ?? "",
    truthy: el.hasAttribute("truthy"),
    gt: el.getAttribute("gt") ?? "",
    lt: el.getAttribute("lt") ?? "",
  };
}

function resolveDataProvider(el: HTMLElement): string | null {
  const own = el.getAttribute("dataProvider");
  if (own) return own;
  const inherited = HTML.getAncestorAttributeValue(el, "dataProvider");
  return inherited || null;
}

function bindIf(el: LitHost): void {
  let state = ifStates.get(el);
  if (!state) {
    state = {
      rule: null,
      publisher: null,
      update: () => el.requestUpdate(),
      observer: null,
    };
    ifStates.set(el, state);
  }
  unbindPublisher(state);

  const rule = readIfRule(el);
  const hasRule =
    rule.key !== "" ||
    rule.truthy ||
    rule.equals !== "" ||
    rule.not !== "" ||
    rule.gt !== "" ||
    rule.lt !== "";
  const dataProvider = hasRule ? resolveDataProvider(el) : null;

  if (dataProvider) {
    const publisher = PublisherManager.get(dataProvider) as unknown as Publisher;
    state.rule = rule;
    state.publisher = publisher;
    publisher.onAssign(state.update, false);
    publisher.onInternalMutation(state.update);
  } else {
    state.rule = null;
  }

  if (!state.observer && typeof MutationObserver !== "undefined") {
    state.observer = new MutationObserver(() => {
      bindIf(el);
      el.requestUpdate();
    });
    state.observer.observe(el, { attributes: true, attributeFilter: IF_ATTRS });
  }
}

function unbindPublisher(state: IfState): void {
  if (!state.publisher) return;
  state.publisher.offAssign(state.update);
  state.publisher.offInternalMutation(state.update);
  state.publisher = null;
}

function unbindIf(el: HTMLElement): void {
  const state = ifStates.get(el);
  if (!state) return;
  unbindPublisher(state);
  state.observer?.disconnect();
  state.observer = null;
}

const withController = new WeakSet<HTMLElement>();

function attachIfController(el: LitHost): void {
  if (withController.has(el)) return;
  withController.add(el);
  const host = el as LitHost & { addController(c: ReactiveController): void };
  // addController appelle hostConnected tout de suite si l'élément est déjà connecté.
  host.addController({
    hostConnected: () => bindIf(el),
    hostDisconnected: () => unbindIf(el),
  });
}

function patchIf(ctor: CustomElementConstructor): void {
  const proto = ctor.prototype as LitHost & { [PATCHED_IF]?: boolean };
  if (Object.prototype.hasOwnProperty.call(proto, PATCHED_IF)) return;
  proto[PATCHED_IF] = true;

  const render = proto.render;

  // connectedCallback / disconnectedCallback sont capturés par customElements.define :
  // les remplacer sur le prototype après coup n'aurait aucun effet. On passe donc par un
  // ReactiveController Lit, ajouté au premier rendu (render, lui, est relu à chaque appel).
  proto.render = function (this: LitHost) {
    attachIfController(this);
    const state = ifStates.get(this);
    if (!state?.rule || !state.publisher) return render.call(this);
    return evaluateIf(state.publisher.get(), state.rule)
      ? html`<slot></slot>`
      : nothing;
  };
}

// ---------------------------------------------------------------------------
// sonic-value
// ---------------------------------------------------------------------------

/** Formatage de `sonic-value` (`""` = pas de format, valeur brute). */
export function formatValue(raw: unknown, format: string): string {
  const s = String(raw);
  if (!format) return s;
  if (format.startsWith("intl:")) {
    const [locale = "fr-FR", style, currency = "EUR"] = format.slice(5).split(":");
    const n = Number(raw);
    if (!Number.isFinite(n)) return s;
    if (style === "currency") {
      return new Intl.NumberFormat(locale || "fr-FR", { style: "currency", currency }).format(n);
    }
    if (style === "percent") {
      return new Intl.NumberFormat(locale || "fr-FR", { style: "percent" }).format(n);
    }
    return new Intl.NumberFormat(locale || "fr-FR").format(n);
  }
  if (/^0+$/.test(format)) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return s;
    return String(n).padStart(format.length, "0");
  }
  return s;
}

type SubscriberHost = LitHost & {
  props: unknown;
  _props: unknown;
  publisher: { get(): unknown; set(v: unknown): void } | null;
};

/** Vrai si `v` ferait échouer le `JSON.parse` du setter `props` de Concorde. */
export function isUnparsableJsonLike(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const first = v.trim().charAt(0);
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(v);
    return false;
  } catch {
    return true;
  }
}

function findAccessor(proto: object, name: string): { owner: object; desc: PropertyDescriptor } | null {
  let cur: object | null = proto;
  while (cur) {
    const desc = Object.getOwnPropertyDescriptor(cur, name);
    if (desc && (desc.get || desc.set)) return { owner: cur, desc };
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

/**
 * Le setter `props` du mixin Subscriber fait `JSON.parse` sans garde sur toute chaîne
 * commençant par `{` ou `[`. Pour ces chaînes-là seulement, on garde la valeur brute
 * en reprenant le reste du setter d'origine à l'identique.
 */
export function guardSubscriberProps(ctor: CustomElementConstructor): void {
  const found = findAccessor(ctor.prototype, "props");
  if (!found?.desc.set) return;
  const { owner, desc } = found;
  const marked = owner as { [PATCHED_PROPS]?: boolean };
  if (Object.prototype.hasOwnProperty.call(marked, PATCHED_PROPS)) return;
  marked[PATCHED_PROPS] = true;
  const originalSet = desc.set as (this: SubscriberHost, v: unknown) => void;
  Object.defineProperty(owner, "props", {
    ...desc,
    set(this: SubscriberHost, value: unknown) {
      if (!isUnparsableJsonLike(value)) {
        originalSet.call(this, value);
        return;
      }
      if (value == this._props) return;
      this._props = value;
      if (this.publisher && this.publisher.get() != value) this.publisher.set(value);
      this.requestUpdate();
    },
  });
}

function patchValue(ctor: CustomElementConstructor): void {
  guardSubscriberProps(ctor);
  const proto = ctor.prototype as SubscriberHost & { [PATCHED_VALUE]?: boolean };
  if (Object.prototype.hasOwnProperty.call(proto, PATCHED_VALUE)) return;
  proto[PATCHED_VALUE] = true;
  const render = proto.render;
  proto.render = function (this: SubscriberHost) {
    const format = this.getAttribute("format") ?? "";
    const raw = this.props;
    if (!format || typeof raw === "object" || raw === undefined) return render.call(this);
    return html`${unsafeHTML(formatValue(raw, format))}<slot name="prefix"></slot><slot></slot
      ><slot name="suffix"></slot>` as TemplateResult;
  };
}

// ---------------------------------------------------------------------------

let installed = false;

/** Installe les compléments (idempotent). Appelé à l'import de ce module. */
export function installConcordeCompat(): void {
  if (installed || typeof customElements === "undefined") return;
  installed = true;
  const ifCtor = customElements.get("sonic-if");
  if (ifCtor) patchIf(ifCtor);
  else void customElements.whenDefined("sonic-if").then((c) => patchIf(c));
  const valueCtor = customElements.get("sonic-value");
  if (valueCtor) patchValue(valueCtor);
  else void customElements.whenDefined("sonic-value").then((c) => patchValue(c));
}

installConcordeCompat();
