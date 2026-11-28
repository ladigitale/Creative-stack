/**
 * Contrôleur de personnage (CPU, pur, testé sans rendu) : un acteur mené image par image comme dans un jeu d'action —
 * course avec accélération et inertie, saut à hauteur variable (on relâche, il retombe plus tôt), tolérance au bord
 * (on saute encore un instant après avoir quitté une plateforme), saut mémorisé juste avant l'atterrissage, contrôle en
 * l'air réduit, double saut en option, chute plus rapide que la montée, marches franchies, glissement le long des murs,
 * atterrissage sur le dessus réel des objets.
 *
 * Le monde est vu par trois questions (`CtrlWorld`) : hauteur du sol ou du dessus d'objet sous les pieds, ce qui fait
 * mur à hauteur du corps, et le plafond. Repère : mètres, cap 0 = +z, croissant vers +x.
 */

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export type CtrlSpec = {
  actor: string;
  /** Plan de jeu : `free` (3D), `x` (2,5D : on avance le long de x, z bloqué sur `lane`), `z`. */
  plane: "free" | "x" | "z";
  lane: number | null;
  /** Vitesses (m/s) : marche, course ; hauteur de saut (m) ; gravité (m/s²). */
  walk: number;
  run: number;
  jump: number;
  gravity: number;
  /** Part du contrôle gardée en l'air (0 … 1). */
  air: number;
  /** Sauts permis avant de toucher le sol (2 = double saut). */
  jumps: number;
  /** Tolérance au bord et mémoire du saut (s). */
  coyote: number;
  buffer: number;
  /** Marche franchie sans sauter (m). */
  step: number;
  /** Caméra : profil (2,5D), troisième personne, première personne, ou laissée à l'artefact. */
  camera: "side" | "third" | "first" | "free";
  /** Hauteur en dessous de laquelle on est tombé (m) : retour au dernier point sûr. */
  killY: number;
  /** Rayon de ramassage (m) des objets `collect`. */
  reach: number;
  /** Ids d'objets, calques ou générateurs ramassables (pièces, clés) ; `goal` : arrivée. */
  collect: string[];
  goal: string | null;
  /** Tir (première personne) : actif, cadence (coups par seconde), portée (m). */
  fire: boolean;
  rate: number;
  range: number;
};

/** Lecture tolérante de `player` du DataProvider. */
export function parseCtrl(v: unknown): CtrlSpec | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const actor = typeof o.actor === "string" && o.actor ? o.actor : null;
  if (!actor) return null;
  const n = (x: unknown, d: number, a: number, b: number) => (Number.isFinite(Number(x)) && x !== null && x !== "" && typeof x !== "boolean" ? clamp(Number(x), a, b) : d);
  const plane = o.plane === "x" || o.plane === "z" ? o.plane : "free";
  const cam = ["side", "third", "first", "free"].includes(String(o.camera)) ? (String(o.camera) as CtrlSpec["camera"]) : plane === "free" ? "third" : "side";
  const list = (x: unknown) => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []).filter((s): s is string => typeof s === "string" && !!s).slice(0, 32);
  return {
    actor,
    plane,
    lane: Number.isFinite(Number(o.lane)) && o.lane !== null && o.lane !== "" ? Number(o.lane) : null,
    walk: n(o.walk, 2.2, 0.5, 8),
    run: n(o.run ?? o.speed, 6, 1, 20),
    jump: n(o.jump, 1.6, 0, 8),
    gravity: n(o.gravity, 26, 2, 80),
    air: n(o.air, 0.65, 0, 1),
    jumps: Math.round(n(o.jumps, 1, 0, 3)),
    coyote: n(o.coyote, 0.1, 0, 0.5),
    buffer: n(o.buffer, 0.12, 0, 0.5),
    step: n(o.step, 0.45, 0, 1.5),
    camera: cam,
    killY: n(o.killY, -8, -1000, 1000),
    reach: n(o.reach, 1.1, 0.2, 5),
    collect: list(o.collect),
    goal: typeof o.goal === "string" && o.goal ? o.goal : null,
    fire: o.fire === true || (o.fire !== false && cam === "first"),
    rate: n(o.rate, 4, 0.5, 20),
    range: n(o.range, 80, 2, 500),
  };
}

