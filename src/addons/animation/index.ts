/**
 * Addon animation : le temps est une valeur de DataProvider (`sonic-clock`), une timeline la lit
 * (`sonic-timeline`), `sonic-animate` applique des recettes prêtes à l'emploi.
 * Opt-in : `@supersoniks/creative-stack/animation`
 */
export { SonicClock } from "./clock";
export { SonicTimeline } from "./timeline";
export { SonicAnimate } from "./animate";
export { ClockCore } from "./clock-core";
export { TimelineRunner, type RunnerOptions, type RunnerState } from "./runner";
export { RECIPES, RECIPE_NAMES, buildRecipe, isRecipe, type RecipeName, type RecipeOptions } from "./recipes";
export {
  LIMITS,
  applyState,
  compileTimeline,
  evaluate,
  isAnimatableProp,
  labelAt,
  normalizeProgress,
  resolveEase,
  setsCrossed,
} from "./timeline-core";
export { collectSduiIds, validateSduiAnimation, validateTimelineDescriptor } from "./validate";
export type * from "./types";

import "./clock";
import "./timeline";
import "./animate";
