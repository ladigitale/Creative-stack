/**
 * TimelineRunner : lie un descripteur compilé à des éléments du DOM.
 * Partagé par `sonic-timeline` (temps lu dans un DataProvider) et `sonic-animate` (horloge locale).
 * Pas de rAF sauf pendant un lissage (`smooth` > 0) en cours de convergence.
 */
import { set as setDp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { prefersReducedMotion } from "./attrs";
import {
  applyState,
  compileTimeline,
  evaluate,
  labelAt,
  normalizeProgress,
  setsCrossed,
  type Compiled,
} from "./timeline-core";
import type { AnimationIssue, TimelineDescriptor } from "./types";
import { validateTimelineDescriptor } from "./validate";

export type RunnerState = {
  status: "idle" | "ready" | "error";
  progress: number;
  time: number;
  duration: number;
  currentLabel: string;
  issues: AnimationIssue[];
};

export type RunnerOptions = {
  onState?: (state: RunnerState) => void;
  /** Écriture d'un nœud `set` (défaut : DataProvider Concorde). */
  write?: (path: string, value: unknown) => void;
  /** Force `prefers-reduced-motion` (tests). */
  reducedMotion?: boolean;
  /**
   * Mode `nodes` : au lieu d'écrire dans le DOM, publie l'état des cibles au format `nodes` partagé
   * (src/shared/nodes.ts) dans ce DataProvider (`<dp>.nodes`). Les cibles sont alors des noms de nœuds
   * (élément de `sonic-stage`, nœud glTF de `sonic-3d`).
   */
  nodesOut?: string;
};

/** Cible fictive d'un nœud en mode `nodes` (aucun élément DOM). */
type NodeTarget = { nodeName: string };
const RAD = Math.PI / 180;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Propriétés de timeline → champs `nodes` (rotation en degrés → `rz` en radians ; le reste est ignoré). */
export function propsToNode(props: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  if ("x" in props) out.x = r4(props.x);
  if ("y" in props) out.y = r4(props.y);
  if ("rotate" in props) out.rz = r4(props.rotate * RAD);
  if ("scale" in props) out.scale = r4(props.scale);
  if ("opacity" in props) out.opacity = r4(props.opacity);
  return out;
}

const escAttr = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const TOKEN = /^(children|group):(.+)$/;

export class TimelineRunner {
  private descriptor: TimelineDescriptor | null = null;
  private compiled: Compiled | null = null;
  private cache = new Map<string, Element[]>();
  private observer: MutationObserver | null = null;
  private refreshQueued = false;
  private target = 0;
  private shown = 0;
  private lastTime = -1;
  private label = "";
  private raf = 0;
  private lastFrame = 0;
  private issues: AnimationIssue[] = [];
  private warned = new Set<string>();
  private disposed = false;
  private lastNodes = "";
  private nodeTargets = new Map<string, NodeTarget>();

  constructor(private host: HTMLElement, private options: RunnerOptions = {}) {}

  /** Charge (ou remplace) le descripteur. Valide, compile ; invalide = muet + problèmes publiés. */
  configure(descriptor: TimelineDescriptor | null): void {
    this.descriptor = descriptor;
    this.compiled = null;
    this.cache.clear();
    this.lastTime = -1;
    this.label = "";
    this.issues = descriptor ? validateTimelineDescriptor(descriptor) : [];
    for (const i of this.issues) {
      const key = `${i.path}|${i.message}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(`[sonic-animation] ${i.path} : ${i.message} ${i.fix}`);
      }
    }
    if (descriptor && !this.issues.length) {
      this.compiled = compileTimeline(descriptor.root, { countTargets: (t) => this.resolve(t).length });
      this.observe();
    } else {
      this.unobserve();
    }
    this.emit();
    if (this.compiled) this.render();
  }

  get duration(): number {
    const d = this.descriptor?.duration;
    if (typeof d === "number" && d > 0) return d;
    return this.compiled?.duration ?? 0;
  }

  get state(): RunnerState {
    const duration = this.duration;
    return {
      status: this.issues.length ? "error" : this.compiled ? "ready" : "idle",
      progress: this.shown,
      time: this.shown * duration,
      duration,
      currentLabel: this.label,
      issues: this.issues,
    };
  }

  /** Position normalisée (0..1) demandée par la source de temps. */
  setProgress(t: unknown): void {
    if (!this.compiled) return;
    this.target = normalizeProgress(t, this.descriptor?.outOfRange ?? "clamp");
    const smooth = this.descriptor?.smooth ?? 0;
    if (smooth > 0 && !this.reduced()) {
      if (!this.raf) {
        this.lastFrame = performance.now();
        this.raf = requestAnimationFrame(this.frame);
      }
      return;
    }
    this.shown = this.target;
    this.render();
  }

  /** Recalcule les cibles (arbre SDUI modifié) et réapplique l'état courant. */
  refresh(): void {
    if (!this.descriptor || !this.compiled || this.disposed) return;
    this.cache.clear();
    this.compiled = compileTimeline(this.descriptor.root, { countTargets: (t) => this.resolve(t).length });
    this.render();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.unobserve();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cache.clear();
  }

  /* ------------------------------------------------------------ interne */

  private reduced(): boolean {
    return this.options.reducedMotion ?? prefersReducedMotion();
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.disposed) return;
    const smooth = this.descriptor?.smooth ?? 0;
    const dt = Math.min(0.25, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const k = smooth > 0 ? 1 - Math.exp(-dt / smooth) : 1;
    this.shown += (this.target - this.shown) * k;
    if (Math.abs(this.target - this.shown) < 1e-4) this.shown = this.target;
    this.render();
    if (this.shown !== this.target) this.raf = requestAnimationFrame(this.frame);
  };

  private render(): void {
    const compiled = this.compiled;
    if (!compiled) return;
    const duration = this.duration;
    // Mouvement réduit : état final, sans passage par les états intermédiaires.
    const time = this.reduced() ? duration : this.shown * duration;
    const states = evaluate(compiled, time, (t) => this.resolve(t));
    const out = this.options.nodesOut?.trim();
    if (out) {
      const nodes: Record<string, Record<string, number>> = {};
      for (const [target, st] of states) nodes[(target as unknown as NodeTarget).nodeName] = propsToNode(st.props);
      const sig = JSON.stringify(nodes);
      if (sig !== this.lastNodes) {
        this.lastNodes = sig;
        try {
          (this.options.write ?? setDp)(`${out}.nodes`, nodes);
        } catch {
          /* écriture refusée : ignorée */
        }
      }
    } else for (const [el, st] of states) applyState(el, st);

    if (time < this.lastTime) this.lastTime = time;
    for (const s of setsCrossed(compiled, this.lastTime, time)) {
      try {
        (this.options.write ?? setDp)(s.path, s.value);
      } catch {
        /* écriture refusée : ignorée */
      }
    }
    this.lastTime = time;

    const label = labelAt(compiled, time);
    const changed = label !== this.label;
    this.label = label;
    if (changed || this.options.onState) this.emit();
  }

  private emit(): void {
    this.options.onState?.(this.state);
  }

  private root(): ParentNode {
    return this.host.getRootNode() as ParentNode;
  }

  private resolve(target: string): Element[] {
    const hit = this.cache.get(target);
    if (hit) return hit;
    if (this.options.nodesOut?.trim()) {
      // Mode nodes : une cible = un nom de nœud ; `children:` et `group:` n'ont pas de sens sans DOM.
      let t = this.nodeTargets.get(target);
      if (!t && !TOKEN.test(target) && target !== "@self") this.nodeTargets.set(target, (t = { nodeName: target }));
      const els = (t ? [t] : []) as unknown as Element[];
      this.cache.set(target, els);
      return els;
    }
    const root = this.root();
    let els: Element[] = [];
    const m = TOKEN.exec(target);
    try {
      if (m && m[1] === "group") {
        els = [...root.querySelectorAll(`[data-anim-group="${escAttr(m[2])}"]`)];
      } else {
        const id = m ? m[2] : target;
        const base =
          id === "@self"
            ? [this.host]
            : [...root.querySelectorAll(`[data-node-id="${escAttr(id)}"], [id="${escAttr(id)}"]`)];
        els = m ? base.flatMap((b) => [...b.children]) : base;
      }
    } catch {
      els = [];
    }
    this.cache.set(target, els);
    return els;
  }

  private observe(): void {
    if (this.observer || typeof MutationObserver === "undefined" || this.options.nodesOut?.trim()) return;
    const root = this.root() as unknown as Node;
    this.observer = new MutationObserver(() => {
      if (this.refreshQueued) return;
      this.refreshQueued = true;
      setTimeout(() => {
        this.refreshQueued = false;
        this.refreshIfTargetsChanged();
      }, 0);
    });
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["id", "data-node-id", "data-anim-group"],
    });
  }

  private unobserve(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private refreshIfTargetsChanged(): void {
    if (this.disposed || !this.compiled) return;
    const before = new Map(this.cache);
    this.cache.clear();
    let changed = false;
    for (const [token, prev] of before) {
      const next = this.resolve(token);
      if (next.length !== prev.length || next.some((el, i) => el !== prev[i])) changed = true;
    }
    if (changed) this.refresh();
  }
}
