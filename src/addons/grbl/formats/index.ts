/**
 * Importeurs des formats de découpe et de gravure laser : reconnaissance du format (extension, type, signature),
 * puis conversion en SVG millimétré (dessins), en pixels (images que le navigateur ne lit pas) ou en programme
 * (G-code déjà préparé par un autre logiciel).
 */
import type { LaserOp } from "../toolpath";
import { MAX_GCODE_LINES } from "../toolpath";
import { MAX_SVG_OUT, writeSvg, type Shape } from "./geom";
import { readDxf } from "./dxf";
import { readHpgl } from "./hpgl";
import { readLightburn, type LightburnLayer } from "./lightburn";
import { readPdf } from "./pdf";
import { readPostScript } from "./ps";
import { inflate, latin1 } from "./pslex";
import { readTiff, type Pixels } from "./tiff";

export type ImportFormat = "svg" | "dxf" | "hpgl" | "pdf" | "ai" | "eps" | "lightburn" | "gcode" | "image" | "tiff";
export type ImportKind = "vector" | "image" | "program";

export const IMPORT_FORMATS: { id: ImportFormat; label: string; kind: ImportKind; ext: string[]; note: string }[] = [
  { id: "svg", label: "SVG", kind: "vector", ext: [".svg", ".svgz"], note: "Inkscape, Illustrator, Figma, LightBurn, xTool, Glowforge" },
  { id: "dxf", label: "DXF", kind: "vector", ext: [".dxf"], note: "AutoCAD, LibreCAD, QCAD, Fusion, FreeCAD, SolidWorks, RDWorks (DXF ASCII)" },
  { id: "pdf", label: "PDF", kind: "vector", ext: [".pdf"], note: "tracés vectoriels d'une page" },
  { id: "ai", label: "Illustrator", kind: "vector", ext: [".ai"], note: "compatibilité PDF (défaut) ou ancien format PostScript" },
  { id: "eps", label: "EPS / PostScript", kind: "vector", ext: [".eps", ".epsf", ".ps"], note: "CorelDraw, Inkscape, Illustrator" },
  { id: "hpgl", label: "HPGL / PLT", kind: "vector", ext: [".plt", ".hpgl", ".hgl", ".hpg", ".plo"], note: "CorelDraw, découpeuses vinyle, RDWorks" },
  { id: "lightburn", label: "LightBurn", kind: "vector", ext: [".lbrn2", ".lbrn"], note: "formes et réglages des calques" },
  { id: "gcode", label: "G-code", kind: "program", ext: [".gcode", ".gc", ".nc", ".ngc", ".tap", ".cnc", ".gco", ".g"], note: "programme prêt (LightBurn, LaserGRBL, Inkscape)" },
  { id: "image", label: "Image", kind: "image", ext: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"], note: "gravure par balayage ou vectorisation" },
  { id: "tiff", label: "TIFF", kind: "image", ext: [".tif", ".tiff"], note: "photos et scans" },
];

/** Valeur `accept` d'un `sonic-file-open` couvrant tous les formats lus. */
export const IMPORT_ACCEPT = [...IMPORT_FORMATS.flatMap((f) => f.ext), "image/*", "application/pdf", "image/svg+xml", "application/dxf", "application/postscript"].join(",");

/** Formats propriétaires reconnus pour donner un conseil d'export plutôt qu'une erreur muette. */
const UNSUPPORTED: Record<string, string> = {
  ".cdr": "CorelDraw (.cdr) est un format fermé : l'exporter en SVG, PDF, DXF ou PLT",
  ".xcs": "projet xTool Creative Space : l'exporter en SVG",
  ".rld": "fichier machine Ruida (.rld) : ouvrir le projet d'origine et l'exporter en SVG ou DXF",
  ".dwg": "DWG est un format fermé : l'enregistrer en DXF",
  ".gfx": "fichier Glowforge : l'exporter en SVG",
  ".skp": "SketchUp : exporter la vue en DXF ou PDF",
  ".stl": "STL est un volume 3D : en tirer une coupe ou une projection en SVG / DXF",
  ".lbrn2~": "",
  ".heic": "photo HEIC : l'enregistrer en JPEG",
  ".psd": "Photoshop : l'exporter en PNG",
};

const extOf = (name: string) => {
  const m = /\.[a-z0-9~]+$/i.exec(name.trim());
  return m ? m[0].toLowerCase() : "";
};

export function detectFormat(name: string, mime: string, head: Uint8Array): ImportFormat | null {
  const ext = extOf(name);
  const txt = latin1(head.subarray(0, 2048));
  const trimmed = txt.replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart();
  // Signatures d'abord (une extension peut mentir).
  if (trimmed.startsWith("%PDF")) return ext === ".ai" ? "ai" : "pdf";
  if ((head[0] === 0xc5 && head[1] === 0xd0 && head[2] === 0xd3 && head[3] === 0xc6) || trimmed.startsWith("%!PS")) return ext === ".ai" ? "ai" : "eps";
  if (head[0] === 0x1f && head[1] === 0x8b) return "svg";
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 42) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 42)) return "tiff";
  if (head[0] === 0x89 && head[1] === 0x50) return "image";
  if (head[0] === 0xff && head[1] === 0xd8) return "image";
  if (txt.startsWith("GIF8") || txt.startsWith("BM") && ext === ".bmp" || (txt.startsWith("RIFF") && txt.slice(8, 12) === "WEBP")) return "image";
  if (/<LightBurnProject[\s>]/.test(txt)) return "lightburn";
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(trimmed) || /<svg[\s>]/i.test(txt) && (ext === ".svg" || mime === "image/svg+xml")) return "svg";
  if (/^\s*0\s*\r?\n\s*SECTION\s*\r?\n/.test(txt) || /^\s*999\s*\r?\n/.test(txt) || txt.startsWith("AutoCAD Binary DXF")) return "dxf";
  for (const f of IMPORT_FORMATS) if (f.ext.includes(ext)) return f.id;
  if (/^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(mime)) return "image";
  if (mime === "image/tiff") return "tiff";
  if (mime === "application/pdf") return "pdf";
  if (/^(IN|IN;|PU|SP\d|\x1b\.)/i.test(trimmed) || /;\s*(PU|PD)[\d\s,;-]/i.test(txt.slice(0, 400))) return "hpgl";
  if (/^\s*(;|\(|%|G[0-3]?\d\b|M[0-9]+\b|\$H|G21|G90)/im.test(trimmed) && /\bG0*[01]\b/i.test(txt)) return "gcode";
  return null;
}

