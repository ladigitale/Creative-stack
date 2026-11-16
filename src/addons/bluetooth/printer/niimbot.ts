import { UNKNOWN_STATUS, type PaperType, type PrintJob, type PrinterInfo, type PrinterLink, type PrinterProtocol, type PrinterStatus } from "./protocol";

/**
 * Imprimantes d'étiquettes Niimbot (D11, D110, D101, B1, B21, B18…). Protocole à paquets
 * `55 55 <commande> <longueur> <données…> <somme XOR> AA AA`, une réponse attendue par commande sauf pour les
 * lignes d'image. La séquence d'impression change selon le modèle : cinq variantes (« tâches ») ci-dessous.
 *
 * Références : wiki communautaire printers.niim.blue (paquets, tâches d'impression) et la bibliothèque
 * `@mmote/niimbluelib` (MIT) dont ce pilote reprend les identifiants de commande, la table des modèles et l'ordre
 * des paquets. Écrit d'après documentation : aucune variante n'a été essayée sur matériel par ce projet.
 *
 * Volontairement absents : mise à jour de micrologiciel (`F5`, `91`, `92`, `9B`, `9C`), remise à zéro (`28`),
 * délai d'extinction (`27`), écriture des étiquettes RFID.
 */
export const NIIM = {
  printStart: 0x01,
  pageStart: 0x03,
  setPageSize: 0x13,
  printQuantity: 0x15,
  printClear: 0x20,
  setDensity: 0x21,
  setLabelType: 0x23,
  printerInfo: 0x40,
  printIndexedRow: 0x83,
  printEmptyRow: 0x84,
  printBitmapRow: 0x85,
  printStatus: 0xa3,
  printerStatusData: 0xa5,
  connect: 0xc1,
  heartbeat: 0xdc,
  pageEnd: 0xe3,
  printEnd: 0xf3,
} as const;

/** Réponses : identifiant de la commande reçue. */
export const NIIM_IN = {
  notSupported: 0x00,
  printStart: 0x02,
  pageStart: 0x04,
  setPageSize: 0x14,
  printQuantity: 0x16,
  printClear: 0x30,
  setDensity: 0x31,
  setLabelType: 0x33,
  printStatus: 0xb3,
  printerStatusData: 0xb5,
  connect: 0xc2,
  heartbeatAdvanced2: 0xd9,
  printError: 0xdb,
  heartbeatAdvanced1: 0xdd,
  heartbeatBasic: 0xde,
  heartbeatPrinterInfo: 0xdf,
  pageIndex: 0xe0,
  pageEnd: 0xe4,
  printEnd: 0xf4,
} as const;

const INFO = { modelId: 8, softwareVersion: 9, battery: 10 } as const;

export type NiimbotTask = "d110" | "b1" | "d11v1" | "b21v1" | "v4";
export const NIIMBOT_TASKS: NiimbotTask[] = ["d110", "b1", "d11v1", "b21v1", "v4"];

export type NiimbotModel = {
  name: string;
  /** Largeur imprimable en points (multiple de 8). */
  widthPx: number;
  /** Nombre réel de points de la tête, quand il n'est pas multiple de 8. */
  headPx?: number;
  dpi: number;
  /** Noirceur : minimum, maximum, valeur par défaut. */
  density: [number, number, number];
  task: NiimbotTask;
  /** Étiquette courante, longueur × largeur en millimètres. */
  labelMm: [number, number];
};

const small = (name: string, task: NiimbotTask): NiimbotModel => ({ name, widthPx: 96, dpi: 203, density: [1, 3, 2], task, labelMm: [30, 12] });
const wide = (name: string, task: NiimbotTask): NiimbotModel => ({ name, widthPx: 384, dpi: 203, density: [1, 5, 3], task, labelMm: [50, 30] });

/** Identifiant de modèle (commande d'information 8) → modèle. */
export const NIIMBOT_MODELS: Record<number, NiimbotModel> = {
  512: small("D11", "d11v1"),
  514: small("D11S", "d11v1"),
  528: { name: "D11_H", widthPx: 136, headPx: 142, dpi: 300, density: [1, 5, 3], task: "v4", labelMm: [30, 12] },
  2304: small("D110", "d110"),
  2305: small("D110", "d110"),
  2320: { ...small("D110_M", "b1"), density: [1, 5, 3] },
  2560: { name: "D101", widthPx: 192, dpi: 203, density: [1, 3, 2], task: "b1", labelMm: [40, 25] },
  1792: small("B16", "d110"),
  3584: small("B18", "d110"),
  3585: small("B18S", "d110"),
  768: wide("B21", "b21v1"),
  771: wide("B21_C2B", "b1"),
  775: wide("B21_C2B", "b1"),
  776: wide("B21S_C2B", "d110"),
  777: wide("B21S", "d110"),
  4096: wide("B1", "b1"),
  4098: wide("B1_SE", "b1"),
};

