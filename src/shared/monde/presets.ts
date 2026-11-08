/**
 * Préréglages procéduraux du format « monde » : un modèle `{preset, seed, params}` devient des pièces et des clips
 * ordinaires (ceux qu'un agent écrirait à la main), donc pilotables et retouchables pièce par pièce.
 * Même graine = même modèle ; chaque paramètre absent est tiré de la graine.
 */
import type { Rand } from "./math";
import type { ClipIn, PartIn } from "./format";

export type PresetOut = {
  parts: PartIn[];
  clips?: Record<string, ClipIn>;
  roles?: Record<string, string>;
  clip?: string;
};

export type Preset = {
  doc: string;
  params: Record<string, string>;
  build(r: Rand, p: Record<string, unknown>): PresetOut;
};

const str = (v: unknown, list: readonly string[], r: Rand): string => (typeof v === "string" && list.includes(v) ? v : r.pick(list));
const nb = (v: unknown, a: number, b: number, r: Rand): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : r.range(a, b));
const flag = (v: unknown, p: number, r: Rand): boolean => (typeof v === "boolean" ? v : r.chance(p));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const isHex = (v: unknown): v is string => typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
const R = (a: number[]) => a.map(round3);

/* ------------------------------------------------------------------ bipède */

const ESPECES: Record<string, Record<string, unknown>> = {
  humain: { oreilles: "humaines", museau: 0, queue: "aucune", cornes: "aucune", yeux: "ronds", peau: ["#f2c29b", "#e0ac82", "#a66a45", "#7a4a2b", "#f5d0b5"] },
  chat: { oreilles: "pointues", museau: 0.35, queue: "longue", cornes: "aucune", cheveux: "aucun", yeux: "amande", peau: ["#f59e0b", "#9ca3af", "#f8fafc", "#1f2937", "#d6a36b"] },
  renard: { oreilles: "pointues", museau: 0.8, queue: "touffue", cornes: "aucune", cheveux: "aucun", yeux: "amande", peau: ["#ea580c", "#c2410c", "#e5e7eb"] },
  ours: { oreilles: "rondes", museau: 0.55, queue: "courte", cornes: "aucune", cheveux: "aucun", yeux: "ronds", peau: ["#7c4a2b", "#a16207", "#f1f5f9", "#292524"] },
  lapin: { oreilles: "longues", museau: 0.25, queue: "courte", cornes: "aucune", cheveux: "aucun", yeux: "grands", peau: ["#f1f5f9", "#d6d3d1", "#a8a29e", "#fbcfe8"] },
  dino: { oreilles: "aucune", museau: 0.9, queue: "longue", cornes: "petites", cheveux: "crete", yeux: "ronds", peau: ["#22c55e", "#84cc16", "#14b8a6", "#a855f7"] },
  monstre: { oreilles: "aucune", museau: 0, queue: "aucune", cornes: "grandes", cheveux: "aucun", yeux: "grands", peau: ["#8b5cf6", "#f43f5e", "#06b6d4", "#84cc16"] },
  grenouille: { oreilles: "aucune", museau: 0.15, queue: "aucune", cornes: "aucune", cheveux: "aucun", yeux: "globes", peau: ["#4ade80", "#16a34a", "#a3e635"] },
  robot: { oreilles: "antennes", museau: 0, queue: "aucune", cornes: "aucune", cheveux: "aucun", yeux: "visiere", tete: "carree", peau: ["#cbd5e1", "#94a3b8", "#fde047", "#fb923c"] },
};

