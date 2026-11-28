/**
 * Mode course du rendu 3D : relie le moteur de course (`scene/race.ts`) à la vue.
 *
 * - Voitures : les véhicules de la couche `voitures` sont menés par le moteur (leur état de conduite est partagé), la
 *   vue ne fait que les poser (relief, roues, braquage, roulis).
 * - Caméras : poursuite (défaut), poursuite éloignée, capot, vue de dessus ; envolée au-dessus de la grille pendant le
 *   compte à rebours ; champ de vision qui s'ouvre avec la vitesse.
 * - Commandes intégrées : clavier (flèches, ZQSD / WASD, espace = frein à main, R = remise en piste), manette
 *   (gâchettes, stick, A, B), écran tactile (boutons) ; et entrée `input` du DataProvider.
 * - Habillage intégré (désactivable) : position, tour, chronos, vitesse, minicarte, compte à rebours, bandeaux,
 *   classement final. Éléments DOM créés un par un (aucun HTML injecté).
 */
import type { DriveState } from "../scene/drive";
import { type CarInput, NO_CAR_INPUT, RaceSim, type RaceSpec } from "../scene/race";
import { RaceAudio } from "./race-audio";

export interface RaceHost {
  readonly canvas: HTMLCanvasElement;
  /** Prend la main sur une voiture de la scène : rend son état de conduite (partagé avec la vue), ou `null`. */
  car(id: string): DriveState | null;
  /** Rend la main sur toutes les voitures. */
  release(): void;
  /** Ce qui gêne la pose (décor, bord de scène) pour la voiture `id`, ou `null`. */
  blocked(id: string, x: number, z: number, yaw: number): string | null;
  setCamera(c: { cx: number; cy: number; cz: number; yaw: number; pitch: number; dist: number; fov: number }): void;
  emit(type: string, payload: Record<string, unknown>): void;
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const DEG = 180 / Math.PI;
const SVGNS = "http://www.w3.org/2000/svg";

const KEYS: Record<string, string> = {
  ArrowUp: "up", KeyW: "up", KeyZ: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left", KeyQ: "left",
  ArrowRight: "right", KeyD: "right",
  Space: "handbrake", KeyR: "reset", KeyC: "camera",
};

const CAMS: RaceSpec["camera"][] = ["chase", "far", "hood", "top"];
const PAINT_HEX: Record<string, string> = { red: "#e2383f", blue: "#2f6fe0", yellow: "#f2c230", green: "#3fae4a", orange: "#f08a2c", purple: "#8a4fd0", white: "#f4f4f4", black: "#2a2a2a" };

export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return "–:––.–––";
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`;
}
const ordinal = (n: number) => (n === 1 ? "1er" : `${n}e`);

export class RaceDirector {
  readonly sim: RaceSim;
  private host: RaceHost;
  private held = new Set<string>();
  private steerK = 0;
  private touchIn = { left: false, right: false, gas: false, brake: false };
  private ext: Partial<CarInput> = {};
  private extReset = 0;
  private camMode: RaceSpec["camera"];
  private cam = { x: 0, y: 0, z: 0, yaw: 0, fov: 60, init: false };
  private ui: HTMLElement | null = null;
  private els: Record<string, HTMLElement | SVGElement> = {};
  private dots: SVGCircleElement[] = [];
  private map: { x0: number; z0: number; k: number } = { x0: 0, z0: 0, k: 1 };
  private banner = { text: "", t: 0 };
  private hud: boolean;
  readonly audio: RaceAudio | null;
  private lastSummary = "";
  private intro = 0;
  onSummary: (s: Record<string, unknown>) => void = () => {};

  constructor(host: RaceHost, spec: RaceSpec, ids: string[], opts: { hud?: boolean; keyboard?: boolean; touch?: boolean; sound?: boolean } = {}) {
    this.host = host;
    this.sim = new RaceSim(spec, ids);
    // l'état de conduite des voitures de la scène devient celui du moteur
    for (const c of this.sim.cars) {
      const s = host.car(c.id);
      if (!s) continue;
      Object.assign(s, c.s);
      c.s = s;
    }
    this.sim.blocked = (id, x, z, yaw) => host.blocked(id, x, z, yaw);
    this.camMode = spec.camera;
    this.hud = opts.hud !== false;
    this.audio = typeof window !== "undefined" ? new RaceAudio(opts.sound !== false) : null;
    if (opts.keyboard !== false && typeof window !== "undefined") {
      window.addEventListener("keydown", this.onKey);
      window.addEventListener("keyup", this.onKey);
      window.addEventListener("blur", this.onBlur);
    }
    if (typeof document !== "undefined" && host.canvas.parentElement) this.buildUi(host.canvas.parentElement, opts.touch !== false && spec.human);
  }

  dispose() {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("keyup", this.onKey);
      window.removeEventListener("blur", this.onBlur);
    }
    this.ui?.remove();
    this.ui = null;
    this.audio?.dispose();
    this.host.release();
  }

  /** Entrée venue du DataProvider (`race.input`) : `{throttle, steer, brake, handbrake, reset}` (reset = compteur). */
  setInput(v: unknown) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const n = (x: unknown, a: number, b: number) => (Number.isFinite(Number(x)) ? clamp(Number(x), a, b) : 0);
    this.ext = { throttle: n(o.throttle, -1, 1), steer: n(o.steer, -1, 1), brake: n(o.brake, 0, 1), handbrake: !!o.handbrake };
    const r = Number(o.reset);
    if (Number.isFinite(r) && r !== this.extReset) {
      if (this.extReset !== 0 || r > 0) this.resetPlayer();
      this.extReset = r;
    }
  }

  setSound(on: boolean) {
    this.audio?.setEnabled(on);
  }

  setCameraMode(m: RaceSpec["camera"]) {
    this.camMode = m;
  }

  private resetPlayer() {
    const p = this.sim.player;
    if (p && this.sim.phase === "race") this.sim.reset(p);
  }

  private onKey = (e: KeyboardEvent) => {
    const k = KEYS[e.code];
    if (!k) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.type === "keydown") {
      if (k === "reset" && !e.repeat) this.resetPlayer();
      if (k === "camera" && !e.repeat) this.camMode = CAMS[(CAMS.indexOf(this.camMode) + 1) % CAMS.length];
      this.held.add(k);
    } else this.held.delete(k);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  };
  private onBlur = () => this.held.clear();

  private input(dt: number): CarInput {
    const h = this.held;
    let throttle = h.has("up") ? 1 : 0;
    let brake = h.has("down") ? 1 : 0;
    let handbrake = h.has("handbrake");
    // volant au clavier : il revient au centre plus vite qu'il ne braque
    const want = (h.has("right") || this.touchIn.right ? 1 : 0) - (h.has("left") || this.touchIn.left ? 1 : 0);
    const rate = want === 0 || Math.sign(want) !== Math.sign(this.steerK) ? 7 : 3.2;
    this.steerK += clamp(want - this.steerK, -rate * dt, rate * dt);
    let steer = this.steerK;
    if (this.touchIn.gas) throttle = 1;
    if (this.touchIn.brake) brake = 1;
    // manette (disposition standard) : stick gauche, gâchette droite / A accélère, gauche / B freine, X frein à main
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads ?? []) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steer = Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88);
      const val = (i: number) => gp.buttons[i]?.value ?? (gp.buttons[i]?.pressed ? 1 : 0);
      throttle = Math.max(throttle, val(7), gp.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, val(6), gp.buttons[1]?.pressed ? 1 : 0);
      handbrake ||= !!gp.buttons[2]?.pressed;
      if (gp.buttons[3]?.pressed && !this.padReset) this.resetPlayer();
      this.padReset = !!gp.buttons[3]?.pressed;
      break;
    }
    const e = this.ext;
    if (Math.abs(e.steer ?? 0) > 0.05) steer = e.steer!;
    if ((e.throttle ?? 0) > 0.05) throttle = Math.max(throttle, e.throttle!);
    if ((e.throttle ?? 0) < -0.05) brake = Math.max(brake, -e.throttle!);
    brake = Math.max(brake, e.brake ?? 0);
    handbrake ||= !!e.handbrake;
    // frein tenu à l'arrêt (ou presque) : marche arrière
    const p = this.sim.player;
    if (p && brake > 0.5 && throttle < 0.1 && p.s.speed < 1) return { throttle: -brake, steer, brake: 0, handbrake };
    return { throttle, steer, brake, handbrake };
  }
  private padReset = false;

  /* ---------------- pas ---------------- */

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    const sim = this.sim;
    // pas de 20 ms au plus : la conduite reste la même sur un appareil lent (30 images par seconde ou moins)
    const n = Math.max(1, Math.ceil(dt / 0.02));
    const inp = this.input(dt);
    for (let i = 0; i < n; i++) sim.step(dt / n, inp);
    for (const e of sim.events) this.onEvent(e.type, e.payload);
    sim.events.length = 0;
    this.stepCamera(dt);
    this.updateUi(dt);
    const f = sim.focus;
    if (f && this.audio) this.audio.update(f.s.speed, f.tune.maxSpeed, f.input.throttle, f.slip, f.offT > 0);
    const s = sim.summary();
    const key = JSON.stringify({ ...s, time: Math.round(s.time * 10) });
    if (key !== this.lastSummary) {
      this.lastSummary = key;
      this.onSummary(s);
    }
  }

  private onEvent(type: string, p: Record<string, unknown>) {
    const a = this.audio;
    switch (type) {
      case "countdown":
        a?.beep(false);
        break;
      case "start":
        a?.beep(true);
        this.show("Partez !", 1.2);
        break;
      case "lap": {
        if (!p.human) break;
        const lap = Number(p.lap);
        const laps = this.sim.spec.laps;
        if (lap === laps - 1) this.show("Dernier tour !", 1.8);
        else if (p.best && lap > 1) this.show(`Meilleur tour  ${formatTime(Number(p.time))}`, 1.8);
        break;
      }
      case "finish":
        if (p.human) this.show(`Arrivée : ${ordinal(Number(p.position))}`, 3);
        break;
      case "bump":
        if (p.car === this.sim.focus?.id) a?.thud(clamp(Number(p.speed) / 80, 0, 1));
        break;
      case "contact":
        if (p.a === this.sim.focus?.id || p.b === this.sim.focus?.id) a?.thud(clamp(Number(p.speed) / 60, 0, 0.7));
        break;
      case "respawn":
        if (p.car === this.sim.player?.id && p.reason !== "asked") this.show("Remise en piste", 1.2);
        break;
    }
    this.host.emit(type, p);
  }

  private show(text: string, t: number) {
    this.banner = { text, t };
  }

  /* ---------------- caméra ---------------- */

  private stepCamera(dt: number) {
    if (this.camMode === "free") return;
    const f = this.sim.focus;
    if (!f) return;
    const s = f.s;
    const v = Math.abs(s.speed);
    const c = this.cam;
    if (!c.init) Object.assign(c, { x: s.x, y: 0, z: s.z, yaw: s.yaw, init: true });
    // cap de caméra en retard sur la voiture (on voit la voiture tourner), position suivie de près
    const kp = 1 - Math.exp(-dt * 9), ky = 1 - Math.exp(-dt * (this.camMode === "hood" ? 12 : 4.5));
    c.x += (s.x - c.x) * kp;
    c.z += (s.z - c.z) * kp;
    let dy = s.yaw - c.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    c.yaw += dy * ky;
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    const yawDeg = c.yaw * DEG + 180;
    let cam: { cx: number; cy: number; cz: number; yaw: number; pitch: number; dist: number; fov: number };
    const fovRun = clamp(56 + v * 0.42, 56, 76);
    c.fov += (fovRun - c.fov) * (1 - Math.exp(-dt * 2));
    switch (this.camMode) {
      case "far":
        cam = { cx: c.x + fx * 4, cy: 1, cz: c.z + fz * 4, yaw: yawDeg, pitch: 17, dist: 15 + v * 0.08, fov: c.fov - 6 };
        break;
      case "hood":
        cam = { cx: c.x + fx * 14, cy: 0.9, cz: c.z + fz * 14, yaw: yawDeg, pitch: 2.5, dist: 14.2, fov: c.fov + 4 };
        break;
      case "top":
        cam = { cx: c.x + Math.sin(s.yaw) * v * 0.45, cy: 0, cz: c.z + Math.cos(s.yaw) * v * 0.45, yaw: 180, pitch: 70, dist: 58 + v * 0.3, fov: 38 };
        break;
      default:
        cam = { cx: c.x + fx * 3.5, cy: 1, cz: c.z + fz * 3.5, yaw: yawDeg, pitch: 11.5, dist: 8 + v * 0.05, fov: c.fov };
    }
    // compte à rebours : envolée au-dessus de la grille, qui se pose derrière la voiture au départ
    if (this.sim.phase === "countdown") {
      this.intro += dt;
      const k = clamp(1 - this.sim.countdown / 3.6, 0, 1);
      const e = k * k * (3 - 2 * k);
      const orbit = yawDeg + 140 * (1 - e);
      cam = { ...cam, yaw: orbit, pitch: cam.pitch + (34 - cam.pitch) * (1 - e), dist: cam.dist + 34 * (1 - e) };
    }
    this.host.setCamera(cam);
  }

  /* ---------------- habillage ---------------- */

  private buildUi(parent: HTMLElement, touch: boolean) {
    const mk = (tag: string, css: Partial<CSSStyleDeclaration>, text = "") => {
      const e = document.createElement(tag);
      Object.assign(e.style, css);
      if (text) e.textContent = text;
      return e;
    };
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const ui = mk("div", { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", fontFamily: "system-ui, sans-serif", userSelect: "none", color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.55)" });
    ui.setAttribute("data-race-ui", "");
    const show = this.hud ? "block" : "none";
    const pos = mk("div", { position: "absolute", left: "14px", top: "10px", fontWeight: "900", fontStyle: "italic", fontSize: "clamp(26px, 6vw, 44px)", lineHeight: "1", display: show });
    const lap = mk("div", { position: "absolute", left: "16px", top: "clamp(42px, 9vw, 60px)", fontWeight: "700", fontSize: "clamp(12px, 2.6vw, 16px)", display: show });
    const times = mk("div", { position: "absolute", right: "14px", top: "12px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "700", fontSize: "clamp(12px, 2.6vw, 16px)", lineHeight: "1.35", display: show });
    const time = mk("div", {}), best = mk("div", { opacity: ".8", fontSize: "85%" });
    times.append(time, best);
    const speed = mk("div", { position: "absolute", right: "16px", bottom: touch ? "120px" : "14px", textAlign: "right", fontWeight: "900", fontStyle: "italic", fontVariantNumeric: "tabular-nums", fontSize: "clamp(26px, 6vw, 42px)", lineHeight: "1", display: show });
    const kmh = mk("span", { fontSize: "40%", fontStyle: "normal", marginLeft: "4px" }, "km/h");
    const speedN = mk("span", {}, "0");
    speed.append(speedN, kmh);
    const banner = mk("div", { position: "absolute", left: "50%", top: "30%", transform: "translate(-50%, -50%)", fontWeight: "900", fontStyle: "italic", letterSpacing: ".03em", fontSize: "clamp(22px, 6vw, 46px)", whiteSpace: "nowrap", opacity: "0", transition: "opacity .2s", display: show });
    const count = mk("div", { position: "absolute", left: "50%", top: "42%", transform: "translate(-50%, -50%)", fontWeight: "900", fontSize: "clamp(60px, 18vw, 140px)", opacity: "0", display: show });
    const board = mk("div", { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", background: "rgba(10,12,18,.82)", borderRadius: "10px", padding: "14px 18px", minWidth: "min(320px, 80vw)", display: "none", fontVariantNumeric: "tabular-nums", textShadow: "none" });
    ui.append(pos, lap, times, speed, banner, count, board);
    this.els = { pos, lap, time, best, speedN, banner, count, board };
    if (this.hud) this.buildMap(ui);
    if (touch && typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0)) this.buildTouch(ui, mk);
    parent.append(ui);
    this.ui = ui;
  }

  private buildMap(ui: HTMLElement) {
    const t = this.sim.track;
    const [x0, z0, x1, z1] = t.bounds;
    const W = 120, k = W / Math.max(x1 - x0, z1 - z0);
    this.map = { x0, z0, k };
    const svg = document.createElementNS(SVGNS, "svg");
    const h = Math.ceil((z1 - z0) * k) + 8, w = Math.ceil((x1 - x0) * k) + 8;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("viewBox", `-4 -4 ${w} ${h}`);
    Object.assign(svg.style, { position: "absolute", left: "12px", bottom: "12px", opacity: ".9", filter: "drop-shadow(0 1px 3px rgba(0,0,0,.6))" });
    const line = document.createElementNS(SVGNS, "polyline");
    const pts = t.pts.filter((_, i) => i % 3 === 0).map(([x, z]) => `${((x - x0) * k).toFixed(1)},${((z - z0) * k).toFixed(1)}`);
    pts.push(pts[0]);
    line.setAttribute("points", pts.join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "rgba(255,255,255,.85)");
    line.setAttribute("stroke-width", "3");
    line.setAttribute("stroke-linejoin", "round");
    svg.append(line);
    const paints = new Map(this.sim.spec.drivers.map((d) => [d.name, d.paint]));
    for (const c of this.sim.cars) {
      const dot = document.createElementNS(SVGNS, "circle");
      dot.setAttribute("r", c.human ? "4.2" : "3");
      dot.setAttribute("fill", PAINT_HEX[paints.get(c.name) ?? "red"] ?? "#e2383f");
      dot.setAttribute("stroke", c.human ? "#fff" : "#111");
      dot.setAttribute("stroke-width", c.human ? "1.6" : "0.8");
      svg.append(dot);
      this.dots.push(dot);
    }
    ui.append(svg);
  }

  private buildTouch(ui: HTMLElement, mk: (tag: string, css: Partial<CSSStyleDeclaration>, text?: string) => HTMLElement) {
    const btn = (label: string, css: Partial<CSSStyleDeclaration>, key: keyof RaceDirector["touchIn"] | "reset") => {
      const b = mk("div", { position: "absolute", width: "76px", height: "76px", borderRadius: "50%", background: "rgba(0,0,0,.28)", border: "2px solid rgba(255,255,255,.55)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "26px", fontWeight: "900", pointerEvents: "auto", touchAction: "none", ...css }, label);
      const on = (v: boolean) => (e: PointerEvent) => {
        e.preventDefault();
        if (key === "reset") {
          if (v) this.resetPlayer();
          return;
        }
        this.touchIn[key] = v;
        b.style.background = v ? "rgba(255,255,255,.35)" : "rgba(0,0,0,.28)";
      };
      b.addEventListener("pointerdown", on(true));
      b.addEventListener("pointerup", on(false));
      b.addEventListener("pointercancel", on(false));
      b.addEventListener("pointerleave", on(false));
      ui.append(b);
    };
    btn("◀", { left: "16px", bottom: "150px" }, "left");
    btn("▶", { left: "104px", bottom: "150px" }, "right");
    btn("▲", { right: "16px", bottom: "26px", width: "88px", height: "88px" }, "gas");
    btn("▼", { right: "116px", bottom: "26px" }, "brake");
    btn("↺", { right: "16px", top: "70px", width: "44px", height: "44px", fontSize: "20px" }, "reset");
  }

  private updateUi(dt: number) {
    const e = this.els;
    if (!this.ui || !this.hud) return;
    const sim = this.sim, f = sim.focus;
    if (!f) return;
    e.pos.textContent = `${ordinal(f.rank)} / ${sim.cars.length}`;
    e.lap.textContent = sim.phase === "done" || f.finished !== null ? "Arrivée" : `Tour ${Math.min(sim.spec.laps, f.lap + 1)} / ${sim.spec.laps}`;
    const lapT = f.finished !== null ? f.finished : sim.time;
    e.time.textContent = formatTime(lapT);
    e.best.textContent = `Meilleur ${formatTime(f.best)}`;
    e.speedN.textContent = String(Math.round(Math.abs(f.s.speed) * 3.6));
    // compte à rebours
    const cd = e.count as HTMLElement;
    if (sim.phase === "countdown") {
      const n = Math.ceil(sim.countdown);
      cd.textContent = n >= 1 && n <= 3 ? String(n) : "";
      cd.style.opacity = n <= 3 ? "1" : "0";
      cd.style.color = n === 1 ? "#ffd23a" : "#fff";
    } else cd.style.opacity = "0";
    // bandeau
    const b = e.banner as HTMLElement;
    if (this.banner.t > 0) {
      this.banner.t -= dt;
      if (b.textContent !== this.banner.text) b.textContent = this.banner.text;
      b.style.opacity = "1";
    } else b.style.opacity = "0";
    // minicarte
    const m = this.map;
    sim.cars.forEach((c, i) => {
      const d = this.dots[i];
      if (!d) return;
      d.setAttribute("cx", ((c.s.x - m.x0) * m.k).toFixed(1));
      d.setAttribute("cy", ((c.s.z - m.z0) * m.k).toFixed(1));
    });
    // classement final
    const board = e.board as HTMLElement;
    if (sim.phase === "done" && board.style.display === "none") {
      board.style.display = "block";
      const title = document.createElement("div");
      Object.assign(title.style, { fontWeight: "900", fontSize: "18px", marginBottom: "8px" });
      title.textContent = "Classement";
      board.append(title);
      for (const r of sim.results()) {
        const row = document.createElement("div");
        Object.assign(row.style, { display: "flex", gap: "12px", justifyContent: "space-between", padding: "3px 0", fontWeight: r.human ? "800" : "500", color: r.human ? "#ffd23a" : "#fff" });
        const a = document.createElement("span"), n = document.createElement("span"), t = document.createElement("span");
        a.textContent = ordinal(r.position);
        n.textContent = r.name;
        n.style.flex = "1";
        t.textContent = r.time !== null ? formatTime(r.time) : `${r.laps} t.`;
        row.append(a, n, t);
        board.append(row);
      }
    }
  }
}