/** Modèle d'après l'identifiant et la version de protocole (les D11 récents suivent la séquence du D110). */
export function niimbotModel(id: number | null, protocolVersion: number): NiimbotModel | null {
  if (id === null || !Object.prototype.hasOwnProperty.call(NIIMBOT_MODELS, id)) return null;
  const model = NIIMBOT_MODELS[id];
  if (id === 512 && (protocolVersion === 1 || protocolVersion === 2)) return { ...model, task: "d110" };
  if (id === 2320 && protocolVersion >= 4) return { ...model, task: "v4" };
  return model;
}

export type NiimbotPacket = { cmd: number; data: Uint8Array };

/** Paquet prêt à écrire. La commande de connexion est précédée d'un octet `03`. */
export function niimbotPacket(cmd: number, data: ArrayLike<number> = [1]): Uint8Array {
  const n = data.length;
  if (n > 255) throw new Error("paquet Niimbot trop long");
  const lead = cmd === NIIM.connect ? 1 : 0;
  const out = new Uint8Array(lead + 7 + n);
  if (lead) out[0] = 0x03;
  out[lead] = 0x55;
  out[lead + 1] = 0x55;
  out[lead + 2] = cmd;
  out[lead + 3] = n;
  let sum = cmd ^ n;
  for (let i = 0; i < n; i++) {
    out[lead + 4 + i] = data[i];
    sum ^= data[i];
  }
  out[lead + 4 + n] = sum & 0xff;
  out[lead + 5 + n] = 0xaa;
  out[lead + 6 + n] = 0xaa;
  return out;
}

/** Paquets complets et valides trouvés dans un tampon de notifications (le reste est ignoré). */
export function parseNiimbotPackets(buffer: Uint8Array): NiimbotPacket[] {
  const out: NiimbotPacket[] = [];
  let i = 0;
  while (i + 7 <= buffer.length) {
    if (buffer[i] !== 0x55 || buffer[i + 1] !== 0x55) {
      i++;
      continue;
    }
    const cmd = buffer[i + 2];
    const n = buffer[i + 3];
    const end = i + 4 + n;
    if (end + 3 > buffer.length) break;
    let sum = cmd ^ n;
    for (let k = i + 4; k < end; k++) sum ^= buffer[k];
    if (buffer[end] === (sum & 0xff) && buffer[end + 1] === 0xaa && buffer[end + 2] === 0xaa) {
      out.push({ cmd, data: buffer.slice(i + 4, end) });
      i = end + 3;
    } else {
      i++;
    }
  }
  return out;
}

const u16 = (v: number): [number, number] => [(v >> 8) & 0xff, v & 0xff];

/** Nombres de points noirs d'une ligne : par tiers de tête quand la ligne y tient, sinon total sur deux octets. */
export function niimbotCounts(row: Uint8Array, headPx: number, mode: "auto" | "total" = "auto"): { total: number; parts: [number, number, number] } {
  const chunk = Math.floor(headPx / 8 / 3);
  const split = mode === "auto" && chunk > 0 && row.length <= chunk * 3;
  const parts: [number, number, number] = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < row.length; i++) {
    let b = row[i];
    let n = 0;
    while (b) {
      n += b & 1;
      b >>= 1;
    }
    total += n;
    if (split) parts[Math.min(2, Math.floor(i / chunk))] = Math.min(255, parts[Math.min(2, Math.floor(i / chunk))] + n);
  }
  return split ? { total, parts } : { total, parts: [0, total & 0xff, (total >> 8) & 0xff] };
}

/**
 * Lignes d'image → paquets : lignes identiques regroupées (255 répétitions au plus), lignes blanches en `84`,
 * lignes de 6 points noirs ou moins en positions (`83`), les autres en bitmap (`85`).
 */
