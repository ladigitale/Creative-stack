/**
 * Addon interactivity déclarative (stores, inputs, matrix).
 * Opt-in : `@supersoniks/creative-stack/interactive`
 */
export {
  dispatch,
  getStore,
  listStoreIds,
  type SonicActionMessage,
} from "./registry";
export { SonicStore } from "./store";
export { SonicKeyboard } from "./keyboard";
export { SonicGamepad } from "./gamepad";
export { SonicGesture } from "./gesture";
export { SonicAction } from "./action";
export { SonicTicker } from "./ticker";
export { SonicTrigger, type TriggerState } from "./trigger";
export { TriggerMachine, matchesRule, readPath, type TriggerEvent, type TriggerOptions, type TriggerRule } from "./trigger-core";
export { SonicMotion } from "./motion";
export { MotionTracker, quantizeNote, parseRange, parseScale, type MotionOptions, type MotionOutput } from "./motion-core";
export { SonicMatrix } from "./matrix";
export { SonicNotify, toMessages, escapeText, type NotifyMessage } from "./notify";
export { SonicCssVars, isSafeVar } from "./css-vars";
export { SonicSlider } from "./slider";

/** `sonic-if` (mode attributs) et `sonic-value` (`format`) sur Concorde classique. */
import "../../shared/concorde-compat";
import "./store";
import "./keyboard";
import "./gamepad";
import "./gesture";
import "./action";
import "./ticker";
import "./trigger";
import "./motion";
import "./matrix";
import "./notify";
import "./css-vars";
import "./slider";
