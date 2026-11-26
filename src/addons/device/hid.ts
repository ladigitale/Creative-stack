import { customElement, property } from "lit/decorators.js";
import { dispatch } from "../interactive";
import { DeviceElement, policyAllows, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { payloadBytes } from "../../shared/pipe/bytes";

const tagName = "sonic-hid";

/** Octets au plus d'un rapport envoyé ; octets gardés d'un rapport reçu ; rapports gardés au plus. */
const MAX_REPORT_OUT = 4096;
const MAX_REPORT_IN = 1024;
const MAX_KEEP = 64;
const MAX_FILTERS = 16;

// ─── Filtres de sélecteur (partagés avec sonic-usb) ────────────────────────────────────────────────────────────
const id16 = (v: unknown): number | null => {
  const n = typeof v === "string" ? (/^(0x)?[0-9a-f]{1,4}$/i.test(v.trim()) ? parseInt(v.trim().replace(/^0x/i, ""), 16) : NaN) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 0xffff ? n : null;
};
const id8 = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,3}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 0xff ? n : null;
};

/** `1a86` (4 chiffres hexadécimaux) ; vide si absent. */
export const hex4 = (n: number | undefined | null): string => (typeof n === "number" ? n.toString(16).padStart(4, "0") : "");

/**
 * JSON de filtres → tableau propre ; un message d'erreur si invalide. Identifiants 16 bits en nombre ou en
 * hexadécimal (`"1a86"`, `"0x1a86"`), 8 bits en nombre décimal. Seules les clés de `keys` sont acceptées.
 * Chaîne vide → `[]` (sélecteur sans filtre : tous les appareils).
 */
export function parseDeviceFilters(text: string, keys: Record<string, 8 | 16>): Record<string, number>[] | string {
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "filters : JSON invalide";
  }
  const names = Object.keys(keys).join(", ");
  if (!Array.isArray(parsed)) return `filters : tableau de {${names}} attendu`;
  if (parsed.length > MAX_FILTERS) return `filters : ${MAX_FILTERS} filtres au plus`;
  const out: Record<string, number>[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `filters : tableau de {${names}} attendu`;
    const f: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const bits = keys[k];
      if (!bits || !Object.prototype.hasOwnProperty.call(keys, k)) return `filters : clé inconnue ${k} (attendu : ${names})`;
      const n = bits === 16 ? id16(v) : id8(v);
      if (n === null) return `filters : ${k} invalide (${bits === 16 ? "0 à ffff, hexadécimal en chaîne ou nombre" : "0 à 255"})`;
      f[k] = n;
    }
    if (!Object.keys(f).length) return "filters : filtre vide (omettre filters pour tout lister)";
    out.push(f);
  }
  return out;
}

export function matchesDeviceFilters(info: Record<string, unknown>, filters: Record<string, number>[]): boolean {
  if (!filters.length) return true;
  return filters.some((f) => Object.entries(f).every(([k, v]) => info[k] === v));
}

/** Entier borné d'un argument de commande, `null` s'il manque ou sort des bornes. */
export function intArg(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

const HID_FILTER_KEYS = { vendorId: 16, productId: 16, usagePage: 16, usage: 16 } as const;

// ─── État ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type HidReport = { reportId: number; bytes: number[]; at: number; buttons?: boolean[] };

export type HidState = DeviceBaseState & {
  device: { productName: string; vendorId: string; productId: string; collections: { usagePage: number; usage: number }[] } | null;
  /** Dernier rapport d'entrée (décodé selon `profile`). */
  last: HidReport | null;
  /** Les `keep` derniers rapports, du plus ancien au plus récent. */
  reports: HidReport[];
  /** Dernier rapport de fonctionnalité lu (`receiveFeatureReport`). */
  feature: { reportId: number; bytes: number[]; at: number } | null;
  /** Rapports reçus depuis l'ouverture. */
  count: number;
};

// ─── Sous-ensemble de WebHID utilisé ici ──────────────────────────────────────────────────────────────────────
type HidDeviceLike = EventTarget & {
  opened: boolean;
  productName?: string;
  vendorId: number;
  productId: number;
  collections?: { usagePage?: number; usage?: number }[];
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
};
type HidInputEvent = Event & { reportId?: number; data?: DataView; device?: HidDeviceLike };
type WebHid = EventTarget & { requestDevice(options: { filters: Record<string, number>[] }): Promise<HidDeviceLike[]>; getDevices(): Promise<HidDeviceLike[]> };

const PROFILES = ["", "gamepad-generic", "buttons"] as const;

function initial(): HidState {
  return { status: "idle", error: null, supported: false, allowed: "unknown", active: false, device: null, last: null, reports: [], feature: null, count: 0 };
}

const viewBytes = (v: DataView | undefined | null, max: number): number[] => (v ? Array.from(new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, max))) : []);

/** Décodage d'un rapport selon le profil : `buttons` = les 8 bits du premier octet (bit 0 d'abord). */
export function decodeHidReport(profile: string, bytes: number[]): Pick<HidReport, "buttons"> {
  if (profile === "buttons") {
    const b = bytes[0] ?? 0;
    return { buttons: Array.from({ length: 8 }, (_, i) => ((b >> i) & 1) === 1) };
  }
  return {};
}

