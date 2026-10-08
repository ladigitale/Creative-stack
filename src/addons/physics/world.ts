import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import type { SonicFrameConsumerHost, SonicFrameSource } from "../../shared/mediaRef";
import { CounterTrigger } from "../../shared/media/control";
import { parseBody, parseJoint, PhysicsWorld, type BodySpec, type BodyState, type Drive, type JointSpec, type PhysicsEvent, type WorldOptions } from "./core";
import "./elements";

const tagName = "sonic-physics";
const STEP = 1 / 60;
const MAX_PUBLISHED = 200;
/** Corps au plus par liste DataProvider (au-delà : ignorés, erreur publiée). */
const MAX_LIST = 500;

export type PhysicsState = {
  status: "running" | "paused" | "error";
  running: boolean;
  /** Temps simulé (s), pas, chocs signalés depuis le départ. */
  time: number;
  steps: number;
  collisions: number;
  /** Corps nommés : position (px), angle (°), vitesse (px/s). */
  bodies: Record<string, BodyState>;
  count: number;
  /** Corps tenu à la souris / au doigt. */
  dragging: string | null;
  errors: string[];
};

type StoreLike = { dispatchAction(action: { type: string; payload?: unknown }): void };

const COLORS: Record<BodySpec["type"], string> = { dynamic: "#38bdf8", kinematic: "#f59e0b", static: "#64748b" };

/**
 * Monde physique 2D (planck.js / Box2D) décrit en SDUI.
 *
 * - Corps : enfants `sonic-body` et/ou liste en DataProvider (`bodies="game.bricks"`) ;
 *   joints : enfants `sonic-joint`.
 * - Pilotage : `input` (DP `{ nom: { vx, vy, fx, fy, spin, torque, impulse: {n,x,y}, set: {n,x,y,vx,vy,angle} } }`),
 *   `control` (DP `{ running, reset: compteur, gravity: [x,y], timeScale }`), glisser avec `drag`.
 * - Sorties : `store="game"` reçoit `collide`, `enter`, `leave`, `out`, `tap` ; état `<id>State`
 *   (positions publiées `rate` fois par seconde) ; le canvas sert de source à `sonic-shader channel0="#id"`.
 */
@customElement(tagName)
export class SonicPhysics extends LitElement implements SonicFrameSource, SonicFrameConsumerHost {
  static styles = css`
    :host {
      display: block;
      position: relative;
      line-height: 0;
      touch-action: none;
    }
    :host([hidden-preview]) {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
      overflow: hidden;
    }
    canvas {
      display: block;
      width: 100%;
      height: auto;
    }
  `;

  /** Taille du monde (px). */
  @property({ type: Number }) width = 800;
  @property({ type: Number }) height = 450;
  /** Pixels par mètre (défaut 50 : une balle de 20 px fait 40 cm). */
  @property({ type: Number }) scale = 50;
  /** Gravité en m/s², y vers le bas : "0 9.8" (défaut), "0 0" (vue de dessus). */
  @property({ type: String }) gravity = "0 9.8";
  /** Murs : `walls` (défaut, 4 côtés), `box` (sans sol : la balle peut tomber), `floor`, `none`. */
  @property({ type: String }) bounds: WorldOptions["bounds"] = "walls";
  @property({ type: Boolean }) paused = false;
  /** Vitesse de la simulation (1 = temps réel). */
  @property({ type: Number, attribute: "time-scale" }) timeScale = 1;
  @property({ type: String }) bodies = "";
  @property({ type: String }) input = "";
  @property({ type: String }) control = "";
  @property({ type: String }) store = "";
  @property({ type: String, attribute: "action-prefix" }) actionPrefix = "";
  /** Impulsion minimale (N·s) d'un choc signalé. */
  @property({ type: Number, attribute: "collide-min" }) collideMin = 0;
  /** Glisser les corps dynamiques à la souris / au doigt. */
  @property({ type: Boolean }) drag = false;
  /** Corps publiés dans l'état (noms séparés par des espaces ; défaut : tous). */
  @property({ type: String }) publish = "";
  @property({ type: Number }) rate = 30;
  @property({ type: String }) background = "";
  /** Afficher les joints et les capteurs. */
  @property({ type: Boolean }) debug = false;
  @property({ type: Boolean, attribute: "hidden-preview" }) hiddenPreview = false;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  @query("canvas") private canvas!: HTMLCanvasElement;

