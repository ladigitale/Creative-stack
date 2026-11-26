import { customElement, property } from "lit/decorators.js";
import { DeviceElement, policyAllows, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { indexOfBytes, payloadBytes, startsWith, toHex, utf8OrUndefined } from "../../shared/pipe/bytes";
import type { PipeWriteOptions, SonicBytePipe } from "../../shared/pipe/pipe";
import { getProfile, type BluetoothFilter, type BluetoothProfile } from "../../shared/bluetooth/profiles";
import { chunks, OpQueue, sleep } from "../../shared/pipe/queue";
import { expandUuid, isBlockedService, parseChannel } from "../../shared/bluetooth/uuid";
import { dispatch } from "../interactive";
import { BleMidiDecoder, encodeBleMidi, splitMidi, trackNotes, type BleMidiEvent, type HeldMidiNote } from "./midi/ble-midi";

const tagName = "sonic-bluetooth";

/** Limite de l'API Web Bluetooth pour une écriture. */
const MAX_WRITE = 512;
const MAX_FILTERS = 16;
const MAX_SERVICES = 16;
const MAX_NAME = 64;

/** État MIDI (profil `midi`) : dernier message reçu (hors horloge), notes tenues, compteurs. */
export type BleMidiState = { last: BleMidiEvent | null; notes: HeldMidiNote[]; n: number; sent: number };

export type BluetoothValue = { hex: string; bytes: number[]; text?: string; n: number; at: number };

export type BluetoothState = DeviceBaseState & {
  /** Un adaptateur Bluetooth est présent et allumé (`unknown` si le navigateur ne le dit pas). */
  available: boolean | "unknown";
  connected: boolean;
  device: { id: string; name: string } | null;
  profile: string | null;
  services: { uuid: string; characteristics: { uuid: string; props: string[] }[] }[];
  /** Alias de canaux réellement ouverts. */
  channels: string[];
  /** Dernière valeur reçue ou lue, par alias. `text` seulement si c'est de l'UTF-8 valide. */
  values: Record<string, BluetoothValue>;
  /** Compteur de notifications reçues (utilisable comme `trigger`). */
  rx: number;
  tx: { queued: number; sent: number; n: number };
  reconnecting: boolean;
  /** Profil `midi` seulement (sinon `null`). */
  midi: BleMidiState | null;
};

// ─── Sous-ensemble de Web Bluetooth utilisé ici (absent des types DOM standard) ────────────────────────────────
type GattCharacteristic = EventTarget & {
  uuid: string;
  value?: DataView | null;
  properties: Record<string, boolean>;
  readValue(): Promise<DataView>;
  writeValueWithResponse?(data: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(data: Uint8Array): Promise<void>;
  writeValue?(data: Uint8Array): Promise<void>;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
};
type GattService = { uuid: string; getCharacteristic(uuid: string): Promise<GattCharacteristic>; getCharacteristics?(): Promise<GattCharacteristic[]> };
type GattServer = { connected: boolean; connect(): Promise<GattServer>; disconnect(): void; getPrimaryService(uuid: string): Promise<GattService> };
type BleDevice = EventTarget & { id: string; name?: string | null; gatt?: GattServer | null; forget?(): Promise<void> };
type RequestOptions = { filters?: BluetoothFilter[]; acceptAllDevices?: boolean; optionalServices?: string[] };
type WebBluetooth = { requestDevice(options: RequestOptions): Promise<BleDevice>; getAvailability?(): Promise<boolean> };

const PROPS = ["read", "write", "writeWithoutResponse", "notify", "indicate"];

function initial(): BluetoothState {
  return {
    status: "idle", error: null, supported: false, allowed: "unknown", active: false,
    available: "unknown", connected: false, device: null, profile: null, services: [], channels: [], values: {}, rx: 0,
    tx: { queued: 0, sent: 0, n: 0 }, reconnecting: false, midi: null,
  };
}

function cleanFilters(value: unknown): BluetoothFilter[] | null {
  if (!Array.isArray(value) || value.length > MAX_FILTERS) return null;
  const out: BluetoothFilter[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    const filter: BluetoothFilter = {};
    if (typeof f.name === "string" && f.name && f.name.length <= MAX_NAME) filter.name = f.name;
    if (typeof f.namePrefix === "string" && f.namePrefix && f.namePrefix.length <= MAX_NAME) filter.namePrefix = f.namePrefix;
    if (Array.isArray(f.services)) {
      const uuids = f.services.map((s) => expandUuid(String(s)));
      if (uuids.some((u) => !u) || uuids.length > MAX_SERVICES) return null;
      if (uuids.length) filter.services = uuids as string[];
    }
    if (!Object.keys(filter).length) return null;
    out.push(filter);
  }
  return out;
}

/**
 * Bluetooth Low Energy (Web Bluetooth) : un appareil choisi par l'utilisateur, ses caractéristiques GATT
 * lues, écrites et écoutées par DataProvider. Sert aussi de canal d'octets (`SonicBytePipe`) aux pilotes
 * (`sonic-label-printer transport="#id"`).
 *
 * - `profile` : profil nommé (`luck`, `uart-nus`, `heart-rate`…) qui porte filtres, canaux et découpage.
 * - `filters`, `services`, `channels`, `notify` : pour un appareil sans profil.
 * - `for="bouton"` : le clic ouvre le sélecteur du navigateur (geste obligatoire).
 * - `control` (DP) : `{ connect: n, disconnect: n, toggle: n, write: {n, channel, hex | bytes | text},
 *   read: {n, channel}, subscribe: {n, channel}, unsubscribe: {n, channel}, forget: n, midiSend: {n, bytes | hex} }`.
 * - État `<id>State` : `{ status, error, supported, allowed, active, available, connected, device,
 *   services, channels, values, rx, tx, reconnecting, midi }`.
 * - Profil `midi` : paquets BLE-MIDI décodés dans `midi {last, notes, n, sent}` et envoyés en action
 *   `midi:message` au store `target`.
 *
 * Chromium seulement, en HTTPS ; ni iOS, ni Firefox, ni Safari. Dans une iframe : `allow="bluetooth"`.
 * Jamais de mise à jour de micrologiciel : les services DFU, HID et FIDO sont refusés.
 */
/** Profils réunis sur un même sélecteur, au plus. */
const MAX_PROFILES = 4;

type PlanVariant = {
  name: string | null;
  profile: BluetoothProfile | null;
  channels: Record<string, { service: string; characteristic: string }>;
  notify: string[];
};

@customElement(tagName)
export class SonicBluetooth extends DeviceElement<BluetoothState> implements SonicBytePipe {
  @property({ type: String }) profile = "";
  /** JSON `[{ "namePrefix": "…" }, { "services": ["heart_rate"] }]`, ajouté aux filtres du profil. */
  @property({ type: String }) filters = "";
  /** Services à ouvrir en plus, séparés par des espaces. */
  @property({ type: String }) services = "";
  /** JSON `{ "tx": "18f0/2af1", "rx": "18f0/2af0" }`. */
  @property({ type: String }) channels = "";
  /** Alias écoutés dès la connexion (défaut : ceux du profil, sinon `rx`). */
  @property({ type: String }) notify = "";
  @property({ type: Number, attribute: "chunk-size" }) chunkSizeAttr = 0;
  @property({ type: Number, attribute: "gap-ms" }) gapMsAttr = -1;
  @property({ type: Boolean, attribute: "auto-reconnect" }) autoReconnect = false;
  /** Sélecteur sans filtre de nom (déconseillé) ; `services` ou `channels` restent obligatoires. */
  @property({ type: Boolean, attribute: "accept-all" }) acceptAll = false;
  /** Store (id) qui reçoit chaque message MIDI décodé (profil `midi`) en action `midi:message`. */
  @property({ type: String }) target = "";

  protected feature = "bluetooth";
  protected readonly defaultCommand = "connect";
  protected state: BluetoothState = initial();

  private device: BleDevice | null = null;
  private chars = new Map<string, GattCharacteristic>();
  private listening = new Map<string, () => void>();
  private queue = new OpQueue();
  private listeners = new Set<(data: Uint8Array, channel: string) => void>();
  private wanted = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private forbidden: number[][] = [];
  private activeProfile = "";
  private chunk = 20;
  private gap = 0;
  private midiDecoder: BleMidiDecoder | null = null;

  protected commands(): CommandMap {
    return {
      connect: () => this.connect(),
      disconnect: () => this.disconnect(),
      toggle: () => (this.state.connected || this.state.status === "requesting" ? this.disconnect() : this.connect()),
      write: (a) => this.commandWrite(a),
      read: (a) => this.commandRead(a),
      subscribe: (a) => this.subscribe(String(a.channel ?? "")),
      unsubscribe: (a) => this.unsubscribe(String(a.channel ?? "")),
      forget: () => this.forget(),
      midiSend: (a) => this.midiSend(a),
    };
  }

  private api(): WebBluetooth | null {
    const b = typeof navigator !== "undefined" ? (navigator as Navigator & { bluetooth?: WebBluetooth }).bluetooth : undefined;
    return b && typeof b.requestDevice === "function" ? b : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    const api = this.api();
    this.patch({ supported: !!api, status: api ? "idle" : "unsupported", allowed: policyAllows(this.feature), profile: this.profile || null });
    void api?.getAvailability?.().then(
      (available) => this.isConnected && this.patch({ available }),
      () => undefined,
    );
  }

  disconnectedCallback(): void {
    this.wanted = false;
    this.closeDevice();
    this.listeners.clear();
    super.disconnectedCallback();
  }

  // ─── SonicBytePipe ────────────────────────────────────────────────────────────────────────────────────────────
  get pipeReady(): boolean {
    return this.state.connected && this.chars.has("tx");
  }

  get deviceName(): string {
    return this.state.device?.name ?? "";
  }

  /** Profil effectivement ouvert sur l'appareil connecté (utile quand `profile` en liste plusieurs). */
  get pipeProfile(): string {
    return this.state.connected ? this.activeProfile : "";
  }

  onBytes(cb: (data: Uint8Array, channel: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Écrit des octets sur un canal, par morceaux et en file. Ne lève jamais. */
  async writeBytes(data: Uint8Array, opts: PipeWriteOptions = {}): Promise<boolean> {
    const alias = opts.channel || "tx";
    const ch = this.chars.get(alias);
    if (!ch || !this.state.connected) return false;
    if (this.forbidden.some((seq) => startsWith(data, seq))) {
      this.patch({ error: "écriture refusée : commande interdite pour ce profil" });
      return false;
    }
    const size = Math.min(MAX_WRITE, Math.max(1, Math.floor(opts.chunkSize ?? this.chunk)));
    const gap = Math.max(0, opts.gapMs ?? this.gap);
    const parts = chunks(data, size);
    const token = this.queue.token();
    this.bumpTx({ queued: this.state.tx.queued + parts.length });
    const withResponse = opts.response === true || !ch.properties.writeWithoutResponse;
    const done = await this.queue.run(async () => {
      for (let i = 0; i < parts.length; i++) {
        if (!this.queue.alive(token) || !this.state.connected) throw new Error("déconnecté");
        if (withResponse && ch.writeValueWithResponse) await ch.writeValueWithResponse(parts[i]);
        else if (!withResponse && ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(parts[i]);
        else if (ch.writeValue) await ch.writeValue(parts[i]);
        else throw new Error("caractéristique non inscriptible");
        this.bumpTx({ queued: Math.max(0, this.state.tx.queued - 1), sent: this.state.tx.sent + parts[i].length });
        if (gap && i < parts.length - 1) await sleep(gap);
      }
      return true;
    });
    if (!done) {
      this.bumpTx({ queued: 0 });
      return false;
    }
    this.bumpTx({ n: this.state.tx.n + 1 }, true);
    return true;
  }

  private bumpTx(partial: Partial<BluetoothState["tx"]>, force = false): void {
    this.patch({ tx: { ...this.state.tx, ...partial } }, force);
  }

  // ─── Connexion ────────────────────────────────────────────────────────────────────────────────────────────────
  /** Filtres, services et canaux effectifs (profil puis attributs). `null` + message si la configuration est invalide. */
  private plan(): { options: RequestOptions; variants: PlanVariant[] } | string {
    // Plusieurs profils (« luck niimbot ») : filtres réunis ; à la connexion, le premier dont le service
    // d'écriture existe sur l'appareil est retenu.
    const names = this.profile.split(/[\s,]+/).filter(Boolean).slice(0, MAX_PROFILES);
    const profiles: { name: string | null; profile: BluetoothProfile | null }[] = [];
    for (const name of names) {
      const profile = getProfile(name);
      if (!profile) return `profil inconnu : ${name}`;
      profiles.push({ name, profile });
    }
    if (!profiles.length) profiles.push({ name: null, profile: null });

    const extraChannels: Record<string, string> = {};
    if (this.channels.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.channels);
      } catch {
        return "channels : JSON invalide";
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "channels : objet attendu";
      for (const [alias, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(alias) || typeof v !== "string") return `channels : alias ou valeur invalide (${alias})`;
        extraChannels[alias] = v;
      }
    }
    const variants: PlanVariant[] = [];
    let filters: BluetoothFilter[] = [];
    for (const { name, profile } of profiles) {
      const channels: Record<string, { service: string; characteristic: string }> = {};
      for (const [alias, v] of Object.entries({ ...(profile?.channels ?? {}), ...extraChannels })) {
        const parsed = parseChannel(v);
        if (!parsed) return `canal invalide : ${alias} (forme service/caractéristique)`;
        channels[alias] = parsed;
      }
      const notify = (this.notify.trim() ? this.notify.split(/\s+/) : profile?.notify ?? (channels.rx ? ["rx"] : [])).filter((a) => channels[a]);
      variants.push({ name, profile, channels, notify });
      for (const f of profile?.filters ?? []) {
        filters.push({ ...f, ...(f.services ? { services: f.services.map((s) => expandUuid(s) as string) } : {}) });
      }
    }
    if (this.filters.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.filters);
      } catch {
        return "filters : JSON invalide";
      }
      const extra = cleanFilters(parsed);
      if (!extra) return "filters : tableau de {name | namePrefix | services} attendu";
      filters = filters.concat(extra);
    }

    const services = new Set<string>(variants.flatMap((v) => Object.values(v.channels).map((c) => c.service)));
    for (const s of this.services.split(/\s+/).filter(Boolean)) {
      const uuid = expandUuid(s);
      if (!uuid) return `service invalide : ${s}`;
      services.add(uuid);
    }
    for (const f of filters) for (const s of f.services ?? []) services.add(s);
    if (services.size > MAX_SERVICES) return "trop de services";
    for (const s of services) if (isBlockedService(s)) return `service refusé : ${s}`;
    if (!services.size) return "aucun service : donner profile, channels ou services";

    const options: RequestOptions = { optionalServices: [...services] };
    if (this.acceptAll) options.acceptAllDevices = true;
    else if (filters.length) options.filters = filters;
    else return "aucun filtre : donner profile, filters, ou accept-all";

    return { options, variants };
  }

  /** Ouvre le sélecteur du navigateur puis connecte. À appeler dans un geste. */
  async connect(): Promise<boolean> {
    const api = this.api();
    if (!api) {
      this.patch({ status: "unsupported", supported: false, error: "Bluetooth non disponible dans ce navigateur (Chrome ou Edge, en HTTPS)" });
      return false;
    }
    if (this.state.connected) return true;
    if (this.state.status === "requesting") return false;
    const plan = this.plan();
    if (typeof plan === "string") {
      this.patch({ status: "error", error: plan });
      return false;
    }
    this.wanted = true;
    this.patch({ status: "requesting", error: null, profile: this.profile || null });
    let device: BleDevice;
    try {
      device = await api.requestDevice(plan.options);
    } catch (e) {
      // Sélecteur fermé sans choix : ce n'est pas une erreur.
      if ((e as { name?: string } | null)?.name === "NotFoundError") {
        this.patch({ status: "idle", error: null });
        return false;
      }
      this.fail(e, "Bluetooth");
      return false;
    }
    if (!this.isConnected) return false;
    this.closeDevice();
    this.device = device;
    device.addEventListener("gattserverdisconnected", this.onGattDisconnected);
    return this.open(plan);
  }

  private async open(plan: Exclude<ReturnType<SonicBluetooth["plan"]>, string>): Promise<boolean> {
    const device = this.device;
    if (!device?.gatt) {
      this.patch({ status: "error", error: "appareil sans serveur GATT" });
      return false;
    }
    try {
      const server = await device.gatt.connect();
      this.chars.clear();
      const services: BluetoothState["services"] = [];
      const cache = new Map<string, GattService>();
      for (const uuid of plan.options.optionalServices ?? []) {
        try {
          const service = await server.getPrimaryService(uuid);
          cache.set(uuid, service);
          const list = (await service.getCharacteristics?.().catch(() => [])) ?? [];
          services.push({ uuid, characteristics: list.map((c) => ({ uuid: c.uuid, props: PROPS.filter((p) => c.properties?.[p]) })) });
        } catch {
          // Service déclaré mais absent de cet appareil : ignoré.
        }
      }
      // Profil retenu : le premier dont le service d'écriture (à défaut, un service quelconque) est présent.
      const present = (v: PlanVariant, alias?: string): boolean =>
        Object.entries(v.channels).some(([a, c]) => (!alias || a === alias) && cache.has(c.service));
      const variant = plan.variants.find((v) => present(v, "tx")) ?? plan.variants.find((v) => present(v)) ?? plan.variants[0];
      this.activeProfile = variant.name ?? "";
      for (const [alias, target] of Object.entries(variant.channels)) {
        const service = cache.get(target.service);
        if (!service) continue;
        try {
          this.chars.set(alias, await service.getCharacteristic(target.characteristic));
        } catch {
          // Caractéristique absente : l'alias n'est pas ouvert.
        }
      }
      if (this.device !== device || !this.isConnected) return false;
      this.forbidden = variant.profile?.forbidden ?? [];
      this.chunk = this.chunkSizeAttr > 0 ? this.chunkSizeAttr : variant.profile?.chunkSize ?? 20;
      this.gap = this.gapMsAttr >= 0 ? this.gapMsAttr : variant.profile?.gapMs ?? 0;
      this.retryDelay = 1000;
      this.midiDecoder = variant.name === "midi" ? new BleMidiDecoder() : null;
      this.patch({
        midi: this.midiDecoder ? { last: this.state.midi?.last ?? null, notes: [], n: this.state.midi?.n ?? 0, sent: this.state.midi?.sent ?? 0 } : null,
        status: "ready", error: this.chars.size || !Object.keys(variant.channels).length ? null : "aucun canal trouvé sur cet appareil",
        active: true, connected: true, reconnecting: false, profile: variant.name,
        device: { id: device.id, name: (device.name ?? "").slice(0, MAX_NAME) }, services, channels: [...this.chars.keys()], values: {},
      });
      for (const alias of variant.notify) await this.subscribe(alias);
      this.emit("sonic-bluetooth-connect", { device: this.state.device });
      return true;
    } catch (e) {
      if (this.device === device) this.fail(e, "connexion Bluetooth");
      return false;
    }
  }

  async disconnect(): Promise<boolean> {
    this.wanted = false;
    const was = this.state.connected;
    this.closeDevice();
    this.patch({ ...this.offline(), status: this.state.supported ? "idle" : "unsupported", error: null });
    if (was) this.emit("sonic-bluetooth-disconnect", { wanted: true });
    return true;
  }

  /** Oublie l'appareil : la prochaine connexion repassera par le sélecteur. */
  async forget(): Promise<boolean> {
    const device = this.device;
    await this.disconnect();
    try {
      await device?.forget?.();
    } catch {
      // API absente ou refusée : la déconnexion suffit.
    }
    return true;
  }

  private offline(): Partial<BluetoothState> {
    this.midiDecoder?.reset();
    return {
      ...(this.state.midi ? { midi: { ...this.state.midi, notes: [] } } : {}), active: false, connected: false, reconnecting: false, channels: [], services: [], device: null, tx: { ...this.state.tx, queued: 0 } };
  }

  private closeDevice(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.queue.clear();
    for (const off of this.listening.values()) off();
    this.listening.clear();
    this.chars.clear();
    this.midiDecoder = null;
    const device = this.device;
    this.device = null;
    if (!device) return;
    device.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
    try {
      if (device.gatt?.connected) device.gatt.disconnect();
    } catch {
      // déjà déconnecté
    }
  }

  private onGattDisconnected = (): void => {
    const device = this.device;
    if (!device) return;
    this.queue.clear();
    for (const off of this.listening.values()) off();
    this.listening.clear();
    this.chars.clear();
    const again = this.wanted && this.autoReconnect && this.isConnected;
    this.patch({ ...this.offline(), device: again ? this.state.device : null, status: "idle", reconnecting: again, error: again ? null : "appareil déconnecté" });
    this.emit("sonic-bluetooth-disconnect", { wanted: false });
    if (!again) {
      device.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
      this.device = null;
      return;
    }
    // Même appareil : la reconnexion ne demande ni sélecteur ni geste.
    const retry = (): void => {
      this.retryTimer = setTimeout(async () => {
        this.retryTimer = null;
        if (this.device !== device || !this.wanted || !this.isConnected) return;
        const plan = this.plan();
        if (typeof plan !== "string" && (await this.open(plan))) return;
        if (this.device !== device || !this.wanted) return;
        this.retryDelay = Math.min(30000, this.retryDelay * 2);
        this.patch({ status: "idle", reconnecting: true, error: null });
        retry();
      }, this.retryDelay);
    };
    retry();
  };

  // ─── Lecture, écoute, écriture par commande ───────────────────────────────────────────────────────────────────
  async subscribe(alias: string): Promise<boolean> {
    const ch = this.chars.get(alias);
    if (!ch) return false;
    if (this.listening.has(alias)) return true;
    const handler = (e: Event): void => {
      const view = (e.target as GattCharacteristic).value;
      if (!view) return;
      const data = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
      this.store(alias, data, true);
      if (this.midiDecoder && alias === "rx") this.onMidi(data);
      for (const cb of this.listeners) {
        try {
          cb(data, alias);
        } catch {
          // Un pilote en erreur ne coupe pas les autres.
        }
      }
      this.emit("sonic-bluetooth-data", { channel: alias, bytes: Array.from(data) });
    };
    const ok = await this.queue.run(async () => {
      await ch.startNotifications();
      return true;
    });
    if (!ok) return false;
    ch.addEventListener("characteristicvaluechanged", handler);
    this.listening.set(alias, () => {
      ch.removeEventListener("characteristicvaluechanged", handler);
      void ch.stopNotifications().catch(() => undefined);
    });
    return true;
  }

  async unsubscribe(alias: string): Promise<boolean> {
    const off = this.listening.get(alias);
    if (!off) return false;
    off();
    this.listening.delete(alias);
    return true;
  }

  private store(alias: string, data: Uint8Array, notification: boolean): void {
    const previous = this.state.values[alias];
    const value: BluetoothValue = { hex: toHex(data), bytes: Array.from(data), n: (previous?.n ?? 0) + 1, at: Date.now() };
    const text = utf8OrUndefined(data);
    if (text !== undefined) value.text = text;
    // Valeurs continues : publication plafonnée par `rate`.
    this.patch({ values: { ...this.state.values, [alias]: value }, rx: this.state.rx + (notification ? 1 : 0) }, false);
  }

  // ─── MIDI (profil `midi`) ─────────────────────────────────────────────────────────────────────────────────────
  private onMidi(packet: Uint8Array): void {
    const events = this.midiDecoder?.events(packet) ?? [];
    if (!events.length || !this.state.midi) return;
    let { notes, n } = this.state.midi;
    const store = this.target.trim().replace(/^#/, "");
    for (const e of events) {
      notes = trackNotes(notes, e);
      n++;
      if (store) dispatch(store, { type: "midi:message", payload: e });
    }
    this.patch({ midi: { ...this.state.midi, last: events[events.length - 1], notes, n } }, false);
  }

  /** `midiSend {n, bytes | hex}` : messages MIDI complets (statut compris), SysEx refusé. */
  private async midiSend(arg: CommandArg): Promise<boolean> {
    if (!this.midiDecoder || !this.state.midi) {
      this.patch({ error: "midiSend : appareil MIDI non connecté (profile=\"midi\")" });
      return false;
    }
    const data = payloadBytes({ hex: arg.hex, bytes: arg.bytes }, 256);
    const messages = data ? splitMidi(data) : null;
    if (!messages) {
      this.patch({ error: "midiSend : messages MIDI complets attendus dans bytes ou hex (SysEx refusé, 256 octets au plus)" });
      return false;
    }
    const size = Math.min(MAX_WRITE, Math.max(5, this.chunk));
    // Un paquet par écriture : un paquet BLE-MIDI ne doit jamais être coupé.
    for (const packet of encodeBleMidi(messages, typeof performance !== "undefined" ? performance.now() : Date.now(), size)) {
      if (!(await this.writeBytes(packet, { chunkSize: packet.length }))) return false;
    }
    this.patch({ error: null, midi: { ...this.state.midi, sent: this.state.midi.sent + messages.length } });
    return true;
  }

  private async commandRead(arg: CommandArg): Promise<boolean> {
    const alias = String(arg.channel ?? "rx");
    const ch = this.chars.get(alias);
    if (!ch) return false;
    const view = await this.queue.run(() => ch.readValue());
    if (!view) return false;
    this.store(alias, new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)), false);
    return true;
  }

  private async commandWrite(arg: CommandArg): Promise<boolean> {
    const data = payloadBytes(arg, MAX_WRITE);
    if (!data) {
      this.patch({ error: `write : hex, bytes ou text attendu (${MAX_WRITE} octets au plus)` });
      return false;
    }
    // Écriture libre venue du document : la commande interdite est cherchée partout, pas seulement en tête.
    if (this.forbidden.some((seq) => indexOfBytes(data, seq) >= 0)) {
      this.patch({ error: "écriture refusée : commande interdite pour ce profil" });
      return false;
    }
    const ok = await this.writeBytes(data, { channel: typeof arg.channel === "string" ? arg.channel : "tx", response: arg.response === true });
    if (ok && this.state.error) this.patch({ error: null });
    return ok;
  }
}

export default SonicBluetooth;
