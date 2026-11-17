/**
 * Monde infini dans les simulations : formes du peuplement des tuiles proches (requêtes, capteurs, émetteurs,
 * physique) et hauteur du relief. Seules les tuiles autour du centre (anneau `ring`) comptent : les copies
 * lointaines ne sont ni touchées ni heurtées.
 */
import type { Monde } from "../monde/format";
import { heightAt, type Tile, type TileManager } from "../monde/infini";
import { hull, placeBoxes } from "../monde/collide";
import type { Shape } from "./queries";

const cache = new WeakMap<Tile, Shape[]>();

/** Étiquettes d'une copie : modèle de base, étiquettes du prefab, `infini`, `decor`. */
function tagsOf(m: Monde, model: string): string[] {
  const base = model.split("~")[0];
  const p = Object.prototype.hasOwnProperty.call(m.prefabs, base) ? m.prefabs[base] : null;
  return [base, ...(p?.tags ?? []), ...(p?.famille ? [p.famille] : []), "infini", "decor"];
}

/**
 * Formes des copies d'une tuile (repère du monde). `name` = identifiant de la copie (celui que `tiles.<clé>.remove`
 * retire), étiquette `infini`.
 */
export function tileShapes(m: Monde, tile: Tile): Shape[] {
  const hit = cache.get(tile);
  if (hit) return hit;
  const out: Shape[] = [];
  for (const it of tile.items) {
    const model = m.models.get(it.model);
    if (!model) continue;
    const boxes = placeBoxes(model, [it.x, it.y, it.z], [0, it.ry, 0], [it.s, it.s, it.s]);
    if (!boxes.length) continue;
    const h = hull(boxes);
    out.push({ name: it.id, model: it.model, tags: tagsOf(m, it.model), sensor: false, boxes, lo: h.lo, hi: h.hi });
  }
  cache.set(tile, out);
  return out;
}

/** Tuiles chargées à au plus `ring` tuiles du centre du gestionnaire. */
export function nearTiles(mgr: TileManager, ring = 1): Tile[] {
  const s = mgr.spec;
  if (!s) return [];
  const cx = Math.floor(mgr.center[0] / s.tile), cz = s.axes === "x" ? 0 : Math.floor(mgr.center[1] / s.tile);
  const out: Tile[] = [];
  for (const t of mgr.tiles.values()) if (Math.abs(t.cx - cx) <= ring && Math.abs(t.cz - cz) <= ring) out.push(t);
  return out;
}

/** Formes du peuplement proche ; signature (clés des tuiles) pour ne recalculer qu'au changement. */
export function nearShapes(m: Monde, mgr: TileManager, ring = 1): { sig: string; shapes: Shape[] } {
  const tiles = nearTiles(mgr, ring);
  const shapes: Shape[] = [];
  for (const t of tiles) shapes.push(...tileShapes(m, t));
  return { sig: tiles.map((t) => t.key).sort().join(";"), shapes };
}

/** Hauteur du sol du monde infini (0 sans relief ni monde infini). */
export function groundOf(m: Monde | null): (x: number, z: number) => number {
  const s = m?.infini;
  if (!s || !s.relief) return () => 0;
  return (x, z) => heightAt(s, x, z);
}

/**
 * À chaque image d'un monde infini : le peuplement proche rejoint les requêtes et capteurs, les émetteurs (boîtes
 * touchées, contournées) et la physique (obstacles, relief). Rien n'est refait tant que les tuiles proches restent
 * les mêmes.
 */
export function syncInfiniSims(
  m: Monde,
  mgr: TileManager,
  sims: { probe?: { setExtra(sig: string, s: Shape[]): void } | null; emitters?: { setFixed(sig: string, b: Shape[]): void } | null; rigid?: { syncInfini(mgr: TileManager): void } | null },
) {
  if (!m.infini || !mgr.spec) return;
  const tiles = nearTiles(mgr, 1);
  const sig = tiles.map((t) => t.key).sort().join(";");
  const last = lastSig.get(mgr);
  // nouveau monde : requêtes et émetteurs ont été remontés, ils reprennent le peuplement
  if (!last || last.m !== m || last.sig !== sig) {
    lastSig.set(mgr, { m, sig });
    const shapes: Shape[] = [];
    for (const t of tiles) shapes.push(...tileShapes(m, t));
    sims.probe?.setExtra(sig, shapes);
    sims.emitters?.setFixed(sig, shapes);
  }
  sims.rigid?.syncInfini(mgr);
}
const lastSig = new WeakMap<TileManager, { m: Monde; sig: string }>();
