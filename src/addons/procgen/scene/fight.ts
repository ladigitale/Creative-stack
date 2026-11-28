/**
 * Combat (jeu de baston, CPU, pur, testé sans rendu) : deux combattants face à face sur un axe (2,5D), coups de
 * poing enchaînés, coups de pied, coups d'épée (si le combattant en tient une), garde, sauts, projections au sol,
 * barres de vie, manches au meilleur de N, chrono, adversaire géré par la machine (niveau réglable) ou second joueur.
 *
 * Le moteur est l'autorité : il tient position, hauteur, cap, vie et geste de chaque combattant ; le rendu
 * (`render/fight.ts`) pose les personnages de la scène là où il les met (marionnettes) avec le temps de geste qui
 * montre le bon coup. Les coups sont calés sur les gestes `punch` (0,8 s par coup), `fightkick` (1,2 s) et `sword`
 * (1 s) des personnages.
 */

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Un coup : geste affiché et début dans son cycle, fenêtre de touche, durée, portée, dégâts, effet. */
export type Move = {
  id: string;
  action: "punch" | "fightkick" | "sword" | "knee" | "elbow" | "spinkick";
  /** Début du coup dans le cycle du geste (s). */
  at: number;
  /** Fenêtre active (s depuis le début du coup) et durée totale avant de pouvoir rejouer. */
  on: number;
  off: number;
  total: number;
  /** Portée (m, entre les centres), dégâts, recul infligé (m/s), temps de sonnage (s). */
  range: number;
  damage: number;
  push: number;
  stun: number;
  /** Met au sol. */
  down?: boolean;
  /** Coup suivant de l'enchaînement (même touche dans la fenêtre). */
  next?: string;
  /** Hauteur visée : haut, milieu (un saut l'évite), bas. */
  level: "high" | "mid";
};

export const MOVES: Record<string, Move> = {
  jab: { id: "jab", action: "punch", at: 0, on: 0.12, off: 0.26, total: 0.42, range: 1.0, damage: 5, push: 0.7, stun: 0.32, next: "cross", level: "high" },
  cross: { id: "cross", action: "punch", at: 0.8, on: 0.12, off: 0.26, total: 0.48, range: 1.05, damage: 7, push: 0.8, stun: 0.34, next: "hook", level: "high" },
  hook: { id: "hook", action: "punch", at: 1.6, on: 0.16, off: 0.3, total: 0.55, range: 1.0, damage: 9, push: 0.9, stun: 0.38, next: "uppercut", level: "high" },
  uppercut: { id: "uppercut", action: "punch", at: 2.4, on: 0.14, off: 0.3, total: 0.68, range: 1.0, damage: 13, push: 4, stun: 0.5, down: true, level: "high" },
  frontkick: { id: "frontkick", action: "fightkick", at: 0, on: 0.4, off: 0.62, total: 0.95, range: 1.35, damage: 10, push: 3, stun: 0.42, next: "roundkick", level: "mid" },
  roundkick: { id: "roundkick", action: "fightkick", at: 1.2, on: 0.4, off: 0.62, total: 1.0, range: 1.3, damage: 14, push: 3.2, stun: 0.5, down: true, level: "high" },
  sidekick: { id: "sidekick", action: "fightkick", at: 2.4, on: 0.42, off: 0.64, total: 1.0, range: 1.55, damage: 12, push: 5, stun: 0.45, level: "mid" },
  // corps-à-corps (boxe thaïe) et coup de pied retourné en fin d'enchaînement
  elbow: { id: "elbow", action: "elbow", at: 0, on: 0.3, off: 0.48, total: 0.72, range: 0.8, damage: 8, push: 1.2, stun: 0.4, level: "high" },
  knee: { id: "knee", action: "knee", at: 0, on: 0.26, off: 0.46, total: 0.85, range: 0.85, damage: 11, push: 1.6, stun: 0.45, level: "mid" },
  spinkick: { id: "spinkick", action: "spinkick", at: 0, on: 0.45, off: 0.66, total: 1.3, range: 1.5, damage: 16, push: 5.5, stun: 0.5, down: true, level: "high" },
  slash: { id: "slash", action: "sword", at: 0, on: 0.32, off: 0.5, total: 0.8, range: 1.6, damage: 12, push: 2, stun: 0.4, next: "cut", level: "high" },
  cut: { id: "cut", action: "sword", at: 1, on: 0.32, off: 0.5, total: 0.8, range: 1.6, damage: 13, push: 2.2, stun: 0.4, next: "sweep", level: "mid" },
  sweep: { id: "sweep", action: "sword", at: 2, on: 0.32, off: 0.5, total: 0.85, range: 1.7, damage: 14, push: 2.6, stun: 0.45, next: "thrust", level: "mid" },
  thrust: { id: "thrust", action: "sword", at: 3, on: 0.32, off: 0.52, total: 0.95, range: 2.0, damage: 17, push: 4, stun: 0.5, down: true, level: "mid" },
};

