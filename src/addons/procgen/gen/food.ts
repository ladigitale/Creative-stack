/**
 * Aliments et boissons à taille réelle, sur la grammaire de pièces (même modèle en 3D et en vectoriel) : chaque sorte
 * a plusieurs variantes (`variant`). Se pose sur une table, un comptoir, une étagère avec `onTop: true` (ou
 * `at: [{x, z, on: true}]`) ; ancre `top`.
 */
import { type Q, type V3, clamp } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh } from "./parts";
import { type Anchor, defineGenerator } from "./types";

export const FOOD_KINDS = [
  "burger", "soda", "pizza", "sushi", "coffee", "tea", "wine", "beer", "juice", "water", "croissant", "baguette", "cake", "icecream", "fruit", "fries",
  "hotdog", "donut", "cupcake", "sandwich", "pasta", "salad", "soup", "steak", "breakfast", "taco", "cheese", "bread", "cookies", "chocolate",
] as const;

/** Variantes de chaque sorte (index = `variant` modulo le nombre). */
export const FOOD_VARIANTS: Record<string, string[]> = {
  burger: ["classique", "cheeseburger", "double", "poulet", "végétarien"],
  soda: ["cola (canette)", "orange (canette)", "citron (canette)", "bouteille en verre", "gobelet à paille"],
  pizza: ["margherita", "pepperoni", "quatre fromages", "végétarienne", "part"],
  sushi: ["nigiris saumon", "nigiris thon", "makis", "california rolls", "plateau mixte"],
  coffee: ["expresso", "cappuccino", "mug", "gobelet à emporter", "latte en verre"],
  tea: ["tasse", "théière", "thé glacé", "thé vert (bol)"],
  wine: ["bouteille de rouge", "bouteille de blanc", "rosé", "verre de rouge", "verre de blanc", "champagne (flûte)"],
  beer: ["bouteille", "pinte", "canette", "chope"],
  juice: ["orange", "pomme", "fraise (smoothie)", "citronnade"],
  water: ["bouteille plastique", "carafe", "verre"],
  croissant: ["croissant", "pain au chocolat", "brioche"],
  baguette: ["baguette", "ficelle", "en sac"],
  cake: ["gâteau d'anniversaire", "part de gâteau", "tarte aux fraises", "forêt-noire"],
  icecream: ["cornet une boule", "cornet deux boules", "cornet trois boules", "coupe", "esquimau"],
  fruit: ["pomme", "banane", "orange", "grappe de raisin", "tranche de pastèque", "corbeille"],
  fries: ["cornet", "barquette", "frites au ketchup"],
  hotdog: ["classique", "moutarde", "chili"],
  donut: ["glacé rose", "chocolat", "sucre", "trois donuts"],
  cupcake: ["vanille", "chocolat", "fraise"],
  sandwich: ["jambon-beurre", "club", "panini"],
  pasta: ["tomate", "carbonara", "pesto"],
  salad: ["verte", "composée", "fruits"],
  soup: ["tomate", "potiron", "légumes"],
  steak: ["steak-frites", "poulet rôti", "poisson grillé"],
  breakfast: ["œufs au plat", "pancakes", "céréales", "tartines"],
  taco: ["bœuf", "poulet", "trois tacos"],
  cheese: ["plateau", "meule", "camembert"],
  bread: ["miche", "pain de mie", "corbeille de pain"],
  cookies: ["assiette de cookies", "macarons", "biscuits"],
  chocolate: ["tablette", "boîte de chocolats", "chocolat chaud"],
};

const flat = (y: number, pts: [number, number][], d: number, role: Role): Part => ({ t: "plate", c: [0, y - d, 0], pts: pts.map(([x, z]) => [x, -z] as [number, number]), d, rot: [-90, 0, 0], role });
const circle = (r: number, n = 18, cx = 0, cz = 0): [number, number][] => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cz + Math.sin((i / n) * Math.PI * 2) * r] as [number, number]);
const blob = (c: V3, r: V3, role: Role): Part => ({ t: "blob", c, r, role });
const lathe = (c: V3, profile: [number, number][], role: Role): Part => ({ t: "lathe", c, profile, role });
const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, ...(r1 !== undefined ? { r1 } : {}), role });
const box = (c: V3, h: V3, role: Role, rot?: V3, r = 0.002): Part => ({ t: "box", c, h, role, rot, r });

