import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { FakePipe, fromHex, toHex, expandUuid, getProfile, labelPixels, parseLabelMm, toPrintBitmap, luckProtocol, rasterHeader, parseLuckStatus, parseLuckError, modelFromName, PrinterLink, escposProtocol } from "./index";
import type { SonicBluetooth } from "./bluetooth";
import type { SonicLabelPrinter } from "./label-printer";
import { centerInWidth, coverage, dither, fitRect, packBitmap, rotateBitmap, toGray, type Bitmap } from "../../shared/raster1bit";
import { chunks, OpQueue } from "../../shared/bluetooth/queue";
import { isBlockedService, parseChannel } from "../../shared/bluetooth/uuid";
import { indexOfBytes, payloadBytes } from "../../shared/bluetooth/bytes";

type Restore = () => void;
let restores: Restore[] = [];
function stub(obj: object, key: string, value: unknown): void {
  const before = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (before) Object.defineProperty(obj, key, before);
    else delete (obj as Record<string, unknown>)[key];
  });
}
const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const domError = (name: string) => Object.assign(new Error(name), { name });

async function mount<T extends HTMLElement & { updateComplete: Promise<boolean> }>(html: string, selector: string): Promise<T> {
  document.body.insertAdjacentHTML("beforeend", html);
  const el = document.querySelector(selector) as T;
  await el.updateComplete;
  return el;
}

beforeEach(() => {
  restores = [];
});
afterEach(() => {
  document.body.innerHTML = "";
  for (const r of restores.reverse()) r();
});

// ─── Faux appareil GATT ──────────────────────────────────────────────────────────────────────────────────────────
class FakeChar extends EventTarget {
  value: DataView | null = null;
  written: Uint8Array[] = [];
  notifying = false;
  properties: Record<string, boolean>;
  constructor(readonly uuid: string, props: string[], private onWrite?: (data: Uint8Array) => void) {
    super();
    this.properties = Object.fromEntries(props.map((p) => [p, true]));
  }
  async readValue(): Promise<DataView> {
    return new DataView(Uint8Array.from([0x2a]).buffer);
  }
  async writeValueWithoutResponse(data: Uint8Array): Promise<void> {
    this.written.push(Uint8Array.from(data));
    this.onWrite?.(data);
  }
  async writeValueWithResponse(data: Uint8Array): Promise<void> {
    this.written.push(Uint8Array.from(data));
    this.onWrite?.(data);
  }
  async startNotifications(): Promise<void> {
    this.notifying = true;
  }
  async stopNotifications(): Promise<void> {
    this.notifying = false;
  }
  notify(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

function fakeDevice(name = "FICHERO_5836") {
  const service = expandUuid("18f0") as string;
  const tx = new FakeChar(expandUuid("2af1") as string, ["writeWithoutResponse", "write"]);
  const rx = new FakeChar(expandUuid("2af0") as string, ["notify"]);
  const device = Object.assign(new EventTarget(), {
    id: "dev-1",
    name,
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return this;
      },
      disconnect() {
        this.connected = false;
        device.dispatchEvent(new Event("gattserverdisconnected"));
      },
      async getPrimaryService(uuid: string) {
        if (uuid !== service) throw domError("NotFoundError");
        return {
          uuid,
          getCharacteristics: async () => [tx, rx],
          getCharacteristic: async (c: string) => {
            const found = [tx, rx].find((x) => x.uuid === c);
            if (!found) throw domError("NotFoundError");
            return found;
          },
        };
      },
    },
  });
  return { device, tx, rx };
}

