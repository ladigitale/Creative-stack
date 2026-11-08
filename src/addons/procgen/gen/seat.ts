/**
 * Assises (`seat`, raccourci `seat.<kind>`) : tabourets, chaises, fauteuils, canapés, bancs, rondins, transats,
 * trônes, balançoire, couchettes d'animaux… construits par la grammaire de pièces (`parts.ts`) : un seul code pour la
 * 3D et le vectoriel. Taille selon l'utilisateur (`user` : adulte, enfant, tout-petit, géant, animal, lutin), matière,
 * dossier, accoudoirs, nombre de places.
 *
 * Chaque place publie une ancre `sit.N` (bassin assis) et `approach.N` (au sol, devant) : un acteur envoyé sur
 * `target: "<id>.sit.N"` avec `action: "sit"` marche jusqu'à la place et s'y assied face à l'avant de l'assise.
 */
import { type Q, type V3, clamp } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam } from "./parts";
import { type Anchor, defineGenerator } from "./types";

export const SEAT_KINDS = [
  "stool", "barstool", "chair", "armchair", "school", "folding", "rocking", "highchair", "throne", "monobloc",
  "bench", "parkbench", "pew", "sofa", "log", "stonebench", "deckchair", "pouf", "beanbag", "swing",
  "dogbed", "perch",
] as const;
export type SeatKind = (typeof SEAT_KINDS)[number];

/** Échelle selon l'utilisateur (hauteur d'assise et gabarit). */
export const USERS: Record<string, number> = { adult: 1, child: 0.72, toddler: 0.5, giant: 2.2, pet: 0.42, gnome: 0.28 };

type Built = { parts: PartList; seats: V3[]; depth: number; affords: string[]; back?: V3 };

type Opts = {
  W: number;
  places: number;
  back: "none" | "low" | "high";
  arms: boolean;
  frame: Role;
  seat: Role;
  cushion: boolean;
  variant: number;
};

const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, r1, role });
const bx = (c: V3, h: V3, role: Role, rot?: V3): Part => ({ t: "box", c, h, role, rot });

/** Quatre pieds droits (ou légèrement écartés) sous une assise de demi-côtés (x, z), hauteur y. */
function legs4(P: PartList, x: number, z: number, y: number, r: number, role: Role, splay = 0, taper = 0.8) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.push(rod([sx * (x + splay), 0, sz * (z + splay)], [sx * x, y, sz * z], r, role, r * taper));
}

/** Dossier : lattes, barreaux ou panneau entre deux montants arrière. */
function backrest(P: PartList, o: Opts, x: number, z: number, y0: number, h: number, tilt: number, kind: "slats" | "spindles" | "panel") {
  const lean = Math.tan((tilt * Math.PI) / 180) * h;
  for (const sx of [-1, 1]) P.push(rod([sx * x, y0, z], [sx * x, y0 + h, z - lean], 0.018, o.frame));
  if (kind === "panel") P.push(bx([0, y0 + h * 0.62, z - lean * 0.62], [x, h * 0.36, 0.015], o.seat, [-tilt, 0, 0]));
  else if (kind === "spindles") {
    const n = Math.max(3, Math.round((x * 2) / 0.07));
    for (let i = 1; i < n; i++) {
      const xi = -x + (2 * x * i) / n;
      P.push(rod([xi, y0 + 0.04, z - lean * 0.04 / h], [xi, y0 + h * 0.92, z - lean * 0.92], 0.009, o.frame));
    }
    P.push(bx([0, y0 + h * 0.96, z - lean * 0.96], [x + 0.02, 0.03, 0.018], o.frame, [-tilt, 0, 0]));
  } else {
    for (const f of [0.55, 0.85]) P.push(bx([0, y0 + h * f, z - lean * f], [x, 0.045, 0.012], o.seat, [-tilt, 0, 0]));
  }
}