export type CtrlInput = {
  /** Déplacement voulu dans le monde (norme ≤ 1), déjà tourné selon la caméra. */
  x: number;
  z: number;
  run: boolean;
  /** Saut tenu ; `jumpEdge` : appuyé à cette image. */
  jump: boolean;
  jumpEdge: boolean;
};
export const NO_CTRL: CtrlInput = { x: 0, z: 0, run: false, jump: false, jumpEdge: false };

export type CtrlState = {
  pos: [number, number, number];
  vel: [number, number, number];
  yaw: number;
  grounded: boolean;
  /** Temps depuis le dernier appui au sol, mémoire du saut, sauts restants, saut coupé. */
  air: number;
  buf: number;
  jumpsLeft: number;
  cut: boolean;
  /** Objet sous les pieds (id) et dernier point sûr (retour après une chute). */
  on: string | null;
  safe: [number, number, number];
  /** Hauteur max atteinte pendant la chute (atterrissage lourd). */
  peak: number;
};

export function newCtrlState(x: number, y: number, z: number, yaw: number): CtrlState {
  return { pos: [x, y, z], vel: [0, 0, 0], yaw, grounded: true, air: 0, buf: 0, jumpsLeft: 0, cut: false, on: null, safe: [x, y, z], peak: y };
}

export interface CtrlWorld {
  /** Sol ou dessus d'objet le plus haut sous (x, z) qui ne dépasse pas `feetY + stepUp`. */
  ground(x: number, z: number, feetY: number, stepUp: number): { y: number; on: string | null };
  /** Un mur (ou un objet plus haut qu'une marche) au point (x, z) pour des pieds à `feetY` ? */
  blocked(x: number, z: number, feetY: number, stepUp: number): boolean;
  /** Plafond au-dessus de (x, z) depuis `y` (dessous d'un objet), ou `Infinity`. */
  ceiling?(x: number, z: number, y: number): number;
}

export type CtrlEvent = { type: "jump" | "land" | "fall" | "respawn"; payload: Record<string, unknown> };

/**
 * Un pas du contrôleur. Rend les événements (`jump {n}`, `land {speed, height}`, `fall` quand on passe sous `killY`,
 * puis `respawn` au dernier point sûr).
 */