export type FighterSpec = {
  /** Acteur de la scène (sinon créé par l'arène : `combattant1`, `combattant2`). */
  actor: string | null;
  name: string;
  human: boolean;
  /** Vie, force (× dégâts), vitesse (× déplacement), défense (× dégâts reçus). */
  hp: number;
  power: number;
  speed: number;
  defense: number;
  /** Arme : poings et pieds, ou épée (coups d'épée à la place des poings). */
  weapon: "none" | "sword";
  /** Apparence (paramètres du personnage) quand l'arène crée le combattant. */
  params: Record<string, unknown>;
};

export const ARENAS = ["dojo", "rue", "plage", "ring", "foret", "nuit"] as const;
export type FightSpec = {
  fighters: [FighterSpec, FighterSpec];
  /** Manches : au meilleur de `rounds` (1, 3, 5) ; chrono d'une manche (s, 0 = sans). */
  rounds: number;
  time: number;
  /** Niveau de l'adversaire géré (0 … 1). */
  level: number;
  /** Arène générée (sans `recipe`) ; `null` : la scène de la recette. */
  arena: (typeof ARENAS)[number] | null;
  camera: "side" | "free";
  seed: number;
};

const NAMES = ["Kenji", "Rosa"];

/** Lecture tolérante de `fight` du DataProvider. */
export function parseFight(v: unknown, hasRecipe = false): FightSpec {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = (x: unknown, d: number, a: number, b: number) => (Number.isFinite(Number(x)) && x !== null && x !== "" && typeof x !== "boolean" ? clamp(Number(x), a, b) : d);
  const list: unknown[] = Array.isArray(o.fighters) ? o.fighters : o.fighters && typeof o.fighters === "object" ? Object.values(o.fighters as object) : [];
  const humans = o.humans === 2 || o.versus === true ? 2 : o.humans === 0 || o.human === false || o.human === "none" ? 0 : 1;
  const fighter = (i: number): FighterSpec => {
    const f = (list[i] && typeof list[i] === "object" ? list[i] : {}) as Record<string, unknown>;
    const params = f.params && typeof f.params === "object" && !Array.isArray(f.params) ? (JSON.parse(JSON.stringify(f.params)) as Record<string, unknown>) : {};
    return {
      actor: typeof f.actor === "string" && f.actor ? f.actor : null,
      name: typeof f.name === "string" && f.name.trim() ? f.name.trim().slice(0, 16) : NAMES[i],
      human: typeof f.human === "boolean" ? f.human : i < humans,
      hp: n(f.hp, 100, 10, 1000),
      power: n(f.power, 1, 0.3, 3),
      speed: n(f.speed, 1, 0.5, 2),
      defense: n(f.defense, 1, 0.3, 3),
      weapon: f.weapon === "sword" ? "sword" : "none",
      params,
    };
  };
  const arena = (ARENAS as readonly string[]).includes(String(o.arena)) ? (String(o.arena) as FightSpec["arena"]) : hasRecipe ? null : "dojo";
  const r = Math.round(n(o.rounds, 3, 1, 9));
  return {
    fighters: [fighter(0), fighter(1)],
    rounds: r % 2 ? r : r + 1,
    time: n(o.time, 60, 0, 600),
    level: n(o.level, 0.55, 0, 1),
    arena,
    camera: o.camera === "free" ? "free" : "side",
    seed: Math.floor(n(o.seed, 9, -1e9, 1e9)),
  };
}

