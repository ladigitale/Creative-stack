/**
 * Addon `sonic-2d` : scène 2D / 2.5D PixiJS pilotée par le format `nodes` partagé (src/shared/nodes.ts).
 * Opt-in : `@supersoniks/creative-stack/2d` (peer : pixi.js).
 */
export { Sonic2d } from "./2d";
export { Scene2D } from "./scene";
export {
  parseSprite,
  parseLayers,
  layerTransform,
  screenToLayer,
  hitShape,
  safeImageSrc,
  type SpriteSpec,
  type SpriteShape,
  type Layer,
  type Camera,
} from "./model";

import "./elements";
import "./2d";
