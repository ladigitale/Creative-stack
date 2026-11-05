import { customElement, property } from "lit/decorators.js";
import { listenDp } from "../../shared/audio/dp";
import { createMediaPipeMpEngine, getVisionConfig } from "./mp-engine";
import { SonicSegmenter, type SegmentOutput } from "./segmenter";
import type { TrackerEngine } from "./tracker-base";

const tagName = "sonic-click-segmenter";

type Masks = Parameters<SonicSegmenter["toOutput"]>[0];
type Point = { x: number; y: number };

/** Point 0..1 depuis `"x,y"`, `[x, y]` ou `{ x, y }` ; `null` si invalide ou hors de l'image. */
export function parsePoint(v: unknown): Point | null {
  let x: number;
  let y: number;
  if (typeof v === "string") {
    const p = v.trim().split(/[\s,]+/).map(Number);
    if (p.length < 2) return null;
    [x, y] = p;
  } else if (Array.isArray(v)) {
    x = Number(v[0]);
    y = Number(v[1]);
  } else if (v && typeof v === "object") {
    x = Number((v as Point).x);
    y = Number((v as Point).y);
  } else return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Segmente l'objet qui se trouve **au point désigné** (clic, toucher, valeur d'un DataProvider) : modèle interactif de
 * MediaPipe, sans liste de catégories. Même sortie que `sonic-segmenter` : le masque est une source d'images
 * (`sonic-mask-replace mask="#id"`, `sonic-shader channel1="#id"`), plus `point` et les statistiques (couverture, centre, boîte).
 * Le point est donné en coordonnées d'écran 0..1 (comme ce que voit l'utilisateur, miroir compris) par :
 * `point="0.5,0.4"`, `point-from="chemin"` (DataProvider : `{x, y}` ou `"x,y"`) ou `click-on="#id"` (un clic sur cet
 * élément, par exemple la vue de la caméra). Sans point : aucun masque. `live="true"` (défaut) re-segmente ce qui est sous
 * le point à chaque image : ce n'est pas un suivi d'objet, l'objet qui bouge quitte le point ; `live="false"` fige le masque
 * calculé pour ce point.
 */
@customElement(tagName)
export class SonicClickSegmenter extends SonicSegmenter {
  /** Point d'intérêt `x,y` (0..1, repère écran). */
  @property({ type: String })
  point = "";

  /** Chemin DataProvider du point (`{x, y}` ou `"x,y"`, 0..1) ; prime sur `point`. */
  @property({ type: String, attribute: "point-from" })
  pointFrom = "";

  /** Id d'un élément dont un clic / toucher désigne le point (position relative à sa boîte). */
  @property({ type: String, attribute: "click-on" })
  clickOn = "";

  /** `"false"` : le masque est calculé une fois par point puis gardé. */
  @property({ type: String })
  live: "true" | "false" = "true";

  /** Le modèle interactif est lourd : cadence plus basse que le segmenteur de personne. */
  @property({ type: Number })
  fps = 8;

  private pt: Point | null = null;
  private unlistenPoint: (() => void) | null = null;
  private clickEl: Element | null = null;

  protected defaultModel(): string {
    return "interactive-segmenter";
  }

  /** Désigne le point (0..1, repère écran) ou, avec `null`, l'efface. */
  setPoint(p: Point | null): void {
    const same = (!p && !this.pt) || (!!p && !!this.pt && p.x === this.pt.x && p.y === this.pt.y);
    if (same) return;
    this.pt = p;
    if (!p) this.clearMask();
  }

  getPoint(): Point | null {
    return this.pt ? { ...this.pt } : null;
  }

  disconnectedCallback(): void {
    this.detachInputs();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (!this.isConnected) return;
    if (changed.has("point") || changed.has("pointFrom") || changed.has("clickOn") || this.clickEl === null) this.attachInputs();
  }

  private attachInputs(): void {
    this.detachInputs();
    const from = this.pointFrom.trim();
    if (from) this.unlistenPoint = listenDp(from, (v) => this.setPoint(parsePoint(v)));
    else if (this.point.trim() || !this.clickOn.trim()) this.setPoint(parsePoint(this.point));
    const id = this.clickOn.trim().replace(/^#/, "");
    const el = id ? (document.getElementById(id) ?? null) : null;
    if (el) {
      el.addEventListener("pointerdown", this.onClick);
      this.clickEl = el;
    }
  }

  private detachInputs(): void {
    this.unlistenPoint?.();
    this.unlistenPoint = null;
    this.clickEl?.removeEventListener("pointerdown", this.onClick);
    this.clickEl = null;
  }

  private onClick = (e: Event) => {
    const el = this.clickEl;
    const ev = e as PointerEvent;
    if (!el || typeof ev.clientX !== "number") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    this.setPoint(parsePoint({ x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height }));
  };

  private isMirrored(frame: CanvasImageSource): boolean {
    return this.mirror === "true" || (this.mirror === "auto" && typeof HTMLVideoElement !== "undefined" && frame instanceof HTMLVideoElement);
  }

  protected async createEngine(model: Uint8Array): Promise<TrackerEngine<Masks>> {
    const factory = getVisionConfig().createMpEngine ?? createMediaPipeMpEngine;
    const mp = await factory({ task: "interactive", model, options: {}, delegate: this.delegate, thread: this.thread });
    let cache: { key: string; masks: Masks } | null = null;
    return {
      backend: mp.backend,
      thread: mp.thread,
      close: () => mp.close(),
      detect: async (frame, tsMs) => {
        const pt = this.pt;
        if (!pt) return [];
        // le point est donné à l'écran ; le modèle voit l'image brute (non retournée)
        const raw = { x: this.isMirrored(frame) ? 1 - pt.x : pt.x, y: pt.y };
        const key = `${raw.x},${raw.y}`;
        if (this.live === "false" && cache?.key === key) return cache.masks;
        const masks = (await mp.detect(frame, tsMs, raw)).masks ?? [];
        cache = { key, masks };
        return masks;
      },
    };
  }

  protected toOutput(masks: Masks, now: number, mirror: boolean): SegmentOutput {
    return { ...super.toOutput(masks, now, mirror), point: this.pt ? { ...this.pt } : null };
  }
}

export default SonicClickSegmenter;
