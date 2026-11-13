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

export type Tile = { L: number; tx: number; ty: number; canvas: HTMLCanvasElement; rect: BBox };

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
      // Ajout au-dessus : on peint les nouveaux traits sur les tuiles touchées.
      const added = strokes.slice(same);
      for (const t of this.tiles.values()) {
        const hit = added.filter((s) => intersects(s.bbox, t.rect));
        if (hit.length) this.paint(t, hit);
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

  /** Rend la tuile (L, tx, ty) à partir des traits synchronisés et la met en cache. */
  render(L: number, tx: number, ty: number): Tile | null {
    const canvas = this.make(TILE + 2 * GUTTER, TILE + 2 * GUTTER);
    if (!canvas) return null;
    const t: Tile = { L, tx, ty, canvas, rect: tileRect(L, tx, ty) };
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (this.bg) { ctx.fillStyle = this.bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    this.paint(t, this.synced.filter((s) => intersects(s.bbox, grown(t))));
    const k = key(L, tx, ty);
    this.tiles.set(k, t);
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value as string);
    return t;
  }

  private paint(t: Tile, strokes: readonly Stroke[]): void {
    const ctx = t.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const z = 2 ** t.L;
    const side = TILE + 2 * GUTTER;
    const view: View = { x: t.rect.x + t.rect.w / 2, y: t.rect.y + t.rect.h / 2, zoom: z, rotation: 0 };
    const s: Surface = { ctx, w: side, h: side, view };
    const area = grown(t);
    for (const st of strokes) {
      if (!intersects(st.bbox, area) || Math.max(st.bbox.w, st.bbox.h) * z < 0.4) continue;
      drawStroke(s, st);
    }
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
      if (!t && render && budget()) t = this.render(L, tx, ty) ?? undefined;
      if (t) { place(t); continue; }
      missing++;
      // Remplaçante : la tuile parente (moins fine) ou, à défaut, les enfants du niveau au-dessus.
      const parent = this.get(L - 1, Math.floor(tx / 2), Math.floor(ty / 2)) ?? this.get(L - 2, Math.floor(tx / 4), Math.floor(ty / 4));
      if (parent) { ctx.save(); clipTile(ctx, view, w, h, dpr, tileRect(L, tx, ty)); place(parent); ctx.restore(); continue; }
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const child = this.get(L + 1, tx * 2 + i, ty * 2 + j);
        if (child) place(child);
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