// ─── Octets, UUID, file ──────────────────────────────────────────────────────────────────────────────────────────
describe("socle bluetooth", () => {
  it("hexadécimal : formes tolérées, refus du reste", () => {
    expect(Array.from(fromHex("1D 76 30") ?? [])).toEqual([0x1d, 0x76, 0x30]);
    expect(Array.from(fromHex("0x10,0xFF") ?? [])).toEqual([0x10, 0xff]);
    expect(fromHex("1D7")).toBeNull();
    expect(fromHex("zz")).toBeNull();
    expect(toHex([0, 255, 16])).toBe("00 ff 10");
    expect(indexOfBytes([1, 2, 3, 4], [3, 4])).toBe(2);
  });

  it("charge utile : hex, bytes, text, bornes", () => {
    expect(Array.from(payloadBytes({ hex: "0a0b" }, 8) ?? [])).toEqual([10, 11]);
    expect(Array.from(payloadBytes({ bytes: [1, 2] }, 8) ?? [])).toEqual([1, 2]);
    expect(payloadBytes({ bytes: [1, 300] }, 8)).toBeNull();
    expect(payloadBytes({ text: "ok" }, 8)?.length).toBe(2);
    expect(payloadBytes({ text: "trop long pour la limite" }, 8)).toBeNull();
    expect(payloadBytes({}, 8)).toBeNull();
  });

  it("UUID : court, nommé, complet ; canaux ; services refusés", () => {
    expect(expandUuid("18f0")).toBe("000018f0-0000-1000-8000-00805f9b34fb");
    expect(expandUuid("heart_rate")).toBe("0000180d-0000-1000-8000-00805f9b34fb");
    expect(expandUuid("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")).toBe("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    expect(expandUuid("pas-un-uuid")).toBeNull();
    expect(parseChannel("18f0/2af1")).toEqual({ service: expandUuid("18f0"), characteristic: expandUuid("2af1") });
    expect(parseChannel("18f0")).toBeNull();
    expect(isBlockedService(expandUuid("1812") as string)).toBe(true);
    expect(isBlockedService(expandUuid("fe59") as string)).toBe(true);
    expect(isBlockedService(expandUuid("18f0") as string)).toBe(false);
  });

  it("profils : luck porte les canaux, le découpage et les commandes interdites", () => {
    const luck = getProfile("luck");
    expect(luck?.channels).toEqual({ tx: "18f0/2af1", rx: "18f0/2af0" });
    expect(luck?.chunkSize).toBe(200);
    expect(luck?.forbidden).toContainEqual([0x10, 0xff, 0xe0]);
    expect(getProfile("constructor")).toBeNull();
    expect(getProfile("inconnu")).toBeNull();
  });

  it("file : ordre gardé, vidage à la déconnexion", async () => {
    expect(chunks(new Uint8Array(450), 200).map((c) => c.length)).toEqual([200, 200, 50]);
    const q = new OpQueue();
    const order: number[] = [];
    const a = q.run(async () => {
      await wait(5);
      order.push(1);
      return "a";
    });
    const b = q.run(async () => {
      order.push(2);
      return "b";
    });
    q.clear();
    const c = q.run(async () => "c");
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(await c).toBe("c");
    expect(order).toEqual([]);
  });
});

// ─── Image 1 bit ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("raster 1 bit", () => {
  it("gris : transparence posée sur du blanc", () => {
    const g = toGray([0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255], 3, 1);
    expect(Array.from(g).map(Math.round)).toEqual([0, 255, 255]);
  });

  it("seuil, Floyd-Steinberg, Atkinson et Bayer rendent un gris moyen à moitié noir environ", () => {
    const gray = new Float32Array(64 * 64).fill(128);
    expect(coverage(dither(gray, 64, 64, "threshold", 128))).toBe(0);
    expect(coverage(dither(gray, 64, 64, "threshold", 129))).toBe(1);
    for (const mode of ["floyd", "bayer"] as const) {
      const c = coverage(dither(gray, 64, 64, mode, 128));
      expect(c).toBeGreaterThan(0.4);
      expect(c).toBeLessThan(0.6);
    }
    const atk = coverage(dither(gray, 64, 64, "atkinson", 128));
    expect(atk).toBeGreaterThan(0.3);
    expect(atk).toBeLessThan(0.7);
  });

  it("rotation d'un quart de tour : le coin haut gauche passe en haut à droite", () => {
    const src: Bitmap = { width: 3, height: 2, bits: Uint8Array.from([1, 0, 0, 0, 0, 0]) };
    const r = rotateBitmap(src, 90);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(Array.from(r.bits)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(Array.from(rotateBitmap(rotateBitmap(src, 90), 270).bits)).toEqual(Array.from(src.bits));
    expect(Array.from(rotateBitmap(src, 180).bits)).toEqual([0, 0, 0, 0, 0, 1]);
  });

  it("emballage : bit de poids fort à gauche, lignes complétées", () => {
    const packed = packBitmap({ width: 10, height: 2, bits: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) });
    expect(packed.bytesPerRow).toBe(2);
    expect(Array.from(packed.data)).toEqual([0x81, 0x80, 0x00, 0x40]);
  });

  it("centrage dans la largeur de la tête et cadrage", () => {
    const c = centerInWidth({ width: 2, height: 1, bits: Uint8Array.from([1, 1]) }, 6);
    expect(Array.from(c.bits)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(fitRect(100, 50, 240, 96, "contain")).toEqual({ x: 24, y: 0, w: 192, h: 96 });
    expect(fitRect(100, 50, 240, 96, "cover")).toEqual({ x: 0, y: -12, w: 240, h: 120 });
    expect(fitRect(100, 50, 240, 96, "stretch")).toEqual({ x: 0, y: 0, w: 240, h: 96 });
  });
});

