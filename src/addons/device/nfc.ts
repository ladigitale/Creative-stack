import { customElement, property } from "lit/decorators.js";
import { dispatch } from "../interactive";
import { DeviceElement, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-nfc";

/** Bornes : enregistrements lus ou écrits, taille d'un texte, d'un JSON, d'un message écrit. */
const MAX_RECORDS = 16;
const MAX_TEXT = 10_000;
const MAX_JSON_BYTES = 32_768;
const MAX_WRITE_BYTES = 8_192;

export type NfcRecord = {
  recordType: string;
  mediaType: string | null;
  text?: string;
  url?: string;
  json?: unknown;
  /** Taille des données d'un enregistrement non décodé (octets). */
  size?: number;
};

export type NfcState = DeviceBaseState & {
  /** Lecture en cours (le téléphone écoute les tags approchés). */
  scanning: boolean;
  /** Une écriture attend qu'un tag soit approché. */
  writing: boolean;
  /** Numéro de série du dernier tag lu (`04:a2:…`), `null` si le tag n'en donne pas. */
  serial: string | null;
  records: NfcRecord[];
  /** Tags lus depuis le chargement. */
  count: number;
  /** Dernière écriture réussie : nombre d'enregistrements et instant. */
  lastWrite: { records: number; at: number } | null;
};

// ─── Sous-ensemble de Web NFC utilisé ici (absent des types DOM standard) ───────────────────────────────────────
type NdefRecordLike = { recordType: string; mediaType?: string | null; encoding?: string | null; data?: DataView | null };
type NdefReadingEvent = Event & { serialNumber?: string; message?: { records?: NdefRecordLike[] } };
type NdefRecordInit = { recordType: string; mediaType?: string; data: string | Uint8Array };
type NdefReaderLike = EventTarget & {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(message: { records: NdefRecordInit[] }, options?: { overwrite?: boolean; signal?: AbortSignal }): Promise<void>;
  makeReadOnly?(options?: { signal?: AbortSignal }): Promise<void>;
};
type NdefReaderCtor = new () => NdefReaderLike;

function initial(): NfcState {
  return {
    status: "idle", error: null, supported: false, allowed: "unknown", active: false,
    scanning: false, writing: false, serial: null, records: [], count: 0, lastWrite: null,
  };
}

/** Seules les URL http(s) sont écrites ou publiées comme `url` (jamais `javascript:` ni `data:`). */
export function safeNfcUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const isJsonType = (mediaType: unknown): boolean => typeof mediaType === "string" && /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/i.test(mediaType.trim());

function decodeText(view: DataView | null | undefined, encoding = "utf-8"): string | undefined {
  if (!view) return undefined;
  try {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return new TextDecoder(encoding || "utf-8").decode(bytes);
  } catch {
    return undefined;
  }
}

/** Enregistrement NDEF lu → forme publiée (texte, URL http(s), JSON ; les autres types : taille seulement). */
export function decodeNfcRecord(r: NdefRecordLike): NfcRecord {
  const out: NfcRecord = { recordType: String(r.recordType ?? ""), mediaType: r.mediaType ?? null };
  const size = r.data?.byteLength ?? 0;
  if (out.recordType === "text") {
    const t = decodeText(r.data, r.encoding ?? "utf-8");
    if (t !== undefined) out.text = t.slice(0, MAX_TEXT);
  } else if (out.recordType === "url" || out.recordType === "absolute-url") {
    const url = safeNfcUrl(decodeText(r.data));
    if (url) out.url = url;
    else out.size = size;
  } else if (out.recordType === "mime" && isJsonType(r.mediaType) && size <= MAX_JSON_BYTES) {
    try {
      out.json = JSON.parse(decodeText(r.data) ?? "");
    } catch {
      out.size = size;
    }
  } else out.size = size;
  return out;
}

/**
 * Arguments de `write` → enregistrements NDEF ; un message d'erreur si la demande est invalide.
 * `{text}`, `{url}` (http ou https) ou `{records: [{recordType: "text"|"url"|"mime", data, mediaType?}]}` ;
 * `mime` accepte seulement `application/json` (data = valeur JSON).
 */
export function buildNfcMessage(arg: CommandArg): NdefRecordInit[] | string {
  let list: unknown[];
  if (typeof arg.text === "string") list = [{ recordType: "text", data: arg.text }];
  else if (arg.url !== undefined) list = [{ recordType: "url", data: arg.url }];
  else if (Array.isArray(arg.records)) list = arg.records;
  else return "write : donner text, url ou records";
  if (!list.length) return "write : aucun enregistrement";
  if (list.length > MAX_RECORDS) return `write : ${MAX_RECORDS} enregistrements au plus`;
  const out: NdefRecordInit[] = [];
  let total = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") return "write : enregistrement invalide";
    const r = raw as Record<string, unknown>;
    if (r.recordType === "text") {
      if (typeof r.data !== "string") return "write : un enregistrement text attend data en chaîne";
      out.push({ recordType: "text", data: r.data });
      total += new TextEncoder().encode(r.data).length;
    } else if (r.recordType === "url") {
      const url = safeNfcUrl(r.data);
      if (!url) return "write : url http ou https attendue";
      out.push({ recordType: "url", data: url });
      total += url.length;
    } else if (r.recordType === "mime") {
      const mediaType = typeof r.mediaType === "string" ? r.mediaType : "application/json";
      if (!isJsonType(mediaType)) return "write : seul le type mime application/json est accepté";
      let json: string | undefined;
      try {
        json = JSON.stringify(r.data);
      } catch {
        json = undefined;
      }
      if (json === undefined) return "write : data d'un enregistrement mime doit être une valeur JSON";
      const bytes = new TextEncoder().encode(json);
      out.push({ recordType: "mime", mediaType, data: bytes });
      total += bytes.length;
    } else return "write : recordType text, url ou mime seulement";
  }
  if (total > MAX_WRITE_BYTES) return `write : message trop long (${MAX_WRITE_BYTES} octets au plus ; un tag courant en contient bien moins)`;
  return out;
}

