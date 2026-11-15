import { rasterHeader } from "./luck";
import type { PrintJob, PrinterInfo, PrinterLink, PrinterProtocol } from "./protocol";

/**
 * ESC/POS générique (imprimantes tickets 58 mm en BLE) : initialisation, raster `GS v 0` par bandes,
 * avance. Écrit d'après le jeu de commandes ESC/POS, non validé sur matériel.
 */
const INIT = [0x1b, 0x40];
/** Hauteur d'une bande : certaines imprimantes débordent au-delà. */
const BAND_ROWS = 255;

export function escposProtocol(): PrinterProtocol {
  return {
    id: "escpos",
    async info(): Promise<PrinterInfo> {
      return { model: null, firmware: null, battery: null, status: null };
    },
    async print(link: PrinterLink, job: PrintJob, onProgress): Promise<string | null> {
      const lost = "imprimante déconnectée";
      if (!(await link.send(INIT))) return lost;
      await link.wait(50);
      for (let row = 0; row < job.rows; row += BAND_ROWS) {
        const rows = Math.min(BAND_ROWS, job.rows - row);
        const band = job.data.subarray(row * job.bytesPerRow, (row + rows) * job.bytesPerRow);
        const payload = new Uint8Array(8 + band.length);
        payload.set(rasterHeader(job.bytesPerRow, rows), 0);
        payload.set(band, 8);
        if (!(await link.send(payload))) return lost;
        onProgress(Math.min(0.95, (row + rows) / job.rows));
      }
      // Avance de 80 points pour dégager la barre de coupe.
      if (!(await link.send([0x1b, 0x4a, 80]))) return lost;
      onProgress(1);
      return null;
    },
    feed: (link) => link.send([0x1b, 0x4a, 80]),
  };
}