// ─── Protocole LuckPrinter (Fichero) ─────────────────────────────────────────────────────────────────────────────
/** Imprimante simulée : répond comme un D11s. */
function fakeFichero(status = 0x00, stopReply: number[] = [0xaa]): FakePipe {
  return new FakePipe("FICHERO_5836", (data) => {
    const hex = toHex(data, "");
    if (hex === "10ff20f0") return [0x44, 0x31, 0x31, 0x73]; // D11s
    if (hex === "10ff20f1") return [0x32, 0x2e, 0x34, 0x2e, 0x36]; // 2.4.6
    if (hex === "10ff50f1") return [0x00, 0x56];
    if (hex === "10ff40") return [status];
    if (hex.startsWith("10ff10") || hex.startsWith("10ff84")) return [0x4f, 0x4b];
    if (hex === "10fffe45" || hex === "10fff145") return stopReply;
    return null;
  });
}

describe("protocole luck", () => {
  it("en-tête raster d'une étiquette 30 x 12 mm", () => {
    expect(toHex(rasterHeader(12, 240))).toBe("1d 76 30 00 0c 00 f0 00");
    expect(toHex(rasterHeader(48, 300))).toBe("1d 76 30 00 30 00 2c 01");
  });

  it("octet d'état et réponse d'erreur", () => {
    expect(parseLuckStatus(0x00)).toMatchObject({ cover: "closed", paper: "ok", overheated: false, charging: false, printing: false });
    expect(parseLuckStatus(0x02).cover).toBe("open");
    expect(parseLuckStatus(0x04).paper).toBe("out");
    expect(parseLuckStatus(0x10).overheated).toBe(true);
    expect(parseLuckStatus(0x40).overheated).toBe(true);
    expect(parseLuckStatus(0x28)).toMatchObject({ charging: true, lowBattery: true });
    expect(parseLuckError([0xff, 0x06])).toBe("capot ouvert, plus de papier");
    expect(parseLuckError([0xaa])).toBeNull();
  });

  it("informations : modèle, micrologiciel, batterie, état", async () => {
    const link = new PrinterLink(fakeFichero(0x20), 0);
    const info = await luckProtocol("aiyin").info(link);
    expect(info).toMatchObject({ model: "D11s", firmware: "2.4.6", battery: 86 });
    expect(info.status?.charging).toBe(true);
  });

  it("séquence d'impression complète, dans l'ordre de la référence", async () => {
    const pipe = fakeFichero();
    const link = new PrinterLink(pipe, 0);
    const data = new Uint8Array(12 * 240).fill(0xff);
    const progress: number[] = [];
    const error = await luckProtocol("aiyin").print(link, { data, bytesPerRow: 12, rows: 240, density: 2, paper: "gap" }, (p) => progress.push(p));
    expect(error).toBeNull();
    const sent = pipe.writes.map((w) => toHex(w.subarray(0, 8), ""));
    expect(sent[0]).toBe("10ff40");
    expect(sent[1]).toBe("10ff100002");
    expect(sent[2]).toBe("10ff8400");
    expect(sent[3]).toBe("0000000000000000");
    expect(pipe.writes[3].length).toBe(12);
    expect(sent[4]).toBe("10fffe01");
    expect(sent[5]).toBe("1d7630000c00f000");
    expect(pipe.writes[5].length).toBe(8 + 2880);
    expect(sent[6]).toBe("1d0c");
    expect(sent[7]).toBe("10fffe45");
    expect(pipe.writes.length).toBe(8);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it("variante Lujiang : autres commandes d'activation et de fin", async () => {
    const pipe = fakeFichero();
    await luckProtocol("lujiang").print(new PrinterLink(pipe, 0), { data: new Uint8Array(12), bytesPerRow: 12, rows: 1, density: 1, paper: "continuous" }, () => undefined);
    const sent = pipe.writes.map((w) => toHex(w, ""));
    expect(sent).toContain("10fff103");
    expect(sent).toContain("10fff145");
    expect(sent).toContain("10ff8402");
  });

  it("refuse d'imprimer capot ouvert ou sans papier, relaie l'erreur de fin", async () => {
    const job = { data: new Uint8Array(12), bytesPerRow: 12, rows: 1, density: 1, paper: "gap" as const };
    const open = fakeFichero(0x02);
    expect(await luckProtocol("aiyin").print(new PrinterLink(open, 0), job, () => undefined)).toBe("capot ouvert");
    expect(open.writes.length).toBe(1);
    expect(await luckProtocol("aiyin").print(new PrinterLink(fakeFichero(0x04), 0), job, () => undefined)).toBe("plus de papier");
    expect(await luckProtocol("aiyin").print(new PrinterLink(fakeFichero(0, [0xff, 0x04]), 0), job, () => undefined)).toBe("plus de papier");
  });

  it("déconnexion en cours d'impression : message, pas d'exception", async () => {
    const pipe = fakeFichero();
    const link = new PrinterLink(pipe, 0);
    const original = pipe.writeBytes.bind(pipe);
    pipe.writeBytes = async (d, o) => {
      if (d.length > 100) pipe.pipeReady = false;
      return original(d, o);
    };
    const error = await luckProtocol("aiyin").print(link, { data: new Uint8Array(2880), bytesPerRow: 12, rows: 240, density: 1, paper: "gap" }, () => undefined);
    expect(error).toBe("imprimante déconnectée");
  });

  it("ESC/POS : initialisation, bandes de 255 lignes, avance", async () => {
    const pipe = new FakePipe("POS");
    const error = await escposProtocol().print(new PrinterLink(pipe, 0), { data: new Uint8Array(48 * 300), bytesPerRow: 48, rows: 300, density: 1, paper: "continuous" }, () => undefined);
    expect(error).toBeNull();
    expect(toHex(pipe.writes[0], "")).toBe("1b40");
    expect(toHex(pipe.writes[1].subarray(0, 8), "")).toBe("1d76300030 00ff00".replace(" ", ""));
    expect(toHex(pipe.writes[2].subarray(0, 8), "")).toBe("1d763000300 02d00".replace(" ", ""));
    expect(toHex(pipe.writes[3], "")).toBe("1b4a50");
  });
});

// ─── Étiquette ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("géométrie de l'étiquette", () => {
  const d11s = modelFromName("FICHERO_5836");

  it("modèle reconnu par le nom", () => {
    expect(d11s).toMatchObject({ protocol: "luck-aiyin", widthPx: 96, dpi: 203 });
    expect(modelFromName("D11s_1234")?.protocol).toBe("luck-aiyin");
    expect(modelFromName("Inconnue")).toBeNull();
  });

  it("label-mm : formes acceptées", () => {
    expect(parseLabelMm("30x12")).toEqual([30, 12]);
    expect(parseLabelMm("40 × 12,5")).toEqual([40, 12.5]);
    expect(parseLabelMm([30, 12])).toEqual([30, 12]);
    expect(parseLabelMm("30")).toBeNull();
    expect(parseLabelMm("0x12")).toBeNull();
  });

  it("30 x 12 mm = 240 x 96 points ; largeur ramenée à la tête", () => {
    expect(labelPixels([30, 12], d11s!)).toEqual({ along: 240, across: 96 });
    expect(labelPixels([30, 14], d11s!)).toEqual({ along: 240, across: 96 });
    expect(labelPixels([40, 10], d11s!)).toEqual({ along: 320, across: 80 });
  });

  it("paysage : le dessin 240 x 96 devient 96 colonnes x 240 lignes", () => {
    const design: Bitmap = { width: 240, height: 96, bits: new Uint8Array(240 * 96) };
    design.bits[0] = 1; // coin haut gauche du dessin
    const print = toPrintBitmap(design, "landscape", 96);
    expect([print.width, print.height]).toEqual([96, 240]);
    expect(print.bits[95]).toBe(1); // première ligne imprimée, dernier point
    const flipped = toPrintBitmap(design, "landscape", 96, true);
    expect(flipped.bits[239 * 96]).toBe(1); // demi-tour : dernière ligne, premier point
    const narrow = toPrintBitmap({ width: 240, height: 80, bits: new Uint8Array(240 * 80).fill(1) }, "landscape", 96);
    expect(narrow.width).toBe(96);
    expect(Array.from(narrow.bits.subarray(0, 96)).filter(Boolean).length).toBe(80);
    expect(narrow.bits[0]).toBe(0);
    expect(narrow.bits[8]).toBe(1);
  });
});

