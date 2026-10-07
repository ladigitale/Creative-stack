/**
 * MediaRecorder (Chrome, Firefox) écrit des WebM sans durée : les lecteurs
 * n'affichent pas la longueur et se déplacent mal dans le fichier.
 * `withWebmDuration` ajoute l'élément Duration dans Segment > Info.
 * Pur (octets en entrée, octets en sortie), sans dépendance.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_DURATION = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_CLUSTER = 0x1f43b675;

type Vint = { value: number; length: number; unknown: boolean };

function vintLength(first: number): number {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

/** Identifiant d'élément (marqueur de longueur conservé). */
function readId(b: Uint8Array, pos: number): Vint | null {
  const length = vintLength(b[pos] ?? 0);
  if (!length || length > 4 || pos + length > b.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + b[pos + i];
  return { value, length, unknown: false };
}

/** Taille de données (marqueur retiré ; « inconnue » si tous les bits sont à 1). */
function readSize(b: Uint8Array, pos: number): Vint | null {
  const length = vintLength(b[pos] ?? 0);
  if (!length || pos + length > b.length) return null;
  let value = b[pos] & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

function writeSize(value: number, length: number): Uint8Array | null {
  if (value >= 2 ** (7 * length) - 1) return null;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function readUint(b: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[pos + i];
  return v;
}

/**
 * Renvoie une copie du WebM avec sa durée (en ms), ou null si la structure
 * n'est pas reconnue (le fichier d'origine reste alors utilisable tel quel).
 */
export function withWebmDuration(input: ArrayBuffer | Uint8Array, durationMs: number): Uint8Array | null {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!(durationMs > 0)) return null;
  let pos = 0;
  const header = readId(b, pos);
  if (!header || header.value !== ID_EBML) return null;
  const headerSize = readSize(b, pos + header.length);
  if (!headerSize || headerSize.unknown) return null;
  pos += header.length + headerSize.length + headerSize.value;

  const seg = readId(b, pos);
  if (!seg || seg.value !== ID_SEGMENT) return null;
  const segSizePos = pos + seg.length;
  const segSize = readSize(b, segSizePos);
  if (!segSize) return null;
  pos = segSizePos + segSize.length;

  // Enfants du segment jusqu'à Info.
  for (let guard = 0; guard < 64 && pos < b.length; guard++) {
    const id = readId(b, pos);
    if (!id) return null;
    const sizePos = pos + id.length;
    const size = readSize(b, sizePos);
    if (!size) return null;
    const dataStart = sizePos + size.length;
    if (id.value === ID_CLUSTER || size.unknown) return null;
    if (id.value !== ID_INFO) {
      pos = dataStart + size.value;
      continue;
    }
    const dataEnd = dataStart + size.value;
    if (dataEnd > b.length) return null;
    let scale = 1_000_000;
    for (let p = dataStart; p < dataEnd; ) {
      const cid = readId(b, p);
      if (!cid) return null;
      const csize = readSize(b, p + cid.length);
      if (!csize || csize.unknown) return null;
      const cdata = p + cid.length + csize.length;
      if (cid.value === ID_TIMECODE_SCALE && csize.value <= 8) scale = readUint(b, cdata, csize.value) || scale;
      if (cid.value === ID_DURATION) {
        // Déjà présente : on la réécrit si c'est un flottant 8 octets.
        if (csize.value !== 8) return null;
        const out = b.slice();
        new DataView(out.buffer).setFloat64(cdata, (durationMs * 1e6) / scale);
        return out;
      }
      p = cdata + csize.value;
    }
    const element = new Uint8Array(11);
    element.set([0x44, 0x89, 0x88]);
    new DataView(element.buffer).setFloat64(3, (durationMs * 1e6) / scale);
    const infoSize = writeSize(size.value + element.length, size.length);
    if (!infoSize) return null;
    const out = new Uint8Array(b.length + element.length);
    out.set(b.subarray(0, sizePos), 0);
    if (!segSize.unknown) {
      const s = writeSize(segSize.value + element.length, segSize.length);
      if (!s) return null;
      out.set(s, segSizePos);
    }
    out.set(infoSize, sizePos);
    out.set(b.subarray(dataStart, dataEnd), dataStart);
    out.set(element, dataEnd);
    out.set(b.subarray(dataEnd), dataEnd + element.length);
    return out;
  }
  return null;
}
