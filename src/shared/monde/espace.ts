/**
 * Espace d'un « monde » : une pièce ou une parcelle décrite par son contour, ses bords (murs, clôtures) percés
 * d'ouvertures, ses zones de sol et son plafond.
 *
 * ```json
 * { "unite": "cm",
 *   "espace": {
 *     "contour": [[0, 0], [420, 0], [420, 310], [0, 310]], "hauteur": 250,
 *     "bords": [ { "couleur": "#f4f1ea" },
 *                { "bord": 1, "ouvertures": [ { "type": "fenetre", "at": 150, "largeur": 120, "hauteur": 125, "allege": 90 } ] } ],
 *     "zones": [ { "nom": "plancher", "revetement": "parquet" } ] } }
 * ```
 *
 * Par défaut un mur n'a qu'une face, tournée vers la pièce : de dehors on voit à travers, la pièce se regarde de tous
 * les côtés comme une maquette. `"murs": "pleins"` donne des murs épais, opaques des deux côtés.
 *
 * Ce fichier est une passe sur le JSON d'entrée : l'espace devient des modèles ordinaires (`espace:…`) et des
 * placements nommés (`mur0`, `mur1`…, `plafond`, le nom de chaque zone, `fenetre0`, `porte0`…), que le reste de la
 * chaîne lit comme les autres. Chaque mur est un appui vertical (`on: "mur1", at: [200, 150]`), le plafond un appui
 * par-dessous, chaque zone un appui au sol : la pose (supports.ts) fait le reste.
 *
 * Les longueurs s'écrivent dans l'unité du document (`unite`).
 */
import { inPolygon } from "./supports";

type Obj = Record<string, unknown>;
export type EspaceIssue = { path: string; message: string };

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown, d: number) => (fin(v) ? v : d);
const isHex = (v: unknown): v is string => typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
const clean = (s: string) => s.replace(/[^\w-]/g, "");
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const DEG = 180 / Math.PI;

/** Revêtements de sol : couleur et texture (toute zone peut les remplacer par `couleur` et `tex`). */
export const REVETEMENTS: Record<string, { color: string; tex?: unknown }> = {
  parquet: { color: "#b98a56", tex: "parquet" },
  chevron: { color: "#b98a56", tex: "chevron" },
  "baton-rompu": { color: "#b98a56", tex: "chevron" },
  moquette: { color: "#9aa3ad", tex: "moquette" },
  carrelage: { color: "#e3e0d8", tex: "carrelage" },
  beton: { color: "#a9aaa6", tex: "beton" },
  lino: { color: "#cfc8b8" },
  gazon: { color: "#6b8f4e", tex: "herbe" },
  pelouse: { color: "#6b8f4e", tex: "herbe" },
  dalles: { color: "#bdb7aa", tex: "dalles" },
  terrasse: { color: "#a9825a", tex: { kind: "rayures", scale: 7, contrast: 0.35 } },
  gravier: { color: "#c9c2b4", tex: "gravier" },
  paillis: { color: "#7a5236", tex: "paillis" },
  terre: { color: "#6f4e37", tex: "bruit" },
  sable: { color: "#e2cf9f", tex: "grain" },
  eau: { color: "#4aa3c7", tex: "nuages" },
};

/** Clôtures de jardin : types du générateur procgen `wall`. */
const CLOTURES = ["drystone", "coping", "fence", "picket", "hedge", "railing", "bamboo"];
const ALIAS_CLOTURE: Record<string, string> = { haie: "hedge", cloture: "fence", palissade: "picket", muret: "coping", "pierre-seche": "drystone", grille: "railing", bambou: "bamboo" };

type Opening = { x0: number; x1: number; y0: number; y1: number; raw: Obj; model: string; path: string };

/**
 * Transforme `espace` en modèles et placements. `unit` : facteur de l'unité du document vers le mètre (0,01 pour des
 * centimètres). Ne lève jamais ; sans `espace`, rend l'entrée telle quelle.
 */
