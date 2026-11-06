/** Lecture de CSV / TSV (guillemets, séparateur détecté, retours à la ligne dans les champs). */

export const MAX_CSV_CHARS = 8_000_000;
export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 200;

export type Row = Record<string, string>;

function detectDelimiter(head: string): string {
  const line = head.split(/\r?\n/, 1)[0] ?? "";
  let best = ",", n = -1;
  for (const d of [",", ";", "\t", "|"]) {
    let inQ = false, c = 0;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === d && !inQ) c++;
    }
    if (c > n) { n = c; best = d; }
  }
  return best;
}

/** Lignes d'un CSV avec en-tête. Lève une erreur au-delà des bornes ou si l'en-tête est inutilisable. */
export function parseCsv(text: string): { columns: string[]; rows: Row[] } {
  if (text.length > MAX_CSV_CHARS) throw new Error("fichier trop gros");
  const src = text.replace(/^﻿/, "");
  const delim = detectDelimiter(src);
  const records: string[][] = [];
  let field = "", rec: string[] = [], inQ = false;
  const endField = () => { rec.push(field); field = ""; };
  const endRecord = () => { endField(); if (rec.length > 1 || rec[0] !== "") records.push(rec); rec = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"' && field === "") inQ = true;
    else if (ch === delim) endField();
    else if (ch === "\n") endRecord();
    else if (ch === "\r") { /* ignoré : \r\n */ }
    else field += ch;
    if (records.length > MAX_ROWS + 1) throw new Error(`plus de ${MAX_ROWS} lignes`);
  }
  if (field !== "" || rec.length) endRecord();
  if (records.length < 2) throw new Error("il faut une ligne d'en-tête et au moins une ligne de données");
  const columns = records[0].map((c, i) => c.trim() || `col${i + 1}`);
  if (columns.length > MAX_COLUMNS) throw new Error(`plus de ${MAX_COLUMNS} colonnes`);
  const seen = new Map<string, number>();
  const names = columns.map((c) => {
    const n = seen.get(c) ?? 0;
    seen.set(c, n + 1);
    return n ? `${c}_${n + 1}` : c;
  });
  const rows = records.slice(1).map((r) => {
    const o: Row = {};
    names.forEach((c, i) => { o[c] = (r[i] ?? "").trim(); });
    return o;
  });
  return { columns: names, rows };
}
