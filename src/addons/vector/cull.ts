import { intersects, multiBBox, type BBox, type Multi } from "./geometry";
import { boolean, simplifyMulti } from "./ops";

/**
 * Élagage (culling) pour le rendu vectoriel : ne garder que les formes visibles dans la vue,
 * réduire leur détail à la taille d'un pixel, et découper celles qui débordent.
 */

export type CullItem = { id: string; bbox: BBox };

/** Rectangle du monde vu par une caméra (centre, zoom en pixels par unité, taille de l'écran en pixels). */
export function viewFromCamera(cx: number, cy: number, zoom: number, width: number, height: number): BBox {
  const z = zoom > 0 ? zoom : 1;
  return { x: cx - width / 2 / z, y: cy - height / 2 / z, w: width / z, h: height / z };
}

const grow = (b: BBox, m: number): BBox => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });

/** Formes dont la boîte touche la vue (agrandie de `margin`, en unités du monde). */
export function cull<T extends CullItem>(items: T[], view: BBox, margin = 0): T[] {
  const v = margin ? grow(view, margin) : view;
  return items.filter((it) => intersects(it.bbox, v));
}

/**
 * Grille spatiale : interrogation en temps quasi constant pour des milliers de formes.
 * Chaque forme est inscrite dans toutes les cases qu'elle touche.
 */
export class TileIndex {
  private cells = new Map<string, Set<string>>();
  private boxes = new Map<string, BBox>();

  constructor(readonly cell = 256) {
    if (!(cell > 0)) throw new Error("taille de case invalide");
  }

  get size(): number {
    return this.boxes.size;
  }

  private range(b: BBox): [number, number, number, number] {
    return [Math.floor(b.x / this.cell), Math.floor(b.y / this.cell), Math.floor((b.x + b.w) / this.cell), Math.floor((b.y + b.h) / this.cell)];
  }

  insert(id: string, bbox: BBox): void {
    this.remove(id);
    this.boxes.set(id, bbox);
    const [x0, y0, x1, y1] = this.range(bbox);
    // Une forme géante est rangée dans le nombre de cases borné par 4096 (puis reprise par un test de boîte).
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      this.add("*", id);
      return;
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.add(`${x},${y}`, id);
  }

  private add(key: string, id: string): void {
    let s = this.cells.get(key);
    if (!s) this.cells.set(key, (s = new Set()));
    s.add(id);
  }

  remove(id: string): void {
    const b = this.boxes.get(id);
    if (!b) return;
    this.boxes.delete(id);
    const [x0, y0, x1, y1] = this.range(b);
    const keys = (x1 - x0 + 1) * (y1 - y0 + 1) > 4096 ? ["*"] : [];
    if (!keys.length) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) keys.push(`${x},${y}`);
    for (const k of keys) {
      const s = this.cells.get(k);
      if (s) {
        s.delete(id);
        if (!s.size) this.cells.delete(k);
      }
    }
  }

  clear(): void {
    this.cells.clear();
    this.boxes.clear();
  }

  /** Identifiants des formes dont la boîte touche la vue, dans l'ordre d'insertion. */
  query(view: BBox, margin = 0): string[] {
    const v = margin ? grow(view, margin) : view;
    const [x0, y0, x1, y1] = this.range(v);
    const found = new Set<string>(this.cells.get("*") ?? []);
    const n = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (n > this.cells.size * 2 + 16) {
      for (const [k, s] of this.cells) {
        if (k === "*") continue;
        const [cx, cy] = k.split(",").map(Number);
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) for (const id of s) found.add(id);
      }
    } else {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (const id of this.cells.get(`${x},${y}`) ?? []) found.add(id);
    }
    return [...this.boxes.keys()].filter((id) => found.has(id) && intersects(this.boxes.get(id)!, v));
  }
}

/**
 * Niveau de détail pour un zoom donné (`ppu` pixels par unité) : `null` si la forme tient dans moins
 * de `minPx` pixels (invisible), sinon la forme simplifiée à `tolPx` pixels près.
 */
export function levelOfDetail(shape: Multi, ppu: number, opts: { minPx?: number; tolPx?: number } = {}): Multi | null {
  const { minPx = 0.5, tolPx = 0.5 } = opts;
  if (!(ppu > 0)) return shape;
  const b = multiBBox(shape);
  if (Math.max(b.w, b.h) * ppu < minPx) return null;
  return simplifyMulti(shape, tolPx / ppu);
}

/** Découpe une forme à la vue : indispensable aux très forts zooms (coordonnées gigantesques hors écran). */
export function clipToView(shape: Multi, view: BBox, margin = 0): Multi {
  const v = margin ? grow(view, margin) : view;
  if (!shape.length) return shape;
  const b = multiBBox(shape);
  if (b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h) return shape;
  if (!intersects(b, v)) return [];
  const rect: Multi = [[[[v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.h], [v.x, v.y + v.h]]]];
  return boolean("intersect", shape, rect);
}