/**
 * Appareil HID (WebHID) : boutons, pédales, claviers de macros, manettes non standard, capteurs USB ou Bluetooth.
 *
 * - `for="bouton"` : le clic ouvre le sélecteur du navigateur (`filters` JSON `[{vendorId, productId,
 *   usagePage, usage}]` ; sans filtre le sélecteur liste tous les appareils HID).
 * - `auto-reconnect` : rouvre au chargement un appareil déjà autorisé pour ce site, et au rebranchement.
 * - `control` (DP) : `{ connect: n | {n, pick}, close: n, sendReport: {n, reportId, bytes | hex},
 *   sendFeatureReport: {n, reportId, bytes | hex}, receiveFeatureReport: {n, reportId}, forget: n }`.
 * - `target` : store qui reçoit `hid:input` `{reportId, bytes, at, buttons?}` (au plus `rate` par seconde).
 * - État `<id>State` : `{ status, error, supported, allowed, active, device, last, reports, feature, count }`.
 *
 * Chromium sur ordinateur, en HTTPS. Claviers et souris sont masqués par le navigateur. Dans une iframe :
 * `allow="hid"`. Non testé sur matériel.
 */
@customElement(tagName)
export class SonicHid extends DeviceElement<HidState> {
  @property({ type: String }) filters = "";
  @property({ type: Boolean, attribute: "auto-reconnect" }) autoReconnect = false;
  /** Rapports gardés dans `reports` (16 ; 0 à 64). */
  @property({ type: Number }) keep = 16;
  /** Décodage : `gamepad-generic` (rien, octets bruts) ou `buttons` (bits du premier octet). */
  @property({ type: String }) profile = "";
  @property({ type: String }) target = "";

  protected feature = "hid";
  protected readonly defaultCommand = "connect";
  protected state: HidState = initial();

  private device: HidDeviceLike | null = null;
  private wanted = false;
  private lastAction = 0;
  private pendingAction: HidReport | null = null;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;

  protected commands(): CommandMap {
    return {
      connect: (a) => this.connect(a.pick === true),
      close: () => this.close(),
      sendReport: (a) => this.send(a, false),
      sendFeatureReport: (a) => this.send(a, true),
      receiveFeatureReport: (a) => this.receiveFeature(a),
      forget: () => this.forget(),
    };
  }

  private api(): WebHid | null {
    const h = typeof navigator !== "undefined" ? (navigator as Navigator & { hid?: WebHid }).hid : undefined;
    return h && typeof h.requestDevice === "function" ? h : null;
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
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = null;
    void this.release();
    super.disconnectedCallback();
  }

  private plan(): Record<string, number>[] | string {
    if (!PROFILES.includes(this.profile as (typeof PROFILES)[number])) return `profile inconnu : ${this.profile} (gamepad-generic ou buttons)`;
    return parseDeviceFilters(this.filters, HID_FILTER_KEYS);
  }

  private fits(d: HidDeviceLike, filters: Record<string, number>[]): boolean {
    if (!filters.length) return true;
    const cols = d.collections?.length ? d.collections : [{}];
    return cols.some((c) => matchesDeviceFilters({ vendorId: d.vendorId, productId: d.productId, usagePage: c.usagePage, usage: c.usage }, filters));
  }

  /** Un seul appareil déjà autorisé qui correspond : rouvert sans sélecteur. */
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

