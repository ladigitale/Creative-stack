/** Addon sketch : dessin vectoriel à zoom infini, export SVG. */
export { SonicSketch, type SketchState } from "./sketch";
export { Doc, MAX_ZOOM, MIN_ZOOM, clampZoom, contentBBox, fitView, panBy, sanitizeView, strokeHit, toScreen, toWorld, visibleRect, zoomAt, type Stroke, type View } from "./model";
export { exportSvg } from "./export";
