/**
 * Préréglages procéduraux 2D (dessinés pour la 2D, vue de profil, de face ou de dessus) : un modèle
 * `{preset, seed, params}` devient des pièces vectorielles et des clips ordinaires, retouchables pièce par pièce.
 * Même graine = même modèle ; un paramètre absent est tiré de la graine. Unités : px, y vers le bas, origine au sol
 * (profil, face) ou au centre (dessus) ; regard vers +x (profil, dessus).
 */
import type { Rand } from "../monde/math";
import type { Clip2In, Part2In } from "./format";

export type Preset2dOut = { parts: Part2In[]; clips?: Record<string, Clip2In>; roles?: Record<string, string>; clip?: string; height?: number };
export type Preset2d = { doc: string; params: Record<string, string>; build(r: Rand, p: Record<string, unknown>): Preset2dOut };

const isHex = (v: unknown): v is string => typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
const str = (v: unknown, list: readonly string[], r: Rand): string => (typeof v === "string" && list.includes(v) ? v : r.pick(list));
const nb = (v: unknown, a: number, b: number, r: Rand): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : r.range(a, b));
const oneOf = (v: unknown, list: readonly string[], d: string): string => (typeof v === "string" && list.includes(v) ? v : d);
const numIn = (v: unknown, a: number, b: number, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d);
const flag = (v: unknown, p: number, r: Rand): boolean => (typeof v === "boolean" ? v : r.chance(p));
const q = (n: number) => Math.round(n * 10) / 10;
const Q = (a: number[]) => a.map(q);
const QQ = (a: number[][]) => a.map(Q);

/* ------------------------------------------------------------------ personnages */

const ESPECES: Record<string, Record<string, unknown>> = {
  humain: { oreilles: "humaines", museau: 0, queue: "aucune", cornes: "aucune", yeux: "ronds", peau: ["#f2c29b", "#e0ac82", "#a66a45", "#7a4a2b", "#f5d0b5"] },
  chat: { oreilles: "pointues", museau: 0.35, queue: "longue", cornes: "aucune", cheveux: "aucun", yeux: "amande", peau: ["#f59e0b", "#9ca3af", "#f8fafc", "#1f2937", "#d6a36b"] },
  renard: { oreilles: "pointues", museau: 0.85, queue: "touffue", cornes: "aucune", cheveux: "aucun", yeux: "amande", peau: ["#ea580c", "#c2410c"] },
  ours: { oreilles: "rondes", museau: 0.55, queue: "courte", cornes: "aucune", cheveux: "aucun", yeux: "ronds", peau: ["#7c4a2b", "#a16207", "#f1f5f9", "#292524"] },
  lapin: { oreilles: "longues", museau: 0.25, queue: "courte", cornes: "aucune", cheveux: "aucun", yeux: "grands", peau: ["#f1f5f9", "#d6d3d1", "#a8a29e", "#fbcfe8"] },
  dino: { oreilles: "aucune", museau: 0.9, queue: "longue", cornes: "petites", cheveux: "crete", yeux: "ronds", peau: ["#22c55e", "#84cc16", "#14b8a6", "#a855f7"] },
  monstre: { oreilles: "aucune", museau: 0, queue: "aucune", cornes: "grandes", cheveux: "aucun", yeux: "grands", peau: ["#8b5cf6", "#f43f5e", "#06b6d4", "#84cc16"] },
  grenouille: { oreilles: "aucune", museau: 0.15, queue: "aucune", cornes: "aucune", cheveux: "aucun", yeux: "globes", peau: ["#4ade80", "#16a34a", "#a3e635"] },
  robot: { oreilles: "antennes", museau: 0, queue: "aucune", cornes: "aucune", cheveux: "aucun", yeux: "visiere", tete: "carree", peau: ["#cbd5e1", "#94a3b8", "#fde047", "#fb923c"] },
};

type Look = {
  vue: "profil" | "face" | "dessus";
  h: number;
  hr: number;
  legL: number;
  th: number;
  tw: number;
  lr: number;
  armL: number;
  tete: string;
  oreilles: string;
  queue: string;
  cornes: string;
  cheveux: string;
  yeux: string;
  museau: number;
  numero: string;
  espece: string;
};

function look(r: Rand, p: Record<string, unknown>): Look {
  const espece = str(p.espece, Object.keys(ESPECES), r);
  const E = ESPECES[espece];
  const pick = (k: string, list: readonly string[]) => str(p[k] ?? E[k], list, r);
  const vue = oneOf(p.vue, ["profil", "face", "dessus"], "profil") as Look["vue"];
  const h = numIn(p.taille, 24, 600, 64);
  const c = nb(p.corpulence, 0.75, 1.35, r);
  const big = nb(p.grosseTete, 0.26, 0.42, r);
  const hr = (h * big) / 2;
  const body = h - hr * 2;
  return {
    vue,
    h,
    hr,
    legL: body * 0.46,
    th: body * 0.44,
    tw: h * 0.15 * c,
    lr: h * 0.04 * Math.sqrt(c),
    armL: body * 0.46,
    tete: pick("tete", ["ronde", "ovale", "carree", "large"]),
    oreilles: pick("oreilles", ["aucune", "rondes", "pointues", "longues", "humaines", "antennes"]),
    queue: pick("queue", ["aucune", "courte", "longue", "touffue"]),
    cornes: pick("cornes", ["aucune", "petites", "grandes"]),
    cheveux: pick("cheveux", ["aucun", "court", "epis", "crete", "bol"]),
    yeux: pick("yeux", ["ronds", "grands", "amande", "globes", "visiere"]),
    museau: nb(p.museau ?? E.museau, 0, 1, r),
    numero: typeof p.numero === "number" || typeof p.numero === "string" ? String(p.numero).slice(0, 3) : "",
    espece,
  };
}

function headShape(L: Look): Partial<Part2In> {
  const r = L.hr;
  if (L.tete === "carree") return { rect: Q([r * 2, r * 1.85, r * 0.45]) };
  if (L.tete === "ovale") return { ellipse: Q([r * 0.9, r * 1.08]) };
  if (L.tete === "large") return { ellipse: Q([r * 1.15, r * 0.92]) };
  return { circle: q(r) };
}

/** Personnage vu de face. */
function face(L: Look): Part2In[] {
  const { h, hr, legL, th, tw, lr, armL } = L;
  const parts: Part2In[] = [
    { name: "bassin", at: [0, q(-legL)], ellipse: Q([tw * 0.95, h * 0.06]), role: "short", z: 1 },
    { name: "cuisse", parent: "bassin", mirror: "x", at: Q([tw * 0.48, 0]), capsule: Q([lr * 1.25, legL * 0.5 - lr]), off: Q([0, legL * 0.25]), role: "short", z: 0.5 },
    { name: "mollet", parent: "cuisse", at: Q([0, legL * 0.5]), capsule: Q([lr, legL * 0.42 - lr]), off: Q([0, legL * 0.22]), role: "chaussette", z: 0.6 },
    { name: "pied", parent: "mollet", at: Q([0, legL * 0.47]), ellipse: Q([lr * 1.8, lr * 1.1]), off: Q([lr * 0.3, lr * 0.2]), role: "chaussure", z: 0.7 },
    { name: "torse", parent: "bassin", at: Q([0, -h * 0.02]), rect: Q([tw * 2, th, tw * 0.7]), off: Q([0, -th / 2]), role: "maillot", z: 2 },
    { name: "bras", parent: "torse", mirror: "x", at: Q([tw * 1.02, -th * 0.86]), rot: -8, capsule: Q([lr * 1.1, armL * 0.5 - lr]), off: Q([0, armL * 0.25]), role: "maillot", z: 2.5 },
    { name: "avantbras", parent: "bras", at: Q([0, armL * 0.5]), capsule: Q([lr * 0.95, armL * 0.42 - lr]), off: Q([0, armL * 0.21]), role: "peau", z: 2.6 },
    { name: "main", parent: "avantbras", at: Q([0, armL * 0.46]), circle: q(lr * 1.35), role: "peau", z: 2.7 },
    { name: "tete", parent: "torse", at: Q([0, -th + 1]), ...headShape(L), off: Q([0, -hr * 0.92]), role: "peau", z: 4 },
  ];
  if (L.numero) parts.push({ name: "numero", parent: "torse", at: Q([0, -th * 0.5]), text: { text: L.numero, size: q(th * 0.5) }, role: "numero", z: 2.2 });
  ears(parts, L, "x", [hr * 0.62, -hr * 1.62], 3.9);
  if (L.yeux === "visiere") parts.push({ name: "visiere", parent: "tete", at: Q([0, -hr * 1.05]), rect: Q([hr * 1.5, hr * 0.4, hr * 0.18]), role: "oeil", glow: 0.6, z: 4.3 });
  else {
    const er = hr * (L.yeux === "grands" ? 0.3 : L.yeux === "globes" ? 0.32 : 0.22);
    const ey = L.yeux === "globes" ? -hr * 1.85 : -hr * (L.museau > 0.5 ? 1.12 : 1.02);
    parts.push({ name: "oeil", parent: "tete", mirror: "x", at: Q([hr * (L.yeux === "globes" ? 0.55 : 0.38), ey]), ellipse: Q([er, L.yeux === "amande" ? er * 0.75 : er * 1.1]), role: "oeil", z: 4.2, line: 0.8 });
    parts.push({ name: "pupille", parent: "oeil", at: Q([-er * 0.08, er * 0.12]), circle: q(er * 0.56), role: "pupille", z: 4.25, line: 0 });
    parts.push({ name: "reflet", parent: "pupille", at: Q([-er * 0.18, -er * 0.2]), circle: q(er * 0.2), role: "blanc", glow: 1, z: 4.26 });
  }
  if (L.museau > 0.05) {
    parts.push({ name: "museau", parent: "tete", at: Q([0, -hr * 0.6]), ellipse: Q([hr * (0.32 + L.museau * 0.2), hr * (0.24 + L.museau * 0.08)]), role: "museau", z: 4.3 });
    parts.push({ name: "nez", parent: "museau", at: Q([0, -hr * 0.12]), ellipse: Q([hr * 0.13, hr * 0.09]), role: "pupille", z: 4.35, line: 0 });
  } else if (L.espece !== "robot") parts.push({ name: "nez", parent: "tete", at: Q([0, -hr * 0.72]), ellipse: Q([hr * 0.08, hr * 0.06]), role: "joue", z: 4.3, line: 0 });
  parts.push({ name: "bouche", parent: "tete", at: Q([0, -hr * 0.5]), arc: Q([hr * 0.2, 20, 160, Math.max(1, h * 0.014)]), role: "pupille", z: 4.4, line: 0 });
  horns(parts, L, "x", [hr * 0.45, -hr * 1.7], 3.95);
  hair(parts, L, [0, -hr * 1.45], 4.5);
  tail(parts, L, "bassin", [tw * 0.9, -h * 0.02], 60, -1);
  return parts;
}

