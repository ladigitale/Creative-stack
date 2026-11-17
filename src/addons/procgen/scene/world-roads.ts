/**
 * Spécification d'un monde infini (`recipe.infinite`) et réseau de routes du monde : sans dépendance à la
 * composition (lue aussi par une scène finie qui compose une recette infinie, en rendu vectoriel).
 */
import { clamp } from "../core/math";
import { Rng, hash32 } from "../core/rng";
import type { Issues } from "../core/schema";
import type { PathKind, PathSpec } from "./terrain";

export type RoadNet = { id: string; kind: PathKind; width: number; sidewalk: number; spacing: number; density: number; wiggle: number };

export type InfiniteSpec = {
  tile: number;
  radius: number;
  /** Id d'acteur suivi, ou `camera` (centre de la vue). */
  follow: string;
  seed: string;
  roads: RoadNet[];
  /** Retouches persistées au plus (tout le monde confondu). */
  persist: number;
  /** Composition par image (ms). */
  budget: number;
  quality: "auto" | "low" | "high";
  /** Pas du maillage de sol (m). */
  step: number;
};

export const INFINITE_LIMITS = { radius: 4, tile: [8, 128] as const, persist: 5000, roads: 4 };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const KINDS: PathKind[] = ["street", "road", "path", "river", "plaza"];

/** Lecture de `recipe.infinite` ; `null` : scène finie. */
export function readInfinite(v: unknown, issues: Issues, defaultSeed: string): InfiniteSpec | null {
  if (v === undefined || v === null || v === false) return null;
  if (!isObj(v)) {
    issues.add({ path: "infinite", code: "type", message: "objet attendu ({tile, radius, follow, seed, roads, persist})" });
    return null;
  }
  const num = (k: string, d: number, lo: number, hi: number) => {
    const x = v[k];
    if (x === undefined) return d;
    if (!fin(x)) {
      issues.add({ path: `infinite.${k}`, code: "type", message: "nombre attendu", got: x, used: d });
      return d;
    }
    const c = clamp(x, lo, hi);
    if (c !== x) issues.add({ path: `infinite.${k}`, code: "clamped", message: "hors bornes", got: x, used: c });
    return c;
  };
  const tile = num("tile", 32, INFINITE_LIMITS.tile[0], INFINITE_LIMITS.tile[1]);
  const rawRoads = v.roads === undefined ? [] : v.roads === false ? [] : Array.isArray(v.roads) ? v.roads : [v.roads];
  const roads: RoadNet[] = [];
  for (const [i, r] of rawRoads.entries()) {
    if (roads.length >= INFINITE_LIMITS.roads) {
      issues.add({ path: "infinite.roads", code: "limit", message: `${INFINITE_LIMITS.roads} réseaux au plus` });
      break;
    }
    if (!isObj(r)) continue;
    const kind = KINDS.includes(r.kind as PathKind) ? (r.kind as PathKind) : "road";
    roads.push({
      id: typeof r.id === "string" && r.id ? r.id.slice(0, 32) : i ? `routes${i}` : "routes",
      kind,
      width: fin(r.width) ? clamp(r.width, 0.5, 30) : kind === "path" ? 1.6 : kind === "river" ? 6 : 4,
      sidewalk: fin(r.sidewalk) ? clamp(r.sidewalk, 0, 6) : kind === "street" ? 1.8 : 0,
      spacing: fin(r.spacing) ? clamp(r.spacing, tile, 2000) : Math.max(tile, 96),
      density: fin(r.density) ? clamp(r.density, 0, 1) : 0.7,
      wiggle: fin(r.wiggle) ? clamp(r.wiggle, 0, 0.45) : 0.2,
    });
  }
  const p = v.persist;
  const persist = p === undefined ? 400 : fin(p) ? clamp(Math.round(p), 0, INFINITE_LIMITS.persist) : isObj(p) && fin(p.total) ? clamp(Math.round(p.total), 0, INFINITE_LIMITS.persist) : 400;
  return {
    tile,
    radius: Math.round(num("radius", 2, 1, INFINITE_LIMITS.radius)),
    follow: typeof v.follow === "string" && v.follow ? v.follow : "camera",
    seed: typeof v.seed === "string" || fin(v.seed) ? String(v.seed) : defaultSeed,
    roads,
    persist,
    budget: num("budget", 4, 1, 16),
    quality: v.quality === "low" || v.quality === "high" ? v.quality : "auto",
    step: num("step", 1, 0.4, 4),
  };
}

/**
 * Réseau de routes du monde : un nœud par cellule de `spacing` m (position à désordre), une route entre deux nœuds
 * voisins avec la probabilité `density`, tracé légèrement sinueux. Renvoie les tronçons dont l'emprise touche le
 * rectangle (repère du monde) ; chaque tronçon a un id stable `<réseau>.<i>_<j>_<h|v>` et les mêmes points dans
 * toutes les tuiles (même relief de chaussée partout).
 */
export function worldRoads(spec: Pick<InfiniteSpec, "roads" | "seed">, x0: number, z0: number, x1: number, z1: number): PathSpec[] {
  const out: PathSpec[] = [];
  for (const net of spec.roads) {
    const S = net.spacing;
    const node = (i: number, j: number): [number, number] => {
      const r = new Rng(hash32(`${spec.seed}/${net.id}/n/${i}/${j}`));
      return [(i + 0.5 + (r.next() - 0.5) * 0.6) * S, (j + 0.5 + (r.next() - 0.5) * 0.6) * S];
    };
    const m = net.width + net.sidewalk * 2 + S * net.wiggle + 4;
    const i0 = Math.floor((x0 - m) / S) - 1, i1 = Math.floor((x1 + m) / S) + 1;
    const j0 = Math.floor((z0 - m) / S) - 1, j1 = Math.floor((z1 + m) / S) + 1;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (const dir of ["h", "v"] as const) {
          const r = new Rng(hash32(`${spec.seed}/${net.id}/e/${i}/${j}/${dir}`));
          if (r.next() >= net.density) continue;
          const a = node(i, j), b = dir === "h" ? node(i + 1, j) : node(i, j + 1);
          if (Math.max(a[0], b[0]) < x0 - m || Math.min(a[0], b[0]) > x1 + m || Math.max(a[1], b[1]) < z0 - m || Math.min(a[1], b[1]) > z1 + m) continue;
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
          const amp = (r.next() - 0.5) * 2 * net.wiggle * S * 0.35, amp2 = (r.next() - 0.5) * net.wiggle * S * 0.2;
          const pts: [number, number][] = [];
          const N = Math.max(4, Math.ceil(L / 12));
          for (let k = 0; k <= N; k++) {
            const t = k / N;
            const w = Math.sin(Math.PI * t) * amp + Math.sin(2 * Math.PI * t) * amp2;
            pts.push([a[0] + (b[0] - a[0]) * t + nx * w, a[1] + (b[1] - a[1]) * t + nz * w]);
          }
          out.push({ id: `${net.id}.${i}_${j}_${dir}`, points: pts, width: net.width, kind: net.kind, sidewalk: net.sidewalk });
        }
  }
  return out;
}