export function niimbotRows(job: Pick<PrintJob, "data" | "bytesPerRow" | "rows">, headPx: number, mode: "auto" | "total" = "auto"): Uint8Array[] {
  const out: Uint8Array[] = [];
  const w = job.bytesPerRow;
  const same = (a: number, b: number): boolean => {
    for (let i = 0; i < w; i++) if (job.data[a * w + i] !== job.data[b * w + i]) return false;
    return true;
  };
  let y = 0;
  while (y < job.rows) {
    let repeat = 1;
    while (y + repeat < job.rows && repeat < 255 && same(y, y + repeat)) repeat++;
    const row = job.data.subarray(y * w, (y + 1) * w);
    const counts = niimbotCounts(row, headPx, mode);
    if (counts.total === 0) {
      out.push(niimbotPacket(NIIM.printEmptyRow, [...u16(y), repeat]));
    } else if (counts.total <= 6) {
      const indexes: number[] = [];
      for (let i = 0; i < w; i++) for (let bit = 0; bit < 8; bit++) if (row[i] & (0x80 >> bit)) indexes.push(...u16(i * 8 + bit));
      out.push(niimbotPacket(NIIM.printIndexedRow, [...u16(y), ...counts.parts, repeat, ...indexes]));
    } else {
      out.push(niimbotPacket(NIIM.printBitmapRow, [...u16(y), ...counts.parts, repeat, ...row]));
    }
    y += repeat;
  }
  return out;
}

const ERRORS: Record<number, string> = {
  1: "capot ouvert",
  2: "plus de papier",
  3: "batterie faible",
  4: "problème de batterie",
  5: "impression annulée sur l'imprimante",
  6: "données refusées par l'imprimante",
  7: "imprimante en surchauffe",
  8: "sortie du papier anormale",
  9: "imprimante occupée",
  10: "tête d'impression absente",
  11: "imprimante trop froide",
  12: "tête d'impression mal fixée",
  16: "étiquettes non reconnues",
  17: "type d'étiquette refusé",
  19: "noirceur refusée",
  24: "dimensions d'étiquette refusées",
  28: "étiquettes à vérifier",
  30: "noirceur non prise en charge",
  50: "page refusée",
  52: "l'imprimante n'a pas reçu toutes les données",
};

export function niimbotError(code: number): string {
  return ERRORS[code] ?? `erreur ${code} de l'imprimante`;
}

const LABEL_TYPE: Record<PaperType, number> = { gap: 1, "black-mark": 2, continuous: 3 };

/** Noirceur 0 (clair), 1 (normal), 2 (foncé) → valeur du modèle. */
export function niimbotDensity(level: number, range: [number, number, number]): number {
  const l = Math.round(level);
  return l <= 0 ? range[0] : l >= 2 ? range[1] : range[2];
}

/** État lu dans la réponse de battement (formats selon le modèle). `null` si le format est inconnu. */
export function parseNiimbotHeartbeat(p: NiimbotPacket, modelId: number | null): { status: PrinterStatus; battery: number | null } | null {
  const d = p.data;
  let lid: boolean | null = null;
  let paper: boolean | null = null;
  let battery: number | null = null;
  if (p.cmd === NIIM_IN.heartbeatAdvanced2 && d.length >= 9) {
    battery = d[2];
    lid = d[4] === 0;
    paper = d[5] === 0;
  } else if (p.cmd === NIIM_IN.heartbeatAdvanced1) {
    if (d.length === 10) {
      lid = d[8] === 0;
      battery = d[9];
    } else if (d.length === 13) {
      lid = d[9] === 0;
      battery = d[10];
      paper = d[11] === 0;
    } else if (d.length === 19) {
      lid = d[15] === 0;
      battery = d[16];
      paper = d[17] === 0;
    } else if (d.length === 20) {
      paper = d[18] === 0;
    } else {
      return null;
    }
    // Sur ces modèles l'octet du capot est inversé.
    if (lid !== null && modelId !== null && [512, 514, 513, 2304, 1792, 3584, 5120, 2560, 3840, 4352, 272, 273, 274].includes(modelId)) lid = !lid;
  } else {
    return null;
  }
  if (battery !== null && battery <= 4) battery *= 25;
  return {
    battery: battery === null ? null : Math.min(100, battery),
    status: { ...UNKNOWN_STATUS, cover: lid === null ? "unknown" : lid ? "closed" : "open", paper: paper === null ? "unknown" : paper ? "ok" : "out" },
  };
}

type Session = { modelId: number | null; protocolVersion: number; model: NiimbotModel | null };

/**
 * `task` vide : variante choisie d'après le modèle lu sur l'imprimante (`d110` si le modèle est inconnu).
 * Sinon la variante est imposée, pour essayer une imprimante que la table ne connaît pas.
 */