/** Personnage de profil, regard vers +x. */
function profil(L: Look): Part2In[] {
  const { h, hr, legL, th, tw, lr, armL } = L;
  const parts: Part2In[] = [
    { name: "bassin", at: [0, q(-legL)], ellipse: Q([tw * 0.8, h * 0.06]), role: "short", z: 1 },
    { name: "cuisse", parent: "bassin", mirror: "z", at: [0, 0], capsule: Q([lr * 1.3, legL * 0.5 - lr]), off: Q([0, legL * 0.25]), role: "short", z: 0.5 },
    { name: "mollet", parent: "cuisse", at: Q([0, legL * 0.5]), capsule: Q([lr * 1.05, legL * 0.42 - lr]), off: Q([0, legL * 0.22]), role: "chaussette", z: 0.6 },
    { name: "pied", parent: "mollet", at: Q([0, legL * 0.47]), ellipse: Q([lr * 2.1, lr * 1.1]), off: Q([lr * 0.9, lr * 0.2]), role: "chaussure", z: 0.7 },
    { name: "torse", parent: "bassin", at: Q([0, -h * 0.02]), rect: Q([tw * 1.45, th, tw * 0.6]), off: Q([0, -th / 2]), role: "maillot", z: 2 },
    // bras proche devant tout (bras levés devant la tête), bras éloigné derrière le torse
    { name: "bras", parent: "torse", mirror: "z", mirrorZ: -3.2, at: Q([0, -th * 0.86]), capsule: Q([lr * 1.1, armL * 0.5 - lr]), off: Q([0, armL * 0.25]), role: "maillot", z: 4.8 },
    { name: "avantbras", parent: "bras", at: Q([0, armL * 0.5]), capsule: Q([lr * 0.95, armL * 0.42 - lr]), off: Q([0, armL * 0.21]), role: "peau", z: 4.9 },
    { name: "main", parent: "avantbras", at: Q([0, armL * 0.46]), circle: q(lr * 1.35), role: "peau", z: 4.95 },
    { name: "tete", parent: "torse", at: Q([tw * 0.1, -th + 1]), ...headShape(L), off: Q([hr * 0.08, -hr * 0.92]), role: "peau", z: 4 },
  ];
  if (L.numero) parts.push({ name: "numero", parent: "torse", at: Q([-tw * 0.2, -th * 0.5]), text: { text: L.numero, size: q(th * 0.5) }, role: "numero", z: 2.2, opacity: 0.9 });
  ears(parts, L, "z", [-hr * 0.15, -hr * 1.65], 3.8);
  if (L.yeux === "visiere") parts.push({ name: "visiere", parent: "tete", at: Q([hr * 0.55, -hr * 1.02]), rect: Q([hr * 0.8, hr * 0.4, hr * 0.18]), role: "oeil", glow: 0.6, z: 4.3 });
  else {
    const er = hr * (L.yeux === "grands" ? 0.3 : L.yeux === "globes" ? 0.3 : 0.22);
    const at = L.yeux === "globes" ? [hr * 0.35, -hr * 1.85] : [hr * 0.5, -hr * (L.museau > 0.5 ? 1.15 : 1.02)];
    parts.push({ name: "oeil", parent: "tete", at: Q(at), ellipse: Q([er * 0.8, L.yeux === "amande" ? er * 0.75 : er * 1.1]), role: "oeil", z: 4.2, line: 0.8 });
    parts.push({ name: "pupille", parent: "oeil", at: Q([er * 0.25, er * 0.1]), circle: q(er * 0.5), role: "pupille", z: 4.25, line: 0 });
    parts.push({ name: "reflet", parent: "pupille", at: Q([-er * 0.12, -er * 0.18]), circle: q(er * 0.18), role: "blanc", glow: 1, z: 4.26 });
  }
  if (L.museau > 0.05) {
    const ml = hr * (0.3 + L.museau * 0.55);
    parts.push({ name: "museau", parent: "tete", at: Q([hr * 0.75, -hr * 0.62]), ellipse: Q([ml, hr * 0.28]), off: Q([ml * 0.45, 0]), role: "museau", z: 4.3 });
    parts.push({ name: "nez", parent: "museau", at: Q([ml * 1.35, -hr * 0.1]), ellipse: Q([hr * 0.12, hr * 0.09]), role: "pupille", z: 4.35, line: 0 });
  } else if (L.espece !== "robot") parts.push({ name: "nez", parent: "tete", at: Q([hr * 0.98, -hr * 0.75]), ellipse: Q([hr * 0.1, hr * 0.08]), role: "peau", z: 4.3 });
  parts.push({ name: "bouche", parent: "tete", at: Q([hr * (L.museau > 0.05 ? 1.0 : 0.72), -hr * 0.45]), arc: Q([hr * 0.14, 30, 120, Math.max(1, h * 0.014)]), role: "pupille", z: 4.4, line: 0 });
  horns(parts, L, "z", [hr * 0.15, -hr * 1.75], 3.95);
  hair(parts, L, [-hr * 0.2, -hr * 1.4], 4.5);
  tail(parts, L, "bassin", [-tw * 0.75, -h * 0.02], 115, -1.5);
  return parts;
}

