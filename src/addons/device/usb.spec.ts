import { afterEach, describe, expect, it } from "vitest";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";
import { cleanSetup } from "./usb";
import type { SonicUsb } from "./usb";

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const domError = (name: string) => Object.assign(new Error(name), { name });

class FakeUsbDevice {
  opened = false;
  productName = "Carte";
  manufacturerName = "Atelier";
  serialNumber = "A1";
  vendorId = 0x2341;
  productId = 0x8036;
  deviceClass = 0xff;
  configuration: { configurationValue: number } | null = null;
  claimed: number[] = [];
  protectedInterfaces = new Set<number>();
  log: unknown[] = [];
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async selectConfiguration(n: number) {
    this.configuration = { configurationValue: n };
  }
  async claimInterface(n: number) {
    if (this.protectedInterfaces.has(n)) throw domError("SecurityError");
    this.claimed.push(n);
  }
  async releaseInterface(n: number) {
    this.claimed = this.claimed.filter((c) => c !== n);
  }
  async transferIn(endpoint: number, length: number) {
    this.log.push(["in", endpoint, length]);
    return { data: new DataView(Uint8Array.from({ length }, (_, i) => i & 0xff).buffer), status: "ok" };
  }
  async transferOut(endpoint: number, data: Uint8Array) {
    this.log.push(["out", endpoint, [...data]]);
    return { bytesWritten: data.length, status: "ok" };
  }
  async controlTransferIn(setup: unknown, length: number) {
    this.log.push(["cin", setup, length]);
    return { data: new DataView(new Uint8Array([1, 2]).buffer), status: "stall" };
  }
  async controlTransferOut(setup: unknown, data?: Uint8Array) {
    this.log.push(["cout", setup, data ? [...data] : null]);
    return { bytesWritten: data?.length ?? 0, status: "ok" };
  }
}

class FakeUsb extends EventTarget {
  granted: FakeUsbDevice[] = [];
  requested: unknown[] = [];
  pick = new FakeUsbDevice();
  async requestDevice(options: unknown) {
    this.requested.push(options);
    return this.pick;
  }
  async getDevices() {
    return this.granted;
  }
}

let usb: FakeUsb;
function install(): FakeUsb {
  usb = new FakeUsb();
  Object.defineProperty(navigator, "usb", { configurable: true, value: usb });
  return usb;
}

async function mount(attrs: string): Promise<SonicUsb> {
  document.body.insertAdjacentHTML("beforeend", `<sonic-usb ${attrs}></sonic-usb>`);
  const el = document.querySelector("sonic-usb") as SonicUsb;
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (navigator as unknown as Record<string, unknown>).usb;
});

describe("sonic-usb", () => {
  it("sans WebUSB : unsupported", async () => {
    const el = await mount('id="usb0"');
    expect(get("usb0State")).toMatchObject({ status: "unsupported" });
    expect(await el.run("connect")).toBe(false);
  });

  it("connect : sélecteur filtré, configuration et interface réservées, état device", async () => {
    install();
    const el = await mount('id="usb1" filters=\'[{"vendorId":"2341","classCode":255}]\' configuration="1" interface="2"');
    expect(await el.run("connect")).toBe(true);
    expect(usb.requested[0]).toEqual({ filters: [{ vendorId: 0x2341, classCode: 255 }] });
    expect(usb.pick.claimed).toEqual([2]);
    expect(el.getState()).toMatchObject({
      status: "ready", active: true, claimed: { configuration: 1, interface: 2 },
      device: { productName: "Carte", manufacturerName: "Atelier", vendorId: "2341", productId: "8036", serialNumber: "A1" },
    });
    await el.run("close");
    expect(usb.pick.claimed).toEqual([]);
    expect(usb.pick.opened).toBe(false);
  });

  it("interface protégée : message clair, appareil refermé", async () => {
    install();
    usb.pick.protectedInterfaces.add(0);
    const el = await mount('id="usb2"');
    expect(await el.run("connect")).toBe(false);
    expect(el.getState().error).toMatch(/protégée par le navigateur/);
    await wait();
    expect(usb.pick.opened).toBe(false);
  });

  it("sélecteur fermé : idle sans erreur", async () => {
    install();
    usb.requestDevice = async () => {
      throw domError("NotFoundError");
    };
    const el = await mount('id="usb3"');
    expect(await el.run("connect")).toBe(false);
    expect(el.getState()).toMatchObject({ status: "idle", error: null });
  });

  it("transferts : in (action usb:in, recopie bornée), out, contrôle ; bornes 64 Ko", async () => {
    install();
    const got: SonicActionMessage[] = [];
    registerStore({ id: "usbStore", dispatch: (a) => void got.push(a), getState: () => ({}), reset: () => {} });
    const el = await mount('id="usb4" target="usbStore"');
    expect(await el.run("transferIn", { endpoint: 1, length: 8 })).toBe(false);
    await el.run("connect");
    expect(await el.run("transferIn", { endpoint: 1, length: 8 })).toBe(true);
    expect(el.getState().last).toMatchObject({ endpoint: 1, bytes: [0, 1, 2, 3, 4, 5, 6, 7], length: 8, truncated: false, status: "ok" });
    expect(got[0]).toMatchObject({ type: "usb:in", payload: { endpoint: 1, length: 8 } });
    expect(await el.run("transferIn", { endpoint: 1, length: 10000 })).toBe(true);
    expect(el.getState().last).toMatchObject({ length: 10000, truncated: true });
    expect(el.getState().last!.bytes.length).toBe(4096);
    expect(await el.run("transferIn", { endpoint: 1, length: 65537 })).toBe(false);
    expect(await el.run("transferIn", { endpoint: 16, length: 8 })).toBe(false);
    expect(await el.run("transferOut", { endpoint: 2, text: "G0" })).toBe(true);
    expect(el.getState().lastOut).toMatchObject({ endpoint: 2, bytesWritten: 2, status: "ok" });
    expect(await el.run("transferOut", { endpoint: 2, bytes: new Array(65537).fill(0) })).toBe(false);
    const setup = { requestType: "vendor", recipient: "device", request: 1, value: 2, index: 0 };
    expect(await el.run("controlTransferOut", { setup })).toBe(true);
    expect(await el.run("controlTransferIn", { setup, length: 2 })).toBe(false);
    expect(el.getState().error).toMatch(/stall/);
    expect(await el.run("controlTransferIn", { setup: { ...setup, requestType: "autre" }, length: 2 })).toBe(false);
    expect(usb.pick.log.map((l) => (l as unknown[])[0])).toEqual(["in", "in", "out", "cout", "cin"]);
    unregisterStore("usbStore");
  });

  it("débranchement : état remis à zéro", async () => {
    install();
    const el = await mount('id="usb5"');
    await el.run("connect");
    usb.dispatchEvent(Object.assign(new Event("disconnect"), { device: usb.pick }));
    expect(el.getState()).toMatchObject({ active: false, device: null, error: "appareil USB débranché" });
  });

  it("cleanSetup : bornes", () => {
    expect(cleanSetup({ requestType: "class", recipient: "interface", request: 0x22, value: 1, index: 0 })).toMatchObject({ request: 0x22 });
    expect(cleanSetup({ requestType: "class", recipient: "interface", request: 256 })).toMatch(/request/);
    expect(cleanSetup({ requestType: "class", recipient: "interface", request: 1, value: 70000 })).toMatch(/value/);
    expect(cleanSetup(null)).toMatch(/setup/);
  });
});
