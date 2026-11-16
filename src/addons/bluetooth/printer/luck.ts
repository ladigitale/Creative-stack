import { indexOfBytes } from "../../../shared/pipe/bytes";
import { UNKNOWN_STATUS, type PaperType, type PrintJob, type PrinterInfo, type PrinterLink, type PrinterProtocol, type PrinterStatus } from "./protocol";

/**
 * Imprimantes du SDK LuckPrinter : Fichero D11s d'Action (AiYin D11s), D12, et la branche Lujiang
 * (LuckP, DP, L12, L13). Raster ESC/POS (`GS v 0`) encadré par des commandes `10 FF …`.
 *
 * Référence : github.com/0xMH/fichero-printer (docs/PROTOCOL.md), vérifié par ce projet sur un D11s
 * au micrologiciel 2.4.6. La branche Lujiang n'a été testée par personne ici.
 *
 * Volontairement absents : mise à jour de micrologiciel (`10 FF E0`), remise à zéro d'usine (`10 FF 04`),
 * délai d'extinction (`10 FF 12`).
 */
export const LUCK = {
  getModel: [0x10, 0xff, 0x20, 0xf0],
  getFirmware: [0x10, 0xff, 0x20, 0xf1],
  getBattery: [0x10, 0xff, 0x50, 0xf1],
  getStatus: [0x10, 0xff, 0x40],
  setDensity: (level: number) => [0x10, 0xff, 0x10, 0x00, Math.min(2, Math.max(0, Math.round(level)))],
  setPaper: (type: PaperType) => [0x10, 0xff, 0x84, type === "black-mark" ? 1 : type === "continuous" ? 2 : 0],
  wake: new Array<number>(12).fill(0),
  formFeed: [0x1d, 0x0c],
  enable: { aiyin: [0x10, 0xff, 0xfe, 0x01], lujiang: [0x10, 0xff, 0xf1, 0x03] },
  stop: { aiyin: [0x10, 0xff, 0xfe, 0x45], lujiang: [0x10, 0xff, 0xf1, 0x45] },
} as const;

/** En-tête raster `GS v 0` : mode normal, largeur en octets et hauteur en lignes, petit-boutiste. */
export function rasterHeader(bytesPerRow: number, rows: number): number[] {
  return [0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff];
}

/** Octet d'état (`10 FF 40`) : bit 0 impression, 1 capot, 2 papier, 3 batterie faible, 4 et 6 surchauffe, 5 charge. */
export function parseLuckStatus(byte: number): PrinterStatus {
  return {
    printing: !!(byte & 0x01),
    cover: byte & 0x02 ? "open" : "closed",
    paper: byte & 0x04 ? "out" : "ok",
    lowBattery: !!(byte & 0x08),
    overheated: !!(byte & 0x50),
    charging: !!(byte & 0x20),
  };
}

/** Réponse d'erreur `FF nn` : bit 0 surchauffe, 1 capot, 2 papier, 3 batterie. `null` si ce n'en est pas une. */
export function parseLuckError(response: ArrayLike<number>): string | null {
  if (response.length < 2 || response[0] !== 0xff) return null;
  const b = response[1];
  const parts = [b & 0x01 && "surchauffe", b & 0x02 && "capot ouvert", b & 0x04 && "plus de papier", b & 0x08 && "batterie faible"].filter(Boolean);
  return parts.length ? parts.join(", ") : "erreur de l'imprimante";
}

export function statusProblem(s: PrinterStatus): string | null {
  if (s.cover === "open") return "capot ouvert";
  if (s.paper === "out") return "plus de papier";
  if (s.overheated) return "imprimante en surchauffe";
  return null;
}

const ascii = (data: Uint8Array | null): string | null => {
  if (!data?.length) return null;
  const text = Array.from(data, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "")).join("").trim();
  return text ? text.slice(0, 40) : null;
};

const OK = [0x4f, 0x4b];

export function luckProtocol(variant: "aiyin" | "lujiang"): PrinterProtocol {
  return {
    id: `luck-${variant}`,

    async info(link: PrinterLink): Promise<PrinterInfo> {
      const model = ascii(await link.request(LUCK.getModel));
      const firmware = ascii(await link.request(LUCK.getFirmware));
      const battery = await link.request(LUCK.getBattery);
      const status = await link.request(LUCK.getStatus);
      return {
        model,
        firmware,
        battery: battery && battery.length >= 2 ? Math.min(100, battery[battery.length - 1]) : null,
        status: status?.length ? parseLuckStatus(status[status.length - 1]) : null,
      };
    },

    async print(link, job: PrintJob, onProgress): Promise<string | null> {
      const lost = "imprimante déconnectée";
      const status = await link.request(LUCK.getStatus);
      if (status === null) return lost;
      if (status.length) {
        const problem = statusProblem(parseLuckStatus(status[status.length - 1]));
        if (problem) return problem;
      }
      if ((await link.request(LUCK.setDensity(job.density))) === null) return lost;
      await link.wait(100);
      if ((await link.request(LUCK.setPaper(job.paper))) === null) return lost;
      await link.wait(50);
      if (!(await link.send(LUCK.wake))) return lost;
      await link.wait(50);
      if (!(await link.send(LUCK.enable[variant]))) return lost;
      await link.wait(50);
      onProgress(0.1);

      const payload = new Uint8Array(8 + job.data.length);
      payload.set(rasterHeader(job.bytesPerRow, job.rows), 0);
      payload.set(job.data, 8);
      if (!(await link.send(payload))) return lost;
      onProgress(0.7);
      await link.wait(500);

      if (!(await link.send(LUCK.formFeed))) return lost;
      await link.wait(300);
      onProgress(0.85);

      // Fin : l'imprimante répond 0xAA ou « OK » quand l'étiquette est sortie (jusqu'à 60 s).
      const end = await link.request(LUCK.stop[variant], 60000, (b) => b.includes(0xaa) || indexOfBytes(b, OK) >= 0 || b[0] === 0xff);
      if (end === null) return lost;
      const error = parseLuckError(end);
      if (error) return error;
      if (!end.length) return "pas de confirmation de l'imprimante";
      onProgress(1);
      return null;
    },

    feed: (link) => link.send(LUCK.formFeed),
  };
}

export { UNKNOWN_STATUS };
