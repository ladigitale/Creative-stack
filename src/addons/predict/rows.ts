import { parseCsv, MAX_ROWS } from "./csv";
import type { Row } from "./data";

/** Lignes d'une valeur de DataProvider : tableau d'objets, `{ rows | items | data }`, ou texte CSV. */
export function rowsOf(v: unknown): { rows: Row[]; columns: string[] } {
  let x = v;
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o = x as Record<string, unknown>;
    x = o.rows ?? o.items ?? o.data ?? (typeof o.text === "string" ? o.text : x);
  }
  if (typeof x === "string") {
    if (!x.trim()) return { rows: [], columns: [] };
    const { columns, rows } = parseCsv(x);
    return { rows, columns };
  }
  if (!Array.isArray(x)) throw new Error("données attendues : tableau de lignes ou texte CSV");
  if (x.length > MAX_ROWS) throw new Error(`plus de ${MAX_ROWS} lignes`);
  const rows = x.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r));
  const cols = new Set<string>();
  for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) cols.add(k);
  return { rows, columns: [...cols] };
}
