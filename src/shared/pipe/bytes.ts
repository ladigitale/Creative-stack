/** Octets : conversions hexadécimales et assemblage, sans dépendance. */

export function toHex(data: ArrayLike<number>, sep = " "): string {
  let out = "";
  for (let i = 0; i < data.length; i++) out += (i ? sep : "") + (data[i] & 0xff).toString(16).padStart(2, "0");
  return out;
}

/** `"1D 76 30"`, `"1d7630"`, `"0x1D,0x76"` → octets ; `null` si la chaîne n'est pas de l'hexadécimal. */
export function fromHex(text: string): Uint8Array | null {
  const clean = text.replace(/0x/gi, "").replace(/[\s,:;-]+/g, "");
  if (!clean.length || clean.length % 2 || /[^0-9a-f]/i.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function startsWith(data: ArrayLike<number>, prefix: ArrayLike<number>): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

export function indexOfBytes(data: ArrayLike<number>, needle: ArrayLike<number>): number {
  outer: for (let i = 0; i + needle.length <= data.length; i++) {
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Texte UTF-8 si les octets en sont, sinon `undefined` (pas de caractère de remplacement). */
export function utf8OrUndefined(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

/** Charge utile d'une commande : `{hex}`, `{bytes: [..]}` ou `{text}`. `null` si invalide ou trop longue. */
export function payloadBytes(arg: Record<string, unknown>, max: number): Uint8Array | null {
  let out: Uint8Array | null = null;
  if (typeof arg.hex === "string") out = fromHex(arg.hex);
  else if (Array.isArray(arg.bytes)) {
    if (arg.bytes.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)) out = Uint8Array.from(arg.bytes as number[]);
  } else if (typeof arg.text === "string") out = new TextEncoder().encode(arg.text);
  return out && out.length > 0 && out.length <= max ? out : null;
}