/** Assiette plate (bord relevé) de rayon r, posée à y ; rend la hauteur du dessus. */
function plate(P: PartList, r = 0.13, role: Role = "white", y = 0): number {
  // fond plein (disque) et bord relevé (aile) : une assiette n'est jamais creuse au milieu
  P.push(flat(y + 0.008, circle(r * 0.88, 24), 0.004, role));
  P.push(lathe([0, y, 0], [[r * 0.55, 0], [r * 0.6, 0.004], [r * 0.86, 0.006], [r, 0.02], [r * 0.97, 0.024], [r * 0.85, 0.012], [r * 0.8, 0.01]], role));
  return y + 0.012;
}
/** Bol de rayon r. */
function bowl(P: PartList, r = 0.08, role: Role = "white"): number {
  P.push(lathe([0, 0, 0], [[r * 0.45, 0], [r * 0.85, r * 0.35], [r, r * 0.7], [r * 0.94, r * 0.72], [r * 0.78, r * 0.36], [0, r * 0.12]], role));
  return r * 0.62;
}
/** Verre droit (r, h) ; rend la hauteur. */
function glass(P: PartList, r: number, h: number, fill: Role | null, level = 0.8, x = 0, z = 0): number {
  P.push(lathe([x, 0, z], [[r * 0.85, 0], [r, h], [r * 0.93, h], [r * 0.8, 0.006], [0, 0.006]], "glass"));
  if (fill) P.push(lathe([x, 0.006, z], [[r * 0.78, 0], [r * (0.8 + 0.12 * level), h * level], [0, h * level]], fill));
  return h;
}
/** Verre à pied (vin, flûte). */
function stemGlass(P: PartList, wine: Role | null, flute = false, x = 0, z = 0) {
  const r = flute ? 0.026 : 0.042, h = flute ? 0.15 : 0.11;
  P.push(lathe([x, 0, z], [[0.035, 0], [0.034, 0.004], [0.004, 0.01], [0.004, h * 0.45], [r * 0.6, h * 0.52], [r, h * 0.78], [r * 0.95, h], [r * 0.9, h], [r * 0.5, h * 0.54], [0, h * 0.5]], "glass"));
  if (wine) P.push(lathe([x, h * 0.5, z], [[0.004, 0], [r * 0.7, h * 0.08], [r * 0.9, h * (flute ? 0.38 : 0.2)], [0, h * (flute ? 0.38 : 0.2)]], wine));
}
/** Bouteille (r, h), col et bouchon. */
function bottle(P: PartList, body: Role, cap: Role, r = 0.037, h = 0.3, label: Role | null = "paper", x = 0, z = 0) {
  P.push(lathe([x, 0, z], [[r, 0], [r, h * 0.6], [r * 0.95, h * 0.68], [r * 0.38, h * 0.82], [r * 0.32, h * 0.97], [0, h * 0.97]], body));
  P.push(lathe([x, h * 0.95, z], [[r * 0.36, 0], [r * 0.36, h * 0.06], [0, h * 0.06]], cap));
  if (label) P.push(lathe([x, h * 0.2, z], [[r * 1.01, 0], [r * 1.01, h * 0.25], [0, h * 0.25]], label));
}
/** Canette. */
function can(P: PartList, body: Role, x = 0, z = 0) {
  P.push(lathe([x, 0, z], [[0.028, 0], [0.033, 0.01], [0.033, 0.105], [0.027, 0.122], [0, 0.122]], body));
  P.push(lathe([x, 0.105, z], [[0.028, 0], [0.026, 0.017], [0, 0.017]], "metal"));
}
/** Tasse à anse sur soucoupe ; rend la hauteur du bord. */
function cup(P: PartList, r: number, h: number, role: Role, drink: Role | null, saucer = true, x = 0, z = 0): number {
  const y0 = saucer ? 0.008 : 0;
  if (saucer) P.push(lathe([x, 0, z], [[0.045, 0], [0.07, 0.006], [0.072, 0.01], [0, 0.008]], role));
  P.push(lathe([x, y0, z], [[r * 0.7, 0], [r, h * 0.85], [r, h], [r * 0.92, h], [0, h * 0.1]], role));
  if (drink) P.push(lathe([x, y0 + h * 0.75, z], [[r * 0.93, 0], [0, 0.001]], drink));
  P.push({ t: "tube", pts: [[x + r * 0.95, y0 + h * 0.8, z], [x + r * 1.55, y0 + h * 0.68, z], [x + r * 1.45, y0 + h * 0.3, z], [x + r * 0.95, y0 + h * 0.22, z]], r: 0.004, role });
  return y0 + h;
}

