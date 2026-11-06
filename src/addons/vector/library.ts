import { multiArea, multiBBox, type BBox } from "./geometry";
import { pathToMulti } from "./ops";
import { parsePath } from "./svgpath";

/**
 * Bibliothèque d'objets vectoriels : formes nommées, étiquetées, stockées comme chemins SVG
 * (la courbe d'origine est conservée ; les opérations travaillent sur une copie aplatie).
 */

export type VectorShape = { id: string; name: string; d: string; tags: string[] };
export type ShapeInfo = VectorShape & { bbox: BBox; area: number };

export const MAX_SHAPES = 500;
export const MAX_TOTAL_CHARS = 2_000_000;

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Valide une forme brute : `d` doit être un chemin lisible, id / nom / étiquettes sont assainis. */
export function normalizeShape(input: unknown): { shape?: Omit<VectorShape, "id"> & { id?: string }; error?: string } {
  if (!input || typeof input !== "object") return { error: "forme invalide" };
  const o = input as Record<string, unknown>;
  const d = typeof o.d === "string" ? o.d.trim() : "";
  if (!d) return { error: "chemin `d` manquant" };
  if (!parsePath(d)) return { error: "chemin `d` illisible ou trop volumineux" };
  let id: string | undefined;
  if (o.id !== undefined) {
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return { error: "id invalide (lettres, chiffres, _ . : -, 64 max)" };
    id = o.id;
  }
  const name = typeof o.name === "string" ? o.name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) : "";
  const tags = Array.isArray(o.tags) ? [...new Set(o.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 12) : [];
  return { shape: { id, name: name || id || "forme", d, tags } };
}

export class ShapeLibrary {
  private map = new Map<string, VectorShape>();
  private info = new Map<string, ShapeInfo>();
  private chars = 0;

  get size(): number {
    return this.map.size;
  }

  /** Ajoute (ou remplace) une forme ; retourne l'id retenu ou une erreur. */
  add(input: unknown): { id?: string; error?: string } {
    const { shape, error } = normalizeShape(input);
    if (!shape) return { error };
    let id = shape.id;
    if (!id) {
      const base = slug(shape.name) || "forme";
      id = base;
      for (let i = 2; this.map.has(id); i++) id = `${base}-${i}`;
    }
    const prev = this.map.get(id);
    if (!prev && this.map.size >= MAX_SHAPES) return { error: `bibliothèque pleine (${MAX_SHAPES} formes)` };
    if (this.chars - (prev?.d.length ?? 0) + shape.d.length > MAX_TOTAL_CHARS) return { error: "bibliothèque trop volumineuse" };
    this.chars += shape.d.length - (prev?.d.length ?? 0);
    const full: VectorShape = { id, name: shape.name, d: shape.d, tags: shape.tags };
    this.map.set(id, full);
    const m = pathToMulti(shape.d) ?? [];
    this.info.set(id, { ...full, bbox: multiBBox(m), area: multiArea(m) });
    return { id };
  }

  remove(id: string): boolean {
    const s = this.map.get(id);
    if (!s) return false;
    this.chars -= s.d.length;
    this.map.delete(id);
    this.info.delete(id);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.info.clear();
    this.chars = 0;
  }

  get(id: string): ShapeInfo | null {
    return this.info.get(id) ?? null;
  }

  rename(id: string, name: string): boolean {
    const s = this.map.get(id);
    const i = this.info.get(id);
    if (!s || !i) return false;
    s.name = i.name = String(name).slice(0, 80);
    return true;
  }

  /** Formes triées par nom ; `tag` et `query` (sous-chaîne du nom) filtrent. */
  list(filter: { tag?: string; query?: string } = {}): ShapeInfo[] {
    const q = filter.query?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    return [...this.info.values()]
      .filter((s) => (!tag || s.tags.includes(tag)) && (!q || s.name.toLowerCase().includes(q) || s.id.includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  toJSON(): VectorShape[] {
    return [...this.map.values()].map((s) => ({ ...s, tags: [...s.tags] }));
  }

  /** Reconstruit depuis un tableau (les formes invalides sont ignorées et comptées). */
  load(items: unknown): { loaded: number; rejected: number } {
    this.clear();
    let loaded = 0, rejected = 0;
    for (const it of Array.isArray(items) ? items : []) {
      if (this.add(it).id) loaded++;
      else rejected++;
    }
    return { loaded, rejected };
  }
}
