/**
 * Noyau pur de la timeline : compilation de l'arbre, évaluation à un instant, application au DOM.
 * Le temps est une entrée : `evaluate(compiled, time)` ne dépend de rien d'autre (rejouable, scrubbable).
 */
import type { Ease, TextNode, TimelineNode, TweenNode } from "./types";

export const LIMITS = { maxDepth: 8, maxTargets: 200, maxDuration: 600 } as const;

export const BASE_PROPS = ["opacity", "x", "y", "scale", "rotate", "blur"] as const;

export function isAnimatableProp(name: string): boolean {
  return (BASE_PROPS as readonly string[]).includes(name) || /^--[A-Za-z0-9_-]+$/.test(name);
}

/* ---------------------------------------------------------------- easing */

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sy = (s: number) => ((ay * s + by) * s + cy) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(s) - x;
      if (Math.abs(err) < 1e-6) return sy(s);
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 24; i++) {
      const v = sx(s);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return sy(s);
  };
}

export function resolveEase(ease: Ease | undefined): (t: number) => number {
  if (Array.isArray(ease) && ease.length === 4 && ease.every((n) => typeof n === "number")) {
    return cubicBezier(ease[0], ease[1], ease[2], ease[3]);
  }
  switch (ease) {
    case "easeIn":
      return (t) => t * t;
    case "easeOut":
      return (t) => 1 - (1 - t) * (1 - t);
    case "easeInOut":
      return (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    default:
      return (t) => t;
  }
}

/* ------------------------------------------------------------ compilation */

export type CompiledTween = {
  start: number;
  duration: number;
  targets: string[];
  staggerEach: number;
  props: Record<string, [number, number]>;
  ease: (t: number) => number;
};

export type CompiledText = {
  start: number;
  duration: number;
  targets: string[];
  staggerEach: number;
  mode: "count" | "type";
  from: number;
  to: number;
  decimals: number;
  prefix: string;
  suffix: string;
  ease: (t: number) => number;
};

export type CompiledSet = { at: number; path: string; value: unknown };
export type CompiledLabel = { at: number; name: string };

export type Compiled = {
  duration: number;
  tweens: CompiledTween[];
  texts: CompiledText[];
  sets: CompiledSet[];
  labels: CompiledLabel[];
};

export type CompileOptions = {
  /** Nombre d'éléments visés par une cible (pour répartir un stagger). Défaut : 1. */
  countTargets?: (target: string) => number;
};

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function compileTimeline(root: TimelineNode, options: CompileOptions = {}): Compiled {
  const out: Compiled = { duration: 0, tweens: [], texts: [], sets: [], labels: [] };
  const count = options.countTargets ?? (() => 1);
  let maxEnd = 0;

  const targetCount = (targets: string[]) =>
    Math.max(1, targets.reduce((n, t) => n + Math.max(0, count(t)), 0));

  /** Place un nœud à `start` ; renvoie sa durée (utilisée par `seq`). */
  const place = (node: TimelineNode, start: number, each: number, depth: number): number => {
    if (!node || typeof node !== "object" || depth > LIMITS.maxDepth) return 0;
    switch (node.type) {
      case "tween":
      case "text": {
        const n = node as TweenNode | TextNode;
        const targets = Array.isArray(n.targets) ? n.targets.filter((t) => typeof t === "string") : [];
        const delay = Math.max(0, num(n.delay, 0));
        const dur = Math.max(0, num(n.duration, 0.5));
        const spread = Math.max(0, targetCount(targets) - 1) * each;
        const common = { start: start + delay, duration: dur, targets, staggerEach: each, ease: resolveEase(n.ease) };
        if (node.type === "tween") {
          out.tweens.push({ ...common, props: (node as TweenNode).props ?? {} });
        } else {
          const t = node as TextNode;
          out.texts.push({
            ...common,
            mode: t.mode === "type" ? "type" : "count",
            from: num(t.from, 0),
            to: num(t.to, 100),
            decimals: Math.max(0, Math.min(6, Math.round(num(t.decimals, 0)))),
            prefix: typeof t.prefix === "string" ? t.prefix : "",
            suffix: typeof t.suffix === "string" ? t.suffix : "",
          });
        }
        const total = delay + dur + spread;
        maxEnd = Math.max(maxEnd, start + total);
        return total;
      }
      case "seq": {
        let cursor = 0;
        for (const child of node.nodes ?? []) cursor += place(child, start + cursor, each, depth + 1);
        return cursor;
      }
      case "par": {
        let longest = 0;
        for (const child of node.nodes ?? []) longest = Math.max(longest, place(child, start, each, depth + 1));
        return longest;
      }
      case "stagger": {
        const step = Math.max(0, num(node.each, 0.1));
        let longest = 0;
        (node.nodes ?? []).forEach((child, i) => {
          longest = Math.max(longest, i * step + place(child, start + i * step, step, depth + 1));
        });
        return longest;
      }
      case "set": {
        const at = start + Math.max(0, num(node.at, 0));
        if (typeof node.path === "string" && node.path) out.sets.push({ at, path: node.path, value: node.value });
        maxEnd = Math.max(maxEnd, at);
        return 0;
      }
      case "label": {
        const at = start + Math.max(0, num(node.at, 0));
        if (typeof node.name === "string" && node.name) out.labels.push({ at, name: node.name });
        maxEnd = Math.max(maxEnd, at);
        return 0;
      }
      default:
        return 0;
    }
  };

  place(root, 0, 0, 1);
  out.duration = Math.min(LIMITS.maxDuration, maxEnd);
  out.labels.sort((a, b) => a.at - b.at);
  out.sets.sort((a, b) => a.at - b.at);
  return out;
}

/* ------------------------------------------------------------- évaluation */

export type TextState =
  | { mode: "count"; value: number; decimals: number; prefix: string; suffix: string }
  | { mode: "type"; progress: number };

export type ElementState = { props: Record<string, number>; text?: TextState };
export type Resolver = (target: string) => Element[];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** État de chaque élément visé à l'instant `time` (secondes). Sans effet de bord. */
export function evaluate(compiled: Compiled, time: number, resolve: Resolver): Map<Element, ElementState> {
  const result = new Map<Element, ElementState>();
  const stateOf = (el: Element) => {
    let s = result.get(el);
    if (!s) result.set(el, (s = { props: {} }));
    return s;
  };

  type Pick = { start: number; value: number; started: boolean; order: number };
  const picks = new Map<Element, Map<string, Pick>>();
  const consider = (el: Element, key: string, effStart: number, order: number, value: number) => {
    let m = picks.get(el);
    if (!m) picks.set(el, (m = new Map()));
    const cur = m.get(key);
    const started = effStart <= time;
    if (!cur) {
      m.set(key, { start: effStart, value, started, order });
      return;
    }
    if (started) {
      if (!cur.started || effStart > cur.start || (effStart === cur.start && order >= cur.order)) {
        m.set(key, { start: effStart, value, started, order });
      }
    } else if (!cur.started && effStart < cur.start) {
      m.set(key, { start: effStart, value, started, order });
    }
  };

  let order = 0;
  const flat = (targets: string[]) => {
    const els: Element[] = [];
    for (const t of targets) for (const el of resolve(t)) if (!els.includes(el)) els.push(el);
    return els;
  };
  const progress = (effStart: number, dur: number, ease: (t: number) => number) =>
    ease(dur <= 0 ? (time >= effStart ? 1 : 0) : clamp01((time - effStart) / dur));

  for (const tw of compiled.tweens) {
    order++;
    flat(tw.targets).forEach((el, i) => {
      const effStart = tw.start + i * tw.staggerEach;
      const p = progress(effStart, tw.duration, tw.ease);
      for (const [prop, range] of Object.entries(tw.props)) {
        if (!Array.isArray(range) || range.length !== 2) continue;
        const [from, to] = range;
        if (typeof from !== "number" || typeof to !== "number") continue;
        consider(el, prop, effStart, order, from + (to - from) * p);
      }
    });
  }
  for (const [el, m] of picks) {
    const s = stateOf(el);
    for (const [k, p] of m) s.props[k] = p.value;
  }

  const textPick = new Map<Element, { start: number; state: TextState; started: boolean; order: number }>();
  for (const tx of compiled.texts) {
    order++;
    flat(tx.targets).forEach((el, i) => {
      const effStart = tx.start + i * tx.staggerEach;
      const p = progress(effStart, tx.duration, tx.ease);
      const state: TextState =
        tx.mode === "type"
          ? { mode: "type", progress: p }
          : { mode: "count", value: tx.from + (tx.to - tx.from) * p, decimals: tx.decimals, prefix: tx.prefix, suffix: tx.suffix };
      const started = effStart <= time;
      const cur = textPick.get(el);
      if (!cur || (started && (!cur.started || effStart >= cur.start)) || (!started && !cur.started && effStart < cur.start)) {
        textPick.set(el, { start: effStart, state, started, order });
      }
    });
  }
  for (const [el, p] of textPick) stateOf(el).text = p.state;
  return result;
}

/** Label courant : le dernier dont l'instant est atteint (chaîne vide avant le premier). */
export function labelAt(compiled: Compiled, time: number): string {
  let name = "";
  for (const l of compiled.labels) if (l.at <= time) name = l.name;
  return name;
}

/** `set` à déclencher quand le temps passe de `from` (exclu) à `to` (inclus), en avançant. */
export function setsCrossed(compiled: Compiled, from: number, to: number): CompiledSet[] {
  if (to <= from) return [];
  return compiled.sets.filter((s) => s.at > from && s.at <= to);
}

/* ------------------------------------------------------------- application */

const originalText = new WeakMap<Element, string>();

const round = (v: number) => Math.round(v * 10000) / 10000;

export function applyState(el: Element, state: ElementState): void {
  const style = (el as HTMLElement).style;
  if (!style) return;
  const p = state.props;
  if ("opacity" in p) style.opacity = String(round(p.opacity));
  const parts: string[] = [];
  if ("x" in p || "y" in p) parts.push(`translate(${round(p.x ?? 0)}px, ${round(p.y ?? 0)}px)`);
  if ("rotate" in p) parts.push(`rotate(${round(p.rotate)}deg)`);
  if ("scale" in p) parts.push(`scale(${round(p.scale)})`);
  if (parts.length) style.transform = parts.join(" ");
  if ("blur" in p) style.filter = `blur(${round(Math.max(0, p.blur))}px)`;
  for (const [k, v] of Object.entries(p)) if (k.startsWith("--")) style.setProperty(k, String(round(v)));

  if (state.text) {
    if (!originalText.has(el)) originalText.set(el, el.textContent ?? "");
    const t = state.text;
    let next: string;
    if (t.mode === "type") {
      const full = originalText.get(el) ?? "";
      next = full.slice(0, Math.round(full.length * clamp01(t.progress)));
    } else {
      next = `${t.prefix}${t.value.toFixed(t.decimals)}${t.suffix}`;
    }
    // Ne réécrit que si le texte change : évite de relancer l'observateur de mutations en boucle.
    if (el.textContent !== next) el.textContent = next;
  }
}

/** Progression normalisée : hors de 0..1, `clamp` (défaut) ou `wrap`. */
export function normalizeProgress(t: unknown, mode: "clamp" | "wrap" = "clamp"): number {
  const v = typeof t === "number" ? t : Number(t);
  if (!Number.isFinite(v)) return 0;
  if (mode === "wrap") return ((v % 1) + 1) % 1;
  return clamp01(v);
}
