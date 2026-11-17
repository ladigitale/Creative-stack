/**
 * Monde infini : le sol est découpé en tuiles carrées, chacune générée à la demande depuis la graine et ses
 * coordonnées, chargée autour d'une instance suivie puis relâchée derrière elle.
 *
 * - Relief, biome et densités sont des champs en coordonnées du monde (expressions `x`, `z`, `noise`) : deux tuiles
 *   voisines se raccordent sans couture.
 * - Peuplement par grille à désordre alignée sur le monde (`cell`) : un candidat par cellule, gardé selon `density`.
 *   L'écart minimal tient par construction, sans regarder les tuiles voisines.
 * - Identifiants stables `t.<cx>.<cz>.<calque>.<rang>` : revenir sur une tuile redonne les mêmes objets ; les
 *   retouches du joueur (`tiles."cx,cz"`) s'appliquent après la génération.
 *
 * Sans dépendance au rendu : `sonic-3d` et `sonic-2d` dessinent les tuiles chargées.
 */
import { Rng, hash32 } from "../rng";
import { evaluate } from "../expr";

export type InfiniLayer = {
  /** Modèles tirés au hasard pour chaque copie. */
  models: string[];
  cell: number;
  /** Probabilité de garder le candidat d'une cellule : nombre ou expression (`x`, `z`, `h`, `biome`). */
  density: number | string;
  /** Désordre dans la cellule (0 : au centre, 1 : n'importe où). */
  jitter: number;
  scale: [number, number];
  /** Rotation y au hasard (degrés). */
  turn: number;
  /** Seulement dans ces biomes (vide : partout). */
  biomes: string[];
};

export type InfiniSpec = {
  seed: string;
  /** Côté d'une tuile (m). */
  tile: number;
  /** Rayon de chargement (tuiles). */
  radius: number;
  /** Instance autour de laquelle les tuiles sont chargées. */
  follow: string;
  /** Centre à défaut d'instance suivie (m). */
  center: [number, number];
  /** `xz` (3D, vue de dessus) ou `x` (défilement horizontal : une rangée de tuiles). */
  axes: "xz" | "x";
  /** Relief : expression de la hauteur (m), vide = plat. */
  relief: string;
  ground: string;
  /** Champ du biome (expression, de -1 à 1) et biomes par seuil croissant, avec leur couleur de sol. */
  biomeField: string;
  biomes: { to: number; name: string; color: string }[];
  layers: InfiniLayer[];
  /** Copies au plus par tuile (tous calques). */
  perTile: number;
};

export type TileItem = { id: string; layer: number; model: string; x: number; y: number; z: number; ry: number; s: number };
export type Tile = { cx: number; cz: number; key: string; biome: string; items: TileItem[] };
export type TileEdit = { remove?: string[]; add?: { model: string; x: number; z: number; ry?: number; s?: number; id?: string }[] };

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const COLOR = /^#[0-9a-fA-F]{6}$/;

export const INFINI_LIMITS = { layers: 12, perTile: 600, radius: 6 } as const;

