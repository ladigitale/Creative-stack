import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { bool, num } from "../../shared/media/control";
import { FrameRing, type RingSlot } from "../../shared/media/frame-ring";
import type { SonicFrameConsumerHost, SonicFrameSource } from "../../shared/mediaRef";

const tagName = "sonic-frame-sync";

export type FrameSyncMode = "sync" | "delay" | "live";

export type FrameSyncState = {
  /** Mode effectivement utilisé à cet instant (`sync` retombe sur `delay` sans tracker). */
  mode: FrameSyncMode;
  /** true tant que l'image affichée est celle que le tracker a analysée (mode sync). */
  matched: boolean;
  /** Numéro (frameSeq de la source) de l'image affichée. */
  seq: number;
  /** Âge de l'image affichée par rapport à la plus récente de la source, en ms. */
  delayMs: number;
  /** Dernier frameSeq annoncé par le tracker (ou null). */
  trackerSeq: number | null;
  /** Nombre d'images gardées. */
  filled: number;
};

type CanvasSource = Partial<SonicFrameSource> & Partial<SonicFrameConsumerHost>;

/**
 * Affiche l'image que le tracker a réellement analysée (ou une image retardée de N ms),
 * pour que l'effet (calculé à partir d'un résultat en retard) et la vidéo soient alignés.
 *
 * Source d'images (contrat `getFrameCanvas()` + `frameSeq`) → utilisable tel quel dans
 * `sonic-shader channel0="#id"`.
 *
 * Modes (`mode` : `auto` par défaut) :
 * - `sync`  : `sync="<DP du tracker>"`, le tracker publie `frameSeq` ; image exacte.
 * - `delay` : `delay-ms="120"`, retard fixe (repli, ou source sans identité d'image).
 * - `live`  : aucune attente, passe-plat.
 * `auto` = sync si `sync` est renseigné, sinon delay si `delay-ms` > 0, sinon live.
 * En `sync`, si le tracker ne publie plus (aucun visage, arrêté) on retombe sur un retard égal à la
 * dernière latence mesurée, puis sur `live`.
 *
 * DP `control` : `{ hold, source, delayMs (0..5000), mode }` ; `delayMs` et `mode` recouvrent les attributs
 * tant que la clé est présente (clé retirée : retour à l'attribut).
 */
@customElement(tagName)
export class SonicFrameSync extends LitElement implements SonicFrameSource, SonicFrameConsumerHost {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** `#id` de la source d'images (sonic-camera, sonic-video…). */
  @property({ type: String })
  for = "";

  /** DataProvider du tracker (son `out-data-provider`) : doit contenir `frameSeq`, `latencyMs`. */
  @property({ type: String })
  sync = "";

  @property({ type: String })
  mode: "auto" | FrameSyncMode = "auto";

  /** Retard fixe en ms (mode delay). */
  @property({ type: Number, attribute: "delay-ms" })
  delayMs = 0;

  /** Nombre d'images gardées (défaut 12 ≈ 400 ms à 30 fps). Chaque image = 1 canvas. */
  @property({ type: Number })
  history = 12;

  /** Largeur max des copies gardées (0 = taille de la source). Réduire économise la mémoire. */
  @property({ type: Number, attribute: "max-width" })
  maxWidth = 0;

  /** Au-delà de ce délai sans publication du tracker (ms), on quitte le mode sync. */
  @property({ type: Number, attribute: "stale-ms" })
  staleMs = 600;

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  /**
   * `"true"` : fige l'image affichée (la plus récente de la source au moment du gel) ; `frameSeq` ne bouge plus.
   * Placé entre une caméra et ses trackers (`for="<ce composant>"`), il fige aussi leurs résultats : une photo.
   */
  @property({ type: String })
  hold: "true" | "false" | "" = "";

  /**
   * DataProvider de commande `{ hold, source, delayMs, mode }` (un store) : chaque clé valide prime sur l'attribut
   * correspondant (`hold` quand il publie un booléen).
   */
  @property({ type: String })
  control = "";

  /**
   * DataProvider où publier l'image figée, à chaque gel : `{ url (blob:, PNG), width, height, mime }` ; `null` quand le gel
   * se lève. Se branche sur l'entrée d'un modèle (`sonic-hugging-face-infer inputProvider="<chemin>.url"`, carte de
   * profondeur) ou sur `sonic-still in-data-provider`.
   */
  @property({ type: String, attribute: "snapshot-provider" })
  snapshotProvider = "";

