/**
 * Mode combat du rendu 3D : relie le moteur de combat (`scene/fight.ts`) à la vue.
 *
 * - Les deux combattants (acteurs de l'arène générée, ou deux acteurs de la recette) deviennent des marionnettes
 *   posées sur l'axe qui les relie au départ ; ils se font toujours face.
 * - Caméra latérale qui cadre les deux combattants (`camera: "free"` la laisse à l'artefact).
 * - Commandes : un joueur (flèches ou ZQSD/WASD, J/X poing, K/C pied, L/V garde, haut saut) ou deux sur le même
 *   clavier (joueur 1 : WASD + F G H ; joueur 2 : flèches + K L M), manettes (une par joueur), boutons tactiles,
 *   entrée `fight.input = {p1: {x, jump, guard, light, heavy}, p2: …}`.
 * - Habillage (désactivable) : barres de vie, manches gagnées, chrono, bandeaux (Manche, Combat !, K.O.), combo.
 */
import { holdButton, shieldUi } from "./game-ui";
import { type FightInput, FightSim, type FightSpec, NO_FIGHT_INPUT } from "../scene/fight";

export interface FightHost {
  readonly canvas: HTMLCanvasElement;
  actorPose(id: string): { x: number; y: number; z: number; yaw: number } | null;
  ground(x: number, z: number): number;
  puppet(id: string, p: { x: number; y: number; z: number; yaw: number; speed: number; action: string; actionTime: number; vy: number; land: number } | null): void;
  setCamera(c: { cx: number; cy: number; cz: number; yaw: number; pitch: number; dist: number; fov: number }): void;
  emit(type: string, payload: Record<string, unknown>): void;
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const DEG = 180 / Math.PI;

/** Touches : un seul joueur (toutes dispositions) ou deux joueurs sur le même clavier. */
const SOLO: Record<string, keyof FightInput | "left" | "right" | "down"> = {
  ArrowLeft: "left", KeyA: "left", KeyQ: "left", ArrowRight: "right", KeyD: "right", ArrowUp: "jump", KeyW: "jump", KeyZ: "jump", Space: "jump",
  ArrowDown: "guard", KeyS: "guard", KeyL: "guard", KeyV: "guard", KeyJ: "light", KeyX: "light", KeyK: "heavy", KeyC: "heavy",
};
const DUO: [Record<string, string>, Record<string, string>] = [
  { KeyA: "left", KeyQ: "left", KeyD: "right", KeyW: "jump", KeyZ: "jump", KeyS: "guard", KeyH: "guard", KeyF: "light", KeyG: "heavy" },
  { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "jump", ArrowDown: "guard", Semicolon: "guard", KeyK: "light", KeyL: "heavy" },
];

export class FightDirector {
  readonly sim: FightSim;
  private host: FightHost;
  private ids: [string, string];
  /** Axe du combat : centre et direction (monde). */
  private c: [number, number];
  private d: [number, number];
  private held = new Set<string>();
  private touchIn: FightInput & { left: boolean; right: boolean } = { ...NO_FIGHT_INPUT, left: false, right: false };
  private touchTap: { light?: boolean; heavy?: boolean; jump?: boolean } = {};
  private ext: [Partial<FightInput>, Partial<FightInput>] = [{}, {}];
  private hud: boolean;
  private ui: HTMLElement | null = null;
  private els: Record<string, HTMLElement> = {};
  private banner = { text: "", t: 0 };
  private camDist = 6;
  private lastOut = "";
  private time = 0;
  onSummary: (s: Record<string, unknown>) => void = () => {};

  constructor(host: FightHost, spec: FightSpec, ids: [string, string], opts: { hud?: boolean; keyboard?: boolean; touch?: boolean } = {}) {
    this.host = host;
    this.ids = ids;
    this.sim = new FightSim(spec);
    const a = host.actorPose(ids[0])!, b = host.actorPose(ids[1])!;
    this.c = [(a.x + b.x) / 2, (a.z + b.z) / 2];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    this.d = L > 0.1 ? [dx / L, dz / L] : [1, 0];
    // départ : là où sont les acteurs (au moins 1,2 m d'écart)
    this.sim.f[0].x = -Math.max(0.6, L / 2);
    this.sim.f[1].x = Math.max(0.6, L / 2);
    this.hud = opts.hud !== false;
    if (opts.keyboard !== false && typeof window !== "undefined") {
      window.addEventListener("keydown", this.onKey);
      window.addEventListener("keyup", this.onKey);
      window.addEventListener("blur", this.onBlur);
    }
    if (typeof document !== "undefined" && host.canvas.parentElement) this.buildUi(host.canvas.parentElement, opts.touch !== false && spec.fighters.some((f) => f.human));
  }

