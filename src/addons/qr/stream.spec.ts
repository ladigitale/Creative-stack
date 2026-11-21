import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import {
  MAX_QR_TEXT,
  QrStreamAssembler,
  base64ToBytes,
  bytesToBase64,
  parseDataUrl,
  qrMatrix,
  qrStreamFrames,
  qrStreamHash,
  type QrReaderState,
  type QrReceiverState,
  type QrSenderState,
  type SonicQrReader,
  type SonicQrReceiver,
  type SonicQrSender,
} from "./index";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";

function sample(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 3)) & 255;
  return b;
}

describe("flux de QR : protocole", () => {
  it("base64 aller-retour, y compris sur de gros tampons", () => {
    const b = sample(100_000);
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    expect(base64ToBytes("pas du base64 !")).toBeNull();
  });

  it("empreinte stable et sensible au contenu", () => {
    expect(qrStreamHash(new Uint8Array([1, 2, 3]))).toBe(qrStreamHash(new Uint8Array([1, 2, 3])));
    expect(qrStreamHash(new Uint8Array([1, 2, 3]))).not.toBe(qrStreamHash(new Uint8Array([1, 2, 4])));
    expect(qrStreamHash(new Uint8Array(0))).toBe("811c9dc5");
  });

  it("trames : une fiche puis les octets, chacune affichable en QR code", () => {
    const frames = qrStreamFrames(sample(1000), { mime: "image/jpeg", name: "photo.jpg" }, { chunk: 300, id: "ab12" });
    expect(frames.length).toBe(5);
    expect(frames[0].startsWith("QS1|ab12|0|5|")).toBe(true);
    expect(frames[4].startsWith("QS1|ab12|4|5|")).toBe(true);
    for (const f of frames) {
      expect(f.length).toBeLessThanOrEqual(MAX_QR_TEXT);
      expect(qrMatrix(f, "L")!.version).toBeLessThanOrEqual(15);
    }
    // Trame la plus dense autorisée : encore sous la limite d'un QR lisible.
    const dense = qrStreamFrames(sample(4000), { mime: "image/jpeg" }, { chunk: 800 });
    expect(Math.max(...dense.map((f) => f.length))).toBeLessThanOrEqual(MAX_QR_TEXT);
  });

  it("rassemble dans le désordre, avec doublons et trames étrangères", () => {
    const bytes = sample(2345);
    const frames = qrStreamFrames(bytes, { mime: "image/png", name: "x.png" }, { chunk: 200, id: "zz" });
    const a = new QrStreamAssembler();
    const order = frames.map((_, i) => i).sort((x, y) => ((x * 7) % frames.length) - ((y * 7) % frames.length));
    expect(a.feed("https://exemple.org")).toBe("ignored");
    expect(a.feed(42)).toBe("ignored");
    let last = "";
    for (const i of order) {
      expect(a.feed(frames[i])).toMatch(/new|done/);
      last = a.feed(frames[i]);
      expect(last).toBe("known");
    }
    expect(a.done).toBe(true);
    expect(a.file).toMatchObject({ mime: "image/png", name: "x.png", size: 2345 });
    expect(a.file!.bytes).toEqual(bytes);
    expect(a.progress).toBe(1);
  });

  it("un nouvel envoi remplace le précédent", () => {
    const a = new QrStreamAssembler();
    const one = qrStreamFrames(sample(500), { mime: "a/b" }, { chunk: 100, id: "one" });
    const two = qrStreamFrames(sample(90), { mime: "text/plain" }, { chunk: 100, id: "two" });
    a.feed(one[0]);
    a.feed(one[1]);
    expect(a.received).toBe(2);
    expect(a.feed(two[1])).toBe("new");
    expect(a).toMatchObject({ id: "two", total: 2, received: 1 });
    expect(a.feed(two[0])).toBe("done");
    expect(a.file!.mime).toBe("text/plain");
  });

  it("empreinte fausse : erreur, pas de fichier", () => {
    const frames = qrStreamFrames(sample(150), { mime: "a/b" }, { chunk: 100, id: "bad" });
    const forged = `QS1|bad|2|3|${bytesToBase64(sample(50).map((v) => v ^ 1))}`;
    const a = new QrStreamAssembler();
    a.feed(frames[0]);
    a.feed(frames[1]);
    expect(a.feed(forged)).toBe("error");
    expect(a.file).toBeNull();
    expect(a.error).toMatch(/altéré/);
  });

  it("trames malformées ignorées", () => {
    const a = new QrStreamAssembler();
    for (const t of ["QS1|x|5|3|AAAA", "QS1|x|0|1|AAAA", "QS1|x|a|3|AAAA", "QS1|x|1|3|", "QS1||1|3|AAAA", "QS2|x|1|3|AAAA"]) {
      expect(a.feed(t)).toBe("ignored");
    }
    expect(a.total).toBe(0);
  });

  it("URL data: en base64 et en texte", () => {
    expect(parseDataUrl("data:image/png;base64,AQID")).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
    const t = parseDataUrl("data:text/plain;charset=utf-8,%C3%A9t%C3%A9")!;
    expect(new TextDecoder().decode(t.bytes)).toBe("été");
    expect(t.mime).toBe("text/plain");
    expect(parseDataUrl("https://exemple.org")).toBeNull();
  });
});

