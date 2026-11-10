import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "./audio/dp";
import type { View2D } from "./view2d";

/**
 * Vue partagée entre plusieurs toiles superposées (`view-sync` de `sonic-sketch` et `sonic-paint`) : chacune
 * lit le DP `{ x, y, zoom, rotation }` et y écrit sa vue quand elle change (geste, cadrage). Deux calques qui
 * partagent la même vue restent alignés pixel pour pixel : une unité du monde vectoriel = un pixel de l'image.
 * Une toile qui borne la vue (zoom maximal d'une image) réécrit la vue bornée, que les autres adoptent.
 */
export class ViewSync {
  private last = "";
  constructor(private readonly path: string) {}

  private static key(v: View2D): string {
    return `${v.x},${v.y},${v.zoom},${v.rotation}`;
  }

  /** `apply` reçoit chaque vue venue du DP (sauf l'écho de la sienne). */
  listen(apply: (v: unknown) => void): () => void {
    return listenDp(this.path, (v) => {
      if (!v || typeof v !== "object") return;
      const o = v as Partial<View2D>;
      if (![o.x, o.y, o.zoom].every((n) => typeof n === "number" && Number.isFinite(n))) return;
      const k = ViewSync.key({ x: o.x!, y: o.y!, zoom: o.zoom!, rotation: Number(o.rotation) || 0 });
      if (k === this.last) return;
      this.last = k;
      apply(v);
    });
  }

  /** Publie la vue si elle diffère de la dernière vue lue ou écrite. */
  write(v: View2D): void {
    const k = ViewSync.key(v);
    if (k === this.last) return;
    this.last = k;
    set(this.path, { x: v.x, y: v.y, zoom: v.zoom, rotation: v.rotation });
  }
}