// ─── sonic-bluetooth ─────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-bluetooth", () => {
  it("sans Web Bluetooth : unsupported, connect ne lève pas", async () => {
    stub(navigator, "bluetooth", undefined);
    const el = await mount<SonicBluetooth>(`<sonic-bluetooth id="bt" profile="luck"></sonic-bluetooth>`, "#bt");
    expect(el.getState()).toMatchObject({ status: "unsupported", supported: false });
    expect(await el.connect()).toBe(false);
    expect(el.getState().error).toContain("non disponible");
  });

  it("connexion par profil : filtres et services demandés, canaux ouverts, état publié", async () => {
    const { device, rx } = fakeDevice();
    let asked: unknown;
    stub(navigator, "bluetooth", { requestDevice: async (o: unknown) => ((asked = o), device), getAvailability: async () => true });
    const el = await mount<SonicBluetooth>(`<sonic-bluetooth id="bt2" profile="luck"></sonic-bluetooth>`, "#bt2");
    expect(await el.connect()).toBe(true);
    expect(asked).toEqual({ filters: [{ namePrefix: "FICHERO" }, { namePrefix: "D11s_" }], optionalServices: [expandUuid("18f0")] });
    const s = el.getState();
    expect(s).toMatchObject({ status: "ready", connected: true, active: true, device: { id: "dev-1", name: "FICHERO_5836" }, channels: ["tx", "rx"] });
    expect(s.services[0].characteristics.map((c) => c.props)).toEqual([["write", "writeWithoutResponse"], ["notify"]]);
    expect(rx.notifying).toBe(true);
    expect(el.pipeReady).toBe(true);
    expect(el.deviceName).toBe("FICHERO_5836");
    expect((get("bt2State") as { connected?: boolean }).connected).toBe(true);
  });

  it("sélecteur fermé : retour à idle sans erreur ; refus : denied", async () => {
    stub(navigator, "bluetooth", { requestDevice: async () => Promise.reject(domError("NotFoundError")) });
    const el = await mount<SonicBluetooth>(`<sonic-bluetooth id="bt3" profile="luck"></sonic-bluetooth>`, "#bt3");
    expect(await el.connect()).toBe(false);
    expect(el.getState()).toMatchObject({ status: "idle", error: null });
    stub(navigator, "bluetooth", { requestDevice: async () => Promise.reject(domError("SecurityError")) });
    expect(await el.connect()).toBe(false);
    expect(el.getState().status).toBe("denied");
  });

  it("configuration invalide : message, aucune demande au navigateur", async () => {
    let calls = 0;
    stub(navigator, "bluetooth", { requestDevice: async () => (calls++, fakeDevice().device) });
    const cases: [string, string][] = [
      [`profile="nexistepas"`, "profil inconnu"],
      [`services="1812" accept-all`, "service refusé"],
      [`channels='{"tx":"fe59/2af1"}' accept-all`, "service refusé"],
      [`channels='{"tx":"18f0"}' accept-all`, "canal invalide"],
      [`channels='{"tx":"18f0/2af1"}'`, "aucun filtre"],
      [`filters='[{"namePrefix":"X"}]'`, "aucun service"],
      [`filters='pas du json' services="18f0"`, "JSON invalide"],
    ];
    let i = 0;
    for (const [attrs, message] of cases) {
      const id = `bad${i++}`;
      const el = await mount<SonicBluetooth>(`<sonic-bluetooth id="${id}" ${attrs}></sonic-bluetooth>`, `#${id}`);
      expect(await el.connect()).toBe(false);
      expect(el.getState().error).toContain(message);
    }
    expect(calls).toBe(0);
  });

  it("écriture découpée en morceaux, notifications publiées et relayées aux pilotes", async () => {
    const { device, tx, rx } = fakeDevice();
    stub(navigator, "bluetooth", { requestDevice: async () => device });
    const el = await mount<SonicBluetooth>(`<sonic-bluetooth id="bt4" profile="luck" gap-ms="0"></sonic-bluetooth>`, "#bt4");
    await el.connect();
    const heard: number[][] = [];
    const off = el.onBytes((d, channel) => heard.push([...d, channel === "rx" ? 1 : 0]));
    expect(await el.writeBytes(new Uint8Array(450).fill(7))).toBe(true);
    expect(tx.written.map((w) => w.length)).toEqual([200, 200, 50]);
    expect(el.getState().tx).toMatchObject({ queued: 0, sent: 450, n: 1 });
    rx.notify([0x4f, 0x4b]);
    await wait(60);
    expect(heard).toEqual([[0x4f, 0x4b, 1]]);
    expect(el.getState().values.rx).toMatchObject({ hex: "4f 4b", bytes: [0x4f, 0x4b], text: "OK", n: 1 });
    expect(el.getState().rx).toBe(1);
    off();
    rx.notify([0xff, 0xfe]);
    await wait(60);
    expect(heard.length).toBe(1);
    expect(el.getState().values.rx.text).toBeUndefined();
  });

  it("commandes par control : write, read ; commandes de micrologiciel refusées", async () => {
    const { device, tx } = fakeDevice();
    stub(navigator, "bluetooth", { requestDevice: async () => device });
    set("btCtl", { write: 0, read: 0 });
    const el = await mount<SonicBluetooth>(`<sonic-bluetooth id="bt5" profile="luck" control="btCtl"></sonic-bluetooth>`, "#bt5");
    await el.connect();
    set("btCtl", { write: { n: 1, hex: "10 FF 40" }, read: 0 });
    await wait(20);
    expect(toHex(tx.written[0])).toBe("10 ff 40");
    // Mise à jour de micrologiciel, même cachée au milieu de la charge utile.
    expect(await el.run("write", { hex: "00 10 FF E0 AA AA" })).toBe(false);
    expect(el.getState().error).toContain("refusée");
    expect(await el.writeBytes(Uint8Array.from([0x10, 0xff, 0x04]))).toBe(false);
    expect(tx.written.length).toBe(1);
    expect(await el.run("write", { bytes: new Array(600).fill(1) })).toBe(false);
    expect(await el.run("read", { channel: "rx" })).toBe(true);
    await wait(60);
    expect(el.getState().values.rx.bytes).toEqual([0x2a]);
  });

  it("déconnexion : état remis à zéro, écritures refusées, événement émis", async () => {
    const { device } = fakeDevice();
    stub(navigator, "bluetooth", { requestDevice: async () => device });
    const el = await mount<SonicBluetooth>(`<sonic-bluetooth id="bt6" profile="luck"></sonic-bluetooth>`, "#bt6");
    await el.connect();
    let lost = 0;
    el.addEventListener("sonic-bluetooth-disconnect", () => lost++);
    device.gatt.disconnect();
    expect(el.getState()).toMatchObject({ connected: false, active: false, device: null, error: "appareil déconnecté" });
    expect(lost).toBe(1);
    expect(await el.writeBytes(Uint8Array.from([1]))).toBe(false);
    expect(el.pipeReady).toBe(false);
  });

  it("reconnexion automatique au même appareil, sans sélecteur", async () => {
    const { device } = fakeDevice();
    let asks = 0;
    stub(navigator, "bluetooth", { requestDevice: async () => (asks++, device) });
    const el = await mount<SonicBluetooth>(`<sonic-bluetooth id="bt7" profile="luck" auto-reconnect></sonic-bluetooth>`, "#bt7");
    await el.connect();
    (el as unknown as { retryDelay: number }).retryDelay = 5;
    device.gatt.disconnect();
    expect(el.getState()).toMatchObject({ connected: false, reconnecting: true });
    await wait(60);
    expect(el.getState()).toMatchObject({ connected: true, reconnecting: false });
    expect(asks).toBe(1);
    await el.disconnect();
    await wait(30);
    expect(el.getState().connected).toBe(false);
  });
});

