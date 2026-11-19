import { extractFeatures } from "./features";
import { buildPyramid, trackChecked, type Pyramid } from "./flow";
import type { Gray } from "./image";
import type { Pt } from "./homography";
import { decodeReference, fitPairs, locate, type DecodedReference, type Pairs } from "./reference";

/**
 * Moteur d'ancrage sans DOM (fil principal ou worker) : détecte la zone par appariement de descripteurs,
 * puis la suit image par image par flot optique, bien moins cher ; redétecte quand le suivi s'appauvrit.
 */

export type EngineOptions = {
  /** Indices des références à essayer en détection, dans l'ordre (la référence suivie passe toujours d'abord). */
  order: number[];
  up: Pt | null;
  gravityTolerance: number;
  minInliers: number;
  maxPoints: number;
  /** Points suivis au plus. */
  trackPoints: number;
  /** Suivi seul, sans redétection, au plus pendant ce nombre d'images. */
  refreshEvery: number;
};

export type EngineResult = {
  found: boolean;
  index: number;
  /** Coins en pixels de l'image analysée. */
  corners: Pt[] | null;
  matches: number;
  inliers: number;
  confidence: number;
  rotation: number | null;
  mode: "detect" | "track" | "none";
  ms: number;
};

type Track = { index: number; pyr: Pyramid; pairs: Pairs; initial: number; age: number };

export const ENGINE_DEFAULTS: EngineOptions = { order: [], up: null, gravityTolerance: 45, minInliers: 14, maxPoints: 700, trackPoints: 120, refreshEvery: 30 };

export class AnchorEngine {
  refs: Array<DecodedReference | null> = [];
  private track: Track | null = null;

  /** Références brutes (JSON) ; `null` pour une entrée illisible (l'index reste aligné). */
  setReferences(list: unknown[]): number {
    this.refs = list.map((r) => decodeReference(r));
    this.track = null;
    return this.refs.filter(Boolean).length;
  }

  reset(): void {
    this.track = null;
  }

  get tracking(): number {
    return this.track ? this.track.index : -1;
  }

  process(gray: Gray, o: Partial<EngineOptions> = {}): EngineResult {
    const opts = { ...ENGINE_DEFAULTS, ...o };
    const t0 = now();
    const pyr = buildPyramid(gray, 3);
    const fitOpts = { up: opts.up, gravityTolerance: opts.gravityTolerance, minInliers: opts.minInliers };
    let best = { matches: 0, inliers: 0 };

    // 1. Suivi de la zone déjà trouvée.
    const tr = this.track;
    if (tr && this.refs[tr.index]) {
      const ref = this.refs[tr.index]!;
      const f = trackChecked(tr.pyr, pyr, tr.pairs.dx, tr.pairs.dy, 1.2);
      const p = subset(tr.pairs, f);
      const res = fitPairs(ref, gray.width, gray.height, p, { ...fitOpts, maxIterations: 120 });
      if (res.found && res.pairs && res.inliers >= Math.max(opts.minInliers, tr.initial * 0.25)) {
        tr.age++;
        const weak = res.inliers < Math.max(opts.minInliers * 2, tr.initial * 0.5);
        if ((weak || tr.age >= opts.refreshEvery)) {
          // Regarnir : redétection sur la même référence ; gardée si elle trouve au moins autant.
          const fresh = locate(ref, extractFeatures(gray, { maxPoints: opts.maxPoints, levels: 4 }), fitOpts);
          if (fresh.found && fresh.pairs && fresh.inliers >= res.inliers) {
            const pairs = limit(fresh.pairs, opts.trackPoints);
            this.track = { index: tr.index, pyr, pairs, initial: pairs.n, age: 0 };
            return out(fresh, tr.index, "detect", t0);
          }
        }
        this.track = { ...tr, pyr, pairs: res.pairs };
        return out(res, tr.index, "track", t0);
      }
      best = { matches: res.matches, inliers: res.inliers };
      this.track = null;
    }

    // 2. Détection.
    const order = opts.order.filter((i) => this.refs[i]);
    if (!order.length) return { ...NONE, ...best, ms: now() - t0 };
    const feats = extractFeatures(gray, { maxPoints: opts.maxPoints, levels: 4 });
    for (const i of order) {
      const res = locate(this.refs[i]!, feats, fitOpts);
      if (res.matches > best.matches) best = { matches: res.matches, inliers: res.inliers };
      if (res.found && res.pairs) {
        const pairs = limit(res.pairs, opts.trackPoints);
        this.track = { index: i, pyr, pairs, initial: pairs.n, age: 0 };
        return out(res, i, "detect", t0);
      }
    }
    return { ...NONE, ...best, ms: now() - t0 };
  }
}

const NONE: EngineResult = { found: false, index: -1, corners: null, matches: 0, inliers: 0, confidence: 0, rotation: null, mode: "none", ms: 0 };

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function out(r: { corners: Pt[] | null; matches: number; inliers: number; confidence: number; rotation: number | null }, index: number, mode: "detect" | "track", t0: number): EngineResult {
  return { found: true, index, corners: r.corners, matches: r.matches, inliers: r.inliers, confidence: r.confidence, rotation: r.rotation, mode, ms: now() - t0 };
}

/** Garde les correspondances suivies avec succès, positions mises à jour. */
function subset(p: Pairs, f: { x: Float32Array; y: Float32Array; ok: Uint8Array }): Pairs {
  let n = 0;
  for (let i = 0; i < p.n; i++) if (f.ok[i]) n++;
  const q: Pairs = { sx: new Float64Array(n), sy: new Float64Array(n), dx: new Float64Array(n), dy: new Float64Array(n), n };
  for (let i = 0, k = 0; i < p.n; i++) {
    if (!f.ok[i]) continue;
    q.sx[k] = p.sx[i]; q.sy[k] = p.sy[i]; q.dx[k] = f.x[i]; q.dy[k] = f.y[i]; k++;
  }
  return q;
}

/** Au plus `max` correspondances, prises régulièrement dans la liste (garde la répartition spatiale). */
function limit(p: Pairs, max: number): Pairs {
  if (p.n <= max) return p;
  const step = p.n / max;
  const q: Pairs = { sx: new Float64Array(max), sy: new Float64Array(max), dx: new Float64Array(max), dy: new Float64Array(max), n: max };
  for (let k = 0; k < max; k++) {
    const i = Math.floor(k * step);
    q.sx[k] = p.sx[i]; q.sy[k] = p.sy[i]; q.dx[k] = p.dx[i]; q.dy[k] = p.dy[i];
  }
  return q;
}
