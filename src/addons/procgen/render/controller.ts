/**
 * Contrôleur de personnage du rendu 3D : relie `scene/controller.ts` à la vue.
 *
 * - L'acteur `player.actor` devient une marionnette menée image par image (course, saut piloté, chute, marches).
 * - Caméras : profil 2,5D qui suit avec un peu d'avance, troisième personne orbitale (souris glissée, stick droit,
 *   doigt), première personne (souris verrouillée, stick droit, doigt ; le personnage est masqué).
 * - Commandes intégrées : clavier (flèches / ZQSD / WASD, Espace saut, Maj marche, clic ou F tir, E utiliser),
 *   manette, écran tactile (stick virtuel, boutons) ; et entrée `player.input` du DataProvider.
 * - Jeu : ramassage (`collect`), arrivée (`goal`), ennemis qui patrouillent (`enemies` : écrasés en leur sautant
 *   dessus, sinon ils blessent), vies, tir à la première personne (rayon au centre de l'écran).
 * - Habillage (désactivable) : vies, compteur de ramassage, viseur, bandeaux. Éléments DOM créés un par un.
 */
import { type CtrlInput, type CtrlSpec, type CtrlState, type CtrlWorld, ctrlPose, newCtrlState, stepCtrl } from "../scene/controller";

export type Hit = { objectId: string | null; actor: string | null; x: number; y: number; z: number };

export interface CtrlHost {
  readonly canvas: HTMLCanvasElement;
  /** Position et cap de l'acteur (ou `null` s'il n'existe pas). */
  actorPose(id: string): { x: number; y: number; z: number; yaw: number; height: number } | null;
  /** Pose de la marionnette (ou `null` : rendue à la scène). */
  puppet(id: string, p: { x: number; y: number; z: number; yaw: number; speed: number; action: string; actionTime: number; vy: number; land: number } | null): void;
  /** Acteur visible ou masqué (première personne). */
  showActor(id: string, on: boolean): void;
  world: CtrlWorld;
  /** Objets candidats au ramassage : id, calque, générateur, centre. */
  objects(): { id: string; layer: string; generator: string; x: number; y: number; z: number; h: number }[];
  hide(ids: string[]): void;
  /** Rayon depuis la caméra au centre de l'écran. */
  aim(): Hit | null;
  setCamera(c: { cx: number; cy: number; cz: number; yaw: number; pitch: number; dist: number; fov: number }): void;
  emit(type: string, payload: Record<string, unknown>): void;
}

export type CtrlExtra = { hud: boolean; keyboard: boolean; touch: boolean; enemies: string[]; lives: number; patrol: number };

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const DEG = 180 / Math.PI;
const KEYS: Record<string, string> = {
  ArrowUp: "up", KeyW: "up", KeyZ: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left", KeyQ: "left",
  ArrowRight: "right", KeyD: "right",
  Space: "jump", ShiftLeft: "walk", ShiftRight: "walk", KeyF: "fire", KeyE: "use", KeyJ: "lookL", KeyL: "lookR",
};
const round = (x: number) => Math.round(x * 100) / 100;

/** Le motif désigne-t-il l'objet ? Id exact, calque, générateur (ou famille), ou préfixe terminé par `*`. */
export function matches(pattern: string, o: { id: string; layer: string; generator: string }): boolean {
  if (pattern.endsWith("*")) return o.id.startsWith(pattern.slice(0, -1));
  return o.id === pattern || o.layer === pattern || o.generator === pattern || o.generator.split(".")[0] === pattern;
}

type Enemy = { id: string; x0: number; y: number; z: number; x: number; dir: number; dead: boolean; t: number };

