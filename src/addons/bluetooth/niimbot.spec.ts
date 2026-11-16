import { afterEach, describe, expect, it } from "vitest";
import "./index";
import {
  FakePipe, PrinterLink, NIIM, NIIM_IN, createProtocol, expandUuid, getProfile, modelFromName, niimbotCounts, niimbotDensity, niimbotModel,
  niimbotPacket, niimbotProtocol, niimbotRows, parseNiimbotHeartbeat, parseNiimbotPackets, toHex,
} from "./index";
import type { SonicBluetooth } from "./bluetooth";
import type { SonicLabelPrinter } from "./label-printer";

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
afterEach(() => {
  document.body.innerHTML = "";
});

/** Réponses d'une fausse imprimante : identifiant de modèle, version, batterie, état. */
function fakeNiimbot(opts: { name?: string; modelId?: number; connect?: number; statusData?: number[]; silent?: number[]; error?: [number, number]; statusLen?: number } = {}): FakePipe {
  const modelId = opts.modelId ?? 2304;
  let polls = 0;
  return new FakePipe(opts.name ?? "D110-E1234567", (data) => {
    const p = parseNiimbotPackets(data)[0];
    if (!p) return null;
    if (opts.silent?.includes(p.cmd)) return null;
    if (opts.error && opts.error[0] === p.cmd) return niimbotPacket(NIIM_IN.printError, [opts.error[1]]);
    switch (p.cmd) {
      case NIIM.connect: return niimbotPacket(NIIM_IN.connect, [opts.connect ?? 1]);
      case NIIM.printerStatusData: return niimbotPacket(NIIM_IN.printerStatusData, opts.statusData ?? new Array(13).fill(0));
      case NIIM.printerInfo:
        if (p.data[0] === 8) return niimbotPacket(0x48, [(modelId >> 8) & 0xff, modelId & 0xff]);
        if (p.data[0] === 9) return niimbotPacket(0x49, [0x01, 0x2c]);
        if (p.data[0] === 10) return niimbotPacket(0x4a, [3]);
        return niimbotPacket(NIIM_IN.notSupported, [0]);
      case NIIM.heartbeat: return niimbotPacket(NIIM_IN.heartbeatAdvanced1, [0, 0, 0, 0, 0, 0, 0, 0, 1, 3]);
      case NIIM.setDensity: return niimbotPacket(NIIM_IN.setDensity, [1]);
      case NIIM.setLabelType: return niimbotPacket(NIIM_IN.setLabelType, [1]);
      case NIIM.printStart: return niimbotPacket(NIIM_IN.printStart, [1]);
      case NIIM.printClear: return niimbotPacket(NIIM_IN.printClear, [1]);
      case NIIM.pageStart: return niimbotPacket(NIIM_IN.pageStart, [1]);
      case NIIM.setPageSize: return niimbotPacket(NIIM_IN.setPageSize, [1]);
      case NIIM.printQuantity: return niimbotPacket(NIIM_IN.printQuantity, [1]);
      case NIIM.pageEnd: return niimbotPacket(NIIM_IN.pageEnd, [1]);
      case NIIM.printEnd: return niimbotPacket(NIIM_IN.printEnd, [1]);
      case NIIM.printStatus: {
        polls++;
        const done = polls >= 2;
        const body = [0, done ? 1 : 0, done ? 100 : 40, done ? 100 : 0];
        return niimbotPacket(NIIM_IN.printStatus, opts.statusLen === 10 ? [...body, 0, 0, 0, 0, 0, 0] : body);
      }
      default: return null;
    }
  });
}

const sent = (pipe: FakePipe): number[] => pipe.writes.map((w) => parseNiimbotPackets(w)[0]?.cmd ?? -1);

