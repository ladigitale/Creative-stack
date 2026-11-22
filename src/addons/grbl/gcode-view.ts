import { css, html, LitElement, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import { applyGestures, gestureMode, wheelToPage } from "../../shared/gestures";
import { clampZoomTo, fitBox, screenToWorld, viewMatrix, worldToScreen, ViewGestures, type View2D } from "../../shared/view2d";
import { dispatch } from "../interactive";
import { cleanLine, num } from "./codec";
import { getMachine, isGcodeSource } from "./machines";

const tagName = "sonic-gcode-view";

type Box = { x: number; y: number; w: number; h: number };

/** Programme lu en segments, en millimètres (Y vers le haut, comme la machine). */
export type ParsedProgram = {
  /** x0, y0, x1, y1 par segment. */
  xy: Float32Array;
  /** Index de couleur (dans `colors`), niveau de puissance 0..3 (ou -1 : déplacement à vide) par segment. */
  color: Uint16Array;
  level: Int8Array;
  /** Ligne du programme préparé (lignes vides et commentaires retirés, comme `sonic-grbl`) de chaque segment. */
  line: Uint32Array;
  count: number;
  colors: string[];
  /** Emprise des segments brûlés (sinon de tous les mouvements). */
  bbox: Box | null;
  lines: number;
};

const WORD = /([GXYSMF])([+-]?(?:\d+\.?\d*|\.\d+))/g;
const MAX_SEGMENTS = 1_500_000;

/** Lit un programme G-code (absolu ou relatif, mm) en segments typés. Pur, testable. */
export function parseProgram(source: string[], maxS = 1000): ParsedProgram {
  let cap = 4096;
  let xy = new Float32Array(cap * 4), color = new Uint16Array(cap), level = new Int8Array(cap), line = new Uint32Array(cap);
  const colors: string[] = ["#141414"];
  let current = 0, count = 0, prepared = 0;
  let x = 0, y = 0, abs = true, motion = 0, s = 0, on = false;
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  let aMinX = Infinity, aMinY = Infinity, aMaxX = -Infinity, aMaxY = -Infinity;
  const grow = (): void => {
    cap *= 2;
    const nxy = new Float32Array(cap * 4); nxy.set(xy); xy = nxy;
    const nc = new Uint16Array(cap); nc.set(color); color = nc;
    const nl = new Int8Array(cap); nl.set(level); level = nl;
    const nn = new Uint32Array(cap); nn.set(line); line = nn;
  };
  for (const raw of source) {
    const text = String(raw);
    if (text.startsWith(";op ")) {
      const c = text.slice(4).trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(c)) {
        const shown = c === "#ffffff" ? "#141414" : c;
        let i = colors.indexOf(shown);
        if (i < 0) i = colors.push(shown) - 1;
        current = i;
      }
      continue;
    }
    const l = cleanLine(text);
    if (!l || l === "%") continue;
    const index = prepared++;
    let nx: number | null = null, ny: number | null = null;
    WORD.lastIndex = 0;
    for (let m = WORD.exec(l); m; m = WORD.exec(l)) {
      const v = Number(m[2]);
      if (m[1] === "G") { if (v >= 0 && v <= 3) motion = v; else if (v === 90) abs = true; else if (v === 91) abs = false; }
      else if (m[1] === "M") { if (v === 3 || v === 4) on = true; else if (v === 5) on = false; }
      else if (m[1] === "S") s = v;
      else if (m[1] === "X") nx = v;
      else if (m[1] === "Y") ny = v;
    }
    if (nx === null && ny === null) continue;
    const tx = nx === null ? x : abs ? nx : x + nx;
    const ty = ny === null ? y : abs ? ny : y + ny;
    if (count < MAX_SEGMENTS && (tx !== x || ty !== y)) {
      if (count >= cap) grow();
      const burn = motion !== 0 && on && s > 0;
      xy[count * 4] = x; xy[count * 4 + 1] = y; xy[count * 4 + 2] = tx; xy[count * 4 + 3] = ty;
      color[count] = current;
      level[count] = burn ? Math.min(3, Math.floor((s / Math.max(1, maxS)) * 4)) : -1;
      line[count] = index;
      count++;
      if (burn) {
        bMinX = Math.min(bMinX, x, tx); bMaxX = Math.max(bMaxX, x, tx);
        bMinY = Math.min(bMinY, y, ty); bMaxY = Math.max(bMaxY, y, ty);
      }
      if (motion !== 0) {
        aMinX = Math.min(aMinX, x, tx); aMaxX = Math.max(aMaxX, x, tx);
        aMinY = Math.min(aMinY, y, ty); aMaxY = Math.max(aMaxY, y, ty);
      }
    }
    x = tx;
    y = ty;
  }
  const bbox = Number.isFinite(bMinX) ? { x: bMinX, y: bMinY, w: bMaxX - bMinX, h: bMaxY - bMinY }
    : Number.isFinite(aMinX) ? { x: aMinX, y: aMinY, w: aMaxX - aMinX, h: aMaxY - aMinY } : null;
  return { xy, color, level, line, count, colors, bbox, lines: prepared };
}