export class CtrlDirector {
  readonly spec: CtrlSpec;
  readonly st: CtrlState;
  private host: CtrlHost;
  private extra: CtrlExtra;
  private held = new Set<string>();
  private edge = new Set<string>();
  private ext: Partial<CtrlInput> & { fire?: boolean; use?: boolean; look?: [number, number] } = {};
  private extJump = false;
  private touchIn = { x: 0, z: 0, jump: false, fire: false };
  private look = { yaw: 0, pitch: 12, dyaw: 0, dpitch: 0 };
  private cam = { x: 0, y: 0, z: 0, init: false };
  private fireT = 0;
  private collected = new Set<string>();
  private enemies: Enemy[] = [];
  private lives: number;
  private hurtT = 0;
  private landT = 0;
  private goalDone = false;
  private over = false;
  private ui: HTMLElement | null = null;
  private els: Record<string, HTMLElement> = {};
  private banner = { text: "", t: 0 };
  private flash = 0;
  private lastOut = "";
  private time = 0;
  private dragging: { x: number; y: number; id: number } | null = null;
  onSummary: (s: Record<string, unknown>) => void = () => {};

  constructor(host: CtrlHost, spec: CtrlSpec, extra: CtrlExtra) {
    this.host = host;
    this.spec = spec;
    this.extra = extra;
    this.lives = extra.lives;
    const p = host.actorPose(spec.actor)!;
    // posé sur le dessus le plus haut sous lui (une plateforme de départ, une caisse)
    const g = host.world.ground(p.x, p.z, 1e4, 0);
    this.st = newCtrlState(p.x, g.y, p.z, p.yaw);
    this.st.on = g.on;
    this.look.yaw = (p.yaw * DEG + 180) % 360;
    this.look.pitch = spec.camera === "first" ? 0 : 14;
    for (const id of extra.enemies) {
      const e = host.actorPose(id);
      if (!e) continue;
      const ge = host.world.ground(e.x, e.z, 1e4, 0);
      this.enemies.push({ id, x0: e.x, y: ge.y, z: e.z, x: e.x, dir: 1, dead: false, t: 0 });
    }
    if (typeof window !== "undefined" && extra.keyboard) {
      window.addEventListener("keydown", this.onKey);
      window.addEventListener("keyup", this.onKey);
      window.addEventListener("blur", this.onBlur);
    }
    if (typeof document !== "undefined") {
      host.canvas.addEventListener("pointerdown", this.onDown);
      window.addEventListener("pointermove", this.onMove);
      window.addEventListener("pointerup", this.onUp);
      if (host.canvas.parentElement) this.buildUi(host.canvas.parentElement);
    }
    if (spec.camera === "first") host.showActor(spec.actor, false);
  }