function bipede(r: Rand, p: Record<string, unknown>): PresetOut {
  const espece = str(p.espece, Object.keys(ESPECES), r);
  const E = ESPECES[espece];
  const pick = (k: string, list: readonly string[]) => str(p[k] ?? E[k], list, r);
  const h = nb(p.taille, 0.5, 2.2, r) * (typeof p.taille === "number" ? 1 : espece === "humain" ? 1.2 : 1);
  const c = nb(p.corpulence, 0.75, 1.35, r);
  const big = nb(p.grosseTete, 0.26, 0.42, r); // part de la tête dans la hauteur (chibi > 0.33)
  const tete = pick("tete", ["ronde", "ovale", "carree", "large"]);
  const oreilles = pick("oreilles", ["aucune", "rondes", "pointues", "longues", "humaines", "antennes"]);
  const queue = pick("queue", ["aucune", "courte", "longue", "touffue"]);
  const cornes = pick("cornes", ["aucune", "petites", "grandes"]);
  const cheveux = pick("cheveux", ["aucun", "court", "epis", "crete", "bol"]);
  const yeux = pick("yeux", ["ronds", "grands", "amande", "globes", "visiere"]);
  const museau = nb(p.museau ?? E.museau, 0, 1, r);
  const ventre = flag(p.ventre, espece === "humain" || espece === "robot" ? 0 : 0.6, r);
  const peaux = (E.peau as string[]) ?? ["#f2c29b"];
  const peau = isHex(p.peau) ? p.peau : r.pick(peaux);

  // Proportions (mètres)
  const headH = h * big;
  const headR = headH * 0.5;
  const legL = (h - headH) * 0.46;
  const torsoH = (h - headH) * 0.42;
  const hipY = legL;
  const torsoW = h * 0.16 * c;
  const limbR = h * 0.035 * Math.sqrt(c);
  const armL = torsoH * 0.95;
  const sh = (x: number) => round3(x);

  const parts: PartIn[] = [];
  parts.push({ name: "bassin", at: [0, sh(hipY), 0], sphere: R([torsoW * 0.95, h * 0.07, torsoW * 0.7]), role: "short" });
  parts.push({ name: "torse", parent: "bassin", at: [0, sh(h * 0.03), 0], box: R([torsoW * 2, torsoH, torsoW * 1.35, torsoW * 0.55]), off: [0, sh(torsoH / 2), 0], role: "maillot" });
  if (ventre) parts.push({ name: "ventre", parent: "torse", at: [0, sh(torsoH * 0.45), sh(torsoW * 0.6)], sphere: R([torsoW * 0.75, torsoH * 0.38, torsoW * 0.18]), role: "ventre" });
  parts.push({ name: "numero", parent: "torse", at: [0, sh(torsoH * 0.55), sh(-torsoW * 0.69)], box: R([torsoW * 0.9, torsoH * 0.45, 0.004]), role: "numero" });

  // Tête
  const tShape: Partial<PartIn> =
    tete === "carree"
      ? { box: R([headR * 1.9, headR * 1.75, headR * 1.8, headR * 0.35]) }
      : tete === "ovale"
        ? { sphere: R([headR * 0.88, headR * 1.08, headR * 0.92]) }
        : tete === "large"
          ? { sphere: R([headR * 1.15, headR * 0.9, headR]) }
          : { sphere: R([headR, headR, headR]) };
  parts.push({ name: "tete", parent: "torse", at: [0, sh(torsoH + h * 0.01), 0], ...tShape, off: [0, sh(headR), 0], role: "peau" });
  const faceZ = headR * (tete === "carree" ? 0.92 : 0.86);
  const eyeY = headR * (museau > 0.5 ? 1.25 : 1.12);
  if (yeux === "visiere") {
    parts.push({ name: "visiere", parent: "tete", at: [0, sh(eyeY), sh(faceZ)], box: R([headR * 1.3, headR * 0.38, headR * 0.12, headR * 0.12]), role: "oeil", glow: 0.6 });
  } else {
    const er = headR * (yeux === "grands" ? 0.3 : yeux === "globes" ? 0.32 : 0.22);
    const ex = headR * (yeux === "globes" ? 0.5 : 0.38);
    const ey = yeux === "globes" ? headR * 1.85 : eyeY;
    const ez = yeux === "globes" ? headR * 0.3 : faceZ - er * 0.35;
    parts.push({ name: "oeil", parent: "tete", mirror: "x", at: R([ex, ey, ez]), sphere: R([er, yeux === "amande" ? er * 0.75 : er, er * 0.6]), role: "oeil" });
    parts.push({ name: "pupille", parent: "oeil", at: R([0, 0, er * 0.5]), sphere: R([er * 0.48, er * (yeux === "amande" ? 0.5 : 0.55), er * 0.25]), role: "pupille" });
    parts.push({ name: "reflet", parent: "pupille", at: R([er * 0.18, er * 0.2, er * 0.14]), sphere: R([er * 0.15, er * 0.15, er * 0.06]), role: "blanc", glow: 1 });
  }
  if (museau > 0.05) {
    const mz = headR * (0.25 + museau * 0.6);
    parts.push({ name: "museau", parent: "tete", at: R([0, headR * 0.8, faceZ * 0.85]), sphere: R([headR * 0.42, headR * 0.3, mz]), off: R([0, 0, mz * 0.5]), role: "museau" });
    parts.push({ name: "nez", parent: "museau", at: R([0, headR * 0.12, mz * 1.4]), sphere: R([headR * 0.12, headR * 0.09, headR * 0.08]), role: "pupille" });
  } else if (espece !== "robot") {
    parts.push({ name: "nez", parent: "tete", at: R([0, eyeY - headR * 0.32, faceZ + headR * 0.08]), sphere: R([headR * 0.09, headR * 0.08, headR * 0.08]), role: "peau" });
  }
  parts.push({ name: "bouche", parent: "tete", at: R([0, headR * 0.62, faceZ * 0.97]), torus: R([headR * 0.18, headR * 0.035, 180]), rot: [0, 0, 180], role: "pupille" });

  // Oreilles
  const ear = (o: Partial<PartIn>) => parts.push({ name: "oreille", parent: "tete", mirror: "x", role: "peau", ...o });
  if (oreilles === "pointues") ear({ at: R([headR * 0.62, headR * 1.7, 0]), rot: [0, 0, -18], cone: R([headR * 0.32, headR * 0.7]), off: R([0, headR * 0.3, 0]) });
  else if (oreilles === "rondes") ear({ at: R([headR * 0.72, headR * 1.7, 0]), sphere: R([headR * 0.3, headR * 0.3, headR * 0.14]) });
  else if (oreilles === "longues") ear({ at: R([headR * 0.4, headR * 1.8, 0]), rot: [-8, 0, -12], capsule: R([headR * 0.2, headR * 1.3]), off: R([0, headR * 0.8, 0]), scale: [1, 1, 0.45] });
  else if (oreilles === "humaines") ear({ at: R([headR * 0.98, headR * 1.05, 0]), sphere: R([headR * 0.1, headR * 0.2, headR * 0.16]) });
  else if (oreilles === "antennes") {
    ear({ at: R([headR * 0.55, headR * 1.85, 0]), cylinder: R([headR * 0.04, headR * 0.6]), off: R([0, headR * 0.3, 0]), role: "metal" });
    parts.push({ name: "lampe", parent: "oreille", at: R([0, headR * 0.65, 0]), sphere: [round3(headR * 0.12)], role: "accent", glow: 0.8 });
  }
  if (cornes !== "aucune") {
    const k = cornes === "grandes" ? 1 : 0.5;
    parts.push({ name: "corne", parent: "tete", mirror: "x", at: R([headR * 0.45, headR * 1.75, headR * 0.1]), rot: [0, 0, -25], cone: R([headR * 0.16 * (1 + k), headR * 0.7 * k * 1.6]), off: R([0, headR * 0.45 * k, 0]), role: "corne" });
  }
  // Cheveux
  if (cheveux === "court" || cheveux === "bol") {
    parts.push({ name: "cheveux", parent: "tete", at: R([0, headR * (cheveux === "bol" ? 1.2 : 1.35), -headR * 0.08]), sphere: R([headR * 1.06, headR * (cheveux === "bol" ? 0.95 : 0.78), headR * 1.04]), role: "cheveux" });
  } else if (cheveux === "epis") {
    parts.push({ name: "meche", parent: "tete", at: R([0, headR * 1.9, 0]), repeat: { n: 5, rot: [0, 72, 0] }, rot: [0, 0, 25], cone: R([headR * 0.22, headR * 0.6]), off: R([0, headR * 0.15, 0]), role: "cheveux" });
  } else if (cheveux === "crete") {
    parts.push({ name: "crete", parent: "tete", at: R([0, headR * 1.85, headR * 0.5]), repeat: { n: 4, at: [0, round3(headR * 0.08), round3(-headR * 0.42)] }, cone: R([headR * 0.2, headR * 0.45]), off: R([0, headR * 0.18, 0]), role: "crete" });
  }

  // Bras
  parts.push({ name: "bras", parent: "torse", mirror: "x", at: R([torsoW * 1.08, torsoH * 0.88, 0]), rot: [0, 0, 8], capsule: R([limbR, armL * 0.5 - limbR]), off: R([0, -armL * 0.25, 0]), role: "maillot" });
  parts.push({ name: "avantbras", parent: "bras", at: R([0, -armL * 0.5, 0]), capsule: R([limbR * 0.9, armL * 0.45 - limbR]), off: R([0, -armL * 0.23, 0]), role: "peau" });
  parts.push({ name: "main", parent: "avantbras", at: R([0, -armL * 0.48, 0]), sphere: R([limbR * 1.5, limbR * 1.6, limbR * 1.4]), role: espece === "robot" ? "metal" : "peau" });
  // Jambes
  const hipX = torsoW * 0.5;
  parts.push({ name: "cuisse", parent: "bassin", mirror: "x", at: R([hipX, -h * 0.02, 0]), capsule: R([limbR * 1.3, legL * 0.5 - limbR * 1.3]), off: R([0, -legL * 0.25, 0]), role: "short" });
  parts.push({ name: "mollet", parent: "cuisse", at: R([0, -legL * 0.5, 0]), capsule: R([limbR * 1.05, legL * 0.42 - limbR]), off: R([0, -legL * 0.22, 0]), role: "chaussette" });
  parts.push({ name: "pied", parent: "mollet", at: R([0, -legL * 0.47, 0]), box: R([limbR * 2.6, limbR * 1.8, limbR * 4.4, limbR * 0.8]), off: R([0, -limbR * 0.4, limbR * 0.9]), role: "chaussure" });

  // Queue (chaîne de 3 segments)
  if (queue !== "aucune") {
    const ql = queue === "courte" ? h * 0.06 : h * 0.16;
    const qr = queue === "touffue" ? limbR * 2.2 : queue === "courte" ? limbR * 1.8 : limbR;
    let parent = "bassin";
    const n = queue === "courte" ? 1 : 3;
    for (let i = 0; i < n; i++) {
      const name = `queue${i}`;
      const qk = qr * (queue === "touffue" ? 1 + i * 0.35 : 1 - i * 0.18);
      parts.push({
        name,
        parent,
        at: i === 0 ? R([0, h * 0.02, -torsoW * 0.6]) : R([0, 0, -ql]),
        rot: i === 0 ? [-35, 0, 0] : [-12, 0, 0],
        sphere: R([qk, qk, ql * 0.62]),
        off: R([0, 0, -ql / 2]),
        role: i === n - 1 && queue === "touffue" ? "blanc" : "peau",
      });
      parent = name;
    }
  }

  const k = h; // amplitudes de translation proportionnelles à la taille
  const clips: Record<string, ClipIn> = {
    idle: { ms: 1800, tracks: { bassin: { y: [0, -0.008 * k] }, torse: { rx: [0, 2] }, tete: { rx: [0, -3], ry: [-4, 4] }, bras: { rz: [6, 10], sync: true }, queue0: { ry: [-15, 15] } } },
    marche: {
      ms: 760,
      tracks: {
        cuisse: { rx: [-26, 0, 24, 0] },
        mollet: { rx: [4, 30, 12, 0] },
        pied: { rx: [10, -10, 0, 0] },
        bras: { rx: [24, 0, -24, 0], rz: [8, 8], sync: false },
        avantbras: { rx: [-12, -22, -12, -4] },
        bassin: { y: [0, 0.018 * k, 0, 0.018 * k], ry: [-5, 0, 5, 0] },
        torse: { ry: [6, 0, -6, 0] },
        tete: { rx: [0, 3, 0, 3] },
        queue0: { ry: [-20, 20] },
      },
    },
    course: {
      ms: 440,
      tracks: {
        cuisse: { rx: [-55, -10, 38, 0] },
        mollet: { rx: [20, 85, 40, 10] },
        bras: { rx: [55, 0, -50, 0], rz: [12, 12] },
        avantbras: { rx: [-75, -85, -75, -70] },
        bassin: { y: [0.02 * k, 0.05 * k, 0.02 * k, 0.05 * k] },
        torse: { rx: [12, 14, 12, 14], ry: [10, 0, -10, 0] },
        queue0: { ry: [-25, 25], rx: [10, 10] },
      },
    },
    controle: {
      ms: 520,
      tracks: {
        cuisse: { rx: [-18, 0, 12, 0] },
        mollet: { rx: [10, 40, 15, 5] },
        bras: { rx: [10, 0, -10, 0], rz: [25, 25] },
        bassin: { y: [0, 0.015 * k] },
        torse: { rx: [10, 10] },
        tete: { rx: [14, 14] },
      },
    },
    tir: {
      ms: 560,
      loop: false,
      then: "idle",
      tracks: {
        cuisseR: { rx: [0, 45, 50, -75, -40, 0] },
        molletR: { rx: [0, 60, 85, 5, 10, 0] },
        cuisseL: { rx: [0, -8, -10, 5, 0, 0] },
        brasL: { rz: [8, 35, 50, 40, 20, 8], rx: [0, -20, -30, 10, 0, 0] },
        brasR: { rz: [8, 30, 40, 30, 15, 8], rx: [0, 30, 40, -20, 0, 0] },
        torse: { rx: [0, -8, -12, 14, 6, 0], ry: [0, 15, 20, -10, 0, 0] },
        bassin: { y: [0, -0.02 * k, -0.03 * k, 0.01 * k, 0, 0] },
      },
    },
    passe: {
      ms: 440,
      loop: false,
      then: "idle",
      tracks: {
        cuisseR: { rx: [0, 25, -35, 0], ry: [0, -20, -30, 0] },
        molletR: { rx: [0, 30, 10, 0] },
        brasL: { rz: [8, 25, 30, 8] },
        torse: { ry: [0, 10, -8, 0] },
      },
    },
    tacle: {
      ms: 760,
      loop: false,
      then: "idle",
      tracks: {
        bassin: { rx: [0, -55, -65, -50, 0], y: [0, -hipY * 0.7, -hipY * 0.8, -hipY * 0.55, 0] },
        cuisseL: { rx: [0, -60, -75, -60, 0] },
        cuisseR: { rx: [0, 20, 35, 30, 0] },
        molletR: { rx: [0, 70, 90, 70, 0] },
        bras: { rz: [8, 60, 70, 50, 8], sync: true },
        torse: { rx: [0, 25, 30, 20, 0] },
      },
    },
    chute: {
      ms: 900,
      loop: false,
      tracks: {
        bassin: { rx: [0, -40, -82, -88], y: [0, -hipY * 0.35, -hipY * 0.78, -hipY * 0.8] },
        bras: { rz: [8, 70, 95, 100], sync: true },
        cuisse: { rx: [0, -30, -20, -10], sync: true },
        tete: { rx: [0, 15, 5, 0] },
      },
    },
    saut: {
      ms: 650,
      loop: false,
      then: "idle",
      tracks: {
        bassin: { y: [0, -0.06 * k, 0.32 * k, 0.2 * k, 0] },
        cuisse: { rx: [0, -20, -50, -30, 0], sync: true },
        mollet: { rx: [0, 40, 80, 40, 0], sync: true },
        bras: { rz: [8, 20, 150, 110, 8], sync: true },
      },
    },
    joie: {
      ms: 700,
      tracks: {
        bassin: { y: [0, 0.12 * k, 0] },
        bras: { rz: [150, 165, 150], rx: [0, -10, 0], sync: true },
        avantbras: { rx: [-20, 0, -20], sync: true },
        cuisse: { rx: [0, -15, 0], sync: true },
        mollet: { rx: [0, 30, 0], sync: true },
        tete: { rx: [-10, -15, -10] },
      },
    },
    plongeon: {
      ms: 700,
      loop: false,
      tracks: {
        bassin: { rz: [0, 50, 85, 88], y: [0, 0.1 * k, -hipY * 0.55, -hipY * 0.75], x: [0, 0.2 * k, 0.45 * k, 0.5 * k] },
        bras: { rz: [8, 120, 170, 170], sync: true },
      },
    },
  };
  return {
    parts,
    clips,
    clip: "idle",
    roles: {
      peau,
      museau: "#f8fafc",
      ventre: "#fde68a",
      corne: "#f8fafc",
      crete: "#f97316",
      numero: "#f8fafc",
      chaussette: "#f8fafc",
    },
  };
}