export function expandEspace<T extends { espace?: unknown; models?: unknown; place?: unknown }>(src: T, issues: EspaceIssue[], unit: number): T {
  const e = src.espace;
  if (!isObj(e)) return src;
  /** Longueur donnée en mètres, dans l'unité du document. */
  const U = (m: number) => m / unit;
  const pts = (Array.isArray(e.contour) ? e.contour : []).filter((q): q is number[] => Array.isArray(q) && q.length >= 2 && fin(q[0]) && fin(q[1])).map((q) => [q[0], q[1]]);
  if (pts.length < 3) {
    issues.push({ path: "espace.contour", message: "au moins 3 points [x, z]" });
    return src;
  }
  if (pts.length > 60) {
    issues.push({ path: "espace.contour", message: "plus de 60 points : la suite est ignorée" });
    pts.length = 60;
  }
  const models: Obj = {};
  const userModels = isObj(src.models) ? src.models : {};
  const place: Obj[] = [];
  const names = new Set<string>();
  const unique = (base: string) => {
    let n = clean(base) || "zone";
    while (names.has(n)) n += "_";
    names.add(n);
    return n;
  };
  const height = fin(e.hauteur) && e.hauteur > 0 ? e.hauteur : 0;
  /** Murs pleins (boîtes, opaques de dehors) au lieu de faces tournées vers l'intérieur. */
  const solid = e.murs === "pleins";

  /* ---------------------------------------------------------------- zones de sol */

  const slab = (contour: number[][], y: number, look: { color: string; tex?: unknown }, surface: Obj): Obj => ({
    // extrusion du contour (x, z) couchée à plat : son épaisseur est verticale, sa texture court sur le sol
    parts: [{ name: "dalle", extrude: { pts: contour, depth: U(0.02) }, rot: [90, 0, 0], at: [0, y, 0], color: look.color, ...(look.tex !== undefined ? { tex: look.tex } : {}), surface }],
  });
  const zones = (Array.isArray(e.zones) ? e.zones : []).filter(isObj).slice(0, 24);
  if (!zones.some((z) => !Array.isArray(z.contour))) zones.unshift({ nom: "plancher", couleur: "#d9d2c5" });
  zones.forEach((z, i) => {
    const path = `espace.zones.${i}`;
    const own = Array.isArray(z.contour) ? z.contour.filter((q): q is number[] => Array.isArray(q) && q.length >= 2 && fin(q[0]) && fin(q[1])).map((q) => [q[0], q[1]]).slice(0, 60) : null;
    const contour = own && own.length >= 3 ? own : pts;
    const rev = typeof z.revetement === "string" ? z.revetement : "";
    const base = has(REVETEMENTS, rev) ? REVETEMENTS[rev] : null;
    if (rev && !base) issues.push({ path: `${path}.revetement`, message: `revêtement inconnu « ${rev} » (${Object.keys(REVETEMENTS).join(", ")})` });
    const look = { color: isHex(z.couleur) ? z.couleur : (base?.color ?? "#d9d2c5"), tex: z.tex !== undefined ? z.tex : base?.tex };
    const name = unique(typeof z.nom === "string" && z.nom ? z.nom : `zone${i}`);
    // chaque zone affleure un peu au-dessus de la précédente : pas de scintillement entre deux sols superposés
    models[`espace:zone_${name}`] = slab(contour, U(-0.01 + i * 0.003), look, { name: "top", from: "origine" });
    place.push({ model: `espace:zone_${name}`, name, shadow: false });
    // peuplement de la zone (massif, pelouse semée d'arbustes…)
    (Array.isArray(z.layers) ? z.layers : []).filter(isObj).slice(0, 12).forEach((l, j) => {
      if (typeof l.model !== "string") return;
      const cell = Math.max(U(0.05), num(l.cell, U(1)));
      const area = Math.abs(polygonArea(contour));
      const n = fin(l.count) ? l.count : Math.round((area / (cell * cell)) * Math.max(0, Math.min(1, num(l.density, 1))));
      const { cell: _c, density: _d, count: _n, ...rest } = l;
      place.push({ on: "sol", seed: `${name}/${j}`, spacing: 0, ...rest, scatter: Math.max(0, Math.min(2000, n)), within: contour });
    });
  });

  /* ---------------------------------------------------------------- bords */

  const bords = (Array.isArray(e.bords) ? e.bords : []).filter(isObj);
  const common: Obj = Object.assign({}, ...bords.filter((b) => !fin(b.bord)));
  const counters: Record<string, number> = {};
  const builtin = builtinOpenings(U);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const spec: Obj = { ...common, ...Object.assign({}, ...bords.filter((x) => x.bord === i)) };
    const path = `espace.bords[${i}]`;
    let type = typeof spec.type === "string" ? spec.type : height ? "mur" : "aucun";
    if (type.startsWith("wall.")) type = type.slice(5);
    if (has(ALIAS_CLOTURE, type)) type = ALIAS_CLOTURE[type];
    if (type === "aucun" || type === "none") continue;
    // normale tournée vers l'intérieur : le mur se lit de l'intérieur, sa face d'appui regarde la pièce
    const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    let nx = -dz, nz = dx;
    if (!inPolygon(mx + nx * L * 1e-3, mz + nz * L * 1e-3, pts)) [nx, nz] = [-nx, -nz];
    const yaw = Math.atan2(nx, nz);
    // repère du mur : x le long du mur, de gauche à droite pour qui le regarde de l'intérieur ; z vers l'intérieur
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const toWorld = (x: number, z: number): [number, number] => [mx + x * lx + z * nx, mz + x * lz + z * nz];
    const H = fin(spec.hauteur) && spec.hauteur > 0 ? spec.hauteur : height || U(type === "mur" ? 2.5 : 1.2);
    const T = fin(spec.epaisseur) && spec.epaisseur > 0 ? spec.epaisseur : U(0.1);

    // ouvertures, de gauche à droite
    const openings: Opening[] = [];
    (Array.isArray(spec.ouvertures) ? spec.ouvertures : []).filter(isObj).slice(0, 12).forEach((o, j) => {
      const op = `${path}.ouvertures.${j}`;
      const kind = typeof o.type === "string" ? o.type : "";
      const model = typeof o.model === "string" ? o.model : kind;
      const def = isObj(userModels[model]) ? (userModels[model] as Obj) : has(builtin, model) ? builtin[model] : null;
      if (!def) {
        issues.push({ path: op, message: `ouverture sans modèle connu (« ${model} ») : model d'un modèle du monde, ou type ${Object.keys(builtin).join(", ")}` });
        return;
      }
      const given = isObj(o.params) ? o.params : {};
      const declared = (k: string) => (isObj(def.params) && has(def.params, k) ? (isObj((def.params as Obj)[k]) ? ((def.params as Obj)[k] as Obj).default : (def.params as Obj)[k]) : undefined);
      const w = num(o.largeur, num(given.largeur, num(declared("largeur"), U(0.9))));
      const h = num(o.hauteur, num(given.hauteur, num(declared("hauteur"), U(2))));
      const sill = Math.max(0, num(o.allege, model === "fenetre" ? U(0.9) : 0));
      const c = -L / 2 + num(o.at, L / 2);
      const x0 = Math.max(-L / 2, c - w / 2), x1 = Math.min(L / 2, c + w / 2);
      if (x1 - x0 < w - 1e-6) issues.push({ path: op, message: "ouverture plus large que la place disponible sur ce bord : rognée" });
      if (openings.some((q) => x0 < q.x1 && x1 > q.x0)) {
        issues.push({ path: op, message: "ouverture qui en chevauche une autre : ignorée" });
        return;
      }
      openings.push({ x0, x1, y0: Math.min(sill, H), y1: Math.min(sill + h, H), raw: o, model, path: op });
    });
    openings.sort((p, q) => p.x0 - q.x0);

    const wallName = unique(`mur${i}`);
    if (type === "mur") {
      const look: Obj = isHex(spec.couleur) ? { color: spec.couleur } : typeof spec.matiere === "string" ? { matiere: spec.matiere } : { color: "#f4f1ea" };
      if (spec.tex !== undefined) look.tex = spec.tex;
      const face = { name: "top", face: "+z", from: "coin" };
      const parts: Obj[] = [];
      const piece = (x0: number, x1: number, y0: number, y1: number) => {
        if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return;
        const pan = { name: `pan${parts.length}`, surface: face, ...look };
        // mur « intérieur » : une face tournée vers la pièce, invisible de dehors (on voit dans la pièce de partout)
        if (solid) parts.push({ ...pan, box: [x1 - x0, y1 - y0, T], at: [(x0 + x1) / 2, (y0 + y1) / 2, -T / 2] });
        else parts.push({ ...pan, plane: [x1 - x0, y1 - y0], rot: [90, 0, 0], at: [(x0 + x1) / 2, (y0 + y1) / 2, 0] });
      };
      let cursor = -L / 2;
      for (const o of openings) {
        piece(cursor, o.x0, 0, H);
        piece(o.x0, o.x1, 0, o.y0);
        piece(o.x0, o.x1, o.y1, H);
        cursor = o.x1;
      }
      piece(cursor, L / 2, 0, H);
      if (solid) {
        // angle : chaque mur déborde de son épaisseur à droite (un seul poteau par angle, hors de la face d'appui)
        parts.push({ name: "angle", box: [T, H, T], at: [L / 2 + T / 2, H / 2, -T / 2], ...look });
      } else {
        // chant du mur : son épaisseur se lit d'en haut (et dessine le mur sur un plan)
        parts.push({ name: "chant", plane: [L + T, T], at: [T / 2, H, -T / 2], color: "#8a8f98" });
      }
      models[`espace:${wallName}`] = { parts };
      place.push({ model: `espace:${wallName}`, name: wallName, at: [mx, 0, mz], rot: [0, yaw * DEG, 0], shadow: false });
    } else if (CLOTURES.includes(type)) {
      // clôture procgen le long du bord, interrompue aux ouvertures (points en mètres, le générateur ne connaît que le mètre)
      let cursor = -L / 2;
      const runs: [number, number][] = [];
      for (const o of openings) {
        runs.push([cursor, o.x0]);
        cursor = o.x1;
      }
      runs.push([cursor, L / 2]);
      runs.filter(([p, q]) => q - p > U(0.05)).forEach(([p, q], k) => {
        const [ax, az] = toWorld(p, 0), [bx, bz] = toWorld(q, 0);
        const key = `espace:${wallName}_${k}`;
        const extra = isObj(spec.params) ? spec.params : {};
        models[key] = { gen: "wall", seed: key, params: { height: fin(spec.hauteur) && spec.hauteur > 0 ? spec.hauteur * unit : 0, gaps: 0, ...extra, kind: type, points: [[ax * unit, az * unit], [bx * unit, bz * unit]] } };
        place.push({ model: key, at: [0, 0, 0] });
      });
    } else {
      issues.push({ path: `${path}.type`, message: `type de bord inconnu « ${type} » (mur, aucun, ${CLOTURES.join(", ")}, ${Object.keys(ALIAS_CLOTURE).join(", ")})` });
      continue;
    }

    // menuiseries : posées dans l'épaisseur du bord, tournées comme lui
    for (const o of openings) {
      const cx = (o.x0 + o.x1) / 2;
      const [wx, wz] = toWorld(cx, type === "mur" ? -T / 2 : 0);
      const def = isObj(userModels[o.model]) ? (userModels[o.model] as Obj) : builtin[o.model];
      if (!isObj(userModels[o.model])) models[o.model] = def;
      const params: Obj = { ...(isObj(o.raw.params) ? o.raw.params : {}) };
      const dp = isObj(def.params) ? def.params : {};
      if (has(dp, "largeur") && params.largeur === undefined) params.largeur = o.x1 - o.x0;
      if (has(dp, "hauteur") && params.hauteur === undefined) params.hauteur = o.y1 - o.y0;
      const k = (counters[o.model] = (counters[o.model] ?? -1) + 1);
      const name = unique(typeof o.raw.name === "string" && o.raw.name ? o.raw.name : `${o.model}${k}`);
      place.push({ model: o.model, name, shadow: false, at: [wx, o.y0, wz], rot: [0, yaw * DEG + (o.raw.sens === "inverse" ? 180 : 0), 0], ...(Object.keys(params).length ? { params } : {}), ...(isObj(o.raw.slots) ? { slots: o.raw.slots } : {}) });
    }
  }

  /* ---------------------------------------------------------------- plafond */

  if (e.plafond && height) {
    const c = isObj(e.plafond) ? e.plafond : {};
    models["espace:plafond"] = slab(pts, height + U(0.01), { color: isHex(c.couleur) ? c.couleur : "#fbfaf7" }, { name: "top", face: "-y", from: "origine" });
    place.push({ model: "espace:plafond", name: unique("plafond"), shadow: false });
  }

  const { espace: _e, ...rest } = src;
  // les modèles et placements écrits passent après : ils peuvent s'appuyer sur les murs, et un modèle écrit l'emporte
  return { ...(rest as T), models: { ...models, ...userModels }, place: [...place, ...(Array.isArray(src.place) ? src.place : [])] };
}

