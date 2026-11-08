/**
 * Addon procgen v3 : générateur procédural 3D (personnages skinnés, végétation, rochers, bâtiments, terrain, routes,
 * objets, blasons) rendu en 2D ou en 3D selon la caméra et le style, piloté par DataProvider.
 * Opt-in : `@supersoniks/creative-stack/procgen` (peer : three).
 */
export { SonicProcgen } from "./procgen";
export { ProcgenView, type ActorIntent, type GameEvent } from "./render/view";
export { composeScene, type Recipe, type SceneModel, type LayerSpec, type Placement } from "./scene/compose";
export { SCENES } from "./scene/library";
export { GENERATORS, generatorCatalog } from "./gen/index";
export { STYLE_PRESETS, PALETTES, resolveStyle, resolveColors, type StyleTokens } from "./style/style";
export { ROLES } from "./style/roles";
export { CAMERAS } from "./render/camera";
export { ACTIONS } from "./rig/locomotion";
export { GenKit, GenActor, type GenDrive } from "./bridge";
import { GenKit as _GenKit, GenActor as _GenActor } from "./bridge";
import { GenSprite as _GenSprite } from "./vector/sprite";
import { registerProcgen } from "../../shared/procgen-loader";
registerProcgen({ GenKit: _GenKit, GenActor: _GenActor, GenSprite: _GenSprite });
import "./procgen";
export * from "./vector/index";