function build(kind: string, v: number): { parts: PartList; label: string } {
  const P: PartList = [];
  const names = FOOD_VARIANTS[kind] ?? [kind];
  const vi = ((v % names.length) + names.length) % names.length;
  const label = `${kind} (${names[vi]})`;
  switch (kind) {
    case "burger": {
      const y = plate(P, 0.12, "white");
      P.push(lathe([0, y, 0], [[0.05, 0], [0.056, 0.008], [0.055, 0.018], [0, 0.018]], "orange"));
      let h = y + 0.018;
      const patty = (role: Role) => {
        P.push(lathe([0, h, 0], [[0.058, 0], [0.06, 0.007], [0.057, 0.014], [0, 0.014]], role));
        h += 0.014;
      };
      if (vi === 3) {
        P.push(blob([0, h + 0.01, 0], [0.058, 0.012, 0.052], "orange"));
        h += 0.02;
      } else patty(vi === 4 ? "green" : "bark");
      if (vi === 1 || vi === 2) {
        P.push(box([0, h + 0.002, 0], [0.05, 0.002, 0.05], "yellow", [0, 45, 0]));
        h += 0.004;
      }
      if (vi === 2) {
        patty("bark");
        P.push(box([0, h + 0.002, 0], [0.05, 0.002, 0.05], "yellow", [0, 20, 0]));
        h += 0.004;
      }
      P.push(lathe([0, h, 0], [[0.06, 0], [0.062, 0.004], [0, 0.004]], "green"));
      P.push(lathe([0, h + 0.004, 0], [[0.045, 0], [0.045, 0.006], [0, 0.006]], "red"));
      h += 0.01;
      P.push(lathe([0, h, 0], [[0.056, 0], [0.058, 0.012], [0.05, 0.03], [0.032, 0.042], [0, 0.046]], "orange"));
      for (let i = 0; i < 9; i++) {
        const a = i * 2.4, rr = 0.012 + (i % 3) * 0.012;
        P.push(blob([Math.cos(a) * rr, h + 0.043 - rr * 0.35, Math.sin(a) * rr], [0.003, 0.0015, 0.002], "white"));
      }
      break;
    }
    case "soda": {
      if (vi <= 2) can(P, (["red", "orange", "green"] as Role[])[vi]);
      else if (vi === 3) bottle(P, "glass", "red", 0.03, 0.24, "red");
      else {
        P.push(lathe([0, 0, 0], [[0.032, 0], [0.045, 0.15], [0.041, 0.15], [0, 0.01]], "red"));
        P.push(lathe([0, 0.15, 0], [[0.047, 0], [0.046, 0.008], [0, 0.012]], "white"));
        P.push(rod([0.01, 0.12, 0], [0.018, 0.22, 0.004], 0.0035, "white"));
      }
      break;
    }
    case "pizza": {
      if (vi === 4) {
        const y = plate(P, 0.12);
        P.push(flat(y + 0.006, [[0, -0.02], [0.08, 0.13], [-0.08, 0.13]], 0.005, "yellow"));
        P.push(rod([-0.085, y + 0.008, 0.13], [0.085, y + 0.008, 0.13], 0.009, "orange"));
        for (const [x, z] of [[0, 0.04], [-0.03, 0.09], [0.035, 0.1]]) P.push(flat(y + 0.0125, circle(0.012, 10, x, z), 0.0015, "red"));
        break;
      }
      P.push(lathe([0, 0, 0], [[0.18, 0], [0.18, 0.006], [0, 0.006]], "wood"));
      P.push(lathe([0, 0.006, 0], [[0.15, 0], [0.155, 0.008], [0.145, 0.016], [0.13, 0.012], [0, 0.01]], "orange"));
      P.push(flat(0.02, circle(0.128, 24), 0.003, vi === 2 ? "yellow" : "red"));
      if (vi !== 2) for (let i = 0; i < 7; i++) P.push(flat(0.0225, circle(0.025, 8, Math.cos(i * 1.9) * (0.03 + (i % 3) * 0.03), Math.sin(i * 1.9) * (0.03 + (i % 3) * 0.03)), 0.0012, "yellow"));
      const top = (n: number, role: Role, r: number, d = 0.0015) => {
        for (let i = 0; i < n; i++) {
          const a = i * 2.39996, rr = 0.025 + ((i * 37) % 10) * 0.009;
          P.push(flat(0.0245, circle(r, 10, Math.cos(a) * rr, Math.sin(a) * rr), d, role));
        }
      };
      if (vi === 0) top(6, "green", 0.01);
      if (vi === 1) top(9, "red", 0.017, 0.0022);
      if (vi === 2) top(8, "white", 0.016);
      if (vi === 3) {
        top(7, "green", 0.012);
        top(6, "black", 0.006);
        top(5, "orange", 0.01);
      }
      break;
    }
    case "sushi": {
      // planche de bois ou assiette noire rectangulaire
      P.push(box([0, 0.008, 0], [0.13, 0.008, 0.06], vi === 4 ? "black" : "wood", undefined, 0.004));
      const y = 0.016;
      const nigiri = (x: number, fish: Role) => {
        P.push(blob([x, y + 0.01, 0], [0.022, 0.011, 0.012], "white"));
        P.push(blob([x, y + 0.02, 0], [0.026, 0.005, 0.014], fish));
        if (fish === "orange") for (const k of [-1, 0, 1]) P.push(blob([x + k * 0.012, y + 0.024, 0], [0.002, 0.001, 0.012], "white"));
      };
      const maki = (x: number, z: number, inside: Role, outside: Role = "black") => {
        P.push(lathe([x, y, z], [[0.016, 0], [0.016, 0.022], [0, 0.022]], outside));
        P.push(flat(y + 0.0225, circle(0.013, 10, x, z), 0.0008, "white"));
        P.push(flat(y + 0.0235, circle(0.005, 8, x, z), 0.0008, inside));
      };
      if (vi === 0 || vi === 1) for (const x of [-0.07, 0, 0.07]) nigiri(x, vi === 0 ? "orange" : "red");
      else if (vi === 2) for (let i = 0; i < 6; i++) maki(-0.09 + i * 0.036, 0, i % 2 ? "green" : "orange");
      else if (vi === 3) for (let i = 0; i < 6; i++) maki(-0.09 + i * 0.036, 0, "orange", "white");
      else {
        nigiri(-0.08, "orange");
        nigiri(-0.025, "red");
        for (let i = 0; i < 3; i++) maki(0.03 + i * 0.034, 0.01, i % 2 ? "green" : "orange");
        P.push(blob([0.1, y + 0.006, -0.04], [0.012, 0.006, 0.01], "green"));
        P.push(blob([0.08, y + 0.005, -0.045], [0.014, 0.004, 0.012], "orange"));
      }
      break;
    }
    case "coffee": {
      if (vi === 0) cup(P, 0.03, 0.05, "white", "bark");
      else if (vi === 1) {
        const h = cup(P, 0.045, 0.065, "white", "paper");
        P.push(blob([0, h - 0.004, 0], [0.04, 0.008, 0.04], "paper"));
      } else if (vi === 2) cup(P, 0.042, 0.095, "red", "bark", false);
      else if (vi === 3) {
        P.push(lathe([0, 0, 0], [[0.03, 0], [0.042, 0.13], [0, 0.13]], "paper"));
        P.push(lathe([0, 0.035, 0], [[0.034, 0], [0.038, 0.05], [0, 0.05]], "bark"));
        P.push(lathe([0, 0.128, 0], [[0.045, 0], [0.044, 0.012], [0.03, 0.02], [0, 0.02]], "white"));
      } else {
        glass(P, 0.035, 0.12, "paper", 0.85);
        P.push(lathe([0, 0.006, 0], [[0.03, 0], [0.031, 0.05], [0, 0.05]], "bark"));
      }
      break;
    }
    case "tea": {
      if (vi === 0) cup(P, 0.04, 0.05, "white", "orange");
      else if (vi === 1) {
        P.push(lathe([0, 0, 0], [[0.05, 0], [0.075, 0.05], [0.07, 0.1], [0.03, 0.13], [0.02, 0.15], [0, 0.155]], "white"));
        P.push({ t: "tube", pts: [[0.07, 0.04, 0], [0.11, 0.08, 0], [0.13, 0.13, 0]], r: 0.009, role: "white" });
        P.push({ t: "tube", pts: [[-0.07, 0.1, 0], [-0.11, 0.09, 0], [-0.1, 0.04, 0], [-0.07, 0.03, 0]], r: 0.006, role: "white" });
      } else if (vi === 2) {
        glass(P, 0.035, 0.13, "orange", 0.75);
        for (let i = 0; i < 3; i++) P.push(box([(i - 1) * 0.012, 0.08, 0], [0.008, 0.008, 0.008], "glass", [i * 20, i * 30, 0]));
        P.push(blob([0.02, 0.12, 0], [0.012, 0.006, 0.003], "yellow"));
      } else {
        const y = bowl(P, 0.05, "green");
        P.push(flat(y - 0.003, circle(0.042, 14), 0.001, "green"));
      }
      break;
    }
    case "wine": {
      if (vi <= 2) bottle(P, (["purple", "yellow", "red"] as Role[])[vi], "black", 0.037, 0.3, "paper");
      else stemGlass(P, vi === 3 ? "purple" : vi === 4 ? "yellow" : "yellow", vi === 5);
      break;
    }
    case "beer": {
      if (vi === 0) bottle(P, "bark", "metal", 0.03, 0.23, "yellow");
      else if (vi === 1) {
        glass(P, 0.042, 0.15, "yellow", 0.85);
        P.push(blob([0, 0.138, 0], [0.042, 0.014, 0.042], "white"));
      } else if (vi === 2) can(P, "green");
      else {
        P.push(lathe([0, 0, 0], [[0.05, 0], [0.05, 0.15], [0.046, 0.15], [0.045, 0.008], [0, 0.008]], "glass"));
        P.push(lathe([0, 0.008, 0], [[0.044, 0], [0.044, 0.12], [0, 0.12]], "yellow"));
        P.push(blob([0, 0.14, 0], [0.05, 0.02, 0.05], "white"));
        P.push({ t: "tube", pts: [[0.05, 0.13, 0], [0.085, 0.12, 0], [0.085, 0.04, 0], [0.05, 0.03, 0]], r: 0.009, role: "glass" });
      }
      break;
    }
    case "juice": {
      const fill: Role = (["orange", "yellow", "red", "yellow"] as Role[])[vi];
      glass(P, 0.034, 0.13, fill, 0.82);
      P.push(rod([0.012, 0.06, 0], [0.025, 0.17, 0.005], 0.0035, vi === 2 ? "white" : "red"));
      if (vi === 0) P.push(lathe([0.034, 0.12, 0], [[0.02, 0], [0.021, 0.006], [0, 0.006]], "orange"));
      if (vi === 3) P.push(lathe([0.034, 0.12, 0], [[0.02, 0], [0.021, 0.006], [0, 0.006]], "yellow"));
      break;
    }
    case "water": {
      if (vi === 0) bottle(P, "glass", "blue", 0.035, 0.26, "blue");
      else if (vi === 1) {
        P.push(lathe([0, 0, 0], [[0.05, 0], [0.065, 0.08], [0.05, 0.17], [0.032, 0.22], [0.036, 0.25], [0, 0.25]], "glass"));
        P.push(lathe([0, 0.005, 0], [[0.048, 0], [0.062, 0.08], [0.052, 0.15], [0, 0.15]], "water"));
      } else glass(P, 0.034, 0.11, "water", 0.8);
      break;
    }
    case "croissant": {
      const y = plate(P, 0.1);
      if (vi === 0) {
        P.push({ t: "tube", pts: [[-0.07, y + 0.015, 0.03], [-0.04, y + 0.022, -0.005], [0, y + 0.026, -0.015], [0.04, y + 0.022, -0.005], [0.07, y + 0.015, 0.03]], r: 0.022, role: "orange" });
        for (const x of [-0.03, 0, 0.03]) P.push(blob([x, y + 0.03, -0.012], [0.008, 0.016, 0.022], "wood"));
      } else if (vi === 1) {
        P.push(box([0, y + 0.018, 0], [0.065, 0.017, 0.035], "orange", undefined, 0.014));
        for (const x of [-0.035, 0.035]) P.push(box([x, y + 0.02, 0], [0.007, 0.014, 0.036], "bark", undefined, 0.004));
      } else {
        P.push(blob([0, y + 0.03, 0], [0.05, 0.03, 0.05], "orange"));
        P.push(blob([0, y + 0.065, 0], [0.025, 0.02, 0.025], "orange"));
      }
      break;
    }
    case "baguette": {
      const L = vi === 1 ? 0.6 : 0.65, r = vi === 1 ? 0.022 : 0.032;
      P.push(rod([-L / 2 + r, r, 0], [L / 2 - r, r, 0], r, "orange"));
      for (let i = 0; i < 5; i++) P.push(box([-L / 2 + 0.1 + i * (L - 0.2) / 4, r * 1.9, 0], [0.04, 0.003, 0.006], "wood", [0, 30, 0]));
      if (vi === 2) P.push(box([0.12, 0.05, 0], [0.12, 0.05, 0.05], "paper", undefined, 0.01));
      break;
    }
    case "cake": {
      const y = plate(P, vi === 1 ? 0.1 : 0.15);
      if (vi === 1) {
        P.push(flat(y + 0.035, [[0, 0], [0.09, -0.04], [0.09, 0.04]], 0.0175, "wood"));
        P.push(box([0.045, y + 0.035, 0], [0.045, 0.006, 0.03], "white", [0, 0, 0]));
        P.push(blob([0.07, y + 0.05, 0], [0.012, 0.012, 0.012], "red"));
        break;
      }
      const R = vi === 2 ? 0.12 : 0.1;
      P.push(lathe([0, y, 0], [[R, 0], [R, vi === 2 ? 0.035 : 0.08], [0, vi === 2 ? 0.035 : 0.08]], vi === 3 ? "bark" : vi === 2 ? "orange" : "white"));
      const top = y + (vi === 2 ? 0.035 : 0.08);
      if (vi === 0) {
        P.push(lathe([0, top - 0.012, 0], [[R + 0.004, 0], [R + 0.004, 0.014], [0, 0.014]], "red"));
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          P.push(rod([Math.cos(a) * 0.05, top, Math.sin(a) * 0.05], [Math.cos(a) * 0.05, top + 0.055, Math.sin(a) * 0.05], 0.004, (["blue", "yellow", "green", "red", "purple", "orange"] as Role[])[i]));
          P.push(blob([Math.cos(a) * 0.05, top + 0.064, Math.sin(a) * 0.05], [0.004, 0.009, 0.004], "fire"));
        }
      } else if (vi === 2) for (let i = 0; i < 12; i++) P.push(blob([Math.cos(i * 2.4) * (0.03 + (i % 3) * 0.03), top + 0.012, Math.sin(i * 2.4) * (0.03 + (i % 3) * 0.03)], [0.015, 0.014, 0.012], "red"));
      else {
        P.push(blob([0, top, 0], [R * 0.95, 0.015, R * 0.95], "white"));
        for (let i = 0; i < 8; i++) P.push(blob([Math.cos(i * 0.785) * R * 0.75, top + 0.02, Math.sin(i * 0.785) * R * 0.75], [0.011, 0.011, 0.011], "red"));
      }
      break;
    }
    case "icecream": {
      const flav: Role[] = ["paper", "bark", "red", "green", "yellow"];
      if (vi <= 2) {
        P.push(lathe([0, 0, 0], [[0.004, 0], [0.032, 0.12], [0, 0.12]], "orange"));
        for (let k = 0; k <= vi; k++) P.push(blob([0, 0.13 + k * 0.045, 0], [0.034, 0.03, 0.034], flav[(k * 2) % flav.length]));
      } else if (vi === 3) {
        P.push(lathe([0, 0, 0], [[0.03, 0], [0.012, 0.03], [0.05, 0.08], [0, 0.07]], "glass"));
        for (let k = 0; k < 3; k++) P.push(blob([Math.cos(k * 2.1) * 0.022, 0.09, Math.sin(k * 2.1) * 0.022], [0.028, 0.025, 0.028], flav[k + 1]));
        P.push(box([0.02, 0.13, 0], [0.004, 0.025, 0.012], "orange", [0, 0, 20]));
      } else {
        // esquimau couché sur son bâton
        P.push(box([0, 0.012, 0.02], [0.025, 0.012, 0.045], "bark", undefined, 0.01));
        P.push(box([0, 0.004, -0.045], [0.006, 0.003, 0.03], "wood"));
      }
      break;
    }
    case "fruit": {
      if (vi === 0) {
        P.push(blob([0, 0.035, 0], [0.038, 0.036, 0.038], "red"));
        P.push(rod([0, 0.068, 0], [0.004, 0.085, 0], 0.002, "bark"));
        P.push(blob([0.012, 0.08, 0], [0.012, 0.003, 0.006], "green"));
      } else if (vi === 1) P.push({ t: "tube", pts: [[-0.08, 0.03, 0], [-0.04, 0.018, 0.01], [0.02, 0.018, 0.012], [0.07, 0.035, 0]], r: 0.017, role: "yellow" });
      else if (vi === 2) P.push(blob([0, 0.036, 0], [0.037, 0.035, 0.037], "orange"));
      else if (vi === 3) {
        for (let i = 0; i < 14; i++) P.push(blob([Math.cos(i * 2.4) * (i % 4) * 0.009, 0.015 + (i % 5) * 0.012, Math.sin(i * 2.4) * (i % 4) * 0.009 + 0.0], [0.011, 0.012, 0.011], "purple"));
        P.push(rod([0, 0.07, 0], [0.005, 0.085, 0], 0.002, "bark"));
      } else if (vi === 4) {
        P.push({ t: "plate", c: [0, 0.05, 0], pts: [[-0.1, 0], [0.1, 0], [0, 0.085]], d: 0.015, rot: [0, 0, 0], role: "red" });
        P.push({ t: "plate", c: [0, 0.042, 0], pts: [[-0.11, -0.012], [0.11, -0.012], [0, -0.005]], d: 0.016, rot: [0, 0, 0], role: "green" });
        for (const x of [-0.04, 0, 0.04]) P.push(blob([x, 0.075, 0.016], [0.003, 0.005, 0.002], "black"));
      } else {
        const y = bowl(P, 0.12, "wood");
        P.push(blob([-0.04, y + 0.02, 0], [0.035, 0.034, 0.035], "red"));
        P.push(blob([0.035, y + 0.02, 0.02], [0.035, 0.034, 0.035], "orange"));
        P.push({ t: "tube", pts: [[-0.05, y + 0.05, -0.04], [0, y + 0.045, -0.035], [0.06, y + 0.06, -0.03]], r: 0.016, role: "yellow" });
      }
      break;
    }
    case "fries": {
      const red = vi === 2;
      if (vi === 1) P.push(box([0, 0.02, 0], [0.06, 0.02, 0.04], "white", undefined, 0.005));
      else P.push(lathe([0, 0, 0], [[0.03, 0], [0.045, 0.1], [0, 0.1]], "red"));
      const y0 = vi === 1 ? 0.03 : 0.08;
      for (let i = 0; i < 14; i++) {
        const a = i * 2.4, r = (i % 4) * 0.009;
        P.push(box([Math.cos(a) * r, y0 + 0.02 + (i % 3) * 0.01, Math.sin(a) * r], [0.004, 0.035, 0.004], "yellow", [(i % 5 - 2) * 8, a * 30, (i % 3 - 1) * 10]));
      }
      if (red) P.push(blob([0.02, y0 + 0.055, 0], [0.025, 0.006, 0.02], "red"));
      break;
    }
    case "hotdog": {
      const y = plate(P, 0.11, "white");
      P.push(rod([-0.075, y + 0.018, 0], [0.075, y + 0.018, 0], 0.024, "orange"));
      P.push(rod([-0.085, y + 0.034, 0], [0.085, y + 0.034, 0], 0.012, "red"));
      P.push({ t: "tube", pts: [[-0.06, y + 0.048, 0], [-0.02, y + 0.05, 0.004], [0.02, y + 0.048, -0.004], [0.06, y + 0.05, 0]], r: 0.004, role: vi === 2 ? "bark" : "yellow" });
      break;
    }
    case "donut": {
      const one = (x: number, z: number, glaze: Role) => {
        P.push(lathe([x, 0, z], [[0.018, 0.01], [0.022, 0.024], [0.04, 0.03], [0.05, 0.016], [0.04, 0.002], [0.022, 0.004], [0.018, 0.01]], "orange"));
        if (glaze !== "orange") P.push(lathe([x, 0.016, z], [[0.02, 0.01], [0.04, 0.016], [0.051, 0.002], [0.05, 0], [0.02, 0.008]], glaze));
        if (glaze === "red") for (let i = 0; i < 8; i++) P.push(box([x + Math.cos(i * 0.8) * 0.034, 0.033, z + Math.sin(i * 0.8) * 0.034], [0.005, 0.0015, 0.0015], (["yellow", "blue", "white", "green"] as Role[])[i % 4], [0, i * 50, 0]));
      };
      if (vi === 3) {
        plate(P, 0.15);
        one(-0.055, 0.02, "red");
        one(0.055, 0.02, "bark");
        one(0, -0.06, "white");
      } else one(0, 0, (["red", "bark", "white"] as Role[])[vi]);
      break;
    }
    case "cupcake": {
      P.push(lathe([0, 0, 0], [[0.024, 0], [0.032, 0.04], [0, 0.04]], "paper"));
      const icing: Role = (["white", "bark", "red"] as Role[])[vi];
      P.push(lathe([0, 0.04, 0], [[0.035, 0], [0.03, 0.02], [0.018, 0.035], [0.006, 0.048], [0, 0.05]], icing));
      P.push(blob([0, 0.095, 0], [0.008, 0.008, 0.008], "red"));
      break;
    }
    case "sandwich": {
      const y = plate(P, 0.12);
      const layer = (h: number, role: Role, s = 1) => P.push({ t: "plate", c: [0, y + h, 0], pts: [[-0.06 * s, -0.04 * s], [0.06 * s, -0.04 * s], [0, 0.06 * s]], d: 0.007, rot: [-90, 0, 0], role });
      if (vi === 0) {
        P.push(rod([-0.1, y + 0.025, 0], [0.1, y + 0.025, 0], 0.025, "orange"));
        P.push(rod([-0.095, y + 0.03, 0.002], [0.095, y + 0.03, 0.002], 0.019, "red"));
      } else {
        layer(0.008, vi === 2 ? "wood" : "paper");
        layer(0.018, "red", 0.97);
        layer(0.026, "green", 1.02);
        layer(0.034, "yellow", 0.96);
        layer(0.044, vi === 2 ? "wood" : "paper");
      }
      break;
    }
    case "pasta": {
      const y = plate(P, 0.13);
      P.push(blob([0, y + 0.018, 0], [0.075, 0.022, 0.07], "yellow"));
      for (let i = 0; i < 10; i++) P.push({ t: "tube", pts: [[Math.cos(i) * 0.05, y + 0.03, Math.sin(i) * 0.05], [Math.cos(i + 1) * 0.03, y + 0.036, Math.sin(i + 1) * 0.03], [Math.cos(i + 2.4) * 0.05, y + 0.032, Math.sin(i + 2.4) * 0.05]], r: 0.003, role: "yellow" });
      P.push(blob([0, y + 0.04, 0], [0.04, 0.008, 0.036], vi === 0 ? "red" : vi === 1 ? "paper" : "green"));
      if (vi === 2) P.push(blob([0.02, y + 0.048, 0], [0.01, 0.003, 0.006], "green"));
      break;
    }
    case "salad": {
      const y = bowl(P, 0.09, "white");
      const n = 16;
      for (let i = 0; i < n; i++) {
        const role: Role = vi === 2 ? (["red", "orange", "yellow", "green", "purple"] as Role[])[i % 5] : vi === 1 && i % 4 === 0 ? (["red", "yellow", "orange"] as Role[])[i % 3] : i % 2 ? "green" : "leaf";
        P.push(blob([Math.cos(i * 2.4) * (i % 4) * 0.016, y + 0.01 + (i % 3) * 0.006, Math.sin(i * 2.4) * (i % 4) * 0.016], [0.018, 0.006, 0.014], role));
      }
      break;
    }
    case "soup": {
      const y = bowl(P, 0.08, "white");
      P.push(flat(y - 0.006, circle(0.068, 16), 0.002, (["red", "orange", "yellow"] as Role[])[vi]));
      if (vi === 2) for (let i = 0; i < 6; i++) P.push(box([Math.cos(i) * 0.03, y - 0.002, Math.sin(i) * 0.03], [0.006, 0.003, 0.006], (["green", "orange"] as Role[])[i % 2]));
      P.push(rod([0.02, y, 0.02], [0.11, y + 0.06, 0.06], 0.004, "metal"));
      break;
    }
    case "steak": {
      const y = plate(P, 0.14);
      if (vi === 0) {
        P.push(blob([-0.03, y + 0.012, 0], [0.06, 0.012, 0.045], "bark"));
        for (let i = 0; i < 10; i++) P.push(box([0.06 + (i % 3) * 0.008, y + 0.008 + (i % 2) * 0.006, -0.04 + i * 0.008], [0.004, 0.004, 0.03], "yellow", [0, i * 9, 0]));
      } else if (vi === 1) {
        P.push(blob([0, y + 0.035, 0], [0.07, 0.04, 0.05], "orange"));
        for (const sx of [-1, 1]) P.push(rod([sx * 0.04, y + 0.03, 0.04], [sx * 0.06, y + 0.04, 0.08], 0.012, "orange"));
      } else {
        P.push(blob([0, y + 0.012, 0], [0.09, 0.012, 0.035], "white"));
        P.push({ t: "plate", c: [0.09, y + 0.012, 0], pts: [[0, 0], [0.035, 0.025], [0.035, -0.025]], d: 0.006, rot: [-90, 0, 0], role: "white" });
        P.push(blob([-0.04, y + 0.03, 0.04], [0.02, 0.006, 0.014], "yellow"));
      }
      break;
    }
    case "breakfast": {
      const y = plate(P, 0.13);
      if (vi === 0) {
        for (const x of [-0.035, 0.035]) {
          P.push(flat(y + 0.003, circle(0.04, 14, x, 0), 0.002, "white"));
          P.push(blob([x, y + 0.008, 0], [0.016, 0.008, 0.016], "orange"));
        }
        P.push(box([0, y + 0.006, 0.06], [0.06, 0.004, 0.012], "red", [0, 10, 0]));
      } else if (vi === 1) {
        for (let k = 0; k < 4; k++) P.push(lathe([0, y + k * 0.012, 0], [[0.06, 0], [0.062, 0.006], [0.058, 0.012], [0, 0.012]], "orange"));
        P.push(blob([0, y + 0.05, 0], [0.04, 0.006, 0.04], "bark"));
        P.push(box([0, y + 0.058, 0], [0.012, 0.006, 0.012], "yellow"));
      } else if (vi === 2) {
        const yb = bowl(P, 0.075, "blue");
        P.push(flat(yb - 0.006, circle(0.064, 14), 0.002, "white"));
        for (let i = 0; i < 14; i++) P.push(blob([Math.cos(i * 2.4) * (i % 4) * 0.014, yb - 0.002, Math.sin(i * 2.4) * (i % 4) * 0.014], [0.008, 0.003, 0.008], "orange"));
      } else {
        for (const x of [-0.04, 0.04]) {
          P.push(box([x, y + 0.008, 0], [0.035, 0.007, 0.045], "orange", [0, x > 0 ? 8 : -6, 0], 0.004));
          P.push(box([x, y + 0.016, 0], [0.03, 0.002, 0.04], x > 0 ? "red" : "yellow", [0, x > 0 ? 8 : -6, 0]));
        }
      }
      break;
    }
    case "taco": {
      const one = (x: number, fill: Role) => {
        P.push({ t: "lathe", c: [x, 0.045, 0], profile: [[0.002, -0.045], [0.04, -0.03], [0.05, 0], [0.045, 0.004]], role: "yellow" });
        P.push(blob([x, 0.03, 0], [0.012, 0.022, 0.04], fill));
        P.push(blob([x, 0.05, 0.005], [0.008, 0.008, 0.035], "green"));
        P.push(blob([x, 0.052, -0.01], [0.006, 0.005, 0.02], "red"));
      };
      if (vi === 2) for (const x of [-0.05, 0, 0.05]) one(x, (["bark", "orange", "bark"] as Role[])[(x * 20 + 1) | 0] ?? "bark");
      else one(0, vi === 0 ? "bark" : "orange");
      break;
    }
    case "cheese": {
      if (vi === 0) {
        P.push(box([0, 0.01, 0], [0.16, 0.01, 0.1], "wood", undefined, 0.004));
        P.push({ t: "plate", c: [-0.06, 0.02, 0], pts: [[0, 0], [0.07, 0.04], [0.07, -0.04]], d: 0.025, rot: [-90, 0, 0], role: "yellow" });
        P.push(lathe([0.05, 0.02, -0.02], [[0.045, 0], [0.045, 0.03], [0, 0.03]], "paper"));
        P.push(box([0.06, 0.035, 0.05], [0.035, 0.015, 0.02], "orange", [0, 15, 0], 0.003));
        P.push(blob([-0.1, 0.04, 0.06], [0.012, 0.012, 0.012], "purple"));
      } else if (vi === 1) P.push(lathe([0, 0, 0], [[0.18, 0], [0.19, 0.04], [0.18, 0.09], [0, 0.09]], "yellow"));
      else P.push(lathe([0, 0, 0], [[0.055, 0], [0.056, 0.03], [0, 0.032]], "paper"));
      break;
    }
    case "bread": {
      if (vi === 0) P.push(blob([0, 0.05, 0], [0.11, 0.055, 0.09], "orange"));
      else if (vi === 1) P.push(box([0, 0.055, 0], [0.11, 0.055, 0.06], "wood", undefined, 0.02));
      else {
        const y = bowl(P, 0.12, "wood");
        for (let i = 0; i < 5; i++) P.push(box([Math.cos(i * 1.3) * 0.04, y + 0.015, Math.sin(i * 1.3) * 0.04], [0.04, 0.008, 0.025], "orange", [i * 12, i * 40, 0], 0.006));
      }
      break;
    }
    case "cookies": {
      const y = plate(P, 0.12);
      if (vi === 1) for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2, x = Math.cos(a) * 0.06, z = Math.sin(a) * 0.06;
        const c: Role = (["red", "green", "yellow", "purple", "orange", "bark"] as Role[])[i];
        P.push(lathe([x, y, z], [[0.02, 0], [0.021, 0.006], [0, 0.007]], c));
        P.push(lathe([x, y + 0.007, z], [[0.017, 0], [0, 0.003]], "white"));
        P.push(lathe([x, y + 0.01, z], [[0.02, 0], [0.021, 0.005], [0, 0.007]], c));
      }
      else for (let i = 0; i < 5; i++) {
        const a = i * 1.25, x = Math.cos(a) * 0.05 * (i ? 1 : 0), z = Math.sin(a) * 0.05 * (i ? 1 : 0);
        P.push(lathe([x, y + (i ? 0 : 0.01), z], [[0.035, 0], [0.036, 0.006], [0, 0.009]], vi === 2 ? "wood" : "orange"));
        if (vi === 0) for (let k = 0; k < 4; k++) P.push(blob([x + Math.cos(k * 1.7) * 0.018, y + 0.01 + (i ? 0 : 0.01), z + Math.sin(k * 1.7) * 0.018], [0.004, 0.003, 0.004], "bark"));
      }
      break;
    }
    case "chocolate": {
      if (vi === 0) {
        P.push(box([0, 0.006, 0], [0.08, 0.006, 0.04], "bark", undefined, 0.002));
        for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) P.push(box([-0.06 + i * 0.04, 0.013, -0.02 + j * 0.04], [0.017, 0.002, 0.017], "bark", undefined, 0.002));
        P.push(box([0.04, 0.007, 0], [0.042, 0.0075, 0.041], "red"));
      } else if (vi === 1) {
        P.push(box([0, 0.012, 0], [0.1, 0.012, 0.07], "red", undefined, 0.006));
        for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) P.push(blob([-0.06 + i * 0.04, 0.03, -0.04 + j * 0.04], [0.014, 0.008, 0.014], i % 2 ? "bark" : "black"));
      } else {
        cup(P, 0.042, 0.09, "white", "bark", true);
        P.push(blob([0, 0.095, 0], [0.036, 0.008, 0.036], "white"));
      }
      break;
    }
  }
  return { parts: P, label };
}

