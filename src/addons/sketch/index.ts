/** Addon sketch : dessin vectoriel à zoom infini, export SVG. */
export { SonicSketch, type SketchState } from "./sketch";
export { Doc, MAX_ZOOM, MIN_ZOOM, clampZoom, contentBBox, fitView, panBy, sanitizeView, strokeHit, toScreen, toWorld, visibleRect, zoomAt, type Stroke, type View } from "./model";
export { exportSvg } from "./export";
export { SonicSketchGuide } from "./guide-element";
export { GUIDE_DEFAULTS, GUIDE_TYPES, POSES, guidePaths, sanitizeGuide, type GuideSettings, type GuideType } from "./guide";
export { readStrokes, writeStrokes, type DrawingMeta } from "./store";
export { SonicPainterly, imageUrlOf, readPainterlyOptions, type PainterlyState } from "./painterly-element";
export { paintImage, type PainterlyOptions, type PainterlyResult } from "./painterly";
export { readGestures, gesturesUrl, type Gestures } from "./gestures";
