/**
 * Cœur de `sonic-trigger` : lecture d'une valeur dans la sortie d'un composant, comparaison à un seuil, et
 * machine à états (maintien, repos, un seul déclenchement par franchissement). Sans DOM : testable sous node.
 */

export type TriggerRule = {
  equals: string;
  not: string;
  gt: string;
  gte: string;
  lt: string;
  lte: string;
  /** Sans aucun opérateur, la condition est « la valeur est vraie ». */
  truthy: boolean;
};

export const NO_RULE: TriggerRule = { equals: "", not: "", gt: "", gte: "", lt: "", lte: "", truthy: false };

/** Valeur d'un chemin pointé (`labels.person`, `faces.0.blend.jawOpen`) ; undefined si absent. */
export function readPath(value: unknown, path: string): unknown {
  const p = path.trim();
  if (!p) return value;
  let cur: unknown = value;
  for (const seg of p.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function isTruthy(v: unknown): boolean {
  if (typeof v === "string") return v !== "" && v !== "false" && v !== "0";
  return Boolean(v);
}

/** Vrai quand `value` satisfait tous les opérateurs renseignés (ET) ; sans opérateur : valeur vraie. */
export function matchesRule(value: unknown, rule: TriggerRule): boolean {
  const num = (s: string) => Number(s);
  const tests: boolean[] = [];
  if (rule.equals !== "") tests.push(String(value) === rule.equals);
  if (rule.not !== "") tests.push(value !== undefined && value !== null && String(value) !== rule.not);
  const cmp = (s: string, f: (a: number, b: number) => boolean) => {
    const n = typeof value === "number" ? value : value === undefined || value === null || value === "" ? NaN : Number(value);
    return Number.isFinite(n) && Number.isFinite(num(s)) && f(n, num(s));
  };
  if (rule.gt !== "") tests.push(cmp(rule.gt, (a, b) => a > b));
  if (rule.gte !== "") tests.push(cmp(rule.gte, (a, b) => a >= b));
  if (rule.lt !== "") tests.push(cmp(rule.lt, (a, b) => a < b));
  if (rule.lte !== "") tests.push(cmp(rule.lte, (a, b) => a <= b));
  if (rule.truthy || tests.length === 0) tests.push(isTruthy(value));
  return tests.every(Boolean);
}

export type TriggerOptions = {
  /** La condition doit rester vraie ce temps (ms) avant de déclencher : filtre les faux positifs. */
  holdMs: number;
  /** Délai minimal entre deux déclenchements (ms). */
  cooldownMs: number;
  /** `edge` : un déclenchement par franchissement (il faut repasser à faux) ; `repeat` : un à chaque repos tant que c'est vrai. */
  mode: "edge" | "repeat";
};

export type TriggerEvent = "fire" | "end";

/**
 * Machine à états : `step(now, on)` à chaque changement de valeur et à intervalle régulier ; retourne les
 * événements à émettre (« fire » à la montée confirmée, « end » au retour à faux après un déclenchement).
 */
export class TriggerMachine {
  count = 0;
  /** true tant que la condition est vraie (brut, avant maintien). */
  active = false;
  /** true tant qu'un déclenchement est possible (edge : après un retour à faux). */
  armed = true;

  private since: number | null = null;
  private lastFire = Number.NEGATIVE_INFINITY;
  private episode = false;

  constructor(public opts: TriggerOptions) {}

  reset(): void {
    this.count = 0;
    this.active = false;
    this.armed = true;
    this.since = null;
    this.lastFire = Number.NEGATIVE_INFINITY;
    this.episode = false;
  }

  step(now: number, on: boolean): TriggerEvent[] {
    const out: TriggerEvent[] = [];
    this.active = on;
    if (!on) {
      this.since = null;
      this.armed = true;
      if (this.episode) {
        this.episode = false;
        out.push("end");
      }
      return out;
    }
    if (this.since === null) this.since = now;
    const held = now - this.since >= Math.max(0, this.opts.holdMs);
    const rested = now - this.lastFire >= Math.max(0, this.opts.cooldownMs);
    if (held && rested && (this.armed || this.opts.mode === "repeat")) {
      this.count++;
      this.lastFire = now;
      this.episode = true;
      if (this.opts.mode === "edge") this.armed = false;
      out.push("fire");
    }
    return out;
  }
}