/* ------------------------------------------------------------------ quadrupède */

function quadrupede(r: Rand, p: Record<string, unknown>): PresetOut {
  const h = nb(p.taille, 0.3, 1.8, r);
  const longueur = nb(p.longueur, 1.1, 1.8, r);
  const oreilles = str(p.oreilles, ["pointues", "rondes", "tombantes"], r);
  const queue = str(p.queue, ["courte", "longue", "touffue"], r);
  const peau = isHex(p.peau) ? p.peau : r.pick(["#a16207", "#78350f", "#f5f5f4", "#57534e", "#ea580c", "#1c1917"]);
  const legL = h * 0.5;
  const bodyL = h * longueur * 0.55;
  const bodyR = h * 0.2;
  const headR = h * 0.17;
  const lr = h * 0.045;
  const parts: PartIn[] = [
    { name: "corps", at: R([0, legL + bodyR * 0.5, 0]), sphere: R([bodyR, bodyR * 0.95, bodyL]), role: "peau" },
    { name: "cou", parent: "corps", at: R([0, bodyR * 0.4, bodyL * 0.8]), rot: [-35, 0, 0], capsule: R([headR * 0.5, headR * 0.9]), off: R([0, headR * 0.5, 0]), role: "peau" },
    { name: "tete", parent: "cou", at: R([0, headR * 1.3, 0]), rot: [35, 0, 0], sphere: R([headR, headR * 0.9, headR * 1.05]), role: "peau" },
    { name: "museau", parent: "tete", at: R([0, -headR * 0.2, headR * 0.8]), sphere: R([headR * 0.55, headR * 0.45, headR * 0.6]), role: "museau" },
    { name: "nez", parent: "museau", at: R([0, headR * 0.1, headR * 0.55]), sphere: R([headR * 0.18, headR * 0.12, headR * 0.1]), role: "pupille" },
    { name: "oeil", parent: "tete", mirror: "x", at: R([headR * 0.45, headR * 0.3, headR * 0.75]), sphere: R([headR * 0.16, headR * 0.18, headR * 0.1]), role: "pupille" },
    { name: "reflet", parent: "oeilL", at: R([headR * 0.05, headR * 0.06, headR * 0.06]), sphere: [round3(headR * 0.05)], role: "blanc", glow: 1 },
    { name: "reflet2", parent: "oeilR", at: R([headR * 0.05, headR * 0.06, headR * 0.06]), sphere: [round3(headR * 0.05)], role: "blanc", glow: 1 },
  ];
  if (oreilles === "pointues") parts.push({ name: "oreille", parent: "tete", mirror: "x", at: R([headR * 0.55, headR * 0.75, -headR * 0.1]), rot: [0, 0, -15], cone: R([headR * 0.3, headR * 0.6]), off: R([0, headR * 0.25, 0]), role: "peau" });
  else if (oreilles === "rondes") parts.push({ name: "oreille", parent: "tete", mirror: "x", at: R([headR * 0.65, headR * 0.75, -headR * 0.1]), sphere: R([headR * 0.28, headR * 0.28, headR * 0.12]), role: "peau" });
  else parts.push({ name: "oreille", parent: "tete", mirror: "x", at: R([headR * 0.85, headR * 0.5, -headR * 0.1]), rot: [0, 0, 30], capsule: R([headR * 0.22, headR * 0.6]), off: R([0, -headR * 0.4, 0]), scale: [0.5, 1, 1], role: "taches" });
  for (const [nm, z] of [["avant", bodyL * 0.62], ["arriere", -bodyL * 0.62]] as const) {
    parts.push({ name: nm, parent: "corps", mirror: "x", at: R([bodyR * 0.62, -bodyR * 0.4, z]), capsule: R([lr * 1.3, legL * 0.5 - lr]), off: R([0, -legL * 0.25, 0]), role: "peau" });
    parts.push({ name: `${nm}Bas`, parent: nm, at: R([0, -legL * 0.5, 0]), capsule: R([lr, legL * 0.45 - lr]), off: R([0, -legL * 0.24, 0]), role: "patte" });
  }
  // la queue
  const ql = queue === "courte" ? h * 0.12 : h * 0.35;
  parts.push({ name: "queue", parent: "corps", at: R([0, bodyR * 0.5, -bodyL * 0.95]), rot: [queue === "longue" ? -30 : -60, 0, 0], sphere: R([lr * (queue === "touffue" ? 2.6 : 1.1), lr * (queue === "touffue" ? 2.6 : 1.1), ql / 2]), off: R([0, 0, -ql / 2]), role: queue === "touffue" ? "blanc" : "peau" });
  const k = h;
  const clips: Record<string, ClipIn> = {
    idle: { ms: 2000, tracks: { corps: { y: [0, 0.006 * k] }, cou: { rx: [0, 6] }, queue: { ry: [-20, 20] } } },
    marche: {
      ms: 900,
      tracks: {
        avant: { rx: [-25, 0, 25, 0] },
        avantBas: { rx: [0, -10, -35, -10] },
        arriere: { rx: [25, 0, -25, 0], phase: 0.5 },
        arriereBas: { rx: [-35, -10, 0, -10], phase: 0.5 },
        corps: { y: [0, 0.015 * k, 0, 0.015 * k] },
        cou: { rx: [0, 4, 0, 4] },
        queue: { ry: [-15, 15] },
      },
    },
    course: {
      ms: 480,
      tracks: {
        avant: { rx: [-55, 40], sync: true },
        avantBas: { rx: [-10, -60], sync: true },
        arriere: { rx: [50, -45], sync: true, phase: 0.5 },
        arriereBas: { rx: [-60, -5], sync: true, phase: 0.5 },
        corps: { y: [0, 0.08 * k], rx: [-6, 6] },
        queue: { rx: [-10, 10] },
      },
    },
    assis: {
      ms: 500,
      loop: false,
      tracks: { corps: { rx: [0, -35], y: [0, -0.18 * k], z: [0, -0.1 * k] }, arriere: { rx: [0, -55], sync: true }, arriereBas: { rx: [0, 90], sync: true }, avant: { rx: [0, 35], sync: true }, cou: { rx: [0, 25] } },
    },
    saut: {
      ms: 700,
      loop: false,
      then: "idle",
      tracks: { corps: { y: [0, -0.05 * k, 0.4 * k, 0.15 * k, 0], rx: [0, 10, -15, 10, 0] }, avant: { rx: [0, 20, -70, 30, 0], sync: true }, arriere: { rx: [0, -20, 60, 20, 0], sync: true } },
    },
  };
  return { parts, clips, clip: "idle", roles: { peau, museau: "#f5f5f4", patte: peau, taches: "#44403c" } };
}

