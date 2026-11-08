/**
 * Ballons, balles, boules et billes (`ball`, raccourci `ball.<kind>`) : tailles réelles, motifs de panneaux et de
 * coutures fidèles (football en icosaèdre tronqué, couture de tennis, fuseaux de ballon de plage…), ballons ovales,
 * écrasement au sol, couleurs par rôle. Chaque ballon publie ses **affordances** et ses **propriétés physiques**
 * (`extra.affords`, `extra.physics`) : un jeu ou `sonic-physics` sait qu'il roule, rebondit, se lance.
 */
import { type Q, type V3, DEG, clamp, m4Compose, norm, qAxis, qConj, qEuler, qMul, qRot } from "../core/math";
import { Mesh } from "../geom/mesh";
import { icosphere, tube } from "../geom/prims";
import { splitByLabel } from "../geom/rolecut";
import { ROLE, type Role } from "../style/roles";
import { roleParam } from "./parts";
import { type Pattern, type Seam, circle, icosahedron, labelAt, slerp, tennisSeam } from "./sphere-pattern";
import { defineGenerator } from "./types";

/** Emplacement de couleur : 0, 1, 2 (couleurs réglables du ballon) ou un rôle fixe. */
export type Slot = number | Role;

type Kind = {
  label: string;
  /** Diamètre réel (m) ; ovales : longueur. */
  d: number;
  /** Proportions de l'ellipsoïde en espace motif (axe long selon y). */
  S: V3;
  mass: number;
  /** Coefficient de restitution (rebond). */
  e: number;
  friction: number;
  colors: [Role, Role, Role];
  affords: string[];
  pattern: (n: number) => Pattern;
  /** Ovale couché sur le flanc. */
  lying?: boolean;
};

/* ---------- motifs ---------- */

const ICO = icosahedron();
const mid = (a: V3, b: V3, t: number): V3 => norm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
const arc = (a: V3, b: V3, n = 6): V3[] => Array.from({ length: n + 1 }, (_, i) => slerp(a, b, i / n));

/** Icosaèdre tronqué (football, handball) : 12 pentagones, 20 hexagones, coutures fines en vectoriel. */
function truncatedIco(penta: Slot, seamSlot: Slot): Pattern {
  const { v, nb } = ICO;
  const regions = v.map((a, i) => ({ r: { k: "poly" as const, pts: nb[i].map((j) => mid(a, v[j], 1 / 3)) }, slot: penta }));
  const seams: Seam[] = [];
  for (const r of regions) seams.push({ pts: r.r.pts.flatMap((p, k) => arc(p, r.r.pts[(k + 1) % r.r.pts.length], 5).slice(0, -1)), closed: true, slot: seamSlot, w: 0.008, vectorOnly: true, alpha: 0.8 });
  for (let i = 0; i < v.length; i++) for (const j of nb[i]) if (j > i) seams.push({ pts: arc(mid(v[i], v[j], 1 / 3), mid(v[i], v[j], 2 / 3), 5), closed: false, slot: seamSlot, w: 0.008, vectorOnly: true, alpha: 0.8 });
  return { base: 0, regions, seams };
}

const ring = (n: V3, d: number, slot: Slot, w: number, extra: Partial<Seam> = {}): Seam => ({ pts: circle(n, d, 40), closed: true, slot, w, ...extra });

const meridians = (count: number, slot: Slot, w: number, extra: Partial<Seam> = {}): Seam[] =>
  Array.from({ length: count / 2 }, (_, i) => ring([Math.cos((i / count) * Math.PI * 2), 0, -Math.sin((i / count) * Math.PI * 2)], 0, slot, w, extra));

const lunes = (slots: Slot[]): Pattern["regions"] => slots.map((slot, i) => ({ r: { k: "lune" as const, a0: (i / slots.length) * Math.PI * 2, a1: ((i + 1) / slots.length) * Math.PI * 2 - 1e-4 }, slot }));

/** Points répartis sur la sphère (spirale de Fibonacci). */
const fibo = (n: number): V3[] => Array.from({ length: n }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * 2.399963;
  return [Math.cos(a) * r, y, Math.sin(a) * r] as V3;
});

const BILLIARD: Role[] = ["yellow", "blue", "red", "purple", "orange", "green", "leather", "black"];

