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
export { SonicMatrix } from "./matrix";

/** `sonic-if` (mode attributs) et `sonic-value` (`format`) sur Concorde classique. */
import "../../shared/concorde-compat";
import "./store";
import "./keyboard";
import "./gamepad";
import "./gesture";
import "./action";
import "./ticker";
import "./trigger";
import "./matrix";
