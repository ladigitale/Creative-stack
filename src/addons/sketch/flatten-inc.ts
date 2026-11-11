import { multiBBox, type BBox, type Multi, type Pt } from "../vector";
import type { BlendMode } from "../paint/brush";
import { flatVertices, paintFlat, safeBoolean, type Backdrop, type Region } from "./flat";
import type { Rgba } from "./flat-color";
import { strokeOutline } from "./merge";
import { compactStroke } from "./model";

/**
 * Aplatissement progressif d'un trait plein, pendant le geste : le trait est livré par morceaux (une passe, ou un
 * tronçon d'une passe longue) dès qu'ils sont terminés, et chaque morceau est contouré puis peint dans la carte
 * d'aplats par petites tranches de temps. Au lever, il ne reste que le dernier morceau à calculer, au lieu de
 * tout le trait : tourner longtemps au même endroit ne fige plus la vue au relâchement.
 *
 * Jonctions : `pass` (nouvelle passe, qui se cumule avec la précédente) ôte de sa forme le bout arrondi de départ,
 * déjà couvert par la fin de la passe précédente ; `chunk` (suite de la même passe) ôte toute la forme du morceau
 * précédent, pour qu'une même passe ne se recouvre jamais. Un trait couvrant (normal, opaque) n'a besoin d'aucun
 * des deux : ses recouvrements ne se voient pas.
 */

export type Joint = "start" | "pass" | "chunk";
export type Piece = { pts: number[]; joint: Joint };

export type FlattenSpec = {
  /** Rayon du trait (monde), d'après ses premiers points (la pression, constante, réduit le diamètre). */
  radius: (pts: number[]) => number;
  /** Tolérance du contour (monde) pour un rayon donné. */
  tolerance: (r: number) => number;
  /** Pinceau à pression : elle doit rester constante (sinon le trait n'est pas plein : échec). */
  pressure: boolean;
  /** Tolérance de compaction des points (monde) ; 0 = aucune. */
  ztol: number;
  /** Tolérance de compaction de la pression. */
  ptol: number;
  src: Rgba;
  alpha: number;
  mode: BlendMode;
  /** Trait à passes (fusion, opacité partielle) : les jonctions comptent. */
  multi: boolean;
  /**
   * Budget d'un morceau (ms) : un morceau plus long, sur une carte déjà complexe (`heavyVertices`), arrête
   * l'aplatissement (`heavy`) — tourner longtemps au même endroit en fusion morcelle la carte en centaines de
   * régions, et chaque passe coûte plus que la précédente. Défaut : pas de limite.
   */
  budgetMs?: number;
  heavyVertices?: number;
};

/** Carte cible choisie au premier morceau : son rang, ses régions, ce qu'il y a dessous. */
export type Target = { index: number; regions: Region[]; back: Backdrop };

/** Disque polygonal (bout arrondi d'un morceau). */
export function capDisc(x: number, y: number, r: number, n = 48): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push([x + Math.cos((i / n) * Math.PI * 2) * r, y + Math.sin((i / n) * Math.PI * 2) * r]);
  return out;
}

const unionBox = (a: BBox | null, b: BBox): BBox => {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export class StrokeFlattener {
  private queue: Piece[] = [];
  private prev: Multi | null = null;
  private target: Target | null = null;
  private regions: Region[] = [];
  private box: BBox | null = null;
  private r = 0;
  private otol = 0;
  private lo = Infinity;
  private hi = -Infinity;
  /** Points après compaction, tous morceaux confondus (statistiques). */
  points = 0;
  /** Échec (découpage impossible, carte cible remise en cause) : le résultat est à refaire d'un bloc. */
  failed = false;
  /** Échec pour cause de coût (voir `budgetMs`) : refaire d'un bloc serait pire. */
  heavy = false;

  /**
   * `pick(bbox)` donne la carte cible pour l'emprise du trait ; elle est fixée au premier morceau, et chaque morceau
   * suivant vérifie qu'elle reste la même pour l'emprise agrandie (sinon : échec, calcul complet au lever).
   */
  constructor(private spec: FlattenSpec, private pick: (bbox: BBox) => Target) {}

  push(piece: Piece): void {
    if (!this.failed && piece.pts.length >= 3) this.queue.push(piece);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Traite des morceaux tant que `over()` est faux (au moins un si `atLeastOne`). */
  step(over: () => boolean, atLeastOne = false): void {
    let first = atLeastOne;
    while (this.queue.length && !this.failed && (first || !over())) {
      first = false;
      this.one(this.queue.shift()!);
    }
  }

  /** Termine tout ce qui reste ; null en cas d'échec. */
  finish(): Target | null {
    this.step(() => false);
    if (this.failed || !this.target) return null;
    return { ...this.target, regions: this.regions };
  }

  private one(piece: Piece): void {
    const s = this.spec;
    try {
      if (s.pressure) {
        for (let i = 2; i < piece.pts.length; i += 3) { this.lo = Math.min(this.lo, piece.pts[i]); this.hi = Math.max(this.hi, piece.pts[i]); }
        if (this.hi - this.lo > 0.02) return this.fail();
      }
      if (!this.r) {
        this.r = s.radius(piece.pts);
        this.otol = s.tolerance(this.r);
        if (!(this.r > 0)) return this.fail();
      }
      const pts = s.ztol > 0 ? compactStroke(piece.pts, s.ztol, s.ptol) : piece.pts;
      this.points += pts.length / 3 - (piece.joint === "start" ? 0 : 1);
      const full = strokeOutline(pts, this.r, this.otol);
      if (!full.length) return;
      let shape = full;
      if (s.multi && piece.joint === "pass") shape = safeBoolean("difference", full, [[capDisc(pts[0], pts[1], this.r)]]);
      else if (s.multi && piece.joint === "chunk" && this.prev) shape = safeBoolean("difference", full, this.prev);
      this.prev = full;
      this.box = unionBox(this.box, multiBBox(full));
      const t = this.pick(this.box);
      if (!this.target) {
        this.target = t;
        this.regions = t.regions;
      } else if (t.index !== this.target.index) {
        this.fail();
        return;
      }
      const t0 = performance.now();
      if (shape.length) this.regions = paintFlat(this.regions, shape, s.src, s.alpha, s.mode, this.target.back);
      if (s.budgetMs !== undefined && performance.now() - t0 > s.budgetMs && flatVertices(this.regions) > (s.heavyVertices ?? 0)) {
        this.heavy = true;
        this.fail();
      }
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    this.failed = true;
    this.queue = [];
  }
}

/** Budget d'un morceau pendant le geste (ms) et complexité de carte à partir de laquelle il s'applique. */
export const PIECE_BUDGET_MS = 40;
export const HEAVY_VERTICES = 1500;
