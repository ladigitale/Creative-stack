/**
 * Addon tape : lecture « bande / platine » d'un son à vitesse signée pilotée en temps réel
 * (rotation ou secousse de l'appareil, curseur, DataProvider), avant et arrière, scrub.
 */
export { SonicTape, type TapeState, type TapeStatus } from "./tape";
export { TapeVoice, reverseBuffer } from "./voice";
export {
  RateMapper,
  HighPass,
  LeakyIntegrator,
  deadzone,
  ema,
  omegaToRate,
  scrubRate,
  TURNTABLE_33_DEG_PER_SEC,
  type RateMode,
  type RateMapperOptions,
} from "./mapping";
