/**
 * Identité d'objets entre images (calcul pur, sans DOM) : chaque boîte détectée reçoit l'`id` de la boîte de même
 * étiquette qui la recouvre le plus à l'image précédente (IoU), sinon un nouvel `id`. Un objet qui disparaît
 * garde son `id` pendant `maxAgeMs` : s'il revient au même endroit, il le retrouve (passage derrière un obstacle,
 * détection manquée). Appariement glouton par IoU décroissante : suffisant pour quelques objets, pas pour une foule.
 */

export type TrackInput = { label: string; x: number; y: number; w: number; h: number };
export type TrackResult = { id: number; /** Durée (ms) depuis la première apparition de cet `id`. */ ageMs: number };

export type IdTrackerOptions = { iou: number; maxAgeMs: number };

type Track = { id: number; key: string; x: number; y: number; w: number; h: number; firstSeen: number; lastSeen: number };

const labelOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/** Recouvrement (intersection / union) de deux boîtes `x, y, w, h`. 0 si l'une est vide. */
export function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  if (!(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0)) return 0;
  const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

export class IdTracker {
  private opts: IdTrackerOptions;
  private tracks: Track[] = [];
  private next = 1;

  constructor(opts: Partial<IdTrackerOptions> = {}) {
    this.opts = { iou: 0.3, maxAgeMs: 500, ...opts };
  }

  configure(opts: Partial<IdTrackerOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  reset(): void {
    this.tracks = [];
    this.next = 1;
  }

  /** `id` des objets suivis en ce moment (vus ou encore gardés). */
  alive(): Set<number> {
    return new Set(this.tracks.map((t) => t.id));
  }

  /** Associe les boîtes de cette image aux identités ; renvoie un résultat par boîte, dans le même ordre. */
  update(boxes: TrackInput[], now: number): TrackResult[] {
    const iouMin = Math.max(0.01, Math.min(0.99, this.opts.iou));
    const pairs: Array<{ t: number; d: number; v: number }> = [];
    boxes.forEach((b, d) => {
      const key = labelOf(b.label);
      this.tracks.forEach((t, ti) => {
        if (t.key !== key) return;
        const v = iou(t, b);
        if (v >= iouMin) pairs.push({ t: ti, d, v });
      });
    });
    pairs.sort((a, b) => b.v - a.v);
    const usedT = new Set<number>();
    const assigned = new Map<number, Track>();
    for (const p of pairs) {
      if (usedT.has(p.t) || assigned.has(p.d)) continue;
      usedT.add(p.t);
      assigned.set(p.d, this.tracks[p.t]);
    }
    const results = boxes.map((b, d): TrackResult => {
      let t = assigned.get(d);
      if (!t) {
        t = { id: this.next++, key: labelOf(b.label), x: b.x, y: b.y, w: b.w, h: b.h, firstSeen: now, lastSeen: now };
        this.tracks.push(t);
      }
      t.x = b.x;
      t.y = b.y;
      t.w = b.w;
      t.h = b.h;
      t.lastSeen = now;
      return { id: t.id, ageMs: Math.max(0, Math.round(now - t.firstSeen)) };
    });
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= this.opts.maxAgeMs);
    return results;
  }
}
