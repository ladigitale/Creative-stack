import type { Stroke } from "./model";
import { readStrokes, writeStrokes } from "./store";
import { SOURCE_ID, type SvgSource } from "./export";

/**
 * Traits d'origine embarqués dans un SVG exporté (`<metadata id="sonic-sketch-source">`) : le rendu reste un SVG
 * ordinaire, lisible partout ; `sonic-sketch` sait le rouvrir trait par trait (pinceaux, fusions, gomme compris).
 */

/** Nombres arrondis à 3 décimales (positions en unités du dessin, pressions 0..1) : la source reste légère. */
const round = (_k: string, v: unknown) => (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);

/** Taille max du JSON décompressé relu (garde-fou contre une bombe gzip). */
export const MAX_SOURCE_CHARS = 16_000_000;

export async function encodeSource(strokes: Stroke[]): Promise<SvgSource> {
  const json = JSON.stringify({ v: 1, strokes: writeStrokes(strokes) }, round);
  if (typeof CompressionStream === "undefined") return { format: "json", data: json };
  try {
    const gz = await new Response(new Response(json).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    return { format: "gz64", data: toBase64(new Uint8Array(gz)) };
  } catch {
    return { format: "json", data: json };
  }
}

/** Traits relus d'un SVG produit avec sa source, ou `null` (SVG sans source, illisible ou invalide). */
export async function decodeSource(svg: string): Promise<Stroke[] | null> {
  if (typeof DOMParser === "undefined" || !svg.includes(SOURCE_ID)) return null;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const meta = [...doc.getElementsByTagName("metadata")].find((m) => m.getAttribute("id") === SOURCE_ID);
  const text = meta?.textContent?.trim() ?? "";
  if (!text) return null;
  let json = text;
  if (meta!.getAttribute("data-format") === "gz64") {
    if (typeof DecompressionStream === "undefined") return null;
    try {
      const bytes = fromBase64(text);
      const stream = new Response(bytes as BodyInit).body!.pipeThrough(new DecompressionStream("gzip"));
      json = await readCapped(stream);
    } catch {
      return null;
    }
  }
  try {
    const o = JSON.parse(json) as { v?: unknown; strokes?: unknown };
    return o && o.v === 1 ? readStrokes(o.strokes) : null;
  } catch {
    return null;
  }
}

/** Texte d'un SVG donné en texte, en URL `data:image/svg+xml`, en `blob:` ou en `{url}`. */
export async function svgText(v: unknown): Promise<string | null> {
  const s = typeof v === "string" ? v.trim() : v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string" ? String((v as { url: string }).url).trim() : "";
  if (!s) return null;
  if (s.startsWith("<")) return s.length <= MAX_SOURCE_CHARS ? s : null;
  const m = /^data:image\/svg\+xml(;[^,]*)?,/i.exec(s);
  if (m) {
    const body = s.slice(m[0].length);
    try {
      return /;base64/i.test(m[1] ?? "") ? new TextDecoder().decode(fromBase64(body)) : decodeURIComponent(body);
    } catch {
      return null;
    }
  }
  if (s.startsWith("blob:")) {
    try {
      const blob = await (await fetch(s)).blob();
      return blob.size <= MAX_SOURCE_CHARS ? await blob.text() : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
    if (out.length > MAX_SOURCE_CHARS) { await reader.cancel(); throw new Error("source trop grande"); }
  }
  return out + dec.decode();
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
