import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { publisherAt } from "../../shared/dp-path";
import { CounterTrigger } from "../../shared/media/control";
import { dispatch } from "../interactive";
import { type CatchEvent, MAX_AGENTS, Swarm, type WorldSpec, agentClip } from "./core";

const STEP = 1 / 60;

function parseSpec(v: unknown): WorldSpec | null {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as WorldSpec) : null;
}

/** Réglages en direct : groupes fusionnés par nom sur la description (`{groups: [{name, seek: {target: [x, y]}}], paused}`). */
function merge(base: WorldSpec, over: WorldSpec | null): WorldSpec {
  if (!over) return base;
  const groups = (base.groups ?? []).map((g) => {
    const o = (over.groups ?? []).find((x) => x && x.name === g.name);
    return o ? { ...g, ...o } : g;
  });
  return { ...base, ...over, groups };
}

/**
 * Essaims : agents pilotés (boids, chercher, fuir, poursuivre, chemin, champ de flux sur grille…) publiés au format
 * `nodes` (x, y, rz) et en liste `sprites` pour `sonic-2d`. Description dans `spec` (JSON ou chemin DataProvider),
 * réglages en direct dans `control` (DataProvider, fusionné par nom de groupe), captures envoyées à un store.
 */
@customElement("sonic-swarm")
export class SonicSwarm extends LitElement {
  /** Description `{bounds, edges, grid, seed, groups}` : JSON littéral ou chemin DataProvider. */
  @property({ type: String }) spec = "";
  /** Chemin DataProvider des réglages en direct (cibles, poids, `paused`, `count`). */
  @property({ type: String }) control = "";
  /** DataProvider de sortie : `nodes`, `sprites`, `agents`, `count`, `status`, `error`, `catches`. */
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  /** `screen` (x, y, rz) ou `xz` (sol 3D : x, z, ry ; `scale` = unités du monde par mètre). */
  @property({ type: String }) plane: "screen" | "xz" = "screen";
  @property({ type: Number }) scale = 1;
  /** Publications par seconde (la simulation tourne à 60 Hz). */
  @property({ type: Number }) rate = 30;
  /** Store qui reçoit les captures (`{type: action, payload: {by, caught, group, x, y}}`). */
  @property({ type: String }) target = "";
  @property({ type: String }) action = "swarm:catch";
  /**
   * Store qui reçoit `{type: "swarm:report", payload: {agents: {nom: [x, y, cap]}, groups, leaders}}` toutes les
   * `report-ms` ms : positions des groupes `report-groups` (noms séparés par des virgules, tous si vide), agents
   * vivants par groupe, suiveurs par meneur. Un réducteur ne lit pas les autres DataProviders : c'est sa vue du monde.
   */
  @property({ type: String }) report = "";
  @property({ type: String, attribute: "report-groups" }) reportGroups = "";
  @property({ type: Number, attribute: "report-ms" }) reportMs = 100;

  private sim = new Swarm(1);
  private base: WorldSpec | null = null;
  private live: WorldSpec | null = null;
  private applied = "";
  private raf = 0;
  private last = 0;
  private acc = 0;
  private sinceOut = 0;
  private unsubs: (() => void)[] = [];
  private spriteSig = "";
  private catches = 0;
  private respawnTrigger = new CounterTrigger();
  private sinceReport = 0;