export type FightInput = { x: number; jump: boolean; guard: boolean; light: boolean; heavy: boolean };
export const NO_FIGHT_INPUT: FightInput = { x: 0, jump: false, guard: false, light: false, heavy: false };

export type Fighter = {
  i: 0 | 1;
  spec: FighterSpec;
  /** Position sur l'axe (m), hauteur, vitesses. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  wins: number;
  /** Coup en cours et temps écoulé ; coup déjà touché. */
  move: Move | null;
  t: number;
  landed: boolean;
  /** Prochain coup demandé pendant le coup en cours (enchaînement). */
  queued: string | null;
  /** Sonné, en garde (s restantes de recul en garde), au sol. */
  stun: number;
  block: number;
  guard: boolean;
  down: number;
  combo: number;
  /** Geste affiché et son temps. */
  action: string;
  actionTime: number;
  /** IA : temps avant la prochaine décision, intention. */
  think: number;
  plan: FightInput;
  edges: { light: boolean; heavy: boolean; jump: boolean };
};

export type FightEvent = { type: string; payload: Record<string, unknown> };
export type FightPhase = "intro" | "fight" | "ko" | "roundEnd" | "over";

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bord de l'aire de combat (m, demi-longueur sur l'axe). */
export const STAGE = 6;
const GRAV = 22;

export class FightSim {
  readonly spec: FightSpec;
  readonly f: [Fighter, Fighter];
  phase: FightPhase = "intro";
  round = 1;
  clock: number;
  private phaseT = 0;
  readonly events: FightEvent[] = [];
  /** Ralenti voulu (K.O.). */
  timeScale = 1;
  private rnd: () => number;
  winner: number | null = null;

  constructor(spec: FightSpec) {
    this.spec = spec;
    this.rnd = rng(spec.seed * 53 + 7);
    const mk = (i: 0 | 1): Fighter => ({ i, spec: spec.fighters[i], x: i ? 1.6 : -1.6, y: 0, vx: 0, vy: 0, hp: spec.fighters[i].hp, wins: 0, move: null, t: 0, landed: false, queued: null, stun: 0, block: 0, guard: false, down: 0, combo: 0, action: "guard", actionTime: 0, think: 0, plan: { ...NO_FIGHT_INPUT }, edges: { light: false, heavy: false, jump: false } });
    this.f = [mk(0), mk(1)];
    this.clock = spec.time;
    this.events.push({ type: "round", payload: { round: 1 } });
  }

  /** Sens « vers l'adversaire » pour le combattant `i` (+1 ou -1 sur l'axe). */
  facing(i: 0 | 1): number {
    const a = this.f[i], b = this.f[1 - i];
    return b.x >= a.x ? 1 : -1;
  }

  step(dt: number, inputs: [FightInput, FightInput]) {
    dt = Math.min(dt, 0.05);
    this.phaseT += dt;
    this.timeScale = this.phase === "ko" && this.phaseT < 1.2 ? 0.35 : 1;
    const sdt = dt * this.timeScale;
    if (this.phase === "intro") {
      if (this.phaseT > 1.6) {
        this.phase = "fight";
        this.phaseT = 0;
        this.events.push({ type: "fight", payload: { round: this.round } });
      }
    } else if (this.phase === "fight" && this.spec.time > 0) {
      this.clock = Math.max(0, this.clock - dt);
      if (this.clock <= 0) this.endRound(null, "time");
    } else if ((this.phase === "ko" && this.phaseT > 2.6) || (this.phase === "roundEnd" && this.phaseT > 2.2)) {
      if (this.f.some((x) => x.wins > this.spec.rounds / 2)) {
        this.phase = "over";
        this.phaseT = 0;
        this.winner = this.f[0].wins > this.f[1].wins ? 0 : 1;
        this.events.push({ type: "matchEnd", payload: { winner: this.winner, name: this.f[this.winner].spec.name, score: [this.f[0].wins, this.f[1].wins] } });
      } else this.nextRound();
    }
    const live = this.phase === "fight";
    for (const k of [0, 1] as const) {
      const fi = this.f[k];
      const inp = fi.spec.human ? inputs[k] : this.ai(k, dt);
      this.stepFighter(fi, live ? inp : NO_FIGHT_INPUT, sdt);
    }
    if (live) for (const k of [0, 1] as const) this.resolve(k);
    // les corps ne se traversent pas ; bords de l'aire
    const [a, b] = this.f;
    const gap = b.x - a.x;
    if (Math.abs(gap) < 0.85 && Math.abs(a.y - b.y) < 1) {
      const push = ((0.85 - Math.abs(gap)) / 2) * Math.sign(gap || 1);
      a.x -= push;
      b.x += push;
    }
    for (const fi of this.f) fi.x = clamp(fi.x, -STAGE, STAGE);
  }

