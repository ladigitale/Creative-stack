/**
 * Addon plot : graphiques statistiques déclaratifs et graphes nœuds / liens (SVG, design tokens Concorde, DataProviders).
 */
export { SonicPlot, type PlotState } from "./plot";
export { normalizeSpec, field, PLOT_TYPES, type PlotSpec, type PlotType, type PlotRule } from "./spec";
export { buildChart, seriesColor, type ChartModel, type Hit, type Mark, type Axis, type LegendItem } from "./layout";
export { niceTicks, ticksIn, timeTicks, makeFormatter, linePath, arcPath, band, linear, parseDate } from "./scales";
export { SonicGraph, readSelection, MAX_PUBLISHED_POSITIONS, type GraphState } from "./graph";
export { ForceSim, normalizeGraph, staticLayout, sanitizeLayout, nodeRadius, LAYOUTS, MAX_NODES, MAX_LINKS, BARNES_HUT_FROM, type GraphData, type GraphNodeIn, type GraphLinkIn, type LayoutKind, type ForceOptions, type SimNode } from "./force";