  /** Ouvre un appareil : déjà autorisé (un seul qui correspond), sinon par le sélecteur (dans un geste). */
  async connect(pick = false): Promise<boolean> {
    const api = this.api();
    if (!api) {
      this.patch({ status: "unsupported", supported: false, error: "WebHID non disponible dans ce navigateur (Chrome ou Edge sur ordinateur, en HTTPS)" });
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
    let device: HidDeviceLike | undefined;
    try {
      if (!pick) {
        const granted = (await api.getDevices()).filter((d) => this.fits(d, filters));
        if (granted.length === 1) device = granted[0];
      }
      // Sélecteur fermé sans choix : tableau vide, ce n'est pas une erreur.
      device ??= (await api.requestDevice({ filters }))[0];
    } catch (e) {
      this.fail(e, "HID");
      return false;
    }
    if (!device) {
      this.patch({ status: "idle", error: null });
      return false;
    }
    if (!this.isConnected) return false;
    return this.open(device);
  }

  private async open(device: HidDeviceLike): Promise<boolean> {
    try {
      if (!device.opened) await device.open();
    } catch (e) {
      const name = (e as { name?: string } | null)?.name ?? "";
      if (name === "InvalidStateError" || name === "NotAllowedError") {
        this.patch({ status: "error", active: false, error: "ouverture de l'appareil HID impossible : déjà utilisé, ou protégé par le système" });
      } else this.fail(e, "HID");
      return false;
    }
    if (!this.isConnected) {
      void device.close().catch(() => undefined);
      return false;
    }
    this.device = device;
    device.addEventListener("inputreport", this.onInput);
    const collections = (device.collections ?? []).slice(0, 16).map((c) => ({ usagePage: c.usagePage ?? 0, usage: c.usage ?? 0 }));
    this.patch({
      status: "ready", error: null, active: true, count: 0, last: null, reports: [],
      device: { productName: String(device.productName ?? "").slice(0, 128), vendorId: hex4(device.vendorId), productId: hex4(device.productId), collections },
    });
    this.emit("sonic-hid-connect", { device: this.state.device });
    return true;
  }

  private async release(): Promise<void> {
    const d = this.device;
    this.device = null;
    d?.removeEventListener("inputreport", this.onInput);
    try {
      if (d?.opened) await d.close();
    } catch {
      // déjà fermé
    }
  }

  async close(): Promise<boolean> {
    this.wanted = false;
    const was = !!this.device;
    await this.release();
    this.patch({ active: false, device: null, status: this.state.supported ? "idle" : "unsupported", error: null });
    if (was) this.emit("sonic-hid-disconnect", { wanted: true });
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

  private async send(arg: CommandArg, feature: boolean): Promise<boolean> {
    const d = this.device;
    const what = feature ? "sendFeatureReport" : "sendReport";
    if (!d) {
      this.patch({ error: `${what} : aucun appareil HID ouvert` });
      return false;
    }
    const reportId = intArg(arg.reportId ?? 0, 0, 255);
    if (reportId === null) {
      this.patch({ error: `${what} : reportId de 0 à 255` });
      return false;
    }
    const data = payloadBytes(arg, MAX_REPORT_OUT);
    if (!data) {
      this.patch({ error: `${what} : bytes (0 à 255) ou hex attendu, ${MAX_REPORT_OUT} octets au plus` });
      return false;
    }
    try {
      await (feature ? d.sendFeatureReport(reportId, data) : d.sendReport(reportId, data));
    } catch (e) {
      this.patch({ error: `${what} : ${e instanceof Error && e.message ? e.message : "échec de l'envoi"}` });
      return false;
    }
    this.patch({ error: null });
    return true;
  }

  private async receiveFeature(arg: CommandArg): Promise<boolean> {
    const d = this.device;
    if (!d) {
      this.patch({ error: "receiveFeatureReport : aucun appareil HID ouvert" });
      return false;
    }
    const reportId = intArg(arg.reportId ?? 0, 0, 255);
    if (reportId === null) {
      this.patch({ error: "receiveFeatureReport : reportId de 0 à 255" });
      return false;
    }
    try {
      const view = await d.receiveFeatureReport(reportId);
      this.patch({ error: null, feature: { reportId, bytes: viewBytes(view, MAX_REPORT_IN), at: Date.now() } });
      return true;
    } catch (e) {
      this.patch({ error: `receiveFeatureReport : ${e instanceof Error && e.message ? e.message : "échec de la lecture"}` });
      return false;
    }
  }

  private onInput = (e: Event): void => {
    const ev = e as HidInputEvent;
    const bytes = viewBytes(ev.data, MAX_REPORT_IN);
    const report: HidReport = { reportId: ev.reportId ?? 0, bytes, at: Date.now(), ...decodeHidReport(this.profile, bytes) };
    const keep = Math.max(0, Math.min(MAX_KEEP, Math.floor(Number(this.keep) || 0)));
    const reports = keep ? [...this.state.reports, report].slice(-keep) : [];
    this.patch({ last: report, reports, count: this.state.count + 1 }, false);
    this.queueAction(report);
  };

  /** Action `hid:input` vers `target`, au plus `rate` par seconde ; le dernier rapport n'est jamais perdu. */
  private queueAction(report: HidReport): void {
    const target = this.target.trim();
    if (!target) return;
    const gap = 1000 / Math.max(1, Math.min(60, this.rate));
    const now = performance.now();
    this.pendingAction = report;
    if (this.actionTimer) return;
    const wait = gap - (now - this.lastAction);
    if (wait <= 0) this.flushAction();
    else this.actionTimer = setTimeout(() => this.flushAction(), wait);
  }

  private flushAction(): void {
    this.actionTimer = null;
    const r = this.pendingAction;
    this.pendingAction = null;
    const target = this.target.trim();
    if (!r || !target || !this.isConnected) return;
    this.lastAction = performance.now();
    dispatch(target, { type: "hid:input", payload: { ...r, bytes: [...r.bytes], ...(r.buttons ? { buttons: [...r.buttons] } : {}) } });
  }

  private onUnplugged = (e: Event): void => {
    const d = (e as HidInputEvent).device;
    if (!this.device || d !== this.device) return;
    void this.release().then(() => {
      this.patch({ active: false, device: null, status: "idle", error: this.wanted && this.autoReconnect ? null : "appareil HID débranché" });
      this.emit("sonic-hid-disconnect", { wanted: false });
    });
  };

  private onPlugged = (): void => {
    if (this.wanted && this.autoReconnect && !this.device && this.isConnected) void this.reopenGranted();
  };
}

export default SonicHid;