/** Pas de grille « rond » (1, 2, 5 × 10ⁿ mm) d'au moins `minPx` pixels à ce zoom, et sa subdivision. */
export function gridSteps(zoom: number, minPx = 72): { major: number; minor: number } {
  const target = minPx / Math.max(1e-6, zoom);
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  const m = target / p;
  const mant = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  const major = mant * p;
  const minor = major / (mant === 2 ? 4 : 5);
  return { major, minor };
}

export type GcodeViewState = {
  status: "empty" | "ready";
  /** Position du pointeur en mm (repère du travail), `null` hors de la vue. */
  pointer: { x: number; y: number } | null;
  /** Pixels par mm. */
  zoom: number;
  bbox: Box | null;
  segments: number;
  lines: number;
  /** Plateau de la machine dans le repère du travail (origine posée prise en compte), si connu. */
  bed: Box | null;
  seq: number;
};

/**
 * Vue du programme réel (`sonic-gcode`) à zoom libre, avec repère en millimètres : grille, règles cotées,
 * axes et origine du travail, plateau de la machine, emprise cotée, position de la tête et avancement.
 *
 * - `source="#prog"` : un `sonic-gcode` (ou toute source de G-code) ; `machine` (profil, ex. `atomstack-a5-pro`)
 *   ou `bed="410 400"` : plateau en mm ; `state-from` : état d'un `sonic-grbl` (tête, origine posée, tâche en cours).
 * - Gestes : molette ou pincement = zoom sous le pointeur, glisser = déplacer, double-clic = tout voir ;
 *   + − 0 au clavier. Boutons intégrés (zoom, cadrer, plateau) sauf `no-controls`.
 * - `control` (DP) : `{fit: n, bed: n, zoomIn: n, zoomOut: n, upTo: 0..1 (simulation : tracé jusque-là, tête au
 *   point atteint ; 1 ou vide = tout le tracé), travel: bool (déplacements à vide en pointillés), beamMm}`.
 * - `drag-job` + `target` (store) : glisser l'emprise envoie `{type: "place", payload: {dx, dy}}` (mm) au lâcher.
 * - État `out-data-provider` (défaut `<id>State`) : `{status, pointer, zoom, bbox, segments, lines, bed, seq}`.
 */
@customElement(tagName)
export class SonicGcodeView extends LitElement {
  static styles = css`
    :host { display: block; position: relative; height: 320px; overflow: hidden; background: #fbfaf7; color: #1d1b18;
      font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; touch-action: none; user-select: none; -webkit-user-select: none; outline: none; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
    .tools { position: absolute; right: 8px; top: 26px; display: flex; flex-direction: column; gap: 4px; }
    button { all: unset; box-sizing: border-box; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; cursor: pointer;
      background: rgb(255 255 255 / .92); color: #1d1b18; box-shadow: 0 0 0 1px rgb(0 0 0 / .14), 0 1px 3px rgb(0 0 0 / .12); font: 600 15px/1 system-ui, sans-serif; }
    button:focus-visible { box-shadow: 0 0 0 2px #2563eb; }
    button svg { width: 16px; height: 16px; }
    .readout { position: absolute; left: 26px; bottom: 6px; padding: 3px 7px; border-radius: 6px; background: rgb(255 255 255 / .92);
      box-shadow: 0 0 0 1px rgb(0 0 0 / .12); pointer-events: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
    :host([no-controls]) .tools { display: none; }
  `;