export const BALLS: Record<string, Kind> = {
  soccer: { label: "Ballon de football", d: 0.22, S: [1, 1, 1], mass: 0.43, e: 0.8, friction: 0.5, colors: ["white", "black", "red"], affords: ["kick", "roll", "bounce", "throw", "catch", "hold"], pattern: () => truncatedIco(1, 1) },
  basketball: { label: "Ballon de basket", d: 0.24, S: [1, 1, 1], mass: 0.62, e: 0.83, friction: 0.6, colors: ["orange", "black", "black"], affords: ["bounce", "throw", "catch", "hold", "roll"], pattern: () => ({ base: 0, regions: [], seams: [ring([0, 1, 0], 0, 1, 0.014), ring([1, 0, 0], 0, 1, 0.014), ring([0, 0, 1], 0.64, 1, 0.014), ring([0, 0, 1], -0.64, 1, 0.014)] }) },
  volleyball: {
    label: "Ballon de volley", d: 0.21, S: [1, 1, 1], mass: 0.27, e: 0.75, friction: 0.5, colors: ["yellow", "blue", "white"], affords: ["throw", "catch", "bounce", "hold", "roll"],
    pattern: () => {
      const regions: Pattern["regions"] = [];
      const seams: Seam[] = [];
      for (let a = 0; a < 3; a++)
        for (const s of [1, -1]) {
          const b = s > 0 ? (a + 1) % 3 : (a + 2) % 3, c = 3 - a - b;
          for (let i = 0; i < 3; i++) {
            const w0 = -1 + (2 * i) / 3, w1 = -1 + (2 * (i + 1)) / 3;
            const P = (u: number, w: number): V3 => { const q: V3 = [0, 0, 0]; q[a] = s; q[c] = u; q[b] = w; return norm(q); };
            const pts = [P(-1, w0), P(1, w0), P(1, w1), P(-1, w1)];
            regions.push({ r: { k: "poly", pts }, slot: (i + a + (s > 0 ? 0 : 1)) % 3 });
            seams.push({ pts: pts.flatMap((p, k) => arc(p, pts[(k + 1) % 4], 6).slice(0, -1)), closed: true, slot: "ink", w: 0.006, vectorOnly: true, alpha: 0.5 });
          }
        }
      return { base: 2, regions, seams };
    },
  },
  handball: { label: "Ballon de handball", d: 0.19, S: [1, 1, 1], mass: 0.45, e: 0.7, friction: 0.7, colors: ["white", "blue", "ink"], affords: ["throw", "catch", "bounce", "hold", "roll"], pattern: () => truncatedIco(1, 2) },
  waterpolo: { label: "Ballon de water-polo", d: 0.22, S: [1, 1, 1], mass: 0.42, e: 0.75, friction: 0.8, colors: ["yellow", "blue", "ink"], affords: ["throw", "catch", "hold", "float"], pattern: () => ({ base: 0, regions: lunes([0, 1, 0, 1, 0, 1, 0, 1]), seams: meridians(8, 2, 0.006, { vectorOnly: true, alpha: 0.5 }) }) },
  rugby: { label: "Ballon de rugby", d: 0.3, S: [0.63, 1, 0.63], mass: 0.44, e: 0.6, friction: 0.7, colors: ["white", "red", "blue"], affords: ["throw", "catch", "kick", "carry", "hold"], lying: true, pattern: () => ({ base: 0, regions: [{ r: { k: "band", n: [0, 1, 0], lo: 0.5, hi: 0.66 }, slot: 1 }, { r: { k: "band", n: [0, 1, 0], lo: -0.66, hi: -0.5 }, slot: 1 }, { r: { k: "band", n: [0, 0, 1], lo: -0.18, hi: 0.18 }, slot: 2 }], seams: meridians(4, "ink", 0.01) }) },
  americanfootball: {
    label: "Ballon de football américain", d: 0.28, S: [0.6, 1, 0.6], mass: 0.42, e: 0.6, friction: 0.7, colors: ["leather", "white", "black"], affords: ["throw", "catch", "kick", "carry", "hold"], lying: true,
    pattern: () => {
      const laces: Seam[] = [{ pts: arc(norm([0, 0.32, 1]), norm([0, -0.32, 1]), 8), closed: false, slot: 1, w: 0.03 }];
      for (let i = 0; i < 7; i++) {
        const y = -0.24 + i * 0.08;
        laces.push({ pts: arc(norm([-0.13, y, 1]), norm([0.13, y, 1]), 3), closed: false, slot: 1, w: 0.02 });
      }
      return { base: 0, regions: [{ r: { k: "band", n: [0, 1, 0], lo: 0.6, hi: 0.69 }, slot: 1 }, { r: { k: "band", n: [0, 1, 0], lo: -0.69, hi: -0.6 }, slot: 1 }], seams: [...meridians(4, 2, 0.008), ...laces] };
    },
  },
  tennis: { label: "Balle de tennis", d: 0.067, S: [1, 1, 1], mass: 0.058, e: 0.75, friction: 0.6, colors: ["yellow", "white", "green"], affords: ["throw", "catch", "bounce", "hold", "hit"], pattern: () => ({ base: 0, regions: [], seams: [{ pts: tennisSeam(0.36), closed: true, slot: 1, w: 0.05 }] }) },
  baseball: { label: "Balle de baseball", d: 0.074, S: [1, 1, 1], mass: 0.145, e: 0.55, friction: 0.6, colors: ["white", "red", "ink"], affords: ["throw", "catch", "hold", "hit"], pattern: () => ({ base: 0, regions: [], seams: [{ pts: tennisSeam(0.36), closed: true, slot: 1, w: 0.022 }] }) },
  cricket: { label: "Balle de cricket", d: 0.072, S: [1, 1, 1], mass: 0.16, e: 0.5, friction: 0.6, colors: ["red", "paper", "ink"], affords: ["throw", "catch", "hold", "hit"], pattern: () => ({ base: 0, regions: [{ r: { k: "band", n: [0, 1, 0], lo: -0.06, hi: 0.06 }, slot: 1 }], seams: [ring([0, 1, 0], 0.11, 1, 0.01, { vectorOnly: true }), ring([0, 1, 0], -0.11, 1, 0.01, { vectorOnly: true })] }) },
  golf: { label: "Balle de golf", d: 0.043, S: [1, 1, 1], mass: 0.046, e: 0.83, friction: 0.4, colors: ["white", "white", "ink"], affords: ["hit", "roll", "hold"], pattern: () => ({ base: 0, regions: [], seams: fibo(60).map((c) => ({ pts: circle(c, Math.cos(0.13), 10), closed: true, slot: 0, w: 0.004, vectorOnly: true, tone: -1, alpha: 0.55 })) }) },
  pingpong: { label: "Balle de ping-pong", d: 0.04, S: [1, 1, 1], mass: 0.0027, e: 0.89, friction: 0.3, colors: ["white", "orange", "ink"], affords: ["hit", "bounce", "hold"], pattern: () => ({ base: 0, regions: [], seams: [ring([0, 1, 0], 0, 0, 0.004, { vectorOnly: true, tone: -1, alpha: 0.4 })] }) },
  petanque: { label: "Boule de pétanque", d: 0.075, S: [1, 1, 1], mass: 0.7, e: 0.2, friction: 0.5, colors: ["metal", "metal", "ink"], affords: ["throw", "roll", "hold"], pattern: () => ({ base: 0, regions: [], seams: [ring([0, 1, 0], 0, 1, 0.012, { tone: -1 }), ring([0, 1, 0], 0.3, 1, 0.01, { tone: -1 }), ring([0, 1, 0], -0.3, 1, 0.01, { tone: -1 })] }) },
  cochonnet: { label: "Cochonnet", d: 0.03, S: [1, 1, 1], mass: 0.015, e: 0.3, friction: 0.5, colors: ["wood", "red", "ink"], affords: ["throw", "roll", "hold"], pattern: () => ({ base: 0, regions: [], seams: [] }) },
  billiard: {
    label: "Boule de billard", d: 0.057, S: [1, 1, 1], mass: 0.17, e: 0.9, friction: 0.2, colors: ["white", "yellow", "white"], affords: ["roll", "hit", "hold"],
    pattern: (n) => {
      if (n <= 0) return { base: 2, regions: [], seams: [] };
      const spot = { r: { k: "cap" as const, c: [0, 0, 1] as V3, cos: Math.cos(0.42) }, slot: 2 };
      if (n <= 8) return { base: 1, regions: [spot], seams: [] };
      return { base: 2, regions: [spot, { r: { k: "band", n: [0, 1, 0], lo: -0.5, hi: 0.5 }, slot: 1 }], seams: [] };
    },
  },
  bowling: { label: "Boule de bowling", d: 0.218, S: [1, 1, 1], mass: 6.5, e: 0.2, friction: 0.3, colors: ["blue", "black", "purple"], affords: ["roll", "hold"], pattern: () => ({ base: 0, regions: [norm([0, 0.95, 0.32]), norm([-0.16, 0.9, 0.05]), norm([0.16, 0.9, 0.05])].map((c) => ({ r: { k: "cap" as const, c, cos: Math.cos(0.14) }, slot: 1 })), seams: [] }) },
  beach: { label: "Ballon de plage", d: 0.5, S: [1, 1, 1], mass: 0.1, e: 0.6, friction: 0.5, colors: ["red", "blue", "yellow"], affords: ["throw", "catch", "bounce", "kick", "float", "hold"], pattern: () => ({ base: "white", regions: [{ r: { k: "cap", c: [0, 1, 0], cos: Math.cos(0.24) }, slot: "white" }, { r: { k: "cap", c: [0, -1, 0], cos: Math.cos(0.24) }, slot: "white" }, ...lunes([0, "white", 1, "white", 2, "white"])], seams: [] }) },
  gym: { label: "Ballon de gym", d: 0.65, S: [1, 1, 1], mass: 1.2, e: 0.7, friction: 0.7, colors: ["blue", "white", "ink"], affords: ["sit", "roll", "bounce", "push"], pattern: () => ({ base: 0, regions: [], seams: [ring([0, 1, 0], 0, 0, 0.004, { vectorOnly: true, tone: -1, alpha: 0.4 })] }) },
  medicine: { label: "Médecine-ball", d: 0.3, S: [1, 1, 1], mass: 3, e: 0.1, friction: 0.8, colors: ["leather", "black", "red"], affords: ["throw", "catch", "hold", "carry"], pattern: () => ({ base: 0, regions: [], seams: meridians(4, 1, 0.014) }) },
  bouncy: { label: "Balle rebondissante", d: 0.045, S: [1, 1, 1], mass: 0.02, e: 0.92, friction: 0.7, colors: ["red", "yellow", "blue"], affords: ["bounce", "throw", "catch", "hold"], pattern: () => ({ base: 0, regions: [{ r: { k: "band", n: norm([0.4, 0.8, 0.45]), lo: -0.22, hi: 0.22 }, slot: 1 }, { r: { k: "band", n: norm([-0.6, 0.2, 0.77]), lo: -0.18, hi: 0.18 }, slot: 2 }], seams: [] }) },
  marble: { label: "Bille", d: 0.016, S: [1, 1, 1], mass: 0.005, e: 0.7, friction: 0.2, colors: ["blue", "white", "yellow"], affords: ["roll", "hold"], pattern: () => ({ base: 0, regions: [{ r: { k: "band", n: norm([0.3, 0.9, 0.3]), lo: -0.16, hi: 0.16 }, slot: 1 }], seams: [] }) },
  playground: { label: "Ballon en plastique", d: 0.2, S: [1, 1, 1], mass: 0.15, e: 0.7, friction: 0.6, colors: ["red", "yellow", "ink"], affords: ["kick", "throw", "catch", "bounce", "roll", "hold"], pattern: () => ({ base: 0, regions: [{ r: { k: "cap", c: [0, 1, 0], cos: Math.cos(0.3) }, slot: 1 }], seams: [ring([0, 1, 0], 0, 0, 0.004, { vectorOnly: true, tone: -1, alpha: 0.5 })] }) },
};

