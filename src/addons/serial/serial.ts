import { customElement, property } from "lit/decorators.js";
import { DeviceElement, policyAllows, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { payloadBytes, toHex } from "../../shared/pipe/bytes";
import { LineSplitter } from "../../shared/pipe/lines";
import type { PipeWriteOptions, SonicBytePipe } from "../../shared/pipe/pipe";
import { chunks, OpQueue, sleep } from "../../shared/pipe/queue";
import { cleanSerialFilters, getSerialProfile, hex4, matchesFilters, type SerialFilter } from "./profiles";

const tagName = "sonic-serial";

/** Octets au plus pour une écriture commandée par le document (`write`, `line`). */
const MAX_COMMAND_WRITE = 4096;
const MAX_LINE = 1024;
const LAST_HEX_BYTES = 64;
const PARITIES = ["none", "even", "odd"] as const;
const FLOWS = ["none", "hardware"] as const;

export type SerialState = DeviceBaseState & {
  connected: boolean;
  /** Identifiants USB du pont série, en hexadécimal (`1a86`, `7523`) ; vides pour un port non USB. */
  port: { vendorId: string; productId: string; name: string } | null;
  profile: string | null;
  baud: number;
  /** Octets et lignes reçus ; `lines` est utilisable comme `trigger`. */
  rx: { bytes: number; lines: number };
  /** Dernière ligne de texte reçue (protocoles en lignes : GRBL, consoles). */
  lastLine: string | null;
  /** Derniers octets reçus (64 au plus). */
  last: { hex: string; at: number } | null;
  tx: { queued: number; sent: number; n: number };
  reconnecting: boolean;
};

// ─── Sous-ensemble de Web Serial utilisé ici (absent des types DOM standard) ───────────────────────────────────
type PortInfo = { usbVendorId?: number; usbProductId?: number };
type OpenOptions = { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; flowControl?: string; bufferSize?: number };
type SerialPortLike = EventTarget & {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: OpenOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): PortInfo;
  forget?(): Promise<void>;
  setSignals?(signals: Record<string, boolean>): Promise<void>;
};
type WebSerial = EventTarget & { requestPort(options?: { filters?: SerialFilter[] }): Promise<SerialPortLike>; getPorts(): Promise<SerialPortLike[]> };

function initial(): SerialState {
  return {
    status: "idle", error: null, supported: false, allowed: "unknown", active: false,
    connected: false, port: null, profile: null, baud: 0, rx: { bytes: 0, lines: 0 }, lastLine: null, last: null,
    tx: { queued: 0, sent: 0, n: 0 }, reconnecting: false,
  };
}

type Plan = { filters: SerialFilter[]; options: OpenOptions; label: string };

/**
 * Port série (Web Serial) : un appareil branché en USB derrière un pont série (CH340, CP210x, FTDI, USB natif
 * d'un microcontrôleur), lu et écrit par DataProvider. Sert de canal d'octets (`SonicBytePipe`) aux pilotes
 * (`sonic-grbl transport="#id"`).
 *
 * - `profile` : `ch340`, `cp210x`, `ftdi`, `arduino`, `esp32`, `grbl` (filtres du sélecteur, débit).
 * - `baud`, `data-bits`, `stop-bits`, `parity`, `flow-control` : réglages de la liaison.
 * - `for="bouton"` : le clic ouvre le sélecteur du navigateur (geste obligatoire). Un port déjà autorisé
 *   pour ce site est rouvert sans sélecteur.
 * - `control` (DP) : `{ connect: n | {n, pick}, disconnect: n, toggle: n, write: {n, hex | bytes | text},
 *   line: {n, text}, signals: {n, dtr, rts}, forget: n }`.
 * - État `<id>State` : `{ status, error, supported, allowed, active, connected, port, profile, baud, rx,
 *   lastLine, last, tx, reconnecting }`.
 *
 * Chromium seulement (ordinateur, et Android récent), en HTTPS. Dans une iframe : `allow="serial"`.
 */
@customElement(tagName)
export class SonicSerial extends DeviceElement<SerialState> implements SonicBytePipe {
  @property({ type: String }) profile = "";
  /** JSON `[{ "usbVendorId": "1a86", "usbProductId": "7523" }]`, ajouté aux filtres du profil. */
  @property({ type: String }) filters = "";
  /** Débit en bauds (défaut : celui du profil, sinon 115200). */
  @property({ type: Number }) baud = 0;
  @property({ type: Number, attribute: "data-bits" }) dataBits = 8;
  @property({ type: Number, attribute: "stop-bits" }) stopBits = 1;
  @property({ type: String }) parity = "none";
  @property({ type: String, attribute: "flow-control" }) flowControl = "none";
  /** Fin de ligne ajoutée par la commande `line` : `lf` (défaut), `crlf` ou `cr`. */
  @property({ type: String }) eol = "lf";
  /** Réouverture du même port quand il est rebranché, sans sélecteur. */
  @property({ type: Boolean, attribute: "auto-reconnect" }) autoReconnect = false;
  /** Sélecteur sans filtre : tous les ports de la machine. */
  @property({ type: Boolean, attribute: "accept-all" }) acceptAll = false;