function build(kind: SeatKind, o: Opts): Built {
  const P: PartList = [];
  const W = o.W;
  const v = o.variant;
  const sit = (y: number, z = 0, n = 1): V3[] => Array.from({ length: n }, (_, i) => [n === 1 ? 0 : -W / 2 + (W * (i + 0.5)) / n, y, z] as V3);
  switch (kind) {
    case "stool": {
      const H = 0.46, R = 0.17;
      P.push({ t: "lathe", c: [0, H - 0.045, 0], profile: [[R * 0.92, 0], [R, 0.02], [R, 0.035], [R * 0.9, 0.045]], role: o.seat });
      const n = v % 2 ? 3 : 4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.6;
        P.push(rod([Math.cos(a) * R * 1.15, 0, Math.sin(a) * R * 1.15], [Math.cos(a) * R * 0.7, H - 0.045, Math.sin(a) * R * 0.7], 0.017, o.frame, 0.014));
      }
      const ring: V3[] = Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * Math.PI * 2 + 0.6; return [Math.cos(a) * R * 0.98, H * 0.3, Math.sin(a) * R * 0.98]; });
      P.push({ t: "tube", pts: ring, r: 0.009, role: o.frame });
      return { parts: P, seats: sit(H), depth: R * 2.3, affords: ["sit"] };
    }
    case "barstool": {
      const H = 0.76, R = 0.18;
      P.push({ t: "lathe", c: [0, H - 0.06, 0], profile: [[R * 0.85, 0], [R, 0.03], [R, 0.05], [R * 0.85, 0.06]], role: o.seat });
      if (v % 2) {
        P.push({ t: "lathe", c: [0, 0, 0], profile: [[0.22, 0], [0.22, 0.02], [0.05, 0.04], [0.04, H - 0.06]], role: o.frame });
        P.push({ t: "tube", pts: Array.from({ length: 13 }, (_, i) => [Math.cos((i / 12) * Math.PI * 2) * 0.16, 0.3, Math.sin((i / 12) * Math.PI * 2) * 0.16] as V3), r: 0.01, role: o.frame });
      } else {
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          P.push(rod([Math.cos(a) * 0.24, 0, Math.sin(a) * 0.24], [Math.cos(a) * 0.13, H - 0.06, Math.sin(a) * 0.13], 0.016, o.frame, 0.013));
        }
        P.push({ t: "tube", pts: Array.from({ length: 5 }, (_, i) => { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; return [Math.cos(a) * 0.205, 0.28, Math.sin(a) * 0.205] as V3; }), r: 0.011, role: o.frame });
      }
      if (o.back !== "none") backrest(P, o, R * 0.8, -R * 0.75, H, o.back === "high" ? 0.32 : 0.18, 8, "slats");
      return { parts: P, seats: sit(H), depth: 0.5, affords: ["sit"] };
    }
    case "chair":
    case "rocking":
    case "highchair": {
      const H = kind === "highchair" ? 0.74 : 0.45, D = kind === "highchair" ? 0.36 : 0.42, x = W / 2 - 0.025, z = D / 2 - 0.025;
      P.push(bx([0, H - 0.02, 0], [W / 2, 0.02, D / 2], o.seat));
      const splay = kind === "highchair" ? 0.08 : 0;
      legs4(P, x, z, H - 0.04, 0.019, o.frame, splay);
      if (kind === "rocking") {
        for (const sx of [-1, 1]) P.push({ t: "tube", pts: Array.from({ length: 9 }, (_, i) => { const t = i / 8 - 0.5; return [sx * x, 0.06 + t * t * 0.5 - 0.0, t * (D + 0.5)] as V3; }), r: 0.016, role: o.frame });
      } else for (const sz of [-1, 1]) P.push(rod([-x - splay * 0.6, 0.16, sz * (z + splay * 0.6)], [x + splay * 0.6, 0.16, sz * (z + splay * 0.6)], 0.009, o.frame));
      if (kind === "highchair") {
        P.push(rod([-x - 0.05, 0.36, z + 0.05], [x + 0.05, 0.36, z + 0.05], 0.012, o.frame));
        P.push(bx([0, H + 0.24, D / 2 + 0.12], [W / 2 + 0.03, 0.015, 0.14], o.seat));
        for (const sx of [-1, 1]) P.push(rod([sx * x, H, D / 2 - 0.03], [sx * x, H + 0.23, D / 2 + 0.05], 0.012, o.frame));
      }
      if (o.back !== "none") backrest(P, o, x, -z, H - 0.02, o.back === "high" ? (kind === "rocking" ? 0.62 : 0.5) : 0.26, kind === "rocking" ? 14 : 9, v % 3 === 0 ? "slats" : v % 3 === 1 ? "spindles" : "panel");
      if (o.arms) for (const sx of [-1, 1]) {
        P.push(bx([sx * (x + 0.01), H + 0.22, 0], [0.025, 0.012, D / 2], o.frame));
        P.push(rod([sx * x, H, z], [sx * x, H + 0.21, z], 0.014, o.frame));
      }
      if (o.cushion) P.push({ t: "blob", c: [0, H + 0.02, 0.01], r: [W / 2 - 0.02, 0.03, D / 2 - 0.02], role: "cloth2" });
      return { parts: P, seats: sit(H + (o.cushion ? 0.04 : 0), -0.02), depth: kind === "rocking" ? D + 0.5 : D + 0.1, affords: kind === "rocking" ? ["sit", "rock"] : ["sit"], back: [0, H + 0.3, -z] };
    }
    case "monobloc": {
      // chaise de jardin en plastique moulé d'une pièce
      const H = 0.44, D = 0.44, x = W / 2;
      P.push(bx([0, H - 0.02, 0.01], [x, 0.022, D / 2], o.seat, [3, 0, 0]));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.push(rod([sx * (x + 0.04), 0, sz * (D / 2 + 0.03)], [sx * (x - 0.03), H - 0.03, sz * (D / 2 - 0.04)], 0.026, o.seat, 0.022));
      P.push(bx([0, H + 0.28, -D / 2 - 0.02], [x * 0.95, 0.24, 0.018], o.seat, [-14, 0, 0]));
      if (o.arms) for (const sx of [-1, 1]) P.push({ t: "tube", pts: [[sx * x, H + 0.4, -D / 2], [sx * (x + 0.02), H + 0.2, 0], [sx * (x + 0.03), H - 0.02, D / 2 - 0.02]], r: 0.02, role: o.seat });
      return { parts: P, seats: sit(H, -0.01), depth: D + 0.12, affords: ["sit", "stack"] };
    }
    case "school": {
      const H = 0.43, D = 0.4, x = W / 2 - 0.02;
      P.push(bx([0, H - 0.012, 0], [W / 2, 0.012, D / 2], o.seat));
      for (const sx of [-1, 1]) {
        P.push({ t: "tube", pts: [[sx * x, 0, D / 2 - 0.02], [sx * x, H - 0.03, D / 2 - 0.04], [sx * x, H - 0.03, -D / 2 + 0.04], [sx * x, 0, -D / 2 + 0.02]], r: 0.012, role: o.frame });
        P.push(rod([sx * x, H - 0.03, -D / 2 + 0.04], [sx * x, H + 0.36, -D / 2 - 0.02], 0.012, o.frame));
      }
      P.push(bx([0, H + 0.26, -D / 2 - 0.012], [W / 2 - 0.01, 0.1, 0.012], o.seat, [-8, 0, 0]));
      return { parts: P, seats: sit(H), depth: D + 0.08, affords: ["sit", "stack"] };
    }
    case "folding": {
      const H = 0.45, D = 0.42, x = W / 2;
      for (const sx of [-1, 1]) {
        P.push(rod([sx * x, 0, D / 2], [sx * x, H + 0.42, -D / 2 - 0.06], 0.012, o.frame));
        P.push(rod([sx * x, 0, -D / 2], [sx * x, H - 0.02, D / 2 - 0.04], 0.012, o.frame));
      }
      for (let i = 0; i < 4; i++) P.push(bx([0, H - 0.01, -D / 2 + 0.06 + (i * (D - 0.1)) / 3], [x - 0.015, 0.01, 0.04], o.seat));
      P.push(bx([0, H + 0.3, -D / 2 - 0.02], [x - 0.015, 0.07, 0.01], o.seat, [-14, 0, 0]));
      return { parts: P, seats: sit(H), depth: D + 0.1, affords: ["sit", "fold"] };
    }
    case "armchair": {
      const H = 0.42, D = 0.78, x = W / 2;
      P.push(bx([0, 0.24, 0], [x, 0.12, D / 2], o.seat));
      legs4(P, x - 0.06, D / 2 - 0.06, 0.12, 0.022, o.frame);
      P.push({ t: "blob", c: [0, 0.4, 0.04], r: [x - 0.14, 0.07, D / 2 - 0.08], role: o.seat });
      if (o.back !== "none") P.push(bx([0, 0.42 + (o.back === "high" ? 0.34 : 0.22), -D / 2 + 0.1], [x - 0.02, o.back === "high" ? 0.38 : 0.24, 0.09], o.seat, [-10, 0, 0]));
      if (o.arms) for (const sx of [-1, 1]) {
        P.push(bx([sx * (x - 0.07), 0.46, -0.02], [0.07, 0.1, D / 2 - 0.02], o.seat));
        P.push({ t: "blob", c: [sx * (x - 0.07), 0.57, -0.02], r: [0.08, 0.035, D / 2 - 0.02], role: o.seat });
      }
      return { parts: P, seats: sit(H + 0.05, 0.02), depth: D, affords: ["sit"] };
    }
    case "sofa": {
      const D = 0.86, x = W / 2;
      P.push(bx([0, 0.2, 0], [x, 0.1, D / 2], o.seat));
      legs4(P, x - 0.06, D / 2 - 0.06, 0.1, 0.022, o.frame);
      const n = o.places;
      const inner = x - (o.arms ? 0.16 : 0.02);
      for (let i = 0; i < n; i++) {
        const cx = -inner + (2 * inner * (i + 0.5)) / n;
        P.push({ t: "blob", c: [cx, 0.36, 0.06], r: [inner / n - 0.01, 0.07, D / 2 - 0.12], role: o.seat });
        if (o.back !== "none") P.push({ t: "blob", c: [cx, 0.58, -D / 2 + 0.16], r: [inner / n - 0.01, o.back === "high" ? 0.24 : 0.17, 0.09], role: o.seat });
      }
      if (o.back !== "none") P.push(bx([0, 0.5, -D / 2 + 0.06], [x, o.back === "high" ? 0.3 : 0.22, 0.06], o.seat));
      if (o.arms) for (const sx of [-1, 1]) P.push(bx([sx * (x - 0.08), 0.42, 0], [0.08, 0.14, D / 2], o.seat));
      return { parts: P, seats: Array.from({ length: n }, (_, i) => [-inner + (2 * inner * (i + 0.5)) / n, 0.43, 0.04] as V3), depth: D, affords: ["sit", "lie"] };
    }
    case "bench": {
      const H = 0.45, D = 0.3, x = W / 2;
      P.push(bx([0, H - 0.025, 0], [x, 0.025, D / 2], o.seat));
      if (v % 2) legs4(P, x - 0.08, D / 2 - 0.04, H - 0.05, 0.025, o.frame, 0.03);
      else for (const sx of [-1, 1]) P.push(bx([sx * (x - 0.12), (H - 0.05) / 2, 0], [0.025, (H - 0.05) / 2, D / 2 - 0.02], o.frame));
      if (o.back !== "none") {
        for (const sx of [-1, 1]) P.push(rod([sx * (x - 0.12), H - 0.05, -D / 2 + 0.02], [sx * (x - 0.12), H + 0.4, -D / 2 - 0.06], 0.02, o.frame));
        P.push(bx([0, H + 0.3, -D / 2 - 0.04], [x - 0.04, 0.06, 0.015], o.seat, [-10, 0, 0]));
      }
      return { parts: P, seats: sit(H, 0, o.places), depth: D + 0.1, affords: ["sit", "lie"] };
    }
    case "parkbench": {
      const H = 0.45, D = 0.44, x = W / 2;
      for (let i = 0; i < 4; i++) P.push(bx([0, H - 0.015, -D / 2 + 0.06 + (i * (D - 0.12)) / 3], [x, 0.016, 0.042], o.seat));
      for (let i = 0; i < 3; i++) P.push(bx([0, H + 0.12 + i * 0.12, -D / 2 - 0.02 - i * 0.025], [x, 0.04, 0.012], o.seat, [-14, 0, 0]));
      for (const sx of [-1, 1]) {
        const ex = sx * (x - 0.1);
        P.push({ t: "tube", pts: [[ex, 0, D / 2 - 0.02], [ex, H * 0.5, D / 2 - 0.05], [ex, H - 0.03, D / 2 - 0.06]], r: 0.018, role: o.frame });
        P.push({ t: "tube", pts: [[ex, 0, -D / 2 + 0.02], [ex, H - 0.03, -D / 2 + 0.03], [ex, H + 0.45, -D / 2 - 0.1]], r: 0.018, role: o.frame });
        P.push(rod([ex, H - 0.035, -D / 2 + 0.02], [ex, H - 0.035, D / 2 - 0.04], 0.015, o.frame));
        if (o.arms) P.push({ t: "tube", pts: [[sx * x, H, D / 2 - 0.06], [sx * x, H + 0.22, D / 2 - 0.08], [sx * x, H + 0.24, -D / 2 + 0.06]], r: 0.016, role: o.frame });
      }
      return { parts: P, seats: sit(H, 0, o.places), depth: D + 0.12, affords: ["sit", "lie"], back: [0, H + 0.3, -D / 2] };
    }
    case "pew": {
      const H = 0.44, D = 0.46, x = W / 2;
      P.push(bx([0, H - 0.025, 0], [x, 0.025, D / 2], o.seat));
      P.push(bx([0, H + 0.3, -D / 2 + 0.02], [x, 0.32, 0.02], o.seat, [-6, 0, 0]));
      for (const sx of [-1, 1]) P.push(bx([sx * (x + 0.025), 0.46, -0.02], [0.025, 0.46, D / 2 + 0.02], o.frame));
      P.push(bx([0, H + 0.48, -D / 2 - 0.12], [x, 0.012, 0.09], o.frame));
      return { parts: P, seats: sit(H, 0.02, o.places), depth: D + 0.25, affords: ["sit", "kneel"] };
    }
    case "log": {
      const r = 0.2, x = W / 2;
      P.push(rod([-x, r, 0], [x, r, 0], r, o.frame));
      for (const sx of [-1, 1]) P.push(rod([sx * x, r, 0], [sx * (x + 0.006), r, 0], r * 0.9, o.seat));
      P.push(bx([0, 2 * r - 0.03, 0], [x * 0.85, 0.02, r * 0.55], o.seat));
      return { parts: P, seats: sit(2 * r - 0.01, 0, o.places), depth: 2 * r, affords: ["sit", "roll"] };
    }
    case "stonebench": {
      const H = 0.45, D = 0.42, x = W / 2;
      P.push(bx([0, H - 0.05, 0], [x, 0.05, D / 2], o.seat));
      for (const sx of [-1, 1]) P.push(bx([sx * (x - 0.2), (H - 0.1) / 2, 0], [0.12, (H - 0.1) / 2, D / 2 - 0.04], o.frame));
      return { parts: P, seats: sit(H, 0, o.places), depth: D, affords: ["sit", "lie", "climb"] };
    }
    case "deckchair": {
      const x = W / 2;
      for (const sx of [-1, 1]) {
        P.push(rod([sx * x, 0, 0.5], [sx * x, 0.9, -0.42], 0.016, o.frame));
        P.push(rod([sx * (x - 0.04), 0, -0.25], [sx * (x - 0.04), 0.4, 0.42], 0.016, o.frame));
      }
      P.push({ t: "tube", pts: [[-x + 0.02, 0.88, -0.4], [-x + 0.02, 0.3, 0.05], [-x + 0.02, 0.36, 0.42]], r: 0.004, role: o.frame });
      P.push(bx([0, 0.52, -0.14], [x - 0.03, 0.006, 0.36], o.seat, [-55, 0, 0]));
      P.push(bx([0, 0.3, 0.2], [x - 0.03, 0.006, 0.18], o.seat, [20, 0, 0]));
      return { parts: P, seats: sit(0.3, 0.0), depth: 1.0, affords: ["sit", "lie", "fold"] };
    }
    case "pouf": {
      const R = 0.24;
      P.push({ t: "lathe", c: [0, 0, 0], profile: [[R * 0.92, 0], [R, 0.06], [R * 1.02, 0.2], [R, 0.34], [R * 0.85, 0.4], [0, 0.41]], role: o.seat });
      return { parts: P, seats: sit(0.41), depth: R * 2, affords: ["sit", "push"] };
    }
    case "beanbag": {
      P.push({ t: "blob", c: [0, 0.2, 0.06], r: [0.42, 0.2, 0.42], role: o.seat });
      P.push({ t: "blob", c: [0, 0.42, -0.18], r: [0.36, 0.28, 0.2], role: o.seat });
      return { parts: P, seats: sit(0.3, 0.06), depth: 0.9, affords: ["sit", "lie", "push"] };
    }
    case "throne": {
      const H = 0.5, D = 0.6, x = W / 2;
      P.push(bx([0, H / 2 - 0.02, 0], [x, H / 2 - 0.02, D / 2], o.frame));
      P.push(bx([0, H + 0.6, -D / 2 + 0.06], [x, 0.62, 0.06], o.frame));
      P.push(bx([0, H + 0.62, -D / 2 + 0.125], [x - 0.08, 0.5, 0.008], o.seat));
      for (const sx of [-1, 1]) {
        P.push(bx([sx * (x - 0.05), H + 0.17, 0.02], [0.06, 0.17, D / 2 - 0.02], o.frame));
        P.push({ t: "blob", c: [sx * x, H + 1.28, -D / 2 + 0.06], r: [0.06, 0.06, 0.06], role: "metal" });
      }
      P.push({ t: "lathe", c: [0, H + 1.22, -D / 2 + 0.06], profile: [[0.1, 0], [0.04, 0.12], [0.06, 0.2], [0, 0.3]], role: "metal" });
      P.push({ t: "blob", c: [0, H + 0.03, 0.04], r: [x - 0.12, 0.05, D / 2 - 0.08], role: o.seat });
      return { parts: P, seats: sit(H + 0.07, 0.04), depth: D, affords: ["sit"], back: [0, H + 0.6, -D / 2] };
    }
    case "swing": {
      const Hb = 2.1, x = Math.max(W / 2 + 0.35, 0.8);
      for (const sx of [-1, 1]) {
        P.push(rod([sx * x, 0, 0.7], [sx * x, Hb, 0], 0.04, o.frame));
        P.push(rod([sx * x, 0, -0.7], [sx * x, Hb, 0], 0.04, o.frame));
      }
      P.push(rod([-x - 0.08, Hb, 0], [x + 0.08, Hb, 0], 0.045, o.frame));
      const n = o.places;
      for (let i = 0; i < n; i++) {
        const cx = n === 1 ? 0 : -x + 0.45 + ((2 * x - 0.9) * i) / Math.max(1, n - 1);
        for (const dx of [-0.2, 0.2]) P.push(rod([cx + dx, Hb, 0], [cx + dx, 0.47, 0], 0.006, "metal"));
        P.push(bx([cx, 0.45, 0], [0.24, 0.02, 0.1], o.seat));
      }
      return { parts: P, seats: Array.from({ length: n }, (_, i) => [n === 1 ? 0 : -x + 0.45 + ((2 * x - 0.9) * i) / Math.max(1, n - 1), 0.47, 0] as V3), depth: 1.5, affords: ["sit", "swing"] };
    }
    case "dogbed": {
      const R = 0.4;
      P.push({ t: "lathe", c: [0, 0, 0], profile: [[R * 0.95, 0], [R, 0.08], [R * 0.96, 0.17], [R * 0.82, 0.18], [R * 0.74, 0.08], [R * 0.7, 0.06], [0, 0.06]], role: o.seat });
      P.push({ t: "blob", c: [0, 0.07, 0], r: [R * 0.7, 0.04, R * 0.7], role: "cloth3" });
      return { parts: P, seats: sit(0.1), depth: R * 2, affords: ["sit", "lie", "sleep"] };
    }
    case "perch": {
      P.push({ t: "lathe", c: [0, 0, 0], profile: [[0.22, 0], [0.22, 0.03], [0.05, 0.05], [0.025, 0.08]], role: o.frame });
      P.push(rod([0, 0.06, 0], [0, 1.0, 0], 0.022, o.frame));
      P.push(rod([-0.32, 1.0, 0], [0.32, 1.0, 0], 0.016, o.seat));
      P.push({ t: "lathe", c: [0.28, 0.96, 0], profile: [[0.03, 0], [0.05, 0.02], [0.05, 0.04]], role: "metal" });
      return { parts: P, seats: [[-0.16, 1.02, 0], [0.12, 1.02, 0]], depth: 0.44, affords: ["perch"] };
    }
  }
}

