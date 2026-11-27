/**
 * Match de football (CPU, pur, testé sans rendu) : règles, ballon, intelligence des équipes, joueur humain.
 *
 * Le moteur est l'autorité : il tient la position, la vitesse, le cap et l'action de chaque joueur, ainsi que le
 * ballon (vol, rebonds, roulement, poteaux, filets). Le rendu (`render/football.ts`) pose les personnages là où le
 * moteur les place (`puppet` de la vue) et le ballon de la scène là où il est, puis règle la caméra et les
 * cinématiques à partir des événements (`cine`).
 *
 * Repère : terrain de `L × W` m centré sur l'origine, lignes de but en x = ±L/2, touche en z = ±W/2. L'équipe 0
 * attaque vers +x en première période, l'équipe 1 vers -x ; les camps s'échangent à la mi-temps.
 */

export type TeamSpec = { name: string; shirt: string; shorts: string; socks: string; keeper: string; pattern: "plain" | "stripes" | "vstripes" };
export type FootballSpec = {
  /** Joueurs par équipe (gardien compris) : 5, 7 ou 11. */
  side: number;
  /** Durée réelle du match (min) ; l'horloge affichée va de 0 à 90'. */
  minutes: number;
  /** Niveau de l'adversaire géré par la machine (0 … 1). */
  level: number;
  /** Équipe du joueur humain : 0, 1, ou -1 (match entre deux équipes gérées). */
  human: number;
  teams: [TeamSpec, TeamSpec];
  /** Cinématiques et ralentis (but, grosse occasion, arrêt, tacle, penalty). */
  cinematics: boolean;
  seed: number;
};

export type FootballInput = { x: number; z: number; sprint: boolean; pass: boolean; shoot: boolean; lob: boolean; tackle: boolean; switch: boolean };
export const NO_INPUT: FootballInput = { x: 0, z: 0, sprint: false, pass: false, shoot: false, lob: false, tackle: false, switch: false };

export type Role = "gk" | "def" | "mid" | "fwd";
export type Player = {
  id: string;
  team: 0 | 1;
  num: number;
  role: Role;
  /** Place dans le système (x : -1 = propre but … 1 = but adverse, z : -1 … 1, vu par l'équipe qui attaque vers +x). */
  home: [number, number];
  pos: [number, number];
  vel: [number, number];
  yaw: number;
  /** Action affichée (nom d'action procgen) et son temps. */
  action: string;
  actionTime: number;
  /** Qualité (0,8 … 1,1) : vitesse, précision, réflexes. */
  skill: number;
  /** Ne peut plus toucher le ballon avant (s). */
  noTouch: number;
  /** Au sol / déséquilibré / en glissade (s restantes). */
  down: number;
  slide: number;
  slideDir: [number, number];
  dive: number;
  diveV: [number, number];
  /** Décision suivante de l'IA (s). */
  think: number;
  /** Cible de course choisie par l'IA. */
  target: [number, number];
  /** Vitesse voulue (m/s) et direction voulue. */
  want: [number, number];
  /** Tient le ballon dans les mains (gardien). */
  holding: number;
  /** Fatigue légère du sprint (0 … 1). */
  tire: number;
};

export type Ball = { p: [number, number, number]; v: [number, number, number]; owner: number; last: number; lastTeam: 0 | 1 | -1; /** effet latéral (m/s²) */ curl: number; inGoal: number };

export type CineKind = "intro" | "shot" | "save" | "goal" | "tackle" | "penalty" | "halftime" | "fulltime" | "post";
export type FootballEvent = { type: string; payload: Record<string, unknown> };

export type Phase = "intro" | "setpiece" | "play" | "goal" | "halftime" | "fulltime";
export type SetPiece = { kind: "kickoff" | "throwin" | "corner" | "goalkick" | "freekick" | "penalty"; team: 0 | 1; spot: [number, number]; taker: number; t: number; ready: boolean };

const G = 9.81;
const R = 0.11;
const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const hyp = Math.hypot;
const wrap = (a: number) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};

/** Dimensions selon le nombre de joueurs (m). */
export function pitchSize(side: number): { L: number; W: number; gw: number; gh: number; box: [number, number]; six: [number, number]; spot: number; circle: number } {
  if (side <= 5) return { L: 40, W: 25, gw: 3, gh: 2, box: [6, 12], six: [0, 0], spot: 6, circle: 3 };
  if (side <= 7) return { L: 60, W: 40, gw: 6, gh: 2.1, box: [13, 26], six: [4, 12], spot: 9, circle: 6 };
  return { L: 105, W: 68, gw: 7.32, gh: 2.44, box: [16.5, 40.32], six: [5.5, 18.32], spot: 11, circle: 9.15 };
}

/** Systèmes de jeu (gardien d'abord), coordonnées de l'équipe qui attaque vers +x. */
const FORMATIONS: Record<number, [Role, number, number][]> = {
  5: [["gk", -0.95, 0], ["def", -0.55, -0.45], ["def", -0.55, 0.45], ["mid", -0.1, 0], ["fwd", 0.35, 0]],
  7: [["gk", -0.95, 0], ["def", -0.62, -0.55], ["def", -0.65, 0], ["def", -0.62, 0.55], ["mid", -0.25, -0.4], ["mid", -0.25, 0.4], ["fwd", 0.15, 0]],
  11: [
    ["gk", -0.95, 0],
    ["def", -0.62, -0.72], ["def", -0.68, -0.25], ["def", -0.68, 0.25], ["def", -0.62, 0.72],
    ["mid", -0.3, -0.62], ["mid", -0.35, -0.18], ["mid", -0.35, 0.18], ["mid", -0.3, 0.62],
    ["fwd", -0.05, -0.18], ["fwd", -0.05, 0.18],
  ],
};

export const TEAM_PRESETS: TeamSpec[] = [
  { name: "Rouges", shirt: "#c8202c", shorts: "#f4f4f4", socks: "#c8202c", keeper: "#2bb24c", pattern: "plain" },
  { name: "Bleus", shirt: "#1f4fa8", shorts: "#14204a", socks: "#f4f4f4", keeper: "#f2c230", pattern: "plain" },
  { name: "Rayés", shirt: "#f4f4f4", shorts: "#111111", socks: "#111111", keeper: "#e86a1a", pattern: "vstripes" },
  { name: "Jaunes", shirt: "#f2d230", shorts: "#1f6a3a", socks: "#f2d230", keeper: "#6a2bb2", pattern: "plain" },
];