export function foodModel(p: Record<string, unknown>): { parts: PartList; label: string; kind: string } {
  const kind = (FOOD_KINDS as readonly string[]).includes(String(p.kind)) ? String(p.kind) : "burger";
  const v = clamp(Math.round(Number(p.variant ?? 0)) || 0, 0, 9);
  return { ...build(kind, v), kind };
}

export const food = defineGenerator({
  id: "food",
  label: "Aliments et boissons",
  doc: `Aliments et boissons à taille réelle, plusieurs variantes chacun (\`variant\`) : ${FOOD_KINDS.map((k) => `${k} (${FOOD_VARIANTS[k].join(", ")})`).join(" ; ")}. Se posent sur une table, un comptoir, une étagère avec \`onTop: true\` sur le calque (ou \`at: [{x, z, on: true}]\`). Ancre \`top\`.`,
  tags: ["nourriture", "boisson", "café", "restaurant", "cuisine", "table", "repas"],
  schema: {
    kind: { type: "enum", default: "burger", options: FOOD_KINDS, doc: "Aliment ou boisson" },
    variant: { type: "int", default: 0, min: 0, max: 9, doc: "Variante (voir la liste de chaque sorte)" },
  },
  build(p) {
    const m = foodModel(p);
    const mesh = partsToMesh(m.parts, 1.6);
    const bb = partsBounds(m.parts);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.02);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.02);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, bb.max[1], 0], rot, scale: 1 } };
    return { generator: "food", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: Math.max(0.01, bb.max[1]), extra: { label: m.label, kind: m.kind, affords: ["eat", "drink", "carry"] } };
  },
});