describe("paquets niimbot", () => {
  it("cadre, somme XOR et préfixe de la commande de connexion", () => {
    expect(toHex(niimbotPacket(NIIM.setDensity, [3]))).toBe("55 55 21 01 03 23 aa aa");
    expect(toHex(niimbotPacket(NIIM.connect, [1]))).toBe("03 55 55 c1 01 01 c1 aa aa");
    expect(() => niimbotPacket(0x85, new Uint8Array(256))).toThrow();
  });

  it("relit un flux fragmenté, ignore le bruit et les sommes fausses", () => {
    const a = niimbotPacket(NIIM_IN.printStart, [1]);
    const b = niimbotPacket(NIIM_IN.printStatus, [0, 1, 100, 100]);
    const bad = Uint8Array.from(niimbotPacket(NIIM_IN.pageEnd, [1]));
    bad[5] ^= 0xff;
    const stream = Uint8Array.from([0x00, 0x55, ...a, ...bad, ...b]);
    expect(parseNiimbotPackets(stream).map((p) => p.cmd)).toEqual([NIIM_IN.printStart, NIIM_IN.printStatus]);
    expect(parseNiimbotPackets(stream.subarray(0, stream.length - 3)).map((p) => p.cmd)).toEqual([NIIM_IN.printStart]);
  });

  it("ligne de 4 points : paquet indexé identique à l'exemple de la référence", () => {
    // Référence niimbluelib : 5555 83 0e 007e 000400 01 0027 0028 0029 002a fa aaaa
    const rows = 127;
    const data = new Uint8Array(12 * rows);
    for (const x of [39, 40, 41, 42]) data[126 * 12 + (x >> 3)] |= 0x80 >> (x & 7);
    const packets = niimbotRows({ data, bytesPerRow: 12, rows }, 96);
    expect(toHex(packets[packets.length - 1], "")).toBe("5555830e007e000400010027002800290" + "02afaaaaa");
    // Les 126 lignes blanches du dessus : une seule commande de saut.
    expect(toHex(packets[0], "")).toBe(toHex(niimbotPacket(NIIM.printEmptyRow, [0, 0, 126]), ""));
    expect(packets.length).toBe(2);
  });

  it("lignes pleines : bitmap, répétitions regroupées par 255", () => {
    const data = new Uint8Array(12 * 300).fill(0xff);
    const packets = niimbotRows({ data, bytesPerRow: 12, rows: 300 }, 96).map((p) => parseNiimbotPackets(p)[0]);
    expect(packets.map((p) => p.cmd)).toEqual([NIIM.printBitmapRow, NIIM.printBitmapRow]);
    expect(Array.from(packets[0].data.subarray(0, 6))).toEqual([0, 0, 32, 32, 32, 255]);
    expect(Array.from(packets[1].data.subarray(0, 6))).toEqual([0, 255, 32, 32, 32, 45]);
    expect(packets[0].data.length).toBe(6 + 12);
  });

  it("comptes de points : par tiers de tête, ou total quand la ligne dépasse", () => {
    const row = Uint8Array.from([0xff, 0, 0, 0, 0x0f, 0, 0, 0, 0, 0, 0, 0x01]);
    expect(niimbotCounts(row, 96)).toEqual({ total: 13, parts: [8, 4, 1] });
    expect(niimbotCounts(row, 96, "total")).toEqual({ total: 13, parts: [0, 13, 0] });
    expect(niimbotCounts(new Uint8Array(48).fill(0xff), 96).parts).toEqual([0, 0x80, 0x01]);
  });

  it("noirceur, modèles et variantes", () => {
    expect([0, 1, 2].map((l) => niimbotDensity(l, [1, 3, 2]))).toEqual([1, 2, 3]);
    expect([0, 1, 2].map((l) => niimbotDensity(l, [1, 5, 3]))).toEqual([1, 3, 5]);
    expect(niimbotModel(2304, 0)).toMatchObject({ name: "D110", task: "d110", widthPx: 96 });
    expect(niimbotModel(4096, 3)).toMatchObject({ name: "B1", task: "b1", widthPx: 384 });
    expect(niimbotModel(512, 0)?.task).toBe("d11v1");
    expect(niimbotModel(512, 2)?.task).toBe("d110");
    expect(niimbotModel(9999, 0)).toBeNull();
    expect(modelFromName("D110-E1234567")).toMatchObject({ protocol: "niimbot", widthPx: 96 });
    expect(modelFromName("B1-G123")).toMatchObject({ protocol: "niimbot", widthPx: 384 });
    expect(modelFromName("D11s_1234")?.protocol).toBe("luck-aiyin");
    expect(createProtocol("niimbot")?.id).toBe("niimbot");
    expect(createProtocol("niimbot-b1")?.id).toBe("niimbot-b1");
    expect(createProtocol("niimbot-rien")).toBeNull();
  });

  it("battement : capot et batterie, octet du capot inversé sur D110", () => {
    const p = { cmd: NIIM_IN.heartbeatAdvanced1, data: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 3]) };
    expect(parseNiimbotHeartbeat(p, 2304)).toMatchObject({ battery: 75, status: { cover: "closed" } });
    expect(parseNiimbotHeartbeat(p, 4096)?.status.cover).toBe("open");
    expect(parseNiimbotHeartbeat({ cmd: NIIM_IN.heartbeatAdvanced1, data: new Uint8Array(3) }, null)).toBeNull();
  });
});