/** Lecture de `monde.infini` (longueurs dans l'unité du document) ; `known` dit si un modèle existe. */
export function readInfini(v: unknown, u: number, known: (m: string) => boolean, issues: { path: string; message: string }[], resolve: (m: string) => string = (m) => m): InfiniSpec | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) {
    issues.push({ path: "infini", message: "objet attendu ({tile, radius, follow, layers…})" });
    return null;
  }
  const expr = (x: unknown, path: string, d: string): string => {
    if (x === undefined) return d;
    if (fin(x)) return String(x * u);
    if (typeof x === "string") {
      try {
        evaluate(x, { vars: { x: 0, z: 0, h: 0, biome: "" }, rng: new Rng(1) });
        return x;
      } catch (e) {
        issues.push({ path, message: `expression invalide : ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return d;
  };
  const g = isObj(v.ground) ? v.ground : {};
  const bi = isObj(v.biomes) ? v.biomes : {};
  const biomes = (Array.isArray(bi.list) ? bi.list : [])
    .filter(isObj)
    .slice(0, 8)
    .map((b) => ({ to: fin(b.to) ? b.to : 1, name: typeof b.name === "string" ? b.name.slice(0, 32) : "", color: typeof b.color === "string" && COLOR.test(b.color) ? b.color : "" }))
    .sort((a, b) => a.to - b.to);
  const layers: InfiniLayer[] = [];
  for (const [i, raw] of (Array.isArray(v.layers) ? v.layers : []).entries()) {
    const path = `infini.layers.${i}`;
    if (layers.length >= INFINI_LIMITS.layers) {
      issues.push({ path: "infini.layers", message: `${INFINI_LIMITS.layers} calques au plus` });
      break;
    }
    if (!isObj(raw)) continue;
    const models = (Array.isArray(raw.models) ? raw.models : [raw.model]).filter((m): m is string => typeof m === "string").slice(0, 8).map(resolve);
    const ok = models.filter((m) => known(m));
    for (const m of models) if (!known(m)) issues.push({ path: `${path}.model`, message: `modèle inconnu « ${m} »` });
    if (!ok.length) continue;
    const density = typeof raw.density === "string" ? expr(raw.density, `${path}.density`, "0") : fin(raw.density) ? clamp(raw.density, 0, 1) : 0.5;
    layers.push({
      models: ok,
      cell: fin(raw.cell) ? clamp(raw.cell * u, 0.2, 200) : 4,
      density,
      jitter: fin(raw.jitter) ? clamp(raw.jitter, 0, 1) : 0.8,
      scale: Array.isArray(raw.scale) && fin(raw.scale[0]) ? [raw.scale[0], fin(raw.scale[1]) ? raw.scale[1] : raw.scale[0]] : fin(raw.scale) ? [raw.scale, raw.scale] : [0.85, 1.15],
      turn: fin(raw.turn) ? clamp(raw.turn, 0, 360) : 360,
      biomes: Array.isArray(raw.biomes) ? raw.biomes.filter((b): b is string => typeof b === "string") : typeof raw.biome === "string" ? [raw.biome] : [],
    });
  }
  return {
    seed: typeof v.seed === "string" || fin(v.seed) ? String(v.seed) : "monde",
    tile: fin(v.tile) ? clamp(v.tile * u, 4, 512) : 32,
    radius: fin(v.radius) ? clamp(Math.round(v.radius), 1, INFINI_LIMITS.radius) : 2,
    follow: typeof v.follow === "string" ? v.follow : "",
    center: Array.isArray(v.center) && fin(v.center[0]) ? [v.center[0] * u, fin(v.center[1]) ? v.center[1] * u : 0] : [0, 0],
    axes: v.axes === "x" ? "x" : "xz",
    relief: expr(isObj(g) ? g.relief : undefined, "infini.ground.relief", ""),
    ground: typeof g.color === "string" && COLOR.test(g.color) ? g.color : "#6b8f4e",
    biomeField: expr(bi.field, "infini.biomes.field", "noise(x / 200, z / 200)"),
    biomes,
    layers,
    perTile: fin(v.perTile) ? clamp(Math.round(v.perTile), 1, INFINI_LIMITS.perTile) : 300,
  };
}

const scopeRng = new Rng(1);

/** Valeur d'un champ en (x, z) (mètres) ; les expressions sont écrites en mètres. */
function field(src: string, x: number, z: number, extra?: Record<string, unknown>, rng: Rng = scopeRng): number {
  if (!src) return 0;
  const n = Number(src);
  if (Number.isFinite(n)) return n;
  try {
    const v = evaluate(src, { vars: { x, z, ...extra }, rng });
    return typeof v === "number" ? v : Number(v) || 0;
  } catch {
    return 0;
  }
}

export function heightAt(s: InfiniSpec, x: number, z: number): number {
  return s.relief ? field(s.relief, x, z) : 0;
}

export function biomeAt(s: InfiniSpec, x: number, z: number): { name: string; color: string } {
  if (!s.biomes.length) return { name: "", color: s.ground };
  const v = field(s.biomeField, x, z);
  for (const b of s.biomes) if (v <= b.to) return { name: b.name, color: b.color || s.ground };
  const last = s.biomes[s.biomes.length - 1];
  return { name: last.name, color: last.color || s.ground };
}

/** Génère une tuile (déterministe) puis applique les retouches du joueur. */
export function generateTile(s: InfiniSpec, cx: number, cz: number, edit?: TileEdit): Tile {
  const T = s.tile;
  const x0 = cx * T, z0 = cz * T;
  const key = `${cx},${cz}`;
  const items: TileItem[] = [];
  s.layers.forEach((L, li) => {
    const c = L.cell;
    const i0 = Math.floor(x0 / c), i1 = Math.ceil((x0 + T) / c);
    const j0 = s.axes === "x" ? 0 : Math.floor(z0 / c), j1 = s.axes === "x" ? 1 : Math.ceil((z0 + T) / c);
    let rank = 0;
    for (let i = i0; i < i1; i++)
      for (let j = j0; j < j1; j++) {
        if (items.length >= s.perTile) return;
        // une graine par cellule du monde : la même quelle que soit la tuile qui la génère
        const r = new Rng(hash32(`${s.seed}/${li}/${i}/${j}`));
        const x = (i + 0.5 + (r.next() - 0.5) * L.jitter) * c;
        const z = s.axes === "x" ? z0 + (r.next() - 0.5) * L.jitter * c : (j + 0.5 + (r.next() - 0.5) * L.jitter) * c;
        // la cellule appartient à la tuile qui contient son candidat
        if (x < x0 || x >= x0 + T || (s.axes !== "x" && (z < z0 || z >= z0 + T))) continue;
        const h = heightAt(s, x, z);
        const biome = biomeAt(s, x, z).name;
        if (L.biomes.length && !L.biomes.includes(biome)) continue;
        const d = typeof L.density === "number" ? L.density : field(L.density, x, z, { h, biome }, r);
        if (r.next() >= d) continue;
        const model = L.models.length > 1 ? L.models[Math.floor(r.next() * L.models.length) % L.models.length] : L.models[0];
        items.push({ id: `t.${cx}.${cz}.${li}.${rank++}`, layer: li, model, x, y: h, z, ry: (r.next() * L.turn * Math.PI) / 180, s: L.scale[0] + (L.scale[1] - L.scale[0]) * r.next() });
      }
  });
  if (edit) {
    if (edit.remove?.length) {
      const gone = new Set(edit.remove);
      for (let k = items.length - 1; k >= 0; k--) if (gone.has(items[k].id)) items.splice(k, 1);
    }
    for (const [k, a] of (edit.add ?? []).entries()) {
      if (!a || typeof a.model !== "string" || !fin(a.x) || !fin(a.z)) continue;
      items.push({ id: a.id ?? `t.${cx}.${cz}.ajout.${k}`, layer: -1, model: a.model, x: a.x, y: heightAt(s, a.x, a.z), z: a.z, ry: fin(a.ry) ? (a.ry * Math.PI) / 180 : 0, s: fin(a.s) ? a.s : 1 });
    }
  }
  return { cx, cz, key, biome: biomeAt(s, x0 + T / 2, z0 + T / 2).name, items };
}

export type InfiniState = { center: [number, number]; loaded: number; pending: number; ms: number };

/**
 * Tuiles chargées autour du centre : les plus proches d'abord, en tranches de 4 ms ; relâchées au-delà de
 * `radius + 1` (hystérésis). `changed` passe à vrai quand l'ensemble change (le rendu reconstruit).
 */
export class TileManager {
  spec: InfiniSpec | null = null;
  tiles = new Map<string, Tile>();
  private edits: Record<string, TileEdit> = {};
  private editSig = "";
  changed = false;
  center: [number, number] = [0, 0];
  private lastTile = "";
  pending = 0;
  ms = 0;
  /** La tuile de l'instance suivie a changé : `{cx, cz, biome}`. */
  onEnter: ((e: { cx: number; cz: number; biome: string }) => void) | null = null;

  set(spec: InfiniSpec | null) {
    const same = this.spec && spec && JSON.stringify(this.spec) === JSON.stringify(spec);
    this.spec = spec;
    if (!same) {
      this.tiles.clear();
      this.changed = true;
      this.lastTile = "";
    }
  }

  /** Retouches du joueur (`tiles."cx,cz"`) : les tuiles touchées sont regénérées. */
  setEdits(v: unknown) {
    if (!isObj(v)) return;
    const sig = JSON.stringify(v);
    if (sig === this.editSig) return;
    this.editSig = sig;
    const next = v as Record<string, TileEdit>;
    for (const k of new Set([...Object.keys(this.edits), ...Object.keys(next)])) if (JSON.stringify(this.edits[k]) !== JSON.stringify(next[k])) this.tiles.delete(k);
    this.edits = next;
    this.changed = true;
  }

  /** Avance le chargement autour de (x, z) (mètres) ; vrai si l'ensemble des tuiles a changé. */
  update(x: number, z: number, budgetMs = 4): boolean {
    const s = this.spec;
    if (!s) return false;
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    this.center = [x, z];
    const T = s.tile;
    const ccx = Math.floor(x / T), ccz = s.axes === "x" ? 0 : Math.floor(z / T);
    const here = `${ccx},${ccz}`;
    if (here !== this.lastTile) {
      this.lastTile = here;
      this.onEnter?.({ cx: ccx, cz: ccz, biome: biomeAt(s, (ccx + 0.5) * T, (ccz + 0.5) * T).name });
    }
    const R = s.radius;
    const want: { cx: number; cz: number; d: number }[] = [];
    for (let dx = -R; dx <= R; dx++)
      for (let dz = s.axes === "x" ? 0 : -R; dz <= (s.axes === "x" ? 0 : R); dz++) {
        const d = Math.hypot(dx, dz);
        if (d <= R + 0.5) want.push({ cx: ccx + dx, cz: ccz + dz, d });
      }
    want.sort((a, b) => a.d - b.d);
    let changed = this.changed;
    this.changed = false;
    // relâche
    for (const [k, t] of this.tiles) if (Math.hypot(t.cx - ccx, t.cz - ccz) > R + 1.5) {
      this.tiles.delete(k);
      changed = true;
    }
    // charge, les plus proches d'abord, dans le budget
    let left = 0;
    for (const w of want) {
      const k = `${w.cx},${w.cz}`;
      if (this.tiles.has(k)) continue;
      const now = typeof performance !== "undefined" ? performance.now() : 0;
      if (now - t0 > budgetMs && this.tiles.size > 0) {
        left++;
        continue;
      }
      this.tiles.set(k, generateTile(s, w.cx, w.cz, this.edits[k]));
      changed = true;
    }
    this.pending = left;
    this.ms = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
    return changed;
  }

  state(): InfiniState {
    return { center: [Math.round(this.center[0] * 100) / 100, Math.round(this.center[1] * 100) / 100], loaded: this.tiles.size, pending: this.pending, ms: Math.round(this.ms * 100) / 100 };
  }
}