/* ------------------------------------------------------------------ décor */

function arbre(r: Rand, p: Record<string, unknown>): PresetOut {
  const h = nb(p.taille, 2, 8, r);
  const forme = str(p.forme, ["rond", "sapin", "palmier", "boules"], r);
  const parts: PartIn[] = [{ name: "tronc", cylinder: R([h * 0.06, h * 0.55, h * 0.04]), at: [0, round3(h * 0.275), 0], role: "bois" }];
  if (forme === "sapin") {
    for (let i = 0; i < 4; i++) parts.push({ name: `etage${i}`, parent: "tronc", at: R([0, h * (0.05 + i * 0.16), 0]), cone: R([h * (0.36 - i * 0.07), h * 0.32]), off: R([0, h * 0.16, 0]), role: "sapin" });
  } else if (forme === "palmier") {
    parts[0].rot = [0, 0, r.range(-12, 12)];
    for (let i = 0; i < 6; i++)
      parts.push({
        name: `palme${i}`,
        parent: "tronc",
        at: R([0, h * 0.28, 0]),
        rot: [0, Math.round(i * 60 + r.range(-10, 10)), 0],
        tube: { pts: [R([0, 0, 0]), R([h * 0.15, h * 0.06, 0]), R([h * 0.32, -h * 0.02, 0]), R([h * 0.42, -h * 0.14, 0])], r: round3(h * 0.035), r2: round3(h * 0.01) },
        role: "feuillage",
      });
    parts.push({ name: "noix", parent: "tronc", at: R([0, h * 0.26, 0]), sphere: [round3(h * 0.05)], role: "bois" });
  } else {
    const n = forme === "boules" ? r.int(3, 5) : 1;
    for (let i = 0; i < n; i++) {
      const s = forme === "boules" ? h * r.range(0.16, 0.24) : h * 0.32;
      parts.push({ name: `feuilles${i}`, parent: "tronc", at: R(forme === "boules" ? [r.range(-0.15, 0.15) * h, h * r.range(0.25, 0.45), r.range(-0.15, 0.15) * h] : [0, h * 0.35, 0]), sphere: R([s, s * 0.9, s]), role: "feuillage" });
    }
  }
  return { parts, roles: { sapin: "#166534", feuillage: r.pick(["#3f9d4a", "#65a30d", "#15803d", "#ca8a04", "#ea580c"]) } };
}