  private sim: PhysicsWorld | null = null;
  private childOwned = new Set<string>();
  private listOwned = new Set<string>();
  private listSpecs: BodySpec[] = [];
  private latestInput: Record<string, Drive> | null = null;
  private unsubs: (() => void)[] = [];
  private observer: MutationObserver | null = null;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private lastPublish = 0;
  private seq = 0;
  private consumers = new Set<object>();
  private resetTrigger = new CounterTrigger();
  private running = true;
  private specErrors: string[] = [];
  private pointerId: number | null = null;
  private resyncQueued = false;

  /* --- SonicFrameSource --- */

  get frameSeq(): number {
    return this.seq;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.canvas ?? null;
  }

  registerFrameConsumer(token: object = {}): void {
    this.consumers.add(token);
  }

  unregisterFrameConsumer(token: object = {}): void {
    this.consumers.delete(token);
  }

  /* --- cycle de vie --- */

  connectedCallback(): void {
    super.connectedCallback();
    this.observer = new MutationObserver(() => this.queueResync());
    this.observer.observe(this, { childList: true, subtree: true, attributes: true });
  }

  disconnectedCallback(): void {
    this.observer?.disconnect();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.build();
    this.addEventListener("pointerdown", this.onDown);
    this.addEventListener("pointermove", this.onMove);
    this.addEventListener("pointerup", this.onUp);
    this.addEventListener("pointercancel", this.onUp);
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (!this.sim) return;
    if (["width", "height", "scale"].some((k) => changed.has(k) && changed.get(k) !== undefined)) {
      this.build();
      return;
    }
    if (changed.has("gravity")) this.sim.setGravity(this.parseGravity());
    if (changed.has("bounds") && changed.get("bounds") !== undefined) this.sim.setBounds(this.bounds);
    if (changed.has("collideMin")) this.sim.opts.collideMin = this.collideMin;
    if (changed.has("paused")) this.running = !this.paused;
    if (changed.has("bodies") || changed.has("input") || changed.has("control")) this.listen();
  }

  /* --- API --- */

  getState(): PhysicsState {
    const sim = this.sim;
    const bodies: Record<string, BodyState> = {};
    if (sim) {
      const only = this.publish.trim() ? new Set(this.publish.trim().split(/\s+/)) : null;
      let n = 0;
      for (const name of sim.bodies.keys()) {
        if (only && !only.has(name)) continue;
        if (n++ >= MAX_PUBLISHED) break;
        bodies[name] = sim.bodyState(name)!;
      }
    }
    const errors = [...this.specErrors, ...(sim?.errors ?? [])];
    return {
      status: errors.length && !sim?.bodies.size ? "error" : this.running ? "running" : "paused",
      running: this.running,
      time: sim ? Math.round(sim.time * 1000) / 1000 : 0,
      steps: sim?.steps ?? 0,
      collisions: sim?.collisions ?? 0,
      bodies,
      count: sim?.bodies.size ?? 0,
      dragging: sim?.dragging ?? null,
      errors,
    };
  }

  /** Avance la simulation de `seconds` (tests, rendu image par image). */
  advance(seconds: number): void {
    const n = Math.max(1, Math.round(seconds / STEP));
    for (let i = 0; i < n; i++) this.stepOnce();
    this.draw();
    this.publishState(true);
  }

  /* --- construction --- */

  private parseGravity(): [number, number] {
    const p = String(this.gravity).trim().split(/[\s,]+/).map(Number);
    return p.length >= 2 && p.every(Number.isFinite) ? [p[0], p[1]] : [0, 9.8];
  }