  private nextRound() {
    this.round++;
    this.phase = "intro";
    this.phaseT = 0;
    this.clock = this.spec.time;
    for (const fi of this.f) Object.assign(fi, { x: fi.i ? 1.6 : -1.6, y: 0, vx: 0, vy: 0, hp: fi.spec.hp, move: null, t: 0, stun: 0, block: 0, down: 0, combo: 0, queued: null, action: "guard" });
    this.events.push({ type: "round", payload: { round: this.round } });
  }

  private endRound(winner: number | null, reason: "ko" | "time") {
    if (winner === null) {
      // temps écoulé : la plus grande part de vie gagne (égalité : personne)
      const r0 = this.f[0].hp / this.f[0].spec.hp, r1 = this.f[1].hp / this.f[1].spec.hp;
      winner = r0 > r1 ? 0 : r1 > r0 ? 1 : null;
    }
    if (winner !== null) this.f[winner].wins++;
    this.phase = reason === "ko" ? "ko" : "roundEnd";
    this.phaseT = 0;
    this.events.push({ type: reason === "ko" ? "ko" : "timeout", payload: { round: this.round, winner, name: winner !== null ? this.f[winner].spec.name : null, score: [this.f[0].wins, this.f[1].wins] } });
  }

  private stepFighter(fi: Fighter, inp: FightInput, dt: number) {
    const dir = this.facing(fi.i);
    const edge = (k: "light" | "heavy" | "jump") => {
      const on = inp[k] && !fi.edges[k];
      fi.edges[k] = inp[k];
      return on;
    };
    const light = edge("light"), heavy = edge("heavy"), jump = edge("jump");
    fi.stun = Math.max(0, fi.stun - dt);
    fi.block = Math.max(0, fi.block - dt);
    const grounded = fi.y <= 0 && fi.vy <= 0;
    // au sol : on se relève
    if (fi.down > 0) {
      fi.down -= dt;
      fi.action = "fall";
      // geste « fall » : à terre de 0,4 à 0,85 s, relevé à 1,5 s ; K.O. : il reste à terre
      fi.actionTime = Math.min(fi.actionTime + dt, fi.hp <= 0 ? 0.7 : 1.5);
      fi.vx *= Math.exp(-dt * 6);
      fi.x += fi.vx * dt;
      if (fi.down <= 0) ((fi.action = "guard"), (fi.actionTime = 0));
      return;
    }
    // coup en cours
    if (fi.move) {
      fi.t += dt;
      fi.actionTime = fi.move.at + fi.t;
      const name = light || heavy ? this.pick(fi, light ? "light" : "heavy", inp.x * dir) : null;
      if (name && (fi.move.next === name || (fi.move.id === "roundkick" && name === "spinkick"))) fi.queued = name;
      if (fi.t >= fi.move.total) {
        const q = fi.queued && fi.landed ? fi.queued : null;
        fi.move = null;
        fi.queued = null;
        if (q) this.start(fi, MOVES[q]);
        else ((fi.action = "guard"), (fi.actionTime = 0), (fi.combo = 0));
      }
    } else if (fi.stun <= 0 && fi.hp > 0) {
      if ((light || heavy) && grounded) {
        const name = this.pick(fi, light ? "light" : "heavy", inp.x * dir);
        if (name) this.start(fi, MOVES[name]);
      }
      fi.guard = grounded && (inp.guard || (inp.x * dir < -0.3 && this.threat(fi)));
      if (jump && grounded) fi.vy = 7.2;
    }
    // déplacement
    const walk = 2.4 * fi.spec.speed;
    const busy = !!fi.move || fi.stun > 0 || fi.hp <= 0;
    const want = busy || fi.guard ? 0 : clamp(inp.x, -1, 1) * walk * (inp.x * dir < 0 ? 0.8 : 1);
    if (grounded) fi.vx += (want - fi.vx) * (1 - Math.exp(-dt * (fi.stun > 0 ? 7 : 14)));
    fi.x += fi.vx * dt;
    if (!grounded || fi.vy > 0) {
      fi.vy -= GRAV * dt;
      fi.y = Math.max(0, fi.y + fi.vy * dt);
      if (fi.y <= 0 && fi.vy < 0) fi.vy = 0;
    }
    if (!fi.move) {
      // coup encaissé : tête et buste rejetés en arrière le temps de l'étourdissement ; coup paré : avant-bras croisés
      fi.action = fi.hp <= 0 ? "fall" : fi.stun > 0 ? "hit" : fi.block > 0 ? "block" : fi.y > 0.02 ? "idle" : Math.abs(fi.vx) > 0.3 && !fi.guard ? "walk" : "guard";
      fi.actionTime += dt;
    }
  }

