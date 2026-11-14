/**
 * Cache de tuiles du dessin, par niveau de zoom (pyramide, comme une carte).
 *
 * Une tuile couvre un carré du monde ; au niveau `L`, elle est dessinée à l'échelle 2^L pixels du canvas par
 * unité du monde, sur `TILE` px de côté. Pour une vue, on prend le niveau juste assez fin (la tuile est réduite
 * d'un facteur entre 1 et 2, jamais agrandie). Une tuile déjà rendue sert tant que rien ne la touche :
 *
 * - déplacer la vue ne dessine que les tuiles qui entrent ; zoomer dans un même niveau n'en dessine aucune ;
 *   revenir à un zoom déjà vu reprend ses tuiles ;
 * - pendant un geste, la vue est composée directement depuis les tuiles en cache (avec, pour une tuile qui
 *   manque, celle d'un niveau voisin agrandie ou réduite) : plus de bord vide en glissant ;
 * - un trait ajouté au-dessus est peint sur les tuiles qu'il touche ; tout autre changement (annulation,
 *   retouche, aplatissement…) n'efface que les tuiles sous les traits ôtés ou ajoutés.
 *
 * Les tuiles contiennent le fond (les modes de fusion le voient, comme dans la couche).
 */
import { intersects, type BBox } from "../vector/geometry";
import { drawStroke, type Surface } from "./render";
import type { Stroke, View } from "./model";

/** Côté d'une tuile (px du canvas), hors marge. */
export const TILE = 256;
/** Marge de recouvrement autour de chaque tuile (px) : pas de joint visible entre tuiles réduites. */
const GUTTER = 2;
/** Nombre de tuiles gardées (≈ 270 Ko chacune). */
export const MAX_TILES = 144;

/** Tuile ; `todo` : traits qui restent à y peindre (rendu par tranches), vide quand elle est prête. */
export type Tile = { L: number; tx: number; ty: number; canvas: HTMLCanvasElement; rect: BBox; todo: Stroke[]; next: number };

/** Au-delà de ce nombre de traits ajoutés d'un coup, les tuiles touchées sont refaites (par tranches) plutôt que complétées sur-le-champ. */
const APPEND_MAX = 48;

/** Niveau de tuiles pour un zoom en px du canvas par unité du monde (le plus fin qui reste ≥ ce zoom). */
export function tileLevel(zoomPx: number): number {
  return Math.ceil(Math.log2(Math.max(1e-30, zoomPx)) - 1e-9) || 0;
}

/** Carré du monde couvert par la tuile (L, tx, ty). */
export function tileRect(L: number, tx: number, ty: number): BBox {
  const s = TILE / 2 ** L;
  return { x: tx * s, y: ty * s, w: s, h: s };
}

/** Tuiles (indices) qui recouvrent un rectangle du monde au niveau L. */
export function tilesFor(L: number, r: BBox): [number, number][] {
  const s = TILE / 2 ** L;
  const x0 = Math.floor(r.x / s), y0 = Math.floor(r.y / s), x1 = Math.floor((r.x + r.w) / s), y1 = Math.floor((r.y + r.h) / s);
  const out: [number, number][] = [];
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return out;
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([tx, ty]);
  return out;
}

const key = (L: number, tx: number, ty: number) => `${L}|${tx}|${ty}`;

export class TileCache {
  private tiles = new Map<string, Tile>();
  /** Traits déjà reflétés par les tuiles (copie, dans l'ordre). */
  private synced: Stroke[] = [];
  private bg: string | null = null;

  constructor(private readonly make: (w: number, h: number) => HTMLCanvasElement | null = defaultCanvas) {}

  get size(): number {
    return this.tiles.size;
  }

  /** Tout oublier (changement de fond, de taille de pixel…). */
  clear(): void {
    this.tiles.clear();
    this.synced = [];
  }

