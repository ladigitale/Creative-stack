import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";
import { buildNfcMessage, decodeNfcRecord, safeNfcUrl } from "./nfc";
import type { SonicNfc } from "./nfc";

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const view = (s: string) => new DataView(new TextEncoder().encode(s).buffer);

/** Doublure de NDEFReader : `scan` résout, `write` attend un tag (`tap()`), `makeReadOnly` résout. */
class FakeReader extends EventTarget {
  static last: FakeReader | null = null;
  scans = 0;
  written: unknown[] = [];
  locked = 0;
  private pending: (() => void) | null = null;
  constructor() {
    super();
    FakeReader.last = this;
  }
  async scan(): Promise<void> {
    this.scans++;
  }
  write(message: unknown, opts: { signal?: AbortSignal }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending = () => {
        this.written.push(message);
        resolve();
      };
      opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })));
    });
  }
  tap(): void {
    this.pending?.();
    this.pending = null;
  }
  async makeReadOnly(): Promise<void> {
    this.locked++;
  }
}

async function mount(attrs: string): Promise<SonicNfc> {
  document.body.insertAdjacentHTML("beforeend", `<sonic-nfc ${attrs}></sonic-nfc>`);
  const el = document.querySelector("sonic-nfc") as SonicNfc;
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).NDEFReader;
  FakeReader.last = null;
});

describe("sonic-nfc", () => {
  it("sans Web NFC : unsupported, scan refusé avec un message", async () => {
    const el = await mount('id="nfc0"');
    expect(get("nfc0State")).toMatchObject({ status: "unsupported", supported: false });
    expect(await el.run("scan")).toBe(false);
    expect(el.getState().error).toMatch(/Android/);
  });

  it("lit un tag : records décodés, compteur, action nfc:read vers le store", async () => {
    (window as unknown as Record<string, unknown>).NDEFReader = FakeReader;
    const got: SonicActionMessage[] = [];
    registerStore({ id: "nfcStore", dispatch: (a) => void got.push(a), getState: () => ({}), reset: () => {} });
    const el = await mount('id="nfc1" target="nfcStore"');
    expect(await el.run("scan")).toBe(true);
    expect(el.getState()).toMatchObject({ status: "ready", scanning: true, active: true });
    const ev = Object.assign(new Event("reading"), {
      serialNumber: "04:a2:11",
      message: {
        records: [
          { recordType: "text", encoding: "utf-8", data: view("Bonjour") },
          { recordType: "url", data: view("https://exemple.fr/a") },
          { recordType: "url", data: view("javascript:alert(1)") },
          { recordType: "mime", mediaType: "application/json", data: view('{"x":1}') },
          { recordType: "mime", mediaType: "image/png", data: view("PNG") },
        ],
      },
    });
    FakeReader.last!.dispatchEvent(ev);
    const st = el.getState();
    expect(st.serial).toBe("04:a2:11");
    expect(st.count).toBe(1);
    expect(st.records[0]).toMatchObject({ recordType: "text", text: "Bonjour" });
    expect(st.records[1]).toMatchObject({ url: "https://exemple.fr/a" });
    expect(st.records[2].url).toBeUndefined();
    expect(st.records[3].json).toEqual({ x: 1 });
    expect(st.records[4]).toMatchObject({ mediaType: "image/png", size: 3 });
    expect(got[0]).toMatchObject({ type: "nfc:read", payload: { serial: "04:a2:11" } });
    expect(await el.run("stop")).toBe(true);
    expect(el.getState().scanning).toBe(false);
    unregisterStore("nfcStore");
  });

  it("write par control : attend un tag, lastWrite ; stop annule une écriture", async () => {
    (window as unknown as Record<string, unknown>).NDEFReader = FakeReader;
    const el = await mount('id="nfc2" control="nfc2C"');
    set("nfc2C", { write: { n: 0 } });
    await el.updateComplete;
    set("nfc2C", { write: { n: 1, url: "https://exemple.fr" } });
    await wait();
    expect(el.getState().writing).toBe(true);
    FakeReader.last!.tap();
    await wait();
    expect(el.getState()).toMatchObject({ writing: false, lastWrite: { records: 1 } });
    expect(FakeReader.last!.written[0]).toEqual({ records: [{ recordType: "url", data: "https://exemple.fr/" }] });
    const p = el.run("write", { text: "x" });
    await wait();
    await el.run("stop");
    expect(await p).toBe(false);
    expect(el.getState().writing).toBe(false);
  });

  it("makeReadOnly refusé sans allow-lock, accepté avec", async () => {
    (window as unknown as Record<string, unknown>).NDEFReader = FakeReader;
    let el = await mount('id="nfc3"');
    expect(await el.run("makeReadOnly")).toBe(false);
    expect(el.getState().error).toMatch(/allow-lock/);
    el.remove();
    el = await mount('id="nfc4" allow-lock');
    expect(await el.run("makeReadOnly")).toBe(true);
    expect(FakeReader.last!.locked).toBe(1);
  });

  it("buildNfcMessage : types acceptés, URL sûres, JSON seulement, bornes", () => {
    expect(buildNfcMessage({ text: "a" })).toEqual([{ recordType: "text", data: "a" }]);
    expect(buildNfcMessage({ url: "javascript:alert(1)" })).toMatch(/http/);
    expect(buildNfcMessage({ records: [{ recordType: "mime", mediaType: "text/html", data: "<b>" }] })).toMatch(/application\/json/);
    expect(buildNfcMessage({ records: [{ recordType: "smart-poster", data: "x" }] })).toMatch(/recordType/);
    const ok = buildNfcMessage({ records: [{ recordType: "mime", data: { a: 1 } }] });
    expect(Array.isArray(ok) && ok[0].mediaType).toBe("application/json");
    expect(buildNfcMessage({ text: "x".repeat(9000) })).toMatch(/trop long/);
    expect(buildNfcMessage({})).toMatch(/text, url ou records/);
    expect(safeNfcUrl("data:text/html,x")).toBeNull();
    expect(decodeNfcRecord({ recordType: "unknown", data: view("abc") })).toEqual({ recordType: "unknown", mediaType: null, size: 3 });
  });
});