  protected feature = "serial";
  protected readonly defaultCommand = "connect";
  protected state: SerialState = initial();

  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private queue = new OpQueue();
  private listeners = new Set<(data: Uint8Array, channel: string) => void>();
  private splitter = new LineSplitter(MAX_LINE);
  private session = 0;
  private wanted = false;
  private lastInfo: PortInfo | null = null;
  private activeProfile = "";

  protected commands(): CommandMap {
    return {
      connect: (a) => this.connect(a.pick === true),
      disconnect: () => this.disconnect(),
      toggle: () => (this.state.connected || this.state.status === "requesting" ? this.disconnect() : this.connect()),
      write: (a) => this.commandWrite(a, false),
      line: (a) => this.commandWrite(a, true),
      signals: (a) => this.setSignals(a),
      forget: () => this.forget(),
    };
  }

  private api(): WebSerial | null {
    const s = typeof navigator !== "undefined" ? (navigator as Navigator & { serial?: WebSerial }).serial : undefined;
    return s && typeof s.requestPort === "function" ? s : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    const api = this.api();
    this.patch({ supported: !!api, status: api ? "idle" : "unsupported", allowed: policyAllows(this.feature), profile: this.profile || null });
    api?.addEventListener("connect", this.onPlugged);
    api?.addEventListener("disconnect", this.onUnplugged);
  }

  disconnectedCallback(): void {
    this.wanted = false;
    const api = this.api();
    api?.removeEventListener("connect", this.onPlugged);
    api?.removeEventListener("disconnect", this.onUnplugged);
    void this.closePort();
    this.listeners.clear();
    super.disconnectedCallback();
  }

  // ─── SonicBytePipe ────────────────────────────────────────────────────────────────────────────────────────────
  get pipeReady(): boolean {
    return this.state.connected && !!this.writer;
  }

  get deviceName(): string {
    return this.state.port?.name ?? "";
  }

  get pipeProfile(): string {
    return this.state.connected ? this.activeProfile : "";
  }

  onBytes(cb: (data: Uint8Array, channel: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Écrit des octets, en file (par morceaux si `chunkSize` est donné). Ne lève jamais. */
  async writeBytes(data: Uint8Array, opts: PipeWriteOptions = {}): Promise<boolean> {
    const writer = this.writer;
    if (!writer || !this.state.connected) return false;
    const parts = opts.chunkSize && opts.chunkSize > 0 ? chunks(data, opts.chunkSize) : [data];
    const gap = Math.max(0, opts.gapMs ?? 0);
    const token = this.queue.token();
    this.bumpTx({ queued: this.state.tx.queued + parts.length });
    const done = await this.queue.run(async () => {
      for (let i = 0; i < parts.length; i++) {
        if (!this.queue.alive(token) || this.writer !== writer) throw new Error("déconnecté");
        await writer.write(parts[i]);
        this.bumpTx({ queued: Math.max(0, this.state.tx.queued - 1), sent: this.state.tx.sent + parts[i].length });
        if (gap && i < parts.length - 1) await sleep(gap);
      }
      return true;
    });
    if (!done) {
      this.bumpTx({ queued: 0 });
      return false;
    }
    this.bumpTx({ n: this.state.tx.n + 1 });
    return true;
  }

  private bumpTx(partial: Partial<SerialState["tx"]>): void {
    this.patch({ tx: { ...this.state.tx, ...partial } }, false);
  }

  // ─── Connexion ────────────────────────────────────────────────────────────────────────────────────────────────
  /** Filtres et réglages effectifs (profil puis attributs) ; un message si la configuration est invalide. */
  private plan(): Plan | string {
    const profile = this.profile ? getSerialProfile(this.profile) : null;
    if (this.profile && !profile) return `profil inconnu : ${this.profile}`;
    let filters = [...(profile?.filters ?? [])];
    if (this.filters.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.filters);
      } catch {
        return "filters : JSON invalide";
      }
      const extra = cleanSerialFilters(parsed);
      if (!extra) return "filters : tableau de {usbVendorId, usbProductId} attendu (hexadécimal en chaîne ou nombre)";
      filters = filters.concat(extra);
    }
    if (!filters.length && !this.acceptAll) return "aucun filtre : donner profile, filters, ou accept-all";
    const baud = Math.round(this.baud > 0 ? this.baud : profile?.baud ?? 115200);
    if (!(baud >= 300 && baud <= 4_000_000)) return `baud invalide : ${this.baud}`;
    if (this.dataBits !== 7 && this.dataBits !== 8) return "data-bits : 7 ou 8";
    if (this.stopBits !== 1 && this.stopBits !== 2) return "stop-bits : 1 ou 2";
    if (!PARITIES.includes(this.parity as (typeof PARITIES)[number])) return "parity : none, even ou odd";
    if (!FLOWS.includes(this.flowControl as (typeof FLOWS)[number])) return "flow-control : none ou hardware";
    return {
      filters: this.acceptAll ? [] : filters,
      options: { baudRate: baud, dataBits: this.dataBits, stopBits: this.stopBits, parity: this.parity, flowControl: this.flowControl, bufferSize: 4096 },
      label: profile?.label ?? "Série",
    };
  }