  /**
   * Met les tuiles à jour pour le dessin `strokes` sur le fond `bg`. Traits ajoutés au-dessus : peints sur les
   * tuiles en cache qu'ils touchent. Sinon : les tuiles sous les traits ôtés ou ajoutés sont oubliées.
   */
  sync(strokes: readonly Stroke[], bg: string | null): void {
    if (bg !== this.bg) { this.bg = bg; this.clear(); }
    const old = this.synced;
    let same = 0;
    const n = Math.min(old.length, strokes.length);
    while (same < n && old[same] === strokes[same]) same++;
    if (same === old.length && strokes.length === old.length) return;
    if (same === old.length) {
      // Ajout au-dessus : les nouveaux traits s'ajoutent à ce qui reste à peindre sur les tuiles touchées (peints
      // tout de suite s'il y en a peu ; sinon la tuile est refaite plus tard, par tranches).
      const added = strokes.slice(same);
      for (const [k, t] of this.tiles) {
        const hit = added.filter((s) => intersects(s.bbox, grown(t)));
        if (!hit.length) continue;
        if (hit.length > APPEND_MAX) { this.tiles.delete(k); continue; }
        t.todo.push(...hit);
        if (t.next >= t.todo.length - hit.length) this.advance(t, () => true);
      }
    } else {
      const keep = new Set(strokes);
      const was = new Set(old);
      const changed: BBox[] = [];
      for (const s of old) if (!keep.has(s)) changed.push(s.bbox);
      for (const s of strokes) if (!was.has(s)) changed.push(s.bbox);
      // Ordre changé sans ajout ni retrait : tout est à refaire.
      if (!changed.length) this.tiles.clear();
      for (const [k, t] of this.tiles) if (changed.some((b) => intersects(b, t.rect))) this.tiles.delete(k);
    }
    this.synced = strokes.slice();
  }

  /** Tuile en cache (rafraîchie dans l'ordre d'usage), ou `undefined`. */
  get(L: number, tx: number, ty: number): Tile | undefined {
    const k = key(L, tx, ty);
    const t = this.tiles.get(k);
    if (t) { this.tiles.delete(k); this.tiles.set(k, t); }
    return t;
  }

  /**
   * Rend la tuile (L, tx, ty) à partir des traits synchronisés et la met en cache ; avec `budget`, par tranches :
   * la tuile reste « à finir » (pas montrée) tant que `budget()` coupe, et reprend au prochain appel.
   */
  render(L: number, tx: number, ty: number, budget: () => boolean = () => true): Tile | null {
    const k = key(L, tx, ty);
    let t = this.tiles.get(k);
    if (!t) {
      const canvas = this.make(TILE + 2 * GUTTER, TILE + 2 * GUTTER);
      if (!canvas) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      t = { L, tx, ty, canvas, rect: tileRect(L, tx, ty), todo: [], next: 0 };
      if (this.bg) { ctx.fillStyle = this.bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      const area = grown(t), z = 2 ** L;
      t.todo = this.synced.filter((s) => intersects(s.bbox, area) && Math.max(s.bbox.w, s.bbox.h) * z >= 0.4);
      this.tiles.set(k, t);
      while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value as string);
    }
    this.advance(t, budget);
    return t;
  }

  /** Tuile prête (tout peint). */
  static ready(t: Tile | undefined): t is Tile {
    return !!t && t.next >= t.todo.length;
  }

  /** Peint sur la tuile les traits qui lui restent, tant que `budget()` le permet (par lots de 16). */
  private advance(t: Tile, budget: () => boolean): void {
    if (t.next >= t.todo.length) return;
    const ctx = t.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const z = 2 ** t.L;
    const side = TILE + 2 * GUTTER;
    const view: View = { x: t.rect.x + t.rect.w / 2, y: t.rect.y + t.rect.h / 2, zoom: z, rotation: 0 };
    const s: Surface = { ctx, w: side, h: side, view };
    while (t.next < t.todo.length) {
      const end = Math.min(t.todo.length, t.next + 16);
      for (; t.next < end; t.next++) drawStroke(s, t.todo[t.next]);
      if (!budget()) break;
    }
    if (t.next >= t.todo.length) { t.todo = []; t.next = 0; }
  }