  @property({ type: String }) source = "";
  @property({ type: String }) machine = "";
  @property({ type: String }) bed = "";
  @property({ type: String, attribute: "state-from" }) stateFrom = "";
  @property({ type: String }) control = "";
  @property({ type: String }) target = "";
  @property({ type: Boolean, attribute: "drag-job" }) dragJob = false;
  @property({ type: Boolean, attribute: "show-travel" }) showTravel = false;
  /** Largeur réelle du faisceau en mm : visible quand on zoome assez (au moins 1 px à l'écran). */
  @property({ type: Number, attribute: "beam-mm" }) beamMm = 0.1;
  @property({ type: String }) gestures = "auto";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: String, attribute: "aria-label", reflect: true }) ariaLabelText = "Parcours du laser, en millimètres";

  private canvas: HTMLCanvasElement | null = null;
  private readout: HTMLElement | null = null;
  private ro: ResizeObserver | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private view: View2D = { x: 0, y: 0, zoom: 2, rotation: 0 };
  private fitted = false;
  private prog: ParsedProgram | null = null;
  private progSeq = -1;
  private paths: { done: Map<string, Path2D>; rest: Map<string, Path2D>; travel: Path2D | null; cut: number } | null = null;
  private live: { upTo: number | null; travel: boolean | null; beamMm: number | null } = { upTo: null, travel: null, beamMm: null };
  private machineState: { pos: [number, number] | null; wco: [number, number]; area: [number, number] | null; running: boolean; line: number | null } = { pos: null, wco: [0, 0], area: null, running: false, line: null };
  private pointer: { x: number; y: number } | null = null;
  private coop = false;
  private raf = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  private offs: (() => void)[] = [];
  private counters = new Map<string, string>();
  private drag: { id: number; sx: number; sy: number; dx: number; dy: number } | null = null;
  private lastClick = 0;
  private seq = 0;
  private lastOut = "";
  private gestureCtl = new ViewGestures({
    view: () => this.view,
    setView: (v) => {
      this.view = { ...v, rotation: 0 };
      this.schedule();
    },
    size: () => ({ w: this.w, h: this.h }),
    zoomRange: () => [0.05, 400],
    fit: () => this.fit(),
  });

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    if (!this.hasAttribute("role")) this.setAttribute("role", "img");
    this.poll = setInterval(() => this.checkSource(), 250);
  }

  disconnectedCallback(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.ro?.disconnect();
    this.ro = null;
    this.offs.forEach((o) => o());
    this.offs = [];
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.canvas = this.renderRoot.querySelector("canvas");
    this.readout = this.renderRoot.querySelector(".readout");
    const c = this.canvas as HTMLCanvasElement;
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
    }
    this.resize();
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointercancel", this.onUp);
    c.addEventListener("pointerleave", this.onLeave);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    this.addEventListener("keydown", this.onKey);
    this.coop = applyGestures(this, [c], gestureMode(this.gestures));
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("control") || changed.has("stateFrom")) {
      this.offs.forEach((o) => o());
      this.offs = [];
      if (this.control) {
        const read = (v: unknown) => this.readControl(v);
        read(plain(get(this.control)));
        this.offs.push(listenDp(this.control, read));
      }
      if (this.stateFrom) {
        const read = (v: unknown) => this.readMachine(v);
        read(plain(get(this.stateFrom)));
        this.offs.push(listenDp(this.stateFrom, read));
      }
    }
    if (changed.has("source")) {
      this.progSeq = -1;
      this.checkSource();
    }
    if (changed.has("gestures") && this.canvas) this.coop = applyGestures(this, [this.canvas], gestureMode(this.gestures));
    this.schedule();
  }

  // ─── Données ──────────────────────────────────────────────────────────────────────────────────────────────────
  private byId(ref: string): Element | null {
    if (!ref.startsWith("#")) return null;
    const id = ref.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  private checkSource(): void {
    const src = this.byId(this.source);
    if (!isGcodeSource(src)) {
      if (this.prog) {
        this.prog = null;
        this.paths = null;
        this.progSeq = -1;
        this.publishState();
        this.schedule();
      }
      return;
    }
    if (src.gcodeSeq === this.progSeq) return;
    this.progSeq = src.gcodeSeq;
    const lines = src.getGcode();
    this.prog = lines && lines.length ? parseProgram(lines) : null;
    this.paths = null;
    if (this.prog?.bbox && (!this.fitted || !this.visible(this.prog.bbox))) this.fit();
    this.publishState();
    this.schedule();
  }

  private readControl(v: unknown): void {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    for (const k of ["fit", "bed", "zoomIn", "zoomOut"]) {
      const raw = o[k];
      if (raw === undefined || raw === null) continue;
      const key = JSON.stringify(raw);
      const prev = this.counters.get(k);
      this.counters.set(k, key);
      if (prev === undefined || prev === key) continue;
      if (k === "fit") this.fit();
      else if (k === "bed") this.fitBed();
      else this.gestureCtl.zoomBy(k === "zoomIn" ? 1.6 : 1 / 1.6);
    }
    const up = Number(o.upTo);
    this.live = {
      upTo: o.upTo === undefined || o.upTo === null || o.upTo === "" || !Number.isFinite(up) ? null : Math.min(1, Math.max(0, up)),
      travel: typeof o.travel === "boolean" ? o.travel : null,
      beamMm: Number.isFinite(Number(o.beamMm)) && Number(o.beamMm) > 0 ? Number(o.beamMm) : null,
    };
    this.schedule();
  }

  private readMachine(v: unknown): void {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const p = o.pos as { x?: number; y?: number } | undefined;
    const mp = o.mpos as { x?: number; y?: number } | undefined;
    const area = o.area as { x?: number; y?: number } | undefined;
    const job = o.job as { kind?: string; line?: number; running?: boolean } | null | undefined;
    const connected = o.connected === true;
    const pos: [number, number] | null = connected && p && Number.isFinite(p.x) && Number.isFinite(p.y) ? [Number(p.x), Number(p.y)] : null;
    const wco: [number, number] = pos && mp && Number.isFinite(mp.x) && Number.isFinite(mp.y) ? [Number(mp.x) - pos[0], Number(mp.y) - pos[1]] : [0, 0];
    this.machineState = {
      pos,
      wco,
      area: area && Number(area.x) > 0 && Number(area.y) > 0 ? [Number(area.x), Number(area.y)] : null,
      running: !!job?.running,
      line: job && job.kind !== "frame" && Number.isFinite(Number(job.line)) ? Number(job.line) : null,
    };
    this.publishState();
    this.schedule();
  }

  /** Plateau dans le repère du travail : la zone machine décalée de l'origine posée. */
  private bedBox(): Box | null {
    let size: [number, number] | null = null;
    const parts = this.bed.trim().split(/[\s×x,]+/).map(Number);
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n > 0)) size = [parts[0], parts[1]];
    size = size ?? this.machineState.area ?? getMachine(this.machine)?.area ?? null;
    if (!size) return null;
    const [ox, oy] = this.machineState.wco;
    return { x: -ox, y: -oy, w: size[0], h: size[1] };
  }

  private publishState(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out) return;
    const r = (n: number): number => Math.round(n * 100) / 100;
    const b = this.prog?.bbox;
    const bed = this.bedBox();
    const state: GcodeViewState = {
      status: this.prog ? "ready" : "empty",
      pointer: this.pointer ? { x: r(this.pointer.x), y: r(this.pointer.y) } : null,
      zoom: r(this.view.zoom),
      bbox: b ? { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) } : null,
      segments: this.prog?.count ?? 0,
      lines: this.prog?.lines ?? 0,
      bed: bed ? { x: r(bed.x), y: r(bed.y), w: r(bed.w), h: r(bed.h) } : null,
      seq: this.seq,
    };
    const json = JSON.stringify(state);
    if (json === this.lastOut) return;
    this.lastOut = json;
    set(out, state);
  }

  // ─── Vue ──────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Monde de la vue = mm avec Y retourné (écran : Y vers le bas). */
  private toWorld(b: Box): Box {
    return { x: b.x, y: -(b.y + b.h), w: b.w, h: b.h };
  }

  private fitTo(b: Box | null, margin = 0.12): void {
    // Vue masquée (taille nulle) : on cadrera quand elle aura une vraie taille.
    if (!b || this.w < 48 || this.h < 48) return;
    const pad = { ...b, w: Math.max(b.w, 1), h: Math.max(b.h, 1) };
    // Place pour les règles (18 px) en haut et à gauche.
    const v = fitBox(this.toWorld(pad), this.w - 18, this.h - 18, 0, 0.05, 400, margin);
    if (!v) return;
    const [sx, sy] = [(this.w - 18) / 2 + 18, (this.h - 18) / 2 + 18];
    const k = v.zoom;
    this.view = { x: v.x - (sx - this.w / 2) / k, y: v.y - (sy - this.h / 2) / k, zoom: clampZoomTo(k, 0.05, 400), rotation: 0 };
    this.fitted = true;
    this.schedule();
  }

  /** Le travail est-il au moins en partie à l'écran ? (sinon un nouveau programme recadre la vue). */
  private visible(b: Box): boolean {
    if (this.w < 48 || this.h < 48) return true;
    const [x0, yTop] = screenToWorld(this.view, 18, 18, this.w, this.h);
    const [x1, yBot] = screenToWorld(this.view, this.w, this.h, this.w, this.h);
    return b.x + b.w >= x0 && b.x <= x1 && b.y + b.h >= -yBot && b.y <= -yTop;
  }

  fit(): void {
    const b = this.prog?.bbox ?? null;
    if (b) this.fitTo(b);
    else this.fitBed();
  }

  fitBed(): void {
    const bed = this.bedBox();
    const b = this.prog?.bbox;
    if (!bed) return this.fitTo(b ?? null);
    const x0 = Math.min(bed.x, b?.x ?? bed.x, 0), y0 = Math.min(bed.y, b?.y ?? bed.y, 0);
    const x1 = Math.max(bed.x + bed.w, b ? b.x + b.w : 0, 0), y1 = Math.max(bed.y + bed.h, b ? b.y + b.h : 0, 0);
    this.fitTo({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 0.05);
  }

  private resize(): void {
    const r = this.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    // Sortie d'un état masqué : recadrer sur le travail.
    if (this.w < 48 || this.h < 48) this.fitted = false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    if (this.canvas) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    if (!this.fitted) this.fit();
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || typeof requestAnimationFrame === "undefined") return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  // ─── Dessin ───────────────────────────────────────────────────────────────────────────────────────────────────
  /** Segment jusqu'où le tracé est « fait » : tâche en cours (ligne atteinte) ou simulation (`upTo`). */
  private cutIndex(): number | null {
    const p = this.prog;
    if (!p || !p.count) return null;
    if (this.machineState.running && this.machineState.line !== null) {
      const line = this.machineState.line;
      let lo = 0, hi = p.count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (p.line[mid] < line) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }
    // Curseur à fond = pas de simulation (tout le tracé, sans tête).
    if (this.live.upTo !== null && this.live.upTo < 1) return Math.round(this.live.upTo * p.count);
    return null;
  }

  private buildPaths(cut: number | null): void {
    const p = this.prog;
    if (!p || typeof Path2D === "undefined") {
      this.paths = null;
      return;
    }
    const c = cut ?? -1;
    if (this.paths && this.paths.cut === c) return;
    const done = new Map<string, Path2D>(), rest = new Map<string, Path2D>();
    const travel = new Path2D();
    const k = (i: number): string => `${p.colors[p.color[i]]}|${p.level[i]}`;
    for (let i = 0; i < p.count; i++) {
      const o = i * 4;
      if (p.level[i] < 0) {
        travel.moveTo(p.xy[o], -p.xy[o + 1]);
        travel.lineTo(p.xy[o + 2], -p.xy[o + 3]);
        continue;
      }
      const into = c >= 0 && i < c ? done : rest;
      const key = k(i);
      let path = into.get(key);
      if (!path) into.set(key, (path = new Path2D()));
      path.moveTo(p.xy[o], -p.xy[o + 1]);
      path.lineTo(p.xy[o + 2], -p.xy[o + 3]);
    }
    this.paths = { done, rest, travel, cut: c };
  }

  private draw(): void {
    const c = this.canvas;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = c?.getContext("2d") ?? null;
    } catch {
      ctx = null;
    }
    if (!c || !ctx) return;
    const { w, h, dpr } = this;
    const v = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fbfaf7";
    ctx.fillRect(0, 0, w, h);
    const W = (x: number, y: number): [number, number] => worldToScreen(v, x, -y, w, h);

    // Plateau.
    const bed = this.bedBox();
    if (bed) {
      const [x0, y0] = W(bed.x, bed.y + bed.h);
      const [x1, y1] = W(bed.x + bed.w, bed.y);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = "rgb(0 0 0 / .35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
    }

    // Grille.
    const { major, minor } = gridSteps(v.zoom);
    const [wx0, wyTop] = screenToWorld(v, 0, 0, w, h);
    const [wx1, wyBot] = screenToWorld(v, w, h, w, h);
    const mmX0 = wx0, mmX1 = wx1, mmY0 = -wyBot, mmY1 = -wyTop;
    const lines = (step: number, color: string): void => {
      if (step * v.zoom < 5) return;
      ctx.beginPath();
      for (let gx = Math.ceil(mmX0 / step) * step; gx <= mmX1; gx += step) {
        const sx = Math.round(W(gx, 0)[0]) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
      }
      for (let gy = Math.ceil(mmY0 / step) * step; gy <= mmY1; gy += step) {
        const sy = Math.round(W(0, gy)[1]) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    lines(minor, "rgb(0 0 0 / .045)");
    lines(major, "rgb(0 0 0 / .11)");

    // Axes du travail.
    const [ox, oy] = W(0, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgb(225 29 72 / .55)";
    ctx.beginPath(); ctx.moveTo(0, Math.round(oy) + 0.5); ctx.lineTo(w, Math.round(oy) + 0.5); ctx.stroke();
    ctx.strokeStyle = "rgb(22 163 74 / .6)";
    ctx.beginPath(); ctx.moveTo(Math.round(ox) + 0.5, 0); ctx.lineTo(Math.round(ox) + 0.5, h); ctx.stroke();

    // Programme.
    const p = this.prog;
    if (p) {
      const cut = this.cutIndex();
      this.buildPaths(cut);
      const paths = this.paths;
      if (paths) {
        const m = viewMatrix(v, w, h);
        ctx.setTransform(m[0] * dpr, m[1] * dpr, m[2] * dpr, m[3] * dpr, m[4] * dpr, m[5] * dpr);
        const beam = this.live.beamMm ?? this.beamMm;
        const px = 1 / v.zoom;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const travel = this.live.travel ?? this.showTravel;
        if (travel && paths.travel) {
          ctx.setLineDash([4 * px, 4 * px]);
          ctx.lineWidth = px;
          ctx.strokeStyle = "rgb(37 99 235 / .45)";
          ctx.stroke(paths.travel);
          ctx.setLineDash([]);
        }
        ctx.lineWidth = Math.max(px, beam > 0 ? beam : px);
        const stroke = (map: Map<string, Path2D>, dim: boolean): void => {
          for (const [key, path] of map) {
            const [col, lev] = key.split("|");
            ctx.globalAlpha = (0.35 + Number(lev) * 0.21) * (dim ? 0.28 : 1);
            ctx.strokeStyle = col;
            ctx.stroke(path);
          }
        };
        stroke(paths.rest, cut !== null);
        stroke(paths.done, false);
        ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      // Emprise cotée (déplacée pendant un glisser).
      const b = p.bbox;
      if (b) {
        const d = this.drag;
        const bx = b.x + (d?.dx ?? 0), by = b.y + (d?.dy ?? 0);
        const [x0, y0] = W(bx, by + b.h);
        const [x1, y1] = W(bx + b.w, by);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = d ? "rgb(37 99 235 / .9)" : "rgb(29 27 24 / .55)";
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(x1 - x0) + 1, Math.round(y1 - y0) + 1);
        ctx.setLineDash([]);
        ctx.font = "600 11px ui-monospace, Menlo, monospace";
        ctx.fillStyle = "#1d1b18";
        const label = `${num(Math.round(b.w * 10) / 10)} × ${num(Math.round(b.h * 10) / 10)} mm`;
        const tw = ctx.measureText(label).width;
        const lx = Math.min(w - tw - 8, Math.max(22, (x0 + x1) / 2 - tw / 2));
        const ly = y0 - 8 > 30 ? y0 - 8 : y1 + 16;
        ctx.fillStyle = "rgb(255 255 255 / .9)";
        ctx.fillRect(lx - 4, ly - 11, tw + 8, 15);
        ctx.fillStyle = "#1d1b18";
        ctx.fillText(label, lx, ly);
        if (d) {
          const t = `X ${num(Math.round(bx * 10) / 10)}  Y ${num(Math.round(by * 10) / 10)}`;
          ctx.fillStyle = "rgb(37 99 235)";
          ctx.fillText(t, Math.max(22, x0), Math.min(h - 26, y1 + 16));
        }
      }

      // Tête simulée (upTo).
      const sim = this.cutIndex();
      if (sim !== null && !this.machineState.running && sim > 0) {
        const i = Math.min(p.count - 1, sim - 1) * 4;
        this.head(ctx, ...W(p.xy[i + 2], p.xy[i + 3]), "#2563eb");
      }
    }

    // Origine.
    ctx.fillStyle = "#1d1b18";
    ctx.beginPath();
    ctx.arc(ox, oy, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Tête réelle.
    const pos = this.machineState.pos;
    if (pos) this.head(ctx, ...W(pos[0], pos[1]), this.machineState.running ? "#e11d48" : "#c2410c");

    this.rulers(ctx, major, minor, W, mmX0, mmX1, mmY0, mmY1);
    this.updateReadout();
  }

  private head(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.moveTo(x - 12, y); ctx.lineTo(x - 3, y);
    ctx.moveTo(x + 3, y); ctx.lineTo(x + 12, y);
    ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 3);
    ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 12);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  private rulers(ctx: CanvasRenderingContext2D, major: number, minor: number, W: (x: number, y: number) => [number, number], x0: number, x1: number, y0: number, y1: number): void {
    const { w, h } = this;
    const R = 18;
    ctx.fillStyle = "rgb(244 241 234 / .96)";
    ctx.fillRect(0, 0, w, R);
    ctx.fillRect(0, 0, R, h);
    ctx.strokeStyle = "rgb(0 0 0 / .25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, R + 0.5); ctx.lineTo(w, R + 0.5);
    ctx.moveTo(R + 0.5, 0); ctx.lineTo(R + 0.5, h);
    ctx.stroke();
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "#4a463f";
    ctx.textBaseline = "middle";
    const fmt = (n: number): string => num(Math.round(n * 1000) / 1000);
    ctx.beginPath();
    for (let gx = Math.ceil(x0 / minor) * minor; gx <= x1; gx += minor) {
      const sx = Math.round(W(gx, 0)[0]) + 0.5;
      if (sx < R) continue;
      const isMajor = Math.abs(gx / major - Math.round(gx / major)) < 1e-6;
      ctx.moveTo(sx, R);
      ctx.lineTo(sx, R - (isMajor ? 8 : 4));
      if (isMajor) ctx.fillText(fmt(gx), sx + 3, 6);
    }
    for (let gy = Math.ceil(y0 / minor) * minor; gy <= y1; gy += minor) {
      const sy = Math.round(W(0, gy)[1]) + 0.5;
      if (sy < R) continue;
      const isMajor = Math.abs(gy / major - Math.round(gy / major)) < 1e-6;
      ctx.moveTo(R, sy);
      ctx.lineTo(R - (isMajor ? 8 : 4), sy);
      if (isMajor) {
        ctx.save();
        ctx.translate(7, sy - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(fmt(gy), 0, 0);
        ctx.restore();
      }
    }
    ctx.stroke();
    // Repère du pointeur sur les règles.
    if (this.pointer) {
      const [px, py] = W(this.pointer.x, this.pointer.y);
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(px - 0.5, 0, 1.5, R);
      ctx.fillRect(0, py - 0.5, R, 1.5);
    }
    ctx.fillStyle = "rgb(244 241 234)";
    ctx.fillRect(0, 0, R, R);
    ctx.fillStyle = "#4a463f";
    ctx.fillText("mm", 1, 9);
    ctx.textBaseline = "alphabetic";
  }

  private updateReadout(): void {
    const el = this.readout;
    if (!el) return;
    const p = this.pointer;
    const z = this.view.zoom;
    const scale = z >= 1 ? `${num(Math.round(z * 10) / 10)} px/mm` : `1 px = ${num(Math.round((1 / z) * 100) / 100)} mm`;
    el.textContent = p ? `X ${p.x.toFixed(2)}  Y ${p.y.toFixed(2)} mm · ${scale}` : scale;
  }

  // ─── Gestes ───────────────────────────────────────────────────────────────────────────────────────────────────
  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toMm(pt: { x: number; y: number }): { x: number; y: number } {
    const [wx, wy] = screenToWorld(this.view, pt.x, pt.y, this.w, this.h);
    return { x: wx, y: -wy };
  }

  private onJob(pt: { x: number; y: number }): boolean {
    const b = this.prog?.bbox;
    if (!b || !this.dragJob || !this.target) return false;
    const m = this.toMm(pt);
    const tol = 6 / this.view.zoom;
    return m.x >= b.x - tol && m.x <= b.x + b.w + tol && m.y >= b.y - tol && m.y <= b.y + b.h + tol;
  }

  private onDown = (e: PointerEvent): void => {
    const pt = this.local(e);
    this.canvas?.setPointerCapture?.(e.pointerId);
    const now = performance.now();
    if (e.pointerType === "mouse" && now - this.lastClick < 320) {
      this.lastClick = 0;
      this.fit();
      return;
    }
    this.lastClick = now;
    if (this.gestureCtl.count === 0 && e.button === 0 && this.onJob(pt) && !this.machineState.running) {
      this.drag = { id: e.pointerId, sx: pt.x, sy: pt.y, dx: 0, dy: 0 };
      this.gestureCtl.down(e.pointerId, pt, false);
      return;
    }
    const mode = this.gestureCtl.down(e.pointerId, pt, true);
    if (mode === "pinch") this.drag = null;
  };

  private onMove = (e: PointerEvent): void => {
    const pt = this.local(e);
    this.pointer = this.toMm(pt);
    if (this.drag && this.drag.id === e.pointerId && this.gestureCtl.count === 1) {
      const step = this.view.zoom >= 8 ? 0.1 : this.view.zoom >= 2 ? 0.5 : 1;
      this.drag.dx = Math.round((pt.x - this.drag.sx) / this.view.zoom / step) * step;
      this.drag.dy = Math.round(-(pt.y - this.drag.sy) / this.view.zoom / step) * step;
      this.schedule();
      return;
    }
    this.gestureCtl.move(e.pointerId, pt);
    this.schedule();
    this.publishSoon();
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      this.drag = null;
      this.gestureCtl.up(e.pointerId);
      if ((d.dx || d.dy) && this.target) {
        const payload = { dx: Math.round(d.dx * 100) / 100, dy: Math.round(d.dy * 100) / 100 };
        dispatch(this.target, { type: "place", payload });
        this.dispatchEvent(new CustomEvent("place", { detail: payload, bubbles: true, composed: true }));
      }
      this.schedule();
      return;
    }
    this.gestureCtl.up(e.pointerId);
    this.schedule();
  };

  private onLeave = (e: PointerEvent): void => {
    if (e.pointerType !== "mouse") return;
    this.pointer = null;
    this.schedule();
    this.publishSoon();
  };

  private onWheel = (e: WheelEvent): void => {
    if (wheelToPage(this.coop, e)) return;
    e.preventDefault();
    this.gestureCtl.wheel(e, this.local(e));
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "r" || e.key === "R") return;
    if (this.gestureCtl.key(e)) e.preventDefault();
  };

  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private publishSoon(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishState();
    }, 100);
  }

  render() {
    const icon = (d: string) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${d}></path></svg>`;
    return html`<canvas aria-hidden="true"></canvas>
      <div class="tools">
        <button type="button" aria-label="Zoomer" title="Zoomer (+)" @click=${() => this.gestureCtl.zoomBy(1.6)}>${icon("M12 5v14M5 12h14")}</button>
        <button type="button" aria-label="Dézoomer" title="Dézoomer (−)" @click=${() => this.gestureCtl.zoomBy(1 / 1.6)}>${icon("M5 12h14")}</button>
        <button type="button" aria-label="Voir tout le travail" title="Voir le travail (0)" @click=${() => this.fit()}>${icon("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5")}</button>
        <button type="button" aria-label="Voir le plateau" title="Voir tout le plateau" @click=${() => this.fitBed()}>${icon("M3 5h18v14H3zM3 10h18M8 5v14")}</button>
      </div>
      <div class="readout" aria-live="off"></div>`;
  }
}

export default SonicGcodeView;