  /** Coup voulu : poings ou épée (léger), pieds (lourd) ; vers l'avant, le coup de pied latéral. */
  private pick(fi: Fighter, kind: "light" | "heavy", fwd: number): string | null {
    const close = Math.abs(this.f[1 - fi.i].x - fi.x) < 0.85 && fi.spec.weapon !== "sword";
    if (kind === "light") {
      if (fi.move && fi.move.next && (fi.move.action === (fi.spec.weapon === "sword" ? "sword" : "punch"))) return fi.move.next;
      // collé à l'adversaire : coude plutôt que direct
      if (close && !fi.move) return "elbow";
      return fi.spec.weapon === "sword" ? "slash" : "jab";
    }
    if (fi.move?.id === "frontkick") return "roundkick";
    // le circulaire enchaîne sur un retourné ; au corps-à-corps, genou
    if (fi.move?.id === "roundkick") return "spinkick";
    if (close) return "knee";
    return fwd > 0.3 ? "sidekick" : "frontkick";
  }

  private start(fi: Fighter, m: Move) {
    fi.move = m;
    fi.t = 0;
    fi.landed = false;
    fi.queued = null;
    fi.guard = false;
    fi.action = m.action;
    fi.actionTime = m.at;
    // on avance dans le coup : un enchaînement reste à portée malgré le recul de l'adversaire
    fi.vx = this.facing(fi.i) * (m.action === "fightkick" || m.action === "spinkick" || m.action === "knee" ? 0.8 : 1.8);
    this.events.push({ type: "attack", payload: { fighter: fi.i, move: m.id } });
  }

  /** L'adversaire attaque-t-il à portée (garde automatique en reculant) ? */
  private threat(fi: Fighter): boolean {
    const o = this.f[1 - fi.i];
    return !!o.move && o.t < o.move.off && Math.abs(o.x - fi.x) < o.move.range + 0.5;
  }

  /** Touche pendant la fenêtre active. */
  private resolve(k: 0 | 1) {
    const a = this.f[k], d = this.f[1 - k];
    const m = a.move;
    if (!m || a.landed || a.t < m.on || a.t > m.off || d.down > 0 || d.hp <= 0) return;
    const dist = Math.abs(d.x - a.x);
    if (dist > m.range + 0.15) return;
    // un saut passe au-dessus des coups au milieu ; en l'air, on ne touche qu'en hauteur
    if (d.y > 0.5 && m.level === "mid") return;
    if (Math.abs(d.y - a.y) > 1.1) return;
    a.landed = true;
    const dir = this.facing(k);
    const blocked = d.guard && d.y <= 0.02 && !d.move;
    const dmg = Math.round(m.damage * a.spec.power / d.spec.defense * (blocked ? 0.12 : 1) * 10) / 10;
    d.hp = Math.max(0, d.hp - dmg);
    // la réaction (encaisser, parer) commence au moment de la touche
    d.actionTime = 0;
    if (blocked) {
      d.block = 0.22;
      d.vx = dir * m.push * 0.5;
    } else {
      a.combo++;
      d.stun = m.stun;
      d.vx = dir * m.push;
      d.move = null;
      d.queued = null;
      if (m.down || d.hp <= 0) {
        d.down = d.hp <= 0 ? 99 : 1.55;
        d.actionTime = 0;
        d.vy = 3;
        d.y = Math.max(d.y, 0.01);
      }
    }
    this.events.push({ type: "hit", payload: { attacker: k, defender: 1 - k, move: m.id, damage: dmg, hp: d.hp, blocked, combo: a.combo, x: Math.round(d.x * 100) / 100 } });
    if (d.hp <= 0) this.endRound(k, "ko");
  }