export function stepCtrl(sp: CtrlSpec, st: CtrlState, inp: CtrlInput, dt: number, w: CtrlWorld): CtrlEvent[] {
  const ev: CtrlEvent[] = [];
  if (dt <= 0) return ev;
  let ix = inp.x, iz = inp.z;
  if (sp.plane === "x") iz = 0;
  if (sp.plane === "z") ix = 0;
  const l = Math.hypot(ix, iz);
  if (l > 1) ((ix /= l), (iz /= l));
  // vitesse visée : course analogique (le stick à fond court), marche lente sinon
  const top = inp.run ? sp.run : sp.run * 0.62;
  const want: [number, number] = [ix * top, iz * top];
  const ctl = st.grounded ? 1 : sp.air;
  const acc = (l > 0.05 ? 38 : 30) * ctl;
  for (const k of [0, 2] as const) {
    const t = k === 0 ? want[0] : want[1];
    const dv = t - st.vel[k];
    st.vel[k] += clamp(dv, -acc * dt, acc * dt);
  }
  // cap : tourné vers le déplacement (en 2,5D, vers la gauche ou la droite seulement)
  const hs = Math.hypot(st.vel[0], st.vel[2]);
  if (l > 0.1 || hs > 0.6) {
    const tx = l > 0.1 ? ix : st.vel[0], tz = l > 0.1 ? iz : st.vel[2];
    const target = sp.plane === "x" ? (tx >= 0 ? Math.PI / 2 : -Math.PI / 2) : sp.plane === "z" ? (tz >= 0 ? 0 : Math.PI) : Math.atan2(tx, tz);
    let d = target - st.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    st.yaw += clamp(d, -dt * 14, dt * 14);
  }
  // saut : mémorisé un instant, permis au sol ou juste après l'avoir quitté, puis en l'air s'il en reste
  if (inp.jumpEdge) st.buf = sp.buffer + 1e-6;
  else st.buf = Math.max(0, st.buf - dt);
  st.air = st.grounded ? 0 : st.air + dt;
  const canGround = st.grounded || st.air <= sp.coyote;
  if (st.buf > 0 && sp.jump > 0 && (canGround || st.jumpsLeft > 0)) {
    const first = canGround;
    if (!first) st.jumpsLeft--;
    else st.jumpsLeft = sp.jumps - 1;
    st.vel[1] = Math.sqrt(2 * sp.gravity * sp.jump) * (first ? 1 : 0.9);
    st.grounded = false;
    st.air = sp.coyote + 1;
    st.buf = 0;
    st.cut = false;
    st.on = null;
    ev.push({ type: "jump", payload: { n: first ? 1 : sp.jumps - st.jumpsLeft } });
  }
  // saut relâché en montée : il retombe plus tôt (hauteur réglée par la durée d'appui)
  if (!inp.jump && st.vel[1] > 0 && !st.cut && !st.grounded) {
    st.vel[1] *= 0.45;
    st.cut = true;
  }
  // gravité (plus forte en descente : saut vif), vitesse de chute bornée
  if (!st.grounded) st.vel[1] = Math.max(-40, st.vel[1] - sp.gravity * (st.vel[1] < 0 ? 1.55 : 1) * dt);
  // déplacement horizontal, axe par axe : on glisse le long des murs
  const feet = st.pos[1];
  const stepUp = st.grounded ? sp.step : 0.08;
  for (const k of [0, 2] as const) {
    const d = st.vel[k] * dt;
    if (!d) continue;
    const nx = k === 0 ? st.pos[0] + d : st.pos[0], nz = k === 2 ? st.pos[2] + d : st.pos[2];
    // une marge devant soi (corps de 0,3 m) : on s'arrête contre le mur, pas dedans
    const px = k === 0 ? nx + Math.sign(d) * 0.28 : nx, pz = k === 2 ? nz + Math.sign(d) * 0.28 : nz;
    if (w.blocked(px, pz, feet, stepUp)) st.vel[k] = 0;
    else if (k === 0) st.pos[0] = nx;
    else st.pos[2] = nz;
  }
  if (sp.plane === "x" && sp.lane !== null) st.pos[2] = sp.lane;
  if (sp.plane === "z" && sp.lane !== null) st.pos[0] = sp.lane;
  // vertical
  const vy = st.vel[1];
  let y = st.pos[1] + vy * dt;
  if (vy > 0 && w.ceiling) {
    const c = w.ceiling(st.pos[0], st.pos[2], st.pos[1]);
    if (y + 1.7 > c) ((y = Math.max(st.pos[1], c - 1.7)), (st.vel[1] = 0));
  }
  const g = groundUnder(w, sp, st.pos[0], st.pos[2], st.grounded ? st.pos[1] : Math.max(y, st.pos[1] - 0.05), st.grounded ? sp.step : 0.05);
  if (st.grounded) {
    // collé au sol : on suit marches et pentes ; une marche descendante plus haute que `step` : on tombe
    if (st.pos[1] - g.y > sp.step + 0.05) {
      st.grounded = false;
      st.air = 0;
      st.peak = st.pos[1];
      st.pos[1] = y;
    } else {
      st.pos[1] = g.y;
      st.vel[1] = 0;
      st.on = g.on;
    }
  } else {
    st.peak = Math.max(st.peak, y);
    if (st.vel[1] <= 0 && y <= g.y) {
      const speed = -st.vel[1];
      st.pos[1] = g.y;
      st.vel[1] = 0;
      st.grounded = true;
      st.on = g.on;
      st.jumpsLeft = sp.jumps - 1;
      ev.push({ type: "land", payload: { speed: Math.round(speed * 10) / 10, height: Math.round((st.peak - g.y) * 10) / 10, on: g.on } });
      st.peak = g.y;
    } else st.pos[1] = y;
  }
  if (st.grounded && Math.hypot(st.vel[0], st.vel[2]) < 0.5) st.safe = [st.pos[0], st.pos[1], st.pos[2]];
  else if (st.grounded) st.safe = [st.pos[0] - Math.sign(st.vel[0]) * 0.6, st.pos[1], st.pos[2] - Math.sign(st.vel[2]) * 0.6];
  if (st.pos[1] < sp.killY) {
    ev.push({ type: "fall", payload: { x: round(st.pos[0]), z: round(st.pos[2]) } });
    st.pos = [...st.safe];
    st.vel = [0, 0, 0];
    st.grounded = true;
    st.air = 0;
    ev.push({ type: "respawn", payload: { x: round(st.pos[0]), y: round(st.pos[1]), z: round(st.pos[2]) } });
  }
  return ev;
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Pieds de 0,2 m de rayon : appui le plus haut sous le centre et autour (on ne tombe pas dans une fente). */
function groundUnder(w: CtrlWorld, sp: CtrlSpec, x: number, z: number, feet: number, stepUp: number): { y: number; on: string | null } {
  let best = w.ground(x, z, feet, stepUp);
  const R = 0.2;
  const offs: [number, number][] = sp.plane === "x" ? [[R, 0], [-R, 0]] : sp.plane === "z" ? [[0, R], [0, -R]] : [[R, 0], [-R, 0], [0, R], [0, -R]];
  for (const [dx, dz] of offs) {
    const g = w.ground(x + dx, z + dz, feet, stepUp);
    if (g.y > best.y) best = g;
  }
  return best;
}

/** Allure affichée : action et vitesse (m/s) pour l'animation de l'acteur. */
export function ctrlPose(st: CtrlState): { action: string; speed: number } {
  const hs = Math.hypot(st.vel[0], st.vel[2]);
  if (!st.grounded) return { action: st.vel[1] > 0.5 ? "jump" : "fall", speed: hs };
  return { action: hs > 3.2 ? "run" : hs > 0.15 ? "walk" : "idle", speed: hs };
}

/* ---------------- niveau de plateformes généré ---------------- */

export type PlatformerSpec = { seed: number; length: number; theme: "prairie" | "foret" | "desert" | "neige" | "nuit"; coins: boolean; enemies: number; lives: number };

export function parsePlatformer(v: unknown): PlatformerSpec {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = (x: unknown, d: number, a: number, b: number) => (Number.isFinite(Number(x)) && x !== null && x !== "" && typeof x !== "boolean" ? clamp(Number(x), a, b) : d);
  const themes = ["prairie", "foret", "desert", "neige", "nuit"] as const;
  return {
    seed: Math.floor(n(o.seed, 5, -1e9, 1e9)),
    length: n(o.length, 120, 40, 400),
    theme: (themes as readonly string[]).includes(String(o.theme)) ? (String(o.theme) as PlatformerSpec["theme"]) : "prairie",
    coins: o.coins !== false,
    enemies: Math.round(n(o.enemies, 3, 0, 12)),
    lives: Math.round(n(o.lives, 3, 1, 9)),
  };
}

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Une plateforme du niveau (x : début, w : largeur, h : hauteur du dessus). */
export type Block = { x: number; w: number; h: number; kind: "ground" | "crate" | "rock" };

/**
 * Niveau de plateformes en 2,5D le long de x (z = 0) : sol en tronçons séparés par des trous à sauter, marches et
 * caisses empilées, plateformes en hauteur, pièces sur les sauts, quelques animaux qui patrouillent, drapeau d'arrivée.
 * Chaque saut demandé reste faisable avec le contrôleur par défaut (1,6 m de haut, ~4 m de long à la course).
 */
export function platformerLevel(spec: PlatformerSpec): { blocks: Block[]; coins: [number, number, number][]; enemies: [number, number][]; start: [number, number]; goal: number } {
  const r = rng(spec.seed * 977 + 13);
  const blocks: Block[] = [];
  const coins: [number, number, number][] = [];
  const enemies: [number, number][] = [];
  let x = -spec.length / 2;
  const end = spec.length / 2;
  // départ : sol plat
  blocks.push({ x, w: 12, h: 0, kind: "ground" });
  x += 12;
  let level = 0;
  while (x < end - 14) {
    const kind = r();
    if (kind < 0.3) {
      // trou à sauter (1,5 … 3,2 m), pièces en arc au-dessus
      const gap = 1.5 + r() * 1.7;
      for (let k = 1; k <= 3; k++) coins.push([x + (gap * k) / 4, level + 1 + Math.sin((k / 4) * Math.PI) * 1.2, 0]);
      x += gap;
      const w = 4 + r() * 6;
      level = clamp(level + (r() < 0.5 ? 0 : r() < 0.5 ? 0.5 : -0.5), 0, 3);
      blocks.push({ x, w, h: level, kind: "ground" });
      if (w > 6 && r() < 0.5) enemies.push([x + w / 2, level]);
      x += w;
    } else if (kind < 0.55) {
      // marches de caisses (0,9 m chacune) montant puis redescendant
      const n = 1 + Math.floor(r() * 2);
      blocks.push({ x, w: 3, h: level, kind: "ground" });
      for (let k = 0; k < n; k++) blocks.push({ x: x + 0.4 + k * 1.1, w: 1.1, h: level + 0.9 * (k + 1), kind: "crate" });
      coins.push([x + 0.4 + (n - 1) * 1.1 + 0.55, level + 0.9 * n + 0.9, 0]);
      x += 3;
      blocks.push({ x, w: 5, h: level, kind: "ground" });
      x += 5;
    } else if (kind < 0.8) {
      // plateformes flottantes au-dessus d'un vide
      const n = 2 + Math.floor(r() * 2);
      for (let k = 0; k < n; k++) {
        x += 1.6 + r() * 1.2;
        const h = level + 0.6 + r() * 1.0;
        const w = 2 + r() * 1.2;
        blocks.push({ x, w, h, kind: "rock" });
        coins.push([x + w / 2, h + 0.9, 0]);
        x += w;
      }
      x += 1.6 + r();
      const w = 6 + r() * 4;
      blocks.push({ x, w, h: level, kind: "ground" });
      if (r() < 0.6) enemies.push([x + w * 0.6, level]);
      x += w;
    } else {
      // long sol plat avec une caisse au milieu
      const w = 8 + r() * 6;
      blocks.push({ x, w, h: level, kind: "ground" });
      blocks.push({ x: x + w / 2 - 0.55, w: 1.1, h: level + 1.1, kind: "crate" });
      coins.push([x + w / 2, level + 2.1, 0]);
      if (r() < 0.7) enemies.push([x + w * 0.25, level]);
      x += w;
    }
  }
  blocks.push({ x, w: end - x + 10, h: level, kind: "ground" });
  // tronçons de sol contigus à la même hauteur : une seule dalle (pas de joint où l'on tomberait)
  const merged: Block[] = [];
  for (const b of blocks.filter((q) => q.kind === "ground")) {
    const p = merged.length ? merged[merged.length - 1] : null;
    if (p && p.h === b.h && Math.abs(p.x + p.w - b.x) < 0.05) p.w = b.x + b.w - p.x;
    else merged.push({ ...b });
  }
  merged.push(...blocks.filter((q) => q.kind !== "ground"));
  return { blocks: merged, coins: spec.coins ? coins : [], enemies: enemies.slice(0, spec.enemies), start: [-spec.length / 2 + 3, 0], goal: end - 4 };
}

const THEMES: Record<PlatformerSpec["theme"], { top: string; side: string; style?: string; deco: string; animal: string; water: number | null; surface: string }> = {
  prairie: { top: "grass", side: "ground", deco: "tree", animal: "animal.dog", water: 0.6, surface: "sand" },
  foret: { top: "leaf2", side: "bark", style: "automne", deco: "tree", animal: "animal.fox", water: 0.6, surface: "dirt" },
  desert: { top: "path", side: "stone", style: "desert", deco: "rock", animal: "animal.goat", water: null, surface: "sand" },
  neige: { top: "paper", side: "stone", style: "neige", deco: "tree", animal: "animal.sheep", water: 0.6, surface: "snow" },
  nuit: { top: "grass", side: "stone", style: "nuit", deco: "tree", animal: "animal.cat", water: 0.6, surface: "grass" },
};

/** Hauteur du sol de la scène sous les plateformes (le vide) : on y tombe, `killY` est juste au-dessus. */
export const PLATFORM_BASE = 2;

/**
 * Recette du niveau : chaque plateforme est un `assembly` (dalle de terre coiffée d'herbe, de sable ou de neige) dont
 * le dessus est à `PLATFORM_BASE + h`, au-dessus d'un vide (eau, ou sable du désert) ; marches en caisses de bois,
 * plateformes flottantes en pierre, pièces (disques dorés), drapeau d'arrivée, décor en arrière-plan, héros et
 * ennemis (animaux) dans `actors`. Rend aussi les réglages du contrôleur qui vont avec.
 */
export function platformerRecipe(spec: PlatformerSpec): { recipe: Record<string, unknown>; player: Record<string, unknown> } {
  const L = platformerLevel(spec);
  const th = THEMES[spec.theme];
  const B = PLATFORM_BASE;
  const D = 3;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const box = (cx: number, y0: number, y1: number, hw: number, hd: number, role: string) => ({ t: "box", c: [0, r2((y0 + y1) / 2), 0], h: [r2(hw), r2((y1 - y0) / 2), r2(hd)], role, _x: cx });
  const layers: unknown[] = [];
  // un assemblage tient dans ±6 m : les longues dalles sont coupées en morceaux jointifs
  const pieces: Block[] = [];
  for (const b of L.blocks) {
    const n = Math.max(1, Math.ceil(b.w / 11.5));
    for (let k = 0; k < n; k++) pieces.push({ ...b, x: b.x + (b.w * k) / n, w: b.w / n });
  }
  pieces.forEach((b, i) => {
    const top = B + b.h;
    const hw = b.w / 2;
    const parts =
      b.kind === "ground"
        ? [box(0, -0.5, top - 0.25, hw, D, th.side), box(0, top - 0.25, top, hw + 0.04, D + 0.04, th.top)]
        : b.kind === "rock"
          ? [box(0, top - 0.5, top, hw, 1.2, "stone")]
          : [box(0, top - 0.9, top, hw - 0.02, 0.55, "wood"), box(0, top - 0.5, top - 0.4, hw + 0.01, 0.56, "trim")];
    layers.push({ id: `bloc${i}`, gen: "assembly", place: { at: [{ x: r2(b.x + hw), z: 0, yaw: 0 }] }, params: { parts: parts.map(({ _x, ...p }) => p) } });
  });
  L.coins.forEach(([x, y], i) => {
    const pts: number[][] = [];
    for (let k = 0; k < 10; k++) pts.push([r2(Math.cos((k / 10) * Math.PI * 2) * 0.24), r2(Math.sin((k / 10) * Math.PI * 2) * 0.24)]);
    layers.push({ id: `piece${i}`, gen: "assembly", place: { at: [{ x: r2(x), z: 0, yaw: 0 }] }, params: { parts: [{ t: "plate", c: [0, r2(B + y), 0], pts, d: 0.06, role: "lamp" }] } });
  });
  // arrivée : mât et drapeau sur la dernière plateforme
  const last = L.blocks[L.blocks.length - 1];
  layers.push({ id: "arrivee", gen: "assembly", place: { at: [{ x: r2(L.goal), z: 0, yaw: 0 }] }, params: { parts: [{ t: "rod", a: [0, B + last.h, 0], b: [0, B + last.h + 3.2, 0], r: 0.05, role: "metal" }, { t: "plate", c: [0.5, B + last.h + 2.8, 0], pts: [[-0.5, -0.35], [0.5, -0.35], [0.5, 0.35], [-0.5, 0.35]], d: 0.03, role: "accent" }] } });
  const decoN = Math.round(spec.length / 6);
  layers.push({ id: "decor", gen: th.deco, place: { at: Array.from({ length: decoN }, (_, k) => ({ x: r2(-spec.length / 2 - 8 + k * 6 + ((k * 37) % 5)), z: r2(-8 - (k % 3) * 4) })) } });
  const actors: Record<string, unknown> = {
    heros: { at: [L.start[0], 0], facing: 90, params: { archetype: "cartoon", hat: "cap", item: "none", bag: "none" } },
  };
  L.enemies.forEach(([x], i) => (actors[`ennemi${i}`] = { gen: th.animal, at: [r2(x), 0], facing: -90 }));
  const recipe = {
    size: [Math.ceil(spec.length + 60), 44],
    seed: spec.seed,
    ground: { relief: 0, surface: th.surface, ...(th.water !== null ? { water: th.water } : {}) },
    layers,
    actors,
    ...(th.style ? { style: th.style } : {}),
    view: { camera: "perspective", yaw: 0, pitch: 9, zoom: 3, cx: L.start[0], cy: B + 1.6, cz: 0, fov: 42 },
  };
  const player = { actor: "heros", plane: "x", lane: 0, camera: "side", collect: ["piece*"], goal: "arrivee", enemies: L.enemies.map((_, i) => `ennemi${i}`), killY: B - 0.8, lives: spec.lives };
  return { recipe, player };
}