/** Personnage vu de dessus, regard vers +x (origine : centre du corps). */
function dessus(L: Look): Part2In[] {
  const { hr, tw, lr } = L;
  const parts: Part2In[] = [
    { name: "pied", mirror: "y", at: Q([0, tw * 0.45]), ellipse: Q([lr * 2.4, lr * 1.3]), off: Q([lr * 0.8, 0]), role: "chaussure", z: 0 },
    { name: "corps", ellipse: Q([tw * 0.95, tw * 1.55]), role: "maillot", z: 2 },
    { name: "bras", parent: "corps", mirror: "y", at: Q([0, tw * 1.45]), ellipse: Q([lr * 1.7, lr * 1.25]), role: "maillot", z: 1.9 },
    { name: "main", parent: "bras", at: Q([lr * 1.5, lr * 0.2]), circle: q(lr * 1.15), role: "peau", z: 1.95 },
    { name: "tete", parent: "corps", at: Q([tw * 0.12, 0]), ...(L.tete === "carree" ? { rect: Q([hr * 1.8, hr * 1.8, hr * 0.45]) } : { circle: q(hr * 0.95) }), role: "peau", z: 4 },
  ];
  if (L.numero) parts.push({ name: "numero", parent: "corps", at: Q([-tw * 0.55, 0]), rot: 90, text: { text: L.numero, size: q(tw * 1.15) }, role: "numero", z: 2.2 });
  if (L.cheveux !== "aucun") parts.push({ name: "cheveux", parent: "tete", at: Q([-hr * 0.22, 0]), ellipse: Q([hr * 0.72, hr * 0.9]), role: "cheveux", z: 4.1 });
  if (L.cheveux === "crete") parts.push({ name: "crete", parent: "tete", at: Q([hr * 0.3, 0]), repeat: { n: 4, at: [q(-hr * 0.32), 0] }, poly: QQ([[-hr * 0.12, -hr * 0.12], [hr * 0.18, 0], [-hr * 0.12, hr * 0.12]]), role: "crete", z: 4.2 });
  const o = L.oreilles;
  if (o === "pointues") parts.push({ name: "oreille", parent: "tete", mirror: "y", at: Q([-hr * 0.05, hr * 0.7]), poly: QQ([[-hr * 0.3, 0], [hr * 0.25, 0], [-hr * 0.05, hr * 0.55]]), role: "peau", z: 3.9 });
  else if (o === "rondes") parts.push({ name: "oreille", parent: "tete", mirror: "y", at: Q([-hr * 0.1, hr * 0.85]), circle: q(hr * 0.3), role: "peau", z: 3.9 });
  else if (o === "longues") parts.push({ name: "oreille", parent: "tete", mirror: "y", at: Q([-hr * 0.2, hr * 0.35]), rot: -70, capsule: Q([hr * 0.2, hr * 1.1]), off: Q([0, hr * 0.7]), role: "peau", z: 4.3 });
  else if (o === "humaines") parts.push({ name: "oreille", parent: "tete", mirror: "y", at: Q([0, hr * 0.95]), ellipse: Q([hr * 0.16, hr * 0.12]), role: "peau", z: 3.9 });
  else if (o === "antennes") parts.push({ name: "oreille", parent: "tete", mirror: "y", at: Q([0, hr * 0.5]), circle: q(hr * 0.16), role: "accent", glow: 0.6, z: 4.3 });
  if (L.museau > 0.05) {
    const ml = hr * (0.3 + L.museau * 0.5);
    parts.push({ name: "museau", parent: "tete", at: Q([hr * 0.72, 0]), ellipse: Q([ml, hr * 0.36]), off: Q([ml * 0.4, 0]), role: "museau", z: 4.2 });
    parts.push({ name: "nez", parent: "museau", at: Q([ml * 1.25, 0]), ellipse: Q([hr * 0.1, hr * 0.14]), role: "pupille", z: 4.3, line: 0 });
  } else parts.push({ name: "nez", parent: "tete", at: Q([hr * 0.9, 0]), ellipse: Q([hr * 0.1, hr * 0.12]), role: "peau", z: 4.2 });
  if (L.yeux !== "visiere") parts.push({ name: "oeil", parent: "tete", mirror: "y", at: Q([hr * 0.66, hr * 0.36]), ellipse: Q([hr * 0.1, hr * 0.13]), role: "pupille", z: 4.25, line: 0 });
  else parts.push({ name: "visiere", parent: "tete", at: Q([hr * 0.75, 0]), rect: Q([hr * 0.25, hr * 1.2, hr * 0.1]), role: "oeil", glow: 0.6, z: 4.25 });
  if (L.cornes !== "aucune") parts.push({ name: "corne", parent: "tete", mirror: "y", at: Q([hr * 0.15, hr * 0.55]), poly: QQ([[-hr * 0.15, 0], [hr * 0.15, 0], [0, hr * (L.cornes === "grandes" ? 0.75 : 0.45)]]), role: "corne", z: 4.3 });
  tail(parts, L, "corps", [-tw * 0.8, 0], 90, 1);
  return parts;
}

function ears(parts: Part2In[], L: Look, m: "x" | "z", at: number[], z: number) {
  const hr = L.hr;
  const o = L.oreilles;
  const base = { name: "oreille", parent: "tete", mirror: m, z, role: "peau" } as Part2In;
  if (o === "pointues") {
    parts.push({ ...base, at: Q(at), rot: m === "x" ? 12 : -10, poly: QQ([[-hr * 0.32, 0], [hr * 0.28, 0], [0, -hr * 0.75]]) });
    parts.push({ name: "oreilleInt", parent: "oreille", at: Q([0, -hr * 0.08]), poly: QQ([[-hr * 0.16, 0], [hr * 0.14, 0], [0, -hr * 0.45]]), role: "interieur", z: z + 0.01, line: 0 });
  } else if (o === "rondes") {
    parts.push({ ...base, at: Q([at[0] + (m === "x" ? hr * 0.1 : 0), at[1] + hr * 0.1]), circle: q(hr * 0.32) });
    parts.push({ name: "oreilleInt", parent: "oreille", at: [0, 0], circle: q(hr * 0.17), role: "interieur", z: z + 0.01, line: 0 });
  } else if (o === "longues") {
    parts.push({ ...base, at: Q([at[0] * (m === "x" ? 0.6 : 1), at[1]]), rot: m === "x" ? 8 : -12, capsule: Q([hr * 0.24, hr * 1.2]), off: Q([0, -hr * 0.75]) });
    parts.push({ name: "oreilleInt", parent: "oreille", at: [0, 0], capsule: Q([hr * 0.11, hr * 0.95]), off: Q([0, -hr * 0.72]), role: "interieur", z: z + 0.01, line: 0 });
  } else if (o === "humaines" && m === "x") parts.push({ ...base, at: Q([hr * 0.98, -hr * 0.95]), ellipse: Q([hr * 0.14, hr * 0.22]) });
  else if (o === "humaines") parts.push({ ...base, mirror: undefined, at: Q([-hr * 0.1, -hr * 0.95]), ellipse: Q([hr * 0.16, hr * 0.22]), z: 4.1 });
  else if (o === "antennes") {
    parts.push({ ...base, at: Q(at), rot: m === "x" ? 15 : 0, trait: { pts: QQ([[0, 0], [0, -hr * 0.6]]) }, fill: false, line: q(Math.max(1, hr * 0.08)), role: "metal", z: z } as Part2In);
    parts.push({ name: "lampe", parent: "oreille", at: Q([0, -hr * 0.65]), circle: q(hr * 0.14), role: "accent", glow: 0.8, z: z + 0.01 });
  }
}

function horns(parts: Part2In[], L: Look, m: "x" | "z", at: number[], z: number) {
  if (L.cornes === "aucune") return;
  const hr = L.hr, k = L.cornes === "grandes" ? 1 : 0.55;
  parts.push({ name: "corne", parent: "tete", mirror: m, at: Q(at), rot: m === "x" ? 20 : 15, poly: QQ([[-hr * 0.15, 0], [hr * 0.15, 0], [hr * 0.05, -hr * 0.9 * k]]), role: "corne", z });
}

function hair(parts: Part2In[], L: Look, at: number[], z: number) {
  const hr = L.hr;
  if (L.cheveux === "court") parts.push({ name: "cheveux", parent: "tete", at: Q(at), blob: QQ([[-hr * 0.95, hr * 0.15], [-hr * 0.8, -hr * 0.45], [0, -hr * 0.62], [hr * 0.8, -hr * 0.45], [hr * 0.95, hr * 0.15], [0, -hr * 0.2]]), role: "cheveux", z });
  else if (L.cheveux === "bol") parts.push({ name: "cheveux", parent: "tete", at: Q(at), blob: QQ([[-hr * 1.02, hr * 0.45], [-hr * 0.9, -hr * 0.45], [0, -hr * 0.65], [hr * 0.9, -hr * 0.45], [hr * 1.02, hr * 0.45], [0, hr * 0.05]]), role: "cheveux", z });
  else if (L.cheveux === "epis") parts.push({ name: "meche", parent: "tete", at: Q(at), repeat: { n: 5, rot: 22 }, rot: -44, poly: QQ([[-hr * 0.2, 0], [hr * 0.2, 0], [0, -hr * 0.7]]), off: Q([0, -hr * 0.2]), role: "cheveux", z });
  else if (L.cheveux === "crete") parts.push({ name: "crete", parent: "tete", at: Q([at[0] - hr * 0.5, at[1]]), repeat: { n: 4, at: [q(hr * 0.33), 0] }, poly: QQ([[-hr * 0.16, 0], [hr * 0.16, 0], [0, -hr * 0.5]]), role: "crete", z: z - 0.6 });
}