/**
 * Tags NFC (Web NFC) : lecture des tags approchés du téléphone, écriture de texte, d'URL ou de JSON.
 *
 * - `for="bouton"` : le clic lance la lecture (`scan`), geste obligatoire la première fois (permission).
 * - `control` (DP) : `{ scan: n, stop: n, write: {n, text} | {n, url} | {n, records}, makeReadOnly: n }`.
 *   `makeReadOnly` (irréversible) est refusé sans l'attribut `allow-lock`.
 * - `target` : store qui reçoit l'action `nfc:read` `{serial, records}` à chaque tag lu.
 * - État `<id>State` : `{ status, error, supported, allowed, active, scanning, writing, serial, records,
 *   count, lastWrite }`.
 *
 * Chrome sous Android seulement, en HTTPS, page visible. Pas de Permissions Policy : ne marche pas dans une
 * iframe d'une autre origine. Non testé sur matériel.
 */
@customElement(tagName)
export class SonicNfc extends DeviceElement<NfcState> {
  /** Store qui reçoit `nfc:read`. */
  @property({ type: String }) target = "";
  /** Autorise `makeReadOnly` (verrouillage définitif du tag). */
  @property({ type: Boolean, attribute: "allow-lock" }) allowLock = false;
  /** `write` remplace un message déjà présent sur le tag (vrai par défaut ; `no-overwrite` refuse un tag non vide). */
  @property({ type: Boolean, attribute: "no-overwrite" }) noOverwrite = false;

  protected feature = null;
  protected readonly defaultCommand = "scan";
  protected state: NfcState = initial();

  private reader: NdefReaderLike | null = null;
  private scanAbort: AbortController | null = null;
  private writeAbort: AbortController | null = null;

  protected commands(): CommandMap {
    return {
      scan: () => this.scan(),
      stop: () => this.stop(),
      write: (a) => this.write(a),
      makeReadOnly: () => this.makeReadOnly(),
    };
  }

  private ctor(): NdefReaderCtor | null {
    const c = typeof window !== "undefined" ? (window as unknown as { NDEFReader?: NdefReaderCtor }).NDEFReader : undefined;
    return typeof c === "function" ? c : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    const supported = !!this.ctor();
    this.patch({ supported, status: supported ? "idle" : "unsupported", allowed: "unknown" });
  }

  disconnectedCallback(): void {
    this.scanAbort?.abort();
    this.writeAbort?.abort();
    this.scanAbort = this.writeAbort = null;
    this.detach();
    super.disconnectedCallback();
  }

  private unsupported(): false {
    const secure = typeof window === "undefined" || window.isSecureContext !== false;
    this.patch({ status: "unsupported", supported: !!this.ctor(), error: secure ? "NFC non disponible : Chrome sous Android seulement" : "NFC : page en HTTPS requise" });
    return false;
  }