function rocher(r: Rand, p: Record<string, unknown>): PresetOut {
  const s = nb(p.taille, 0.3, 2, r);
  const n = r.int(1, 3);
  const parts: PartIn[] = [];
  for (let i = 0; i < n; i++) {
    const k = s * (i ? r.range(0.4, 0.7) : 1);
    parts.push({ name: `bloc${i}`, at: R([i ? r.range(-0.6, 0.6) * s : 0, k * 0.35, i ? r.range(-0.6, 0.6) * s : 0]), rot: R([r.range(-15, 15), r.range(0, 180), r.range(-15, 15)]), box: R([k, k * r.range(0.6, 0.9), k * r.range(0.7, 1), k * 0.22]), role: "pierre" });
  }
  return { parts };
}

function maison(r: Rand, p: Record<string, unknown>): PresetOut {
  const w = nb(p.largeur, 3, 7, r);
  const d = w * r.range(0.7, 1);
  const fh = nb(p.hauteur, 2.4, 5, r);
  const toit = str(p.toit, ["pente", "plat", "pointu"], r);
  const parts: PartIn[] = [{ name: "murs", at: R([0, fh / 2, 0]), box: R([w, fh, d, 0.05]), role: "mur" }];
  if (toit === "pente") parts.push({ name: "toit", parent: "murs", at: R([0, fh / 2, 0]), extrude: { pts: [R([-w * 0.58, 0]), R([w * 0.58, 0]), R([0, w * 0.42])], depth: round3(d * 1.12) }, role: "toit" });
  else if (toit === "pointu") parts.push({ name: "toit", parent: "murs", at: R([0, fh / 2, 0]), cylinder: R([w * 0.78, w * 0.6, 0]), off: R([0, w * 0.3, 0]), rot: [0, 45, 0], role: "toit" });
  else parts.push({ name: "toit", parent: "murs", at: R([0, fh / 2, 0]), box: R([w * 1.04, 0.2, d * 1.04, 0.04]), role: "toit" });
  parts.push({ name: "porte", parent: "murs", at: R([0, -fh / 2 + 0.95, d / 2 + 0.01]), box: R([0.9, 1.9, 0.06, 0.05]), role: "bois" });
  const nf = Math.max(1, Math.floor(w / 2.2));
  for (let i = 0; i < nf; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / nf;
    if (Math.abs(x) < 0.7) continue;
    parts.push({ name: `fenetre${i}`, parent: "murs", at: R([x, fh * 0.1, d / 2 + 0.01]), box: R([0.8, 0.8, 0.05, 0.04]), role: "vitre", glow: 0.25 });
  }
  if (flag(p.cheminee, 0.6, r)) parts.push({ name: "cheminee", parent: "murs", at: R([w * 0.25, fh / 2 + w * 0.3, -d * 0.1]), box: R([0.45, w * 0.45, 0.45]), role: "brique" });
  return {
    parts,
    roles: {
      mur: r.pick(["#fef3c7", "#fde68a", "#e2e8f0", "#fecaca", "#bfdbfe", "#f5f5f4"]),
      toit: r.pick(["#b91c1c", "#9a3412", "#334155", "#1e3a8a", "#065f46"]),
      vitre: "#93c5fd",
      brique: "#9a3412",
    },
  };
}