function tail(parts: Part2In[], L: Look, parent: string, at: number[], rot: number, z: number) {
  if (L.queue === "aucune") return;
  const h = L.h, lr = L.lr;
  const n = L.queue === "courte" ? 1 : 3;
  const ql = L.queue === "courte" ? h * 0.06 : h * 0.13;
  let p = parent;
  for (let i = 0; i < n; i++) {
    const r = L.queue === "touffue" ? lr * (1.4 + i * 0.6) : L.queue === "courte" ? lr * 1.8 : lr * (1.1 - i * 0.18);
    parts.push({ name: `queue${i}`, parent: p, at: i ? [0, q(ql)] : Q(at), rot: i ? -18 : rot, capsule: Q([r, ql]), off: Q([0, ql / 2]), role: L.queue === "touffue" && i === n - 1 ? "blanc" : "peau", z: z - i * 0.01 });
    p = `queue${i}`;
  }
}

function persoClips(L: Look): Record<string, Clip2In> {
  const h = L.h;
  if (L.vue === "dessus") {
    const s = L.tw;
    return {
      idle: { ms: 1800, tracks: { corps: { r: [-2, 2] }, tete: { r: [-6, 6] }, queue0: { r: [70, 110] } } },
      marche: { ms: 700, tracks: { pied: { x: Q([-s * 0.5, s * 0.5]) }, bras: { x: Q([s * 0.35, -s * 0.35]) }, corps: { r: [-5, 5] }, tete: { r: [3, -3] }, queue0: { r: [75, 105] } } },
      course: { ms: 420, tracks: { pied: { x: Q([-s * 0.9, s * 0.9]) }, bras: { x: Q([s * 0.6, -s * 0.6]) }, corps: { r: [-8, 8] }, tete: { r: [5, -5] }, queue0: { r: [70, 110] } } },
      controle: { ms: 520, tracks: { pied: { x: Q([-s * 0.3, s * 0.45]) }, corps: { r: [-4, 4] }, tete: { r: [0, 0] } } },
      tir: { ms: 520, loop: false, then: "idle", tracks: { piedR: { x: Q([0, -s * 0.8, s * 1.4, s * 0.7, 0]) }, corps: { r: [0, -14, 18, 8, 0] }, brasL: { x: Q([0, s * 0.5, -s * 0.4, 0, 0]) } } },
      passe: { ms: 420, loop: false, then: "idle", tracks: { piedR: { x: Q([0, -s * 0.4, s * 0.9, 0]), y: Q([0, 0, -s * 0.3, 0]) }, corps: { r: [0, -8, 10, 0] } } },
      tacle: { ms: 700, loop: false, then: "idle", tracks: { piedL: { x: Q([0, s * 2.2, s * 2.4, s * 1.5, 0]) }, corps: { r: [0, 25, 30, 20, 0], sx: [1, 1.25, 1.3, 1.15, 1] }, tete: { x: Q([0, -s * 0.5, -s * 0.6, -s * 0.3, 0]) } } },
      chute: { ms: 800, loop: false, tracks: { corps: { sx: [1, 1.5, 1.75], r: [0, 20, 30] }, tete: { x: Q([0, -s * 1.2, -s * 1.7]) }, pied: { x: Q([0, s * 1.2, s * 1.8]), sync: true }, bras: { y: Q([0, s * 0.5, s * 0.8]), sync: true } } },
      saut: { ms: 600, loop: false, then: "idle", tracks: { corps: { s: [1, 1.18, 1.25, 1.1, 1] }, pied: { x: Q([0, -s * 0.3, -s * 0.3, 0, 0]), sync: true } } },
      joie: { ms: 650, tracks: { bras: { y: Q([s * 0.9, s * 1.2]), x: Q([s * 0.3, s * 0.5]), sync: true }, corps: { s: [1, 1.08] }, tete: { r: [-10, 10] } } },
      plongeon: { ms: 650, loop: false, tracks: { corps: { r: [0, 60, 85], sx: [1, 1.3, 1.5] }, bras: { x: Q([0, s * 1.5, s * 2]), sync: true } } },
    };
  }
  if (L.vue === "face") {
    return {
      idle: { ms: 1800, tracks: { bassin: { y: Q([0, h * 0.008]) }, bras: { r: [-2, -6], sync: true }, tete: { r: [-3, 3] }, queue0: { r: [50, 70] } } },
      marche: { ms: 700, tracks: { cuisse: { y: Q([0, -h * 0.03, 0, 0]), sy: [1, 0.93, 1, 1] }, bras: { r: [-12, -2, 6, -2] }, bassin: { y: Q([0, -h * 0.015, 0, -h * 0.015]), r: [-3, 0, 3, 0] }, tete: { r: [2, 0, -2, 0] } } },
      course: { ms: 420, tracks: { cuisse: { y: Q([0, -h * 0.06, 0, 0]), sy: [1, 0.85, 1, 1] }, bras: { r: [-30, -5, 20, -5] }, avantbras: { r: [-40, -40] }, bassin: { y: Q([0, -h * 0.03, 0, -h * 0.03]), r: [-5, 0, 5, 0] } } },
      controle: { ms: 520, tracks: { cuisseL: { y: Q([0, -h * 0.05, 0]) }, bras: { r: [-25, -20], sync: true }, tete: { r: [0, 8] } } },
      tir: { ms: 520, loop: false, then: "idle", tracks: { cuisseR: { y: Q([0, -h * 0.02, -h * 0.1, -h * 0.04, 0]), sy: [1, 1, 0.75, 0.9, 1] }, bras: { r: [-8, -40, -60, -30, -8], sync: true }, bassin: { r: [0, -6, 6, 3, 0] } } },
      passe: { ms: 420, loop: false, then: "idle", tracks: { cuisseR: { r: [0, 20, -10, 0] }, bassin: { r: [0, -4, 4, 0] } } },
      tacle: { ms: 700, loop: false, then: "idle", tracks: { bassin: { y: Q([0, h * 0.25, h * 0.28, h * 0.15, 0]) }, cuisseR: { r: [0, -70, -80, -50, 0] }, bras: { r: [-8, -70, -80, -50, -8], sync: true } } },
      chute: { ms: 800, loop: false, tracks: { bassin: { r: [0, 50, 88], y: Q([0, h * 0.12, h * 0.3]) }, bras: { r: [-8, -60, -100], sync: true } } },
      saut: { ms: 600, loop: false, then: "idle", tracks: { bassin: { y: Q([0, h * 0.05, -h * 0.3, -h * 0.15, 0]) }, cuisse: { sy: [1, 0.8, 0.85, 0.95, 1], sync: true }, bras: { r: [-8, -20, -150, -100, -8], sync: true } } },
      joie: { ms: 650, tracks: { bassin: { y: Q([0, -h * 0.12, 0]) }, bras: { r: [-150, -165, -150], sync: true }, tete: { r: [-5, 5, -5] } } },
      plongeon: { ms: 650, loop: false, tracks: { bassin: { r: [0, -60, -85], x: Q([0, -h * 0.25, -h * 0.45]), y: Q([0, -h * 0.05, h * 0.25]) }, bras: { r: [-8, -150, -170], sync: true } } },
    };
  }
  return {
    idle: { ms: 1800, tracks: { bassin: { y: Q([0, h * 0.008]) }, bras: { r: [2, -3] }, tete: { r: [-2, 2] }, queue0: { r: [105, 125] } } },
    marche: {
      ms: 760,
      tracks: {
        cuisse: { r: [-28, 0, 26, 0] },
        mollet: { r: [4, 32, 10, 0] },
        bras: { r: [24, 0, -24, 0] },
        avantbras: { r: [-12, -22, -12, -4] },
        bassin: { y: Q([0, -h * 0.02, 0, -h * 0.02]) },
        torse: { r: [-3, -3] },
        queue0: { r: [100, 125] },
      },
    },
    course: {
      ms: 440,
      tracks: {
        cuisse: { r: [-60, -10, 40, 0] },
        mollet: { r: [20, 90, 40, 10] },
        bras: { r: [55, 0, -50, 0] },
        avantbras: { r: [-80, -90, -80, -70] },
        bassin: { y: Q([-h * 0.02, -h * 0.05, -h * 0.02, -h * 0.05]) },
        torse: { r: [-12, -14, -12, -14] },
        queue0: { r: [95, 115] },
      },
    },
    controle: { ms: 520, tracks: { cuisse: { r: [-20, 0, 14, 0] }, mollet: { r: [10, 40, 15, 5] }, bras: { r: [10, 0, -10, 0] }, torse: { r: [-10, -10] }, tete: { r: [14, 14] } } },
    tir: { ms: 560, loop: false, then: "idle", tracks: { cuisseL: { r: [0, 45, 50, -80, -40, 0] }, molletL: { r: [0, 60, 85, 5, 10, 0] }, cuisseR: { r: [0, -8, -10, 5, 0, 0] }, bras: { r: [0, -30, -45, 30, 10, 0] }, torse: { r: [0, 8, 12, -14, -6, 0] }, bassin: { y: Q([0, h * 0.02, h * 0.03, -h * 0.01, 0, 0]) } } },
    passe: { ms: 440, loop: false, then: "idle", tracks: { cuisseL: { r: [0, 25, -40, 0] }, molletL: { r: [0, 30, 10, 0] }, torse: { r: [0, 5, -6, 0] } } },
    tacle: { ms: 760, loop: false, then: "idle", tracks: { bassin: { r: [0, 50, 62, 45, 0], y: Q([0, L.legL * 0.75, L.legL * 0.85, L.legL * 0.55, 0]) }, cuisseL: { r: [0, -75, -85, -70, 0] }, cuisseR: { r: [0, 20, 30, 25, 0] }, molletR: { r: [0, 70, 90, 70, 0] }, bras: { r: [0, -60, -70, -50, 0], sync: true }, torse: { r: [0, -25, -30, -20, 0] } } },
    chute: { ms: 900, loop: false, tracks: { bassin: { r: [0, 40, 82, 88], y: Q([0, L.legL * 0.35, L.legL * 0.78, L.legL * 0.8]) }, bras: { r: [0, -70, -95, -100], sync: true }, cuisse: { r: [0, -30, -20, -10], sync: true } } },
    saut: { ms: 650, loop: false, then: "idle", tracks: { bassin: { y: Q([0, h * 0.06, -h * 0.32, -h * 0.2, 0]) }, cuisse: { r: [0, -20, -50, -30, 0], sync: true }, mollet: { r: [0, 40, 80, 40, 0], sync: true }, bras: { r: [0, 20, -150, -110, 0], sync: true } } },
    joie: { ms: 700, tracks: { bassin: { y: Q([0, -h * 0.12, 0]) }, bras: { r: [-150, -165, -150], sync: true }, avantbras: { r: [-20, 0, -20], sync: true }, cuisse: { r: [0, -15, 0], sync: true }, mollet: { r: [0, 30, 0], sync: true }, tete: { r: [-10, -15, -10] } } },
    plongeon: { ms: 700, loop: false, tracks: { bassin: { r: [0, -50, -85, -88], x: Q([0, h * 0.2, h * 0.45, h * 0.5]), y: Q([0, -h * 0.1, L.legL * 0.55, L.legL * 0.75]) }, bras: { r: [0, -120, -170, -170], sync: true } } },
  };
}