  /** Adversaire géré : distance, attaques, garde, sauts ; `level` règle les réflexes et l'agressivité. */
  private ai(k: 0 | 1, dt: number): FightInput {
    const me = this.f[k], o = this.f[1 - k];
    const lv = this.spec.level;
    const dir = this.facing(k);
    const dist = Math.abs(o.x - me.x);
    me.think -= dt;
    // réflexe de garde : une attaque arrive
    const incoming = !!o.move && o.t < o.move.off && dist < o.move.range + 0.4;
    if (incoming && !me.move && me.plan.guard === false && this.rnd() < lv * 0.08 + 0.01) me.plan = { ...NO_FIGHT_INPUT, guard: true };
    if (me.think <= 0) {
      me.think = 0.12 + (1 - lv) * 0.35 + this.rnd() * 0.15;
      const r = this.rnd();
      const reach = me.spec.weapon === "sword" ? 1.5 : 1.0;
      if (incoming && r < 0.2 + lv * 0.6) me.plan = { ...NO_FIGHT_INPUT, guard: true };
      else if (dist > reach + 0.5) me.plan = { ...NO_FIGHT_INPUT, x: dir, jump: r < 0.04 };
      else if (dist < 0.75) me.plan = { ...NO_FIGHT_INPUT, x: -dir * (r < 0.5 ? 1 : 0), heavy: r > 0.75 };
      else if (r < 0.35 + lv * 0.4) me.plan = { ...NO_FIGHT_INPUT, light: dist < reach + 0.1 || r < 0.2, heavy: dist >= reach + 0.1 && r > 0.2, x: dist > 1.2 ? dir * 0.4 : 0 };
      else if (r < 0.85) me.plan = { ...NO_FIGHT_INPUT, x: (this.rnd() < 0.5 ? -1 : 0.4) * dir };
      else me.plan = { ...NO_FIGHT_INPUT, jump: true, x: dir * 0.6 };
    }
    // un appui à la fois : relâché après l'image où il a compté
    const p = me.plan;
    const out = { ...p };
    if (p.light || p.heavy || p.jump) me.plan = { ...p, light: false, heavy: false, jump: false };
    // enchaînement : on rappuie pendant le coup en cours
    if (me.move && me.move.next && me.t > me.move.on && !me.queued && this.rnd() < lv * 0.06) out.light = !me.edges.light;
    return out;
  }

  /** Résumé publié (`state-out.fight`). */
  summary() {
    return {
      phase: this.phase,
      round: this.round,
      rounds: this.spec.rounds,
      clock: Math.ceil(this.clock),
      winner: this.winner,
      fighters: this.f.map((x) => ({ name: x.spec.name, hp: Math.round(x.hp * 10) / 10, max: x.spec.hp, wins: x.wins, human: x.spec.human, action: x.action, move: x.move?.id ?? null, combo: x.combo, down: x.down > 0, x: Math.round(x.x * 100) / 100 })),
    };
  }
}

/* ---------------- arène ---------------- */

