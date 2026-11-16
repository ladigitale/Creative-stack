/**
 * Découpe un flux d'octets en lignes de texte (protocoles série : GRBL, Marlin, consoles de microcontrôleur).
 * Fin de ligne `\n` ou `\r\n` ; une ligne plus longue que `maxLength` est coupée d'office (flux binaire ou
 * mauvais débit : on ne garde jamais un tampon sans fin).
 */
export class LineSplitter {
  private pending = "";
  private decoder = new TextDecoder("utf-8");

  constructor(readonly maxLength = 1024) {}

  /** Octets reçus → lignes complètes (sans fin de ligne, vides exclues). */
  push(data: Uint8Array): string[] {
    this.pending += this.decoder.decode(data, { stream: true });
    const out: string[] = [];
    for (;;) {
      const at = this.pending.indexOf("\n");
      if (at < 0) break;
      const line = this.pending.slice(0, at).replace(/\r$/, "");
      this.pending = this.pending.slice(at + 1);
      if (line) out.push(line.slice(0, this.maxLength));
    }
    while (this.pending.length > this.maxLength) {
      out.push(this.pending.slice(0, this.maxLength));
      this.pending = this.pending.slice(this.maxLength);
    }
    return out;
  }

  reset(): void {
    this.pending = "";
    this.decoder = new TextDecoder("utf-8");
  }
}