const get = <T>(name: string) => PublisherManager.get(name).get() as T;

async function mount<T extends HTMLElement>(tag: string, attrs: Record<string, string>): Promise<T> {
  const el = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

describe("sonic-qr-sender", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("envoie un texte en boucle, trame après trame, au rythme demandé", async () => {
    PublisherManager.get("src1").set({ texte: "", n: 0 });
    await mount<SonicQrSender>("sonic-qr-sender", { from: "src1.texte", "send-from": "src1.n", fps: "10", chunk: "20", "out-data-provider": "send1" });
    expect(get<QrSenderState>("send1").status).toBe("idle");
    PublisherManager.get("src1").set({ texte: "Un message assez long pour tenir sur plusieurs trames.", n: 1 });
    await vi.advanceTimersByTimeAsync(1);
    let s = get<QrSenderState>("send1");
    expect(s).toMatchObject({ status: "sending", index: 1, loops: 0, mime: "text/plain" });
    expect(s.frames).toBeGreaterThan(3);
    expect(s.frame.startsWith("QS1|")).toBe(true);
    const seen = new Set([s.frame]);
    const a = new QrStreamAssembler();
    a.feed(s.frame);
    for (let i = 0; i < s.frames; i++) {
      await vi.advanceTimersByTimeAsync(100);
      a.feed(get<QrSenderState>("send1").frame);
      seen.add(get<QrSenderState>("send1").frame);
    }
    s = get<QrSenderState>("send1");
    expect(seen.size).toBe(s.frames);
    expect(s.loops).toBe(1);
    expect(new TextDecoder().decode(a.file!.bytes)).toBe("Un message assez long pour tenir sur plusieurs trames.");
    expect(s.loopSeconds).toBeCloseTo(s.frames / 10, 1);
  });

  it("auto : part quand la source change ; data: lue sans réseau ; cancel arrête", async () => {
    PublisherManager.get("photo2").set({ url: "" });
    PublisherManager.get("ctl2").set({ cancel: 0 });
    await mount<SonicQrSender>("sonic-qr-sender", { from: "photo2", auto: "", "image-max": "0", control: "ctl2", name: "a.bin", "out-data-provider": "send2" });
    expect(get<QrSenderState>("send2").status).toBe("idle");
    PublisherManager.get("photo2").set({ url: "data:application/octet-stream;base64,AQIDBAU=", mime: "application/octet-stream" });
    await vi.advanceTimersByTimeAsync(1);
    expect(get<QrSenderState>("send2")).toMatchObject({ status: "sending", bytes: 5, mime: "application/octet-stream", name: "a.bin", frames: 2 });
    PublisherManager.get("ctl2").set({ cancel: 1 });
    expect(get<QrSenderState>("send2")).toMatchObject({ status: "idle", frames: 0, frame: "" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(get<QrSenderState>("send2").status).toBe("idle");
  });

  it("source illisible ou trop grosse : erreur publiée", async () => {
    const el = await mount<SonicQrSender>("sonic-qr-sender", { "out-data-provider": "send3" });
    await el.send({ url: "https://exemple.org/photo.jpg" });
    expect(get<QrSenderState>("send3")).toMatchObject({ status: "error" });
    expect(get<QrSenderState>("send3").error).toMatch(/blob: ou data:/);
    await el.send("x".repeat(400_001));
    expect(get<QrSenderState>("send3").error).toMatch(/trop gros/);
    await el.send("");
    expect(get<QrSenderState>("send3").error).toMatch(/rien à envoyer/);
  });
});

describe("sonic-qr-receiver", () => {
  let received: SonicActionMessage[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  beforeEach(() => {
    received = [];
    created.length = 0;
    revoked.length = 0;
    registerStore({ id: "qrStore", dispatch: (a) => received.push(a), getState: () => ({}), reset: () => {} });
    let n = 0;
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => (created.push(`blob:test/${++n}`), `blob:test/${n}`), revokeObjectURL: (u: string) => void revoked.push(u) }));
  });
  afterEach(() => {
    document.body.innerHTML = "";
    unregisterStore("qrStore");
    vi.unstubAllGlobals();
  });

  it("rassemble les textes lus, publie le fichier et prévient le store", async () => {
    PublisherManager.get("lecteur1").set({ text: "" });
    await mount<SonicQrReceiver>("sonic-qr-receiver", { source: "lecteur1.text", target: "qrStore", "file-provider": "recu1", "out-data-provider": "recv1" });
    expect(get<QrReceiverState>("recv1").status).toBe("idle");
    const frames = qrStreamFrames(sample(700), { mime: "image/jpeg", name: "p.jpg" }, { chunk: 200, id: "r1" });
    PublisherManager.get("lecteur1").set({ text: frames[2] });
    expect(get<QrReceiverState>("recv1")).toMatchObject({ status: "receiving", received: 1, total: 5, percent: 20, file: null });
    for (const i of [4, 2, 0, 1]) PublisherManager.get("lecteur1").set({ text: frames[i] });
    expect(get<QrReceiverState>("recv1").status).toBe("receiving");
    PublisherManager.get("lecteur1").set({ text: frames[3] });
    const s = get<QrReceiverState>("recv1");
    expect(s).toMatchObject({ status: "done", received: 5, percent: 100, mime: "image/jpeg", name: "p.jpg", size: 700, count: 1 });
    expect(s.file).toEqual({ url: "blob:test/1", mime: "image/jpeg", name: "p.jpg", size: 700 });
    expect(get<{ url: string }>("recu1")).toMatchObject({ url: "blob:test/1", mime: "image/jpeg" });
    expect(received).toMatchObject([{ type: "qr:received", payload: { name: "p.jpg", mime: "image/jpeg", size: 700 } }]);
  });

  it("texte reçu lisible ; nouvel envoi et reset libèrent l'ancien fichier", async () => {
    PublisherManager.get("lecteur2").set({ text: "" });
    PublisherManager.get("ctlr2").set({ reset: 0 });
    await mount<SonicQrReceiver>("sonic-qr-receiver", { source: "lecteur2.text", control: "ctlr2", "out-data-provider": "recv2" });
    for (const f of qrStreamFrames(new TextEncoder().encode("bonjour été"), { mime: "text/plain" }, { id: "t1" })) PublisherManager.get("lecteur2").set({ text: f });
    expect(get<QrReceiverState>("recv2")).toMatchObject({ status: "done", text: "bonjour été" });
    const next = qrStreamFrames(sample(50), { mime: "a/b" }, { id: "t2" });
    PublisherManager.get("lecteur2").set({ text: next[1] });
    expect(get<QrReceiverState>("recv2")).toMatchObject({ status: "receiving", file: null, text: "" });
    expect(revoked).toEqual(["blob:test/1"]);
    PublisherManager.get("lecteur2").set({ text: next[0] });
    expect(get<QrReceiverState>("recv2").status).toBe("done");
    PublisherManager.get("ctlr2").set({ reset: 1 });
    expect(get<QrReceiverState>("recv2")).toMatchObject({ status: "idle", total: 0, file: null });
    expect(revoked).toEqual(["blob:test/1", "blob:test/2"]);
  });
});

