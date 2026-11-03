/**
 * Cœur sans DOM de `sonic-face-tracker` : miroir, lissage One Euro, maintien (`hold-ms`), expressions,
 * clés de sortie plates et attribut `map`.
 */
import { faceExpressions, faceMetrics, mirrorFace, type FaceExpressions, type FaceMetrics, type RawFace } from "../../shared/ml/face";
import type { Point } from "../../shared/ml/hands";
import { assignPath, evalMap, type CompiledMap } from "../../shared/ml/map-expr";
import { Smoother } from "../../shared/ml/one-euro";

export type FaceScalars = FaceMetrics & FaceExpressions;

export type FacesOutput = FaceScalars & {
  present: 0 | 1;
  count: number;
  /** Blendshapes du premier visage (52 clés MediaPipe, noms du sujet, 0..1). */
  blend: Record<string, number>;
  faces: Array<{ blend: Record<string, number>; landmarks?: Point[] }>;
  [derived: string]: unknown;
};

export type FaceCoreOptions = {
  smooth: number;
  holdMs: number;
  mirror: boolean;
  map?: CompiledMap | null;
  /** Publier les 478 points de chaque visage (lourd : désactivé par défaut). */
  landmarks?: boolean;
};

const SCALAR_KEYS = [
  "x", "y", "z", "size", "yaw", "pitch", "roll",
  "mouthOpen", "smile", "pucker", "browUp", "browDown", "blinkLeft", "blinkRight", "gazeX", "gazeY",
] as const;

const EMPTY: FaceScalars = {
  x: 0.5, y: 0.5, z: 0, size: 0, yaw: 0, pitch: 0, roll: 0,
  mouthOpen: 0, smile: 0, pucker: 0, browUp: 0, browDown: 0, blinkLeft: 0, blinkRight: 0, gazeX: 0, gazeY: 0,
};

export class FaceTrackerCore {
  private opts: FaceCoreOptions;
  private smoother: Smoother;
  private last: FaceScalars = { ...EMPTY };
  private lastBlend: Record<string, number> = {};
  private present: 0 | 1 = 0;
  private lastSeen = -Infinity;

  constructor(opts: FaceCoreOptions) {
    this.opts = { ...opts };
    this.smoother = new Smoother(opts.smooth);
  }

  configure(opts: Partial<FaceCoreOptions>): void {
    if (opts.smooth !== undefined && opts.smooth !== this.opts.smooth) {
      this.smoother = new Smoother(opts.smooth);
    }
    this.opts = { ...this.opts, ...opts };
  }

  reset(): void {
    this.smoother.reset();
    this.last = { ...EMPTY };
    this.lastBlend = {};
    this.present = 0;
    this.lastSeen = -Infinity;
  }

  update(raw: RawFace[], now: number): FacesOutput {
    const faces: FacesOutput["faces"] = [];
    if (raw.length > 0) {
      const primary = raw[0];
      const lm = this.opts.mirror ? mirrorFace(primary.landmarks) : primary.landmarks;
      const scalars: FaceScalars = { ...faceMetrics(lm), ...faceExpressions(primary.blendshapes, this.opts.mirror) };
      const next = { ...EMPTY };
      for (const k of SCALAR_KEYS) next[k] = this.smoother.apply(k, scalars[k], now);
      this.last = next;
      this.lastBlend = primary.blendshapes;
      this.present = 1;
      this.lastSeen = now;
      for (const f of raw) {
        const entry: FacesOutput["faces"][number] = { blend: f.blendshapes };
        if (this.opts.landmarks) entry.landmarks = this.opts.mirror ? mirrorFace(f.landmarks) : f.landmarks;
        faces.push(entry);
      }
    } else if (this.present === 1 && now - this.lastSeen > this.opts.holdMs) {
      this.present = 0;
      this.smoother.reset();
    }

    const output: FacesOutput = {
      ...this.last,
      present: this.present,
      count: raw.length,
      blend: { ...this.lastBlend },
      faces,
    };
    if (this.opts.map && this.opts.map.ok) {
      for (const [key, value] of Object.entries(evalMap(this.opts.map, output))) assignPath(output, key, value);
    }
    return output;
  }
}
