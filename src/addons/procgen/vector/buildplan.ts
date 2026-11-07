/**
 * Plan d'un bâtiment pour le dessin vectoriel : mêmes tirages par graine que `gen/building.ts` (allure, travées,
 * étages, soubassement, porte, toit, annexes principales), recopiés ici car le générateur ne les expose pas.
 *
 * Seuls les tirages d'ordre stable sont reproduits exactement (allure et type de toit sur des sous-graines, prélude
 * du tirage principal, grange de ferme, aile ou appentis). Le recentrage de l'emprise est lu sur l'ancre `roof` de
 * l'objet composé (exact), pas recalculé.
 */
import { DEG } from "../core/math";
import { Rng } from "../core/rng";
import { ROLES } from "../style/roles";

export type WinKind = "rect" | "arch" | "segment" | "mullion" | "lancet" | "wide" | "shoji";
export type RoofMat = "tuile" | "ardoise" | "chaume" | "zinc" | "lauze" | "kawara";
export type Finish = "enduit" | "pierre" | "brique" | "bardage" | "colombages" | "shoji" | "beton";

export type Look = {
  finish: Finish;
  wall: string;
  base: string;
  trim: string;
  roofMat: RoofMat;
  roof: string;
  shutter: string;
  shutterKind: "none" | "pleins" | "persiennes";
  door: string;
  win: WinKind;
  petitsBois: boolean;
  ornament: number;
  planters: number;
  quoins: boolean;
  bands: boolean;
  modillons: boolean;
  gutters: boolean;
  genoise: boolean;
  coyau: boolean;
  pitch: number;
};

export type Annex =
  | { kind: "barn" | "wing"; cx: number; cz: number; w: number; d: number; floors: number; fh: number }
  | { kind: "shed"; cx: number; cz: number; w: number; d: number; h: number; side: number; wood: boolean; door: boolean }
  | { kind: "turret"; cx: number; cz: number; r: number; y0: number; h: number; corbel: boolean }
  | { kind: "porch"; u: number; w: number; h: number; posts: boolean }
  | { kind: "stairs"; side: number };

export type Plan = {
  st: string;
  singular: boolean;
  modern: boolean;
  bays: number;
  floors: number;
  W: number;
  D: number;
  bayWs: number[];
  fhs: number[];
  plinth: number;
  top: number;
  jet: number;
  doorBay: number;
  roof: "gable" | "hip" | "mansard" | "flat" | "shed" | "pavilion";
  ridgeZ: boolean;
  look: Look;
  shop: boolean;
  annexes: Annex[];
  /** Tirages des édifices singuliers. */
  tilt: number;
  round: boolean;
  R: number;
  crenel: boolean;
  keeper: number;
  bayX: (b: number) => number;
  floorY: (f: number) => number;
};

const N = (i: number) => ROLES[i] ?? "wall";
const R_ = { wall: 5, trim: 6, roof: 7, wood: 8, bark: 9, leaf2: 11, flower: 12, water: 13, metal: 14, cloth1: 17, cloth2: 18, cloth3: 19, accent: 26, paper: 28, path: 2, stone: 4, road: 3 };

function pickRoof(st: string, asked: string, rng: Rng, W: number, D: number): string {
  if (st === "moderne" || st === "neon") return "flat";
  if (st === "japonais") return "hip";
  if (st === "chapelle") return "gable";
  if (asked !== "auto") return asked;
  const r = rng.fork("roofkind");
  switch (st) {
    case "chalet":
      return "pignon";
    case "chateau":
      return r.pick(["hip", "mansard", "hip"]);
    case "mediterraneen":
      return r.pick(["gable", "hip", "flat", "gable"]);
    case "chaumiere":
    case "ferme":
      return r.chance(0.8) ? "gable" : "hip";
    case "boutique":
      return r.pick(["gable", "pignon", "mansard"]);
    case "vapeur":
      return r.pick(["flat", "gable"]);
    default:
      return W < 6.5 && r.chance(0.35) ? "pignon" : r.weighted([["gable", 5], ["hip", 2], ["mansard", D > 8 ? 2 : 0.5], ["pignon", 1.5]] as const);
  }
}