export function parseFootball(v: unknown): FootballSpec {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = (x: unknown, d: number) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : d);
  const sideRaw = n(o.players ?? o.side, 11);
  const side = sideRaw <= 5 ? 5 : sideRaw <= 7 ? 7 : 11;
  const team = (x: unknown, d: TeamSpec): TeamSpec => {
    const t = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const col = (c: unknown, dc: string) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : dc);
    const pat = ["plain", "stripes", "vstripes"].includes(String(t.pattern)) ? (String(t.pattern) as TeamSpec["pattern"]) : d.pattern;
    return { name: typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 24) : d.name, shirt: col(t.shirt, d.shirt), shorts: col(t.shorts, d.shorts), socks: col(t.socks, d.socks), keeper: col(t.keeper, d.keeper), pattern: pat };
  };
  // tableau, ou objet indexé (certains DataProviders publient les listes ainsi)
  const teams: unknown[] = Array.isArray(o.teams) ? o.teams : o.teams && typeof o.teams === "object" ? Object.values(o.teams as object) : [];
  const human = o.human === "none" || o.human === -1 || o.human === false ? -1 : o.human === "away" || o.human === 1 ? 1 : 0;
  return {
    side,
    minutes: clamp(n(o.minutes, 6), 1, 90),
    level: clamp(n(o.level, 0.6), 0, 1),
    human,
    teams: [team(teams[0], TEAM_PRESETS[0]), team(teams[1], TEAM_PRESETS[1])],
    cinematics: o.cinematics !== false,
    seed: Math.floor(n(o.seed, 7)),
  };
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FootballMatch {
  readonly spec: FootballSpec;
  readonly dim: ReturnType<typeof pitchSize>;
  readonly players: Player[] = [];
  readonly ball: Ball = { p: [0, R, 0], v: [0, 0, 0], owner: -1, last: -1, lastTeam: -1, curl: 0, inGoal: 0 };
  score: [number, number] = [0, 0];
  /** Temps de jeu écoulé (s réelles) et période (1, 2). */
  played = 0;
  half = 1;
  phase: Phase = "intro";
  phaseT = 0;
  set: SetPiece | null = null;
  /** Joueur contrôlé par l'humain (indice) ou -1. */
  ctrl = -1;
  events: FootballEvent[] = [];
  /** Coup en préparation : contact du pied au temps `at` (s, temps du match). */
  private pending: { pl: number; v: [number, number, number]; curl: number; at: number; kind: string; to: number } | null = null;
  private rand: () => number;
  private time = 0;
  private prevIn: FootballInput = { ...NO_INPUT };
  private shootHold = -1;
  /** Dernier tir cadré (pour l'événement d'arrêt et la cinématique). */
  private shot: { by: number; t: number; team: 0 | 1 } | null = null;
  /** Récepteur visé par la dernière passe. */
  private receiver = -1;
  private goalTeam: 0 | 1 = 0;
  private kickoffTeam: 0 | 1 = 0;
  /** Fin du match demandée par l'horloge : on termine à la prochaine sortie ou après 4 s. */
  private ending = 0;

  constructor(spec: FootballSpec) {
    this.spec = spec;
    this.dim = pitchSize(spec.side);
    this.rand = rng(spec.seed * 7919 + 13);
    const form = FORMATIONS[spec.side];
    for (const team of [0, 1] as const) {
      form.forEach(([role, hx, hz], i) => {
        this.players.push({
          id: `${team ? "b" : "a"}${i + 1}`,
          team,
          num: i + 1,
          role,
          home: [hx, hz],
          pos: [0, 0],
          vel: [0, 0],
          yaw: 0,
          action: "idle",
          actionTime: 0,
          skill: 0.85 + this.rand() * 0.2,
          noTouch: 0,
          down: 0,
          slide: 0,
          slideDir: [0, 0],
          dive: 0,
          diveV: [0, 0],
          think: this.rand() * 0.3,
          target: [0, 0],
          want: [0, 0],
          holding: 0,
          tire: 0,
        });
      });
    }
    this.kickoff(0, true);
    this.phase = "intro";
    this.phaseT = 0;
    this.emit("cine", { kind: "intro", dur: spec.cinematics ? 4 : 0 });
  }

  /* ---------------- repères ---------------- */

  /** Sens d'attaque de l'équipe (+1 vers +x). */
  dir(team: number): number {
    return (team === 0 ? 1 : -1) * (this.half === 1 ? 1 : -1);
  }
  /** Centre du but que l'équipe défend. */
  ownGoal(team: number): [number, number] {
    return [(-this.dir(team) * this.dim.L) / 2, 0];
  }
  oppGoal(team: number): [number, number] {
    return [(this.dir(team) * this.dim.L) / 2, 0];
  }
  /** Minute affichée (0 … 90). */
  get minute(): number {
    const halfLen = (this.spec.minutes * 60) / 2;
    return Math.min(90, Math.floor((this.played / halfLen) * 45));
  }
  isHuman(i: number): boolean {
    return this.spec.human >= 0 && this.players[i].team === this.spec.human;
  }
  private emit(type: string, payload: Record<string, unknown>) {
    this.events.push({ type, payload });
  }
  private levelOf(team: number): number {
    return this.spec.human < 0 ? this.spec.level : team === this.spec.human ? 0.75 : this.spec.level;
  }
  private toWorld(team: number, hx: number, hz: number): [number, number] {
    return [hx * this.dir(team) * (this.dim.L / 2), hz * (this.dim.W / 2) * this.dir(team)];
  }

  /* ---------------- coups de pied arrêtés ---------------- */

  private placeTeams(attacking: 0 | 1 | -1, kick = false) {
    for (const p of this.players) {
      let [x, z] = this.toWorld(p.team, p.home[0], p.home[1]);
      if (kick) {
        // coup d'envoi : chacun dans son camp, hors du rond pour l'équipe qui ne l'a pas
        const d = this.dir(p.team);
        x = Math.min(x * d, -1.2) * d;
        if (p.team !== attacking && Math.hypot(x, z) < this.dim.circle + 0.5) {
          const k = (this.dim.circle + 0.8) / Math.max(0.5, Math.hypot(x, z));
          x *= k;
          z *= k;
        }
      }
      p.pos = [x, z];
      p.vel = [0, 0];
      p.yaw = Math.atan2(this.dir(p.team), 0);
      p.action = "idle";
      p.down = p.slide = p.dive = p.holding = 0;
    }
  }

  private kickoff(team: 0 | 1, reset = false) {
    this.kickoffTeam = team;
    this.placeTeams(team, true);
    this.ball.p = [0, R, 0];
    this.ball.v = [0, 0, 0];
    this.ball.owner = -1;
    this.ball.inGoal = 0;
    // l'avant-centre au point central, un coéquipier à côté pour la passe en retrait
    const mates = this.players.map((p, i) => [p, i] as const).filter(([p]) => p.team === team && p.role !== "gk");
    const fwd = mates.sort((a, b) => b[0].home[0] - a[0].home[0])[0];
    const d = this.dir(team);
    fwd[0].pos = [-d * 0.35, 0];
    fwd[0].yaw = Math.atan2(d, 0);
    const sup = mates.find(([p]) => p !== fwd[0]);
    if (sup) sup[0].pos = [-d * 6, sup[0].pos[1] > 0 ? 4 : -4];
    this.set = { kind: "kickoff", team, spot: [0, 0], taker: fwd[1], t: 0, ready: false };
    this.phase = "setpiece";
    this.phaseT = 0;
    if (!reset) this.emit("kickoff", { team, half: this.half });
    this.pickCtrl(true);
  }

  private setPiece(kind: SetPiece["kind"], team: 0 | 1, spot: [number, number]) {
    this.ball.owner = -1;
    this.ball.v = [0, 0, 0];
    this.ball.p = [spot[0], R, spot[1]];
    this.ball.curl = 0;
    this.pending = null;
    // tireur : le gardien pour la sortie de but, sinon le joueur de champ le plus proche
    let taker = -1, best = 1e9;
    this.players.forEach((p, i) => {
      if (p.team !== team || p.down > 0.6) return;
      if (kind === "goalkick" ? p.role !== "gk" : p.role === "gk") return;
      const d = hyp(p.pos[0] - spot[0], p.pos[1] - spot[1]);
      if (d < best) [best, taker] = [d, i];
    });
    if (kind === "penalty") {
      // tireur : le meilleur attaquant ; les autres hors de la surface
      const cands = this.players.map((p, i) => [p, i] as const).filter(([p]) => p.team === team && p.role !== "gk");
      taker = cands.sort((a, b) => b[0].home[0] + b[0].skill - (a[0].home[0] + a[0].skill))[0][1];
      const gx = Math.sign(spot[0]) * (this.dim.L / 2);
      for (const p of this.players) {
        if (p.role === "gk" && p.team !== team) {
          p.pos = [gx - Math.sign(gx) * 0.3, 0];
          p.yaw = Math.atan2(-Math.sign(gx), 0);
          continue;
        }
        if (Math.abs(p.pos[0]) > this.dim.L / 2 - this.dim.box[0] - 1 && Math.sign(p.pos[0]) === Math.sign(gx)) p.pos[0] = gx - Math.sign(gx) * (this.dim.box[0] + 2 + this.rand() * 3);
      }
      const t = this.players[taker];
      t.pos = [spot[0] - Math.sign(gx) * 2.2, spot[1] + 0.6];
      t.yaw = Math.atan2(Math.sign(gx), 0);
      this.emit("cine", { kind: "penalty", at: [spot[0], 0, spot[1]], player: t.id, dur: 2.5 });
    }
    this.set = { kind, team, spot, taker, t: 0, ready: false };
    this.phase = "setpiece";
    this.phaseT = 0;
    this.emit(kind, { team, x: spot[0], z: spot[1] });
    this.pickCtrl(true);
  }

  /* ---------------- pas de simulation ---------------- */

  step(dt: number, input: FootballInput = NO_INPUT) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.phaseT += dt;
    if (this.phase === "intro") {
      if (this.phaseT > (this.spec.cinematics ? 3.5 : 0.2)) {
        this.phase = "setpiece";
        this.phaseT = 0;
        this.emit("kickoff", { team: this.kickoffTeam, half: this.half });
      }
      this.animateIdle(dt);
      return;
    }
    if (this.phase === "fulltime") {
      this.celebrate(dt, this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1);
      return;
    }
    if (this.phase === "halftime") {
      this.animateIdle(dt);
      if (this.phaseT > 3) {
        this.half = 2;
        this.kickoff(this.kickoffTeam === 0 ? 1 : 0);
      }
      return;
    }
    if (this.phase === "goal") {
      this.celebrate(dt, this.goalTeam);
      this.stepBall(dt);
      if (this.phaseT > (this.spec.cinematics ? 9 : 3)) {
        if (this.ending) return this.endHalf();
        this.kickoff(this.goalTeam === 0 ? 1 : 0);
      }
      return;
    }
    // horloge : elle court pendant le jeu et les arrêts de jeu courts
    if (this.phase === "play" || this.phase === "setpiece") {
      this.played += dt;
      const halfLen = (this.spec.minutes * 60) / 2;
      if (!this.ending && this.played >= halfLen * this.half) this.ending = this.time;
      // fin de période : ballon hors des surfaces ou 6 s après le temps réglementaire
      if (this.ending && (this.time - this.ending > 6 || (this.phase === "play" && Math.abs(this.ball.p[0]) < this.dim.L / 2 - this.dim.box[0] - 4))) return this.endHalf();
    }
    this.handleInput(dt, input);
    for (let i = 0; i < this.players.length; i++) this.decide(i, dt);
    this.movePlayers(dt);
    this.stepPending();
    this.stepBall(dt);
    this.touches(dt);
    this.rules();
    if (this.phase === "setpiece") this.stepSetPiece(dt);
    this.prevIn = { ...input };
  }

  /** Fin de la célébration d'un but (après le ralenti) : coup d'envoi tout de suite. */
  endGoal() {
    if (this.phase !== "goal") return;
    if (this.ending) return this.endHalf();
    this.kickoff(this.goalTeam === 0 ? 1 : 0);
  }

  private endHalf() {
    this.ending = 0;
    this.pending = null;
    if (this.half === 1) {
      this.phase = "halftime";
      this.phaseT = 0;
      this.played = (this.spec.minutes * 60) / 2;
      this.emit("halftime", { score: [...this.score] });
      this.emit("cine", { kind: "halftime", dur: 3 });
    } else {
      this.phase = "fulltime";
      this.phaseT = 0;
      this.emit("fulltime", { score: [...this.score], winner: this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1 });
      this.emit("cine", { kind: "fulltime", dur: 6 });
    }
  }

  /* ---------------- humain ---------------- */

  private pickCtrl(force = false) {
    if (this.spec.human < 0) return void (this.ctrl = -1);
    const b = this.ball;
    if (b.owner >= 0 && this.players[b.owner].team === this.spec.human) {
      this.ctrl = b.owner;
      return;
    }
    if (this.set && this.set.team === this.spec.human) {
      this.ctrl = this.set.taker;
      return;
    }
    // le plus proche du point où le ballon va (hors gardien, sauf s'il est le seul proche)
    let best = 1e9, bi = this.ctrl;
    const fut = this.predict(0.5);
    this.players.forEach((p, i) => {
      if (p.team !== this.spec.human || p.down > 0.4) return;
      const d = hyp(p.pos[0] - fut[0], p.pos[1] - fut[2]) + (p.role === "gk" ? 12 : 0) - (i === this.ctrl && !force ? 4 : 0);
      if (d < best) [best, bi] = [d, i];
    });
    this.ctrl = bi;
  }

  private handleInput(dt: number, inp: FootballInput) {
    if (this.spec.human < 0) return;
    const pressed = (k: keyof FootballInput) => !!inp[k] && !this.prevIn[k];
    const b = this.ball;
    if (this.ctrl < 0 || this.players[this.ctrl].team !== this.spec.human) this.pickCtrl(true);
    // le ballon change de pieds : on prend le porteur ; perdu : le plus proche
    if (b.owner >= 0 && this.players[b.owner].team === this.spec.human && b.owner !== this.ctrl) this.ctrl = b.owner;
    if (pressed("switch") || (pressed("pass") && !(b.owner === this.ctrl) && !(this.set && this.set.taker === this.ctrl))) this.pickCtrl(true);
    else if (b.owner < 0 && this.receiver >= 0 && this.players[this.receiver].team === this.spec.human) this.ctrl = this.receiver;
    else if (b.owner >= 0 && this.players[b.owner].team !== this.spec.human) {
      const me = this.players[this.ctrl];
      const o = this.players[b.owner];
      if (hyp(me.pos[0] - o.pos[0], me.pos[1] - o.pos[1]) > 14) this.pickCtrl();
    }
    const i = this.ctrl;
    if (i < 0) return;
    const p = this.players[i];
    const l = hyp(inp.x, inp.z);
    const ux = l > 0.15 ? inp.x / Math.max(1, l) : 0, uz = l > 0.15 ? inp.z / Math.max(1, l) : 0;
    const top = inp.sprint ? 7.9 : 6.3;
    p.want = [ux * top * (1 - 0.15 * p.tire), uz * top * (1 - 0.15 * p.tire)];
    if (inp.sprint && l > 0.15) p.tire = Math.min(1, p.tire + dt * 0.12);
    else p.tire = Math.max(0, p.tire - dt * 0.2);
    const aim: [number, number] = l > 0.15 ? [ux, uz] : [Math.sin(p.yaw), Math.cos(p.yaw)];
    const own = b.owner === i;
    const taking = this.set && this.set.taker === i && this.phase === "setpiece";
    if (taking && !this.set!.ready) return;
    // tir : la puissance monte tant que la touche est tenue (0,9 s au plus)
    if (own || taking) {
      if (inp.shoot && this.shootHold < 0) this.shootHold = 0;
      if (inp.shoot && this.shootHold >= 0) this.shootHold += dt;
      if (this.shootHold >= 0 && (!inp.shoot || this.shootHold > 0.9)) {
        const pw = clamp(this.shootHold / 0.9, 0.15, 1);
        this.shootHold = -2;
        this.shoot(i, pw, uz !== 0 ? uz * 1.2 : (this.rand() - 0.5) * 1.4);
        return;
      }
      if (this.shootHold === -2 && !inp.shoot) this.shootHold = -1;
      if (pressed("pass")) return void this.passToward(i, aim, false);
      if (pressed("lob")) return void this.passToward(i, aim, true);
    } else {
      this.shootHold = -1;
      if (pressed("tackle")) this.tackle(i, aim);
      if (pressed("shoot") || pressed("lob")) this.tackle(i, aim, true);
    }
  }

  /* ---------------- décisions (IA) ---------------- */

  private decide(i: number, dt: number) {
    const p = this.players[i];
    if (p.down > 0 || p.slide > 0 || p.dive > 0) return;
    const human = i === this.ctrl && this.spec.human >= 0;
    const b = this.ball;
    const lv = this.levelOf(p.team);
    const d = this.dir(p.team);
    // pendant un coup de pied arrêté : placement
    if (this.phase === "setpiece" && this.set) {
      if (human && i !== this.set.taker) return;
      return this.setPiecePlace(i);
    }
    if (human) return;
    p.think -= dt;
    // gardien
    if (p.role === "gk") return this.keeper(i, dt);
    const ownBall = b.owner >= 0 && this.players[b.owner].team === p.team;
    if (b.owner === i) {
      if (p.think > 0) return;
      // à peine reçu : on garde le ballon un instant (contrôle, tête levée), sauf si un adversaire est collé
      if (this.time - this.gotAt < 0.5 + 0.4 * this.rand() && this.pressure(p) > 1.6) return void (p.think = 0.1);
      p.think = 0.18 + (1 - lv) * 0.25 + this.rand() * 0.1;
      return this.carrierAI(i);
    }
    // qui va au ballon ? le plus rapide de chaque équipe (le receveur d'une passe y va d'office)
    const chaser = this.chaserOf(p.team);
    if (chaser === i && !ownBall) {
      const t = this.interceptPoint(p);
      const o = b.owner >= 0 ? this.players[b.owner] : null;
      // pressing : se placer entre le porteur et son but
      let tx = t[0], tz = t[1];
      if (o) {
        const g = this.ownGoal(p.team);
        const dx = g[0] - o.pos[0], dz = g[1] - o.pos[1], dl = hyp(dx, dz) || 1;
        const k = Math.min(0.9, hyp(p.pos[0] - o.pos[0], p.pos[1] - o.pos[1]) * 0.15);
        tx = o.pos[0] + (dx / dl) * k + o.vel[0] * 0.25;
        tz = o.pos[1] + (dz / dl) * k + o.vel[1] * 0.25;
        const dd = hyp(p.pos[0] - o.pos[0], p.pos[1] - o.pos[1]);
        if (p.think <= 0) {
          p.think = 0.45 + (1 - lv) * 0.4;
          // le défenseur temporise : il tacle quand il est collé et que le porteur s'expose
          if (dd < 1.25 && this.rand() < 0.14 + 0.2 * lv) this.tackle(i, [o.pos[0] - p.pos[0], o.pos[1] - p.pos[1]]);
          else if (dd < 3.2 && dd > 1.6 && hyp(o.vel[0], o.vel[1]) > 4 && this.rand() < 0.08 + 0.1 * lv) this.tackle(i, [o.pos[0] + o.vel[0] * 0.3 - p.pos[0], o.pos[1] + o.vel[1] * 0.3 - p.pos[1]], true);
        }
      }
      return this.runTo(p, tx, tz, 7.4 + 0.5 * lv);
    }
    if (this.receiver === i && b.owner < 0) {
      const t = this.interceptPoint(p);
      return this.runTo(p, t[0], t[1], 7);
    }
    // placement : système décalé vers le ballon, plus haut en possession
    const bx = b.p[0], bz = b.p[2];
    let [hx, hz] = this.toWorld(p.team, p.home[0], p.home[1]);
    const shift = ownBall ? 0.55 : 0.45;
    hx = hx * 0.8 + bx * shift + d * (ownBall ? (p.role === "fwd" ? 0.24 : p.role === "mid" ? 0.14 : 0.08) : -0.05) * this.dim.L;
    hz = hz * 0.8 + bz * 0.35;
    // défenseurs : jamais derrière leur but, ni très haut
    const lim = this.dim.L / 2 - 2;
    hx = clamp(hx, -lim, lim);
    if (p.role === "def") hx = d > 0 ? Math.min(hx, bx + 4, this.dim.L * 0.18) : Math.max(hx, bx - 4, -this.dim.L * 0.18);
    // appel en profondeur des attaquants quand un coéquipier porte le ballon
    if (ownBall && p.role !== "def" && this.players[b.owner].pos[0] * d > hx * d - 12) {
      const run = Math.sin(this.time * 0.7 + i * 1.9);
      hx += d * (4 + 4 * run);
      hz += Math.cos(this.time * 0.5 + i) * 4;
    }
    // marquage : en défense, se rapprocher de l'adversaire le plus proche de sa zone
    if (!ownBall && p.role !== "fwd") {
      let mk = -1, md = 12;
      this.players.forEach((q, j) => {
        if (q.team === p.team || q.role === "gk") return;
        const dd = hyp(q.pos[0] - hx, q.pos[1] - hz);
        if (dd < md) [md, mk] = [dd, j];
      });
      if (mk >= 0) {
        const q = this.players[mk];
        const g = this.ownGoal(p.team);
        const gx = g[0] - q.pos[0], gz = g[1] - q.pos[1], gl = hyp(gx, gz) || 1;
        hx = mix(hx, q.pos[0] + (gx / gl) * 1.5, 0.55);
        hz = mix(hz, q.pos[1] + (gz / gl) * 1.5, 0.55);
      }
    }
    hz = clamp(hz, -this.dim.W / 2 + 1.5, this.dim.W / 2 - 1.5);
    const far = hyp(hx - p.pos[0], hz - p.pos[1]);
    this.runTo(p, hx, hz, far > 10 ? 6.6 : far > 3 ? 4.2 : 2.2);
  }

  /** Joueur de l'équipe qui va au ballon : le premier à pouvoir l'atteindre. */
  private chaserOf(team: number): number {
    if (this.chaseT !== this.time) {
      this.chaseT = this.time;
      this.chase = [this.chaserRaw(0), this.chaserRaw(1)];
    }
    return this.chase[team];
  }
  private chaseT = -1;
  private chase: [number, number] = [-1, -1];
  private chaserRaw(team: number): number {
    let best = 1e9, bi = -1;
    this.players.forEach((p, i) => {
      if (p.team !== team || p.role === "gk" || p.down > 0.3) return;
      if (this.spec.human === team && i === this.ctrl) return;
      const t = this.timeTo(p);
      if (t < best) [best, bi] = [t, i];
    });
    if (this.spec.human === team) {
      // l'humain va déjà au ballon : un deuxième joueur ne presse que s'il est bien plus près
      const me = this.ctrl >= 0 ? this.timeTo(this.players[this.ctrl]) : 1e9;
      if (me < best + 1.5) return -1;
    }
    return bi;
  }

  /** Temps pour atteindre le ballon (prévision de sa course). */
  private timeTo(p: Player): number {
    const v = 7;
    for (let k = 0; k <= 30; k++) {
      const t = k * 0.1;
      const q = this.predict(t);
      if (q[1] > 2.2) continue;
      if (hyp(q[0] - p.pos[0], q[2] - p.pos[1]) - 0.6 <= v * t + 0.2) return t;
    }
    const q = this.predict(3);
    return 3 + hyp(q[0] - p.pos[0], q[2] - p.pos[1]) / v;
  }

  private interceptPoint(p: Player): [number, number] {
    const b = this.ball;
    if (b.owner >= 0) {
      const o = this.players[b.owner];
      return [o.pos[0] + o.vel[0] * 0.3, o.pos[1] + o.vel[1] * 0.3];
    }
    const t = this.timeTo(p);
    const q = this.predict(Math.min(3, t));
    return [q[0], q[2]];
  }

  /** Position prévue du ballon dans `t` s (vol simplifié et roulement freiné). */
  predict(t: number): [number, number, number] {
    const k = Math.round(t * 10);
    if (Math.abs(k / 10 - t) < 1e-6 && k <= 30) {
      if (this.predT !== this.time) {
        this.predT = this.time;
        this.pred = this.trajectory();
      }
      return this.pred[k];
    }
    return this.predictRaw(t);
  }
  private predT = -1;
  private pred: [number, number, number][] = [];
  /** Course du ballon de 0 à 3 s, pas de 0,1 s. */
  private trajectory(): [number, number, number][] {
    const out: [number, number, number][] = [];
    const b = this.ball;
    if (b.owner >= 0) {
      for (let k = 0; k <= 30; k++) out.push(this.predictRaw(k / 10));
      return out;
    }
    let [x, y, z] = b.p, [vx, vy, vz] = b.v;
    const h = 0.05;
    out.push([x, y, z]);
    for (let s = 1; s <= 60; s++) {
      vy -= G * h;
      x += vx * h;
      y += vy * h;
      z += vz * h;
      if (y <= R) {
        y = R;
        if (vy < -1.5) {
          vy = -vy * 0.5;
          vx *= 0.85;
          vz *= 0.85;
        } else vy = 0;
      }
      if (y <= R + 0.01) {
        const sp = hyp(vx, vz);
        const k = sp > 0 ? Math.max(0, sp - 1.7 * h) / sp : 0;
        vx *= k;
        vz *= k;
      }
      if (s % 2 === 0) out.push([x, y, z]);
    }
    return out;
  }
  private predictRaw(t: number): [number, number, number] {
    const b = this.ball;
    if (b.owner >= 0) {
      const o = this.players[b.owner];
      return [b.p[0] + o.vel[0] * t, R, b.p[2] + o.vel[1] * t];
    }
    let [x, y, z] = b.p, [vx, vy, vz] = b.v;
    const h = 0.05;
    for (let s = 0; s < t; s += h) {
      vy -= G * h;
      x += vx * h;
      y += vy * h;
      z += vz * h;
      if (y <= R) {
        y = R;
        if (vy < -1.5) {
          vy = -vy * 0.5;
          vx *= 0.85;
          vz *= 0.85;
        } else vy = 0;
      }
      if (y <= R + 0.01) {
        const sp = hyp(vx, vz);
        const k = sp > 0 ? Math.max(0, sp - 1.7 * h) / sp : 0;
        vx *= k;
        vz *= k;
      }
    }
    return [x, y, z];
  }

  private carrierAI(i: number) {
    const p = this.players[i];
    const lv = this.levelOf(p.team);
    const g = this.oppGoal(p.team);
    const d = this.dir(p.team);
    const toGoal = hyp(g[0] - p.pos[0], g[1] - p.pos[1]);
    const press = this.pressure(p);
    // tir
    const ang = Math.abs(Math.atan2(g[1] - p.pos[1], (g[0] - p.pos[0]) * d));
    if (toGoal < 26 && ang < 0.9 && (toGoal < 13 || this.rand() < 0.25 + (press < 3 ? 0.25 : 0))) return this.shoot(i, clamp(0.55 + toGoal / 45 + this.rand() * 0.2, 0.4, 1), (this.rand() - 0.5) * 1.8);
    // passe : progression, liberté, distance raisonnable
    let best = -1e9, bj = -1;
    this.players.forEach((q, j) => {
      if (q.team !== p.team || j === i || q.down > 0) return;
      const dx = q.pos[0] - p.pos[0], dz = q.pos[1] - p.pos[1], dist = hyp(dx, dz);
      if (dist < 5 || dist > 38) return;
      const prog = (q.pos[0] - p.pos[0]) * d;
      const open = this.laneOpen(p.pos, q.pos, p.team);
      const free = this.pressure(q);
      const s = (prog > 0 ? prog * 1.1 : prog * 2) + open * 6 + Math.min(free, 6) * 0.8 - dist * 0.06 - (q.role === "gk" ? 15 : 0) + this.rand() * 3 * (1.2 - lv);
      if (s > best) [best, bj] = [s, j];
    });
    // espace devant : le porteur libre avance balle au pied plutôt que de la donner
    const ahead = this.spaceAhead(p);
    const keepScore = (press > 4 ? 6 : press > 2.2 ? 1 : -4) + clamp(ahead - 6, 0, 14) * 1.2;
    if (bj >= 0 && best > keepScore + (toGoal < 30 ? 3 : 0)) return this.passTo(i, bj, hyp(this.players[bj].pos[0] - p.pos[0], this.players[bj].pos[1] - p.pos[1]) > 24 && this.rand() < 0.5);
    // conduite : vers le but, en évitant le défenseur le plus proche
    let ax = g[0] - p.pos[0], az = (g[1] - p.pos[1]) * 0.6;
    const n = this.nearestOpp(p);
    if (n.d < 6) {
      const q = this.players[n.i];
      const ox = p.pos[0] - q.pos[0], oz = p.pos[1] - q.pos[1], ol = hyp(ox, oz) || 1;
      ax += (ox / ol) * 14 * (6 - n.d) / 6;
      az += (oz / ol) * 22 * (6 - n.d) / 6;
    }
    // près de la ligne de touche : rentrer
    if (Math.abs(p.pos[1]) > this.dim.W / 2 - 4) az -= Math.sign(p.pos[1]) * 10;
    const al = hyp(ax, az) || 1;
    const sp = n.d < 3 ? 6.6 : 7.2;
    p.target = [p.pos[0] + (ax / al) * 5, p.pos[1] + (az / al) * 5];
    p.want = [(ax / al) * sp, (az / al) * sp];
  }

  /** Distance du premier adversaire dans le cône devant le joueur (vers le but adverse). */
  private spaceAhead(p: Player): number {
    const d = this.dir(p.team);
    let best = 40;
    for (const q of this.players) {
      if (q.team === p.team) continue;
      const fx = (q.pos[0] - p.pos[0]) * d, fz = q.pos[1] - p.pos[1];
      if (fx > 0 && Math.abs(fz) < fx * 0.8 + 2) best = Math.min(best, hyp(fx, fz));
    }
    return best;
  }

  /** Liberté d'un joueur : distance du plus proche adversaire. */
  private pressure(p: Player): number {
    return this.nearestOpp(p).d;
  }
  private nearestOpp(p: Player): { i: number; d: number } {
    let d = 1e9, bi = -1;
    this.players.forEach((q, j) => {
      if (q.team === p.team) return;
      const dd = hyp(q.pos[0] - p.pos[0], q.pos[1] - p.pos[1]);
      if (dd < d) [d, bi] = [dd, j];
    });
    return { i: bi, d };
  }
  /** Ligne de passe libre (0 : coupée … 1 : libre). */
  private laneOpen(a: [number, number], b: [number, number], team: number): number {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
    let worst = 1;
    for (const q of this.players) {
      if (q.team === team) continue;
      const t = clamp(((q.pos[0] - a[0]) * dx + (q.pos[1] - a[1]) * dz) / l2, 0, 1);
      const d = hyp(a[0] + dx * t - q.pos[0], a[1] + dz * t - q.pos[1]);
      worst = Math.min(worst, clamp((d - 0.6) / 2.4, 0, 1));
    }
    return worst;
  }

  private keeper(i: number, dt: number) {
    const p = this.players[i];
    const b = this.ball;
    const g = this.ownGoal(p.team);
    const d = this.dir(p.team);
    const lv = this.levelOf(p.team);
    if (p.holding > 0) {
      p.want = [0, 0];
      p.holding += dt;
      if (p.holding > 1.6 && !this.pending) {
        // relance : à la main vers un défenseur libre, ou dégagement au pied
        let best = -1e9, bj = -1;
        this.players.forEach((q, j) => {
          if (q.team !== p.team || j === i) return;
          const s = this.pressure(q) * 2 - Math.abs(hyp(q.pos[0] - p.pos[0], q.pos[1] - p.pos[1]) - 22) * 0.3 + (q.pos[0] - p.pos[0]) * d * 0.15;
          if (s > best) [best, bj] = [s, j];
        });
        p.holding = 0;
        if (bj >= 0) this.passTo(i, bj, true);
      }
      return;
    }
    // tir en approche : plongeon
    if (b.owner < 0 && b.v[0] * d < -6) {
      const tx = (g[0] - b.p[0]) / (b.v[0] || 1e-6);
      if (tx > 0 && tx < 1.4) {
        const cz = b.p[2] + b.v[2] * tx, cy = b.p[1] + b.v[1] * tx - 0.5 * G * tx * tx;
        if (Math.abs(cz) < this.dim.gw / 2 + 0.6 && cy < this.dim.gh + 0.4) {
          const lateral = cz - p.pos[1];
          const reflex = 0.12 + (1 - lv) * 0.18;
          if (tx > reflex && Math.abs(lateral) > 0.7 && p.dive <= 0) {
            const sp = hyp(b.v[0], b.v[2]);
            const reach = clamp(1.05 - (sp - 14) * 0.025 - Math.abs(lateral) * 0.08 + lv * 0.15, 0.15, 0.95) * p.skill;
            const save = this.rand() < reach;
            const aimZ = save ? cz : cz - Math.sign(lateral) * (0.7 + this.rand() * 0.5);
            const t = Math.max(0.25, tx - 0.05);
            p.dive = 0.9;
            p.diveV = [((g[0] + d * 0.4 - p.pos[0]) / t) * 0.5, (aimZ - p.pos[1]) / t];
            // côté du plongeon vu du gardien (il fait face au jeu, vers +d)
            const right = (aimZ - p.pos[1]) * d < 0;
            this.setAction(p, right ? "diveright" : "diveleft");
            p.yaw = Math.atan2(d, 0);
            return;
          }
        }
      }
    }
    // ballon libre dans la surface, que le gardien atteint le premier : il sort le prendre
    const inBox = Math.abs(b.p[0] - g[0]) < this.dim.box[0] && Math.abs(b.p[2]) < this.dim.box[1] / 2;
    if (b.owner < 0 && inBox && b.p[1] < 2.4) {
      const mine = this.timeTo(p);
      let theirs = 1e9;
      for (const q of this.players) if (q.team !== p.team) theirs = Math.min(theirs, this.timeTo(q));
      if (mine < theirs + 0.2) {
        const t = this.interceptPoint(p);
        return this.runTo(p, t[0], t[1], 7);
      }
    }
    // placement : sur la bissectrice ballon – but, avancé selon la distance du ballon
    const bx = b.p[0], bz = b.p[2];
    const dist = hyp(bx - g[0], bz - g[1]);
    const out = clamp(dist * 0.1, 0.6, 5);
    const ux = (bx - g[0]) / (dist || 1), uz = (bz - g[1]) / (dist || 1);
    const tx = g[0] + ux * out, tz = clamp(g[1] + uz * out, -this.dim.gw / 2 - 0.3, this.dim.gw / 2 + 0.3);
    this.runTo(p, tx, tz, 4.5);
    // face au ballon
    if (hyp(tx - p.pos[0], tz - p.pos[1]) < 0.6) p.target = [bx, bz];
  }

  private runTo(p: Player, x: number, z: number, speed: number) {
    const dx = x - p.pos[0], dz = z - p.pos[1], l = hyp(dx, dz);
    p.target = [x, z];
    if (l < 0.25) return void (p.want = [0, 0]);
    const s = Math.min(speed * (0.94 + 0.08 * p.skill), l * 2.2);
    p.want = [(dx / l) * s, (dz / l) * s];
  }

  /* ---------------- gestes ---------------- */

  private setAction(p: Player, a: string, t0 = 0) {
    p.action = a;
    p.actionTime = t0;
  }

  /** Coup de pied : élan joué, contact différé (`lead` s), le ballon part à `v`. */
  private kick(i: number, v: [number, number, number], kind: string, to = -1, curl = 0) {
    const p = this.players[i];
    if (this.pending) return;
    // passe courte : élan écourté (contact rapide) ; tir : élan complet
    const lead = kind === "shot" ? 0.3 : kind === "throw" ? 0.45 : 0.17;
    this.setAction(p, kind === "throw" ? "throw" : "kick", kind === "shot" ? 0.08 : kind === "throw" ? 0 : 0.21);
    p.yaw = Math.atan2(v[0], v[2]);
    this.pending = { pl: i, v, curl, at: this.time + lead, kind, to };
    if (this.set && this.set.taker === i) {
      this.phase = "play";
      this.set = null;
    }
  }

  private stepPending() {
    const k = this.pending;
    if (!k || this.time < k.at) return;
    this.pending = null;
    const p = this.players[k.pl];
    const b = this.ball;
    const reach = hyp(b.p[0] - p.pos[0], b.p[2] - p.pos[1]);
    if (b.owner !== k.pl && (reach > 1.5 || p.down > 0)) return;
    b.owner = -1;
    b.v = [...k.v];
    b.curl = k.curl;
    if (k.kind === "throw") b.p = [p.pos[0] + Math.sin(p.yaw) * 0.3, 2.1, p.pos[1] + Math.cos(p.yaw) * 0.3];
    else if (b.p[1] < R + 0.01) b.p[1] = R + 0.02;
    b.last = k.pl;
    b.lastTeam = p.team;
    p.noTouch = 0.35;
    p.holding = 0;
    this.receiver = k.to;
    const sp = hyp(k.v[0], k.v[1], k.v[2]);
    this.emit("kick", { player: p.id, team: p.team, kind: k.kind, speed: Math.round(sp * 10) / 10 });
    if (k.kind === "shot") {
      this.shot = { by: k.pl, t: this.time, team: p.team };
      const g = this.oppGoal(p.team);
      const dist = hyp(g[0] - p.pos[0], g[1] - p.pos[1]);
      this.emit("shot", { player: p.id, team: p.team, speed: Math.round(sp), dist: Math.round(dist) });
      if (dist < 30 && sp > 16) this.emit("cine", { kind: "shot", player: p.id, at: [b.p[0], b.p[1], b.p[2]], goal: [g[0], 1, g[1]], dur: 1.2, slow: 0.3 });
    }
  }

  private shoot(i: number, power: number, aimZ: number) {
    const p = this.players[i];
    const lv = this.levelOf(p.team);
    const g = this.oppGoal(p.team);
    const dist = hyp(g[0] - p.pos[0], g[1] - p.pos[1]);
    // vise un côté du but ; l'erreur grandit avec la puissance, la pression et la distance
    const side = clamp(aimZ, -1, 1) * (this.dim.gw / 2 - 0.45);
    const err = (0.25 + power * power * 0.9 + (this.pressure(p) < 1.5 ? 0.6 : 0) + dist * 0.025) * (1.25 - 0.35 * (this.isHuman(i) ? 0.8 : lv)) / p.skill;
    const tz = side + (this.rand() - 0.5) * 2 * err;
    const ty = clamp(0.2 + power * 1.2 + (this.rand() - 0.35) * err * 1.2, 0.15, 3.2);
    const sp = 15 + power * 15;
    const dx = g[0] - p.pos[0], dz = tz - p.pos[1], dl = hyp(dx, dz) || 1;
    const t = dl / sp;
    const vy = (ty - R + 0.5 * G * t * t) / t;
    this.kick(i, [(dx / dl) * sp, Math.min(vy, 9), (dz / dl) * sp], "shot", -1, (this.rand() - 0.5) * 3 * power);
  }

  private passTo(i: number, j: number, lofted: boolean) {
    const p = this.players[i], q = this.players[j];
    const lead = 0.55;
    const tx = q.pos[0] + q.vel[0] * lead * 1.4, tz = q.pos[1] + q.vel[1] * lead * 1.4;
    this.passAt(i, [tx, tz], lofted, j);
  }

  private passAt(i: number, t: [number, number], lofted: boolean, to: number) {
    const p = this.players[i];
    const lv = this.isHuman(i) ? 0.85 : this.levelOf(p.team);
    const dx = t[0] - p.pos[0], dz = t[1] - p.pos[1], dist = hyp(dx, dz) || 1;
    const e = (1 - lv) * 0.08 + 0.02;
    const a = Math.atan2(dx, dz) + (this.rand() - 0.5) * e;
    if (this.set?.kind === "throwin" && this.set.taker === i) {
      // touche : à deux mains par-dessus la tête
      const T = clamp(dist / 12, 0.4, 1.2);
      return this.kick(i, [Math.sin(a) * (dist / T), (G * T) / 2 - 1, Math.cos(a) * (dist / T)], "throw", to);
    }
    if (lofted) {
      const T = clamp(dist / 16, 0.6, 2.4);
      const h = dist / T;
      this.kick(i, [Math.sin(a) * h, (G * T) / 2 * 0.92, Math.cos(a) * h], "lob", to);
    } else {
      // vitesse pour arriver avec ~4 m/s (freinage du roulement 1,7 m/s²)
      const sp = clamp(Math.sqrt(16 + 2 * 1.7 * dist) * (1 + (this.rand() - 0.5) * e), 6, 24);
      this.kick(i, [Math.sin(a) * sp, 0, Math.cos(a) * sp], "pass", to);
    }
  }

  /** Passe dans la direction indiquée (humain) : le coéquipier le mieux placé dans ce cône. */
  private passToward(i: number, aim: [number, number], lofted: boolean) {
    const p = this.players[i];
    const al = hyp(aim[0], aim[1]) || 1;
    const ax = aim[0] / al, az = aim[1] / al;
    let best = -1e9, bj = -1;
    this.players.forEach((q, j) => {
      if (q.team !== p.team || j === i) return;
      const dx = q.pos[0] - p.pos[0], dz = q.pos[1] - p.pos[1], dist = hyp(dx, dz) || 1;
      const cos = (dx * ax + dz * az) / dist;
      if (cos < 0.35) return;
      const s = cos * 20 - Math.abs(dist - (lofted ? 25 : 14)) * 0.5 + this.laneOpen(p.pos, q.pos, p.team) * (lofted ? 2 : 8);
      if (s > best) [best, bj] = [s, j];
    });
    if (bj >= 0) {
      if (lofted) {
        // ballon en profondeur : devant le receveur, dans le sens de l'attaque
        const q = this.players[bj];
        const d = this.dir(p.team);
        this.passAt(i, [q.pos[0] + d * 7, q.pos[1] + az * 3], true, bj);
      } else this.passTo(i, bj, false);
    } else this.passAt(i, [p.pos[0] + ax * (lofted ? 22 : 12), p.pos[1] + az * (lofted ? 22 : 12)], lofted, -1);
  }

  /** Tacle debout (proche) ou glissé (`slide`). */
  private tackle(i: number, aim: [number, number], slide = false): void {
    const p = this.players[i];
    if (p.down > 0 || p.slide > 0 || p.noTouch > 0.3) return;
    const b = this.ball;
    const al = hyp(aim[0], aim[1]) || 1;
    if (!slide) {
      const near = hyp(b.p[0] - p.pos[0], b.p[2] - p.pos[1]);
      if (near > 1.6) return this.tackle(i, aim, true);
      this.setAction(p, "fightkick", 0.1);
      p.noTouch = 0;
      if (b.owner >= 0 && this.players[b.owner].team !== p.team) {
        const o = this.players[b.owner];
        const win = 0.38 + 0.3 * (this.isHuman(i) ? 0.8 : this.levelOf(p.team)) - 0.18 * (o.skill - 0.9) * 4;
        if (this.rand() < win) {
          b.owner = -1;
          b.v = [(aim[0] / al) * 5 + (this.rand() - 0.5) * 3, 0.5, (aim[1] / al) * 5 + (this.rand() - 0.5) * 3];
          o.noTouch = 0.5;
          b.last = i;
          b.lastTeam = p.team;
          this.emit("tackle", { player: p.id, team: p.team, won: true });
        } else {
          p.down = 0.45;
          this.emit("tackle", { player: p.id, team: p.team, won: false });
        }
      }
      return;
    }
    p.slide = 0.75;
    p.slideDir = [aim[0] / al, aim[1] / al];
    p.yaw = Math.atan2(p.slideDir[0], p.slideDir[1]);
    this.setAction(p, "tackle");
  }

  /* ---------------- mouvement ---------------- */

  private movePlayers(dt: number) {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.noTouch = Math.max(0, p.noTouch - dt);
      p.actionTime += dt;
      let vx = p.want[0], vz = p.want[1];
      let acc = 11;
      if (p.slide > 0) {
        p.slide -= dt;
        const s = 7.5 * Math.max(0, p.slide / 0.75) + 0.5;
        vx = p.slideDir[0] * s;
        vz = p.slideDir[1] * s;
        acc = 60;
        if (p.slide <= 0) {
          p.down = 0.55;
          p.slide = 0;
        }
      } else if (p.dive > 0) {
        p.dive -= dt;
        vx = p.diveV[0] * Math.max(0, (p.dive - 0.35) / 0.55);
        vz = p.diveV[1] * Math.max(0, (p.dive - 0.35) / 0.55);
        acc = 80;
        if (p.dive <= 0) {
          p.dive = 0;
          p.down = 0.5;
        }
      } else if (p.down > 0) {
        p.down -= dt;
        vx = vz = 0;
        acc = 14;
        if (p.down <= 0 && (p.action === "fall" || p.action === "tackle" || p.action.startsWith("dive"))) this.setAction(p, "idle");
      }
      const k = Math.min(1, acc * dt / Math.max(0.5, hyp(vx - p.vel[0], vz - p.vel[1])));
      p.vel[0] += (vx - p.vel[0]) * k;
      p.vel[1] += (vz - p.vel[1]) * k;
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      // cap : vers la course, sinon vers le ballon (ou la cible)
      const sp = hyp(p.vel[0], p.vel[1]);
      if (p.slide <= 0 && p.dive <= 0 && p.down <= 0 && !(p.action === "kick" && p.actionTime < 0.5)) {
        const b = this.ball;
        const want = sp > 1 ? Math.atan2(p.vel[0], p.vel[1]) : Math.atan2(b.p[0] - p.pos[0], b.p[2] - p.pos[1]);
        const dy = wrap(want - p.yaw);
        p.yaw = wrap(p.yaw + clamp(dy, -dt * 9, dt * 9));
      }
      // fin des gestes courts
      if ((p.action === "kick" && p.actionTime > 0.7) || (p.action === "fightkick" && p.actionTime > 0.6) || (p.action === "throw" && p.actionTime > 1.0) || (p.action === "header" && p.actionTime > 0.8) || (p.action === "jump" && p.actionTime > 0.9)) this.setAction(p, "idle");
      if (p.action === "carry" && p.holding <= 0) this.setAction(p, "idle");
      // bords : un peu de marge derrière les lignes
      p.pos[0] = clamp(p.pos[0], -this.dim.L / 2 - 4, this.dim.L / 2 + 4);
      p.pos[1] = clamp(p.pos[1], -this.dim.W / 2 - 3, this.dim.W / 2 + 3);
    }
    // personne ne se traverse : séparation des corps (rayon 0,4 m), le joueur au sol pèse plus
    for (let i = 0; i < this.players.length; i++)
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i], c = this.players[j];
        const dx = c.pos[0] - a.pos[0], dz = c.pos[1] - a.pos[1], d = hyp(dx, dz);
        const min = a.down > 0 || c.down > 0 ? 0.6 : 0.75;
        if (d < min && d > 1e-4) {
          const push = (min - d) / 2;
          const wa = a.down > 0 || a.dive > 0 ? 0.2 : 1, wc = c.down > 0 || c.dive > 0 ? 0.2 : 1;
          const s = wa + wc;
          a.pos[0] -= (dx / d) * push * 2 * (wa / s);
          a.pos[1] -= (dz / d) * push * 2 * (wa / s);
          c.pos[0] += (dx / d) * push * 2 * (wc / s);
          c.pos[1] += (dz / d) * push * 2 * (wc / s);
        }
      }
  }

  /* ---------------- ballon ---------------- */

  private stepBall(dt: number) {
    const b = this.ball;
    if (b.owner >= 0) return this.dribble(dt);
    const n = Math.max(1, Math.ceil((hyp(b.v[0], b.v[1], b.v[2]) * dt) / 0.08));
    const h = dt / n;
    const { L, W, gw, gh } = this.dim;
    for (let s = 0; s < n; s++) {
      const sp = hyp(b.v[0], b.v[1], b.v[2]);
      // traînée de l'air et effet (le ballon brossé tourne : force latérale)
      const drag = 0.011 * sp;
      for (let k = 0; k < 3; k++) b.v[k] -= b.v[k] * drag * h;
      if (b.curl && b.p[1] > R + 0.02) {
        const hs = hyp(b.v[0], b.v[2]) || 1;
        b.v[0] += (b.v[2] / hs) * b.curl * h;
        b.v[2] += (-b.v[0] / hs) * b.curl * h;
      }
      b.v[1] -= G * h;
      const ox = b.p[0], oz = b.p[2];
      b.p[0] += b.v[0] * h;
      b.p[1] += b.v[1] * h;
      b.p[2] += b.v[2] * h;
      if (b.p[1] <= R) {
        b.p[1] = R;
        if (b.v[1] < -1.2) {
          if (b.v[1] < -2.5) this.emit("bounce", { speed: Math.round(-b.v[1] * 10) / 10 });
          b.v[1] = -b.v[1] * 0.55;
          b.v[0] *= 0.86;
          b.v[2] *= 0.86;
          b.curl *= 0.5;
        } else b.v[1] = 0;
      }
      if (b.p[1] <= R + 0.01) {
        const hs = hyp(b.v[0], b.v[2]);
        const k = hs > 0 ? Math.max(0, hs - 1.7 * h) / hs : 0;
        b.v[0] *= k;
        b.v[2] *= k;
        b.curl = 0;
      }
      // poteaux et barre : cylindres de 6 cm
      for (const gx of [L / 2, -L / 2]) {
        for (const pz of [gw / 2 + 0.06, -gw / 2 - 0.06]) {
          if (b.p[1] > gh + 0.1) continue;
          const dx = b.p[0] - gx, dz = b.p[2] - pz, d = hyp(dx, dz);
          if (d < R + 0.06) {
            const nx = dx / (d || 1), nz = dz / (d || 1);
            const vn = b.v[0] * nx + b.v[2] * nz;
            if (vn < 0) {
              b.v[0] -= 1.7 * vn * nx;
              b.v[2] -= 1.7 * vn * nz;
              b.p[0] = gx + nx * (R + 0.07);
              b.p[2] = pz + nz * (R + 0.07);
              if (-vn > 6) this.post(b);
            }
          }
        }
        if (Math.abs(b.p[2]) < gw / 2 + 0.06) {
          const dx = b.p[0] - gx, dy = b.p[1] - (gh + 0.06), d = hyp(dx, dy);
          if (d < R + 0.06) {
            const nx = dx / (d || 1), ny = dy / (d || 1);
            const vn = b.v[0] * nx + b.v[1] * ny;
            if (vn < 0) {
              b.v[0] -= 1.7 * vn * nx;
              b.v[1] -= 1.7 * vn * ny;
              b.p[0] = gx + nx * (R + 0.07);
              b.p[1] = gh + 0.06 + ny * (R + 0.07);
              if (-vn > 6) this.post(b);
            }
          }
        }
      }
      // filets : le ballon entré dans le but est freiné et retenu (profondeur 2 m)
      const side = Math.sign(b.p[0]);
      const inside = Math.abs(b.p[0]) > L / 2 && Math.abs(b.p[2]) < gw / 2 && b.p[1] < gh;
      const wasIn = Math.abs(ox) > L / 2 && Math.abs(oz) < gw / 2;
      if (inside || (wasIn && Math.abs(b.p[0]) > L / 2)) {
        const back = L / 2 + 1.8;
        if (Math.abs(b.p[0]) > back) {
          b.p[0] = side * back;
          b.v[0] *= -0.15;
          b.v[2] *= 0.4;
          b.v[1] *= 0.4;
        }
        if (Math.abs(b.p[2]) > gw / 2 - R) {
          b.p[2] = Math.sign(b.p[2]) * (gw / 2 - R);
          b.v[2] *= -0.15;
        }
        if (b.p[1] > gh - R) {
          b.p[1] = gh - R;
          b.v[1] = Math.min(0, b.v[1]) * 0.2;
        }
      }
    }
    b.p[0] = clamp(b.p[0], -L / 2 - 6, L / 2 + 6);
    b.p[2] = clamp(b.p[2], -W / 2 - 5, W / 2 + 5);
  }

  private post(b: Ball) {
    if (this.time - (this.lastPost ?? -9) < 0.5) return;
    this.lastPost = this.time;
    this.emit("post", { x: b.p[0], z: b.p[2] });
    this.emit("cine", { kind: "post", at: [b.p[0], b.p[1], b.p[2]], dur: 0.9, slow: 0.35 });
  }
  private lastPost?: number;
  private gotAt = 0;

  /** Conduite de balle : le ballon reste devant le pied, poussé à chaque foulée. */
  private dribble(dt: number) {
    const b = this.ball;
    const p = this.players[b.owner];
    if (p.holding > 0) {
      // dans les mains du gardien
      b.p = [p.pos[0] + Math.sin(p.yaw) * 0.32, 1.05, p.pos[1] + Math.cos(p.yaw) * 0.32];
      b.v = [p.vel[0], 0, p.vel[1]];
      return;
    }
    const sp = hyp(p.vel[0], p.vel[1]);
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const touch = (this.time * (1.2 + sp * 0.18) + p.num * 0.37) % 1;
    const ahead = 0.45 + Math.min(1, sp / 7) * (0.35 + 0.55 * (1 - touch));
    const tx = p.pos[0] + fx * ahead, tz = p.pos[1] + fz * ahead;
    const k = 1 - Math.exp(-dt * 14);
    const nx = b.p[0] + (tx - b.p[0]) * k, nz = b.p[2] + (tz - b.p[2]) * k;
    b.v = [(nx - b.p[0]) / dt, 0, (nz - b.p[2]) / dt];
    b.p = [nx, R, nz];
  }

  /** Prises de balle, tacles glissés, têtes, arrêts du gardien. */
  private touches(dt: number) {
    const b = this.ball;
    if (this.phase === "setpiece") return;
    // glissades : le pied balaie le ballon, ou fauche l'adversaire (faute)
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.slide <= 0) continue;
      const fx = p.pos[0] + p.slideDir[0] * 0.7, fz = p.pos[1] + p.slideDir[1] * 0.7;
      if (hyp(b.p[0] - fx, b.p[2] - fz) < 0.75 && b.p[1] < 0.6 && !(b.owner >= 0 && this.players[b.owner].team === p.team)) {
        const o = b.owner;
        b.owner = -1;
        const a = Math.atan2(p.slideDir[0], p.slideDir[1]) + (this.rand() - 0.5) * 0.8;
        b.v = [Math.sin(a) * 7, 1.2, Math.cos(a) * 7];
        b.last = i;
        b.lastTeam = p.team;
        p.slide = Math.min(p.slide, 0.3);
        if (o >= 0) {
          this.players[o].noTouch = 0.6;
          if (this.rand() < 0.4) this.fall(o);
          this.emit("tackle", { player: p.id, team: p.team, won: true, slide: true });
          this.emit("cine", { kind: "tackle", player: p.id, at: [p.pos[0], 0.5, p.pos[1]], dur: 0.9, slow: 0.3 });
        }
        continue;
      }
      for (let j = 0; j < this.players.length; j++) {
        const q = this.players[j];
        if (q.team === p.team || q.down > 0 || q.role === "gk") continue;
        if (hyp(q.pos[0] - fx, q.pos[1] - fz) < 0.6 && hyp(b.p[0] - fx, b.p[2] - fz) > 0.75) {
          this.fall(j);
          p.slide = Math.min(p.slide, 0.25);
          if (b.owner === j || hyp(b.p[0] - q.pos[0], b.p[2] - q.pos[1]) < 3) this.foul(i, j);
          break;
        }
      }
    }
    if (this.phase !== "play") return;
    if (b.owner >= 0) return;
    // ballon libre : le premier qui l'atteint le contrôle (amorti), ou le reprend de la tête s'il est haut
    let best = 1e9, bi = -1;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.noTouch > 0 || p.down > 0 || p.slide > 0) continue;
      const d = hyp(b.p[0] - p.pos[0], b.p[2] - p.pos[1]);
      const gk = p.role === "gk" && this.inOwnBox(p, b.p[0], b.p[2]);
      const reach = p.dive > 0 ? 1.4 : gk ? 0.95 : 0.7;
      const top = p.dive > 0 ? 1.6 : gk ? 2.5 : 2.3;
      if (d < reach && b.p[1] < top && d < best) [best, bi] = [d, i];
    }
    if (bi < 0) return;
    const p = this.players[bi];
    const gk = p.role === "gk" && this.inOwnBox(p, b.p[0], b.p[2]);
    const sp = hyp(b.v[0], b.v[1], b.v[2]);
    const shotFlying = this.shot && this.time - this.shot.t < 2.5 && this.shot.team !== p.team;
    if (gk) {
      const catchIt = sp < 17 + 6 * p.skill || this.rand() < 0.35;
      if (catchIt) {
        b.owner = bi;
        p.holding = 0.01;
        // le gardien qui capte le ballon reste devant sa ligne
        const g = this.ownGoal(p.team);
        if ((p.pos[0] - g[0]) * this.dir(p.team) < 0.5) p.pos[0] = g[0] + this.dir(p.team) * 0.5;
        p.yaw = Math.atan2(this.dir(p.team), 0);
        this.setAction(p, "carry");
      } else {
        // parade : le ballon repart vers le côté et vers l'avant
        const d = this.dir(p.team);
        b.v = [d * (3 + this.rand() * 5), 2 + this.rand() * 3, Math.sign(b.p[2] - p.pos[1] || 1) * (4 + this.rand() * 4)];
        b.owner = -1;
        p.noTouch = 0.6;
      }
      b.last = bi;
      b.lastTeam = p.team;
      if (shotFlying) {
        this.emit("save", { player: p.id, team: p.team, caught: catchIt });
        this.emit("cine", { kind: "save", player: p.id, at: [p.pos[0], 1, p.pos[1]], dur: 1.1, slow: 0.35 });
        this.shot = null;
      }
      this.receiver = -1;
      return;
    }
    if (b.p[1] > 1.25) {
      // tête : vers le but si proche, sinon dégagement vers l'avant
      const g = this.oppGoal(p.team);
      const d = this.dir(p.team);
      const near = hyp(g[0] - p.pos[0], g[1] - p.pos[1]) < 16;
      const tz = near ? (this.rand() - 0.5) * this.dim.gw * 0.9 : p.pos[1] + (this.rand() - 0.5) * 10;
      const tx = near ? g[0] : p.pos[0] + d * 15;
      const dx = tx - b.p[0], dz = tz - b.p[2], dl = hyp(dx, dz) || 1;
      const s = near ? 13 : 11;
      b.v = [(dx / dl) * s, near ? 1 : 4, (dz / dl) * s];
      b.last = bi;
      b.lastTeam = p.team;
      p.noTouch = 0.4;
      this.setAction(p, "header");
      this.receiver = -1;
      this.emit("header", { player: p.id, team: p.team });
      if (near) {
        this.shot = { by: bi, t: this.time, team: p.team };
        this.emit("cine", { kind: "shot", player: p.id, at: [b.p[0], b.p[1], b.p[2]], goal: [g[0], 1, g[1]], dur: 1, slow: 0.3 });
      }
      return;
    }
    // contrôle : un ballon trop rapide rebondit parfois sur le joueur
    if (sp > 16 && this.rand() < 0.5) {
      b.v = [b.v[0] * -0.25 + (this.rand() - 0.5) * 3, 0.6, b.v[2] * -0.25 + (this.rand() - 0.5) * 3];
      b.last = bi;
      b.lastTeam = p.team;
      p.noTouch = 0.3;
      return;
    }
    const prevTeam = b.lastTeam;
    this.gotAt = this.time;
    b.owner = bi;
    b.last = bi;
    b.lastTeam = p.team;
    b.curl = 0;
    this.receiver = -1;
    if (prevTeam !== p.team && prevTeam !== -1) this.emit("possession", { team: p.team, player: p.id });
    if (this.shot && this.shot.team !== p.team) this.shot = null;
  }

  private inOwnBox(p: Player, x: number, z: number): boolean {
    const g = this.ownGoal(p.team);
    return Math.abs(x - g[0]) < this.dim.box[0] && Math.abs(z) < this.dim.box[1] / 2;
  }

  private fall(j: number) {
    const q = this.players[j];
    q.down = 1.5;
    this.setAction(q, "fall");
    if (this.ball.owner === j) this.ball.owner = -1;
  }

  private foul(by: number, on: number) {
    const p = this.players[by], q = this.players[on];
    this.emit("foul", { player: p.id, team: p.team, on: q.id });
    // dans la surface de celui qui a fauté : penalty
    const pen = this.inOwnBox(p, q.pos[0], q.pos[1]);
    if (pen) {
      const g = this.ownGoal(p.team);
      return this.setPiece("penalty", q.team, [g[0] - Math.sign(g[0]) * this.dim.spot, 0]);
    }
    this.emit("cine", { kind: "tackle", player: p.id, at: [q.pos[0], 0.5, q.pos[1]], dur: 1.2, slow: 0.3 });
    this.setPiece("freekick", q.team, [clamp(q.pos[0], -this.dim.L / 2 + 1, this.dim.L / 2 - 1), clamp(q.pos[1], -this.dim.W / 2 + 1, this.dim.W / 2 - 1)]);
  }

  /* ---------------- règles ---------------- */

  private rules() {
    if (this.phase !== "play") return;
    const b = this.ball;
    const { L, W, gw, gh } = this.dim;
    if (b.owner >= 0) {
      const p = this.players[b.owner];
      // conduite hors du terrain
      if (Math.abs(b.p[2]) > W / 2 + R || Math.abs(b.p[0]) > L / 2 + R) {
        b.owner = -1;
        b.lastTeam = p.team;
      } else return;
    }
    // but : ballon entièrement derrière la ligne, entre les poteaux, sous la barre
    if (Math.abs(b.p[0]) > L / 2 + R && Math.abs(b.p[2]) < gw / 2 && b.p[1] < gh) {
      const side = Math.sign(b.p[0]);
      const scorer = side === this.dir(0) ? 0 : 1;
      this.score[scorer]++;
      this.goalTeam = scorer as 0 | 1;
      const by = b.last >= 0 ? this.players[b.last] : null;
      const own = !!by && by.team !== scorer;
      this.phase = "goal";
      this.phaseT = 0;
      this.pending = null;
      this.set = null;
      this.receiver = -1;
      this.emit("goal", { team: scorer, player: by?.id ?? null, own, score: [...this.score], minute: this.minute });
      if (this.spec.cinematics) this.emit("cine", { kind: "goal", team: scorer, player: by?.id ?? null, at: [b.p[0], b.p[1], b.p[2]], dur: 7 });
      this.shot = null;
      return;
    }
    // sortie
    if (Math.abs(b.p[2]) > W / 2 + R) {
      const team = (b.lastTeam === 0 ? 1 : 0) as 0 | 1;
      if (this.ending) return this.endHalf();
      return this.setPiece("throwin", team, [clamp(b.p[0], -L / 2 + 0.5, L / 2 - 0.5), Math.sign(b.p[2]) * (W / 2)]);
    }
    if (Math.abs(b.p[0]) > L / 2 + R) {
      const side = Math.sign(b.p[0]);
      // côté défendu par l'équipe dont c'est le but
      const defender = (this.ownGoal(0)[0] * side > 0 ? 0 : 1) as 0 | 1;
      if (this.ending) return this.endHalf();
      if (b.lastTeam === defender) return this.setPiece("corner", (defender === 0 ? 1 : 0) as 0 | 1, [side * (L / 2), Math.sign(b.p[2] || 1) * (W / 2)]);
      this.emit("miss", { team: defender === 0 ? 1 : 0 });
      return this.setPiece("goalkick", defender, [side * (L / 2 - this.dim.six[0] || L / 2 - 3), side * 0 + (b.p[2] > 0 ? 3 : -3)]);
    }
  }

  private setPiecePlace(i: number) {
    const s = this.set!;
    const p = this.players[i];
    const d = this.dir(p.team);
    if (i === s.taker) {
      // derrière le ballon, face au jeu
      const g = this.oppGoal(p.team);
      let fx = g[0] - s.spot[0], fz = g[1] - s.spot[1];
      if (s.kind === "throwin") [fx, fz] = [d * 0.4, -Math.sign(s.spot[1])];
      if (s.kind === "corner") [fx, fz] = [-Math.sign(s.spot[0]) * 0.6, -Math.sign(s.spot[1])];
      const fl = hyp(fx, fz) || 1;
      const back = s.kind === "throwin" ? 0.25 : s.kind === "penalty" ? 2.2 : 0.75;
      const tx = s.spot[0] - (fx / fl) * back, tz = s.spot[1] - (fz / fl) * back;
      this.runTo(p, tx, tz, 6.5);
      if (hyp(tx - p.pos[0], tz - p.pos[1]) < 0.4) {
        p.want = [0, 0];
        p.yaw = Math.atan2(fx, fz);
      }
      return;
    }
    let [hx, hz] = this.toWorld(p.team, p.home[0], p.home[1]);
    if (p.role === "gk") {
      const g = this.ownGoal(p.team);
      if (s.kind === "penalty" && s.team !== p.team) return this.runTo(p, g[0] - Math.sign(g[0]) * 0.3, 0, 3);
      hx = g[0] + d * 2;
      hz = 0;
    } else if (s.kind === "corner" || (s.kind === "freekick" && Math.abs(s.spot[0]) > this.dim.L / 2 - 30)) {
      // ballon arrêté près d'un but : attaquants et défenseurs dans la surface
      const gx = Math.sign(s.spot[0]) * (this.dim.L / 2);
      const k = (p.num * 0.6180339) % 1;
      const att = p.team === s.team;
      if (p.role !== "def" || !att) {
        hx = gx - Math.sign(gx) * (att ? 6 + k * 8 : 3 + k * 8);
        hz = (k - 0.5) * this.dim.box[1] * 0.7;
      }
    } else if (s.kind === "penalty") {
      const gx = Math.sign(s.spot[0]) * (this.dim.L / 2);
      hx = gx - Math.sign(gx) * (this.dim.box[0] + 2 + ((p.num * 0.37) % 1) * 6);
      hz = ((p.num * 0.618) % 1 - 0.5) * this.dim.box[1];
    } else {
      hx = hx * 0.6 + s.spot[0] * 0.4;
      hz = hz * 0.8 + s.spot[1] * 0.25;
    }
    // l'adversaire à distance du ballon
    if (p.team !== s.team && s.kind !== "kickoff") {
      const dd = hyp(hx - s.spot[0], hz - s.spot[1]);
      const min = s.kind === "throwin" ? 3 : 9.15 * (this.dim.L / 105);
      if (dd < min) {
        hx = s.spot[0] + ((hx - s.spot[0]) / (dd || 1)) * min;
        hz = s.spot[1] + ((hz - s.spot[1]) / (dd || 1)) * min;
      }
    }
    if (s.kind === "kickoff") return void (p.want = [0, 0]);
    hx = clamp(hx, -this.dim.L / 2 + 0.5, this.dim.L / 2 - 0.5);
    hz = clamp(hz, -this.dim.W / 2 + 0.5, this.dim.W / 2 - 0.5);
    const far = hyp(hx - p.pos[0], hz - p.pos[1]);
    this.runTo(p, hx, hz, far > 6 ? 6 : 3);
  }

  private stepSetPiece(dt: number) {
    const s = this.set!;
    s.t += dt;
    const p = this.players[s.taker];
    const b = this.ball;
    // le tireur rejoint le ballon (téléporté s'il traîne : le jeu ne doit pas s'enliser)
    const near = hyp(b.p[0] - p.pos[0], b.p[2] - p.pos[1]) < (s.kind === "penalty" ? 2.8 : 1.3);
    if (!near && s.t > 3.5) {
      p.pos = [b.p[0] - Math.sign(b.p[0] || 1) * 0.6, b.p[2] - Math.sign(b.p[2] || 1) * 0.3];
    }
    if (!s.ready && near && s.t > (s.kind === "kickoff" ? 0.6 : s.kind === "penalty" ? 2.6 : 1.3)) s.ready = true;
    if (!s.ready) return;
    if (s.kind === "throwin" || (s.kind === "goalkick" && p.role === "gk")) {
      // ballon dans les mains au-dessus de la tête (touche)
      if (s.kind === "throwin") b.p = [p.pos[0], 2.05, p.pos[1]];
    }
    const human = this.isHuman(s.taker);
    if (human && s.t < 8) return; // l'humain choisit (passe, tir, ballon long) ; au bout de 8 s, l'IA joue pour lui
    if (s.t < (s.kind === "penalty" ? 3.2 : 1.6)) return;
    const d = this.dir(p.team);
    b.owner = s.taker;
    switch (s.kind) {
      case "kickoff": {
        const mate = this.players.map((q, j) => [q, j] as const).filter(([q, j]) => q.team === p.team && j !== s.taker && q.role !== "gk").sort((a, c) => hyp(a[0].pos[0], a[0].pos[1]) - hyp(c[0].pos[0], c[0].pos[1]))[0];
        return this.passTo(s.taker, mate[1], false);
      }
      case "penalty":
        return this.shoot(s.taker, 0.75 + this.rand() * 0.2, this.rand() < 0.5 ? -0.8 : 0.8);
      case "corner": {
        const gx = Math.sign(s.spot[0]) * (this.dim.L / 2);
        return this.passAt(s.taker, [gx - Math.sign(gx) * (this.dim.spot * 0.8 + this.rand() * 4), (this.rand() - 0.5) * 8], true, -1);
      }
      case "throwin": {
        let best = 1e9, bj = -1;
        this.players.forEach((q, j) => {
          if (q.team !== p.team || j === s.taker || q.role === "gk") return;
          const dd = hyp(q.pos[0] - p.pos[0], q.pos[1] - p.pos[1]);
          const sc = Math.abs(dd - 9) - this.pressure(q);
          if (sc < best) [best, bj] = [sc, j];
        });
        const q = this.players[bj];
        const dx = q.pos[0] - p.pos[0], dz = q.pos[1] - p.pos[1], dl = hyp(dx, dz) || 1;
        const T = clamp(dl / 12, 0.4, 1.2);
        return this.kick(s.taker, [(dx / dl) * (dl / T), (G * T) / 2 - 1, (dz / dl) * (dl / T)], "throw", bj);
      }
      default: {
        // sortie de but, coup franc : passe vers l'avant, longue si personne n'est libre près
        let best = -1e9, bj = -1;
        this.players.forEach((q, j) => {
          if (q.team !== p.team || j === s.taker || q.role === "gk") return;
          const sc = (q.pos[0] - p.pos[0]) * d * 0.3 + this.pressure(q) * 1.5 - Math.abs(hyp(q.pos[0] - p.pos[0], q.pos[1] - p.pos[1]) - 20) * 0.2;
          if (sc > best) [best, bj] = [sc, j];
        });
        const g = this.oppGoal(p.team);
        if (s.kind === "freekick" && hyp(g[0] - s.spot[0], g[1] - s.spot[1]) < 28 && this.rand() < 0.6) return this.shoot(s.taker, 0.8, this.rand() < 0.5 ? -0.85 : 0.85);
        return this.passTo(s.taker, bj, s.kind === "goalkick" || hyp(this.players[bj].pos[0] - p.pos[0], this.players[bj].pos[1] - p.pos[1]) > 22);
      }
    }
  }

  /** Arrêt de jeu humain sur un coup de pied arrêté : la passe, le tir ou le ballon long partent du tireur. */
  setPieceHuman(kind: "pass" | "shoot" | "lob", aim: [number, number]) {
    const s = this.set;
    if (!s || !s.ready) return;
    this.ball.owner = s.taker;
    if (kind === "shoot") this.shoot(s.taker, 0.85, aim[1]);
    else this.passToward(s.taker, aim, kind === "lob");
  }

  /* ---------------- ambiance ---------------- */

  private animateIdle(dt: number) {
    for (const p of this.players) {
      p.vel = [0, 0];
      p.actionTime += dt;
      p.want = [0, 0];
    }
  }

  private celebrate(dt: number, team: number) {
    // les buteurs courent vers le poteau de corner en criant, les autres baissent la tête et regagnent leur place
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.actionTime += dt;
      if (team >= 0 && p.team === team) {
        const g = this.oppGoal(p.team);
        const cx = g[0] - Math.sign(g[0]) * 8, cz = Math.sign(this.ball.p[2] || 1) * (this.dim.W / 2 - 6);
        const scorer = this.ball.last === i;
        const tx = scorer ? cx : cx - Math.sign(g[0]) * (2 + (p.num % 4) * 1.3), tz = scorer ? cz : cz - Math.sign(cz) * ((p.num % 3) * 1.4);
        if (p.role === "gk") {
          p.want = [0, 0];
          if (p.action !== "cheer") this.setAction(p, "cheer");
        } else {
          const dd = hyp(tx - p.pos[0], tz - p.pos[1]);
          if (dd > 1.2) {
            this.runTo(p, tx, tz, scorer ? 7 : 6.5);
            if (p.action !== "idle" && p.action !== "cheer") this.setAction(p, "idle");
            if (scorer && p.action !== "cheer") this.setAction(p, "cheer");
          } else {
            p.want = [0, 0];
            if (p.action !== "cheer" && p.action !== "jump") this.setAction(p, (p.num + Math.floor(this.time)) % 3 === 0 ? "jump" : "cheer");
            else if (p.action === "jump" && p.actionTime > 0.9) this.setAction(p, "cheer");
          }
        }
      } else {
        p.want = [p.vel[0] * 0.5, p.vel[1] * 0.5];
        if (p.action !== "idle" && p.action !== "think") this.setAction(p, p.num % 2 ? "think" : "idle");
      }
      p.down = p.slide = p.dive = p.holding = 0;
    }
    this.movePlayers(dt);
  }

  /** Résumé publié (tableau d'affichage). */
  summary() {
    return {
      phase: this.phase,
      half: this.half,
      minute: this.minute,
      score: [...this.score],
      teams: this.spec.teams.map((t) => t.name),
      possession: this.ball.owner >= 0 ? this.players[this.ball.owner].team : this.ball.lastTeam,
      ctrl: this.ctrl >= 0 ? this.players[this.ctrl].id : null,
      set: this.set ? { kind: this.set.kind, team: this.set.team, ready: this.set.ready } : null,
    };
  }
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** Recette de stade pour `sonic-procgen` : terrain, buts, tribunes, panneaux, joueurs aux couleurs des équipes. */
export function footballRecipe(spec: FootballSpec): Record<string, unknown> {
  const dim = pitchSize(spec.side);
  const { L, W } = dim;
  const margin = spec.side >= 11 ? 9 : 6;
  const stand = spec.side >= 11;
  // place pour les tribunes (10 rangs de 0,85 m) derrière les panneaux
  const sx = L + 2 * margin + (stand ? 34 : 4), sz = W + 2 * margin + (stand ? 34 : 4);
  const actors: Record<string, unknown> = {};
  const form = FORMATIONS[spec.side];
  for (const team of [0, 1] as const) {
    const t = spec.teams[team];
    form.forEach(([role, hx, hz], i) => {
      const gk = role === "gk";
      const seed = spec.seed * 101 + team * 31 + i * 7;
      actors[`${team ? "b" : "a"}${i + 1}`] = {
        at: [hx * (team ? -1 : 1) * (L / 2), hz * (W / 2)],
        params: {
          archetype: "realistic",
          seed,
          top: gk ? "long" : "tee",
          bottom: "shorts",
          shoes: "shoes",
          hat: "none",
          item: "none",
          bag: "none",
          over: "none",
          glasses: "none",
          belt: "none",
          details: "none",
          collar: "round",
          gloves: gk ? "gloves" : "none",
          pattern: gk ? "plain" : t.pattern,
          age: "adult",
          beard: i % 4 === 1 ? "stubble" : "auto",
          colors: { top: gk ? t.keeper : t.shirt, bottom: t.shorts, detail: t.pattern === "plain" ? t.socks : t.shorts, leather: "#1a1a1a" },
        },
      };
    });
  }
  const layers: unknown[] = [
    { id: "terrain", gen: "sport.pitch", place: { at: [{ x: 0, z: 0, yaw: 0 }] }, params: { length: L, width: W, goalWidth: dim.gw, box: dim.box[0], boxWidth: dim.box[1], six: dim.six[0], sixWidth: dim.six[1], spot: dim.spot, circle: dim.circle, boards: stand, margin } },
    { id: "buts", gen: "sport.goal", place: { at: [{ x: L / 2, z: 0, yaw: 90 }, { x: -L / 2, z: 0, yaw: -90 }] }, params: { width: dim.gw, height: dim.gh } },
    { id: "ballon", gen: "ball.soccer", place: { at: [{ x: 0, z: 0 }] } },
  ];
  if (stand) {
    const off = margin + 5;
    layers.push({ id: "tribunes", gen: "sport.stand", place: { at: [{ x: 0, z: -(W / 2 + off), yaw: 0 }, { x: 0, z: W / 2 + off, yaw: 180 }, { x: L / 2 + off, z: 0, yaw: -90 }, { x: -(L / 2 + off), z: 0, yaw: 90 }] }, params: { length: "= i < 2 ? " + (L + 8) + " : " + (W + 8), rows: 10, color1: spec.teams[0].shirt, color2: spec.teams[1].shirt } });
  }
  return {
    size: [sx, sz],
    seed: spec.seed,
    ground: { relief: 0, surface: "grass" },
    layers,
    actors,
    view: { camera: "perspective", yaw: 0, pitch: 62, zoom: 3.2, cx: 0, cy: 0, cz: 0, fov: 34 },
    wind: 0.4,
  };
}
