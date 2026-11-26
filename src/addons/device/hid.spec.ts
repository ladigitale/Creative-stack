import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";
import { decodeHidReport, parseDeviceFilters } from "./hid";
import type { SonicHid } from "./hid";

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

class FakeHidDevice extends EventTarget {
  opened = false;
  productName = "Pédalier";
  vendorId = 0x1a86;
  productId = 0xe026;
  collections = [{ usagePage: 1, usage: 4 }];
  sent: [string, number, number[]][] = [];
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(id: number, data: Uint8Array) {
    this.sent.push(["out", id, [...data]]);
  }
  async sendFeatureReport(id: number, data: Uint8Array) {
    this.sent.push(["feature", id, [...data]]);
  }
  async receiveFeatureReport(_id: number) {
    return new DataView(Uint8Array.from([9, 8, 7]).buffer);
  }
  input(reportId: number, bytes: number[]) {
    this.dispatchEvent(Object.assign(new Event("inputreport"), { reportId, data: new DataView(Uint8Array.from(bytes).buffer), device: this }));
  }
}

class FakeHid extends EventTarget {
  granted: FakeHidDevice[] = [];
  requested: unknown[] = [];
  pick: FakeHidDevice | null = new FakeHidDevice();
  async requestDevice(options: unknown) {
    this.requested.push(options);
    return this.pick ? [this.pick] : [];
  }
  async getDevices() {
    return this.granted;
  }
}

let hid: FakeHid;
function install(): FakeHid {
  hid = new FakeHid();
  Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
  return hid;
}

async function mount(attrs: string): Promise<SonicHid> {
  document.body.insertAdjacentHTML("beforeend", `<sonic-hid ${attrs}></sonic-hid>`);
  const el = document.querySelector("sonic-hid") as SonicHid;
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (navigator as unknown as Record<string, unknown>).hid;
});

describe("sonic-hid", () => {
  it("sans WebHID : unsupported", async () => {
    const el = await mount('id="hid0"');
    expect(get("hid0State")).toMatchObject({ status: "unsupported", supported: false });
    expect(await el.run("connect")).toBe(false);
  });

  it("for : le clic ouvre le sélecteur avec les filtres ; sélecteur fermé = idle sans erreur", async () => {
    install();
    hid.pick = null;
    document.body.insertAdjacentHTML("beforeend", '<button id="hidBtn"></button>');
    const el = await mount('id="hid1" for="hidBtn" filters=\'[{"vendorId":"1a86","usagePage":12}]\'');
    document.getElementById("hidBtn")!.click();
    await wait();
    expect(hid.requested[0]).toEqual({ filters: [{ vendorId: 0x1a86, usagePage: 12 }] });
    expect(el.getState()).toMatchObject({ status: "idle", error: null });
  });

  it("filtres invalides refusés avec un message", async () => {
    install();
    const el = await mount('id="hid2" filters=\'[{"vendorId":"zz"}]\'');
    expect(await el.run("connect")).toBe(false);
    expect(el.getState().error).toMatch(/vendorId invalide/);
    expect(parseDeviceFilters("", { vendorId: 16 })).toEqual([]);
    expect(parseDeviceFilters('[{"autre":1}]', { vendorId: 16 })).toMatch(/clé inconnue/);
    expect(parseDeviceFilters("[{}]", { vendorId: 16 })).toMatch(/filtre vide/);
  });

  it("rapports d'entrée : last décodé (buttons), reports bornés par keep, action hid:input plafonnée", async () => {
    install();
    const got: SonicActionMessage[] = [];
    registerStore({ id: "hidStore", dispatch: (a) => void got.push(a), getState: () => ({}), reset: () => {} });
    const el = await mount('id="hid3" profile="buttons" keep="2" target="hidStore" rate="10"');
    expect(await el.run("connect")).toBe(true);
    expect(el.getState().device).toMatchObject({ productName: "Pédalier", vendorId: "1a86", productId: "e026", collections: [{ usagePage: 1, usage: 4 }] });
    const dev = hid.pick!;
    dev.input(1, [0b101, 0]);
    dev.input(1, [0b010, 0]);
    dev.input(1, [0b001, 0]);
    const st = el.getState();
    expect(st.count).toBe(3);
    expect(st.reports.length).toBe(2);
    expect(st.last).toMatchObject({ reportId: 1, bytes: [1, 0] });
    expect(st.last!.buttons!.slice(0, 3)).toEqual([true, false, false]);
    expect(got.length).toBe(1);
    await wait(150);
    expect(got.length).toBe(2);
    expect(got[1].payload).toMatchObject({ bytes: [1, 0] });
    unregisterStore("hidStore");
  });

  it("commandes : sendReport, sendFeatureReport, receiveFeatureReport, close ; bornes", async () => {
    install();
    const el = await mount('id="hid4" control="hid4C"');
    expect(await el.run("sendReport", { reportId: 1, bytes: [1] })).toBe(false);
    await el.run("connect");
    set("hid4C", { sendReport: 0 });
    await el.updateComplete;
    set("hid4C", { sendReport: { n: 1, reportId: 2, bytes: [1, 2] } });
    await wait();
    expect(await el.run("sendFeatureReport", { reportId: 3, hex: "ff00" })).toBe(true);
    expect(hid.pick!.sent).toEqual([["out", 2, [1, 2]], ["feature", 3, [255, 0]]]);
    expect(await el.run("sendReport", { reportId: 300, bytes: [1] })).toBe(false);
    expect(await el.run("sendReport", { reportId: 1, bytes: new Array(5000).fill(0) })).toBe(false);
    expect(await el.run("receiveFeatureReport", { reportId: 5 })).toBe(true);
    expect(el.getState().feature).toMatchObject({ reportId: 5, bytes: [9, 8, 7] });
    expect(await el.run("close")).toBe(true);
    expect(el.getState()).toMatchObject({ active: false, device: null, status: "idle" });
    expect(hid.pick!.opened).toBe(false);
  });

  it("auto-reconnect : rouvre l'appareil déjà autorisé sans sélecteur, puis après rebranchement", async () => {
    install();
    const dev = new FakeHidDevice();
    hid.granted = [dev];
    const el = await mount('id="hid5" auto-reconnect');
    await wait();
    expect(el.getState().active).toBe(true);
    expect(hid.requested.length).toBe(0);
    hid.dispatchEvent(Object.assign(new Event("disconnect"), { device: dev }));
    await wait();
    expect(el.getState()).toMatchObject({ active: false, error: null });
    hid.dispatchEvent(new Event("connect"));
    await wait();
    expect(el.getState().active).toBe(true);
  });

  it("decodeHidReport : gamepad-generic ne décode rien", () => {
    expect(decodeHidReport("gamepad-generic", [255])).toEqual({});
    expect(decodeHidReport("buttons", [128]).buttons![7]).toBe(true);
  });
});