function personnage(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const L = look(r, p);
  const peaux = (ESPECES[L.espece].peau as string[]) ?? ["#f2c29b"];
  const peau = isHex(p.peau) ? p.peau : r.pick(peaux);
  const parts = L.vue === "dessus" ? dessus(L) : L.vue === "face" ? face(L) : profil(L);
  return {
    parts,
    clips: persoClips(L),
    clip: "idle",
    height: L.h,
    roles: { peau, museau: "#f8fafc", interieur: "#fda4af", joue: "#f9a8d4", corne: "#f8fafc", crete: "#f97316", numero: "#f8fafc", chaussette: "#f8fafc", metal: "#94a3b8" },
  };
}

/* ------------------------------------------------------------------ animaux */

function animal(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const vue = oneOf(p.vue, ["profil", "dessus"], "profil");
  const h = numIn(p.taille, 16, 400, 40);
  const L = nb(p.longueur, 1.1, 1.9, r);
  const oreilles = str(p.oreilles, ["pointues", "rondes", "tombantes"], r);
  const queue = str(p.queue, ["courte", "longue", "touffue"], r);
  const peau = isHex(p.peau) ? p.peau : r.pick(["#a16207", "#78350f", "#f5f5f4", "#57534e", "#ea580c", "#1c1917"]);
  const bl = h * L * 0.5, br = h * 0.22, hr = h * 0.2, leg = h * 0.45, lr = h * 0.055;
  const parts: Part2In[] = [];
  let clips: Record<string, Clip2In>;
  if (vue === "dessus") {
    parts.push({ name: "corps", ellipse: Q([bl, br]), role: "peau", z: 2 });
    for (const [nm, x] of [["avant", bl * 0.6], ["arriere", -bl * 0.6]] as const) parts.push({ name: nm, parent: "corps", mirror: "y", at: Q([x, br * 0.85]), ellipse: Q([lr * 1.6, lr * 1.1]), role: "patte", z: 1 });
    parts.push({ name: "tete", parent: "corps", at: Q([bl * 0.95, 0]), circle: q(hr), role: "peau", z: 3 });
    parts.push({ name: "museau", parent: "tete", at: Q([hr * 0.75, 0]), ellipse: Q([hr * 0.5, hr * 0.4]), role: "museau", z: 3.1 });
    parts.push({ name: "nez", parent: "museau", at: Q([hr * 0.45, 0]), circle: q(hr * 0.15), role: "pupille", z: 3.2, line: 0 });
    parts.push({ name: "oreille", parent: "tete", mirror: "y", at: Q([-hr * 0.2, hr * 0.75]), [oreilles === "rondes" ? "circle" : "ellipse"]: oreilles === "rondes" ? q(hr * 0.3) : Q([hr * 0.3, hr * 0.45]), role: oreilles === "tombantes" ? "taches" : "peau", z: 3.05 } as Part2In);
    parts.push({ name: "queue", parent: "corps", at: Q([-bl * 0.95, 0]), rot: 90, capsule: Q([lr * (queue === "touffue" ? 2.2 : 1), queue === "courte" ? h * 0.1 : h * 0.35]), off: Q([0, (queue === "courte" ? h * 0.1 : h * 0.35) / 2]), role: queue === "touffue" ? "blanc" : "peau", z: 1.5 });
    clips = {
      idle: { ms: 2000, tracks: { queue: { r: [70, 110] }, tete: { r: [-8, 8] } } },
      marche: { ms: 800, tracks: { avant: { x: Q([-lr * 2, lr * 2]) }, arriere: { x: Q([lr * 2, -lr * 2]) }, queue: { r: [75, 105] }, corps: { r: [-3, 3] } } },
      course: { ms: 420, tracks: { avant: { x: Q([-lr * 3.5, lr * 3.5]), sync: true }, arriere: { x: Q([lr * 3.5, -lr * 3.5]), sync: true }, corps: { sx: [0.95, 1.08] }, queue: { r: [80, 100] } } },
      assis: { ms: 500, loop: false, tracks: { corps: { sx: [1, 0.75] }, arriere: { x: Q([0, bl * 0.25]), sync: true } } },
    };
  } else {
    parts.push({ name: "corps", at: [0, q(-leg - br * 0.6)], ellipse: Q([bl, br]), role: "peau", z: 2 });
    for (const [nm, x] of [["avant", bl * 0.62], ["arriere", -bl * 0.62]] as const) {
      parts.push({ name: nm, parent: "corps", mirror: "z", at: Q([x, br * 0.4]), capsule: Q([lr * 1.25, leg * 0.5 - lr]), off: Q([0, leg * 0.25]), role: "peau", z: 1.5 });
      parts.push({ name: `${nm}Bas`, parent: nm, at: Q([0, leg * 0.5]), capsule: Q([lr, leg * 0.48 - lr]), off: Q([0, leg * 0.25]), role: "patte", z: 1.6 });
    }
    parts.push({ name: "cou", parent: "corps", at: Q([bl * 0.75, -br * 0.4]), rot: 145, capsule: Q([hr * 0.5, hr * 0.8]), off: Q([0, hr * 0.5]), role: "peau", z: 2.5 });
    parts.push({ name: "tete", parent: "cou", at: Q([0, hr * 1.15]), rot: -145, circle: q(hr), role: "peau", z: 3 });
    parts.push({ name: "museau", parent: "tete", at: Q([hr * 0.8, hr * 0.15]), ellipse: Q([hr * 0.55, hr * 0.38]), role: "museau", z: 3.1 });
    parts.push({ name: "nez", parent: "museau", at: Q([hr * 0.5, -hr * 0.1]), ellipse: Q([hr * 0.15, hr * 0.11]), role: "pupille", z: 3.2, line: 0 });
    parts.push({ name: "oeil", parent: "tete", at: Q([hr * 0.35, -hr * 0.25]), ellipse: Q([hr * 0.14, hr * 0.17]), role: "pupille", z: 3.2, line: 0 });
    parts.push({ name: "reflet", parent: "oeil", at: Q([-hr * 0.04, -hr * 0.06]), circle: q(hr * 0.05), role: "blanc", glow: 1, z: 3.21 });
    if (oreilles === "tombantes") parts.push({ name: "oreille", parent: "tete", at: Q([-hr * 0.2, -hr * 0.55]), rot: 20, capsule: Q([hr * 0.25, hr * 0.6]), off: Q([0, hr * 0.35]), role: "taches", z: 3.15 });
    else parts.push({ name: "oreille", parent: "tete", mirror: "z", mirrorZ: -0.3, at: Q([-hr * 0.15, -hr * 0.75]), [oreilles === "rondes" ? "circle" : "poly"]: oreilles === "rondes" ? q(hr * 0.32) : QQ([[-hr * 0.28, 0], [hr * 0.22, 0], [-hr * 0.05, -hr * 0.65]]), role: "peau", z: 3.05 } as Part2In);
    const ql = queue === "courte" ? h * 0.12 : h * 0.4;
    parts.push({ name: "queue", parent: "corps", at: Q([-bl * 0.92, -br * 0.3]), rot: queue === "longue" ? 120 : 140, capsule: Q([lr * (queue === "touffue" ? 2.4 : 1), ql]), off: Q([0, ql / 2]), role: queue === "touffue" ? "blanc" : "peau", z: 1.8 });
    clips = {
      idle: { ms: 2000, tracks: { corps: { y: Q([0, h * 0.01]) }, cou: { r: [-4, 4] }, queue: { r: [-10, 10] } } },
      marche: { ms: 900, tracks: { avant: { r: [-25, 0, 25, 0] }, avantBas: { r: [0, 10, 35, 10] }, arriere: { r: [25, 0, -25, 0], phase: 0.5 }, arriereBas: { r: [35, 10, 0, 10], phase: 0.5 }, corps: { y: Q([0, -h * 0.02, 0, -h * 0.02]) }, queue: { r: [-12, 12] } } },
      course: { ms: 460, tracks: { avant: { r: [-55, 40], sync: true }, avantBas: { r: [10, 60], sync: true }, arriere: { r: [50, -45], sync: true, phase: 0.5 }, arriereBas: { r: [60, 5], sync: true, phase: 0.5 }, corps: { y: Q([0, -h * 0.1]), r: [-6, 6] }, queue: { r: [-15, 15] } } },
      assis: { ms: 500, loop: false, tracks: { corps: { r: [0, -30], y: Q([0, h * 0.18]) }, arriere: { r: [0, -60], sync: true }, arriereBas: { r: [0, 90], sync: true }, avant: { r: [0, 30], sync: true } } },
      saut: { ms: 700, loop: false, then: "idle", tracks: { corps: { y: Q([0, h * 0.04, -h * 0.5, -h * 0.2, 0]), r: [0, 8, -15, 10, 0] }, avant: { r: [0, 20, -70, 30, 0], sync: true }, arriere: { r: [0, -20, 60, 20, 0], sync: true } } },
    };
  }
  return { parts, clips, clip: "idle", height: h, roles: { peau, museau: "#f5f5f4", patte: peau, taches: "#44403c" } };
}