/* ---------- valeurs par défaut par type ---------- */

const DEF: Record<SeatKind, { W: number; places: number; back: Opts["back"]; arms: boolean; material: string; label: string }> = {
  stool: { W: 0.36, places: 1, back: "none", arms: false, material: "wood", label: "Tabouret" },
  barstool: { W: 0.42, places: 1, back: "none", arms: false, material: "metal", label: "Tabouret de bar" },
  chair: { W: 0.44, places: 1, back: "high", arms: false, material: "wood", label: "Chaise" },
  armchair: { W: 0.86, places: 1, back: "high", arms: true, material: "upholstered", label: "Fauteuil" },
  school: { W: 0.4, places: 1, back: "low", arms: false, material: "metal", label: "Chaise d'école" },
  folding: { W: 0.44, places: 1, back: "low", arms: false, material: "metal", label: "Chaise pliante" },
  rocking: { W: 0.52, places: 1, back: "high", arms: true, material: "wood", label: "Rocking-chair" },
  highchair: { W: 0.4, places: 1, back: "low", arms: false, material: "wood", label: "Chaise haute" },
  throne: { W: 0.86, places: 1, back: "high", arms: true, material: "throne", label: "Trône" },
  monobloc: { W: 0.5, places: 1, back: "high", arms: true, material: "plastic", label: "Chaise de jardin en plastique" },
  bench: { W: 1.4, places: 3, back: "none", arms: false, material: "wood", label: "Banc" },
  parkbench: { W: 1.8, places: 3, back: "high", arms: true, material: "park", label: "Banc public" },
  pew: { W: 2.6, places: 5, back: "high", arms: false, material: "wood", label: "Banc d'église" },
  sofa: { W: 1.9, places: 3, back: "high", arms: true, material: "upholstered", label: "Canapé" },
  log: { W: 1.6, places: 2, back: "none", arms: false, material: "log", label: "Rondin" },
  stonebench: { W: 1.6, places: 3, back: "none", arms: false, material: "stone", label: "Banc de pierre" },
  deckchair: { W: 0.56, places: 1, back: "high", arms: false, material: "deckchair", label: "Transat" },
  pouf: { W: 0.48, places: 1, back: "none", arms: false, material: "upholstered", label: "Pouf" },
  beanbag: { W: 0.84, places: 1, back: "low", arms: false, material: "upholstered", label: "Poire" },
  swing: { W: 1.0, places: 2, back: "none", arms: false, material: "swing", label: "Balançoire" },
  dogbed: { W: 0.8, places: 1, back: "none", arms: false, material: "upholstered", label: "Panier de chien ou de chat" },
  perch: { W: 0.64, places: 2, back: "none", arms: false, material: "wood", label: "Perchoir d'oiseau" },
};

