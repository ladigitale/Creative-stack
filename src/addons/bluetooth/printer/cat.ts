import { UNKNOWN_STATUS, type PrintJob, type PrinterInfo, type PrinterLink, type PrinterProtocol, type PrinterStatus } from "./protocol";

/**
 * Imprimantes thermiques « chat » (GB01, GB02, GB03, GT01, YT01, MX05 à MX10, X5…) : papier continu de 57 mm,
 * tête de 384 points à 203 dpi. Trames `51 78 <cmd> 00 <len lo> <len hi> <données> <crc8> FF`, CRC-8 (polynôme
 * 0x07, valeur initiale 0) sur les données seules ; l'imprimante répond avec `01` à la place du `00`.
 *
 * Références (documentation communautaire, aucun code repris) : billet « Cat printer » de WerWolv
 * (werwolv.net/blog/cat_printer), projets github.com/rbaron/catprinter et github.com/NaitLee/Cat-Printer.
 * Les valeurs de trame vérifiables (CRC des trames publiées) sont contrôlées par les tests.
 *
 * Sûr (relevé identiquement par les trois sources) : cadre et CRC, `a2` ligne de 48 octets (bit de poids faible
 * = point de gauche), `a1` avance de n lignes, `a6` début et fin de « lattice », `a4` qualité, `af` énergie sur
 * deux octets petit-boutistes, `bd` vitesse, `be` mode (0 image, 1 texte), `a3` état, `ae` contrôle de flux
 * envoyé par l'imprimante (`10` = pause, `00` = reprise).
 * Supposé : valeurs d'énergie et de vitesse par niveau de noirceur, sens des bits de l'octet d'état.
 * Écrit d'après documentation, non testé sur matériel. Les modèles récents à compression (`bf`) ne sont pas gérés.
 */
export const CAT = {
  retract: 0xa0,
  feed: 0xa1,
  line: 0xa2,
  state: 0xa3,
  quality: 0xa4,
  lattice: 0xa6,
  info: 0xa8,
  flow: 0xae,
  energy: 0xaf,
  speed: 0xbd,
  mode: 0xbe,
} as const;

export const CAT_WIDTH_PX = 384;
export const CAT_LATTICE_START = [0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c];
export const CAT_LATTICE_END = [0xaa, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17];

/** CRC-8, polynôme 0x07, valeur initiale 0, sans réflexion. */
export function crc8(data: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] & 0xff;
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** Trame prête à écrire. */
export function catFrame(cmd: number, data: ArrayLike<number> = [0]): Uint8Array {
  const n = data.length;
  if (n > 0xffff) throw new Error("trame trop longue");
  const out = new Uint8Array(8 + n);
  out.set([0x51, 0x78, cmd & 0xff, 0x00, n & 0xff, (n >> 8) & 0xff], 0);
  for (let i = 0; i < n; i++) out[6 + i] = data[i];
  out[6 + n] = crc8(data);
  out[7 + n] = 0xff;
  return out;
}

export type CatFrame = { cmd: number; data: Uint8Array };

/** Trames complètes et valides trouvées dans un tampon de notifications. */
export function parseCatFrames(buffer: ArrayLike<number>): CatFrame[] {
  const out: CatFrame[] = [];
  let i = 0;
  while (i + 8 <= buffer.length) {
    if (buffer[i] !== 0x51 || buffer[i + 1] !== 0x78) {
      i++;
      continue;
    }
    const n = buffer[i + 4] | (buffer[i + 5] << 8);
    const end = i + 6 + n;
    if (end + 2 > buffer.length) break;
    const data = Uint8Array.from(Array.prototype.slice.call(buffer, i + 6, end) as number[]);
    if (buffer[end] === crc8(data) && buffer[end + 1] === 0xff) {
      out.push({ cmd: buffer[i + 2], data });
      i = end + 2;
    } else {
      i++;
    }
  }
  return out;
}

/** Inverse l'ordre des bits d'un octet (point de gauche en bit de poids faible). */
export function reverseBits(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
  return r;
}

/** Une ligne emballée (bit de poids fort à gauche, 1 = noir) → trame `a2` de 48 octets, complétée en blanc. */
export function catLine(row: ArrayLike<number>, bytesPerRow = CAT_WIDTH_PX / 8): Uint8Array {
  const data = new Uint8Array(bytesPerRow);
  for (let i = 0; i < Math.min(row.length, bytesPerRow); i++) data[i] = reverseBits(row[i]);
  return catFrame(CAT.line, data);
}

/** Énergie (supposée) par noirceur 0 clair, 1 normal, 2 foncé. */
export function catEnergy(level: number): number {
  const l = Math.round(level);
  return l <= 0 ? 0x2000 : l >= 2 ? 0x5000 : 0x3000;
}

const u16le = (v: number): [number, number] => [v & 0xff, (v >> 8) & 0xff];