export type ImportResult = {
  format: ImportFormat;
  kind: ImportKind;
  /** Dessins : SVG en millimètres réels. */
  svg: string | null;
  widthMm: number;
  heightMm: number;
  /** Couleurs présentes (une opération par couleur dans `sonic-gcode ops`). */
  colors: string[];
  /** Réglages proposés par le fichier (calques LightBurn), à reprendre dans `ops`. */
  ops: LaserOp[] | null;
  layers: { name: string; color: string; mode?: string; power?: number; speed?: number; passes?: number }[];
  /** Programme G-code prêt (format `gcode`). */
  gcode: string[] | null;
  /** Image décodée (TIFF) ; les autres images restent lues par le navigateur. */
  pixels: Pixels | null;
  pages: number;
  skipped: Record<string, number>;
  issues: string[];
};

export class ImportError extends Error {}

/** Message d'aide pour un format reconnu mais non lu, ou `null`. */
export function unsupportedHint(name: string): string | null {
  const h = UNSUPPORTED[extOf(name)];
  return h || null;
}

const MAX_FILE = 80_000_000;

export async function importBytes(bytes: Uint8Array, opts: { name?: string; mime?: string; page?: number; format?: ImportFormat | "auto" } = {}): Promise<ImportResult> {
  const name = opts.name ?? "";
  if (bytes.length > MAX_FILE) throw new ImportError("fichier trop gros (80 Mo au plus)");
  if (!bytes.length) throw new ImportError("fichier vide");
  const format = opts.format && opts.format !== "auto" ? opts.format : detectFormat(name, opts.mime ?? "", bytes.subarray(0, 4096));
  if (!format) throw new ImportError(unsupportedHint(name) ?? `format non reconnu${extOf(name) ? ` (${extOf(name)})` : ""} : SVG, DXF, PDF, AI, EPS, PLT, LightBurn, G-code ou image`);
  const base: ImportResult = { format, kind: IMPORT_FORMATS.find((f) => f.id === format)!.kind, svg: null, widthMm: 0, heightMm: 0, colors: [], ops: null, layers: [], gcode: null, pixels: null, pages: 1, skipped: {}, issues: [] };
  const vector = (shapes: Shape[], unitMm: number, yUp: boolean, page: { x: number; y: number; w: number; h: number } | null, skipped: Record<string, number>, issues: string[]): ImportResult => {
    const out = writeSvg(shapes, { unitMm, yUp, page });
    if (!out) throw new ImportError(Object.keys(skipped).length ? `aucun tracé lisible (ignorés : ${Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(", ")})` : "aucun tracé dans ce fichier");
    if (out.svg.length > MAX_SVG_OUT) issues.push("dessin très lourd : la préparation peut être lente");
    return { ...base, svg: out.svg, widthMm: out.widthMm, heightMm: out.heightMm, colors: out.colors, skipped, issues };
  };
  switch (format) {
    case "svg": {
      let data = bytes;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) data = await inflate(bytes, "gzip");
      const text = new TextDecoder().decode(data);
      const start = text.search(/<svg[\s>]/i);
      if (start < 0) throw new ImportError("SVG illisible");
      const size = /<svg[^>]*\swidth\s*=\s*["']([\d.]+)(mm|cm|in|pt|px)?["'][^>]*\sheight\s*=\s*["']([\d.]+)(mm|cm|in|pt|px)?["']/i.exec(text);
      const k = (u?: string) => (u === "mm" ? 1 : u === "cm" ? 10 : u === "in" ? 25.4 : u === "pt" ? 25.4 / 72 : 25.4 / 96);
      const colors = [...new Set((text.match(/(?:fill|stroke)\s*[:=]\s*["']?(#[0-9a-fA-F]{3,6})/g) ?? []).map((s) => s.replace(/.*(#[0-9a-fA-F]{3,6}).*/, "$1").toLowerCase()))];
      return { ...base, svg: text, widthMm: size ? Math.round(Number(size[1]) * k(size[2]) * 100) / 100 : 0, heightMm: size ? Math.round(Number(size[3]) * k(size[4]) * 100) / 100 : 0, colors };
    }
    case "dxf": {
      const r = readDxf(new TextDecoder("latin1").decode(bytes));
      return { ...vector(r.shapes, r.unitMm, true, null, r.skipped, r.issues), layers: r.layers };
    }
    case "hpgl": {
      const r = readHpgl(latin1(bytes));
      return vector(r.shapes, r.unitMm, true, null, r.skipped, r.issues);
    }
    case "pdf":
    case "ai": {
      const head = latin1(bytes.subarray(0, 1024));
      if (!head.includes("%PDF")) {
        const r = readPostScript(bytes);
        return vector(r.shapes, r.unitMm, true, r.page, r.skipped, r.issues);
      }
      const r = await readPdf(bytes, opts.page ?? 1);
      return { ...vector(r.shapes, r.unitMm, true, r.page, r.skipped, r.issues), pages: r.pages };
    }
    case "eps": {
      const r = readPostScript(bytes);
      return vector(r.shapes, r.unitMm, true, r.page, r.skipped, r.issues);
    }
    case "lightburn": {
      const r = readLightburn(new TextDecoder().decode(bytes));
      const out = vector(r.shapes, 1, true, null, r.skipped, r.issues);
      return { ...out, ops: r.ops.length ? r.ops : null, layers: r.layers.map((l: LightburnLayer) => ({ name: l.name, color: l.color, mode: l.mode, power: l.power, speed: l.speed, passes: l.passes })) };
    }
    case "gcode": {
      const lines = readGcodeText(new TextDecoder().decode(bytes));
      if (!lines.length) throw new ImportError("aucun mouvement G0 / G1 dans ce G-code");
      const issues: string[] = [];
      if (lines.length > MAX_GCODE_LINES) throw new ImportError(`programme trop long (${lines.length} lignes, ${MAX_GCODE_LINES} au plus)`);
      if (lines.some((l) => /^\$/.test(l))) issues.push("commandes $ du programme retirées (réglages machine protégés)");
      if (lines.some((l) => /\bG20\b/i.test(l))) issues.push("programme en pouces (G20)");
      return { ...base, gcode: lines.filter((l) => !/^\$/.test(l)), issues };
    }
    case "tiff": {
      const px = await readTiff(bytes);
      return { ...base, pixels: px, widthMm: px.dpi ? Math.round((px.width / px.dpi) * 254) / 10 : 0, heightMm: px.dpi ? Math.round((px.height / px.dpi) * 254) / 10 : 0 };
    }
    case "image":
      return base;
  }
}

/** Lignes d'un G-code : sans `%`, sans lignes vides ; les commentaires sont gardés (retirés à l'envoi). */
export function readGcodeText(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l && l !== "%");
  return lines.some((l) => /\bG0*[0-3]\b/i.test(l.replace(/\(.*?\)|;.*$/g, ""))) ? lines : [];
}

export { readDxf, aciColor } from "./dxf";
export { readHpgl } from "./hpgl";
export { readPdf } from "./pdf";
export { readPostScript } from "./ps";
export { readLightburn, LIGHTBURN_COLORS } from "./lightburn";
export { readTiff, type Pixels } from "./tiff";
export { writeSvg, type Shape } from "./geom";
