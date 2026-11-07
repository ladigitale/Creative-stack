/**
 * Mode « vrai 2D » de procgen : illustration vectorielle (Bézier, aplats, traits à épaisseur variable), rendu Canvas
 * net à tout zoom et export SVG. Même `SceneModel`, mêmes acteurs et événements que la vue 3D.
 */
export { VectorView, type VectorViewState } from "./view";
export { composeVector } from "./compose";
export { toSVG, renderSVG } from "./svg";
export { VectorScene, objectParams, DRAWERS } from "./scene";
export { resolveVectorStyle, makeInks, VECTOR_STYLES, type VectorStyle, type VectorStyleName } from "./vstyle";
export { Projector, type VectorCamera } from "./project";
export { ActorSim, type ActorIntent, type GameEvent } from "./actors";
export { type Shape, Pen, strokeVar, blob, scallop, hull, validPath } from "./shape";