export const BALL_KINDS = Object.keys(BALLS);

/* ---------- géométrie commune 3D / vectoriel ---------- */

export type BallSpec = {
  kind: string;
  pattern: Pattern;
  /** Rayon (m) : demi-longueur pour les ovales. */
  R: number;
  S: V3;
  q: Q;
  /** Écrasement vertical (monde) : [sx, sy, sz]. */
  W: V3;
  /** Hauteur du centre au-dessus du sol. */
  cy: number;
  /** Demi-emprise au sol. */
  hx: number;
  hz: number;
  height: number;
  role: (slot: number | string) => Role;
  def: Kind;
};

/** Paramètres résolus → géométrie du ballon (partagée par le maillage et le dessin vectoriel). */
export function ballSpec(p: Record<string, unknown>): BallSpec {
  const kind = String(p.kind ?? "soccer");
  const def = BALLS[kind] ?? BALLS.soccer;
  const dia = Number(p.diameter ?? 0) > 0 ? Number(p.diameter) : def.d;
  const R = dia / 2;
  const sq = clamp(Number(p.squash ?? 0), 0, 0.5);
  const W: V3 = [1 + sq * 0.5, 1 - sq, 1 + sq * 0.5];
  // orientation : motif tourné pour être lisible de face ; ovale couché sur le flanc, axe long selon x
  const turn = Number(p.turn ?? 0) * DEG;
  const q: Q = def.lying ? qMul(qAxis([0, 1, 0], turn), qMul(qAxis([0, 0, 1], Math.PI / 2), qAxis([0, 1, 0], 0.5))) : qMul(qAxis([0, 1, 0], turn), qEuler(-24 * DEG, 18 * DEG, 8 * DEG));
  const S = def.S;
  // lignes de M = W·Rq·S : demi-étendues de l'ellipsoïde selon x, y, z monde
  const ex = qRot(q, [1, 0, 0]), ey = qRot(q, [0, 1, 0]), ez = qRot(q, [0, 0, 1]);
  const row = (i: number) => W[i] * Math.hypot(ex[i] * S[0], ey[i] * S[1], ez[i] * S[2]);
  const n = Number(p.number ?? 0) | 0;
  const pattern = def.pattern(kind === "billiard" ? clamp(n, 0, 15) : n);
  const colors: [Role, Role, Role] = [roleParam(p.color, def.colors[0]), roleParam(p.color2, def.colors[1]), roleParam(p.color3, def.colors[2])];
  if (kind === "billiard" && n > 0 && !(typeof p.color2 === "string" && p.color2 in ROLE)) colors[1] = BILLIARD[(n - 1) % 8];
  const role = (slot: number | string): Role => (typeof slot === "number" ? colors[clamp(slot, 0, 2)] : roleParam(slot, "ink"));
  return { kind, pattern, R, S, q, W, cy: R * row(1), hx: R * row(0), hz: R * row(2), height: 2 * R * row(1), role, def };
}

