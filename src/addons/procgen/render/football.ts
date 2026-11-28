/**
 * Mode football du rendu 3D : relie le moteur de match (`scene/football.ts`) à la vue.
 *
 * - Joueurs : chaque personnage est une marionnette (`puppet`) que la vue pose là où le moteur le place (position, cap,
 *   vitesse qui règle la foulée, geste et son temps) ; le ballon de la scène est mené de l'extérieur (`pin`).
 * - Caméra de jeu : vue de haut fixe (cap constant), qui suit le ballon avec un peu d'avance.
 * - Cinématiques : grosse occasion, arrêt, tacle, poteau (ralenti, caméra au ras du sol), but (caméra sur le buteur
 *   puis ralenti du but rejoué depuis derrière le but), penalty, coup d'envoi, mi-temps, fin.
 * - Commandes intégrées : clavier, manette, écran tactile (stick virtuel et boutons) ; et entrée `input` du DataProvider.
 * - Habillage intégré (désactivable) : tableau d'affichage, bandeaux, barres de cinéma, jauge de tir, anneau sous le
 *   joueur contrôlé. Éléments DOM créés un par un (aucun HTML injecté).
 */
import * as THREE from "three";
import type { V3 } from "../core/math";
import { PITCH_TOP } from "../gen/sport";
import { FootballMatch, type FootballInput, type FootballSpec, NO_INPUT } from "../scene/football";
import { FootballAudio } from "./football-audio";
import { holdButton, shieldUi } from "./game-ui";

export type Puppet = { x: number; z: number; y: number; yaw: number; speed: number; action: string; actionTime: number; /** Vitesse verticale (pose de chute) et atterrissage (s restantes, flexion). */ vy?: number; land?: number };
export type PuppetActor = { puppet?: Puppet | null };

export interface FootballHost {
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  puppets(): Map<string, PuppetActor>;
  pinBall(pos: V3, vel: V3, dt: number): void;
  setCamera(c: { cx: number; cy: number; cz: number; yaw: number; pitch: number; dist: number; fov: number }): void;
  emit(type: string, payload: Record<string, unknown>): void;
}

type Cam = { cx: number; cy: number; cz: number; yaw: number; pitch: number; dist: number; fov: number };
type Cine = { kind: string; t: number; dur: number; slow: number; at: V3; player: string | null; goal?: V3; team?: number };
type Frame = { t: number; p: Float32Array; ball: V3 };

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const DEG = 180 / Math.PI;
const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return a + d * t;
};

const KEYS: Record<string, keyof FootballInput | "up" | "down" | "left" | "right"> = {
  ArrowUp: "up", KeyW: "up", KeyZ: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left", KeyQ: "left",
  ArrowRight: "right", KeyD: "right",
  ShiftLeft: "sprint", ShiftRight: "sprint",
  Space: "shoot", KeyJ: "pass", KeyX: "pass", KeyK: "lob", KeyC: "lob", KeyL: "tackle", KeyV: "tackle", Tab: "switch", KeyE: "switch",
};

export class FootballDirector {
  readonly match: FootballMatch;
  private host: FootballHost;
  private ids: string[];
  /** Caméra de jeu (lissée) et caméra courante. */
  private game: Cam;
  private cam: Cam;
  private cine: Cine | null = null;
  private cineK = 0;
  private replay: { frames: Frame[]; t: number; t0: number; t1: number; cam: Cam } | null = null;
  private rec: Frame[] = [];
  private recT = 0;
  private held = new Set<string>();
  private touchIn = { x: 0, z: 0, shoot: false, pass: false, lob: false };
  private ext: Partial<FootballInput> = {};
  private ui: HTMLElement | null = null;
  private els: Record<string, HTMLElement> = {};
  private ring: THREE.Mesh;
  private banner = { text: "", t: 0 };
  private lastSummary = "";
  private hud: boolean;
  private keyboard: boolean;
  private shootHold = 0;
  private skipHeld = true;
  /** Ambiance sonore générée (null : coupée à la création). */
  readonly audio: FootballAudio | null;
  private spike = 0;
  /** Vitesse du temps de la vue voulue par le mode (ralenti). */
  timeScale = 1;
  onSummary: (s: Record<string, unknown>) => void = () => {};

