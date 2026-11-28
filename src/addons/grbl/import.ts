import { customElement, property } from "lit/decorators.js";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { DeviceElement, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { listenDp, plain } from "../../shared/audio/dp";
import type { LaserOp } from "./toolpath";
import { IMPORT_ACCEPT, IMPORT_FORMATS, importBytes, type ImportFormat, type ImportKind } from "./formats";

const tagName = "sonic-laser-import";

export type LaserImportState = DeviceBaseState & {
  /** Un fichier est lu et prêt. */
  ready: boolean;
  /** Incrémenté à chaque fichier lu. */
  seq: number;
  name: string;
  format: ImportFormat | null;
  formatLabel: string;
  /** `vector` (dessin → `drawing-provider`), `image` (→ `image-provider`) ou `program` (G-code → `drawing-provider`). */
  kind: ImportKind | null;
  widthMm: number;
  heightMm: number;
  /** Couleurs du dessin : une opération par couleur dans `sonic-gcode ops`. */
  colors: string[];
  /** Réglages proposés par le fichier (calques LightBurn), à reprendre tels quels dans `ops`. */
  ops: LaserOp[] | null;
  layers: { name: string; color: string; mode?: string; power?: number; speed?: number; passes?: number }[];
  /** Pages du PDF ; `page` = celle lue. */
  pages: number;
  page: number;
  /** Lignes du programme (G-code). */
  lines: number;
  skipped: Record<string, number>;
  issues: string[];
  /** Formats lus, pour l'interface ; `accept` : valeur à donner à `sonic-file-open accept`. */
  formats: { id: string; label: string; kind: string; ext: string[]; note: string }[];
  accept: string;
};

type FileRef = { url: string; name?: string; mime?: string };
const refOf = (v: unknown): FileRef | null => {
  const r = v as { url?: unknown; name?: unknown; mime?: unknown } | null;
  return r && typeof r.url === "string" && /^(blob|data):/.test(r.url) ? { url: r.url, name: typeof r.name === "string" ? r.name : "", mime: typeof r.mime === "string" ? r.mime : "" } : null;
};

/**
 * Ouvre les fichiers de découpe et de gravure laser : SVG / SVGZ, DXF, PDF, Illustrator (.ai), EPS / PS,
 * HPGL / PLT, projets LightBurn (.lbrn2, .lbrn), G-code (.gcode, .nc, .tap…), images (PNG, JPEG, WebP, GIF,
 * BMP, AVIF) et TIFF. Rien n'est exécuté : chaque format est lu par un lecteur borné.
 *
 * - `from` : DP du fichier (`ref-provider` de `sonic-file-open accept="<state>.accept"`).
 * - `drawing-provider` : reçoit `{ svg, name, format }` pour un dessin (SVG millimétré, à donner à
 *   `sonic-gcode svg-from`), ou `{ gcode: [...], name, format }` pour un programme prêt (passé tel quel par
 *   `sonic-gcode`, vérifié par `sonic-grbl` : M4 imposé, commandes `$` refusées).
 * - `image-provider` : reçoit la référence d'image (`{ url, mime, name }`) pour `sonic-still in-data-provider` ;
 *   un TIFF y arrive converti en PNG.
 * - `page` (PDF), `format` (`auto` ou un format imposé) ; `control` : `{ import: n, clear: n, page }`.
 * - État `<id>State` : voir `LaserImportState`.
 */
@customElement(tagName)
export class SonicLaserImport extends DeviceElement<LaserImportState> {
  @property({ type: String }) from = "";
  @property({ type: String, attribute: "drawing-provider" }) drawingProvider = "";
  @property({ type: String, attribute: "image-provider" }) imageProvider = "";
  @property({ type: Number }) page = 1;
  @property({ type: String }) format = "auto";

  protected feature = null;
  protected readonly defaultCommand = "import";
  protected state: LaserImportState = {
    status: "idle", error: null, supported: true, allowed: "unknown", active: false,
    ready: false, seq: 0, name: "", format: null, formatLabel: "", kind: null, widthMm: 0, heightMm: 0, colors: [], ops: null, layers: [],
    pages: 0, page: 1, lines: 0, skipped: {}, issues: [],
    formats: IMPORT_FORMATS.map((f) => ({ ...f, ext: [...f.ext] })),
    accept: IMPORT_ACCEPT,
  };

  private file: FileRef | null = null;
  private livePage: number | null = null;
  private offFrom: (() => void) | null = null;
  private offLive: (() => void) | null = null;
  private job = 0;
  private madeUrl: string | null = null;

  protected commands(): CommandMap {
    return {
      import: () => this.load(),
      clear: () => this.clear(),
    };
  }

  disconnectedCallback(): void {
    this.offFrom?.();
    this.offLive?.();
    this.offFrom = this.offLive = null;
    this.revoke();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    if (changed.has("from")) {
      this.offFrom?.();
      this.offFrom = null;
      if (this.from) {
        const read = (v: unknown) => {
          const ref = refOf(v);
          if (JSON.stringify(ref) === JSON.stringify(this.file)) return;
          this.file = ref;
          this.livePage = null;
          if (ref) void this.load();
        };
        read(plain(get(this.from)));
        this.offFrom = listenDp(this.from, read);
      }
    }
    if (changed.has("control")) {
      this.offLive?.();
      this.offLive = this.control
        ? listenDp(this.control, (v) => {
            const p = Number((v as { page?: unknown } | null)?.page);
            if (Number.isFinite(p) && p >= 1 && p !== this.livePage) {
              this.livePage = Math.round(p);
              if (this.file && (this.state.format === "pdf" || this.state.format === "ai")) void this.load();
            }
          })
        : null;
    }
    if ((changed.has("page") && changed.get("page") !== undefined) || (changed.has("format") && changed.get("format") !== undefined)) {
      if (this.file) void this.load();
    }
  }

  private revoke(): void {
    if (this.madeUrl) URL.revokeObjectURL(this.madeUrl);
    this.madeUrl = null;
  }

  private clear(): boolean {
    this.file = null;
    this.revoke();
    if (this.drawingProvider) set(this.drawingProvider, null);
    this.patch({ status: "idle", error: null, active: false, ready: false, name: "", format: null, formatLabel: "", kind: null, widthMm: 0, heightMm: 0, colors: [], ops: null, layers: [], pages: 0, lines: 0, skipped: {}, issues: [] });
    return true;
  }

  async load(): Promise<boolean> {
    const file = this.file;
    if (!file) {
      this.patch({ status: "error", error: "aucun fichier : from=\"<ref-provider de sonic-file-open>\"" });
      return false;
    }
    const job = ++this.job;
    const page = this.livePage ?? this.page;
    this.patch({ status: "requesting", error: null, ready: false, name: file.name ?? "" });
    try {
      const bytes = new Uint8Array(await (await fetch(file.url)).arrayBuffer());
      if (job !== this.job || !this.isConnected) return false;
      const res = await importBytes(bytes, { name: file.name, mime: file.mime, page, format: (this.format || "auto") as ImportFormat | "auto" });
      if (job !== this.job || !this.isConnected) return false;
      const meta = IMPORT_FORMATS.find((f) => f.id === res.format)!;
      const name = file.name ?? "";
      if (res.kind === "image") {
        this.revoke();
        let ref: FileRef & { width?: number; height?: number } = file;
        if (res.pixels) {
          const c = document.createElement("canvas");
          c.width = res.pixels.width;
          c.height = res.pixels.height;
          const ctx = c.getContext("2d");
          if (!ctx) throw new Error("canvas 2D indisponible");
          ctx.putImageData(new ImageData(res.pixels.data as Uint8ClampedArray<ArrayBuffer>, res.pixels.width, res.pixels.height), 0, 0);
          const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
          if (!blob) throw new Error("conversion de l'image impossible");
          this.madeUrl = URL.createObjectURL(blob);
          ref = { url: this.madeUrl, mime: "image/png", name: name.replace(/\.tiff?$/i, ".png"), width: c.width, height: c.height };
        }
        if (this.imageProvider) set(this.imageProvider, { ...ref });
      } else if (this.drawingProvider) {
        set(this.drawingProvider, res.kind === "program" ? { gcode: res.gcode, name, format: res.format } : { svg: res.svg, name, format: res.format });
      }
      this.patch({
        status: "ready", error: null, active: true, ready: true, seq: this.state.seq + 1, name, format: res.format, formatLabel: meta.label, kind: res.kind,
        widthMm: res.widthMm, heightMm: res.heightMm, colors: res.colors, ops: res.ops, layers: res.layers, pages: res.pages, page: Math.min(page, res.pages || 1),
        lines: res.gcode?.length ?? 0, skipped: res.skipped, issues: res.issues,
      });
      this.emit("sonic-laser-import-ready", { format: res.format, kind: res.kind });
      return true;
    } catch (e) {
      if (job !== this.job) return false;
      this.patch({ status: "error", error: e instanceof Error && e.message ? e.message : "fichier illisible", ready: false, active: false });
      return false;
    }
  }
}

export default SonicLaserImport;