  /**
   * Ouvre le port. Un seul port déjà autorisé qui correspond aux filtres est rouvert sans sélecteur ; sinon
   * (ou avec `pick`) le sélecteur du navigateur s'ouvre : à appeler dans un geste.
   */
  async connect(pick = false): Promise<boolean> {
    const api = this.api();
    if (!api) {
      this.patch({ status: "unsupported", supported: false, error: "port série non disponible dans ce navigateur (Chrome ou Edge, en HTTPS)" });
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
    let port: SerialPortLike | null = null;
    try {
      if (!pick) {
        const granted = (await api.getPorts()).filter((p) => matchesFilters(p.getInfo(), plan.filters));
        if (granted.length === 1) port = granted[0];
      }
      port ??= await api.requestPort(plan.filters.length ? { filters: plan.filters } : {});
    } catch (e) {
      // Sélecteur fermé sans choix : ce n'est pas une erreur.
      if ((e as { name?: string } | null)?.name === "NotFoundError") {
        this.patch({ status: "idle", error: null });
        return false;
      }
      this.fail(e, "port série");
      return false;
    }
    if (!this.isConnected) return false;
    return this.open(port, plan);
  }

  private async open(port: SerialPortLike, plan: Plan): Promise<boolean> {
    await this.closePort();
    const session = ++this.session;
    try {
      await port.open(plan.options);
    } catch (e) {
      const name = (e as { name?: string } | null)?.name ?? "";
      if (name === "InvalidStateError") this.patch({ status: "error", active: false, error: "port déjà ouvert dans cette page" });
      else if (name === "NetworkError") {
        this.patch({ status: "error", active: false, error: "ouverture du port impossible : déjà utilisé par un autre logiciel, ou accès refusé par le système (sous Linux : groupe dialout)" });
      } else this.fail(e, "port série");
      return false;
    }
    if (session !== this.session || !this.isConnected) {
      void port.close().catch(() => undefined);
      return false;
    }
    this.port = port;
    this.writer = port.writable?.getWriter() ?? null;
    this.splitter.reset();
    const info = port.getInfo();
    this.lastInfo = info;
    this.activeProfile = this.profile;
    const ids = info.usbVendorId !== undefined ? ` ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}` : "";
    this.patch({
      status: "ready", error: null, active: true, connected: true, reconnecting: false, baud: plan.options.baudRate,
      port: { vendorId: hex4(info.usbVendorId), productId: hex4(info.usbProductId), name: `${plan.label}${ids}` },
      rx: { bytes: 0, lines: 0 }, lastLine: null, last: null,
    });
    void this.readLoop(port, session);
    this.emit("sonic-serial-connect", { port: this.state.port });
    return true;
  }

  private async readLoop(port: SerialPortLike, session: number): Promise<void> {
    let failures = 0;
    while (port.readable && session === this.session && failures < 5) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) {
            failures = 0;
            this.onData(value);
          }
        }
        break;
      } catch {
        // Erreur de trame ou de débordement : le navigateur fournit un nouveau flux, on reprend.
        // Appareil débranché : `readable` devient nul et la boucle s'arrête.
        failures++;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // verrou déjà rendu
        }
        if (this.reader === reader) this.reader = null;
      }
    }
    if (session === this.session) void this.lost();
  }

  private onData(data: Uint8Array): void {
    const lines = this.splitter.push(data);
    const tail = data.subarray(Math.max(0, data.length - LAST_HEX_BYTES));
    this.patch(
      {
        rx: { bytes: this.state.rx.bytes + data.length, lines: this.state.rx.lines + lines.length },
        last: { hex: toHex(tail), at: Date.now() },
        ...(lines.length ? { lastLine: lines[lines.length - 1] } : {}),
      },
      false,
    );
    for (const cb of this.listeners) {
      try {
        cb(data, "rx");
      } catch {
        // Un pilote en erreur ne coupe pas les autres.
      }
    }
    for (const text of lines) this.emit("sonic-serial-line", { text });
  }

  /** Port perdu sans l'avoir demandé (câble débranché, appareil éteint). */
  private async lost(): Promise<void> {
    if (!this.state.connected) return;
    await this.closePort();
    const again = this.wanted && this.autoReconnect && this.isConnected;
    this.patch({ ...this.offline(), status: "idle", reconnecting: again, error: again ? null : "port série déconnecté" });
    this.emit("sonic-serial-disconnect", { wanted: false });
  }

  private onUnplugged = (e: Event): void => {
    if (this.port && e.target === this.port) void this.lost();
  };

  /** Un port autorisé vient d'être branché : réouverture si c'est celui qu'on a perdu. */
  private onPlugged = (): void => {
    if (!this.wanted || !this.autoReconnect || this.state.connected || !this.lastInfo || !this.isConnected) return;
    const wanted = this.lastInfo;
    void this.api()
      ?.getPorts()
      .then((ports) => {
        const port = ports.find((p) => {
          const info = p.getInfo();
          return info.usbVendorId === wanted.usbVendorId && info.usbProductId === wanted.usbProductId;
        });
        const plan = this.plan();
        if (port && typeof plan !== "string" && !this.state.connected && this.wanted) void this.open(port, plan);
      })
      .catch(() => undefined);
  };

  async disconnect(): Promise<boolean> {
    this.wanted = false;
    const was = this.state.connected;
    await this.closePort();
    this.patch({ ...this.offline(), status: this.state.supported ? "idle" : "unsupported", error: null });
    if (was) this.emit("sonic-serial-disconnect", { wanted: true });
    return true;
  }

  /** Ferme le port et retire l'autorisation : la prochaine connexion repassera par le sélecteur. */
  async forget(): Promise<boolean> {
    const port = this.port;
    await this.disconnect();
    try {
      await port?.forget?.();
    } catch {
      // API absente : la fermeture suffit.
    }
    this.lastInfo = null;
    return true;
  }

  private offline(): Partial<SerialState> {
    return { active: false, connected: false, reconnecting: false, port: null, tx: { ...this.state.tx, queued: 0 } };
  }

  private async closePort(): Promise<void> {
    this.session++;
    this.queue.clear();
    const port = this.port;
    const reader = this.reader;
    const writer = this.writer;
    this.port = null;
    this.reader = null;
    this.writer = null;
    if (!port) return;
    try {
      await reader?.cancel();
    } catch {
      // flux déjà fermé
    }
    try {
      writer?.releaseLock();
    } catch {
      // verrou déjà rendu
    }
    try {
      await port.close();
    } catch {
      // port déjà fermé ou débranché
    }
  }

  // ─── Écriture par commande ────────────────────────────────────────────────────────────────────────────────────
  private async commandWrite(arg: CommandArg, line: boolean): Promise<boolean> {
    let data = payloadBytes(arg, MAX_COMMAND_WRITE);
    if (!data) {
      this.patch({ error: `${line ? "line" : "write"} : hex, bytes ou text attendu (${MAX_COMMAND_WRITE} octets au plus)` });
      return false;
    }
    if (line) {
      const eol = this.eol === "crlf" ? [13, 10] : this.eol === "cr" ? [13] : [10];
      const joined = new Uint8Array(data.length + eol.length);
      joined.set(data);
      joined.set(eol, data.length);
      data = joined;
    }
    const ok = await this.writeBytes(data);
    if (ok && this.state.error) this.patch({ error: null });
    return ok;
  }

  /** Lignes de contrôle : `{dtr, rts}` (un front sur DTR redémarre la plupart des cartes Arduino et ESP32). */
  private async setSignals(arg: CommandArg): Promise<boolean> {
    const port = this.port;
    if (!port?.setSignals || !this.state.connected) return false;
    const signals: Record<string, boolean> = {};
    if (typeof arg.dtr === "boolean") signals.dataTerminalReady = arg.dtr;
    if (typeof arg.rts === "boolean") signals.requestToSend = arg.rts;
    if (!Object.keys(signals).length) return false;
    try {
      await port.setSignals(signals);
      return true;
    } catch {
      return false;
    }
  }
}

export default SonicSerial;