function nuage(r: Rand, p: Record<string, unknown>): PresetOut {
  const s = nb(p.taille, 1, 4, r);
  const n = r.int(3, 6);
  const parts: PartIn[] = [];
  for (let i = 0; i < n; i++) {
    const k = s * r.range(0.35, 0.6);
    parts.push({ name: `boule${i}`, at: R([(i - (n - 1) / 2) * s * 0.42, r.range(-0.1, 0.25) * s, r.range(-0.2, 0.2) * s]), sphere: R([k, k * 0.8, k]), role: "nuage" });
  }
  return { parts, roles: { nuage: "#f8fafc" }, clips: { idle: { ms: 6000, tracks: { boule0: { y: [0, 0.05 * s] } } } }, clip: "idle" };
}

function ballon(_r: Rand, p: Record<string, unknown>): PresetOut {
  const s = typeof p.taille === "number" && p.taille > 0 ? Math.min(1, p.taille) : 0.11;
  return {
    parts: [
      { name: "sphere", sphere: [round3(s)], role: "blanc" },
      { name: "penta", parent: "sphere", at: [0, 0, round3(s * 0.93)], cylinder: R([s * 0.38, s * 0.12, s * 0.38]), rot: [90, 0, 0], role: "noir" },
      { name: "penta2", parent: "sphere", at: [0, 0, round3(-s * 0.93)], cylinder: R([s * 0.38, s * 0.12, s * 0.38]), rot: [90, 0, 0], role: "noir" },
      { name: "penta3", parent: "sphere", at: [round3(s * 0.93), 0, 0], cylinder: R([s * 0.38, s * 0.12, s * 0.38]), rot: [0, 0, 90], role: "noir" },
      { name: "penta4", parent: "sphere", at: [round3(-s * 0.93), 0, 0], cylinder: R([s * 0.38, s * 0.12, s * 0.38]), rot: [0, 0, 90], role: "noir" },
      { name: "penta5", parent: "sphere", at: [0, round3(s * 0.93), 0], cylinder: R([s * 0.38, s * 0.12, s * 0.38]), role: "noir" },
      { name: "penta6", parent: "sphere", at: [0, round3(-s * 0.93), 0], cylinder: R([s * 0.38, s * 0.12, s * 0.38]), role: "noir" },
    ],
    clips: { roule: { ms: 500, tracks: { sphere: { rx: [0, 120, 240] } } } },
  };
}

