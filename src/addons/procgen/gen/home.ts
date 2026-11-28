/**
 * Objets du quotidien en intérieur, à taille réelle, sur la grammaire de pièces (même modèle en 3D et en vectoriel) :
 * meubles, électroménager, électronique, salle de bain, décoration. Les objets à écran (télévision, ordinateur,
 * portable, téléphone, console, micro-ondes…) publient une ancre `screen` (centre de l'écran, face +z) et sa taille
 * dans `extra.screen` : les écrans animés s'y posent. Face avant vers +z.
 */
import { type Q, type V3, clamp } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam } from "./parts";
import { type Anchor, defineGenerator } from "./types";

type O = { main: Role; trim: Role; v: number };
type Built = { parts: PartList; label: string; screen?: { c: V3; w: number; h: number; tilt?: number }; anchors?: Record<string, V3>; affords?: string[] };

const box = (c: V3, h: V3, role: Role, rot?: V3, r = 0.004): Part => ({ t: "box", c, h, role, rot, r });
const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, ...(r1 !== undefined ? { r1 } : {}), role });
const lathe = (c: V3, profile: [number, number][], role: Role): Part => ({ t: "lathe", c, profile, role });
const blob = (c: V3, r: V3, role: Role): Part => ({ t: "blob", c, r, role });
/** Écran : dalle sombre légèrement en avant d'un cadre (rôle black : éteint ; les écrans animés se posent dessus). */
const screen = (P: PartList, c: V3, w: number, h: number, frame: Role, d = 0.02) => {
  P.push(box(c, [w / 2 + 0.012, h / 2 + 0.012, d], frame));
  P.push(box([c[0], c[1], c[2] + d + 0.001], [w / 2, h / 2, 0.002], "black", undefined, 0.001));
};