export function niimbotProtocol(task: NiimbotTask | "" = ""): PrinterProtocol {
  const session: Session = { modelId: null, protocolVersion: 0, model: null };
  const lost = "imprimante déconnectée";

  /** Envoie une commande et attend l'une des réponses attendues. Chaîne = erreur lisible. */
  const ask = async (link: PrinterLink, cmd: number, data: ArrayLike<number>, expect: number[], timeoutMs = 2000): Promise<NiimbotPacket | string> => {
    const wanted = (b: Uint8Array): NiimbotPacket | undefined =>
      parseNiimbotPackets(b).find((p) => expect.includes(p.cmd) || p.cmd === NIIM_IN.printError || p.cmd === NIIM_IN.notSupported);
    const reply = await link.request(niimbotPacket(cmd, data), timeoutMs, (b) => !!wanted(b));
    if (reply === null) return lost;
    const packet = wanted(reply);
    if (!packet) return "pas de réponse de l'imprimante";
    if (packet.cmd === NIIM_IN.printError) return niimbotError(packet.data[0] ?? 0);
    if (packet.cmd === NIIM_IN.notSupported) return "commande refusée par l'imprimante (essayer une autre variante : protocol=\"niimbot-b1\", \"niimbot-d110\"…)";
    return packet;
  };

  const info = async (link: PrinterLink, type: number): Promise<Uint8Array | null> => {
    const r = await ask(link, NIIM.printerInfo, [type], [NIIM.printerInfo + type], 1500);
    return typeof r === "string" ? null : r.data;
  };

  const heartbeat = async (link: PrinterLink): Promise<ReturnType<typeof parseNiimbotHeartbeat>> => {
    const type = session.protocolVersion >= 3 ? 4 : 1;
    const r = await ask(link, NIIM.heartbeat, [type], [NIIM_IN.heartbeatAdvanced1, NIIM_IN.heartbeatAdvanced2, NIIM_IN.heartbeatBasic, NIIM_IN.heartbeatPrinterInfo], 1000);
    return typeof r === "string" ? null : parseNiimbotHeartbeat(r, session.modelId);
  };

  return {
    id: task ? `niimbot-${task}` : "niimbot",

    async info(link: PrinterLink): Promise<PrinterInfo> {
      const hello = await ask(link, NIIM.connect, [1], [NIIM_IN.connect], 2000);
      session.protocolVersion = 0;
      if (typeof hello !== "string") {
        if (hello.data[0] === 2) session.protocolVersion = 1;
        else if (hello.data[0] === 3) {
          const s = await ask(link, NIIM.printerStatusData, [1], [NIIM_IN.printerStatusData], 1500);
          if (typeof s !== "string" && s.data.length >= 13) {
            const n = s.data[11] * 100 + s.data[12];
            session.protocolVersion = n >= 302 ? 5 : n >= 300 ? 4 : n >= 204 ? 3 : 0;
          }
        }
      }
      const id = await info(link, INFO.modelId);
      session.modelId = id?.length === 1 ? id[0] << 8 : id && id.length >= 2 ? (id[0] << 8) | id[1] : null;
      session.model = niimbotModel(session.modelId, session.protocolVersion);
      const version = await info(link, INFO.softwareVersion);
      const charge = await info(link, INFO.battery);
      const beat = await heartbeat(link);
      const battery = charge?.length === 1 ? Math.min(100, charge[0] <= 4 ? charge[0] * 25 : charge[0]) : beat?.battery ?? null;
      return {
        model: session.model?.name ?? (session.modelId === null ? null : `Niimbot ${session.modelId}`),
        firmware: version?.length === 2 ? ((version[0] * 256 + version[1]) / 100).toFixed(2) : null,
        battery,
        status: beat?.status ?? null,
      };
    },

    async print(link, job: PrintJob, onProgress): Promise<string | null> {
      const variant: NiimbotTask = task || session.model?.task || (session.protocolVersion >= 4 ? "v4" : "d110");
      const headPx = session.model?.headPx ?? session.model?.widthPx ?? job.bytesPerRow * 8;
      const density = niimbotDensity(job.density, session.model?.density ?? [1, 3, 2]);
      const cols = job.bytesPerRow * 8;
      let started = false;

      const step = async (cmd: number, data: ArrayLike<number>, expect: number, timeoutMs = 2000): Promise<string | null> => {
        const r = await ask(link, cmd, data, [expect], timeoutMs);
        return typeof r === "string" ? r : null;
      };
      const end = async (): Promise<boolean> => {
        const r = await ask(link, NIIM.printEnd, [1], [NIIM_IN.printEnd], 2000);
        if (variant === "v4") await link.send(niimbotPacket(NIIM.heartbeat, [1]));
        return typeof r !== "string" && r.data[0] === 1;
      };

      const run = async (): Promise<string | null> => {
        let e: string | null;
        // Préparation : noirceur, type d'étiquette, début de tâche.
        const prelude: [number, number[], number][] = variant === "v4"
          ? [[NIIM.setLabelType, [LABEL_TYPE[job.paper]], NIIM_IN.setLabelType], [NIIM.setDensity, [density], NIIM_IN.setDensity]]
          : [[NIIM.setDensity, [density], NIIM_IN.setDensity], [NIIM.setLabelType, [LABEL_TYPE[job.paper]], NIIM_IN.setLabelType]];
        for (const [cmd, data, expect] of prelude) if ((e = await step(cmd, data, expect))) return e;
        const start = variant === "b1" ? [0, 1, 0, 0, 0, 0, 0] : variant === "v4" ? [0, 1, 0, 0, 0, 0, 0, 1, 0] : [1];
        if ((e = await step(NIIM.printStart, start, NIIM_IN.printStart))) return e;
        started = true;
        onProgress(0.1);

        // Page : dimensions, puis lignes.
        if (variant === "v4") {
          // Le premier paquet après le début de tâche peut rester sans réponse : état demandé sans attendre.
          if (!(await link.send(niimbotPacket(NIIM.printStatus, [1])))) return lost;
          await link.wait(20);
          if ((e = await step(NIIM.setPageSize, [...u16(job.rows), ...u16(cols), 0, 1, 0, 0, 0, 0, 0, 0, 0], NIIM_IN.setPageSize))) return e;
        } else {
          if (variant === "d110" || variant === "d11v1") if ((e = await step(NIIM.printClear, [1], NIIM_IN.printClear))) return e;
          if ((e = await step(NIIM.pageStart, [1], NIIM_IN.pageStart))) return e;
          const size = variant === "d11v1" ? u16(job.rows) : variant === "b1" ? [...u16(job.rows), ...u16(cols), 0, 1] : [...u16(job.rows), ...u16(cols)];
          if ((e = await step(NIIM.setPageSize, size, NIIM_IN.setPageSize))) return e;
          if (variant === "d110" || variant === "d11v1") if ((e = await step(NIIM.printQuantity, [0, 1], NIIM_IN.printQuantity))) return e;
        }
        const rows = niimbotRows(job, headPx, variant === "b21v1" ? "total" : "auto");
        for (let i = 0; i < rows.length; i++) {
          // Un paquet par écriture, avec un court délai : le tampon de l'imprimante est petit.
          if (!(await link.send(rows[i], { chunkSize: 512 }))) return lost;
          await link.wait(10);
          if (i % 16 === 0) onProgress(0.1 + 0.6 * (i / rows.length));
        }
        if ((e = await step(NIIM.pageEnd, [1], NIIM_IN.pageEnd, 10000))) return e;
        onProgress(0.75);

        // Attente de la sortie de l'étiquette.
        if (variant === "d11v1") {
          // Les anciens D11 annoncent d'eux-mêmes la page imprimée : on écoute, sans rien envoyer.
          const done = (b: Uint8Array): NiimbotPacket | undefined =>
            parseNiimbotPackets(b).find((p) => p.cmd === NIIM_IN.printError || (p.cmd === NIIM_IN.pageIndex && p.data.length === 2 && ((p.data[0] << 8) | p.data[1]) >= 1));
          const heard = await link.request([], 15000, (b) => !!done(b));
          if (heard === null) return lost;
          const packet = done(heard);
          if (packet?.cmd === NIIM_IN.printError) return niimbotError(packet.data[0] ?? 0);
          return packet ? null : "l'imprimante n'a pas confirmé la fin de l'impression";
        }
        const deadline = Date.now() + 60000 * Math.max(link.timeScale, 0.01);
        for (;;) {
          await link.wait(variant === "b21v1" ? 500 : 300);
          if (variant === "b21v1") {
            if (await end()) {
              started = false;
              return null;
            }
          } else {
            const r = await ask(link, NIIM.printStatus, [1], [NIIM_IN.printStatus], 5000);
            if (typeof r === "string") return r;
            if (r.data.length === 10 && r.data[6]) return niimbotError(r.data[6]);
            if (r.data.length >= 4) {
              const page = (r.data[0] << 8) | r.data[1];
              onProgress(0.75 + 0.25 * Math.min(1, ((r.data[2] ?? 0) + (r.data[3] ?? 0)) / 200));
              if (page >= 1) return null;
            }
          }
          if (Date.now() > deadline || !link.pipe.pipeReady) return link.pipe.pipeReady ? "l'imprimante n'a pas confirmé la fin de l'impression" : lost;
        }
      };

      const error = await run();
      if (started) await end();
      if (!error) onProgress(1);
      return error;
    },

    /** Pas de commande d'avance documentée commune aux modèles : rien n'est envoyé. */
    feed: () => Promise.resolve(false),
  };
}
