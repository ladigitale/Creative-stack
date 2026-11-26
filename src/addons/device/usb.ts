import { customElement, property } from "lit/decorators.js";
import { dispatch } from "../interactive";
import { DeviceElement, policyAllows, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { payloadBytes } from "../../shared/pipe/bytes";
import { hex4, intArg, matchesDeviceFilters, parseDeviceFilters } from "./hid";

const tagName = "sonic-usb";

/** Octets au plus d'un transfert (entrant ou sortant) ; octets reçus recopiés dans l'état et l'action. */
export const MAX_USB_TRANSFER = 65_536;
const MAX_PUBLISHED = 4096;

const USB_FILTER_KEYS = { vendorId: 16, productId: 16, classCode: 8, subclassCode: 8, protocolCode: 8 } as const;
const REQUEST_TYPES = ["standard", "class", "vendor"] as const;
const RECIPIENTS = ["device", "interface", "endpoint", "other"] as const;

export type UsbSetup = { requestType: (typeof REQUEST_TYPES)[number]; recipient: (typeof RECIPIENTS)[number]; request: number; value: number; index: number };

export type UsbIn = {
  /** Numéro d'endpoint, ou `"control"` pour `controlTransferIn`. */
  endpoint: number | "control";
  /** Octets reçus (les 4096 premiers ; `length` donne la taille réelle). */
  bytes: number[];
  length: number;
  truncated: boolean;
  /** `ok`, `stall` (endpoint bloqué) ou `babble` (l'appareil a envoyé plus que demandé). */
  status: string;
  at: number;
};

export type UsbState = DeviceBaseState & {
  device: { productName: string; manufacturerName: string; vendorId: string; productId: string; serialNumber: string } | null;
  /** Configuration et interface réservées. */
  claimed: { configuration: number; interface: number } | null;
  /** Dernière réception (`transferIn`, `controlTransferIn`). */
  last: UsbIn | null;
  /** Dernier envoi : octets écrits et statut. */
  lastOut: { endpoint: number | "control"; bytesWritten: number; status: string; at: number } | null;
  /** Transferts aboutis depuis l'ouverture. */
  transfers: number;
};

// ─── Sous-ensemble de WebUSB utilisé ici ──────────────────────────────────────────────────────────────────────
type InResult = { data?: DataView | null; status: string };
type OutResult = { bytesWritten: number; status: string };
type UsbDeviceLike = {
  opened: boolean;
  productName?: string | null;
  manufacturerName?: string | null;
  serialNumber?: string | null;
  vendorId: number;
  productId: number;
  deviceClass?: number;
  deviceSubclass?: number;
  deviceProtocol?: number;
  configuration?: { configurationValue: number } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferIn(endpoint: number, length: number): Promise<InResult>;
  transferOut(endpoint: number, data: Uint8Array): Promise<OutResult>;
  controlTransferIn(setup: UsbSetup, length: number): Promise<InResult>;
  controlTransferOut(setup: UsbSetup, data?: Uint8Array): Promise<OutResult>;
};
type UsbConnectionEvent = Event & { device?: UsbDeviceLike };
type WebUsb = EventTarget & { requestDevice(options: { filters: Record<string, number>[] }): Promise<UsbDeviceLike>; getDevices(): Promise<UsbDeviceLike[]> };

function initial(): UsbState {
  return { status: "idle", error: null, supported: false, allowed: "unknown", active: false, device: null, claimed: null, last: null, lastOut: null, transfers: 0 };
}

/** `setup` d'un transfert de contrôle → valeur vérifiée ; un message si invalide. */
export function cleanSetup(v: unknown): UsbSetup | string {
  if (!v || typeof v !== "object") return "setup {requestType, recipient, request, value, index} attendu";
  const s = v as Record<string, unknown>;
  if (!REQUEST_TYPES.includes(s.requestType as UsbSetup["requestType"])) return "setup.requestType : standard, class ou vendor";
  if (!RECIPIENTS.includes(s.recipient as UsbSetup["recipient"])) return "setup.recipient : device, interface, endpoint ou other";
  const request = intArg(s.request, 0, 255);
  const value = intArg(s.value ?? 0, 0, 0xffff);
  const index = intArg(s.index ?? 0, 0, 0xffff);
  if (request === null) return "setup.request : entier de 0 à 255";
  if (value === null || index === null) return "setup.value et setup.index : entiers de 0 à 65535";
  return { requestType: s.requestType as UsbSetup["requestType"], recipient: s.recipient as UsbSetup["recipient"], request, value, index };
}

const STATUS_FR: Record<string, string> = { stall: "endpoint bloqué (stall)", babble: "l'appareil a envoyé plus que demandé (babble)" };

/**
 * Appareil USB (WebUSB) : cartes de développement, instruments, appareils à protocole maison.
 *
 * - `for="bouton"` : le clic ouvre le sélecteur du navigateur (`filters` JSON `[{vendorId, productId,
 *   classCode}]` ; sans filtre il liste tous les appareils USB). Un appareil déjà autorisé est rouvert sans
 *   sélecteur ; `auto-reconnect` le rouvre au chargement et au rebranchement.
 * - Ouverture : `open()`, `selectConfiguration(configuration)` (1), `claimInterface(interface)` (0).
 * - `control` (DP) : `{ connect: n | {n, pick}, open: n, close: n, transferIn: {n, endpoint, length},
 *   transferOut: {n, endpoint, bytes | hex | text}, controlTransferIn: {n, setup, length},
 *   controlTransferOut: {n, setup, bytes | hex | text}, forget: n }` ; 64 Ko au plus par transfert.
 * - `target` : store qui reçoit `usb:in` (= `last`) à chaque réception.
 * - État `<id>State` : `{ status, error, supported, allowed, active, device, claimed, last, lastOut, transfers }`.
 *
 * Chromium (ordinateur, Android), en HTTPS. Les interfaces HID, stockage, audio et vidéo sont protégées par
 * le navigateur. Dans une iframe : `allow="usb"`. Non testé sur matériel.
 */
@customElement(tagName)
export class SonicUsb extends DeviceElement<UsbState> {
  @property({ type: String }) filters = "";
  @property({ type: Boolean, attribute: "auto-reconnect" }) autoReconnect = false;
  /** Configuration choisie à l'ouverture (1). */
  @property({ type: Number }) configuration = 1;
  /** Interface réservée à l'ouverture (0). */
  @property({ type: Number, attribute: "interface" }) interfaceNumber = 0;
  @property({ type: String }) target = "";

  protected feature = "usb";
  protected readonly defaultCommand = "connect";
  protected state: UsbState = initial();

  private device: UsbDeviceLike | null = null;
  private claimedInterface: number | null = null;
  private wanted = false;
  private tail: Promise<unknown> = Promise.resolve();

  protected commands(): CommandMap {
    return {
      connect: (a) => this.connect(a.pick === true),
      open: () => this.connect(false),
      close: () => this.close(),
      transferIn: (a) => this.transferIn(a),
      transferOut: (a) => this.transferOut(a),
      controlTransferIn: (a) => this.controlIn(a),
      controlTransferOut: (a) => this.controlOut(a),
      forget: () => this.forget(),
    };
  }

  private api(): WebUsb | null {
    const u = typeof navigator !== "undefined" ? (navigator as Navigator & { usb?: WebUsb }).usb : undefined;
    return u && typeof u.requestDevice === "function" ? u : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    const api = this.api();
    this.patch({ supported: !!api, status: api ? "idle" : "unsupported", allowed: policyAllows(this.feature) });
    api?.addEventListener("connect", this.onPlugged);
    api?.addEventListener("disconnect", this.onUnplugged);
    if (api && this.autoReconnect) {
      this.wanted = true;
      void this.reopenGranted();
    }
  }

  disconnectedCallback(): void {
    this.wanted = false;
    const api = this.api();
    api?.removeEventListener("connect", this.onPlugged);
    api?.removeEventListener("disconnect", this.onUnplugged);
    void this.release();
    super.disconnectedCallback();
  }

  private plan(): Record<string, number>[] | string {
    if (intArg(this.configuration, 1, 255) === null) return "configuration : entier de 1 à 255";
    if (intArg(this.interfaceNumber, 0, 255) === null) return "interface : entier de 0 à 255";
    return parseDeviceFilters(this.filters, USB_FILTER_KEYS);
  }

  private fits(d: UsbDeviceLike, filters: Record<string, number>[]): boolean {
    return matchesDeviceFilters({ vendorId: d.vendorId, productId: d.productId, classCode: d.deviceClass, subclassCode: d.deviceSubclass, protocolCode: d.deviceProtocol }, filters);
  }

  private async reopenGranted(): Promise<boolean> {
    const api = this.api();
    const filters = this.plan();
    if (!api || typeof filters === "string") return false;
    try {
      const granted = (await api.getDevices()).filter((d) => this.fits(d, filters));
      if (granted.length !== 1 || !this.wanted || this.device) return false;
      return this.open(granted[0]);
    } catch {
      return false;
    }
  }

  async connect(pick = false): Promise<boolean> {
    const api = this.api();
    if (!api) {
      this.patch({ status: "unsupported", supported: false, error: "WebUSB non disponible dans ce navigateur (Chrome ou Edge, en HTTPS)" });
      return false;
    }
    if (this.device) return true;
    if (this.state.status === "requesting") return false;
    const filters = this.plan();
    if (typeof filters === "string") {
      this.patch({ status: "error", error: filters });
      return false;
    }
    this.wanted = true;
    this.patch({ status: "requesting", error: null });
    let device: UsbDeviceLike | null = null;
    try {
      if (!pick) {
        const granted = (await api.getDevices()).filter((d) => this.fits(d, filters));
        if (granted.length === 1) device = granted[0];
      }
      device ??= await api.requestDevice({ filters });
    } catch (e) {
      if ((e as { name?: string } | null)?.name === "NotFoundError") {
        this.patch({ status: "idle", error: null });
        return false;
      }
      this.fail(e, "USB");
      return false;
    }
    if (!this.isConnected) return false;
    return this.open(device);
  }

  private async open(device: UsbDeviceLike): Promise<boolean> {
    const configuration = this.configuration;
    const iface = this.interfaceNumber;
    let step = "ouverture";
    try {
      if (!device.opened) await device.open();
      step = "configuration";
      if (device.configuration?.configurationValue !== configuration) await device.selectConfiguration(configuration);
      step = "interface";
      await device.claimInterface(iface);
    } catch (e) {
      const name = (e as { name?: string } | null)?.name ?? "";
      let error: string;
      if (step === "interface" && (name === "SecurityError" || name === "NetworkError" || name === "InvalidStateError")) {
        error = `interface ${iface} indisponible : protégée par le navigateur (HID, stockage, audio, vidéo), inexistante, ou déjà prise par un pilote du système`;
      } else if (step === "configuration") error = `configuration ${configuration} introuvable sur cet appareil`;
      else if (name === "SecurityError" || name === "NetworkError") error = "ouverture USB impossible : appareil déjà utilisé ou accès refusé par le système (sous Windows : pilote WinUSB ; sous Linux : règle udev)";
      else error = "";
      if (error) this.patch({ status: "error", active: false, error });
      else this.fail(e, "USB");
      void device.close().catch(() => undefined);
      return false;
    }
    if (!this.isConnected) {
      void device.close().catch(() => undefined);
      return false;
    }
    this.device = device;
    this.claimedInterface = iface;
    const s = (v: unknown) => String(v ?? "").slice(0, 128);
    this.patch({
      status: "ready", error: null, active: true, last: null, lastOut: null, transfers: 0,
      claimed: { configuration, interface: iface },
      device: { productName: s(device.productName), manufacturerName: s(device.manufacturerName), vendorId: hex4(device.vendorId), productId: hex4(device.productId), serialNumber: s(device.serialNumber) },
    });
    this.emit("sonic-usb-connect", { device: this.state.device });
    return true;
  }

  private async release(): Promise<void> {
    const d = this.device;
    const iface = this.claimedInterface;
    this.device = null;
    this.claimedInterface = null;
    if (!d) return;
    try {
      if (iface !== null) await d.releaseInterface(iface);
    } catch {
      // déjà rendue
    }
    try {
      if (d.opened) await d.close();
    } catch {
      // déjà fermé
    }
  }

  async close(): Promise<boolean> {
    this.wanted = false;
    const was = !!this.device;
    await this.release();
    this.patch({ active: false, device: null, claimed: null, status: this.state.supported ? "idle" : "unsupported", error: null });
    if (was) this.emit("sonic-usb-disconnect", { wanted: true });
    return true;
  }

  async forget(): Promise<boolean> {
    const d = this.device;
    await this.close();
    try {
      await d?.forget?.();
    } catch {
      // API absente : la fermeture suffit.
    }
    return true;
  }

  // ─── Transferts (un à la fois, dans l'ordre des commandes) ───────────────────────────────────────────────────
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.tail.then(op, op);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private refuse(error: string): false {
    this.patch({ error });
    return false;
  }

  private transferError(what: string, e: unknown): false {
    const name = (e as { name?: string } | null)?.name ?? "";
    const msg = name === "NetworkError" ? "appareil débranché ou transfert interrompu" : e instanceof Error && e.message ? e.message : "échec du transfert";
    return this.refuse(`${what} : ${msg}`);
  }

  private received(endpoint: number | "control", r: InResult): boolean {
    const view = r.data ?? null;
    const length = view?.byteLength ?? 0;
    const bytes = view ? Array.from(new Uint8Array(view.buffer, view.byteOffset, Math.min(length, MAX_PUBLISHED))) : [];
    const last: UsbIn = { endpoint, bytes, length, truncated: length > MAX_PUBLISHED, status: r.status, at: Date.now() };
    const ok = r.status === "ok";
    this.patch({ last, transfers: this.state.transfers + (ok ? 1 : 0), error: ok ? null : `réception : ${STATUS_FR[r.status] ?? r.status}` });
    const target = this.target.trim();
    if (target) dispatch(target, { type: "usb:in", payload: { ...last, bytes: [...bytes] } });
    return ok;
  }

  private sent(endpoint: number | "control", r: OutResult): boolean {
    const ok = r.status === "ok";
    this.patch({
      lastOut: { endpoint, bytesWritten: r.bytesWritten ?? 0, status: r.status, at: Date.now() },
      transfers: this.state.transfers + (ok ? 1 : 0),
      error: ok ? null : `envoi : ${STATUS_FR[r.status] ?? r.status}`,
    });
    return ok;
  }

  private ready(what: string): UsbDeviceLike | null {
    if (!this.device) this.refuse(`${what} : aucun appareil USB ouvert`);
    return this.device;
  }

  async transferIn(arg: CommandArg): Promise<boolean> {
    const d = this.ready("transferIn");
    if (!d) return false;
    const endpoint = intArg(arg.endpoint, 1, 15);
    const length = intArg(arg.length ?? 64, 1, MAX_USB_TRANSFER);
    if (endpoint === null) return this.refuse("transferIn : endpoint de 1 à 15");
    if (length === null) return this.refuse(`transferIn : length de 1 à ${MAX_USB_TRANSFER}`);
    return this.serial(async () => {
      try {
        return this.received(endpoint, await d.transferIn(endpoint, length));
      } catch (e) {
        return this.transferError("transferIn", e);
      }
    });
  }

  async transferOut(arg: CommandArg): Promise<boolean> {
    const d = this.ready("transferOut");
    if (!d) return false;
    const endpoint = intArg(arg.endpoint, 1, 15);
    if (endpoint === null) return this.refuse("transferOut : endpoint de 1 à 15");
    const data = payloadBytes(arg, MAX_USB_TRANSFER);
    if (!data) return this.refuse(`transferOut : bytes (0 à 255), hex ou text attendu, ${MAX_USB_TRANSFER} octets au plus`);
    return this.serial(async () => {
      try {
        return this.sent(endpoint, await d.transferOut(endpoint, data));
      } catch (e) {
        return this.transferError("transferOut", e);
      }
    });
  }

  async controlIn(arg: CommandArg): Promise<boolean> {
    const d = this.ready("controlTransferIn");
    if (!d) return false;
    const setup = cleanSetup(arg.setup);
    if (typeof setup === "string") return this.refuse(`controlTransferIn : ${setup}`);
    const length = intArg(arg.length ?? 64, 1, MAX_USB_TRANSFER);
    if (length === null) return this.refuse(`controlTransferIn : length de 1 à ${MAX_USB_TRANSFER}`);
    return this.serial(async () => {
      try {
        return this.received("control", await d.controlTransferIn(setup, length));
      } catch (e) {
        return this.transferError("controlTransferIn", e);
      }
    });
  }

  async controlOut(arg: CommandArg): Promise<boolean> {
    const d = this.ready("controlTransferOut");
    if (!d) return false;
    const setup = cleanSetup(arg.setup);
    if (typeof setup === "string") return this.refuse(`controlTransferOut : ${setup}`);
    const hasData = arg.bytes !== undefined || arg.hex !== undefined || arg.text !== undefined;
    const data = hasData ? payloadBytes(arg, MAX_USB_TRANSFER) : null;
    if (hasData && !data) return this.refuse(`controlTransferOut : bytes (0 à 255), hex ou text attendu, ${MAX_USB_TRANSFER} octets au plus`);
    return this.serial(async () => {
      try {
        return this.sent("control", await (data ? d.controlTransferOut(setup, data) : d.controlTransferOut(setup)));
      } catch (e) {
        return this.transferError("controlTransferOut", e);
      }
    });
  }

  private onUnplugged = (e: Event): void => {
    const d = (e as UsbConnectionEvent).device;
    if (!this.device || d !== this.device) return;
    this.device = null;
    this.claimedInterface = null;
    this.patch({ active: false, device: null, claimed: null, status: "idle", error: this.wanted && this.autoReconnect ? null : "appareil USB débranché" });
    this.emit("sonic-usb-disconnect", { wanted: false });
  };

  private onPlugged = (): void => {
    if (this.wanted && this.autoReconnect && !this.device && this.isConnected) void this.reopenGranted();
  };
}

export default SonicUsb;