  constructor(host: FootballHost, spec: FootballSpec, opts: { hud?: boolean; keyboard?: boolean; touch?: boolean; sound?: boolean } = {}) {
    this.host = host;
    this.match = new FootballMatch(spec);
    this.ids = this.match.players.map((p) => p.id);
    this.hud = opts.hud !== false;
    this.audio = typeof window !== "undefined" ? new FootballAudio(opts.sound !== false) : null;
    this.keyboard = opts.keyboard !== false;
    const L = this.match.dim.L;
    this.game = { cx: 0, cy: 0, cz: 0, yaw: 0, pitch: 60, dist: L > 80 ? 33 : L > 50 ? 28 : 22, fov: 34 };
    this.cam = { ...this.game };
    // anneau sous le joueur contrôlé
    const g = new THREE.RingGeometry(0.55, 0.72, 40);
    g.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xfff27a, transparent: true, opacity: 0.85, depthWrite: false }));
    this.ring.renderOrder = 2;
    this.ring.visible = false;
    host.scene.add(this.ring);
    if (this.keyboard && typeof window !== "undefined") {
      window.addEventListener("keydown", this.onKey);
      window.addEventListener("keyup", this.onKey);
      window.addEventListener("blur", this.onBlur);
    }
    if (typeof document !== "undefined" && host.canvas.parentElement) this.buildUi(host.canvas.parentElement, opts.touch !== false && spec.human >= 0);
  }

  dispose() {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("keyup", this.onKey);
      window.removeEventListener("blur", this.onBlur);
    }
    this.host.scene.remove(this.ring);
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.ui?.remove();
    this.ui = null;
    this.audio?.dispose();
    for (const id of this.ids) {
      const a = this.host.puppets().get(id);
      if (a) a.puppet = null;
    }
  }

  /** Entrée venue du DataProvider (`football.input`), ajoutée au clavier, à la manette et au tactile. */
  setInput(v: unknown) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const n = (x: unknown) => (Number.isFinite(Number(x)) ? clamp(Number(x), -1, 1) : 0);
    this.ext = { x: n(o.x), z: n(o.z), sprint: !!o.sprint, pass: !!o.pass, shoot: !!o.shoot, lob: !!o.lob, tackle: !!o.tackle, switch: !!o.switch };
  }

  private onKey = (e: KeyboardEvent) => {
    const k = KEYS[e.code];
    if (!k) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.type === "keydown") this.held.add(k);
    else this.held.delete(k);
    if (e.code.startsWith("Arrow") || e.code === "Space" || e.code === "Tab") e.preventDefault();
  };
  private onBlur = () => this.held.clear();

  private input(): FootballInput {
    const h = this.held;
    let x = (h.has("right") ? 1 : 0) - (h.has("left") ? 1 : 0);
    let z = (h.has("down") ? 1 : 0) - (h.has("up") ? 1 : 0);
    const inp: FootballInput = { ...NO_INPUT, sprint: h.has("sprint"), shoot: h.has("shoot"), pass: h.has("pass"), lob: h.has("lob"), tackle: h.has("tackle"), switch: h.has("switch") };
    // manette (disposition standard) : stick gauche, A passe, B tir, X ballon long, Y changer, gâchette droite sprint
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads ?? []) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0, az = gp.axes[1] ?? 0;
      if (Math.hypot(ax, az) > 0.2) [x, z] = [ax, az];
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      inp.pass ||= b(0);
      inp.shoot ||= b(1);
      inp.lob ||= b(2);
      inp.switch ||= b(3) || b(4);
      inp.sprint ||= b(5) || b(7);
      inp.tackle ||= b(1) && false;
      if (b(12)) z = -1;
      if (b(13)) z = 1;
      if (b(14)) x = -1;
      if (b(15)) x = 1;
      break;
    }
    if (Math.hypot(this.touchIn.x, this.touchIn.z) > 0.15) [x, z] = [this.touchIn.x, this.touchIn.z];
    inp.shoot ||= this.touchIn.shoot;
    inp.pass ||= this.touchIn.pass;
    inp.lob ||= this.touchIn.lob;
    const e = this.ext;
    if (Math.hypot(e.x ?? 0, e.z ?? 0) > 0.15) [x, z] = [e.x ?? 0, e.z ?? 0];
    inp.sprint ||= !!e.sprint;
    inp.shoot ||= !!e.shoot;
    inp.pass ||= !!e.pass;
    inp.lob ||= !!e.lob;
    inp.tackle ||= !!e.tackle;
    inp.switch ||= !!e.switch;
    // la caméra de jeu regarde toujours dans le même sens : haut de l'écran = -z
    inp.x = x;
    inp.z = z;
    return inp;
  }

  /* ---------------- pas ---------------- */

  /** Une image : `dt` en secondes réelles. Rend la vitesse du temps voulue pour l'animation des personnages. */
  step(dt: number) {
    dt = Math.min(dt, 0.05);
    const m = this.match;
    if (this.replay) return this.stepReplay(dt);
    // ralenti des cinématiques
    const c = this.cine;
    let slow = 1;
    if (c) {
      c.t += dt;
      if (c.slow < 1) {
        const k = Math.min(ease(c.t / 0.15), 1 - ease((c.t - c.dur + 0.3) / 0.3));
        slow = 1 + (c.slow - 1) * clamp(k, 0, 1);
      }
    }
    this.timeScale = slow;
    const inp = this.input();
    this.shootHold = inp.shoot ? this.shootHold + dt * slow : 0;
    m.step(dt * slow, inp);
    for (const e of m.events) this.onMatchEvent(e.type, e.payload);
    m.events.length = 0;
    this.applyPuppets();
    this.record(dt * slow);
    this.stepCine(dt);
    this.stepCamera(dt);
    this.updateUi(dt);
    this.stepAudio(dt, slow < 0.8);
  }

  /** Tension du jeu pour la foule : ballon près d'un but, occasions récentes, but. */
  private stepAudio(dt: number, slow: boolean) {
    if (!this.audio) return;
    const m = this.match;
    this.spike = Math.max(0, this.spike - dt * 0.35);
    const d = m.dim.L / 2 - Math.abs(m.ball.p[0]);
    const near = Math.max(0, 1 - d / (m.dim.L * 0.3));
    const e = m.phase === "goal" ? 1 : m.phase === "play" || m.phase === "setpiece" ? Math.min(1, 0.22 + 0.45 * near * near + this.spike) : 0.2;
    this.audio.update(dt, e, slow || !!this.replay, m.phase === "play" && e < 0.35);
  }

  /** Sons des événements du match. */
  private sound(type: string, p: Record<string, unknown>) {
    const a = this.audio;
    if (!a) return;
    switch (type) {
      case "kick":
        if (p.kind !== "throw") a.kick(Number(p.speed) || 8);
        if (p.kind === "shot") this.spike = Math.max(this.spike, 0.5);
        break;
      case "header":
        a.kick(11);
        break;
      case "bounce":
        a.bounce(Number(p.speed) || 3);
        break;
      case "save":
        a.ooh(1);
        a.applause(2.2, 0.25);
        this.spike = 0.6;
        break;
      case "post":
        a.post();
        a.ooh(1.1);
        this.spike = 0.7;
        break;
      case "miss":
        a.ooh(0.7);
        break;
      case "goal":
        a.net();
        a.roar();
        break;
      case "foul":
        a.whistle([0.28]);
        a.thud(0.45);
        a.boo();
        break;
      case "penalty":
        a.whistle([0.6]);
        break;
      case "tackle":
        if (p.slide) a.thud(0.4);
        break;
      case "kickoff":
        a.whistle([0.5]);
        break;
      case "halftime":
        a.whistle([0.45, 0.45]);
        a.applause(3, 0.3);
        break;
      case "fulltime":
        a.whistle([0.45, 0.45, 1.1]);
        a.applause(5, 0.4);
        break;
    }
  }

  /** Coupe ou remet le son sans relancer le match. */
  setSound(on: boolean) {
    this.audio?.setEnabled(on);
  }

  private applyPuppets() {
    const m = this.match;
    const map = this.host.puppets();
    for (const p of m.players) {
      const a = map.get(p.id);
      if (!a) continue;
      a.puppet = { x: p.pos[0], z: p.pos[1], y: PITCH_TOP + (p.lift ?? 0), yaw: p.yaw, speed: Math.hypot(p.vel[0], p.vel[1]), action: p.action, actionTime: p.actionTime };
    }
    const b = m.ball;
    this.host.pinBall([b.p[0], b.p[1] + PITCH_TOP, b.p[2]], [b.v[0], b.v[1], b.v[2]], 1 / 60);
  }

  /** Enregistrement des 7 dernières secondes de jeu (ralenti du but). */
  private record(dt: number) {
    if (this.match.phase !== "play" && this.match.phase !== "setpiece") return;
    this.recT += dt;
    const m = this.match;
    const p = new Float32Array(m.players.length * 7);
    m.players.forEach((q, i) => {
      p.set([q.pos[0], q.pos[1], q.yaw, Math.hypot(q.vel[0], q.vel[1]), ACTION_CODES.indexOf(q.action), q.actionTime, q.lift ?? 0], i * 7);
    });
    this.rec.push({ t: this.recT, p, ball: [m.ball.p[0], m.ball.p[1], m.ball.p[2]] });
    while (this.rec.length && this.rec[0].t < this.recT - 7) this.rec.shift();
  }

  private onMatchEvent(type: string, payload: Record<string, unknown>) {
    const m = this.match;
    this.sound(type, payload);
    if (type === "bounce") return;
    if (type === "cine") {
      if (!m.spec.cinematics && payload.kind !== "intro") return;
      const kind = String(payload.kind);
      // une cinématique plus forte remplace la courante (but > arrêt > tir > tacle)
      const rank: Record<string, number> = { goal: 5, fulltime: 6, halftime: 4, penalty: 4, save: 3, post: 3, shot: 2, tackle: 1, intro: 1 };
      if (this.cine && (rank[this.cine.kind] ?? 0) > (rank[kind] ?? 0) && this.cine.t < this.cine.dur) return;
      const at = (Array.isArray(payload.at) ? payload.at : [m.ball.p[0], 0, m.ball.p[2]]) as V3;
      this.cine = { kind, t: 0, dur: Number(payload.dur) || 1, slow: Number(payload.slow) || 1, at, player: (payload.player as string) ?? null, goal: payload.goal as V3 | undefined, team: payload.team as number | undefined };
      if (kind === "goal") {
        const t = m.spec.teams[Number(payload.team)];
        this.showBanner(`BUT ! ${t?.name ?? ""}`, 3.2);
      }
      if (kind === "save") this.showBanner("QUEL ARRÊT !", 1.6);
      if (kind === "post") this.showBanner("POTEAU !", 1.4);
      if (kind === "penalty") this.showBanner("PENALTY !", 2.2);
      if (kind === "halftime") this.showBanner("MI-TEMPS", 3);
      if (kind === "fulltime") this.showBanner(m.score[0] === m.score[1] ? "MATCH NUL" : `VICTOIRE ${m.spec.teams[m.score[0] > m.score[1] ? 0 : 1].name.toUpperCase()}`, 6);
      if (kind === "intro") this.showBanner(`${m.spec.teams[0].name}  –  ${m.spec.teams[1].name}`, 3);
      return;
    }
    if (type === "foul") this.showBanner("FAUTE !", 1.2);
    if (type === "corner") this.showBanner("CORNER", 1.2);
    if (type === "kickoff" && payload.half === 2) this.showBanner("2E MI-TEMPS", 2);
    this.host.emit(type, payload);
  }

  /* ---------------- cinématiques ---------------- */

  private stepCine(dt: number) {
    const c = this.cine;
    if (!c) return void (this.cineK = Math.max(0, this.cineK - dt * 2.2));
    const m = this.match;
    // but : après 3 s sur le buteur, ralenti rejoué depuis derrière le but
    if (c.kind === "goal" && c.t > 3 && !this.replay && this.rec.length > 10) {
      const t1 = this.rec[this.rec.length - 1].t;
      const g = c.at;
      const side = Math.sign(g[0]) || 1;
      this.replay = { frames: this.rec.slice(), t: Math.max(this.rec[0].t, t1 - 4.2), t0: Math.max(this.rec[0].t, t1 - 4.2), t1, cam: { cx: g[0] - side * 10, cy: 0.8, cz: g[2] * 0.4, yaw: side > 0 ? 90 : -90, pitch: 16, dist: 22, fov: 30 } };
      this.showBanner("RALENTI", 4.6, true);
      return;
    }
    if (c.t > c.dur && !(c.kind === "penalty" && m.phase === "setpiece")) {
      this.cine = null;
      return;
    }
    this.cineK = Math.min(1, this.cineK + dt * 3);
  }

  private stepReplay(dt: number) {
    const r = this.replay!;
    // une touche d'action passe le ralenti
    const inp = this.input();
    const any = inp.pass || inp.shoot || inp.lob;
    if (any && !this.skipHeld && r.t > r.t0 + 0.6) r.t = r.t1 + 1;
    this.skipHeld = any;
    r.t += dt * 0.45;
    this.timeScale = 0.45;
    const fr = r.frames;
    let i = 0;
    while (i < fr.length - 1 && fr[i + 1].t < r.t) i++;
    const f = fr[i];
    const map = this.host.puppets();
    this.match.players.forEach((q, k) => {
      const a = map.get(q.id);
      if (!a) return;
      const o = k * 7;
      a.puppet = { x: f.p[o], z: f.p[o + 1], y: PITCH_TOP + f.p[o + 6], yaw: f.p[o + 2], speed: f.p[o + 3], action: ACTION_CODES[f.p[o + 4]] ?? "idle", actionTime: f.p[o + 5] };
    });
    this.host.pinBall([f.ball[0], f.ball[1] + PITCH_TOP, f.ball[2]], [0, 0, 0], dt);
    // caméra : derrière le but, suit le ballon, se rapproche à la fin
    const k = ease((r.t - r.t0) / (r.t1 - r.t0));
    const want: Cam = { ...r.cam, cx: f.ball[0] * 0.6 + r.cam.cx * 0.4, cz: f.ball[2] * 0.7, dist: r.cam.dist - 8 * k };
    this.cam = blendCam(this.cam, want, 1 - Math.exp(-dt * 5));
    this.host.setCamera(this.cam);
    this.cineK = 1;
    this.updateUi(dt);
    if (r.t >= r.t1 + 0.4) {
      this.replay = null;
      this.cine = null;
      this.match.endGoal();
      this.rec = [];
      this.showBanner("", 0);
    }
  }

  /* ---------------- caméra ---------------- */

  private stepCamera(dt: number) {
    const m = this.match;
    const b = m.ball;
    const { L, W } = m.dim;
    // jeu : le ballon un peu en avance sur sa course, bornée au terrain ; plus large pendant un coup de pied arrêté
    const lead = 0.45;
    const tx = clamp(b.p[0] + b.v[0] * lead, -L / 2 - 2, L / 2 + 2), tz = clamp(b.p[2] + b.v[2] * lead * 0.6 + 2, -W / 2 + 4, W / 2 - 2);
    const k = 1 - Math.exp(-dt * 3.2);
    this.game.cx += (tx - this.game.cx) * k;
    this.game.cz += (tz - this.game.cz) * k;
    let want: Cam = this.game;
    const c = this.cine;
    if (m.phase === "intro" || (c && c.kind === "intro")) {
      const t = clamp(m.phaseT / 3.5, 0, 1);
      want = { cx: 0, cy: 0, cz: 0, yaw: -50 + 50 * ease(t), pitch: 22 + 36 * ease(t), dist: (L + W) * 0.75 - (L + W) * 0.3 * ease(t), fov: 34 };
      this.cam = blendCam(this.cam, want, t > 0.98 ? 1 : 1 - Math.exp(-dt * 4));
      this.cam = t > 0.98 ? { ...this.game } : this.cam;
      return this.host.setCamera(this.cam);
    }
    if (c && this.cineK > 0) {
      const pl = c.player ? m.players.find((p) => p.id === c.player) : null;
      let cc: Cam = this.game;
      switch (c.kind) {
        case "shot": {
          // derrière le tireur, au ras du sol, vers le but
          const g = c.goal ?? [Math.sign(b.p[0]) * (L / 2), 1, 0];
          const yaw = Math.atan2(c.at[0] - g[0], c.at[2] - g[2]) * DEG;
          cc = { cx: (b.p[0] + g[0]) / 2, cy: 0.8, cz: (b.p[2] + g[2]) / 2, yaw, pitch: 14, dist: 15, fov: 32 };
          break;
        }
        case "save":
        case "post": {
          const side = Math.sign(c.at[0]) || 1;
          cc = { cx: c.at[0] - side * 1.5, cy: 0.9, cz: c.at[2], yaw: side > 0 ? -70 : 70, pitch: 10, dist: 9, fov: 34 };
          break;
        }
        case "tackle":
          cc = { cx: c.at[0], cy: 0.5, cz: c.at[2], yaw: 35, pitch: 18, dist: 9, fov: 32 };
          break;
        case "penalty": {
          const side = Math.sign(c.at[0]) || 1;
          cc = { cx: c.at[0] + side * 4, cy: 1, cz: c.at[2], yaw: side > 0 ? -90 : 90, pitch: 9, dist: 13, fov: 30 };
          break;
        }
        case "goal": {
          // le buteur qui célèbre, caméra qui tourne lentement autour de lui
          const p = pl ?? m.players[m.ball.last] ?? null;
          const at = p ? [p.pos[0], p.pos[1]] : [c.at[0], c.at[2]];
          cc = { cx: at[0], cy: 1.1, cz: at[1], yaw: 160 + c.t * 25 * (Math.sign(c.at[0]) || 1), pitch: 12, dist: 7.5, fov: 34 };
          break;
        }
        case "halftime":
        case "fulltime":
          cc = { cx: 0, cy: 0, cz: 0, yaw: c.t * 12, pitch: 28, dist: (L + W) * 0.6, fov: 34 };
          break;
      }
      want = blendCam(this.game, cc, ease(this.cineK));
    }
    this.cam = blendCam(this.cam, want, 1 - Math.exp(-dt * (c ? 6 : 10)));
    this.host.setCamera(this.cam);
  }

  /* ---------------- habillage ---------------- */

  private showBanner(text: string, t: number, small = false) {
    this.banner = { text, t };
    const el = this.els.banner;
    if (!el) return;
    el.textContent = text;
    el.style.fontSize = small ? "clamp(14px, 3vw, 22px)" : "clamp(26px, 7vw, 64px)";
    el.style.top = small ? "14%" : "38%";
    el.style.opacity = text ? "1" : "0";
    el.style.transform = text ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.8)";
  }

  private buildUi(parent: HTMLElement, touch: boolean) {
    const mk = (tag: string, css: Partial<CSSStyleDeclaration>, text = "") => {
      const e = document.createElement(tag);
      Object.assign(e.style, css);
      if (text) e.textContent = text;
      return e;
    };
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const ui = mk("div", { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", fontFamily: "system-ui, sans-serif", userSelect: "none" });
    ui.setAttribute("data-football-ui", "");
    const bars = ["top", "bottom"].map((side) => mk("div", { position: "absolute", left: "0", right: "0", [side]: "0", height: "0", background: "#000", transition: "height .35s ease" } as Partial<CSSStyleDeclaration>));
    const score = mk("div", { position: "absolute", left: "12px", top: "12px", display: this.hud ? "flex" : "none", alignItems: "stretch", borderRadius: "6px", overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,.35)", fontWeight: "700", fontSize: "clamp(11px, 2.4vw, 15px)", letterSpacing: ".02em" });
    const teams = this.match.spec.teams;
    const tA = mk("div", { background: teams[0].shirt, color: textOn(teams[0].shirt), padding: "5px 9px" }, short(teams[0].name));
    const sc = mk("div", { background: "#111", color: "#fff", padding: "5px 10px", fontVariantNumeric: "tabular-nums" }, "0 – 0");
    const tB = mk("div", { background: teams[1].shirt, color: textOn(teams[1].shirt), padding: "5px 9px" }, short(teams[1].name));
    const clock = mk("div", { background: "#f4f4f4", color: "#111", padding: "5px 8px", fontVariantNumeric: "tabular-nums" }, "0'");
    score.append(tA, sc, tB, clock);
    const banner = mk("div", { position: "absolute", left: "50%", top: "38%", transform: "translate(-50%, -50%)", color: "#fff", fontWeight: "900", fontStyle: "italic", letterSpacing: ".04em", textShadow: "0 3px 0 rgba(0,0,0,.45), 0 0 24px rgba(0,0,0,.5)", whiteSpace: "nowrap", opacity: "0", transition: "opacity .2s, transform .25s", display: this.hud ? "block" : "none" });
    const power = mk("div", { position: "absolute", left: "50%", bottom: "18px", width: "min(220px, 40vw)", height: "8px", transform: "translateX(-50%)", background: "rgba(0,0,0,.4)", borderRadius: "4px", overflow: "hidden", opacity: "0", transition: "opacity .15s" });
    const fill = mk("div", { height: "100%", width: "0%", background: "linear-gradient(90deg, #7de07a, #f2d230, #e8452c)" });
    power.append(fill);
    ui.append(...bars, score, banner, power);
    this.els = { top: bars[0], bottom: bars[1], score: sc, clock, banner, power, fill };
    if (touch && typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0)) this.buildTouch(ui, mk);
    shieldUi(ui);
    parent.append(ui);
    this.ui = ui;
  }

  private buildTouch(ui: HTMLElement, mk: (tag: string, css: Partial<CSSStyleDeclaration>, text?: string) => HTMLElement) {
    // stick virtuel : moitié gauche de l'écran, il apparaît sous le pouce
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
    zone.addEventListener("lostpointercapture", end);
    const btn = (label: string, key: "shoot" | "pass" | "lob", right: string, bottom: string, size: number, color: string) => {
      const b = mk("div", { position: "absolute", right, bottom, width: `${size}px`, height: `${size}px`, borderRadius: "50%", background: color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "800", fontSize: "13px", pointerEvents: "auto", touchAction: "none", boxShadow: "0 2px 6px rgba(0,0,0,.35)", opacity: ".85" }, label);
      holdButton(b, (down) => {
        this.touchIn[key] = down;
        b.style.opacity = down ? "1" : ".85";
      });
      ui.append(b);
    };
    btn("TIR", "shoot", "18px", "26px", 74, "rgba(214,48,40,.85)");
    btn("PASSE", "pass", "104px", "20px", 60, "rgba(30,90,200,.85)");
    btn("LONG", "lob", "40px", "112px", 56, "rgba(40,150,70,.85)");
    ui.append(zone);
  }

  private updateUi(dt: number) {
    const m = this.match;
    // anneau sous le joueur contrôlé
    const ctrl = m.ctrl >= 0 && !this.replay && m.phase !== "goal" && m.phase !== "intro" ? m.players[m.ctrl] : null;
    this.ring.visible = !!ctrl;
    if (ctrl) this.ring.position.set(ctrl.pos[0], PITCH_TOP + 0.02, ctrl.pos[1]);
    if (this.banner.t > 0) {
      this.banner.t -= dt;
      if (this.banner.t <= 0) this.showBanner("", 0);
    }
    const e = this.els;
    if (e.top) {
      const h = this.cineK > 0.05 || this.replay ? "9%" : "0";
      e.top.style.height = h;
      e.bottom.style.height = h;
      e.score.textContent = `${m.score[0]} – ${m.score[1]}`;
      e.clock.textContent = m.phase === "fulltime" ? "FIN" : m.phase === "halftime" ? "MT" : `${m.minute}'`;
      const own = m.ctrl >= 0 && m.ball.owner === m.ctrl;
      e.power.style.opacity = own && this.shootHold > 0.05 ? "1" : "0";
      e.fill.style.width = `${Math.round(clamp(this.shootHold / 0.9, 0, 1) * 100)}%`;
    }
    const sum = { ...m.summary(), cine: this.replay ? "replay" : this.cine?.kind ?? null };
    const s = JSON.stringify(sum);
    if (s !== this.lastSummary) {
      this.lastSummary = s;
      this.onSummary(sum);
    }
  }
}

/** Gestes du moteur, codés pour l'enregistrement du ralenti. */
const ACTION_CODES = ["idle", "kick", "fightkick", "tackle", "diveleft", "diveright", "fall", "header", "throw", "carry", "cheer", "jump", "think"];

function blendCam(a: Cam, b: Cam, t: number): Cam {
  return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, cz: a.cz + (b.cz - a.cz) * t, yaw: lerpAngle(a.yaw, b.yaw, t), pitch: a.pitch + (b.pitch - a.pitch) * t, dist: a.dist + (b.dist - a.dist) * t, fov: a.fov + (b.fov - a.fov) * t };
}

function short(name: string): string {
  return name.length <= 4 ? name.toUpperCase() : name.slice(0, 3).toUpperCase();
}

/** Texte lisible sur une couleur de fond (noir ou blanc). */
function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111" : "#fff";
}