  private controlHold: boolean | undefined;
  /** Source imposée par `control.source` (`#id`), prioritaire sur `for`. */
  private controlSource: string | undefined;
  /** Retard et mode imposés par `control`, prioritaires sur `delay-ms` et `mode`. */
  private controlDelay: number | undefined;
  private controlMode: "auto" | FrameSyncMode | undefined;
  private controlUnsub: (() => void) | null = null;
  private frozen = false;

  private ring = new FrameRing<HTMLCanvasElement>(12);
  private shown: RingSlot<HTMLCanvasElement> | null = null;
  private outSeq = 0;
  private lastSrcSeq = -1;
  private raf = 0;
  private unsub: (() => void) | null = null;
  private token: object = {};
  private registeredOn: CanvasSource | null = null;
  private consumers = new Set<object>();
  private tracker: { seq: number | null; latency: number; at: number } = { seq: null, latency: 0, at: 0 };
  private lastLatency = 0;
  private lastPublished = "";

  get frameSeq(): number {
    return this.outSeq;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.shown?.value ?? null;
  }

  registerFrameConsumer(token: object = {}): void {
    this.consumers.add(token);
  }

  unregisterFrameConsumer(token: object = {}): void {
    this.consumers.delete(token);
  }

  /** Vrai quand l'image est figée (commande `control` si elle publie, sinon attribut `hold`). */
  get held(): boolean {
    return this.controlHold !== undefined ? this.controlHold : this.hold === "true";
  }

