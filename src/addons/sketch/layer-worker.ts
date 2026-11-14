import type { Stroke, View } from "./model";
import type { LayerMsg, LayerReply } from "./layer-worker-entry";
import { LAYER_WORKER_SOURCE } from "./layer-worker-source";

export type { LayerReply };

/**
 * Rendu de la couche en arrière-plan : un Web Worker (script en blob:, compatible CSP des artefacts) garde une
 * copie des traits et rend les vues demandées dans un OffscreenCanvas. Le fil principal ne fait qu'afficher :
 * les gestes restent fluides pendant le rendu. La copie suit le dessin : ajout au-dessus → seuls les nouveaux
 * traits partent ; tout autre changement → la liste entière (`rev` change). Sans Worker ou OffscreenCanvas, ou
 * si le worker plante, `ok` passe à faux et la toile rend sur le fil principal.
 */
export class LayerWorker {
  private worker: Worker | null = null;
  private url: string | null = null;
  /** Traits connus du worker (mêmes objets, dans l'ordre) et révision de la liste. */
  private sent: Stroke[] = [];
  private rev = 0;
  private seq = 0;
  ok: boolean;
  /** Dernière demande (les réponses plus anciennes sont ignorées). */
  wanted: { id: number; rev: number; len: number; view: View; w: number; h: number; dpr: number } | null = null;

  constructor(private onReply: (r: LayerReply) => void, enabled = true) {
    this.ok = enabled && LayerWorker.supported();
  }

  static supported(): boolean {
    return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function";
  }

  /** Met la copie du worker à jour ; renvoie la révision et la longueur de la liste. */
  syncDoc(strokes: Stroke[]): { rev: number; len: number } {
    const sent = this.sent;
    let same = strokes.length >= sent.length;
    if (same) for (let i = sent.length - 1; i >= 0; i--) if (strokes[i] !== sent[i]) { same = false; break; }
    if (same && strokes.length === sent.length) return { rev: this.rev, len: sent.length };
    const w = this.ensure();
    if (!w) return { rev: this.rev, len: sent.length };
    try {
      if (same && sent.length) w.postMessage({ type: "append", rev: this.rev, strokes: strokes.slice(sent.length) } satisfies LayerMsg);
      else w.postMessage({ type: "set", rev: ++this.rev, strokes } satisfies LayerMsg);
    } catch {
      this.fail();
      return { rev: this.rev, len: sent.length };
    }
    this.sent = strokes.slice();
    return { rev: this.rev, len: strokes.length };
  }

  /** Révision et longueur actuelles, sans rien envoyer (pour juger une réponse). */
  state(strokes: Stroke[]): { rev: number; len: number } | null {
    const sent = this.sent;
    if (strokes.length < sent.length) return null;
    for (let i = sent.length - 1; i >= 0; i--) if (strokes[i] !== sent[i]) return null;
    return { rev: this.rev, len: sent.length };
  }

  /** Demande le rendu d'une vue (idempotent si la même demande est déjà en cours). */
  request(strokes: Stroke[], view: View, w: number, h: number, dpr: number, bg: string | null): boolean {
    if (!this.ok) return false;
    const { rev, len } = this.syncDoc(strokes);
    if (!this.ok) return false;
    const q = this.wanted;
    if (q && q.rev === rev && q.len === len && q.w === w && q.h === h && q.dpr === dpr && sameView(q.view, view)) return true;
    const id = ++this.seq;
    this.wanted = { id, rev, len, view: { ...view }, w, h, dpr };
    try {
      this.worker!.postMessage({ type: "render", id, rev, len, view: { ...view }, w, h, dpr, bg } satisfies LayerMsg);
    } catch {
      this.fail();
      return false;
    }
    return true;
  }

  /** Abandonne la demande en cours (sa réponse sera ignorée). */
  cancel(): void {
    this.wanted = null;
  }

  dispose(): void {
    this.wanted = null;
    this.stop();
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (!this.ok) return null;
    try {
      this.url = URL.createObjectURL(new Blob([LAYER_WORKER_SOURCE], { type: "text/javascript" }));
      const w = new Worker(this.url, { name: "sonic-sketch-layer" });
      w.onmessage = (e: MessageEvent<LayerReply>) => {
        const r = e.data;
        const q = this.wanted;
        if (!q || r.id !== q.id) { r.bitmap?.close(); return; }
        this.wanted = null;
        if (r.error === "désynchronisé") { this.sent = []; r.bitmap?.close(); }
        this.onReply(r);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        this.fail();
      };
      this.worker = w;
      this.sent = [];
      return w;
    } catch {
      this.fail();
      return null;
    }
  }

  private fail(): void {
    // Worker refusé (CSP…) ou planté : la toile repasse au rendu sur le fil principal.
    const q = this.wanted;
    this.ok = false;
    this.stop();
    if (q) this.onReply({ ...q, error: "worker indisponible", ms: 0 });
    this.wanted = null;
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.sent = [];
    this.rev++;
  }
}

export const sameView = (a: View, b: View): boolean => a.x === b.x && a.y === b.y && a.zoom === b.zoom && a.rotation === b.rotation;
