/** Addon vectorize : image → chemins SVG (quantification des couleurs, suivi de contours). */
export { SonicVectorize, type VectorizeState } from "./vectorize";
export { trace, toSvg, quantize, label, denoise, traceMask, MAX_PIXELS, type TraceOptions, type TraceResult, type Layer, type RGBA } from "./trace";