// ─── sonic-label-printer ─────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-label-printer", () => {
  /** Monte un pilote relié à un faux transport (élément porteur du contrat SonicBytePipe). */
  async function mountPrinter(pipe: FakePipe, attrs = ""): Promise<SonicLabelPrinter> {
    const host = document.createElement("div");
    host.id = "fake";
    Object.defineProperties(host, {
      pipeReady: { get: () => pipe.pipeReady },
      deviceName: { get: () => pipe.deviceName },
      writeBytes: { value: pipe.writeBytes.bind(pipe) },
      onBytes: { value: pipe.onBytes.bind(pipe) },
    });
    document.body.appendChild(host);
    const el = await mount<SonicLabelPrinter>(`<sonic-label-printer id="imp" transport="#fake" time-scale="0" ${attrs}></sonic-label-printer>`, "#imp");
    for (let i = 0; i < 40 && el.getState().status !== "ready"; i++) await wait(50);
    return el;
  }

  it("lit le modèle et l'état à la connexion du transport", async () => {
    const el = await mountPrinter(fakeFichero(0x20));
    expect(el.getState()).toMatchObject({
      status: "ready", active: true, protocol: "luck-aiyin", model: "D11s", firmware: "2.4.6", battery: 86, charging: true,
      paper: "ok", cover: "closed", head: { widthPx: 96, dpi: 203 },
    });
    expect(el.getState().settings).toMatchObject({ labelMm: [30, 12], orientation: "landscape", dither: "threshold", copies: 1 });
  });

  it("imprime un dessin 240 x 96 : 96 colonnes x 240 lignes, autant de fois que de copies", async () => {
    const pipe = fakeFichero();
    const el = await mountPrinter(pipe, `copies="2" density="2"`);
    pipe.writes.length = 0;
    const design: Bitmap = { width: 240, height: 96, bits: new Uint8Array(240 * 96).fill(1) };
    let done = 0;
    el.addEventListener("sonic-label-printer-done", () => done++);
    expect(await el.printBitmap(design)).toBe(true);
    const rasters = pipe.writes.filter((w) => w[0] === 0x1d && w[1] === 0x76);
    expect(rasters.length).toBe(2);
    expect(toHex(rasters[0].subarray(0, 8))).toBe("1d 76 30 00 0c 00 f0 00");
    expect(rasters[0].length).toBe(8 + 2880);
    expect(rasters[0].subarray(8).every((b) => b === 0xff)).toBe(true);
    expect(pipe.writes.filter((w) => toHex(w, "") === "10ff100002").length).toBe(2);
    expect(el.getState()).toMatchObject({ printing: false, progress: 1, jobs: 1, copy: 2, copies: 2, error: null });
    expect(done).toBe(1);
  });

  it("erreur de l'imprimante : état error, message lisible, pas de tâche comptée", async () => {
    const pipe = fakeFichero();
    const el = await mountPrinter(pipe);
    pipe.respond = (data) => (toHex(data, "") === "10ff40" ? [0x04] : null);
    expect(await el.printBitmap({ width: 240, height: 96, bits: new Uint8Array(240 * 96) })).toBe(false);
    expect(el.getState()).toMatchObject({ status: "error", error: "plus de papier", printing: false, jobs: 0 });
  });

  it("réglages bornés et signalés, changés en direct par control", async () => {
    set("impCtl", { print: 0 });
    const el = await mountPrinter(fakeFichero(), `copies="400" threshold="900" dither="rien" label-mm="30x20" control="impCtl"`);
    const s = el.getState();
    expect(s.settings).toMatchObject({ copies: 50, threshold: 255, dither: "threshold" });
    expect(s.issues.join(" | ")).toContain("copies ramené à 50");
    expect(s.issues.join(" | ")).toContain("dither inconnu");
    expect(s.issues.join(" | ")).toContain("largeur d'étiquette ramenée à 12 mm");
    set("impCtl", { print: 0, dither: "floyd", copies: 3, labelMm: "40x12" });
    await wait(20);
    expect(el.getState().settings).toMatchObject({ dither: "floyd", copies: 3, labelMm: [40, 12] });
  });

  it("sans transport ni source : messages, pas d'exception", async () => {
    const el = await mount<SonicLabelPrinter>(`<sonic-label-printer id="seul" transport="#absent" source="#rien"></sonic-label-printer>`, "#seul");
    await wait(300);
    expect(el.getState().error).toContain("transport introuvable");
    expect(await el.print()).toBe(false);
    expect(el.getState().error).toContain("source introuvable");
    expect(await el.printBitmap({ width: 8, height: 8, bits: new Uint8Array(64) })).toBe(false);
    expect(el.getState().error).toBe("imprimante non connectée");
  });

  it("protocole inconnu : erreur qui liste les protocoles disponibles", async () => {
    const el = await mount<SonicLabelPrinter>(`<sonic-label-printer id="x" transport="#fake2" protocol="phomemo"></sonic-label-printer>`, "#x");
    const pipe = new FakePipe("B21");
    const host = document.createElement("div");
    host.id = "fake2";
    Object.defineProperties(host, { pipeReady: { get: () => true }, deviceName: { get: () => "B21" }, writeBytes: { value: pipe.writeBytes.bind(pipe) }, onBytes: { value: pipe.onBytes.bind(pipe) } });
    document.body.appendChild(host);
    await wait(300);
    expect(el.getState().error).toContain("protocole inconnu");
    expect(el.getState().error).toContain("luck-aiyin");
  });
});