  private build(): void {
    this.sim = new PhysicsWorld({
      width: Math.max(10, this.width),
      height: Math.max(10, this.height),
      scale: Math.max(1, this.scale),
      gravity: this.parseGravity(),
      bounds: this.bounds,
      collideMin: this.collideMin,
      outMargin: 50,
    });
    this.childOwned = new Set();
    this.listOwned = new Set();
    this.resync();
    if (this.listSpecs.length) this.listOwned = this.sim.syncSet(this.listOwned, this.listSpecs);
    this.listen();
    this.running = !this.paused;
    this.sizeCanvas();
    this.draw();
    this.publishState(true);
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private queueResync(): void {
    if (this.resyncQueued) return;
    this.resyncQueued = true;
    queueMicrotask(() => {
      this.resyncQueued = false;
      this.resync();
    });
  }

  /** Corps et joints déclarés en enfants. */
  private resync(): void {
    const sim = this.sim;
    if (!sim) return;
    const errors: string[] = [];
    const bodies: BodySpec[] = [];
    const joints: JointSpec[] = [];
    let i = 0;
    for (const el of this.querySelectorAll("sonic-body")) {
      const attrs = Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
      const { spec, errors: e } = parseBody(attrs, `body${++i}`);
      errors.push(...e);
      bodies.push(spec);
    }
    let j = 0;
    for (const el of this.querySelectorAll("sonic-joint")) {
      const attrs = Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
      const { spec, errors: e } = parseJoint(attrs, j++);
      errors.push(...e);
      if (spec) joints.push(spec);
    }
    const names = new Set<string>();
    for (const b of bodies) {
      if (names.has(b.name)) errors.push(`corps "${b.name}" déclaré deux fois`);
      names.add(b.name);
    }
    this.specErrors = errors;
    sim.errors = [];
    this.childOwned = sim.syncSet(this.childOwned, bodies);
    sim.setJoints(joints);
    this.publishState(true);
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.resetTrigger.reset();
    if (this.bodies) {
      this.unsubs.push(
        listenDp(this.bodies, (v) => {
          const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as object) : [];
          const specs: BodySpec[] = [];
          const errors: string[] = [];
          if (list.length > MAX_LIST) errors.push(`bodies : ${list.length} corps, ${MAX_LIST} au plus (les suivants sont ignorés)`);
          list.slice(0, MAX_LIST).forEach((raw, k) => {
            if (!raw || typeof raw !== "object") return;
            const { spec, errors: e } = parseBody(raw as Record<string, unknown>, `item${k}`);
            errors.push(...e);
            if (this.childOwned.has(spec.name)) errors.push(`"${spec.name}" existe déjà (enfant sonic-body)`);
            else specs.push(spec);
          });
          this.listSpecs = specs;
          if (this.sim) this.listOwned = this.sim.syncSet(this.listOwned, specs);
          if (errors.length) this.specErrors = [...new Set([...this.specErrors, ...errors])];
          this.publishState(true);
        }),
      );
    }
    if (this.input) {
      this.unsubs.push(listenDp(this.input, (v) => (this.latestInput = v && typeof v === "object" ? (v as Record<string, Drive>) : null)));
    }
    if (this.control) {
      this.unsubs.push(
        listenDp(this.control, (v) => {
          if (!v || typeof v !== "object") return;
          const c = plain<Record<string, unknown>>(v);
          if (typeof c.running === "boolean") this.running = c.running;
          if (Array.isArray(c.gravity) && c.gravity.length >= 2) this.sim?.setGravity([Number(c.gravity[0]) || 0, Number(c.gravity[1]) || 0]);
          if (typeof c.timeScale === "number" && Number.isFinite(c.timeScale)) this.timeScale = Math.max(0, Math.min(4, c.timeScale));
          if (this.resetTrigger.feed(c.reset)) this.build();
          this.publishState(true);
        }),
      );
    }
  }