const KINDS: Record<string, { label: string; main: Role; trim: Role; build: (o: O) => Built }> = {
  /* ---------- électronique ---------- */
  tv: { label: "Télévision", main: "black", trim: "wood", build: (o) => {
    const P: PartList = [];
    // meuble bas, pied central, dalle 16/9 de 1,1 m
    P.push(box([0, 0.24, 0], [0.7, 0.24, 0.2], o.trim));
    P.push(box([0, 0.5, -0.02], [0.12, 0.02, 0.08], "black"));
    P.push(box([0, 0.56, -0.03], [0.02, 0.06, 0.02], "black"));
    screen(P, [0, 0.93, -0.02], 1.1, 0.62, "black", 0.015);
    return { parts: P, label: "Télévision", screen: { c: [0, 0.93, 0.0], w: 1.1, h: 0.62 }, affords: ["watch"] };
  } },
  crt: { label: "Télévision à tube", main: "wood", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.3, 0], [0.3, 0.3, 0.25], o.main, undefined, 0.03));
    screen(P, [-0.05, 0.32, 0.24], 0.4, 0.3, o.trim, 0.02);
    for (const y of [0.22, 0.32, 0.42]) P.push(rod([0.22, y, 0.25], [0.22, y, 0.28], 0.018, "metal"));
    P.push(rod([-0.05, 0.6, 0], [-0.25, 0.85, -0.05], 0.004, "metal"));
    P.push(rod([-0.05, 0.6, 0], [0.15, 0.86, -0.05], 0.004, "metal"));
    return { parts: P, label: "Télévision à tube", screen: { c: [-0.05, 0.32, 0.265], w: 0.4, h: 0.3 }, affords: ["watch"] };
  } },
  laptop: { label: "Ordinateur portable", main: "metal", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.009, 0.1], [0.17, 0.009, 0.12], o.main, undefined, 0.006));
    P.push(box([0, 0.019, 0.08], [0.14, 0.001, 0.06], o.trim));
    P.push(box([0, 0.019, 0.17], [0.04, 0.001, 0.025], "black"));
    // écran ouvert à 105°
    P.push(box([0, 0.12, -0.03], [0.17, 0.11, 0.005], o.main, [-15, 0, 0], 0.004));
    P.push(box([0, 0.12, -0.023], [0.15, 0.094, 0.001], "black", [-15, 0, 0], 0.001));
    return { parts: P, label: "Ordinateur portable", screen: { c: [0, 0.122, -0.02], w: 0.3, h: 0.19, tilt: -15 }, affords: ["use", "type"] };
  } },
  computer: { label: "Ordinateur de bureau", main: "black", trim: "white", build: (o) => {
    const P: PartList = [];
    screen(P, [0, 0.34, -0.1], 0.6, 0.34, o.main, 0.015);
    P.push(box([0, 0.12, -0.12], [0.03, 0.1, 0.02], o.main));
    P.push(box([0, 0.01, -0.12], [0.12, 0.01, 0.09], o.main));
    P.push(box([0, 0.012, 0.12], [0.22, 0.012, 0.07], o.trim, [4, 0, 0]));
    P.push(blob([0.3, 0.015, 0.12], [0.03, 0.015, 0.05], o.trim));
    P.push(box([0.45, 0.22, -0.05], [0.09, 0.22, 0.22], o.main, undefined, 0.01));
    return { parts: P, label: "Ordinateur de bureau", screen: { c: [0, 0.34, -0.08], w: 0.6, h: 0.34 }, affords: ["use", "type"] };
  } },
  phone: { label: "Téléphone", main: "black", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.004, 0], [0.037, 0.004, 0.076], o.main, undefined, 0.008));
    P.push(box([0, 0.0085, 0], [0.034, 0.0006, 0.071], "black", undefined, 0.006));
    return { parts: P, label: "Téléphone", screen: { c: [0, 0.009, 0], w: 0.068, h: 0.142, tilt: -90 }, affords: ["use", "call"] };
  } },
  tablet: { label: "Tablette", main: "metal", trim: "black", build: (o) => {
    const P: PartList = [];
    // posée sur son étui replié, inclinée de 20° vers l'arrière
    P.push(box([0, 0.012, -0.02], [0.12, 0.012, 0.07], o.trim, undefined, 0.006));
    P.push(box([0, 0.1, -0.03], [0.12, 0.085, 0.005], o.main, [-20, 0, 0], 0.006));
    P.push(box([0, 0.1, -0.024], [0.11, 0.075, 0.001], "black", [-20, 0, 0], 0.002));
    P.push(box([0, 0.006, 0.035], [0.12, 0.006, 0.012], o.trim));
    return { parts: P, label: "Tablette", screen: { c: [0, 0.1, -0.022], w: 0.22, h: 0.15, tilt: -20 }, affords: ["use"] };
  } },
  console: { label: "Console de jeux", main: "black", trim: "white", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.04, 0], [0.15, 0.04, 0.13], o.main, undefined, 0.01));
    P.push(box([0.08, 0.081, 0.06], [0.03, 0.001, 0.01], "blue"));
    for (const x of [-0.25, 0.3]) {
      P.push(box([x, 0.025, 0.15], [0.07, 0.02, 0.045], o.trim, [0, x * 40, 0], 0.015));
      P.push(blob([x - 0.03, 0.05, 0.16], [0.01, 0.006, 0.01], "black"));
    }
    return { parts: P, label: "Console de jeux", affords: ["play"] };
  } },
  radio: { label: "Radio", main: "wood", trim: "paper", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.14, 0], [0.2, 0.14, 0.09], o.main, undefined, 0.04));
    P.push(box([-0.06, 0.15, 0.09], [0.11, 0.1, 0.005], o.trim, undefined, 0.02));
    P.push(box([0.13, 0.2, 0.09], [0.05, 0.04, 0.005], "black"));
    for (const y of [0.08, 0.13]) P.push(rod([0.13, y, 0.09], [0.13, y, 0.115], 0.016, "metal"));
    return { parts: P, label: "Radio", affords: ["listen"] };
  } },
  turntable: { label: "Platine vinyle", main: "wood", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.04, 0], [0.22, 0.04, 0.18], o.main, undefined, 0.006));
    P.push(lathe([-0.04, 0.08, 0], [[0.15, 0], [0.15, 0.006], [0, 0.006]], "metal"));
    P.push(lathe([-0.04, 0.086, 0], [[0.15, 0], [0.15, 0.002], [0, 0.002]], o.trim));
    P.push(lathe([-0.04, 0.088, 0], [[0.045, 0], [0.045, 0.001], [0, 0.001]], "red"));
    P.push(rod([0.17, 0.1, -0.12], [0.06, 0.1, 0.06], 0.004, "metal"));
    P.push(rod([0.17, 0.08, -0.12], [0.17, 0.1, -0.12], 0.015, "metal"));
    // couvercle de plexiglas relevé
    P.push(box([0, 0.24, -0.19], [0.22, 0.17, 0.004], "glass", [-15, 0, 0]));
    return { parts: P, label: "Platine vinyle", anchors: { record: [-0.04, 0.09, 0] }, affords: ["listen", "play"] };
  } },
  speaker: { label: "Enceinte", main: "black", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.25, 0], [0.13, 0.25, 0.14], o.main, undefined, 0.01));
    for (const [y, r] of [[0.33, 0.08], [0.12, 0.045]] as const) P.push(lathe([0, y, 0.14], [[r, 0], [r * 0.4, 0.012], [0, 0.015]], o.trim));
    return { parts: P, label: "Enceinte", affords: ["listen"] };
  } },
  cinema: { label: "Toile de cinéma", main: "black", trim: "white", build: (o) => {
    const P: PartList = [];
    // toile 16/9 de 6 m tendue dans un cadre noir, rideaux rouges de part et d'autre, estrade
    P.push(box([0, 0.25, 0], [3.6, 0.25, 0.6], "wood"));
    P.push(box([0, 2.3, -0.05], [3.25, 1.8, 0.04], o.main));
    P.push(box([0, 2.3, -0.005], [3.0, 1.69, 0.004], o.trim, undefined, 0.002));
    for (const sx of [-1, 1]) P.push(box([sx * 3.45, 2.2, 0.05], [0.25, 1.95, 0.08], "red", undefined, 0.06));
    P.push(box([0, 4.25, 0.05], [3.7, 0.18, 0.1], "red", undefined, 0.04));
    return { parts: P, label: "Toile de cinéma", screen: { c: [0, 2.3, 0.001], w: 6.0, h: 3.38 }, affords: ["watch"] };
  } },
  adscreen: { label: "Écran publicitaire", main: "black", trim: "metal", build: (o) => {
    const P: PartList = [];
    // écran à diodes de rue sur un mât, caisson épais
    P.push(box([0, 1.2, -0.05], [0.08, 1.2, 0.08], o.trim, undefined, 0.03));
    P.push(box([0, 3.1, -0.05], [1.05, 0.65, 0.12], o.main, undefined, 0.03));
    return { parts: P, label: "Écran publicitaire", screen: { c: [0, 3.1, 0.072], w: 1.96, h: 1.18 }, affords: ["watch"] };
  } },
  /* ---------- électroménager ---------- */
  vacuum: { label: "Aspirateur", main: "red", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(blob([0, 0.14, 0], [0.16, 0.13, 0.2], o.main));
    for (const sx of [-1, 1]) P.push(lathe([sx * 0.15, 0.06, -0.08], [[0.06, 0], [0.06, 0.03], [0, 0.03]], o.trim));
    P.push({ t: "tube", pts: [[0, 0.2, 0.18], [0.05, 0.35, 0.35], [0.12, 0.6, 0.5]], r: 0.025, role: o.trim });
    P.push(rod([0.12, 0.6, 0.5], [0.3, 0.05, 0.9], 0.018, "metal"));
    P.push(box([0.32, 0.03, 0.95], [0.15, 0.025, 0.05], o.trim, [0, 20, 0], 0.01));
    return { parts: P, label: "Aspirateur", anchors: { grip: [0.12, 0.6, 0.5] }, affords: ["vacuum", "carry"] };
  } },
  iron: { label: "Fer à repasser", main: "blue", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push({ t: "plate", c: [0, 0, 0], pts: [[-0.12, 0], [0.11, 0], [0.13, 0.03], [-0.1, 0.05]], d: 0.05, rot: [0, 90, 0], role: o.trim });
    P.push(blob([0, 0.06, 0], [0.05, 0.035, 0.11], o.main));
    P.push({ t: "tube", pts: [[0, 0.07, -0.06], [0, 0.12, -0.03], [0, 0.12, 0.05], [0, 0.08, 0.08]], r: 0.012, role: o.main });
    return { parts: P, label: "Fer à repasser", affords: ["iron"] };
  } },
  ironingboard: { label: "Table à repasser", main: "blue", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push({ t: "plate", c: [0, 0.88, 0], pts: [[-0.6, -0.18], [0.45, -0.18], [0.6, 0], [0.45, 0.18], [-0.6, 0.18]], d: 0.015, rot: [-90, 0, 0], role: o.main });
    P.push(rod([-0.35, 0.86, -0.15], [0.25, 0.02, 0.15], 0.012, o.trim));
    P.push(rod([-0.35, 0.86, 0.15], [0.25, 0.02, -0.15], 0.012, o.trim));
    P.push(rod([0.3, 0.86, -0.15], [-0.25, 0.02, 0.15], 0.012, o.trim));
    P.push(box([0.5, 0.92, 0], [0.11, 0.035, 0.05], "blue", undefined, 0.02));
    return { parts: P, label: "Table à repasser", affords: ["iron"] };
  } },
  fridge: { label: "Réfrigérateur", main: "white", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.9, 0], [0.3, 0.9, 0.32], o.main, undefined, 0.02));
    P.push(box([0, 1.25, 0.322], [0.295, 0.005, 0.001], o.trim));
    for (const y of [1.45, 0.9]) P.push(rod([0.25, y - 0.15, 0.34], [0.25, y + 0.15, 0.34], 0.012, o.trim));
    return { parts: P, label: "Réfrigérateur", affords: ["open", "store"] };
  } },
  stove: { label: "Cuisinière", main: "white", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.43, 0], [0.3, 0.43, 0.3], o.main, undefined, 0.01));
    P.push(box([0, 0.865, 0], [0.3, 0.005, 0.3], o.trim));
    for (const [x, z] of [[-0.14, -0.13], [0.14, -0.13], [-0.14, 0.13], [0.14, 0.13]]) P.push(lathe([x, 0.87, z], [[0.08, 0], [0.08, 0.008], [0, 0.008]], "black"));
    P.push(box([0, 0.4, 0.3], [0.26, 0.2, 0.004], "glass"));
    P.push(rod([-0.2, 0.68, 0.31], [0.2, 0.68, 0.31], 0.01, "metal"));
    return { parts: P, label: "Cuisinière", anchors: { burner: [0.14, 0.88, 0.13] }, affords: ["cook"] };
  } },
  microwave: { label: "Micro-ondes", main: "white", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.15, 0], [0.25, 0.15, 0.19], o.main, undefined, 0.01));
    P.push(box([-0.05, 0.15, 0.19], [0.17, 0.11, 0.002], o.trim));
    P.push(box([0.18, 0.22, 0.19], [0.04, 0.02, 0.002], "black"));
    return { parts: P, label: "Micro-ondes", screen: { c: [0.18, 0.22, 0.193], w: 0.06, h: 0.03 }, affords: ["heat"] };
  } },
  washer: { label: "Lave-linge", main: "white", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.42, 0], [0.3, 0.42, 0.3], o.main, undefined, 0.012));
    // hublot : anneau de métal (cylindre selon z) et vitre
    P.push(rod([0, 0.38, 0.29], [0, 0.38, 0.33], 0.17, o.trim));
    P.push(rod([0, 0.38, 0.33], [0, 0.38, 0.335], 0.13, "glass"));
    P.push(box([0, 0.78, 0.3], [0.28, 0.04, 0.002], o.trim));
    return { parts: P, label: "Lave-linge", affords: ["wash"] };
  } },
  kettle: { label: "Bouilloire", main: "metal", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(lathe([0, 0, 0], [[0.08, 0], [0.085, 0.12], [0.06, 0.2], [0.03, 0.22], [0, 0.22]], o.main));
    P.push({ t: "tube", pts: [[-0.06, 0.18, 0], [-0.12, 0.17, 0], [-0.12, 0.06, 0], [-0.08, 0.04, 0]], r: 0.012, role: o.trim });
    P.push(rod([0.07, 0.12, 0], [0.13, 0.19, 0], 0.012, o.main, 0.008));
    return { parts: P, label: "Bouilloire", affords: ["heat"] };
  } },
  coffeemaker: { label: "Machine à café", main: "black", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.18, -0.04], [0.12, 0.18, 0.12], o.main, undefined, 0.01));
    P.push(box([0, 0.03, 0.1], [0.12, 0.03, 0.06], o.main, undefined, 0.01));
    P.push(box([0, 0.3, 0.09], [0.1, 0.04, 0.05], o.trim, undefined, 0.01));
    P.push(lathe([0, 0.06, 0.1], [[0.025, 0], [0.032, 0.05], [0, 0.05]], "white"));
    return { parts: P, label: "Machine à café", affords: ["brew"] };
  } },
  toaster: { label: "Grille-pain", main: "metal", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.1, 0], [0.15, 0.1, 0.08], o.main, undefined, 0.03));
    for (const x of [-0.05, 0.05]) P.push(box([x, 0.2, 0], [0.012, 0.004, 0.06], o.trim));
    P.push(box([0.05, 0.215, 0], [0.008, 0.02, 0.05], "orange"));
    return { parts: P, label: "Grille-pain", affords: ["heat"] };
  } },
  /* ---------- meubles ---------- */
  bed: { label: "Lit", main: "wood", trim: "white", build: (o) => {
    const P: PartList = [];
    const W = o.v % 2 ? 0.7 : 1.4;
    P.push(box([0, 0.2, 0], [W / 2 + 0.04, 0.12, 1.02], o.main));
    P.push(box([0, 0.48, -1.03], [W / 2 + 0.04, 0.4, 0.035], o.main));
    P.push(box([0, 0.38, 0.02], [W / 2, 0.08, 0.98], o.trim, undefined, 0.04));
    P.push(box([0, 0.47, 0.3], [W / 2 + 0.03, 0.03, 0.72], (["blue", "cloth1", "green", "red"] as Role[])[o.v % 4], undefined, 0.03));
    for (const x of W > 1 ? [-0.33, 0.33] : [0]) P.push(blob([x, 0.5, -0.78], [0.3, 0.07, 0.17], "white"));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.push(box([sx * (W / 2 - 0.02), 0.05, sz * 0.98], [0.035, 0.05, 0.035], o.main));
    return { parts: P, label: "Lit", anchors: { "sit.0": [0, 0.46, 0.5], lie: [0, 0.5, 0] }, affords: ["sleep", "sit"] };
  } },
  wardrobe: { label: "Armoire", main: "wood", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 1.0, 0], [0.5, 1.0, 0.3], o.main, undefined, 0.006));
    P.push(box([0, 1.0, 0.301], [0.003, 0.95, 0.002], "bark"));
    for (const sx of [-1, 1]) P.push(rod([sx * 0.05, 0.9, 0.31], [sx * 0.05, 1.1, 0.31], 0.008, o.trim));
    return { parts: P, label: "Armoire", affords: ["open", "store"] };
  } },
  bookshelf: { label: "Bibliothèque", main: "wood", trim: "red", build: (o) => {
    const P: PartList = [];
    for (const sx of [-1, 1]) P.push(box([sx * 0.4, 0.9, 0], [0.015, 0.9, 0.15], o.main));
    P.push(box([0, 0.9, -0.145], [0.4, 0.9, 0.006], o.main));
    const cols: Role[] = ["red", "blue", "green", "yellow", "paper", "black", "orange", "purple"];
    for (let s = 0; s < 5; s++) {
      const y = 0.02 + s * 0.4;
      P.push(box([0, y, 0], [0.39, 0.015, 0.15], o.main));
      let x = -0.37;
      let k = s * 3 + o.v;
      while (x < 0.33) {
        const w = 0.02 + ((k * 7) % 4) * 0.008, h = 0.2 + ((k * 5) % 4) * 0.03;
        P.push(box([x + w / 2, y + 0.015 + h / 2, 0.02], [w / 2, h / 2, 0.11], cols[k % cols.length], ((k * 13) % 9) === 0 ? [0, 0, -12] : undefined, 0.003));
        x += w + 0.004;
        k++;
      }
    }
    return { parts: P, label: "Bibliothèque", affords: ["read"] };
  } },
  desk: { label: "Bureau", main: "wood", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.74, 0], [0.6, 0.02, 0.32], o.main));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.push(box([sx * 0.56, 0.36, sz * 0.28], [0.02, 0.36, 0.02], o.trim));
    P.push(box([0.42, 0.55, 0], [0.16, 0.17, 0.3], o.main));
    for (const y of [0.45, 0.62]) P.push(rod([0.36, y, 0.31], [0.48, y, 0.31], 0.006, o.trim));
    return { parts: P, label: "Bureau", affords: ["work", "sit"] };
  } },
  dresser: { label: "Commode", main: "wood", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.42, 0], [0.5, 0.42, 0.24], o.main, undefined, 0.006));
    for (let i = 0; i < 4; i++) {
      const y = 0.13 + i * 0.2;
      P.push(box([0, y, 0.241], [0.47, 0.085, 0.003], o.main));
      P.push(rod([-0.06, y, 0.25], [0.06, y, 0.25], 0.007, o.trim));
    }
    return { parts: P, label: "Commode", affords: ["open", "store"] };
  } },
  nightstand: { label: "Table de chevet", main: "wood", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.27, 0], [0.22, 0.27, 0.18], o.main, undefined, 0.006));
    P.push(rod([-0.04, 0.42, 0.185], [0.04, 0.42, 0.185], 0.006, o.trim));
    return { parts: P, label: "Table de chevet", affords: ["store"] };
  } },
  coffeetable: { label: "Table basse", main: "wood", trim: "black", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.4, 0], [0.55, 0.025, 0.3], o.main, undefined, 0.01));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.push(box([sx * 0.48, 0.19, sz * 0.24], [0.025, 0.19, 0.025], o.main));
    P.push(box([0, 0.12, 0], [0.5, 0.012, 0.26], o.main));
    return { parts: P, label: "Table basse", affords: ["put"] };
  } },
  rug: { label: "Tapis", main: "red", trim: "paper", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 0.004, 0], [1.0, 0.004, 0.7], o.main, undefined, 0.002));
    P.push(box([0, 0.009, 0], [0.8, 0.001, 0.5], o.trim, undefined, 0.001));
    P.push(box([0, 0.011, 0], [0.6, 0.001, 0.32], o.main, undefined, 0.001));
    return { parts: P, label: "Tapis", affords: ["walk"] };
  } },
  floorlamp: { label: "Lampadaire", main: "metal", trim: "paper", build: (o) => {
    const P: PartList = [];
    P.push(lathe([0, 0, 0], [[0.16, 0], [0.15, 0.02], [0, 0.03]], o.main));
    P.push(rod([0, 0.02, 0], [0, 1.45, 0], 0.012, o.main));
    P.push(lathe([0, 1.4, 0], [[0.22, 0], [0.13, 0.28], [0.12, 0.28], [0.2, 0.01]], o.trim));
    P.push(blob([0, 1.5, 0], [0.04, 0.05, 0.04], "lamp"));
    return { parts: P, label: "Lampadaire", anchors: { light: [0, 1.5, 0] }, affords: ["light"] };
  } },
  desklamp: { label: "Lampe de bureau", main: "black", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(lathe([0, 0, 0], [[0.08, 0], [0.075, 0.02], [0, 0.025]], o.main));
    P.push(rod([0, 0.02, 0], [0.05, 0.25, 0], 0.008, o.trim));
    P.push(rod([0.05, 0.25, 0], [0.2, 0.33, 0], 0.008, o.trim));
    P.push(lathe([0.22, 0.27, 0], [[0.07, 0], [0.03, 0.08], [0, 0.085]], o.main));
    P.push(blob([0.22, 0.29, 0], [0.025, 0.02, 0.025], "lamp"));
    return { parts: P, label: "Lampe de bureau", anchors: { light: [0.22, 0.28, 0] }, affords: ["light"] };
  } },
  wallclock: { label: "Horloge murale", main: "white", trim: "black", build: (o) => {
    const P: PartList = [];
    // boîtier et cadran (cylindres selon z, face +z)
    P.push(rod([0, 1.6, 0], [0, 1.6, 0.035], 0.15, o.trim));
    P.push(rod([0, 1.6, 0.035], [0, 1.6, 0.04], 0.13, o.main));
    P.push(box([0.03, 1.64, 0.036], [0.005, 0.06, 0.002], o.trim, [0, 0, -30]));
    P.push(box([-0.04, 1.6, 0.043], [0.04, 0.004, 0.002], o.trim, [0, 0, 20]));
    return { parts: P, label: "Horloge murale", affords: ["look"] };
  } },
  plant: { label: "Plante d'intérieur", main: "orange", trim: "leaf", build: (o) => {
    const P: PartList = [];
    P.push(lathe([0, 0, 0], [[0.12, 0], [0.16, 0.28], [0.15, 0.3], [0, 0.28]], o.main));
    for (let i = 0; i < 9; i++) {
      const a = i * 2.4, r = 0.08 + (i % 3) * 0.05;
      P.push(rod([0, 0.28, 0], [Math.cos(a) * r, 0.5 + (i % 4) * 0.12, Math.sin(a) * r], 0.008, "leaf2"));
      P.push(blob([Math.cos(a) * r * 1.3, 0.52 + (i % 4) * 0.12, Math.sin(a) * r * 1.3], [0.08, 0.02, 0.05], o.trim));
    }
    return { parts: P, label: "Plante d'intérieur", affords: ["water"] };
  } },
  frame: { label: "Cadre", main: "wood", trim: "accent", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 1.5, 0], [0.32, 0.24, 0.015], o.main));
    P.push(box([0, 1.5, 0.016], [0.28, 0.2, 0.001], o.trim));
    P.push(box([0.05, 1.45, 0.018], [0.18, 0.06, 0.001], "green"));
    P.push(blob([-0.12, 1.6, 0.018], [0.04, 0.04, 0.001], "yellow"));
    return { parts: P, label: "Cadre", affords: ["look"] };
  } },
  mirror: { label: "Miroir", main: "wood", trim: "glass", build: (o) => {
    const P: PartList = [];
    P.push(box([0, 1.45, 0], [0.32, 0.5, 0.02], o.main, undefined, 0.02));
    P.push(box([0, 1.45, 0.021], [0.28, 0.46, 0.002], o.trim));
    return { parts: P, label: "Miroir", affords: ["look"] };
  } },
  books: { label: "Pile de livres", main: "red", trim: "paper", build: (o) => {
    const P: PartList = [];
    const cols: Role[] = ["red", "blue", "green", "yellow", "black"];
    let y = 0;
    for (let i = 0; i < 5; i++) {
      const h = 0.02 + (i % 3) * 0.008;
      P.push(box([((i * 7) % 3) * 0.01 - 0.01, y + h / 2, 0], [0.11 - (i % 2) * 0.015, h / 2, 0.075], cols[(i + o.v) % 5], [0, (i - 2) * 8, 0], 0.002));
      y += h;
    }
    return { parts: P, label: "Pile de livres", affords: ["read"] };
  } },
  /* ---------- salle de bain ---------- */
  bathtub: { label: "Baignoire", main: "white", trim: "metal", build: (o) => {
    const P: PartList = [];
    // cuve creuse (fond et quatre parois arrondies), eau à mi-hauteur, robinet au pied
    P.push(box([0, 0.06, 0], [0.38, 0.06, 0.85], o.main, undefined, 0.04));
    for (const sx of [-1, 1]) P.push(box([sx * 0.34, 0.29, 0], [0.04, 0.29, 0.85], o.main, undefined, 0.035));
    for (const sz of [-1, 1]) P.push(box([0, 0.29, sz * 0.81], [0.38, 0.29, 0.04], o.main, undefined, 0.035));
    P.push(box([0, 0.38, 0], [0.3, 0.005, 0.77], "water", undefined, 0.002));
    P.push({ t: "tube", pts: [[0, 0.58, -0.86], [0, 0.72, -0.86], [0, 0.72, -0.74]], r: 0.015, role: o.trim });
    return { parts: P, label: "Baignoire", affords: ["bathe"] };
  } },
  toilet: { label: "Toilettes", main: "white", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(lathe([0, 0, 0.05], [[0.12, 0], [0.16, 0.25], [0.19, 0.4], [0, 0.4]], o.main));
    P.push(box([0, 0.42, 0.06], [0.18, 0.02, 0.22], o.main, undefined, 0.06));
    P.push(box([0, 0.6, -0.2], [0.2, 0.2, 0.08], o.main, undefined, 0.02));
    P.push(rod([0, 0.82, -0.2], [0, 0.82, -0.15], 0.012, o.trim));
    return { parts: P, label: "Toilettes", anchors: { "sit.0": [0, 0.44, 0.05] }, affords: ["sit"] };
  } },
  sink: { label: "Lavabo", main: "white", trim: "metal", build: (o) => {
    const P: PartList = [];
    P.push(lathe([0, 0, -0.1], [[0.09, 0], [0.06, 0.05], [0.05, 0.6], [0.07, 0.72], [0, 0.72]], o.main));
    P.push(lathe([0, 0.72, 0], [[0.1, 0], [0.25, 0.12], [0.24, 0.13], [0.09, 0.03], [0, 0.03]], o.main));
    P.push({ t: "tube", pts: [[0, 0.85, -0.2], [0, 0.95, -0.2], [0, 0.95, -0.1]], r: 0.012, role: o.trim });
    return { parts: P, label: "Lavabo", affords: ["wash", "drink"] };
  } },
};