/** Maillage 3D : icosphère découpée aux frontières des régions, coutures en tubes en relief. */
export function ballMesh(spec: BallSpec): Mesh {
  const { pattern, R } = spec;
  const sub = R < 0.02 ? 2 : 3;
  const m = icosphere(sub, 0);
  const label = Array.from({ length: m.vertexCount }, (_, i) => labelAt(pattern, m.getPos(i)));
  const slotOf = (l: number): number | string => (l === 0 ? pattern.base : pattern.regions[l - 1].slot);
  splitByLabel(m, {
    label,
    roleOf: (l) => ROLE[spec.role(slotOf(l))],
    edgeT: (a, b) => {
      const pa = m.getPos(a), pb = m.getPos(b), la = labelAt(pattern, pa);
      let lo = 0, hi = 1;
      for (let it = 0; it < 7; it++) {
        const t = (lo + hi) / 2;
        if (labelAt(pattern, norm([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t])) === la) lo = t;
        else hi = t;
      }
      return clamp((lo + hi) / 2, 0.02, 0.98);
    },
    place: (p) => {
      const n = norm(p);
      return { p: n, n };
    },
  });
  for (const s of pattern.seams) {
    if (s.vectorOnly) continue;
    const lift = 1 + s.w * 0.3;
    const pts = s.pts.map((p) => [p[0] * lift, p[1] * lift, p[2] * lift] as V3);
    if (s.closed) pts.push(pts[0]);
    m.append(tube(pts, pts.map(() => s.w), ROLE[spec.role(s.slot)], 4, true, true));
  }
  m.transform(m4Compose([0, 0, 0], [0, 0, 0, 1], spec.S));
  m.transform(m4Compose([0, 0, 0], spec.q));
  m.transform(m4Compose([0, spec.cy, 0], [0, 0, 0, 1], [spec.W[0] * R, spec.W[1] * R, spec.W[2] * R]));
  return m;
}

