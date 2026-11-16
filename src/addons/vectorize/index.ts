/** Addon vectorize : image → chemins SVG (quantification des couleurs, suivi de contours). */
export { SonicVectorize, readSettings, type VectorizeState, type VectorizeSettings } from "./vectorize";
export { trace, toSvg, quantize, label, denoise, traceMask, smoothRing, ringToCurve, MAX_PIXELS, type TraceOptions, type TraceResult, type Layer, type RGBA } from "./trace";
export { parseSvgDocument, lengthMm, MAX_SVG_CHARS, type SvgImport, type SvgRawShape, type ParseSvgOptions } from "./svgdoc";
export { svgRefOf, svgTextOf } from "./vectorize";
