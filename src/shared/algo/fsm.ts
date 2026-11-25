/**
 * Machine à états déclarative, sans code : transitions par événement, gardes par égalité ou comparaison sur un
 * contexte, transitions « * » valables depuis tout état.
 *
 * ```json
 * {"initial": "idle", "states": {
 *   "idle":   {"on": {"see": "chase"}},
 *   "chase":  {"on": {"lost": "idle", "hit": [{"target": "flee", "when": {"hp": {"lt": 3}}}, {"target": "fight"}]}},
 *   "*":      {"on": {"die": "dead"}}
 * }}
 * ```
 */
type Guard = Record<string, unknown>;
type Transition = string | { target: string; when?: Guard };

interface Machine {
  initial?: string;
  states?: Record<string, { on?: Record<string, Transition | Transition[]> }>;
}

function get(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function test(value: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    const c = cond as Record<string, unknown>;
    const n = Number(value);
    for (const [op, ref] of Object.entries(c)) {
      const r = Number(ref);
      if (op === "lt" && !(n < r)) return false;
      if (op === "lte" && !(n <= r)) return false;
      if (op === "gt" && !(n > r)) return false;
      if (op === "gte" && !(n >= r)) return false;
      if (op === "eq" && value !== ref) return false;
      if (op === "ne" && value === ref) return false;
      if (op === "in" && !(Array.isArray(ref) && ref.includes(value as never))) return false;
    }
    return true;
  }
  return value === cond;
}

function passes(when: Guard | undefined, ctx: unknown): boolean {
  if (!when) return true;
  for (const [path, cond] of Object.entries(when)) if (!test(get(ctx, path), cond)) return false;
  return true;
}

/** État suivant (l'état courant si aucun passage ne s'applique ; `initial` si l'état est vide). */
export function fsmStep(machine: unknown, state: unknown, event: unknown, ctx?: unknown): string {
  const m = (machine && typeof machine === "object" ? machine : {}) as Machine;
  const states = m.states ?? {};
  const cur = typeof state === "string" && state ? state : String(m.initial ?? "");
  const ev = typeof event === "string" ? event : (event as { type?: unknown } | null)?.type;
  if (typeof ev !== "string") return cur;
  for (const from of [cur, "*"]) {
    const t = states[from]?.on?.[ev];
    if (t === undefined) continue;
    for (const tr of Array.isArray(t) ? t : [t]) {
      if (typeof tr === "string") return tr;
      if (tr && typeof tr === "object" && typeof tr.target === "string" && passes(tr.when, ctx)) return tr.target;
    }
  }
  return cur;
}
