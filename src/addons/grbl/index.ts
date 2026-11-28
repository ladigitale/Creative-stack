/**
 * Addon grbl : machines GRBL (graveurs et découpeuses laser, traceurs à stylo) pilotées par DataProvider.
 *
 * `sonic-gcode` prépare le programme (SVG ou image → G-code), `sonic-grbl` pilote la machine derrière un
 * `sonic-serial` (addon `serial`) : état en direct, déplacements, cadrage, envoi en flux, pause, arrêt.
 */
export { SonicGrbl, type GrblState, type GrblJob } from "./grbl";
export { SonicGcode, type GcodeState, type GcodeSettings } from "./gcode";
export {
  RT, RX_BUFFER, MAX_LINE, parseGrblLine, parseStatus, cleanLine, checkLine, analyzeGcode, prepareJob, grblErrorMessage, grblAlarmMessage, num,
  type GrblMessage, type GrblReport, type GcodeStats, type PreparedJob,
} from "./codec";
export { GrblLink, type Ack, type JobEnd } from "./link";
export { MACHINES, getMachine, isGcodeSource, type MachineProfile, type SonicGcodeSource } from "./machines";
export {
  TOOLPATH_DEFAULTS, MAX_GCODE_LINES, svgToGcode, rasterToGcode, readSvgShapes, planVector, emitPasses, hatch, withTabs, orderPaths, hexColor, cleanOp,
  type LaserOp, type LaserMode, type ToolpathSettings, type ToolpathResult, type RasterSettings, type ToolPath, type ToolPass,
} from "./toolpath";
export { SonicLaserPattern, type PatternState } from "./pattern";
export { SonicGcodeView, parseProgram, gridSteps, formatDuration, SIM_RATES, type ParsedProgram, type GcodeViewState } from "./gcode-view";
export { dryRunLines, modalAt, resumeLines, burnPoints, convexHull, frameLines, resumeHint, PLANNER_LOOKBACK, type ModalState, type ResumePlan } from "./jobs";
export { PATTERNS, FAMILIES, getPattern, patternParams, heartPath, starPath, roundRect, gridColor, type PatternDef, type ParamSpec, type Pattern, type PatternFamily } from "./patterns";
export { optimizeStrokes, strokeLength, type Polyline, type StrokeOptions } from "./lineart";
export { subdivide, tree, coral, spirograph, guilloche, rosette, truchet, maze, flowField, harmonograph, waves, repeatTiles, fitLines, noise2, SUBDIV_MODES, LEAF_FILLS, TILE_SHAPES, REPEATS } from "./generative";
export { LINE_STYLES, photoBurns, burnsToGcode, type LineStyle, type Burn, type PhotoTrace } from "./photo";
export { colorsOf, type FoundColor } from "./toolpath";
export { SonicLaserImport, type LaserImportState } from "./import";
export {
  IMPORT_FORMATS, IMPORT_ACCEPT, detectFormat, importBytes, unsupportedHint, readGcodeText, readDxf, aciColor, readHpgl, readPdf, readPostScript, readLightburn, LIGHTBURN_COLORS, readTiff, writeSvg,
  type ImportFormat, type ImportKind, type ImportResult, type Pixels, type Shape,
} from "./formats";