  dispose() {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("keyup", this.onKey);
      window.removeEventListener("blur", this.onBlur);
    }
    this.ui?.remove();
    this.ui = null;
    for (const id of this.ids) this.host.puppet(id, null);
  }

  setInput(v: unknown) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const one = (x: unknown): Partial<FightInput> => {
      const q = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      return { x: Number.isFinite(Number(q.x)) ? clamp(Number(q.x), -1, 1) : 0, jump: !!q.jump, guard: !!q.guard, light: !!q.light, heavy: !!q.heavy };
    };
    this.ext = [one(o.p1), one(o.p2)];
  }

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const duo = this.sim.f[0].spec.human && this.sim.f[1].spec.human;
    const known = duo ? DUO[0][e.code] ?? DUO[1][e.code] : SOLO[e.code];
    if (!known) return;
    if (e.type === "keydown") this.held.add(e.code);
    else this.held.delete(e.code);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  };
  private onBlur = () => this.held.clear();

  /** Commandes des joueurs humains (gauche / droite de l'écran → avant / arrière selon le côté). */
  private inputs(): [FightInput, FightInput] {
    const duo = this.sim.f[0].spec.human && this.sim.f[1].spec.human;
    const out: [FightInput, FightInput] = [{ ...NO_FIGHT_INPUT }, { ...NO_FIGHT_INPUT }];
    const humans = this.sim.f.filter((f) => f.spec.human).map((f) => f.i);
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? [...(navigator.getGamepads() ?? [])].filter(Boolean) : [];
    humans.forEach((k, slot) => {
      const map: Record<string, string> = duo ? DUO[slot] : (SOLO as Record<string, string>);
      const has = (what: string) => [...this.held].some((code) => map[code] === what);
      const o = out[k];
      let x = (has("right") ? 1 : 0) - (has("left") ? 1 : 0);
      o.jump = has("jump");
      o.guard = has("guard");
      o.light = has("light");
      o.heavy = has("heavy");
      const gp = pads[slot];
      if (gp) {
        const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
        if (Math.abs(ax) > 0.3) x = Math.sign(ax);
        if (gp.buttons[14]?.pressed) x = -1;
        if (gp.buttons[15]?.pressed) x = 1;
        o.jump ||= ay < -0.6 || !!gp.buttons[12]?.pressed || !!gp.buttons[0]?.pressed;
        o.guard ||= ay > 0.6 || !!gp.buttons[13]?.pressed || !!gp.buttons[4]?.pressed || !!gp.buttons[6]?.pressed;
        o.light ||= !!gp.buttons[2]?.pressed;
        o.heavy ||= !!gp.buttons[3]?.pressed || !!gp.buttons[1]?.pressed;
      }
      if (slot === 0) {
        const t = this.touchIn;
        if (t.left || t.right) x = (t.right ? 1 : 0) - (t.left ? 1 : 0);
        const tap = this.touchTap;
        o.jump ||= t.jump || !!tap.jump;
        o.guard ||= t.guard;
        o.light ||= t.light || !!tap.light;
        o.heavy ||= t.heavy || !!tap.heavy;
        this.touchTap = {};
      }
      // gauche / droite de l'écran : la caméra regarde l'axe de côté, +x de l'axe est à droite
      o.x = x;
    });
    for (const k of [0, 1] as const) {
      const e = this.ext[k];
      if (Math.abs(e.x ?? 0) > 0.1) out[k].x = e.x!;
      out[k].jump ||= !!e.jump;
      out[k].guard ||= !!e.guard;
      out[k].light ||= !!e.light;
      out[k].heavy ||= !!e.heavy;
    }
    return out;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const sim = this.sim;
    const n = Math.max(1, Math.ceil(dt / 0.02));
    const inp = this.inputs();
    for (let i = 0; i < n; i++) sim.step(dt / n, inp);
    for (const e of sim.events) this.onEvent(e.type, e.payload);
    sim.events.length = 0;
    // marionnettes
    const yawTo = (dir: number) => Math.atan2(this.d[0] * dir, this.d[1] * dir);
    for (const f of sim.f) {
      const wx = this.c[0] + this.d[0] * f.x, wz = this.c[1] + this.d[1] * f.x;
      const g = this.host.ground(wx, wz);
      this.host.puppet(this.ids[f.i], { x: wx, z: wz, y: g + f.y, yaw: yawTo(sim.facing(f.i)), speed: Math.abs(f.vx), action: f.action, actionTime: f.actionTime, vy: f.y > 0.02 ? Math.min(f.vy, -1.5) : 0, land: 0 });
    }
    this.stepCamera(dt);
    this.updateUi(dt);
    const s = sim.summary();
    const key = JSON.stringify(s);
    if (key !== this.lastOut) {
      this.lastOut = key;
      this.onSummary(s);
    }
  }

  /** Vitesse du temps voulue (ralenti du K.O.). */
  get timeScale() {
    return this.sim.timeScale;
  }

  private onEvent(type: string, p: Record<string, unknown>) {
    const names = this.sim.f.map((f) => f.spec.name);
    if (type === "round") this.show(this.sim.spec.rounds > 1 ? `Manche ${p.round}` : "Prêts ?", 1.4);
    if (type === "fight") this.show("Combat !", 0.9);
    if (type === "ko") this.show("K.O. !", 2.2);
    if (type === "timeout") this.show(p.winner === null ? "Égalité" : `Temps ! ${names[Number(p.winner)]}`, 2);
    if (type === "matchEnd") this.show(`Victoire de ${names[Number(p.winner)]}`, 99);
    if (type === "hit" && Number(p.combo) >= 3 && !p.blocked) this.show(`${p.combo} coups !`, 0.7);
    if (type !== "attack") this.host.emit(type, { ...p, ...(p.attacker !== undefined ? { attackerId: this.ids[Number(p.attacker)] } : {}), ...(p.defender !== undefined ? { defenderId: this.ids[Number(p.defender)] } : {}) });
  }

  private show(text: string, t: number) {
    this.banner = { text, t };
  }

  private stepCamera(dt: number) {
    if (this.sim.spec.camera === "free") return;
    const [a, b] = this.sim.f;
    const mid = (a.x + b.x) / 2;
    const sep = Math.abs(b.x - a.x);
    const want = Math.max(5.2, sep * 1.3 + 3.2);
    this.camDist += (want - this.camDist) * (1 - Math.exp(-dt * 3));
    const cx = this.c[0] + this.d[0] * mid, cz = this.c[1] + this.d[1] * mid;
    const g = this.host.ground(cx, cz);
    const axis = Math.atan2(this.d[0], this.d[1]) * DEG;
    const ko = this.sim.phase === "ko" ? 0.75 : 1;
    this.host.setCamera({ cx, cy: g + 1.15 + Math.max(a.y, b.y) * 0.4, cz, yaw: axis - 90, pitch: 7, dist: this.camDist * ko, fov: 40 });
  }

  private buildUi(parent: HTMLElement, touch: boolean) {
    const mk = (tag: string, css: Partial<CSSStyleDeclaration>, text = "") => {
      const e = document.createElement(tag);
      Object.assign(e.style, css);
      if (text) e.textContent = text;
      return e;
    };
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const ui = mk("div", { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", fontFamily: "system-ui, sans-serif", userSelect: "none", color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.6)" });
    ui.setAttribute("data-fight-ui", "");
    const show = this.hud ? "flex" : "none";
    const top = mk("div", { position: "absolute", left: "12px", right: "12px", top: "10px", display: show, alignItems: "flex-start", gap: "10px" });
    const side = (i: number) => {
      const box = mk("div", { flex: "1", display: "flex", flexDirection: "column", alignItems: i ? "flex-end" : "flex-start", gap: "4px" });
      const bar = mk("div", { width: "100%", height: "14px", background: "rgba(0,0,0,.45)", border: "2px solid rgba(255,255,255,.85)", borderRadius: "3px", overflow: "hidden", display: "flex", justifyContent: i ? "flex-end" : "flex-start" });
      const fill = mk("div", { height: "100%", width: "100%", background: "linear-gradient(180deg, #ffe066, #f2a20c)", transition: "width .12s" });
      bar.append(fill);
      const row = mk("div", { display: "flex", gap: "6px", alignItems: "center", flexDirection: i ? "row-reverse" : "row", fontWeight: "800", fontSize: "clamp(12px, 2.6vw, 16px)" });
      const name = mk("span", {}, this.sim.f[i].spec.name);
      const wins = mk("span", { color: "#ffd23a", letterSpacing: "2px" });
      row.append(name, wins);
      box.append(bar, row);
      this.els[`fill${i}`] = fill;
      this.els[`wins${i}`] = wins;
      return box;
    };
    const clock = mk("div", { minWidth: "44px", textAlign: "center", fontWeight: "900", fontSize: "clamp(20px, 4.5vw, 30px)", fontVariantNumeric: "tabular-nums", lineHeight: "1" });
    top.append(side(0), clock, side(1));
    const banner = mk("div", { position: "absolute", left: "50%", top: "36%", transform: "translate(-50%, -50%)", fontWeight: "900", fontStyle: "italic", letterSpacing: ".04em", fontSize: "clamp(26px, 8vw, 64px)", whiteSpace: "nowrap", opacity: "0", transition: "opacity .15s", display: this.hud ? "block" : "none" });
    ui.append(top, banner);
    this.els.clock = clock;
    this.els.banner = banner;
    if (touch && typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0)) this.buildTouch(ui, mk);
    shieldUi(ui);
    parent.append(ui);
    this.ui = ui;
  }

  private buildTouch(ui: HTMLElement, mk: (tag: string, css: Partial<CSSStyleDeclaration>, text?: string) => HTMLElement) {
    const btn = (label: string, css: Partial<CSSStyleDeclaration>, key: "left" | "right" | "jump" | "guard" | "light" | "heavy") => {
      const b = mk("div", { position: "absolute", width: "70px", height: "70px", borderRadius: "50%", background: "rgba(0,0,0,.28)", border: "2px solid rgba(255,255,255,.55)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: "900", pointerEvents: "auto", touchAction: "none", ...css }, label);
      const on = (v: boolean) => {
        this.touchIn[key] = v;
        // appui bref (plus court qu'une image) : compté à l'image suivante
        if (v && (key === "light" || key === "heavy" || key === "jump")) this.touchTap[key] = true;
        b.style.background = v ? "rgba(255,255,255,.35)" : "rgba(0,0,0,.28)";
      };
      holdButton(b, on);
      ui.append(b);
    };
    btn("◀", { left: "14px", bottom: "30px" }, "left");
    btn("▶", { left: "96px", bottom: "30px" }, "right");
    btn("▲", { left: "55px", bottom: "108px", width: "58px", height: "58px" }, "jump");
    btn("POING", { right: "92px", bottom: "30px" }, "light");
    btn("PIED", { right: "14px", bottom: "72px" }, "heavy");
    btn("GARDE", { right: "92px", bottom: "110px", width: "60px", height: "60px", fontSize: "11px" }, "guard");
  }

  private updateUi(dt: number) {
    if (!this.ui || !this.hud) return;
    const s = this.sim;
    s.f.forEach((f, i) => {
      this.els[`fill${i}`].style.width = `${clamp((f.hp / f.spec.hp) * 100, 0, 100).toFixed(1)}%`;
      this.els[`wins${i}`].textContent = "●".repeat(f.wins);
    });
    this.els.clock.textContent = s.spec.time > 0 ? String(Math.ceil(s.clock)) : "∞";
    const b = this.els.banner;
    if (this.banner.t > 0) {
      this.banner.t -= dt;
      if (b.textContent !== this.banner.text) b.textContent = this.banner.text;
      b.style.opacity = "1";
    } else b.style.opacity = "0";
  }
}