/** Octet d'état de la réponse `a3` (sens supposé) : bit 0 papier absent, 1 capot ouvert, 2 surchauffe, 3 batterie faible. */
export function parseCatState(byte: number): PrinterStatus {
  return {
    ...UNKNOWN_STATUS,
    paper: byte & 0x01 ? "out" : "ok",
    cover: byte & 0x02 ? "open" : "closed",
    overheated: !!(byte & 0x04),
    lowBattery: !!(byte & 0x08),
  };
}

/**
 * Trames d'une impression complète : préparation, lignes, avance, fin. Les lignes identiques ne sont pas
 * regroupées (aucune commande de répétition connue).
 */
export function catJob(job: Pick<PrintJob, "data" | "bytesPerRow" | "rows" | "density">, feedLines = 90): { head: Uint8Array[]; lines: Uint8Array[]; tail: Uint8Array[] } {
  const head = [
    catFrame(CAT.state, [0]),
    catFrame(CAT.quality, [0x33]),
    catFrame(CAT.lattice, CAT_LATTICE_START),
    catFrame(CAT.energy, u16le(catEnergy(job.density))),
    catFrame(CAT.mode, [0]),
    catFrame(CAT.speed, [job.density >= 2 ? 0x19 : 0x23]),
  ];
  const lines: Uint8Array[] = [];
  for (let y = 0; y < job.rows; y++) lines.push(catLine(job.data.subarray(y * job.bytesPerRow, (y + 1) * job.bytesPerRow)));
  const tail = [catFrame(CAT.speed, [0x23]), catFrame(CAT.feed, u16le(feedLines)), catFrame(CAT.lattice, CAT_LATTICE_END), catFrame(CAT.state, [0])];
  return { head, lines, tail };
}

/** Regroupe des trames en écritures d'au plus `maxBytes` octets (une trame n'est jamais coupée entre deux groupes). */
export function groupFrames(frames: Uint8Array[], maxBytes: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let parts: Uint8Array[] = [];
  let size = 0;
  const flush = (): void => {
    if (!parts.length) return;
    const g = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      g.set(p, o);
      o += p.length;
    }
    out.push(g);
    parts = [];
    size = 0;
  };
  for (const f of frames) {
    if (size && size + f.length > maxBytes) flush();
    parts.push(f);
    size += f.length;
  }
  flush();
  return out;
}

/** Lignes par écriture et pause entre deux écritures : l'imprimante a un petit tampon et pas d'accusé de réception. */
const LINES_PER_WRITE = 4;
const WRITE_GAP_MS = 15;

export function catProtocol(): PrinterProtocol {
  const lost = "imprimante déconnectée";

  const readState = async (link: PrinterLink): Promise<PrinterStatus | null> => {
    const reply = await link.request(catFrame(CAT.state, [0]), 1000, (b) => parseCatFrames(b).some((f) => f.cmd === CAT.state));
    const frame = reply ? parseCatFrames(reply).find((f) => f.cmd === CAT.state) : undefined;
    return frame && frame.data.length ? parseCatState(frame.data[0]) : null;
  };

  return {
    id: "cat",

    async info(link: PrinterLink): Promise<PrinterInfo> {
      const status = await readState(link);
      return { model: null, firmware: null, battery: null, status };
    },

    async print(link, job: PrintJob, onProgress): Promise<string | null> {
      if (job.bytesPerRow > CAT_WIDTH_PX / 8) return `image trop large pour la tête (${CAT_WIDTH_PX} points)`;
      const status = await readState(link);
      if (status?.paper === "out") return "plus de papier";
      if (status?.cover === "open") return "capot ouvert";
      if (status?.overheated) return "imprimante en surchauffe";

      // Contrôle de flux : l'imprimante demande une pause (`ae 10`) quand son tampon est plein.
      let paused = false;
      const off = link.pipe.onBytes((bytes) => {
        for (const f of parseCatFrames(bytes)) if (f.cmd === CAT.flow && f.data.length) paused = f.data[0] !== 0;
      });
      const waitResume = async (): Promise<boolean> => {
        const deadline = Date.now() + 10000 * Math.max(link.timeScale, 0.01);
        while (paused && link.pipe.pipeReady && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 20));
        paused = false;
        return link.pipe.pipeReady;
      };

      try {
        const { head, lines, tail } = catJob(job);
        for (const f of head) {
          if (!(await link.send(f))) return lost;
          await link.wait(WRITE_GAP_MS);
        }
        onProgress(0.05);
        const groups = groupFrames(lines, LINES_PER_WRITE * lines[0]?.length || 1);
        for (let i = 0; i < groups.length; i++) {
          if (paused && !(await waitResume())) return lost;
          if (!(await link.send(groups[i]))) return lost;
          await link.wait(WRITE_GAP_MS);
          if (i % 8 === 0) onProgress(0.05 + 0.85 * (i / groups.length));
        }
        for (const f of tail) {
          if (!(await link.send(f))) return lost;
          await link.wait(WRITE_GAP_MS);
        }
        onProgress(1);
        return null;
      } finally {
        off();
      }
    },

    feed: (link) => link.send(catFrame(CAT.feed, u16le(80))),
  };
}
