/**
 * Moteur de détection de mains : `HandEngine` est le seul contrat vu par `sonic-hand-tracker`.
 * Par défaut il s'appuie sur le moteur MediaPipe générique (`mp-engine.ts` : worker classique, repli
 * fil principal) ; l'app hôte peut fournir le sien (`configureVision({ createEngine })`).
 */
import type { Point, RawHand } from "../../shared/ml/hands";
import { createMediaPipeMpEngine, getVisionConfig, type MpResult } from "./mp-engine";

export {
  WORKER_SOURCE,
  configureVision,
  getVisionConfig,
  resetVisionConfig,
  type MpResult,
  type VisionConfig,
} from "./mp-engine";

export type HandEngineOptions = {
  /** Contenu du modèle (.task), déjà téléchargé, plafonné et éventuellement vérifié par sha256. */
  model: Uint8Array;
  /** `true` : le modèle fournit aussi les gestes (GestureRecognizer). */
  gestures: boolean;
  maxHands: number;
  minScore: number;
  delegate: "gpu" | "cpu" | "auto";
  /** `auto` : worker puis repli fil principal ; `worker` : pas de repli ; `main` : jamais de worker. */
  thread: "auto" | "worker" | "main";
};

export type HandEngine = {
  /** `tsMs` strictement croissant. Une seule détection à la fois (le composant l'impose). */
  detect(frame: CanvasImageSource, tsMs: number): Promise<RawHand[]>;
  readonly backend: "gpu" | "cpu";
  readonly thread: "worker" | "main";
  close(): void;
};

export type HandEngineFactory = (options: HandEngineOptions) => Promise<HandEngine>;

const toPoints = (l: Array<{ x: number; y: number; z: number }> | undefined): Point[] | undefined =>
  l?.map((p) => ({ x: p.x, y: p.y, z: p.z }));

/** Convertit un résultat MediaPipe (sans dépendre de ses types) en mains brutes. */
export function handsFromMediaPipe(result: MpResult, minScore: number): RawHand[] {
  const out: RawHand[] = [];
  const marks = result.landmarks ?? [];
  const handed = result.handedness ?? result.handednesses ?? [];
  for (let i = 0; i < marks.length; i++) {
    const landmarks = toPoints(marks[i]);
    if (!landmarks || landmarks.length < 21) continue;
    const cat = handed[i]?.[0];
    const score = cat?.score ?? 1;
    if (score < minScore) continue;
    const gesture = result.gestures?.[i]?.[0];
    out.push({
      landmarks,
      world: toPoints(result.worldLandmarks?.[i]),
      label: cat?.categoryName ?? cat?.displayName,
      score,
      gesture: gesture?.categoryName && gesture.categoryName !== "None" ? gesture.categoryName : undefined,
      gestureScore: gesture?.score,
    });
  }
  return out;
}

export const createMediaPipeEngine: HandEngineFactory = async (opts) => {
  const factory = getVisionConfig().createMpEngine ?? createMediaPipeMpEngine;
  const mp = await factory({
    task: opts.gestures ? "gesture" : "hand",
    model: opts.model,
    options: {
      numHands: opts.maxHands,
      minHandDetectionConfidence: opts.minScore,
      minHandPresenceConfidence: opts.minScore,
      minTrackingConfidence: opts.minScore,
    },
    delegate: opts.delegate,
    thread: opts.thread,
  });
  return {
    backend: mp.backend,
    thread: mp.thread,
    close: () => mp.close(),
    detect: async (frame, tsMs) => handsFromMediaPipe(await mp.detect(frame, tsMs), opts.minScore),
  };
};
