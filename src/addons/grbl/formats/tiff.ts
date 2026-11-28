/**
 * TIFF (scanners, Photoshop, GIMP : souvent utilisé pour les photos à graver) → pixels RGBA.
 * Les navigateurs (sauf Safari) ne le décodent pas. Lu : première image, bandes ou tuiles, sans compression,
 * PackBits, LZW, Deflate (prédicteur horizontal), 1, 4, 8 ou 16 bits, gris (blanc ou noir = 0), RVB, palette,
 * CMJN, canal alpha. JPEG dans TIFF non pris en charge.
 */
import { lzw } from "./pdf";
import { inflate } from "./pslex";

export type Pixels = { width: number; height: number; data: Uint8ClampedArray; dpi: number | null };

const MAX_PIXELS = 40_000_000;

export async function readTiff(bytes: Uint8Array): Promise<Pixels> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!le && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw new Error("pas un fichier TIFF");
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  if (u16(2) === 43) throw new Error("BigTIFF non pris en charge");
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = new Map<number, number[]>();
  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = (SIZE[type] ?? 1) * count;
    const off = size <= 4 ? e + 8 : u32(e + 8);
    const vals: number[] = [];
    for (let i = 0; i < Math.min(count, 1 << 20); i++) {
      const o = off + i * (SIZE[type] ?? 1);
      if (o + (SIZE[type] ?? 1) > bytes.length) break;
      vals.push(type === 3 || type === 8 ? u16(o) : type === 4 || type === 9 ? u32(o) : type === 5 ? u32(o) / (u32(o + 4) || 1) : bytes[o]);
    }
    tags.set(tag, vals);
  }
  const t = (k: number, d = 0) => tags.get(k)?.[0] ?? d;
  const width = t(256), height = t(257);
  if (!width || !height || width * height > MAX_PIXELS) throw new Error("taille d'image TIFF invalide ou trop grande");
  const spp = t(277, 1);
  const bps = tags.get(258)?.[0] ?? 1;
  const comp = t(259, 1);
  const photo = t(262, spp >= 3 ? 2 : 1);
  const planar = t(284, 1);
  const predictor = t(317, 1);
  const extra = tags.get(338)?.length ?? 0;
  if (comp === 6 || comp === 7) throw new Error("TIFF compressé en JPEG : l'enregistrer en PNG");
  if (planar !== 1 && spp > 1) throw new Error("TIFF en plans séparés non pris en charge");
  const tiled = tags.has(322);
  const offsets = tags.get(tiled ? 324 : 273) ?? [];
  const counts = tags.get(tiled ? 325 : 279) ?? [];
  const tw = tiled ? t(322) : width, th = tiled ? t(323) : t(278, height);
  const rowBytes = Math.ceil((tw * spp * bps) / 8);
  const decode = async (raw: Uint8Array): Promise<Uint8Array> => {
    let d: Uint8Array;
    if (comp === 1) d = raw;
    else if (comp === 5) d = lzw(raw, true);
    else if (comp === 8 || comp === 32946) d = await inflate(raw);
    else if (comp === 32773) {
      const out: number[] = [];
      for (let i = 0; i < raw.length;) {
        const c = (raw[i++] << 24) >> 24;
        if (c >= 0) for (let k = 0; k <= c && i < raw.length; k++) out.push(raw[i++]);
        else if (c !== -128) { const b = raw[i++]; for (let k = 0; k < 1 - c; k++) out.push(b); }
      }
      d = Uint8Array.from(out);
    } else throw new Error(`compression TIFF ${comp} non prise en charge`);
    if (predictor === 2 && bps === 8) {
      d = d.slice();
      for (let r = 0; r * rowBytes < d.length; r++) for (let i = spp; i < rowBytes; i++) d[r * rowBytes + i] = (d[r * rowBytes + i] + d[r * rowBytes + i - spp]) & 255;
    }
    return d;
  };
  // Échantillon normalisé 0..1.
  const sampleAt = (d: Uint8Array, bit: number): number => {
    if (bps === 8) return d[bit >> 3] / 255;
    if (bps === 16) {
      const o = bit >> 3;
      return (le ? d[o] | (d[o + 1] << 8) : (d[o] << 8) | d[o + 1]) / 65535;
    }
    const byte = d[bit >> 3], shift = 8 - bps - (bit & 7);
    return ((byte >> shift) & ((1 << bps) - 1)) / ((1 << bps) - 1);
  };
  const map = tags.get(320);
  const out = new Uint8ClampedArray(width * height * 4);
  const across = tiled ? Math.ceil(width / tw) : 1;
  for (let s = 0; s < offsets.length; s++) {
    const raw = bytes.subarray(offsets[s], offsets[s] + (counts[s] ?? 0));
    const d = await decode(raw);
    const ox = tiled ? (s % across) * tw : 0;
    const oy = tiled ? Math.floor(s / across) * th : s * th;
    for (let y = 0; y < th && oy + y < height; y++) {
      for (let x = 0; x < tw; x++) {
        if (ox + x >= width) continue;
        const base = y * rowBytes * 8 + x * spp * bps;
        const c = (k: number) => sampleAt(d, base + k * bps);
        let r: number, g: number, b: number, a = 1;
        if (photo === 2) { r = c(0); g = c(1); b = c(2); if (extra) a = c(3); }
        else if (photo === 5) { const k = c(3); r = (1 - c(0)) * (1 - k); g = (1 - c(1)) * (1 - k); b = (1 - c(2)) * (1 - k); }
        else if (photo === 3 && map) {
          const i = Math.round(c(0) * ((1 << bps) - 1)), m = map.length / 3;
          r = map[i] / 65535; g = map[m + i] / 65535; b = map[2 * m + i] / 65535;
        } else {
          const v = photo === 0 ? 1 - c(0) : c(0);
          r = g = b = v;
          if (spp > 1 && extra) a = c(1);
        }
        const o = ((oy + y) * width + ox + x) * 4;
        out[o] = r * 255; out[o + 1] = g * 255; out[o + 2] = b * 255; out[o + 3] = a * 255;
      }
    }
  }
  const xres = tags.get(282)?.[0];
  const unit = t(296, 2);
  const dpi = xres ? (unit === 3 ? xres * 2.54 : xres) : null;
  return { width, height, data: out, dpi };
}
