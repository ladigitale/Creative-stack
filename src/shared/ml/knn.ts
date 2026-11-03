/**
 * Classificateur k plus proches voisins (distance euclidienne) : « Teachable Machine » minimal, sans modèle ni
 * réseau. Les exemples sont des vecteurs étiquetés ; la classe prédite est le vote pondéré (1 / distance) des k
 * plus proches. Sérialisable pour la mémoire locale.
 */

export type Prediction = {
  label: string;
  /** Part du vote pondéré remportée par `label` (0..1). */
  confidence: number;
  /** Vote pondéré par étiquette, somme = 1. */
  scores: Record<string, number>;
  /** Distance au plus proche exemple de chaque étiquette. */
  distances: Record<string, number>;
  /** Distance au plus proche exemple (toutes étiquettes). */
  nearest: number;
};

export type KnnState = { v: 1; dim: number; examples: Array<{ label: string; vec: number[] }> };

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
};

export class KnnClassifier {
  private examples: Array<{ label: string; vec: number[] }> = [];
  private dim = 0;

  constructor(
    public k = 3,
    /** Plafond d'exemples gardés ; au-delà, les plus anciens de l'étiquette la plus fournie sont retirés. */
    public maxExamples = 2000,
  ) {}

  get size(): number {
    return this.examples.length;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.examples) out[e.label] = (out[e.label] ?? 0) + 1;
    return out;
  }

  /** Ajoute un exemple. Refuse (false) un vecteur invalide ou de dimension différente des exemples déjà là. */
  add(label: string, vec: ArrayLike<number>): boolean {
    if (!label || vec.length === 0) return false;
    for (let i = 0; i < vec.length; i++) if (!Number.isFinite(vec[i])) return false;
    if (this.examples.length === 0) this.dim = vec.length;
    else if (vec.length !== this.dim) return false;
    this.examples.push({ label, vec: Array.from(vec) });
    if (this.examples.length > this.maxExamples) {
      const counts = this.counts();
      const biggest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      const idx = this.examples.findIndex((e) => e.label === biggest);
      this.examples.splice(idx, 1);
    }
    return true;
  }

  /** Efface une étiquette, ou tout si aucune. */
  clear(label?: string): void {
    this.examples = label ? this.examples.filter((e) => e.label !== label) : [];
    if (this.examples.length === 0) this.dim = 0;
  }

  classify(vec: ArrayLike<number>): Prediction | null {
    if (this.examples.length === 0 || vec.length !== this.dim) return null;
    const ranked = this.examples.map((e) => ({ label: e.label, d: dist(e.vec, vec) })).sort((a, b) => a.d - b.d);
    const distances: Record<string, number> = {};
    for (const r of ranked) if (!(r.label in distances)) distances[r.label] = r.d;
    const top = ranked.slice(0, Math.max(1, Math.min(this.k, ranked.length)));
    const votes: Record<string, number> = {};
    let total = 0;
    for (const r of top) {
      const w = 1 / (r.d + 1e-6);
      votes[r.label] = (votes[r.label] ?? 0) + w;
      total += w;
    }
    const scores: Record<string, number> = {};
    for (const l of Object.keys(distances)) scores[l] = (votes[l] ?? 0) / total;
    const label = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    return { label, confidence: scores[label], scores, distances, nearest: ranked[0].d };
  }

  serialize(): KnnState {
    return { v: 1, dim: this.dim, examples: this.examples.map((e) => ({ label: e.label, vec: e.vec })) };
  }

  /** Remplace le contenu ; ignore silencieusement un état invalide (retourne false). */
  load(state: unknown): boolean {
    const s = state as Partial<KnnState> | null;
    if (!s || s.v !== 1 || typeof s.dim !== "number" || !Array.isArray(s.examples)) return false;
    const next: Array<{ label: string; vec: number[] }> = [];
    for (const e of s.examples) {
      if (!e || typeof e.label !== "string" || !Array.isArray(e.vec) || e.vec.length !== s.dim || e.vec.some((v) => typeof v !== "number" || !Number.isFinite(v))) return false;
      next.push({ label: e.label, vec: e.vec });
    }
    this.examples = next.slice(-this.maxExamples);
    this.dim = next.length ? s.dim : 0;
    return true;
  }
}