export const HOME_KINDS = Object.keys(KINDS);

export function homeModel(p: Record<string, unknown>): Built & { kind: string } {
  const kind = KINDS[String(p.kind)] ? String(p.kind) : "tv";
  const k = KINDS[kind];
  const o: O = { main: roleParam(p.color, k.main), trim: roleParam(p.color2, k.trim), v: clamp(Math.round(Number(p.variant ?? 0)) || 0, 0, 7) };
  return { ...k.build(o), kind };
}

export const home = defineGenerator({
  id: "home",
  label: "Objets du quotidien (intérieur)",
  doc: `Objets d'intérieur à taille réelle, face avant vers +z : ${HOME_KINDS.map((k) => `${k} (${KINDS[k].label.toLowerCase()})`).join(", ")}. Écrans (tv, crt, laptop, computer, phone, tablet, microwave) : ancre \`screen\` (centre, face +z) et \`extra.screen\` {w, h} pour les écrans animés. Lit et toilettes : places \`sit.0\` ; lampes : ancre \`light\` ; posés sur un meuble avec \`onTop: true\`. Paramètres : \`kind\`, \`variant\`, \`color\` (rôle principal), \`color2\` (rôle secondaire).`,
  tags: ["intérieur", "maison", "meuble", "électroménager", "électronique", "salle de bain", "cuisine", "salon", "chambre"],
  schema: {
    kind: { type: "enum", default: "tv", options: HOME_KINDS, doc: "Objet" },
    variant: { type: "int", default: 0, min: 0, max: 7, doc: "Variante (lit simple/double, couleurs)" },
    color: { type: "string", default: "auto", doc: "Rôle principal" },
    color2: { type: "string", default: "auto", doc: "Rôle secondaire" },
  },
  build(p) {
    const m = homeModel(p);
    const mesh = partsToMesh(m.parts, 1.2);
    const bb = partsBounds(m.parts);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.03);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.03);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, bb.max[1], 0], rot, scale: 1 } };
    for (const [k, v] of Object.entries(m.anchors ?? {})) anchors[k] = { pos: v, rot, scale: 1 };
    if (m.screen) anchors.screen = { pos: m.screen.c, rot, scale: 1 };
    return { generator: "home", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: Math.max(0.01, bb.max[1]), extra: { label: m.label, kind: m.kind, affords: m.affords ?? [], ...(m.screen ? { screen: m.screen } : {}) } };
  },
});