describe("protocole niimbot", () => {
  it("info : modèle, micrologiciel, batterie, état", async () => {
    const link = new PrinterLink(fakeNiimbot(), 0);
    const info = await niimbotProtocol().info(link);
    expect(info).toMatchObject({ model: "D110", firmware: "3.00", battery: 75 });
    expect(info.status?.cover).toBe("closed");
  });

  it("D110 : séquence de la référence, puis fin de tâche", async () => {
    const pipe = fakeNiimbot();
    const link = new PrinterLink(pipe, 0);
    const proto = niimbotProtocol();
    await proto.info(link);
    pipe.writes.length = 0;
    const progress: number[] = [];
    const error = await proto.print(link, { data: new Uint8Array(12 * 240).fill(0xff), bytesPerRow: 12, rows: 240, density: 2, paper: "gap" }, (p) => progress.push(p));
    expect(error).toBeNull();
    expect(sent(pipe)).toEqual([
      NIIM.setDensity, NIIM.setLabelType, NIIM.printStart, NIIM.printClear, NIIM.pageStart, NIIM.setPageSize, NIIM.printQuantity,
      NIIM.printBitmapRow, NIIM.pageEnd, NIIM.printStatus, NIIM.printStatus, NIIM.printEnd,
    ]);
    expect(toHex(pipe.writes[0], "")).toBe("5555210103" + "23aaaa");
    expect(toHex(pipe.writes[5], "")).toBe(toHex(niimbotPacket(NIIM.setPageSize, [0, 240, 0, 96]), ""));
    expect(progress[progress.length - 1]).toBe(1);
  });

  it("B1 : début de tâche sur 7 octets, dimensions avec le nombre de copies, pas d'effacement", async () => {
    const pipe = fakeNiimbot({ name: "B1-G1", modelId: 4096 });
    const link = new PrinterLink(pipe, 0);
    const proto = niimbotProtocol();
    expect((await proto.info(link)).model).toBe("B1");
    pipe.writes.length = 0;
    expect(await proto.print(link, { data: new Uint8Array(48 * 80), bytesPerRow: 48, rows: 80, density: 1, paper: "continuous" }, () => undefined)).toBeNull();
    expect(sent(pipe)).toEqual([NIIM.setDensity, NIIM.setLabelType, NIIM.printStart, NIIM.pageStart, NIIM.setPageSize, NIIM.printEmptyRow, NIIM.pageEnd, NIIM.printStatus, NIIM.printStatus, NIIM.printEnd]);
    expect(Array.from(parseNiimbotPackets(pipe.writes[0])[0].data)).toEqual([3]);
    expect(Array.from(parseNiimbotPackets(pipe.writes[1])[0].data)).toEqual([3]);
    expect(Array.from(parseNiimbotPackets(pipe.writes[2])[0].data)).toEqual([0, 1, 0, 0, 0, 0, 0]);
    expect(Array.from(parseNiimbotPackets(pipe.writes[4])[0].data)).toEqual([0, 80, 0x01, 0x80, 0, 1]);
  });

  it("variante imposée v4 : ordre type puis noirceur, dimensions sur 13 octets, battement final", async () => {
    const pipe = fakeNiimbot();
    const link = new PrinterLink(pipe, 0);
    const proto = niimbotProtocol("v4");
    expect(proto.id).toBe("niimbot-v4");
    expect(await proto.print(link, { data: new Uint8Array(12 * 8).fill(1), bytesPerRow: 12, rows: 8, density: 1, paper: "gap" }, () => undefined)).toBeNull();
    const cmds = sent(pipe);
    expect(cmds.slice(0, 5)).toEqual([NIIM.setLabelType, NIIM.setDensity, NIIM.printStart, NIIM.printStatus, NIIM.setPageSize]);
    expect(parseNiimbotPackets(pipe.writes[2])[0].data.length).toBe(9);
    expect(Array.from(parseNiimbotPackets(pipe.writes[4])[0].data)).toEqual([0, 8, 0, 96, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(cmds.slice(-2)).toEqual([NIIM.printEnd, NIIM.heartbeat]);
  });

  it("erreur de l'imprimante : message lisible et fin de tâche envoyée", async () => {
    const pipe = fakeNiimbot({ error: [NIIM.pageEnd, 2] });
    const link = new PrinterLink(pipe, 0);
    const error = await niimbotProtocol("d110").print(link, { data: new Uint8Array(12 * 8), bytesPerRow: 12, rows: 8, density: 1, paper: "gap" }, () => undefined);
    expect(error).toBe("plus de papier");
    expect(sent(pipe).slice(-1)).toEqual([NIIM.printEnd]);
  });

  it("erreur signalée dans l'état d'impression (réponse de 10 octets)", async () => {
    const pipe = fakeNiimbot({ statusLen: 10 });
    const base = pipe.respond;
    pipe.respond = (data) => (parseNiimbotPackets(data)[0]?.cmd === NIIM.printStatus ? niimbotPacket(NIIM_IN.printStatus, [0, 0, 10, 0, 0, 0, 1, 0, 0, 0]) : base(data));
    const error = await niimbotProtocol("d110").print(new PrinterLink(pipe, 0), { data: new Uint8Array(12 * 8), bytesPerRow: 12, rows: 8, density: 1, paper: "gap" }, () => undefined);
    expect(error).toBe("capot ouvert");
  });

  it("imprimante muette : message, pas d'exception", async () => {
    const pipe = new FakePipe("D110-X");
    const link = new PrinterLink(pipe, 0);
    const proto = niimbotProtocol();
    expect(await proto.info(link)).toMatchObject({ model: null, battery: null });
    expect(await proto.print(link, { data: new Uint8Array(12), bytesPerRow: 12, rows: 1, density: 1, paper: "gap" }, () => undefined)).toBe("pas de réponse de l'imprimante");
  });
});

describe("sonic-label-printer et sonic-bluetooth avec une Niimbot", () => {
  it("auto : protocole et tête d'après le nom, puis le modèle lu", async () => {
    const pipe = fakeNiimbot({ name: "B1-G1", modelId: 4096 });
    const host = document.createElement("div");
    host.id = "fake";
    Object.defineProperties(host, { pipeReady: { get: () => true }, deviceName: { get: () => pipe.deviceName }, writeBytes: { value: pipe.writeBytes.bind(pipe) }, onBytes: { value: pipe.onBytes.bind(pipe) } });
    document.body.appendChild(host);
    document.body.insertAdjacentHTML("beforeend", `<sonic-label-printer id="imp" transport="#fake" time-scale="0"></sonic-label-printer>`);
    const el = document.querySelector("#imp") as SonicLabelPrinter;
    for (let i = 0; i < 40 && el.getState().status !== "ready"; i++) await wait(50);
    expect(el.getState()).toMatchObject({ protocol: "niimbot", model: "B1", head: { widthPx: 384, dpi: 203 }, battery: 75 });
    expect(await el.printBitmap({ width: 400, height: 240, bits: new Uint8Array(400 * 240).fill(1) })).toBe(true);
    expect(el.getState()).toMatchObject({ jobs: 1, error: null });
  });

  it("nom inconnu : le profil du transport désigne le protocole", async () => {
    const pipe = fakeNiimbot({ name: "Etiqueteuse" });
    const host = document.createElement("div");
    host.id = "fake";
    Object.defineProperties(host, { pipeReady: { get: () => true }, deviceName: { get: () => pipe.deviceName }, pipeProfile: { get: () => "niimbot" }, writeBytes: { value: pipe.writeBytes.bind(pipe) }, onBytes: { value: pipe.onBytes.bind(pipe) } });
    document.body.appendChild(host);
    document.body.insertAdjacentHTML("beforeend", `<sonic-label-printer id="imp" transport="#fake" time-scale="0"></sonic-label-printer>`);
    const el = document.querySelector("#imp") as SonicLabelPrinter;
    for (let i = 0; i < 40 && el.getState().status !== "ready"; i++) await wait(50);
    expect(el.getState()).toMatchObject({ protocol: "niimbot", model: "D110" });
  });

  it("profile=\"luck niimbot\" : filtres réunis, profil retenu d'après le service présent", async () => {
    const niim = getProfile("niimbot")!;
    const [serviceShort, charUuid] = niim.channels.tx.split("/");
    const service = expandUuid(serviceShort) as string;
    const written: Uint8Array[] = [];
    const char = Object.assign(new EventTarget(), {
      uuid: charUuid, value: null, properties: { writeWithoutResponse: true, notify: true },
      async writeValueWithoutResponse(d: Uint8Array) { written.push(Uint8Array.from(d)); },
      async startNotifications() { /* rien */ },
      async stopNotifications() { /* rien */ },
    });
    const device = Object.assign(new EventTarget(), {
      id: "n1", name: "D110-E1",
      gatt: {
        connected: false,
        async connect() { this.connected = true; return this; },
        disconnect() { this.connected = false; },
        async getPrimaryService(uuid: string) {
          if (uuid !== service) throw Object.assign(new Error("NotFoundError"), { name: "NotFoundError" });
          return { uuid, getCharacteristics: async () => [char], getCharacteristic: async (c: string) => { if (c !== charUuid) throw new Error("absent"); return char; } };
        },
      },
    });
    let asked: { filters?: { namePrefix?: string; services?: string[] }[]; optionalServices?: string[] } = {};
    const before = Object.getOwnPropertyDescriptor(navigator, "bluetooth");
    Object.defineProperty(navigator, "bluetooth", { configurable: true, writable: true, value: { requestDevice: async (o: typeof asked) => ((asked = o), device) } });
    try {
      document.body.insertAdjacentHTML("beforeend", `<sonic-bluetooth id="bt" profile="luck niimbot"></sonic-bluetooth>`);
      const el = document.querySelector("#bt") as SonicBluetooth;
      await el.updateComplete;
      expect(await el.connect()).toBe(true);
      expect(asked.filters?.some((f) => f.namePrefix === "FICHERO")).toBe(true);
      expect(asked.filters?.some((f) => f.services?.includes(service))).toBe(true);
      expect(asked.optionalServices).toContain(service);
      expect(el.getState()).toMatchObject({ connected: true, profile: "niimbot", error: null });
      expect(el.pipeProfile).toBe("niimbot");
      // Un paquet de ligne (25 octets) part en une seule écriture.
      expect(await el.writeBytes(niimbotPacket(NIIM.printBitmapRow, new Uint8Array(18)))).toBe(true);
      expect(written.length).toBe(1);
    } finally {
      if (before) Object.defineProperty(navigator, "bluetooth", before);
      else delete (navigator as unknown as Record<string, unknown>).bluetooth;
    }
  });
});
