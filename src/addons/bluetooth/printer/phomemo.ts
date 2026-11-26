import { rasterHeader } from "./luck";
import type { PaperType, PrintJob, PrinterInfo, PrinterLink, PrinterProtocol } from "./protocol";

/**
 * Imprimantes Phomemo. Trois familles, toutes en raster ESC/POS `GS v 0` (`1D 76 30 00 wL wH hL hH` + lignes,
 * bit de poids fort à gauche, 1 = noir), écrit par morceaux de 128 octets :
 *
 * - `phomemo-m02` (M02, M02S, T02 : tickets 384 points). Sûr : `1B 40` (initialisation), raster par bandes de
 *   255 lignes au plus, avance `1B 64 n`. Relevé dans les outils communautaires, rôle supposé : `1B 61 01`
 *   (centrage) et `1F 11 02 04` en tête, `1F 11 08`, `1F 11 0E`, `1F 11 07`, `1F 11 09` en fin (requêtes d'état
 *   du constructeur, sans effet sur l'impression d'après ces outils).
 * - `phomemo-m110` (M110, M120, M200 : étiquettes). Supposé : vitesse `1B 4E 0D n`, noirceur `1B 4E 04 n`
 *   (1..15), type de papier `1F 11 n` (`0A` étiquettes séparées, `0B` continu, `26` marque noire), fin
 *   `1F F0 05 00` puis `1F F0 03 00`.
 * - `phomemo-d30` (D30, D35 : étiquettes de 12 à 15 mm, tête de 96 points). Supposé : préambule `1F 11 24 00`
 *   avant `1B 40`, une seule bande raster, pas d'avance (l'imprimante s'arrête d'elle-même sur l'espace).
 *
 * Références (documentation communautaire, aucun code repris) : github.com/vivier/phomemo-tools (M02),
 * github.com/mkuhlmann/pyphomemo, github.com/transcriptionstream/phomymo (M110), github.com/polskafan/phomemo_d30.
 * Écrit d'après documentation, non testé sur matériel. Aucune commande de micrologiciel n'est envoyée.
 */
export type PhomemoVariant = "m02" | "m110" | "d30";
export const PHOMEMO_VARIANTS: PhomemoVariant[] = ["m02", "m110", "d30"];

export const PHOMEMO = {
  init: [0x1b, 0x40],
  center: [0x1b, 0x61, 0x01],
  m02Head: [0x1f, 0x11, 0x02, 0x04],
  m02Tail: [0x1f, 0x11, 0x08, 0x1f, 0x11, 0x0e, 0x1f, 0x11, 0x07, 0x1f, 0x11, 0x09],
  feed: (lines: number) => [0x1b, 0x64, Math.min(255, Math.max(0, Math.round(lines)))],
  speed: (v: number) => [0x1b, 0x4e, 0x0d, Math.min(5, Math.max(1, Math.round(v)))],
  density: (v: number) => [0x1b, 0x4e, 0x04, Math.min(15, Math.max(1, Math.round(v)))],
  paper: (type: PaperType) => [0x1f, 0x11, type === "continuous" ? 0x0b : type === "black-mark" ? 0x26 : 0x0a],
  m110Tail: [0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00],
  d30Head: [0x1f, 0x11, 0x24, 0x00],
} as const;

/** Taille des écritures (outils communautaires : 128 octets). */
export const PHOMEMO_CHUNK = 128;
const BAND_ROWS = 255;

/** Variante d'après le nom annoncé (`M110…`, `D30…`) ; `m02` par défaut. */
export function phomemoVariant(name: string): PhomemoVariant {
  const n = name.toUpperCase();
  if (/^(M110|M120|M200|M220|M221)/.test(n)) return "m110";
  if (/^(D30|D35|D50|Q30)/.test(n)) return "d30";
  return "m02";
}

/** Noirceur 0 clair, 1 normal, 2 foncé → échelle 1..15 de la M110 (supposée). */
export const phomemoDensity = (level: number): number => (Math.round(level) <= 0 ? 6 : Math.round(level) >= 2 ? 14 : 10);

/** Raster `GS v 0` par bandes de `bandRows` lignes au plus. */
export function phomemoRaster(job: Pick<PrintJob, "data" | "bytesPerRow" | "rows">, bandRows = BAND_ROWS): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let row = 0; row < job.rows; row += bandRows) {
    const rows = Math.min(bandRows, job.rows - row);
    const band = job.data.subarray(row * job.bytesPerRow, (row + rows) * job.bytesPerRow);
    const payload = new Uint8Array(8 + band.length);
    payload.set(rasterHeader(job.bytesPerRow, rows), 0);
    payload.set(band, 8);
    out.push(payload);
  }
  return out;
}

/** Écritures d'une impression, dans l'ordre. */
export function phomemoJob(variant: PhomemoVariant, job: PrintJob): (number[] | Uint8Array)[] {
  const out: (number[] | Uint8Array)[] = [];
  if (variant === "m02") {
    out.push([...PHOMEMO.init, ...PHOMEMO.center, ...PHOMEMO.m02Head]);
    out.push(...phomemoRaster(job));
    out.push([...PHOMEMO.feed(2), ...PHOMEMO.feed(2), ...PHOMEMO.m02Tail]);
  } else if (variant === "m110") {
    out.push([...PHOMEMO.speed(5), ...PHOMEMO.density(phomemoDensity(job.density)), ...PHOMEMO.paper(job.paper)]);
    out.push(...phomemoRaster(job, 0xffff));
    out.push([...PHOMEMO.m110Tail]);
  } else {
    out.push([...PHOMEMO.d30Head, ...PHOMEMO.init]);
    out.push(...phomemoRaster(job, 0xffff));
  }
  return out;
}

/** `variant` vide : choisie d'après le nom de l'appareil au moment d'imprimer. */
export function phomemoProtocol(variant: PhomemoVariant | "" = ""): PrinterProtocol {
  const lost = "imprimante déconnectée";
  return {
    id: variant ? `phomemo-${variant}` : "phomemo",
    async info(): Promise<PrinterInfo> {
      // Réponses d'état non documentées de façon sûre : rien n'est lu.
      return { model: null, firmware: null, battery: null, status: null };
    },
    async print(link: PrinterLink, job: PrintJob, onProgress): Promise<string | null> {
      const v = variant || phomemoVariant(link.pipe.deviceName);
      const writes = phomemoJob(v, job);
      for (let i = 0; i < writes.length; i++) {
        if (!(await link.send(writes[i], { chunkSize: PHOMEMO_CHUNK }))) return lost;
        await link.wait(30);
        onProgress(Math.min(0.95, (i + 1) / writes.length));
      }
      onProgress(1);
      return null;
    },
    feed: (link) => link.send(PHOMEMO.feed(4), { chunkSize: PHOMEMO_CHUNK }),
  };
}