  /* --- boucle --- */

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.running && this.sim) {
      this.acc += dt * Math.max(0, this.timeScale);
      let n = 0;
      while (this.acc >= STEP && n < 5) {
        this.stepOnce();
        this.acc -= STEP;
        n++;
      }
      if (n === 5) this.acc = 0;
    }
    this.draw();
    this.publishState(false);
  };

  private stepOnce(): void {
    const sim = this.sim;
    if (!sim) return;
    sim.drive(this.latestInput);
    const events = sim.step(STEP);
    if (events.length) this.dispatch(events);
  }

  private dispatch(events: PhysicsEvent[]): void {
    if (!this.store) return;
    const store = this.storeEl();
    if (!store) return;
    for (const e of events) {
      const { type, ...payload } = e;
      store.dispatchAction({ type: `${this.actionPrefix}${type}`, payload });
    }
  }

  private storeEl(): (Element & StoreLike) | null {
    const id = this.store.replace(/^#/, "");
    const root = this.getRootNode() as Document | ShadowRoot;
    const el = (root.getElementById?.(id) ?? document.getElementById(id)) as (Element & StoreLike) | null;
    return el && typeof el.dispatchAction === "function" ? el : null;
  }

  /* --- rendu --- */

  private sizeCanvas(): void {
    const c = this.canvas;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(this.width * dpr);
    c.height = Math.round(this.height * dpr);
  }

  private draw(): void {
    const c = this.canvas;
    const sim = this.sim;
    if (!c || !sim) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const k = c.width / this.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (this.background) {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.scale(k, k);
    ctx.lineJoin = "round";
    sim.forEachBody((name, spec, x, y, angle, shapes) => {
      if (spec.hidden || (spec.sensor && !this.debug)) return;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      const fill = spec.fill || (spec.sensor ? "" : COLORS[spec.type]);
      const stroke = spec.stroke || (spec.sensor ? "#a3e635" : "");
      ctx.lineWidth = spec.line;
      if (spec.sensor) ctx.setLineDash([6, 4]);
      for (const s of shapes) {
        ctx.beginPath();
        if (s.kind === "circle") {
          ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
        } else {
          s.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
          if (s.closed) ctx.closePath();
        }
        const open = s.kind === "poly" && !s.closed;
        if (fill && !open) {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        if (stroke || open) {
          ctx.strokeStyle = stroke || fill || COLORS[spec.type];
          ctx.stroke();
        }
        if (s.kind === "circle" && !spec.fixedRotation && this.debug) {
          ctx.beginPath();
          ctx.moveTo(s.cx, s.cy);
          ctx.lineTo(s.cx + s.r, s.cy);
          ctx.strokeStyle = "rgba(0,0,0,.35)";
          ctx.stroke();
        }
      }
      if (spec.label) {
        ctx.rotate(-angle);
        ctx.fillStyle = "#fff";
        ctx.font = "600 13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(spec.label, 0, 0);
      }
      ctx.restore();
      void name;
    });
    if (this.debug || sim.dragging) {
      ctx.strokeStyle = "rgba(255,255,255,.6)";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      for (const [x1, y1, x2, y2] of sim.jointLines()) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
    this.seq++;
  }

  private publishState(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastPublish < 1000 / Math.max(1, Math.min(60, this.rate))) return;
    this.lastPublish = now;
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }

  /* --- pointeur --- */

  private toWorld(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.width, ((e.clientY - r.top) / r.height) * this.height];
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.sim) return;
    const [x, y] = this.toWorld(e);
    const body = this.sim.bodyAt(x, y);
    if (this.store) this.dispatchTap(x, y, body);
    if (this.drag && body && this.sim.startDrag(body, x, y)) {
      this.pointerId = e.pointerId;
      try {
        this.setPointerCapture(e.pointerId);
      } catch {
        /* capture impossible : le glisser reste actif tant que le pointeur est dessus */
      }
      e.preventDefault();
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId || !this.sim) return;
    const [x, y] = this.toWorld(e);
    this.sim.moveDrag(x, y);
  };

  private onUp = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    this.sim?.endDrag();
  };

  private dispatchTap(x: number, y: number, body: string | null): void {
    this.storeEl()?.dispatchAction({ type: `${this.actionPrefix}tap`, payload: { x: Math.round(x), y: Math.round(y), body } });
  }

  render() {
    return html`<canvas part="canvas" role="img" aria-label="simulation physique"></canvas><slot></slot>`;
  }
}

export default SonicPhysics;