export const PRESETS: Record<string, Preset> = {
  bipede: {
    doc: "Personnage ou créature debout, articulé (bassin, torse, tête, bras, avant-bras, mains, cuisses, mollets, pieds, queue) ; clips idle, marche, course, controle, tir, passe, tacle, chute, saut, joie, plongeon",
    params: {
      espece: Object.keys(ESPECES).join("|"),
      taille: "hauteur en m (0.5 à 2.2)",
      corpulence: "0.75 à 1.35",
      grosseTete: "part de la tête dans la hauteur (0.26 à 0.42, chibi au-delà de 0.33)",
      tete: "ronde|ovale|carree|large",
      oreilles: "aucune|rondes|pointues|longues|humaines|antennes",
      queue: "aucune|courte|longue|touffue",
      cornes: "aucune|petites|grandes",
      cheveux: "aucun|court|epis|crete|bol",
      yeux: "ronds|grands|amande|globes|visiere",
      museau: "0 à 1",
      ventre: "booléen",
      peau: "#rrggbb",
    },
    build: bipede,
  },
  quadrupede: {
    doc: "Animal à quatre pattes (corps, cou, tête, museau, oreilles, pattes avant / arrière en deux segments, queue) ; clips idle, marche, course, assis, saut",
    params: { taille: "hauteur au garrot env. (0.3 à 1.8)", longueur: "1.1 à 1.8", oreilles: "pointues|rondes|tombantes", queue: "courte|longue|touffue", peau: "#rrggbb" },
    build: quadrupede,
  },
  arbre: { doc: "Arbre (tronc + feuillage)", params: { taille: "m", forme: "rond|sapin|palmier|boules" }, build: arbre },
  rocher: { doc: "Rocher (1 à 3 blocs arrondis)", params: { taille: "m" }, build: rocher },
  maison: { doc: "Maison (murs, toit, porte, fenêtres, cheminée)", params: { largeur: "m", hauteur: "m", toit: "pente|plat|pointu", cheminee: "booléen" }, build: maison },
  nuage: { doc: "Nuage (boules)", params: { taille: "m" }, build: nuage },
  ballon: { doc: "Ballon de foot ; clip roule", params: { taille: "rayon en m (0.11 par défaut)" }, build: ballon },
};
