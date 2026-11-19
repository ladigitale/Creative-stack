/**
 * Addon anchor : ancrer du contenu sur une surface réelle vue par la caméra.
 * `sonic-anchor-ref` photographie et délimite la zone, `sonic-anchor` la retrouve en direct
 * (points caractéristiques, homographie, a priori de gravité), `sonic-anchor-view` y projette du SDUI.
 */
export { SonicAnchorRef, type AnchorRefState } from "./anchor-ref";
export { SonicAnchor, type AnchorState, type AnchorStatus } from "./anchor";
export { SonicAnchorView, fitRect, projectionMatrix } from "./anchor-view";
export { extractFeatures, PATTERN_VERSION, type Features, type FeatureOptions } from "./core/features";
export { toGray, resizeGray, boxBlur, type Gray } from "./core/image";
export { matchDescriptors, type Matches } from "./core/match";
export { apply, fitHomography, ransacHomography, squareToQuad, toCssMatrix3d, type Mat3, type Pt } from "./core/homography";
export { buildReference, referenceFromFeatures, decodeReference, locate, orderQuad, type AnchorReference, type DecodedReference, type LocateResult } from "./core/reference";
export { upInImage } from "./core/gravity";
