/**
 * Addon vector : outils vectoriels — formes (chemins SVG), opérations booléennes, décalage,
 * simplification, arrondi, ajustement de courbes, élagage (culling), bibliothèque d'objets.
 */
export * from "./geometry";
export { parsePath, serializePath, flatten, ringsToPath, MAX_PATH_CHARS, MAX_SEGMENTS, type Seg } from "./svgpath";
export { pathToMulti, boolean, offset, simplifyLine, simplifyRing, simplifyMulti, visvalingam, roundedPath, fitCurve, fitMulti, type BoolOp } from "./ops";
export { cull, TileIndex, levelOfDetail, clipToView, viewFromCamera, type CullItem } from "./cull";
export { ShapeLibrary, normalizeShape, MAX_SHAPES, type VectorShape, type ShapeInfo } from "./library";
export { SonicVectorOp, SonicVectorLibrary, runVectorOp, VECTOR_OPS, type VectorOp, type VectorResult } from "./vector";