  createRenderRoot(): HTMLElement | ShadowRoot {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    this.listen();
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("spec") || c.has("control")) this.listen();
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const src = this.spec.trim();
    if (src.startsWith("{")) {
      this.base = parseSpec(src);
      if (!this.base) this.fail("spec : JSON invalide");
    } else if (src) {
      this.unsubs.push(listenDp(src, (v) => {
        this.base = parseSpec(v);
        this.reconfigure();
      }));
      this.base = parseSpec(this.read(src));
    }
    const ctl = this.control.trim();
    if (ctl) {
      this.respawnTrigger.reset();
      const onControl = (v: unknown) => {
        this.live = parseSpec(v);
        this.reconfigure();
        // compteur `respawn` : tout le monde replacé, les agents retirés reviennent (nouveau niveau)
        if (this.respawnTrigger.feed((this.live as { respawn?: unknown } | null)?.respawn)) {
          this.sim.respawnAll();
          this.publish(true);
        }
      };
      this.unsubs.push(listenDp(ctl, onControl));
      this.live = parseSpec(this.read(ctl));
      this.respawnTrigger.feed((this.live as { respawn?: unknown } | null)?.respawn);
    }
    this.sim = new Swarm(this.base?.seed ?? 1);
    this.applied = "";
    this.reconfigure();
  }

  private read(path: string): unknown {
    try {
      return (publisherAt(path) as unknown as { get(): unknown }).get();
    } catch {
      return null;
    }
  }

  private fail(msg: string): void {
    if (this.outDataProvider) {
      set(`${this.outDataProvider}.status`, "error");
      set(`${this.outDataProvider}.error`, msg);
    }
  }

  private reconfigure(): void {
    if (!this.base) return;
    const spec = merge(this.base, this.live);
    const sig = JSON.stringify(spec);
    if (sig === this.applied) return;
    this.applied = sig;
    try {
      this.sim.configure(spec);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    const wanted = (spec.groups ?? []).reduce((s, g) => s + Math.max(0, Math.floor(Number(g.count ?? 1))), 0);
    if (this.outDataProvider) {
      set(`${this.outDataProvider}.status`, "ready");
      set(`${this.outDataProvider}.error`, wanted > MAX_AGENTS ? `${wanted} agents demandés, ${MAX_AGENTS} au plus` : "");
    }
    this.publish(true);
    this.wake();
  }

  private wake(): void {
    if (!this.raf && this.isConnected) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  private frame(now: number): void {
    this.raf = 0;
    if (!this.isConnected) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const paused = !!(this.live as { paused?: unknown } | null)?.paused;
    if (!paused && this.sim.agents.length) {
      this.acc += dt;
      let steps = 0;
      const events: CatchEvent[] = [];
      while (this.acc >= STEP && steps < 4) {
        events.push(...this.sim.step(STEP, (ref) => this.resolve(ref)));
        this.acc -= STEP;
        steps++;
      }
      if (steps === 4) this.acc = 0;
      for (const ev of events) this.emit(ev);
      // une capture `remove` change la liste des sprites
      const removedNow = events.length > 0 && this.sim.removed.size > 0;
      this.sinceOut += dt;
      this.sinceReport += dt;
      if (this.report && this.sinceReport * 1000 >= Math.max(33, Number(this.reportMs) || 100)) {
        this.sinceReport = 0;
        this.sendReport();
      }
      if (removedNow || this.sinceOut >= 1 / Math.max(1, Math.min(60, this.rate))) {
        this.sinceOut = 0;
        this.publish(removedNow);
      }
    }
    if (document.visibilityState !== "hidden") this.raf = requestAnimationFrame((t) => this.frame(t));
    else document.addEventListener("visibilitychange", () => this.wake(), { once: true });
  }

  /** `dp:<chemin>` → `[x, y]` ou `{x, y}` lu dans un DataProvider (pointeur, joueur…). */
  private resolve(ref: string): [number, number] | null {
    if (!ref.startsWith("dp:")) return null;
    const v = this.read(ref.slice(3)) as unknown;
    if (Array.isArray(v) && v.length >= 2) return [Number(v[0]), Number(v[1])];
    if (v && typeof v === "object") {
      const o = v as { x?: unknown; y?: unknown };
      const x = Number(o.x), y = Number(o.y);
      if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
    }
    return null;
  }

  /** Rapport au store : positions des groupes choisis, vivants par groupe, suiveurs par meneur. */
  sendReport(): void {
    if (!this.report) return;
    const want = new Set(this.reportGroups.split(",").map((x) => x.trim()).filter(Boolean));
    const agents: Record<string, [number, number, number]> = {};
    const groups: Record<string, number> = {};
    for (const a of this.sim.agents) {
      const g = this.sim.groups[a.group]?.name ?? "";
      groups[g] = (groups[g] ?? 0) + 1;
      if (!want.size || want.has(g)) agents[a.name] = [Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10, Math.round(Math.atan2(a.vy, a.vx) * 1000) / 1000];
    }
    dispatch(this.report, { type: "swarm:report", payload: { agents, groups, leaders: this.sim.followers() } });
  }

  private emit(ev: CatchEvent): void {
    this.catches++;
    if (this.outDataProvider) set(`${this.outDataProvider}.catches`, this.catches);
    if (this.target) dispatch(this.target, { type: this.action || "swarm:catch", payload: { ...ev } });
    this.dispatchEvent(new CustomEvent("catch", { detail: ev, bubbles: true, composed: true }));
  }

  private clipOf = new Map<string, string>();

  private publish(withSprites: boolean): void {
    const out = this.outDataProvider;
    if (!out) return;
    const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
    const r3 = (n: number) => Math.round(n * 1000) / 1000 + 0;
    const nodes: Record<string, Record<string, unknown>> = {};
    const agents: Record<string, unknown>[] = [];
    const groups: Record<string, number> = {};
    const k = Number(this.scale) || 1;
    // couleurs : seulement quand le meneur change (patch : un champ absent reste tel quel)
    const recolor = new Set(this.sim.takeLeaderChanges());
    for (const a of this.sim.agents) {
      const h = Math.atan2(a.vy, a.vx);
      const g = this.sim.groups[a.group];
      const n: Record<string, unknown> = this.plane === "xz" ? { x: r2(a.x / k), z: r2(a.y / k), ry: r3(-h) } : { x: r2(a.x), y: r2(a.y), rz: r3(h) };
      if (withSprites || recolor.has(a.name)) {
        const c = this.sim.colorOf(a);
        if (c) {
          n.color = c;
          n.roles = { [g?.follow?.role || "peau"]: c };
        }
      }
      // clip selon l'état (nage, fuite, morsure) : seulement quand il change
      const want = g ? agentClip(a, g) : null;
      if (want) {
        const key = `${want.clip}|${want.pace}`;
        if (this.clipOf.get(a.name) !== key || withSprites) {
          this.clipOf.set(a.name, key);
          if (want.clip) n.clip = want.clip;
          if (g?.clips?.pace) n.clipSpeed = want.pace;
        }
      }
      // à chaque publication : un rendu qui arrive après coup (scène chargée à la demande) ne lit que le dernier état
      n.visible = true;
      nodes[a.name] = n;
      if (g) groups[g.name] = (groups[g.name] ?? 0) + 1;
      agents.push({ name: a.name, group: g?.name, x: r2(a.x), y: r2(a.y), heading: r3(h), ...(a.leader !== undefined && g?.follow ? { leader: a.leader } : {}) });
    }
    for (const name of this.sim.takeRemoved()) nodes[name] = { visible: false };
    set(`${out}.nodes`, nodes);
    set(`${out}.agents`, agents);
    set(`${out}.count`, agents.length);
    set(`${out}.groups`, groups);
    if (withSprites) {
      const sprites: Record<string, unknown>[] = [];
      for (const a of this.sim.agents) {
        const s = this.sim.groups[a.group]?.sprite;
        if (s && typeof s === "object") sprites.push({ shape: "circle", r: this.sim.groups[a.group].radius ?? 6, ...s, ...(this.sim.colorOf(a) ? { fill: this.sim.colorOf(a) } : {}), name: a.name, x: r2(a.x), y: r2(a.y) });
      }
      const sig = JSON.stringify(sprites.map((s) => [s.name, s.shape, s.r, s.fill, s.text]));
      if (sig !== this.spriteSig) {
        this.spriteSig = sig;
        set(`${out}.sprites`, sprites);
      }
    }
  }
}