describe("sonic-qr-reader", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  function fakeCam(id: string) {
    const el = document.createElement("div") as unknown as HTMLElement & { frameSeq: number; getFrameCanvas: () => HTMLCanvasElement };
    el.id = id;
    el.frameSeq = 0;
    el.getFrameCanvas = () => document.createElement("canvas");
    document.body.appendChild(el);
    return el;
  }

  it("détecteur du navigateur : publie chaque nouveau texte une fois", async () => {
    let visible: string | null = null;
    class FakeDetector {
      static getSupportedFormats = async () => ["qr_code", "ean_13"];
      async detect() {
        return visible ? [{ rawValue: visible }] : [];
      }
    }
    vi.stubGlobal("BarcodeDetector", FakeDetector);
    const seen: SonicActionMessage[] = [];
    registerStore({ id: "readStore", dispatch: (a) => seen.push(a), getState: () => ({}), reset: () => {} });
    const cam = fakeCam("camq1");
    const el = await mount<SonicQrReader>("sonic-qr-reader", { source: "#camq1", target: "readStore", interval: "2000", "out-data-provider": "read1" });
    cam.frameSeq++;
    await el.scan();
    expect(get<QrReaderState>("read1")).toMatchObject({ status: "ready", engine: "native", text: "", count: 0 });
    visible = "QS1|a|0|2|AAAA";
    await el.scan(); // même image : pas d'analyse
    expect(get<QrReaderState>("read1").count).toBe(0);
    cam.frameSeq++;
    await el.scan();
    cam.frameSeq++;
    await el.scan(); // même texte : pas de nouvelle lecture
    expect(get<QrReaderState>("read1")).toMatchObject({ text: "QS1|a|0|2|AAAA", count: 1 });
    visible = "QS1|a|1|2|BBBB";
    cam.frameSeq++;
    await el.scan();
    expect(get<QrReaderState>("read1")).toMatchObject({ text: "QS1|a|1|2|BBBB", count: 2 });
    expect(seen.map((a) => (a.payload as { text: string }).text)).toEqual(["QS1|a|0|2|AAAA", "QS1|a|1|2|BBBB"]);
    unregisterStore("readStore");
  });

  it("sans détecteur de QR dans le navigateur et moteur imposé : erreur claire", async () => {
    class NoQr {
      static getSupportedFormats = async () => ["ean_13"];
      async detect() {
        return [];
      }
    }
    vi.stubGlobal("BarcodeDetector", NoQr);
    const cam = fakeCam("camq2");
    const el = await mount<SonicQrReader>("sonic-qr-reader", { source: "#camq2", engine: "native", interval: "2000", "out-data-provider": "read2" });
    cam.frameSeq++;
    await el.scan();
    expect(get<QrReaderState>("read2")).toMatchObject({ status: "error", engine: null });
    expect(get<QrReaderState>("read2").error).toMatch(/ne lit pas les QR/);
  });

  it("params : pause", async () => {
    class FakeDetector {
      static getSupportedFormats = async () => ["qr_code"];
      async detect() {
        return [{ rawValue: "abc" }];
      }
    }
    vi.stubGlobal("BarcodeDetector", FakeDetector);
    PublisherManager.get("pread3").set({ active: false });
    const cam = fakeCam("camq3");
    const el = await mount<SonicQrReader>("sonic-qr-reader", { source: "#camq3", params: "pread3", interval: "2000", "out-data-provider": "read3" });
    cam.frameSeq++;
    await el.scan();
    expect(get<QrReaderState>("read3")).toMatchObject({ active: false, count: 0 });
    PublisherManager.get("pread3").set({ active: true });
    await el.scan();
    expect(get<QrReaderState>("read3")).toMatchObject({ active: true, text: "abc", count: 1 });
  });
});