function pickLook(st: string, p: Record<string, unknown>, rng0: Rng): Look {
  const r = rng0.fork("look");
  const orn = Number(p.ornament ?? -1) >= 0 ? Number(p.ornament) : r.range(0, 1);
  const enduit = r.weighted([[R_.wall, 5], [R_.paper, 2], [R_.cloth3, 2], [R_.trim, 1.5], [R_.path, 1]] as const);
  const shutterColor = r.weighted([[R_.accent, 2], [R_.leaf2, 2], [R_.water, 2], [R_.wood, 2], [R_.cloth2, 1], [R_.metal, 1], [R_.paper, 0.7], [R_.cloth1, 1]] as const);
  const doorColor = r.weighted([[R_.wood, 4], [shutterColor, 3], [R_.cloth2, 1], [R_.accent, 1], [R_.leaf2, 1]] as const);
  const L = {
    finish: "enduit" as Finish, wall: enduit, base: R_.stone, trim: r.chance(0.7) ? R_.trim : R_.stone, roofMat: "tuile" as RoofMat, roof: R_.roof, shutter: shutterColor,
    shutterKind: (r.chance(0.55) ? "persiennes" : "pleins") as Look["shutterKind"], door: doorColor, win: r.weighted([["rect", 6], ["segment", 2], ["arch", 1]] as const) as WinKind,
    petitsBois: r.chance(0.55), ornament: orn, planters: r.chance(0.45) ? r.range(0.15, 0.6) : 0, quoins: r.chance(0.5), bands: r.chance(0.6), modillons: orn > 0.6, gutters: r.chance(0.7), genoise: false, coyau: r.chance(0.35), pitch: r.range(36, 46) * DEG,
  };
  switch (st) {
    case "colombages":
      Object.assign(L, { finish: "colombages", quoins: false, bands: false, pitch: r.range(48, 56) * DEG, roofMat: r.chance(0.75) ? "tuile" : "ardoise", win: "rect" });
      break;
    case "chaumiere":
      Object.assign(L, { finish: r.chance(0.6) ? "pierre" : "enduit", roofMat: "chaume", pitch: r.range(46, 52) * DEG, quoins: false, bands: false, shutterKind: "pleins", win: "rect", gutters: false, petitsBois: true });
      break;
    case "pierre":
      Object.assign(L, { finish: "pierre", wall: R_.stone, trim: R_.trim, quoins: true, roofMat: r.weighted([["tuile", 2], ["ardoise", 2], ["lauze", 1]] as const) });
      break;
    case "vapeur":
      Object.assign(L, { finish: "brique", wall: R_.roof, trim: R_.stone, roofMat: "zinc", win: r.chance(0.6) ? "segment" : "arch", shutterKind: "none", planters: 0 });
      break;
    case "moderne":
    case "neon":
      Object.assign(L, { finish: "beton", wall: R_.wall, base: R_.road, trim: R_.metal, roofMat: "zinc", shutterKind: "none", win: "wide", quoins: false, bands: false, planters: 0, gutters: false, coyau: false });
      break;
    case "ferme":
      Object.assign(L, { finish: r.chance(0.55) ? "pierre" : "enduit", pitch: r.range(34, 42) * DEG, shutterKind: "pleins", win: "rect", quoins: r.chance(0.6), bands: false, modillons: false, petitsBois: true });
      break;
    case "chalet":
      Object.assign(L, { finish: "bardage", wall: R_.wood, base: R_.stone, pitch: r.range(22, 28) * DEG, roofMat: r.chance(0.5) ? "lauze" : "ardoise", shutterKind: "pleins", win: "rect", quoins: false, bands: false, gutters: false, coyau: false, planters: r.range(0.4, 0.9), shutter: r.pick([R_.accent, R_.leaf2, R_.paper, R_.wood]) });
      break;
    case "mediterraneen":
      Object.assign(L, { wall: r.pick([R_.paper, R_.wall, R_.cloth3, R_.path, R_.flower]), pitch: r.range(20, 26) * DEG, roofMat: "tuile", shutterKind: "persiennes", genoise: true, coyau: false, gutters: false, quoins: false, bands: false, win: r.pick(["rect", "arch", "rect"]), shutter: r.pick([R_.water, R_.leaf2, R_.accent, R_.wood, R_.paper]) });
      break;
    case "japonais":
      Object.assign(L, { finish: "shoji", wall: R_.paper, base: R_.stone, trim: R_.bark, roofMat: "kawara", roof: R_.metal, shutterKind: "none", win: "shoji", door: R_.paper, quoins: false, bands: false, gutters: false, planters: 0, pitch: 30 * DEG, coyau: false });
      break;
    case "chateau":
      Object.assign(L, { finish: "pierre", wall: r.chance(0.6) ? R_.stone : R_.wall, trim: R_.trim, roofMat: "ardoise", win: "mullion", quoins: true, bands: true, pitch: r.range(52, 58) * DEG, ornament: Math.max(orn, 0.7), modillons: true, shutterKind: "none" });
      break;
    case "chapelle":
      Object.assign(L, { finish: "pierre", wall: R_.stone, trim: R_.trim, roofMat: r.chance(0.5) ? "ardoise" : "tuile", win: "lancet", quoins: true, bands: false, pitch: r.range(48, 55) * DEG, shutterKind: "none", planters: 0, coyau: false });
      break;
    case "boutique":
      Object.assign(L, { ornament: Math.max(orn, 0.4), planters: r.range(0.2, 0.7) });
      break;
    case "bourg":
      if (r.chance(0.18)) Object.assign(L, { finish: "brique", wall: R_.roof, trim: R_.trim });
      else if (r.chance(0.15)) Object.assign(L, { finish: "pierre", wall: R_.stone });
      Object.assign(L, { roofMat: r.weighted([["tuile", 7], ["ardoise", 2], ["zinc", 0.5]] as const) });
      break;
  }
  const walls = String(p.walls ?? "auto"), roofing = String(p.roofing ?? "auto");
  if (walls !== "auto") {
    L.finish = walls as Finish;
    L.wall = walls === "pierre" ? R_.stone : walls === "brique" ? R_.roof : walls === "bardage" ? R_.wood : L.wall === R_.stone || L.wall === R_.wood || L.wall === R_.roof ? R_.wall : L.wall;
  }
  if (roofing !== "auto") L.roofMat = roofing as RoofMat;
  L.roof = L.roofMat === "tuile" ? R_.roof : L.roofMat === "chaume" ? R_.path : L.roofMat === "lauze" ? R_.stone : R_.metal;
  if (L.wall === R_.roof && L.roof === R_.roof) L.roof = R_.metal;
  if (L.shutter === L.wall) L.shutter = R_.wood;
  if (Number(p.shutters ?? 0.6) <= 0) L.shutterKind = "none";
  return { ...L, wall: N(L.wall), base: N(L.base), trim: N(L.trim), roof: N(L.roof), shutter: N(L.shutter), door: N(L.door) };
}