  private getReader(): NdefReaderLike | null {
    if (this.reader) return this.reader;
    const C = this.ctor();
    if (!C) return null;
    const reader = new C();
    reader.addEventListener("reading", this.onReading);
    reader.addEventListener("readingerror", this.onReadingError);
    this.reader = reader;
    return reader;
  }

  private detach(): void {
    this.reader?.removeEventListener("reading", this.onReading);
    this.reader?.removeEventListener("readingerror", this.onReadingError);
    this.reader = null;
  }

  private nfcFail(e: unknown, what: string): void {
    const name = (e as { name?: string } | null)?.name ?? "";
    if (name === "NotReadableError") this.patch({ status: "error", error: `${what} : NFC désactivé dans les réglages du téléphone`, scanning: false, writing: false, active: false });
    else {
      this.fail(e, what);
      this.patch({ scanning: false, writing: false });
    }
  }

  async scan(): Promise<boolean> {
    if (this.state.scanning) return true;
    const reader = this.getReader();
    if (!reader) return this.unsupported();
    const ctrl = new AbortController();
    this.scanAbort = ctrl;
    this.patch({ status: "requesting", error: null });
    try {
      await reader.scan({ signal: ctrl.signal });
    } catch (e) {
      if (this.scanAbort === ctrl) this.scanAbort = null;
      if ((e as { name?: string } | null)?.name === "AbortError") return false;
      this.nfcFail(e, "lecture NFC");
      return false;
    }
    if (ctrl.signal.aborted || !this.isConnected) return false;
    this.patch({ status: "ready", error: null, active: true, scanning: true });
    return true;
  }

  async stop(): Promise<boolean> {
    this.scanAbort?.abort();
    this.writeAbort?.abort();
    this.scanAbort = this.writeAbort = null;
    this.patch({ scanning: false, writing: false, active: false, status: this.state.supported ? "idle" : "unsupported" });
    return true;
  }

  async write(arg: CommandArg): Promise<boolean> {
    const reader = this.getReader();
    if (!reader) return this.unsupported();
    const records = buildNfcMessage(arg);
    if (typeof records === "string") {
      this.patch({ status: "error", error: records });
      return false;
    }
    this.writeAbort?.abort();
    const ctrl = new AbortController();
    this.writeAbort = ctrl;
    this.patch({ writing: true, error: null, status: this.state.scanning ? "ready" : "requesting" });
    try {
      // Attend qu'un tag soit approché ; `stop` annule.
      await reader.write({ records }, { overwrite: !this.noOverwrite, signal: ctrl.signal });
    } catch (e) {
      if (this.writeAbort !== ctrl) return false;
      this.writeAbort = null;
      if ((e as { name?: string } | null)?.name === "AbortError") {
        this.patch({ writing: false, status: this.state.scanning ? "ready" : "idle" });
        return false;
      }
      this.nfcFail(e, "écriture NFC");
      return false;
    }
    if (this.writeAbort === ctrl) this.writeAbort = null;
    this.patch({ writing: false, error: null, status: "ready", lastWrite: { records: records.length, at: Date.now() } });
    return true;
  }

  async makeReadOnly(): Promise<boolean> {
    if (!this.allowLock) {
      this.patch({ status: "error", error: "verrouillage du tag refusé : irréversible, ajouter l'attribut allow-lock pour l'autoriser" });
      return false;
    }
    const reader = this.getReader();
    if (!reader) return this.unsupported();
    if (typeof reader.makeReadOnly !== "function") {
      this.patch({ status: "unsupported", error: "verrouillage du tag non disponible dans ce navigateur" });
      return false;
    }
    this.patch({ writing: true, error: null });
    try {
      await reader.makeReadOnly();
    } catch (e) {
      this.nfcFail(e, "verrouillage NFC");
      return false;
    }
    this.patch({ writing: false, status: "ready" });
    return true;
  }

  private onReading = (e: Event): void => {
    const ev = e as NdefReadingEvent;
    const records = (ev.message?.records ?? []).slice(0, MAX_RECORDS).map(decodeNfcRecord);
    const serial = typeof ev.serialNumber === "string" && ev.serialNumber ? ev.serialNumber.slice(0, 64) : null;
    this.patch({ serial, records, count: this.state.count + 1, error: null, status: "ready" });
    const target = this.target.trim();
    if (target) dispatch(target, { type: "nfc:read", payload: { serial, records: JSON.parse(JSON.stringify(records)) } });
    this.emit("sonic-nfc-read", { serial, records });
  };

  private onReadingError = (): void => {
    this.patch({ error: "tag NFC illisible (format non NDEF ?), réessayer", status: "ready" });
  };
}

export default SonicNfc;
