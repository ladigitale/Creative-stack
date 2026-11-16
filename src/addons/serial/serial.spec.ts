import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { cleanSerialFilters, getSerialProfile, LineSplitter, matchesFilters, isBytePipe } from "./index";
import type { SonicSerial } from "./serial";

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
const text = (data: Uint8Array) => new TextDecoder().decode(data);

async function mount(html: string): Promise<SonicSerial> {
  document.body.insertAdjacentHTML("beforeend", html);
  const el = document.querySelector("sonic-serial") as SonicSerial;
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

// ─── Faux port série ─────────────────────────────────────────────────────────────────────────────────────────────
function fakePort(info: { usbVendorId?: number; usbProductId?: number } = { usbVendorId: 0x1a86, usbProductId: 0x7523 }) {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const written: Uint8Array[] = [];
  const state = { opened: null as Record<string, unknown> | null, closed: 0, forgotten: 0, openError: null as Error | null, signals: [] as unknown[] };
  const port = Object.assign(new EventTarget(), {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    async open(options: Record<string, unknown>): Promise<void> {
      if (state.openError) throw state.openError;
      state.opened = options;
      port.readable = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
      port.writable = new WritableStream<Uint8Array>({ write: (chunk) => void written.push(Uint8Array.from(chunk)) });
    },
    async close(): Promise<void> {
      state.closed++;
      port.readable = null;
      port.writable = null;
    },
    getInfo: () => info,
    async forget(): Promise<void> {
      state.forgotten++;
    },
    async setSignals(s: unknown): Promise<void> {
      state.signals.push(s);
    },
  });
  return {
    port, written, state,
    push: (s: string) => ctrl?.enqueue(new TextEncoder().encode(s)),
    unplug: () => {
      const c = ctrl;
      port.readable = null;
      c?.error(new Error("device lost"));
    },
  };
}

function fakeSerial(granted: unknown[] = [], pick: () => Promise<unknown> = async () => { throw domError("NotFoundError"); }) {
  const calls: unknown[] = [];
  const api = Object.assign(new EventTarget(), {
    granted,
    calls,
    async getPorts(): Promise<unknown[]> {
      return api.granted;
    },
    async requestPort(options: unknown): Promise<unknown> {
      calls.push(options);
      return pick();
    },
  });
  stub(navigator, "serial", api);
  return api;
}

describe("profils et filtres", () => {
  it("connaît les ponts courants", () => {
    expect(getSerialProfile("ch340")?.filters).toEqual([{ usbVendorId: 0x1a86 }]);
    expect(getSerialProfile("grbl")?.baud).toBe(115200);
    expect(getSerialProfile("constructor")).toBeNull();
  });

  it("lit les filtres en hexadécimal ou en nombre", () => {
    expect(cleanSerialFilters([{ usbVendorId: "1a86", usbProductId: "0x7523" }, { usbVendorId: 1027 }])).toEqual([{ usbVendorId: 0x1a86, usbProductId: 0x7523 }, { usbVendorId: 1027 }]);
    expect(cleanSerialFilters([{ usbProductId: 1 }])).toBeNull();
    expect(cleanSerialFilters([{ usbVendorId: "zz" }])).toBeNull();
    expect(cleanSerialFilters("x")).toBeNull();
  });

  it("compare un port à des filtres", () => {
    expect(matchesFilters({ usbVendorId: 0x1a86, usbProductId: 1 }, [{ usbVendorId: 0x1a86 }])).toBe(true);
    expect(matchesFilters({ usbVendorId: 0x1a86, usbProductId: 1 }, [{ usbVendorId: 0x1a86, usbProductId: 2 }])).toBe(false);
    expect(matchesFilters({}, [])).toBe(true);
  });
});

describe("LineSplitter", () => {
  it("assemble les lignes coupées entre deux paquets", () => {
    const s = new LineSplitter();
    const enc = new TextEncoder();
    expect(s.push(enc.encode("Grbl 1.1h ['$' for"))).toEqual([]);
    expect(s.push(enc.encode(" help]\r\nok\r\n\r\n<Idle"))).toEqual(["Grbl 1.1h ['$' for help]", "ok"]);
    expect(s.push(enc.encode(">\n"))).toEqual(["<Idle>"]);
  });

  it("coupe une ligne sans fin", () => {
    const s = new LineSplitter(8);
    expect(s.push(new TextEncoder().encode("abcdefghijkl"))).toEqual(["abcdefgh"]);
  });
});

describe("sonic-serial", () => {
  it("signale un navigateur sans Web Serial", async () => {
    const el = await mount('<sonic-serial id="p" profile="ch340"></sonic-serial>');
    expect(el.getState().supported).toBe(false);
    expect(el.getState().status).toBe("unsupported");
    expect(await el.run("connect")).toBe(false);
  });

  it("refuse une configuration sans filtre", async () => {
    fakeSerial();
    const el = await mount('<sonic-serial id="p"></sonic-serial>');
    expect(await el.run("connect")).toBe(false);
    expect(el.getState().error).toContain("aucun filtre");
  });

  it("ouvre le port choisi, lit des lignes et écrit", async () => {
    const dev = fakePort();
    const api = fakeSerial([], async () => dev.port);
    const el = await mount('<sonic-serial id="p" profile="ch340"></sonic-serial>');
    const lines: string[] = [];
    el.addEventListener("sonic-serial-line", (e) => lines.push((e as CustomEvent).detail.text));
    const bytes: number[] = [];
    el.onBytes((d) => bytes.push(...d));

    expect(await el.run("connect")).toBe(true);
    expect(api.calls).toEqual([{ filters: [{ usbVendorId: 0x1a86 }] }]);
    expect(dev.state.opened).toMatchObject({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" });
    expect(el.getState()).toMatchObject({ status: "ready", connected: true, baud: 115200, port: { vendorId: "1a86", productId: "7523", name: "CH340 1a86:7523" } });
    expect(isBytePipe(el)).toBe(true);
    expect(el.pipeReady).toBe(true);
    expect(el.deviceName).toBe("CH340 1a86:7523");

    dev.push("Grbl 1.1h ['$' for help]\r\n");
    await wait(20);
    expect(lines).toEqual(["Grbl 1.1h ['$' for help]"]);
    expect(bytes.length).toBe(26);
    await wait(60);
    expect((get("pState") as { lastLine: string }).lastLine).toBe("Grbl 1.1h ['$' for help]");
    expect(el.getState().rx).toEqual({ bytes: 26, lines: 1 });

    expect(await el.run("line", { text: "$I" })).toBe(true);
    expect(await el.run("write", { hex: "18" })).toBe(true);
    expect(dev.written.map(text)).toEqual(["$I\n", "\x18"]);
    expect(await el.run("write", { text: "" })).toBe(false);

    expect(await el.run("signals", { dtr: false })).toBe(true);
    expect(dev.state.signals).toEqual([{ dataTerminalReady: false }]);

    expect(await el.run("disconnect")).toBe(true);
    expect(dev.state.closed).toBe(1);
    expect(el.getState()).toMatchObject({ connected: false, status: "idle", port: null });
    expect(await el.writeBytes(Uint8Array.of(1))).toBe(false);
  });

  it("rouvre sans sélecteur le seul port déjà autorisé, sauf avec pick", async () => {
    const dev = fakePort();
    const other = fakePort({ usbVendorId: 0x0403, usbProductId: 1 });
    const api = fakeSerial([other.port, dev.port], async () => dev.port);
    const el = await mount('<sonic-serial id="p" profile="ch340" baud="9600"></sonic-serial>');
    expect(await el.run("connect")).toBe(true);
    expect(api.calls).toEqual([]);
    expect(dev.state.opened).toMatchObject({ baudRate: 9600 });
    await el.run("disconnect");
    expect(await el.run("connect", { pick: true })).toBe(true);
    expect(api.calls.length).toBe(1);
  });

  it("revient au repos quand le sélecteur est fermé sans choix", async () => {
    fakeSerial();
    const el = await mount('<sonic-serial id="p" profile="grbl"></sonic-serial>');
    expect(await el.run("connect")).toBe(false);
    expect(el.getState()).toMatchObject({ status: "idle", error: null });
  });

  it("explique un port occupé", async () => {
    const dev = fakePort();
    dev.state.openError = domError("NetworkError");
    fakeSerial([], async () => dev.port);
    const el = await mount('<sonic-serial id="p" profile="ch340"></sonic-serial>');
    expect(await el.run("connect")).toBe(false);
    expect(el.getState().error).toContain("autre logiciel");
  });

  it("détecte le débranchement et rouvre le port rebranché", async () => {
    const dev = fakePort();
    const api = fakeSerial([], async () => dev.port);
    const el = await mount('<sonic-serial id="p" profile="ch340" auto-reconnect></sonic-serial>');
    const events: unknown[] = [];
    el.addEventListener("sonic-serial-disconnect", (e) => events.push((e as CustomEvent).detail));
    await el.run("connect");
    dev.unplug();
    await wait(30);
    expect(el.getState()).toMatchObject({ connected: false, reconnecting: true, error: null });
    expect(events).toEqual([{ wanted: false }]);

    api.granted = [dev.port];
    api.dispatchEvent(new Event("connect"));
    await wait(30);
    expect(el.getState()).toMatchObject({ connected: true, reconnecting: false });
  });

  it("se pilote par DataProvider et oublie le port", async () => {
    const dev = fakePort();
    fakeSerial([], async () => dev.port);
    set("pc", { connect: 0, line: 0 });
    const el = await mount('<sonic-serial id="p" profile="ch340" control="pc"></sonic-serial>');
    await wait(10);
    set("pc", { connect: 1, line: 0 });
    await wait(30);
    expect(el.getState().connected).toBe(true);
    set("pc", { connect: 1, line: { n: 1, text: "?" } });
    await wait(30);
    expect(dev.written.map(text)).toEqual(["?\n"]);
    expect(await el.run("forget")).toBe(true);
    expect(dev.state.forgotten).toBe(1);
  });

  it("ferme le port quand le composant est retiré", async () => {
    const dev = fakePort();
    fakeSerial([], async () => dev.port);
    const el = await mount('<sonic-serial id="p" profile="ch340"></sonic-serial>');
    await el.run("connect");
    el.remove();
    await wait(20);
    expect(dev.state.closed).toBe(1);
  });
});
