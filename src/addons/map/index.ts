/**
 * Addon map : carte MapLibre GL JS pilotée par DataProviders (vue, style, points en entrée ;
 * état de la vue en sortie). Opt-in : `@supersoniks/creative-stack/map` (peer : maplibre-gl 5).
 */
export { default as SonicMap } from "./map";
export { toGeoJSON, readPointsSpec, hostAllowed, firstForbiddenUrl, styleUrls, sameCamera } from "./map-core";
export type { MapPoint, PointsSpec, Camera } from "./map-core";

import "./map";