const MATERIALS: Record<string, { frame: Role; seat: Role }> = {
  wood: { frame: "wood", seat: "wood" },
  metal: { frame: "metal", seat: "wood" },
  plastic: { frame: "white", seat: "white" },
  stone: { frame: "stone", seat: "stone" },
  upholstered: { frame: "wood", seat: "cloth1" },
  wicker: { frame: "wood", seat: "path" },
  park: { frame: "metal", seat: "wood" },
  log: { frame: "bark", seat: "wood" },
  deckchair: { frame: "wood", seat: "cloth3" },
  throne: { frame: "wood", seat: "red" },
  swing: { frame: "wood", seat: "wood" },
};

export type SeatModel = { parts: PartList; seats: V3[]; depth: number; affords: string[]; back?: V3; scale: number; label: string };

/** Paramètres résolus → pièces (à l'échelle de l'utilisateur), places et affordances. Partagé 3D / vectoriel. */
export function seatModel(p: Record<string, unknown>): SeatModel {
  const kind = (SEAT_KINDS as readonly string[]).includes(String(p.kind)) ? (String(p.kind) as SeatKind) : "chair";
  const d = DEF[kind];
  const multi = kind === "bench" || kind === "parkbench" || kind === "pew" || kind === "sofa" || kind === "log" || kind === "stonebench" || kind === "swing";
  const places = multi ? clamp(Number(p.places ?? 0) > 0 ? Math.round(Number(p.places)) : d.places, 1, 12) : d.places;
  const W = Number(p.width ?? 0) > 0 ? Number(p.width) : multi && Number(p.places ?? 0) > 0 ? places * (kind === "sofa" ? 0.62 : 0.56) + (kind === "sofa" ? 0.3 : 0.1) : d.W;
  const matName = String(p.material ?? "auto");
  const mat = MATERIALS[matName === "auto" ? d.material : matName] ?? MATERIALS[d.material];
  const back = (["none", "low", "high"].includes(String(p.back)) ? String(p.back) : d.back) as Opts["back"];
  const arms = p.arms === "yes" ? true : p.arms === "no" ? false : d.arms;
  const o: Opts = {
    W,
    places,
    back,
    arms,
    frame: roleParam(p.color2, mat.frame),
    seat: roleParam(p.color, mat.seat),
    cushion: Boolean(p.cushion),
    variant: Number(p.variant ?? 0) | 0,
  };
  const b = build(kind, o);
  const user = String(p.user ?? "adult");
  const s = clamp((USERS[user] ?? 1) * clamp(Number(p.scale ?? 1) || 1, 0.1, 6), 0.1, 4);
  const S = (q: V3): V3 => [q[0] * s, q[1] * s, q[2] * s];
  const scalePart = (q: Part): Part => {
    switch (q.t) {
      case "box":
        return { ...q, c: S(q.c), h: S(q.h) };
      case "rod":
        return { ...q, a: S(q.a), b: S(q.b), r: q.r * s, r1: q.r1 === undefined ? undefined : q.r1 * s };
      case "tube":
        return { ...q, pts: q.pts.map(S), r: q.r * s };
      case "lathe":
        return { ...q, c: S(q.c), profile: q.profile.map(([r, y]) => [r * s, y * s] as [number, number]) };
      case "blob":
        return { ...q, c: S(q.c), r: S(q.r) };
    }
  };
  return { parts: s === 1 ? b.parts : b.parts.map(scalePart), seats: b.seats.map(S), depth: b.depth * s, affords: b.affords, back: b.back ? S(b.back) : undefined, scale: s, label: d.label };
}