/* ------------------------------------------------------------------ décor */

function arbre(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const vue = oneOf(p.vue, ["profil", "dessus"], "profil");
  const h = numIn(p.taille, 20, 1200, 140);
  const forme = str(p.forme, ["rond", "sapin", "boules", "palmier"], r);
  const parts: Part2In[] = [];
  const leaf = r.pick(["#3f9d4a", "#65a30d", "#15803d", "#ca8a04", "#ea580c", "#16a34a"]);
  if (vue === "dessus") {
    if (forme === "sapin") parts.push({ name: "cime", star: [12, q(h * 0.3), q(h * 0.22)], role: "sapin", z: 1 }, { name: "cime2", star: [12, q(h * 0.2), q(h * 0.14)], rot: 15, role: "sapin2", z: 2 });
    else {
      const n = forme === "boules" ? r.int(3, 5) : 1;
      for (let i = 0; i < n; i++) {
        const s = forme === "boules" ? h * r.range(0.14, 0.2) : h * 0.3;
        const a = (i / n) * Math.PI * 2;
        parts.push({ name: `feuilles${i}`, at: forme === "boules" ? Q([Math.cos(a) * h * 0.12, Math.sin(a) * h * 0.12]) : [0, 0], blob: QQ(Array.from({ length: 8 }, (_, k) => { const b = (k / 8) * Math.PI * 2; const rr = s * r.range(0.85, 1.1); return [Math.cos(b) * rr, Math.sin(b) * rr]; })), role: "feuillage", z: 1 + i * 0.1 });
      }
    }
    return { parts, roles: { feuillage: leaf, sapin: "#166534", sapin2: "#15803d" } };
  }
  const tw = h * 0.07;
  parts.push({ name: "tronc", poly: QQ([[-tw, 0], [tw, 0], [tw * 0.6, -h * 0.55], [-tw * 0.6, -h * 0.55]]), role: "bois", z: 1 });
  if (forme === "sapin") {
    for (let i = 0; i < 4; i++) {
      const w = h * (0.36 - i * 0.07), y = -h * (0.18 + i * 0.18);
      parts.push({ name: `etage${i}`, parent: "tronc", at: [0, q(y)], poly: QQ([[-w, 0], [w, 0], [0, -h * 0.3]]), role: i % 2 ? "sapin2" : "sapin", z: 2 + i * 0.1 });
    }
  } else if (forme === "palmier") {
    parts[0].poly = QQ([[-tw, 0], [tw, 0], [tw * 0.3 + h * 0.08, -h * 0.75], [-tw * 0.3 + h * 0.08, -h * 0.75]]);
    for (let i = 0; i < 6; i++) parts.push({ name: `palme${i}`, parent: "tronc", at: Q([h * 0.08, -h * 0.75]), rot: -150 + i * 60 + r.range(-10, 10), blob: QQ([[0, 0], [h * 0.15, -h * 0.06], [h * 0.35, h * 0.02], [h * 0.15, h * 0.02]]), role: "feuillage", z: 2 });
  } else {
    const n = forme === "boules" ? r.int(3, 5) : 1;
    for (let i = 0; i < n; i++) {
      const s = forme === "boules" ? h * r.range(0.16, 0.24) : h * 0.34;
      const at = forme === "boules" ? [r.range(-0.18, 0.18) * h, -h * r.range(0.55, 0.8)] : [0, -h * 0.66];
      parts.push({ name: `feuilles${i}`, parent: "tronc", at: Q(at), blob: QQ(Array.from({ length: 9 }, (_, k) => { const b = (k / 9) * Math.PI * 2; const rr = s * r.range(0.85, 1.08); return [Math.cos(b) * rr, Math.sin(b) * rr * 0.9]; })), role: "feuillage", z: 2 + i * 0.1 });
    }
  }
  return { parts, roles: { feuillage: leaf, sapin: "#166534", sapin2: "#15803d" }, clips: { vent: { ms: 3000, tracks: { tronc: { r: [-1.5, 1.5] } } } }, clip: "vent" };
}

function buisson(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const s = numIn(p.taille, 10, 400, 40);
  const pts = Array.from({ length: 9 }, (_, k) => { const b = Math.PI + (k / 8) * Math.PI; const rr = s * r.range(0.8, 1.1); return [Math.cos(b) * rr * 1.2, Math.sin(b) * rr * 0.8]; });
  const parts: Part2In[] = [{ name: "buisson", blob: QQ([[s * 1.2, 0], ...pts.slice(1, -1), [-s * 1.2, 0]]), role: "feuillage", z: 1 }];
  if (flag(p.fleurs, 0.5, r)) for (let i = 0; i < 4; i++) parts.push({ name: `fleur${i}`, at: Q([r.range(-0.8, 0.8) * s, -r.range(0.2, 0.6) * s]), star: [5, q(s * 0.1), q(s * 0.05)], role: "fleur", z: 2 });
  return { parts, roles: { feuillage: r.pick(["#3f9d4a", "#65a30d", "#15803d"]), fleur: r.pick(["#f43f5e", "#facc15", "#f8fafc", "#a855f7"]) } };
}

function rocher(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const s = numIn(p.taille, 6, 600, 30);
  const n = r.int(6, 9);
  const pts = Array.from({ length: n }, (_, k) => { const b = Math.PI + (k / (n - 1)) * Math.PI; const rr = s * r.range(0.75, 1.1); return [Math.cos(b) * rr * 1.3, Math.min(0, Math.sin(b) * rr)]; });
  return { parts: [{ name: "bloc", poly: QQ(pts), role: "pierre", z: 1 }] };
}

