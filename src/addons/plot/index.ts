/**
 * Addon plot : graphiques statistiques déclaratifs (SVG, design tokens Concorde, DataProviders).
 */
export { SonicPlot, type PlotState } from "./plot";
export { normalizeSpec, field, PLOT_TYPES, type PlotSpec, type PlotType, type PlotRule } from "./spec";
export { buildChart, seriesColor, type ChartModel, type Hit, type Mark, type Axis, type LegendItem } from "./layout";
export { niceTicks, ticksIn, timeTicks, makeFormatter, linePath, arcPath, band, linear, parseDate } from "./scales";