function polygonArea(p: number[][]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return a / 2;
}

/**
 * Menuiseries de base (prefabs, voir prefab.ts) : origine au milieu du bas de l'ouverture, dans l'épaisseur du mur.
 * Un modèle du monde du même nom les remplace.
 */
function builtinOpenings(U: (m: number) => number): Record<string, Obj> {
  const f = U(0.05), d = U(0.08);
  const frame = (bottom: boolean): Obj[] => [
    { name: "montant", box: [f, "= hauteur", d], at: ["= largeur / 2 - " + f / 2, "= hauteur / 2", 0], mirror: "x", color: "= cadre" },
    { name: "traverse", box: ["= largeur", f, d], at: [0, "= hauteur - " + f / 2, 0], color: "= cadre" },
    ...(bottom ? [{ name: "appui", box: ["= largeur + " + U(0.06), f, d + U(0.06)], at: [0, f / 2, U(0.02)], color: "= cadre" }] : []),
  ];
  return {
    fenetre: {
      famille: "ouverture",
      pose: "mur",
      params: { largeur: { default: U(1.2), min: U(0.3), max: U(6) }, hauteur: { default: U(1.25), min: U(0.3), max: U(4) }, cadre: { default: "#f8fafc" } },
      parts: [
        ...frame(true),
        { name: "meneau", box: [f * 0.8, "= hauteur", d * 0.8], at: [0, "= hauteur / 2", 0], color: "= cadre" },
        { name: "vitre", box: ["= largeur - " + f, "= hauteur - " + f, U(0.01)], at: [0, "= hauteur / 2", 0], color: "#bcdcf0", glow: 0.25 },
      ],
    },
    porte: {
      famille: "ouverture",
      pose: "mur",
      params: { largeur: { default: U(0.83), min: U(0.5), max: U(3) }, hauteur: { default: U(2.04), min: U(1), max: U(4) }, cadre: { default: "#f8fafc" }, teinte: { default: "#e8e2d6" } },
      parts: [
        ...frame(false),
        { name: "battant", box: ["= largeur - " + 2 * f, "= hauteur - " + f, U(0.04)], at: [0, "= (hauteur - " + f + ") / 2", 0], color: "= teinte" },
        { name: "poignee", sphere: U(0.03), at: ["= largeur / 2 - " + U(0.12), U(1), U(0.05)], matiere: "laiton" },
      ],
    },
    portail: {
      famille: "ouverture",
      pose: "mur",
      params: { largeur: { default: U(1), min: U(0.5), max: U(5) }, hauteur: { default: U(1.2), min: U(0.5), max: U(3) }, teinte: { default: "#2f4f3a" } },
      parts: [
        { name: "poteau", box: [U(0.1), "= hauteur + " + U(0.1), U(0.1)], at: ["= largeur / 2", "= (hauteur + " + U(0.1) + ") / 2", 0], mirror: "x", color: "= teinte" },
        { name: "lisse", box: ["= largeur - " + U(0.1), U(0.06), U(0.04)], at: [0, "= hauteur - " + U(0.1), 0], color: "= teinte" },
        { name: "lisseBas", box: ["= largeur - " + U(0.1), U(0.06), U(0.04)], at: [0, U(0.15), 0], color: "= teinte" },
        { name: "barreau", box: [U(0.03), "= hauteur - " + U(0.2), U(0.03)], at: ["= -largeur / 2 + " + U(0.15), "= hauteur / 2", 0], repeat: { n: "= floor((largeur - " + U(0.2) + ") / " + U(0.12) + ")", at: [U(0.12), 0, 0] }, color: "= teinte" },
      ],
    },
  };
}