  private listenControl(): void {
    this.controlUnsub?.();
    this.controlUnsub = null;
    this.controlHold = undefined;
    this.controlSource = undefined;
    this.controlDelay = undefined;
    this.controlMode = undefined;
    if (!this.control.trim()) return;
    this.controlUnsub = listenDp(this.control, (v) => {
      const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
      this.controlHold = o ? bool(o.hold) : undefined;
      const src = o && typeof o.source === "string" ? o.source.trim() : "";
      this.controlSource = /^#?[A-Za-z][\w-]{0,63}$/.test(src) ? src : undefined;
      this.controlDelay = o ? num(o.delayMs, 0, 5000) : undefined;
      const m = o?.mode;
      this.controlMode = m === "auto" || m === "sync" || m === "delay" || m === "live" ? m : undefined;
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listenControl();
    this.listen();
    this.raf = requestAnimationFrame(this.loop);
  }

  disconnectedCallback(): void {
    if (this.snapshotUrl) URL.revokeObjectURL(this.snapshotUrl);
    this.snapshotUrl = null;
    this.snapshotToken++;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.unsub?.();
    this.unsub = null;
    this.controlUnsub?.();
    this.controlUnsub = null;
    this.registeredOn?.unregisterFrameConsumer?.(this.token);
    this.registeredOn = null;
    this.ring.clear();
    this.shown = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("sync")) this.listen();
    if (changed.has("control")) this.listenControl();
    if (changed.has("history")) this.ring.capacity = Math.max(2, Math.min(120, Math.round(this.history) || 12));
  }

  render() {
    return html``;
  }

  /** Mode demandé → mode effectif (hors repli dynamique). */
  resolveMode(): FrameSyncMode {
    const mode = this.controlMode ?? this.mode;
    if (mode === "sync" || mode === "delay" || mode === "live") return mode;
    if (this.sync.trim()) return "sync";
    return this.effectiveDelay() > 0 ? "delay" : "live";
  }

  /** Retard fixe effectif (ms) : `control.delayMs`, sinon l'attribut `delay-ms`. */
  effectiveDelay(): number {
    const d = this.controlDelay ?? this.delayMs;
    return Number.isFinite(d) ? Math.min(5000, Math.max(0, d)) : 0;
  }

  private listen(): void {
    this.unsub?.();
    this.unsub = null;
    this.tracker = { seq: null, latency: 0, at: 0 };
    if (!this.sync.trim()) return;
    this.unsub = listenDp(this.sync, (v) => {
      const o = (v ?? {}) as { frameSeq?: unknown; latencyMs?: unknown };
      const seq = typeof o.frameSeq === "number" && Number.isFinite(o.frameSeq) ? o.frameSeq : null;
      const lat = typeof o.latencyMs === "number" && Number.isFinite(o.latencyMs) ? o.latencyMs : 0;
      if (lat > 0) this.lastLatency = lat;
      this.tracker = { seq, latency: lat, at: performance.now() };
    });
  }

  private source(): CanvasSource | null {
    const id = (this.controlSource ?? this.for).trim().replace(/^#/, "");
    if (!id) return null;
    const root = this.getRootNode() as Document | ShadowRoot;
    return (root.getElementById?.(id) ?? document.getElementById(id)) as CanvasSource | null;
  }

  private loop = (): void => {
    this.tick(performance.now());
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Un pas : capture si la source a une nouvelle image, puis choisit l'image à montrer. */
  tick(now: number): void {
    const src = this.source();
    if (src !== this.registeredOn) {
      this.registeredOn?.unregisterFrameConsumer?.(this.token);
      src?.registerFrameConsumer?.(this.token);
      this.registeredOn = src;
      this.ring.clear();
      this.shown = null;
      this.lastSrcSeq = -1;
    }
    if (!src || typeof src.getFrameCanvas !== "function") return;
    if (this.frozen && this.held) return;
    const seq = typeof src.frameSeq === "number" ? src.frameSeq : 0;
    if (seq !== this.lastSrcSeq) {
      const canvas = src.getFrameCanvas();
      if (canvas && canvas.width > 0) {
        this.lastSrcSeq = seq;
        this.capture(canvas, seq, now);
      }
    }
    if (this.held) {
      // Gel : la plus récente image captée devient définitive jusqu'à la levée du gel.
      const newest = this.ring.newest();
      if (newest) {
        this.frozen = true;
        if (newest !== this.shown) {
          this.shown = newest;
          this.outSeq++;
          this.publishSnapshot(newest.value);
        }
        this.publish(this.resolveMode(), false, newest);
      }
      return;
    }
    if (this.frozen) this.clearSnapshot();
    this.frozen = false;
    this.choose(now);
  }

  private snapshotUrl: string | null = null;
  private snapshotToken = 0;

  private publishSnapshot(canvas: HTMLCanvasElement): void {
    const path = (this.snapshotProvider ?? "").trim();
    if (!path || typeof canvas.toBlob !== "function") return;
    const token = ++this.snapshotToken;
    const { width, height } = canvas;
    canvas.toBlob((blob) => {
      if (!blob || token !== this.snapshotToken || !this.isConnected) return;
      if (this.snapshotUrl) URL.revokeObjectURL(this.snapshotUrl);
      this.snapshotUrl = URL.createObjectURL(blob);
      set(path, { url: this.snapshotUrl, width, height, mime: "image/png" });
    }, "image/png");
  }

  private clearSnapshot(): void {
    this.snapshotToken++;
    const path = (this.snapshotProvider ?? "").trim();
    if (path) set(path, null);
    if (this.snapshotUrl) URL.revokeObjectURL(this.snapshotUrl);
    this.snapshotUrl = null;
  }

  private capture(canvas: HTMLCanvasElement, seq: number, now: number): void {
    this.ring.capacity = Math.max(2, Math.min(120, Math.round(this.history) || 12));
    const scale = this.maxWidth > 0 && canvas.width > this.maxWidth ? this.maxWidth / canvas.width : 1;
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    this.ring.push(
      seq,
      now,
      (recycled) => {
        const c = recycled ?? document.createElement("canvas");
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        c.getContext("2d")?.drawImage(canvas, 0, 0, w, h);
        return c;
      },
      this.shown?.seq ?? null,
    );
  }

  private choose(now: number): void {
    const newest = this.ring.newest();
    if (!newest) return;
    const wanted = this.resolveMode();
    let mode: FrameSyncMode = wanted;
    let slot: RingSlot<HTMLCanvasElement> | null = newest;
    let matched = false;

    if (wanted === "sync") {
      const fresh = this.tracker.seq !== null && now - this.tracker.at <= this.staleMs;
      if (fresh) {
        slot = this.ring.bySeq(this.tracker.seq as number);
        matched = !!slot && slot.seq === this.tracker.seq;
      } else {
        // Plus de résultat récent (pas de visage, tracker arrêté) : retard = dernière latence connue.
        mode = this.lastLatency > 0 ? "delay" : "live";
        slot = this.lastLatency > 0 ? this.ring.byTime(now - this.lastLatency) : newest;
      }
    } else if (wanted === "delay") {
      slot = this.ring.byTime(now - this.effectiveDelay());
    }

    if (slot && slot !== this.shown) {
      this.shown = slot;
      this.outSeq++;
    }
    this.publish(mode, matched, newest);
  }

  private publish(mode: FrameSyncMode, matched: boolean, newest: RingSlot<HTMLCanvasElement>): void {
    if (!this.outDataProvider || !this.shown) return;
    const state: FrameSyncState = {
      mode,
      matched,
      seq: this.shown.seq,
      delayMs: Math.max(0, Math.round(newest.at - this.shown.at)),
      trackerSeq: this.tracker.seq,
      filled: this.ring.size,
    };
    const key = `${state.mode}|${state.matched}|${state.seq}|${state.delayMs}|${state.trackerSeq}|${state.filled}`;
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    set(this.outDataProvider, state);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [tagName]: SonicFrameSync;
  }
}