export const seat = defineGenerator({
  id: "seat",
  label: "Assise : chaise, banc, fauteuil, tabouret…",
  doc:
    "Assises paramétriques (stool, barstool, chair, armchair, school, folding, rocking, highchair, throne, monobloc, bench, parkbench, pew, sofa, log, stonebench, deckchair, pouf, beanbag, swing, dogbed, perch) construites par pièces : même modèle en 3D et en vectoriel. `user` règle le gabarit (adult, child, toddler, giant, pet, gnome), `places` la longueur des bancs et canapés, `material` (wood, metal, plastic, stone, upholstered, wicker…), `back` (none, low, high), `arms` (yes, no), `color`/`color2` les rôles de l'assise et de la structure. Ancres `sit.N` (bassin assis) et `approach.N` (devant, au sol) ; un acteur `{target: \"<id>.sit.0\", action: \"sit\"}` va s'y asseoir. `extra.affords` : sit, lie, rock, swing, perch…",
  tags: ["assise", "chaise", "banc", "fauteuil", "mobilier", "objet du quotidien", "jardin", "parc"],
  schema: {
    kind: { type: "enum", default: "chair", options: SEAT_KINDS, doc: "Type d'assise" },
    user: { type: "enum", default: "adult", options: Object.keys(USERS), doc: "Gabarit de l'utilisateur" },
    scale: { type: "number", default: 1, min: 0.1, max: 6, doc: "Échelle supplémentaire" },
    places: { type: "int", default: 0, min: 0, max: 12, doc: "Places (bancs, canapés, rondins, balançoires) ; 0 = usage" },
    width: { type: "number", default: 0, min: 0, max: 8, unit: "m", doc: "Largeur ; 0 = d'après les places" },
    material: { type: "enum", default: "auto", options: ["auto", ...Object.keys(MATERIALS)], doc: "Matière" },
    back: { type: "enum", default: "auto", options: ["auto", "none", "low", "high"], doc: "Dossier" },
    arms: { type: "enum", default: "auto", options: ["auto", "yes", "no"], doc: "Accoudoirs" },
    cushion: { type: "bool", default: false, doc: "Galette sur l'assise (chaises)" },
    color: { type: "string", default: "auto", doc: "Rôle de l'assise / du tissu" },
    color2: { type: "string", default: "auto", doc: "Rôle de la structure" },
    variant: { type: "int", default: 0, min: 0, max: 7, doc: "Variante (lattes, barreaux ou panneau ; 3 ou 4 pieds…)" },
  },
  build(p) {
    const m = seatModel(p);
    const mesh = partsToMesh(m.parts, m.scale < 0.6 ? 0.7 : 1);
    const bb = partsBounds(m.parts);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]));
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]));
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = {};
    m.seats.forEach((q, i) => {
      anchors[`sit.${i}`] = { pos: q, rot, scale: m.scale };
      anchors[`approach.${i}`] = { pos: [q[0], 0, hz + 0.35 * Math.max(0.5, m.scale)], rot, scale: m.scale };
    });
    if (m.back) anchors.back = { pos: m.back, rot, scale: m.scale };
    return {
      generator: "seat",
      mesh,
      anchors,
      footprint: { hx, hz, r: Math.hypot(hx, hz) },
      height: bb.max[1],
      extra: { affords: m.affords, places: m.seats.length, seatHeight: +m.seats[0][1].toFixed(3), user: String(p.user ?? "adult"), parts: m.parts.length },
    };
  },
});