const ARENA_LOOK: Record<(typeof ARENAS)[number], { surface: string; style?: string; floor: string; deco: unknown[] }> = {
  dojo: { surface: "paved", floor: "wood", deco: [{ id: "lanternes", gen: "prop.lamp", place: { at: [{ x: -8, z: -4 }, { x: 8, z: -4 }] } }, { id: "arbres", gen: "tree", place: { at: [{ x: -11, z: -9 }, { x: 11, z: -10 }, { x: 0, z: -13 }] } }] },
  rue: { surface: "paved", floor: "road", deco: [{ id: "maisons", gen: "building", place: { at: [{ x: -9, z: -9 }, { x: 0, z: -10 }, { x: 9, z: -9 }] } }, { id: "lampadaires", gen: "street.streetlight", place: { at: [{ x: -6, z: -4 }, { x: 6, z: -4 }] } }] },
  plage: { surface: "sand", floor: "path", deco: [{ id: "palmiers", gen: "tree", place: { at: [{ x: -9, z: -6 }, { x: 10, z: -7 }] } }, { id: "rochers", gen: "rock", place: { at: [{ x: -4, z: -9 }, { x: 5, z: -10 }] } }] },
  ring: { surface: "paved", floor: "cloth2", deco: [{ id: "tribune", gen: "sport.stand", place: { at: [{ x: 0, z: -12, yaw: 0 }] }, params: { length: 26, rows: 6 } }] },
  foret: { surface: "grass", style: "automne", floor: "grass", deco: [{ id: "arbres", gen: "tree", place: { at: [{ x: -9, z: -6 }, { x: -4, z: -10 }, { x: 4, z: -9 }, { x: 10, z: -6 }, { x: 0, z: -14 }] } }] },
  nuit: { surface: "paved", style: "nuit", floor: "road", deco: [{ id: "lampadaires", gen: "street.streetlight", place: { at: [{ x: -6, z: -4 }, { x: 6, z: -4 }] } }, { id: "maisons", gen: "building", place: { at: [{ x: -8, z: -10 }, { x: 8, z: -10 }] } }] },
};

/** Ids des combattants créés par l'arène. */
export const FIGHTER_IDS = ["combattant1", "combattant2"];

/** Recette de l'arène : aire de combat (dalle), décor en arrière-plan, deux combattants. */
export function fightRecipe(spec: FightSpec): Record<string, unknown> {
  const a = ARENA_LOOK[spec.arena ?? "dojo"];
  const ring = spec.arena === "ring";
  const parts: unknown[] = [{ t: "box", c: [0, ring ? 0.4 : 0.03, 0], h: [STAGE + 0.6, ring ? 0.4 : 0.03, 2.4], role: a.floor }];
  if (ring) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ t: "rod", a: [sx * (STAGE + 0.5), 0.8, sz * 2.3], b: [sx * (STAGE + 0.5), 2.1, sz * 2.3], r: 0.08, role: "metal" });
    for (const h of [1.3, 1.75]) for (const sz of [-1, 1]) parts.push({ t: "rod", a: [-(STAGE + 0.5), h, sz * 2.3], b: [STAGE + 0.5, h, sz * 2.3], r: 0.025, role: "accent" });
  }
  const defaults = [
    { archetype: "stylized", top: "tee", bottom: "trousers", gloves: "gloves", colors: { top: "#ffffff", bottom: "#1c1c1c" } },
    { archetype: "stylized", top: "tank", bottom: "shorts", colors: { top: "#c8202c", bottom: "#1d2a5a" } },
  ];
  const actors: Record<string, unknown> = {};
  spec.fighters.forEach((f, i) => {
    actors[FIGHTER_IDS[i]] = { at: [i ? 1.6 : -1.6, 0], facing: i ? -90 : 90, params: { ...defaults[i], ...(f.weapon === "sword" ? { item: "sword" } : {}), ...f.params } };
  });
  return {
    size: [40, 30],
    seed: spec.seed,
    ground: { relief: 0, surface: a.surface },
    layers: [{ id: "aire", gen: "assembly", place: { at: [{ x: 0, z: 0, yaw: 0 }] }, params: { parts } }, ...a.deco],
    actors,
    ...(a.style ? { style: a.style } : {}),
    view: { camera: "perspective", yaw: 0, pitch: 8, zoom: 3, cx: 0, cy: 1.2, cz: 0, fov: 40 },
  };
}