function maison(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const vue = oneOf(p.vue, ["profil", "dessus"], "profil");
  const w = numIn(p.largeur, 40, 2000, 160);
  const fh = numIn(p.hauteur, 30, 2000, w * 0.7);
  const toit = str(p.toit, ["pente", "plat", "pointu"], r);
  const roles = { mur: r.pick(["#fef3c7", "#fde68a", "#e2e8f0", "#fecaca", "#bfdbfe", "#f5f5f4"]), toit: r.pick(["#b91c1c", "#9a3412", "#334155", "#1e3a8a", "#065f46"]), vitre: "#93c5fd", brique: "#9a3412" };
  if (vue === "dessus") {
    const d = w * 0.75;
    return { parts: [{ name: "toit", rect: Q([w, d, 4]), role: "toit", z: 1 }, { name: "faitage", rect: Q([w * 0.96, d * 0.06, 2]), role: "faitage", z: 2 }, { name: "pente", at: [0, q(d * 0.25)], rect: Q([w * 0.98, d * 0.48, 2]), role: "toitOmbre", z: 1.5 }], roles: { ...roles, faitage: "#0f172a", toitOmbre: "#7f1d1d" } };
  }
  const parts: Part2In[] = [{ name: "murs", at: [0, q(-fh / 2)], rect: Q([w, fh, 2]), role: "mur", z: 1 }];
  if (toit === "pente") parts.push({ name: "toit", parent: "murs", at: [0, q(-fh / 2)], poly: QQ([[-w * 0.6, 0], [w * 0.6, 0], [0, -w * 0.38]]), role: "toit", z: 2 });
  else if (toit === "pointu") parts.push({ name: "toit", parent: "murs", at: [0, q(-fh / 2)], poly: QQ([[-w * 0.56, 0], [w * 0.56, 0], [w * 0.3, -w * 0.5], [-w * 0.3, -w * 0.5]]), role: "toit", z: 2 });
  else parts.push({ name: "toit", parent: "murs", at: [0, q(-fh / 2)], rect: Q([w * 1.08, fh * 0.1, 2]), role: "toit", z: 2 });
  parts.push({ name: "porte", parent: "murs", at: [0, q(fh / 2 - fh * 0.22)], rect: Q([w * 0.16, fh * 0.44, 3]), role: "bois", z: 3 });
  parts.push({ name: "poignee", parent: "porte", at: Q([w * 0.05, 0]), circle: q(Math.max(1.2, w * 0.012)), role: "accent", z: 3.1, line: 0 });
  const nf = Math.max(1, Math.floor(w / 70));
  for (let i = 0; i < nf * 2; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / (nf * 2);
    if (Math.abs(x) < w * 0.14) continue;
    parts.push({ name: `fenetre${i}`, parent: "murs", at: Q([x, -fh * 0.08]), rect: Q([w * 0.14, w * 0.14, 2]), role: "vitre", z: 3, glow: 0.15 });
    parts.push({ name: `croisillon${i}`, parent: `fenetre${i}`, trait: { pts: QQ([[-w * 0.07, 0], [w * 0.07, 0]]) }, fill: false, line: q(Math.max(1, w * 0.012)), stroke: "#f8fafc", role: "mur", z: 3.1 });
  }
  if (flag(p.cheminee, 0.6, r)) parts.push({ name: "cheminee", parent: "murs", at: Q([w * 0.28, -fh / 2 - w * 0.22]), rect: Q([w * 0.1, w * 0.3, 1]), role: "brique", z: 1.5 });
  return { parts, roles };
}

function nuage(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const s = numIn(p.taille, 10, 2000, 70);
  const n = r.int(4, 7);
  const pts: number[][] = [[s, 0]];
  for (let k = 1; k < n; k++) {
    const b = (k / n) * Math.PI;
    pts.push([Math.cos(b) * s * r.range(0.85, 1.1), -Math.sin(b) * s * r.range(0.45, 0.75)]);
  }
  pts.push([-s, 0], [0, s * 0.12]);
  return { parts: [{ name: "nuage", blob: QQ(pts), role: "nuage", z: 1 }], roles: { nuage: "#f8fafc" }, clips: { derive: { ms: 9000, tracks: { nuage: { x: Q([0, s * 0.15]) } } } }, clip: "derive" };
}

function fleur(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const s = numIn(p.taille, 4, 200, 14);
  return {
    parts: [
      { name: "tige", trait: { pts: QQ([[0, 0], [s * 0.2, -s * 0.8], [0, -s * 1.6]]), smooth: true }, fill: false, line: q(Math.max(1, s * 0.12)), role: "tige", z: 1 },
      { name: "corolle", at: [0, q(-s * 1.6)], star: [r.int(5, 8), q(s * 0.5), q(s * 0.28)], role: "fleur", z: 2 },
      { name: "coeur", parent: "corolle", circle: q(s * 0.16), role: "accent", z: 2.1, line: 0 },
    ],
    roles: { tige: "#15803d", fleur: r.pick(["#f43f5e", "#f8fafc", "#a855f7", "#fb923c", "#38bdf8"]) },
    clips: { vent: { ms: 2600, tracks: { tige: { r: [-6, 6] } } } },
    clip: "vent",
  };
}

function herbe(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const s = numIn(p.taille, 4, 200, 12);
  const n = r.int(3, 6);
  const parts: Part2In[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * s * 0.3;
    parts.push({ name: `brin${i}`, at: [q(x), 0], rot: (i - (n - 1) / 2) * 12, poly: QQ([[-s * 0.08, 0], [s * 0.08, 0], [0, -s * r.range(0.8, 1.3)]]), role: "feuillage", z: 1 });
  }
  return { parts, roles: { feuillage: r.pick(["#4d7c0f", "#65a30d", "#3f6212"]) }, clips: { vent: { ms: 2200, tracks: { brin0: { r: [-8, 8] }, [`brin${n - 1}`]: { r: [6, -6] } } } }, clip: "vent" };
}

function ballon(_r: Rand, p: Record<string, unknown>): Preset2dOut {
  const s = typeof p.taille === "number" && p.taille > 0 ? Math.min(200, p.taille) : 8;
  const parts: Part2In[] = [{ name: "ballon", circle: q(s), role: "blanc", z: 1, relief: true }, { name: "penta", parent: "ballon", star: [5, q(s * 0.38), q(s * 0.3)], role: "noir", z: 1.1, line: 0 }];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
    parts.push({ name: `bord${i}`, parent: "ballon", at: Q([Math.cos(a) * s * 0.88, Math.sin(a) * s * 0.88]), rot: (i * 72), ellipse: Q([s * 0.2, s * 0.12]), role: "noir", z: 1.05, line: 0 });
  }
  return { parts, clips: { roule: { ms: 500, tracks: { ballon: { r: [0, 120, 240] } } } } };
}

function but(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const vue = oneOf(p.vue, ["dessus", "profil"], "dessus");
  const w = numIn(p.largeur, 20, 2000, 160);
  const d = numIn(p.profondeur, 6, 400, 36);
  const t = Math.max(2, w * 0.03);
  if (vue === "profil") {
    const h = w * 0.33;
    return {
      parts: [
        { name: "filet", poly: QQ([[0, 0], [0, -h], [-d, -h * 0.8], [-d, 0]]), role: "filet", tex: { kind: "damier", scale: 12, contrast: 0.5 }, opacity: 0.6, z: 1 },
        { name: "poteau", at: [0, 0], rect: Q([t, h * 2, 1]), off: [0, q(-h / 2)], role: "blanc", z: 2 },
      ],
      roles: { filet: "#e2e8f0" },
    };
  }
  const parts: Part2In[] = [{ name: "filet", at: Q([-d / 2, 0]), rect: Q([d, w, 2]), role: "filet", tex: { kind: "damier", scale: 14, contrast: 0.45 }, opacity: 0.7, z: 1 }];
  parts.push({ name: "poteau", mirror: "y", at: Q([0, w / 2]), circle: q(t), role: "blanc", z: 3 });
  parts.push({ name: "barre", rect: Q([t * 1.2, w, t * 0.6]), role: "blanc", z: 2.5 });
  void r;
  return { parts, roles: { filet: "#e2e8f0" } };
}