/** Plan d'un bâtiment (paramètres résolus, graine de l'objet). */
export function buildPlan(p: Record<string, unknown>, rngIn: Rng): Plan {
  const rng = new Rng(rngIn.key);
  const st = String(p.style ?? "bourg");
  const look = pickLook(st, p, rng);
  const modern = st === "moderne" || st === "neon";
  const singular = st === "moulin" || st === "phare" || st === "tour";
  const bayBase = modern ? 3.2 : st === "chaumiere" || st === "ferme" ? 2.6 : st === "japonais" ? 1.8 : 2.7;
  const fhBase = modern ? 3.3 : st === "chaumiere" ? 2.6 : st === "japonais" ? 2.9 : st === "chateau" ? 3.6 : 3;
  const floors = st === "chapelle" ? 1 : Number(p.floors ?? 2);
  const bays = Number(p.bays ?? 3);
  let bayWs: number[] = [], fhs: number[] = [], W = 0, D = Number(p.depth ?? 7), plinth = 0.5, jet = 0, doorBay = 0, margin = 0.35;
  let roofKind = "gable";
  const plan = { st, singular, modern, bays, floors, look, shop: !!p.shop || st === "boutique", annexes: [] as Annex[], tilt: 0, round: false, R: 3, crenel: false, keeper: 1 } as Plan;
  if (singular) {
    const r = rng.fork("singular");
    if (st === "moulin") plan.tilt = r.range(0, 45) * DEG;
    else if (st === "phare") plan.keeper = r.chance(0.5) ? 1 : -1;
    else {
      plan.round = r.chance(0.5);
      plan.R = r.range(2.6, 3.4);
      plan.crenel = r.chance(0.55);
    }
  } else {
    bayWs = Array.from({ length: bays }, () => bayBase * (modern ? 1 : rng.range(0.92, 1.1)));
    margin = modern ? 0 : st === "chateau" ? 0.9 : 0.35;
    W = bayWs.reduce((s, b) => s + b, 0) + margin * 2;
    D = st === "chapelle" ? Math.max(D, W * 1.5) : D;
    fhs = Array.from({ length: floors }, (_, f) => (st === "chapelle" ? Math.max(5, W * 0.75) : fhBase * (f === 0 && (st === "bourg" || st === "boutique" || p.shop) ? 1.12 : 1) * (modern ? 1 : rng.range(0.96, 1.04))));
    plinth = modern ? 0.25 : st === "japonais" ? 0.6 : st === "chalet" || st === "ferme" ? 0.35 : rng.range(0.4, 0.65);
    jet = look.finish === "colombages" && floors > 1 && rng.chance(0.75) ? rng.range(0.22, 0.4) : 0;
    doorBay = st === "chapelle" ? Math.floor(bays / 2) : bays <= 2 ? rng.int(0, bays - 1) : rng.chance(0.55) ? Math.floor((bays - 1) / 2) + (bays % 2 === 0 && rng.chance(0.5) ? 1 : 0) : rng.pick([0, bays - 1]);
    roofKind = pickRoof(st, String(p.roof ?? "auto"), rng, W, D);
  }
  const top = plinth + fhs.reduce((s, h) => s + h, 0);
  Object.assign(plan, {
    W, D, bayWs, fhs, plinth, top, jet, doorBay,
    roof: st === "japonais" ? "pavilion" : roofKind === "pignon" ? "gable" : (roofKind as Plan["roof"]),
    ridgeZ: roofKind === "pignon" || (st === "chalet" && roofKind === "gable") || st === "chapelle",
    bayX: (b: number) => -W / 2 + margin + bayWs.slice(0, b).reduce((s, x) => s + x, 0) + bayWs[b] / 2,
    floorY: (f: number) => plinth + fhs.slice(0, f).reduce((s, h) => s + h, 0),
  });
  // annexes (ordre de tirage du générateur ; au-delà d'une aile, les tirages ne sont plus alignés : on s'arrête)
  if (!singular && !modern && st !== "chapelle" && st !== "japonais") {
    const ar = rng.fork("annexes");
    const annex = Number(p.annexes ?? 0.5);
    const side = ar.chance(0.5) ? 1 : -1;
    let aligned = true;
    if (st === "ferme" || (ar.chance(annex * 0.55) && st !== "boutique")) {
      const barn = st === "ferme";
      const ww = barn ? ar.range(4.5, 6.5) : ar.range(3, 4.2);
      const wd = barn ? D + ar.range(0, 1.5) : ar.range(D * 0.6, D * 0.95);
      const wf = Math.max(1, floors - (barn ? 0 : 1));
      const cz = barn ? -0.4 : -D / 2 + wd / 2 + ar.range(0, D - wd);
      plan.annexes.push({ kind: barn ? "barn" : "wing", cx: side * (W / 2 + ww / 2 - 0.02), cz, w: ww, d: wd, floors: wf, fh: barn ? Math.max(3.4, fhs[0] * 1.1) : fhs[0] });
      aligned = barn;
    } else if (ar.chance(annex * 0.6)) {
      const aw = ar.range(1.8, 2.8), ad = ar.range(D * 0.45, D * 0.8), ah = ar.range(2.2, 2.7);
      const cz = -D / 2 + ad / 2 + ar.range(0, D - ad);
      const wood = ar.chance(0.5);
      plan.annexes.push({ kind: "shed", cx: side * (W / 2 + aw / 2 - 0.02), cz, w: aw, d: ad, h: ah, side, wood, door: ar.chance(0.6) });
    }
    if (st === "chateau") {
      // tourelles d'angle (rayon tiré : approché quand l'aile a décalé les tirages)
      for (const sx of [-1, 1]) {
        const tr = aligned ? ar.range(1.4, 1.9) : 1.65;
        const th = top + (aligned ? ar.range(1.5, 3) : 2.2);
        plan.annexes.push({ kind: "turret", cx: sx * (W / 2 + tr * 0.35), cz: D / 2 + tr * 0.35, r: tr, y0: 0, h: th, corbel: false });
      }
    } else if (aligned && (st === "bourg" || st === "pierre") && floors >= 2 && ar.chance(annex * look.ornament * 0.5)) {
      const sx = ar.chance(0.5) ? 1 : -1;
      const tr = ar.range(0.9, 1.2);
      const y0 = plinth + fhs[0];
      plan.annexes.push({ kind: "turret", cx: sx * (W / 2 + tr * 0.2), cz: D / 2 + tr * 0.2, r: tr, y0, h: top + 0.6 - y0, corbel: true });
      aligned = false;
    }
    if (aligned && st === "mediterraneen" && floors >= 2 && ar.chance(0.4 + annex * 0.5)) plan.annexes.push({ kind: "stairs", side: -side });
    if (st === "chalet") plan.annexes.push({ kind: "porch", u: plan.bayX(doorBay), w: 1.9, h: Math.min(fhs[0] + plinth - 0.2, 3), posts: true });
  }
  return plan;
}