  dispose() {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("keyup", this.onKey);
      window.removeEventListener("blur", this.onBlur);
      window.removeEventListener("pointermove", this.onMove);
      window.removeEventListener("pointerup", this.onUp);
      this.host.canvas.removeEventListener("pointerdown", this.onDown);
      if (document.pointerLockElement === this.host.canvas) document.exitPointerLock?.();
    }
    this.ui?.remove();
    this.ui = null;
    this.host.puppet(this.spec.actor, null);
    this.host.showActor(this.spec.actor, true);
    for (const e of this.enemies) this.host.puppet(e.id, null);
  }

  /** Entrée du DataProvider : `{x, z (-1…1, haut = z négatif), run, jump, fire, use, look: [dyaw, dpitch] (°/s)}`. */
  setInput(v: unknown) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const n = (x: unknown) => (Number.isFinite(Number(x)) ? clamp(Number(x), -1, 1) : 0);
    const jump = !!o.jump;
    if (jump && !this.extJump) this.edge.add("jump");
    this.extJump = jump;
    if (o.fire && !this.ext.fire) this.edge.add("fire");
    if (o.use && !this.ext.use) this.edge.add("use");
    const look = Array.isArray(o.look) ? ([Number(o.look[0]) || 0, Number(o.look[1]) || 0] as [number, number]) : undefined;
    this.ext = { x: n(o.x), z: n(o.z), run: o.run !== false, jump, fire: !!o.fire, use: !!o.use, look };
  }

  private onKey = (e: KeyboardEvent) => {
    const k = KEYS[e.code];
    if (!k) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.type === "keydown") {
      if (!e.repeat) this.edge.add(k);
      this.held.add(k);
    } else this.held.delete(k);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  };
  private onBlur = () => this.held.clear();

  private onDown = (e: PointerEvent) => {
    if (this.spec.camera === "first" && e.pointerType === "mouse") {
      if (document.pointerLockElement !== this.host.canvas) this.host.canvas.requestPointerLock?.();
      else this.edge.add("fire");
      return;
    }
    if (this.spec.camera === "third" || this.spec.camera === "first") this.dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  private onMove = (e: PointerEvent) => {
    const locked = typeof document !== "undefined" && document.pointerLockElement === this.host.canvas;
    if (locked) {
      this.look.yaw -= e.movementX * 0.15;
      this.look.pitch = clamp(this.look.pitch - e.movementY * 0.15, -80, 80);
      return;
    }
    const d = this.dragging;
    if (!d || d.id !== e.pointerId) return;
    this.look.yaw -= (e.clientX - d.x) * 0.3;
    this.look.pitch = clamp(this.look.pitch + (e.clientY - d.y) * (this.spec.camera === "first" ? -0.25 : 0.25), this.spec.camera === "first" ? -80 : -10, 80);
    d.x = e.clientX;
    d.y = e.clientY;
  };
  private onUp = (e: PointerEvent) => {
    if (this.dragging?.id === e.pointerId) this.dragging = null;
  };

  /** Commande du joueur, tournée selon la caméra. */
  private input(dt: number): CtrlInput & { fire: boolean; use: boolean } {
    const h = this.held;
    let x = (h.has("right") ? 1 : 0) - (h.has("left") ? 1 : 0);
    let z = (h.has("down") ? 1 : 0) - (h.has("up") ? 1 : 0);
    let jump = h.has("jump"), run = !h.has("walk");
    let fire = h.has("fire"), use = false;
    let lx = (h.has("lookR") ? 1 : 0) - (h.has("lookL") ? 1 : 0), ly = 0;
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads ?? []) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0, az = gp.axes[1] ?? 0;
      if (Math.hypot(ax, az) > 0.18) [x, z] = [ax, az];
      if (Math.abs(gp.axes[2] ?? 0) > 0.15) lx = gp.axes[2];
      if (Math.abs(gp.axes[3] ?? 0) > 0.15) ly = gp.axes[3];
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      if (b(0) && !this.padJump) this.edge.add("jump");
      this.padJump = b(0);
      jump ||= b(0);
      fire ||= b(7) || b(5);
      if (b(2) && !this.padUse) this.edge.add("use");
      this.padUse = b(2);
      if (b(12)) z = -1;
      if (b(13)) z = 1;
      if (b(14)) x = -1;
      if (b(15)) x = 1;
      break;
    }
    if (Math.hypot(this.touchIn.x, this.touchIn.z) > 0.15) [x, z] = [this.touchIn.x, this.touchIn.z];
    jump ||= this.touchIn.jump;
    fire ||= this.touchIn.fire;
    const e = this.ext;
    if (Math.hypot(e.x ?? 0, e.z ?? 0) > 0.1) [x, z] = [e.x ?? 0, e.z ?? 0];
    jump ||= !!e.jump;
    fire ||= !!e.fire;
    if (e.run === false) run = false;
    if (e.look) ((lx = e.look[0] / 120), (ly = e.look[1] / 120));
    this.look.yaw -= lx * 120 * dt;
    this.look.pitch = clamp(this.look.pitch - ly * 90 * dt * (this.spec.camera === "first" ? 1 : -1), this.spec.camera === "first" ? -80 : -10, 80);
    const jumpEdge = this.edge.has("jump");
    if (this.edge.has("fire")) fire = true;
    use = this.edge.has("use");
    this.edge.clear();
    // déplacement dans le monde : en 2,5D, la droite de l'écran est +x ; sinon relatif à la caméra
    let wx = x, wz = z;
    if (this.spec.camera === "third" || this.spec.camera === "first") {
      const cy = this.look.yaw / DEG;
      const fx = -Math.sin(cy), fz = -Math.cos(cy);
      const rx = Math.cos(cy), rz = -Math.sin(cy);
      wx = rx * x + fx * -z;
      wz = rz * x + fz * -z;
    } else if (this.spec.camera === "side" && this.spec.plane !== "x") {
      // profil en plan libre : haut de l'écran = s'éloigner de la caméra (-z)
      wx = x;
      wz = z;
    }
    return { x: wx, z: wz, run, jump, jumpEdge, fire, use };
  }
  private padJump = false;
  private padUse = false;

  /* ---------------- pas ---------------- */

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const n = Math.max(1, Math.ceil(dt / (1 / 60)));
    const inp = this.input(dt);
    const sp = this.spec, st = this.st;
    if (!this.over)
      for (let i = 0; i < n; i++) {
        const evs = stepCtrl(sp, st, i === 0 ? inp : { ...inp, jumpEdge: false }, dt / n, this.host.world);
        for (const e of evs) {
          if (e.type === "land") this.landT = clamp(Number(e.payload.speed) / 14, 0, 1) * 0.35;
          if (e.type === "fall") this.loseLife("fall");
          this.host.emit(e.type, { actor: sp.actor, ...e.payload });
        }
      }
    this.landT = Math.max(0, this.landT - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    const pose = ctrlPose(st);
    this.host.puppet(sp.actor, { x: st.pos[0], y: st.pos[1], z: st.pos[2], yaw: st.yaw, speed: pose.speed, action: pose.action === "fall" || pose.action === "jump" ? "idle" : pose.action, actionTime: this.time, vy: st.grounded ? 0 : Math.min(st.vel[1], -1.2) - 0.8, land: this.landT });
    this.stepEnemies(dt);
    this.stepCollect();
    if (inp.fire) this.fire();
    if (inp.use) {
      const hit = this.host.aim();
      this.host.emit("use", { actor: sp.actor, objectId: hit?.objectId ?? null, target: hit?.actor ?? null });
    }
    this.fireT = Math.max(0, this.fireT - dt);
    this.stepCamera(dt);
    this.updateUi(dt);
    const out = this.summary();
    const key = JSON.stringify(out);
    if (key !== this.lastOut) {
      this.lastOut = key;
      this.onSummary(out);
    }
  }

  summary() {
    const st = this.st;
    return {
      actor: this.spec.actor,
      x: round(st.pos[0]), y: round(st.pos[1]), z: round(st.pos[2]),
      vx: round(st.vel[0]), vy: round(st.vel[1]), vz: round(st.vel[2]),
      yaw: Math.round(st.yaw * DEG),
      grounded: st.grounded,
      on: st.on,
      action: ctrlPose(st).action,
      collected: this.collected.size,
      lives: this.lives,
      goal: this.goalDone,
      over: this.over,
      look: { yaw: Math.round(this.look.yaw), pitch: Math.round(this.look.pitch) },
    };
  }

  private loseLife(reason: string) {
    if (this.over) return;
    this.lives = Math.max(0, this.lives - 1);
    this.host.emit("hurt", { actor: this.spec.actor, reason, lives: this.lives });
    this.show(this.lives > 0 ? `${"♥".repeat(this.lives)}` : "Perdu !", 1.2);
    if (this.lives <= 0) {
      this.over = true;
      this.host.emit("gameover", { actor: this.spec.actor, collected: this.collected.size });
    }
  }

  private fire() {
    if (!this.spec.fire || this.fireT > 0) return;
    this.fireT = 1 / this.spec.rate;
    this.flash = 0.06;
    const hit = this.host.aim();
    const st = this.st;
    const d = hit ? Math.hypot(hit.x - st.pos[0], hit.y - st.pos[1] - 1.5, hit.z - st.pos[2]) : Infinity;
    const ok = hit && d <= this.spec.range;
    this.host.emit("shot", { actor: this.spec.actor, objectId: ok ? hit!.objectId : null, target: ok ? hit!.actor : null, x: ok ? round(hit!.x) : null, y: ok ? round(hit!.y) : null, z: ok ? round(hit!.z) : null, dist: ok ? round(d) : null });
    if (ok && (hit!.objectId || hit!.actor)) this.els.cross?.style.setProperty("color", "#ff4a3a");
  }

  /** Ennemis : patrouille sur leur plateforme, écrasés si l'on retombe dessus, sinon ils blessent. */
  private stepEnemies(dt: number) {
    const st = this.st, w = this.host.world;
    const R = this.extra.patrol;
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.t += dt;
      // demi-tour au bout de la patrouille, au bord d'un vide ou contre un mur
      const nx = e.x + e.dir * 1.4 * dt;
      const ahead = nx + e.dir * 0.5;
      const g = w.ground(ahead, e.z, e.y, 0.45);
      if (Math.abs(nx - e.x0) > R || Math.abs(g.y - e.y) > 0.3 || w.blocked(ahead, e.z, e.y, 0.45)) e.dir = -e.dir;
      else e.x = nx;
      this.host.puppet(e.id, { x: e.x, y: e.y, z: e.z, yaw: e.dir > 0 ? Math.PI / 2 : -Math.PI / 2, speed: 1.4, action: "walk", actionTime: e.t, vy: 0, land: 0 });
      const dx = st.pos[0] - e.x, dz = st.pos[2] - e.z, dy = st.pos[1] - e.y;
      if (Math.hypot(dx, dz) < 0.75 && dy > -0.6 && dy < 1.2) {
        if (st.vel[1] < -0.5 && dy > 0.25) {
          // écrasé : il disparaît, on rebondit
          e.dead = true;
          this.host.puppet(e.id, null);
          this.host.hide([...this.collected, ...this.enemies.filter((q) => q.dead).map((q) => q.id)]);
          st.vel[1] = Math.sqrt(2 * this.spec.gravity * this.spec.jump * 0.6);
          st.grounded = false;
          this.host.emit("stomp", { actor: this.spec.actor, enemy: e.id });
        } else if (this.hurtT <= 0) {
          this.hurtT = 1.2;
          st.vel[0] = Math.sign(dx || 1) * 6;
          st.vel[1] = 6;
          st.grounded = false;
          this.loseLife("enemy");
        }
      }
    }
  }

  private stepCollect() {
    const sp = this.spec, st = this.st;
    if (!sp.collect.length && !sp.goal) return;
    const cy = st.pos[1] + 0.9;
    let changed = false;
    for (const o of this.host.objects()) {
      if (this.collected.has(o.id)) continue;
      const d = Math.hypot(o.x - st.pos[0], Math.max(0, Math.abs(o.y + o.h / 2 - cy) - 0.6), o.z - st.pos[2]);
      if (sp.goal && !this.goalDone && (o.id === sp.goal || o.layer === sp.goal) && Math.hypot(o.x - st.pos[0], o.z - st.pos[2]) < 1.6) {
        this.goalDone = true;
        this.show("Arrivée !", 3);
        this.host.emit("goal", { actor: sp.actor, target: o.id, collected: this.collected.size, lives: this.lives });
      }
      if (d > sp.reach || !sp.collect.some((p) => matches(p, o))) continue;
      this.collected.add(o.id);
      changed = true;
      this.host.emit("collect", { actor: sp.actor, objectId: o.id, layer: o.layer, count: this.collected.size });
    }
    if (changed) this.host.hide([...this.collected, ...this.enemies.filter((q) => q.dead).map((q) => q.id)]);
  }

  /* ---------------- caméra ---------------- */

  private stepCamera(dt: number) {
    const sp = this.spec, st = this.st;
    if (sp.camera === "free") return;
    const c = this.cam;
    if (!c.init) Object.assign(c, { x: st.pos[0], y: st.pos[1], z: st.pos[2], init: true });
    const k = 1 - Math.exp(-dt * (sp.camera === "first" ? 40 : 7));
    const ky = 1 - Math.exp(-dt * (sp.camera === "first" ? 40 : 3.5));
    const lead = sp.camera === "side" ? clamp(st.vel[0] * 0.35, -2.5, 2.5) : 0;
    c.x += (st.pos[0] + lead - c.x) * k;
    c.z += (st.pos[2] - c.z) * k;
    // en hauteur, la caméra suit le sol où l'on se tient (pas chaque saut), sauf si l'on tombe loin
    const wantY = st.grounded || st.pos[1] < c.y - 1.5 ? st.pos[1] : c.y;
    c.y += (wantY - c.y) * ky;
    if (sp.camera === "side") this.host.setCamera({ cx: c.x, cy: c.y + 1.6, cz: c.z, yaw: 0, pitch: 9, dist: 13, fov: 42 });
    else if (sp.camera === "third") this.host.setCamera({ cx: c.x, cy: c.y + 1.55, cz: c.z, yaw: this.look.yaw, pitch: this.look.pitch, dist: 5.2, fov: 60 });
    else {
      // première personne : la caméra est à l'œil, elle regarde dans la direction (cap, inclinaison)
      const eye = this.host.actorPose(sp.actor)?.height ?? 1.7;
      const yaw = this.look.yaw / DEG, pitch = this.look.pitch / DEG;
      const L = 4;
      const ex = st.pos[0], ey = st.pos[1] + eye * 0.93, ez = st.pos[2];
      const dx = -Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = -Math.cos(yaw) * Math.cos(pitch);
      this.host.setCamera({ cx: ex + dx * L, cy: ey + dy * L, cz: ez + dz * L, yaw: this.look.yaw, pitch: -this.look.pitch, dist: L, fov: 72 });
    }
  }

  /* ---------------- habillage ---------------- */

  private show(text: string, t: number) {
    this.banner = { text, t };
  }

  private buildUi(parent: HTMLElement) {
    const mk = (tag: string, css: Partial<CSSStyleDeclaration>, text = "") => {
      const e = document.createElement(tag);
      Object.assign(e.style, css);
      if (text) e.textContent = text;
      return e;
    };
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const ui = mk("div", { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", fontFamily: "system-ui, sans-serif", userSelect: "none", color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.55)" });
    ui.setAttribute("data-player-ui", "");
    const show = this.extra.hud ? "block" : "none";
    const lives = mk("div", { position: "absolute", left: "14px", top: "10px", fontSize: "clamp(18px, 4vw, 26px)", color: "#ff5a6a", display: show });
    const count = mk("div", { position: "absolute", right: "14px", top: "10px", fontWeight: "800", fontSize: "clamp(16px, 3.6vw, 24px)", display: show && this.spec.collect.length ? "block" : "none" });
    const banner = mk("div", { position: "absolute", left: "50%", top: "32%", transform: "translate(-50%, -50%)", fontWeight: "900", fontStyle: "italic", fontSize: "clamp(22px, 6vw, 46px)", whiteSpace: "nowrap", opacity: "0", transition: "opacity .2s", display: show });
    const cross = mk("div", { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", fontSize: "26px", fontWeight: "300", lineHeight: "1", display: this.spec.camera === "first" && this.spec.fire ? "block" : "none" }, "+");
    const flash = mk("div", { position: "absolute", inset: "0", background: "radial-gradient(circle at 50% 50%, rgba(255,220,140,.35), transparent 40%)", opacity: "0" });
    const hurt = mk("div", { position: "absolute", inset: "0", boxShadow: "inset 0 0 120px rgba(255,0,0,.55)", opacity: "0", transition: "opacity .15s" });
    ui.append(lives, count, banner, cross, flash, hurt);
    this.els = { lives, count, banner, cross, flash, hurt };
    if (this.extra.touch && typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0)) this.buildTouch(ui, mk);
    parent.append(ui);
    this.ui = ui;
  }

  private buildTouch(ui: HTMLElement, mk: (tag: string, css: Partial<CSSStyleDeclaration>, text?: string) => HTMLElement) {
    const zone = mk("div", { position: "absolute", left: "0", bottom: "0", width: "50%", height: "60%", pointerEvents: "auto", touchAction: "none" });
    const base = mk("div", { position: "absolute", width: "110px", height: "110px", marginLeft: "-55px", marginTop: "-55px", borderRadius: "50%", border: "2px solid rgba(255,255,255,.5)", background: "rgba(0,0,0,.15)", display: "none" });
    const knob = mk("div", { position: "absolute", left: "50%", top: "50%", width: "46px", height: "46px", marginLeft: "-23px", marginTop: "-23px", borderRadius: "50%", background: "rgba(255,255,255,.75)" });
    base.append(knob);
    zone.append(base);
    let origin: [number, number] | null = null, pid = -1;
    zone.addEventListener("pointerdown", (e) => {
      pid = e.pointerId;
      zone.setPointerCapture(pid);
      const r = zone.getBoundingClientRect();
      origin = [e.clientX, e.clientY];
      base.style.left = `${e.clientX - r.left}px`;
      base.style.top = `${e.clientY - r.top}px`;
      base.style.display = "block";
    });
    zone.addEventListener("pointermove", (e) => {
      if (!origin || e.pointerId !== pid) return;
      const dx = e.clientX - origin[0], dy = e.clientY - origin[1], d = Math.hypot(dx, dy), k = Math.min(1, d / 50);
      this.touchIn.x = d > 0 ? (dx / d) * k : 0;
      this.touchIn.z = d > 0 ? (dy / d) * k : 0;
      knob.style.transform = `translate(${(this.touchIn.x * 32).toFixed(1)}px, ${(this.touchIn.z * 32).toFixed(1)}px)`;
    });
    const end = () => {
      origin = null;
      this.touchIn.x = this.touchIn.z = 0;
      knob.style.transform = "";
      base.style.display = "none";
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
    ui.append(zone);
    const btn = (label: string, css: Partial<CSSStyleDeclaration>, key: "jump" | "fire") => {
      const b = mk("div", { position: "absolute", width: "78px", height: "78px", borderRadius: "50%", background: "rgba(0,0,0,.28)", border: "2px solid rgba(255,255,255,.55)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: "900", pointerEvents: "auto", touchAction: "none", ...css }, label);
      const on = (v: boolean) => (e: PointerEvent) => {
        e.preventDefault();
        if (v && key === "jump" && !this.touchIn.jump) this.edge.add("jump");
        this.touchIn[key] = v;
        b.style.background = v ? "rgba(255,255,255,.35)" : "rgba(0,0,0,.28)";
      };
      b.addEventListener("pointerdown", on(true));
      b.addEventListener("pointerup", on(false));
      b.addEventListener("pointercancel", on(false));
      b.addEventListener("pointerleave", on(false));
      ui.append(b);
    };
    btn("SAUT", { right: "18px", bottom: "28px", width: "90px", height: "90px" }, "jump");
    if (this.spec.fire) btn("TIR", { right: "120px", bottom: "40px" }, "fire");
  }

  private updateUi(dt: number) {
    const e = this.els;
    if (!this.ui) return;
    e.lives.textContent = "♥".repeat(this.lives);
    e.count.textContent = `● ${this.collected.size}`;
    if (this.banner.t > 0) {
      this.banner.t -= dt;
      if (e.banner.textContent !== this.banner.text) e.banner.textContent = this.banner.text;
      e.banner.style.opacity = "1";
    } else e.banner.style.opacity = "0";
    this.flash = Math.max(0, this.flash - dt);
    e.flash.style.opacity = this.flash > 0 ? "1" : "0";
    if (this.flash <= 0) e.cross.style.removeProperty("color");
    e.hurt.style.opacity = this.hurtT > 0.8 ? "1" : "0";
  }
}