function terrainFoot(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const w = numIn(p.largeur, 100, 8000, 1050);
  const h = numIn(p.hauteur, 60, 8000, 680);
  const lw = Math.max(2, w * 0.004);
  const stripes = Math.round(numIn(p.bandes, 0, 30, 10));
  const parts: Part2In[] = [{ name: "pelouse", rect: Q([w + lw * 8, h + lw * 8, 4]), role: "pelouse", tex: { kind: "herbe", scale: 3, contrast: 0.35 }, z: 0, relief: false, line: 0 }];
  for (let i = 0; i < stripes; i += 2) parts.push({ name: `bande${i}`, at: Q([-w / 2 + ((i + 0.5) * w) / stripes, 0]), rect: Q([w / stripes, h, 0]), role: "bande", opacity: 0.18, z: 0.1, relief: false, line: 0 });
  const L = (name: string, pts: number[][], closed = false) => parts.push({ name, [closed ? "poly" : "trait"]: closed ? QQ(pts) : { pts: QQ(pts) }, fill: false, line: q(lw), stroke: "#f8fafc", role: "ligne", z: 1, relief: false } as Part2In);
  L("bordure", [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], true);
  L("mediane", [[0, -h / 2], [0, h / 2]]);
  parts.push({ name: "rond", arc: Q([h * 0.14, 0, 360, lw]), role: "ligne", z: 1, relief: false, line: 0 });
  parts.push({ name: "point", circle: q(lw * 1.5), role: "ligne", z: 1, line: 0 });
  for (const s of [-1, 1]) {
    const x0 = (s * w) / 2, sx = -s;
    L(`surface${s > 0 ? "D" : "G"}`, [[x0, -h * 0.3], [x0 + sx * w * 0.16, -h * 0.3], [x0 + sx * w * 0.16, h * 0.3], [x0, h * 0.3]]);
    L(`but${s > 0 ? "D" : "G"}zone`, [[x0, -h * 0.13], [x0 + sx * w * 0.055, -h * 0.13], [x0 + sx * w * 0.055, h * 0.13], [x0, h * 0.13]]);
  }
  void r;
  return { parts, roles: { pelouse: "#3f8f3a", bande: "#ffffff", ligne: "#f8fafc" } };
}

function sol(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const w = numIn(p.largeur, 100, 20000, 1200);
  const d = numIn(p.epaisseur, 10, 4000, 140);
  const relief = numIn(p.relief, 0, 400, 18);
  const n = Math.max(6, Math.min(120, Math.round(w / 40)));
  const top: number[][] = [];
  let y = 0;
  for (let i = 0; i <= n; i++) {
    y = Math.max(-relief, Math.min(relief, y + r.range(-relief, relief) * 0.5));
    top.push([-w / 2 + (i * w) / n, y]);
  }
  const terre = [...top, [w / 2, d], [-w / 2, d]];
  const herbe = [...top, ...top.slice().reverse().map(([x, yy]) => [x, yy + d * 0.12])];
  return {
    parts: [
      { name: "terre", poly: QQ(terre), role: "terre", tex: { kind: "pierre", scale: 2.5, contrast: 0.25 }, z: 0, relief: false },
      { name: "herbe", poly: QQ(herbe), role: "sol", tex: { kind: "herbe", scale: 4, contrast: 0.3 }, z: 1, relief: false },
    ],
  };
}

function collines(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const w = numIn(p.largeur, 100, 20000, 1600);
  const hh = numIn(p.hauteur, 10, 4000, 160);
  const n = r.int(4, 8);
  const pts: number[][] = [[w / 2, hh * 2], [w / 2, 0]];
  for (let i = n; i >= 0; i--) pts.push([-w / 2 + (i * w) / n, -hh * r.range(0.3, 1)]);
  pts.push([-w / 2, 0], [-w / 2, hh * 2]);
  return { parts: [{ name: "colline", blob: QQ(pts), role: "colline", z: 0, relief: false, line: 0 }], roles: { colline: r.pick(["#86b37a", "#6ea36a", "#a3c49a", "#7aa8c7"]) } };
}

function foule(r: Rand, p: Record<string, unknown>): Preset2dOut {
  const w = numIn(p.largeur, 40, 6000, 600);
  const rangs = Math.round(numIn(p.rangs, 1, 12, 3));
  const s = numIn(p.taille, 3, 60, 9);
  const parts: Part2In[] = [{ name: "gradin", rect: Q([w, rangs * s * 2.4, 2]), off: [0, q(-(rangs * s * 2.4) / 2)], role: "gradin", z: 0, relief: false }];
  const colors = ["#ef4444", "#facc15", "#22d3ee", "#f8fafc", "#a855f7", "#f97316", "#3b82f6", "#22c55e"];
  const roles: Record<string, string> = { gradin: "#334155" };
  const per = Math.min(80, Math.floor(w / (s * 2.4)));
  let k = 0;
  for (let j = 0; j < rangs && k < 110; j++)
    for (let i = 0; i < per && k < 110; i += Math.max(1, Math.round(per / 36))) {
      const role = `fan${k % colors.length}`;
      roles[role] = colors[k % colors.length];
      parts.push({ name: `fan${k}`, at: Q([-w / 2 + (i + 0.5) * s * 2.4 + r.range(-2, 2), -(j + 0.5) * s * 2.4]), circle: q(s * r.range(0.8, 1)), role, z: 1 + j * 0.01, line: 0, relief: false });
      k++;
    }
  return { parts, roles, clips: { ola: { ms: 1600, tracks: Object.fromEntries(Array.from({ length: Math.min(k, 40) }, (_, i) => [`fan${i}`, { y: [0, -s * 0.8, 0, 0], phase: i / 40 }])) } }, clip: "ola" };
}

export const PRESETS2D: Record<string, Preset2d> = {
  personnage: {
    doc: "Personnage ou créature articulé, vue profil (regard +x), face ou dessus (regard +x) ; clips idle marche course controle tir passe tacle chute saut joie plongeon",
    params: { vue: "profil|face|dessus", espece: Object.keys(ESPECES).join("|"), taille: "hauteur en px (défaut 64)", corpulence: "0.75..1.35", grosseTete: "0.26..0.42", tete: "ronde|ovale|carree|large", oreilles: "aucune|rondes|pointues|longues|humaines|antennes", queue: "aucune|courte|longue|touffue", cornes: "aucune|petites|grandes", cheveux: "aucun|court|epis|crete|bol", yeux: "ronds|grands|amande|globes|visiere", museau: "0..1", numero: "texte court (dos / poitrine)", peau: "#rrggbb" },
    build: personnage,
  },
  animal: { doc: "Animal à quatre pattes, vue profil ou dessus ; clips idle marche course assis (saut en profil)", params: { vue: "profil|dessus", taille: "px", longueur: "1.1..1.9", oreilles: "pointues|rondes|tombantes", queue: "courte|longue|touffue", peau: "#rrggbb" }, build: animal },
  arbre: { doc: "Arbre (profil ou dessus) ; clip vent en profil", params: { vue: "profil|dessus", taille: "px", forme: "rond|sapin|boules|palmier" }, build: arbre },
  buisson: { doc: "Buisson (profil), fleurs possibles", params: { taille: "px", fleurs: "booléen" }, build: buisson },
  rocher: { doc: "Rocher (profil)", params: { taille: "px" }, build: rocher },
  maison: { doc: "Maison (façade de profil, toit vu de dessus)", params: { vue: "profil|dessus", largeur: "px", hauteur: "px", toit: "pente|plat|pointu", cheminee: "booléen" }, build: maison },
  nuage: { doc: "Nuage ; clip derive", params: { taille: "px" }, build: nuage },
  fleur: { doc: "Fleur ; clip vent", params: { taille: "px" }, build: fleur },
  herbe: { doc: "Touffe d'herbe ; clip vent", params: { taille: "px" }, build: herbe },
  ballon: { doc: "Ballon de foot ; clip roule", params: { taille: "rayon px (défaut 8)" }, build: ballon },
  but: { doc: "But de foot (dessus : ouverture vers +x ; profil)", params: { vue: "dessus|profil", largeur: "px", profondeur: "px" }, build: but },
  terrain: { doc: "Terrain de foot vu de dessus (pelouse à bandes, lignes, surfaces)", params: { largeur: "px", hauteur: "px", bandes: "nombre" }, build: terrainFoot },
  sol: { doc: "Sol de profil (herbe sur terre, relief)", params: { largeur: "px", epaisseur: "px", relief: "px" }, build: sol },
  collines: { doc: "Collines d'arrière-plan (profil)", params: { largeur: "px", hauteur: "px" }, build: collines },
  foule: { doc: "Gradin et supporters ; clip ola", params: { largeur: "px", rangs: "1..12", taille: "px" }, build: foule },
};
