/**
 * Cœur sans DOM de `sonic-pose-tracker` : miroir, noms gauche/droite côté écran, lissage One Euro,
 * maintien (`hold-ms`), mesures du corps, clés de sortie plates et attribut `map`.
 */
import type { Point } from "../../shared/ml/hands";
import { assignPath, evalMap, type CompiledMap } from "../../shared/ml/map-expr";
import { Smoother } from "../../shared/ml/one-euro";
import { ANGLE_KEYS, JOINT_NAMES, bodyMetrics, jointAngles, jointsByName, mirrorPose, type BodyMetrics, type JointName, type RawPose } from "../../shared/ml/pose";

export type JointOutput = { x: number; y: number; z: number; v: number };

export type PoseOutput = BodyMetrics & {
  present: 0 | 1;
  count: number;
  joints: Record<JointName, JointOutput>;
  poses: Array<{ landmarks: Point[]; world?: Point[] }>;
  [derived: string]: unknown;
};

export type PoseCoreOptions = {
  smooth: number;
  holdMs: number;
  /** Image affichée en miroir : `left*` = côté gauche de l'écran (et du sujet). Sinon les côtés sont échangés. */
  mirror: boolean;
  map?: CompiledMap | null;
};

const METRIC_KEYS = ["x", "y", "raiseLeft", "raiseRight", "span", "lean", ...ANGLE_KEYS] as const;

const emptyJoints = (): Record<JointName, JointOutput> => {
  const out = {} as Record<JointName, JointOutput>;
  for (const n of JOINT_NAMES) out[n] = { x: 0.5, y: 0.5, z: 0, v: 0 };
  return out;
};

const EMPTY_METRICS: BodyMetrics = { x: 0.5, y: 0.5, raiseLeft: 0.5, raiseRight: 0.5, span: 0, lean: 0, elbowLeft: 1, elbowRight: 1, kneeLeft: 1, kneeRight: 1, squat: 0 };

export class PoseTrackerCore {
  private opts: PoseCoreOptions;
  private smoother: Smoother;
  private joints = emptyJoints();
  private metrics: BodyMetrics = { ...EMPTY_METRICS };
  private present: 0 | 1 = 0;
  private lastSeen = -Infinity;

  constructor(opts: PoseCoreOptions) {
    this.opts = { ...opts };
    this.smoother = new Smoother(opts.smooth);
  }

  configure(opts: Partial<PoseCoreOptions>): void {
    if (opts.smooth !== undefined && opts.smooth !== this.opts.smooth) this.smoother = new Smoother(opts.smooth);
    this.opts = { ...this.opts, ...opts };
  }

  reset(): void {
    this.smoother.reset();
    this.joints = emptyJoints();
    this.metrics = { ...EMPTY_METRICS };
    this.present = 0;
    this.lastSeen = -Infinity;
  }

  update(raw: RawPose[], now: number): PoseOutput {
    const poses: PoseOutput["poses"] = [];
    if (raw.length > 0) {
      const primary = raw[0];
      const lm = this.opts.mirror ? mirrorPose(primary.landmarks) : primary.landmarks;
      const named = jointsByName(lm, !this.opts.mirror);
      const joints = emptyJoints();
      for (const n of JOINT_NAMES) {
        const p = named[n];
        if (!p) continue;
        joints[n] = {
          x: this.smoother.apply(`${n}.x`, p.x, now),
          y: this.smoother.apply(`${n}.y`, p.y, now),
          z: this.smoother.apply(`${n}.z`, p.z, now),
          v: p.visibility,
        };
      }
      this.joints = joints;
      const m = bodyMetrics(named);
      // Angles : points en mètres (world) quand ils existent, sinon points image.
      if (primary.world && primary.world.length >= 33) {
        const w = jointsByName(
          primary.world.map((p) => ({ ...p, visibility: 1 })),
          !this.opts.mirror,
        );
        Object.assign(m, jointAngles(w));
      }
      const next = { ...EMPTY_METRICS };
      for (const k of METRIC_KEYS) next[k] = this.smoother.apply(k, m[k], now);
      this.metrics = next;
      this.present = 1;
      this.lastSeen = now;
      for (const p of raw) {
        poses.push({
          landmarks: (this.opts.mirror ? mirrorPose(p.landmarks) : p.landmarks).map(({ x, y, z }) => ({ x, y, z })),
          world: p.world,
        });
      }
    } else if (this.present === 1 && now - this.lastSeen > this.opts.holdMs) {
      this.present = 0;
      this.smoother.reset();
    }

    const output: PoseOutput = { ...this.metrics, present: this.present, count: raw.length, joints: this.joints, poses };
    if (this.opts.map && this.opts.map.ok) {
      for (const [key, value] of Object.entries(evalMap(this.opts.map, output))) assignPath(output, key, value);
    }
    return output;
  }
}