  /**
   * Dessine la vue `view` (canvas `w × h` px logiques, `dpr`) sur `ctx` à partir des tuiles. Avec `render`, les
   * tuiles qui manquent sont rendues tant que `budget()` le permet ; les autres sont remplacées par une tuile
   * d'un niveau voisin si elle est en cache. Retourne le nombre de tuiles encore manquantes.
   */
  draw(ctx: CanvasRenderingContext2D, view: View, w: number, h: number, dpr: number, render: boolean, budget: () => boolean = () => true): number {
    const zpx = view.zoom * dpr;
    const L = tileLevel(zpx);
    const r = visible(view, w, h);
    let missing = 0;
    const list = tilesFor(L, r);
    // Du centre vers les bords : ce qu'on regarde se précise d'abord.
    const cx = view.x, cy = view.y, s = TILE / 2 ** L;
    list.sort((a, b) => Math.hypot((a[0] + 0.5) * s - cx, (a[1] + 0.5) * s - cy) - Math.hypot((b[0] + 0.5) * s - cx, (b[1] + 0.5) * s - cy));
    const c = Math.cos(view.rotation) * view.zoom, sn = Math.sin(view.rotation) * view.zoom;
    const place = (t: Tile) => {
      // Monde → canvas : la tuile (marge comprise) posée à sa place.
      const k = 2 ** t.L;
      const ox = t.rect.x - GUTTER / k, oy = t.rect.y - GUTTER / k;
      const e = dpr * (w / 2 - (c * view.x - sn * view.y)), f = dpr * (h / 2 - (sn * view.x + c * view.y));
      ctx.setTransform((dpr * c) / k, (dpr * sn) / k, (-dpr * sn) / k, (dpr * c) / k, e + dpr * (c * ox - sn * oy), f + dpr * (sn * ox + c * oy));
      ctx.drawImage(t.canvas, 0, 0);
    };
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (const [tx, ty] of list) {
      let t = this.get(L, tx, ty);
      if (!TileCache.ready(t) && render && budget()) t = this.render(L, tx, ty, budget) ?? undefined;
      if (TileCache.ready(t)) { place(t); continue; }
      missing++;
      // Remplaçante : la tuile parente (moins fine) ou, à défaut, les enfants du niveau au-dessus.
      const p1 = this.get(L - 1, Math.floor(tx / 2), Math.floor(ty / 2)), p2 = this.get(L - 2, Math.floor(tx / 4), Math.floor(ty / 4));
      const parent = TileCache.ready(p1) ? p1 : TileCache.ready(p2) ? p2 : undefined;
      if (parent) { ctx.save(); clipTile(ctx, view, w, h, dpr, tileRect(L, tx, ty)); place(parent); ctx.restore(); continue; }
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const child = this.get(L + 1, tx * 2 + i, ty * 2 + j);
        if (TileCache.ready(child)) place(child);
      }
    }
    ctx.restore();
    return missing;
  }
}

function grown(t: Tile): BBox {
  const m = GUTTER / 2 ** t.L;
  return { x: t.rect.x - m, y: t.rect.y - m, w: t.rect.w + 2 * m, h: t.rect.h + 2 * m };
}

function visible(v: View, w: number, h: number): BBox {
  const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([sx, sy]) => {
    const dx = (sx - w / 2) / v.zoom, dy = (sy - h / 2) / v.zoom;
    return [v.x + dx * c + dy * s, v.y - dx * s + dy * c];
  });
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** Limite le dessin au carré du monde `r` (pour une tuile remplaçante plus grande). */
function clipTile(ctx: CanvasRenderingContext2D, v: View, w: number, h: number, dpr: number, r: BBox): void {
  const c = Math.cos(v.rotation) * v.zoom, s = Math.sin(v.rotation) * v.zoom;
  const e = w / 2 - (c * v.x - s * v.y), f = h / 2 - (s * v.x + c * v.y);
  ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * e, dpr * f);
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
}

function defaultCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