/**
 * Directions monde → espace motif : un point `p` du motif est visible (ou éclairé) si `p·v ≥ 0` avec
 * `v = S⁻¹·Rq⁻¹·W⁻¹·d` (l'ellipsoïde est une image affine de la sphère : l'hémisphère visible reste un demi-espace).
 */
export function toPatternDir(spec: BallSpec, dLocal: V3): V3 {
  const w: V3 = [dLocal[0] / spec.W[0], dLocal[1] / spec.W[1], dLocal[2] / spec.W[2]];
  const r = qRot(qConj(spec.q), w);
  return norm([r[0] / spec.S[0], r[1] / spec.S[1], r[2] / spec.S[2]]);
}

/** Point du motif → repère local de l'objet (mètres). */
export function patternToLocal(spec: BallSpec, p: V3): V3 {
  const r = qRot(spec.q, [p[0] * spec.S[0], p[1] * spec.S[1], p[2] * spec.S[2]]);
  return [r[0] * spec.W[0] * spec.R, spec.cy + r[1] * spec.W[1] * spec.R, r[2] * spec.W[2] * spec.R];
}

export const ball = defineGenerator({
  id: "ball",
  label: "Ballon, balle, boule, bille",
  doc:
    "Ballons et balles à taille réelle (football 22 cm, basket 24 cm, tennis 6,7 cm, ballon de gym 65 cm…) avec leurs vrais motifs : panneaux, fuseaux, coutures en relief. Ovales (rugby, football américain) couchés sur le flanc. `diameter` change la taille (ballon géant, bille), `squash` l'écrase au sol (dégonflé), `color`/`color2`/`color3` prennent un rôle (red, orange, yellow, green, blue, purple, white, black, accent, cloth1…). Billard : `number` 0 (blanche) à 15. Publie `extra.affords` (kick, roll, bounce, throw, catch, hold…) et `extra.physics` {radius, mass, restitution, friction} ; ancres center, top, grip.",
  tags: ["ballon", "balle", "boule", "sport", "jeu", "jouet", "objet du quotidien"],
  schema: {
    kind: { type: "enum", default: "soccer", options: BALL_KINDS, doc: "Type : soccer, basketball, volleyball, handball, waterpolo, rugby, americanfootball, tennis, baseball, cricket, golf, pingpong, petanque, cochonnet, billiard, bowling, beach, gym, medicine, bouncy, marble, playground" },
    diameter: { type: "number", default: 0, min: 0, max: 4, unit: "m", doc: "Diamètre (longueur pour un ovale) ; 0 = taille réelle" },
    squash: { type: "number", default: 0, min: 0, max: 0.5, doc: "Écrasement au sol (0 gonflé, 0,5 très dégonflé)" },
    color: { type: "string", default: "auto", doc: "Rôle de la couleur principale (auto = couleur d'usage)" },
    color2: { type: "string", default: "auto", doc: "Rôle de la deuxième couleur" },
    color3: { type: "string", default: "auto", doc: "Rôle de la troisième couleur" },
    number: { type: "int", default: 0, min: 0, max: 15, doc: "Billard : numéro (0 blanche, 1–8 pleines, 9–15 rayées)" },
    turn: { type: "number", default: 0, min: -180, max: 180, unit: "°", doc: "Rotation du motif autour de la verticale" },
  },
  build(p) {
    const spec = ballSpec(p);
    const mesh = ballMesh(spec);
    const R = spec.R;
    const A = (pos: V3, scale: number) => ({ pos, rot: [0, 0, 0, 1] as Q, scale });
    return {
      generator: "ball",
      mesh,
      anchors: { center: A([0, spec.cy, 0], R * 2), top: A([0, spec.height, 0], R * 2), grip: A([spec.hx, spec.cy, 0], R * 2) },
      footprint: { hx: spec.hx, hz: spec.hz, r: Math.hypot(spec.hx, spec.hz) },
      height: spec.height,
      extra: {
        affords: spec.def.affords,
        physics: { shape: spec.def.lying ? "ellipsoid" : "sphere", radius: +(R * Math.max(spec.S[0], spec.S[2])).toFixed(4), length: +(2 * R * spec.S[1]).toFixed(4), mass: spec.def.mass * (Number(p.diameter) > 0 ? (Number(p.diameter) / spec.def.d) ** 3 : 1), restitution: spec.def.e * (1 - clamp(Number(p.squash ?? 0), 0, 0.5) * 1.6), friction: spec.def.friction },
        scale: R * 2 < 0.05 ? "tiny" : R * 2 < 0.15 ? "hand" : R * 2 < 0.4 ? "arms" : "body",
      },
    };
  },
});
