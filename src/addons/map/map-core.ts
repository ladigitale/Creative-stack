/**
 * Cœur pur de sonic-map (sans DOM ni WebGL) : testable en isolation.
 */

export type MapPoint = { id: string | number; lat: number | string; lon?: number | string; lng?: number | string; [k: string]: unknown };

export type PointsSpec = MapPoint[] | { data?: MapPoint[]; cluster?: boolean; clusterRadius?: number; clusterMaxZoom?: number };

export type FeatureCollection = {
  type: "FeatureCollection";
  features: { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: Record<string, unknown> }[];
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Points du DataProvider → GeoJSON ; ignore les points sans id ou sans coordonnées valides. */
export function toGeoJSON(points: unknown): FeatureCollection {
  const list = Array.isArray(points) ? points : [];
  const features: FeatureCollection["features"] = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const o = p as MapPoint;
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
    const lat = num(o.lat);
    const lon = num(o.lon ?? o.lng);
    if (!finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (o.id === undefined || o.id === null || o.id === "") continue;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { ...o } });
  }
  return { type: "FeatureCollection", features };
}

/** Normalise la valeur du DP points : tableau seul ou {data, cluster…}. */
export function readPointsSpec(v: unknown): { data: MapPoint[]; cluster: boolean; clusterRadius: number; clusterMaxZoom: number } {
  const opts = Array.isArray(v) ? {} : v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const data = (Array.isArray(v) ? v : Array.isArray(opts.data) ? opts.data : []) as MapPoint[];
  return {
    data,
    cluster: opts.cluster === true,
    clusterRadius: finite(opts.clusterRadius) ? opts.clusterRadius : 50,
    clusterMaxZoom: finite(opts.clusterMaxZoom) ? opts.clusterMaxZoom : 14,
  };
}

/** Hôte autorisé : data:, blob:, même origine, ou hôte listé dans allowed-hosts. */
export function hostAllowed(url: string, allowedHosts: readonly string[], origin: string): boolean {
  if (!url || /^(data|blob):/i.test(url)) return true;
  try {
    const u = new URL(url, origin);
    if (u.origin === new URL(origin).origin) return true;
    if (u.protocol !== "https:") return false;
    return allowedHosts.includes(u.host) || allowedHosts.includes(u.hostname);
  } catch {
    return false;
  }
}

/** URL réseau d'un style MapLibre (style par URL, glyphes, sprites, tuiles, sources). */
export function styleUrls(style: unknown): string[] {
  if (typeof style === "string") return [style];
  if (!style || typeof style !== "object") return [];
  const s = style as Record<string, unknown>;
  const urls: string[] = [];
  if (typeof s.glyphs === "string") urls.push(s.glyphs);
  if (typeof s.sprite === "string") urls.push(s.sprite);
  else if (Array.isArray(s.sprite)) for (const sp of s.sprite) if (sp && typeof (sp as { url?: unknown }).url === "string") urls.push((sp as { url: string }).url);
  for (const src of Object.values((s.sources ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!src || typeof src !== "object") continue;
    if (typeof src.url === "string") urls.push(src.url);
    if (Array.isArray(src.tiles)) for (const t of src.tiles) if (typeof t === "string") urls.push(t);
    if (typeof src.data === "string") urls.push(src.data);
  }
  return urls;
}

/** Première URL refusée d'un style (gabarits {z}/{x}/{y} neutralisés), ou null. */
export function firstForbiddenUrl(style: unknown, allowedHosts: readonly string[], origin: string): string | null {
  for (const u of styleUrls(style)) {
    if (!hostAllowed(u.replace(/\{[^}]+\}/g, "0"), allowedHosts, origin)) return u;
  }
  return null;
}

export type Camera = { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number };

/** Vrai si la caméra demandée est déjà celle de la carte (évite la boucle état → vue → état). */
export function sameCamera(want: Camera, have: Required<Camera>): boolean {
  const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
  return (
    (!want.center || (near(want.center[0], have.center[0], 1e-5) && near(want.center[1], have.center[1], 1e-5))) &&
    (want.zoom === undefined || near(want.zoom, have.zoom, 1e-3)) &&
    (want.bearing === undefined || near(want.bearing, have.bearing, 1e-2)) &&
    (want.pitch === undefined || near(want.pitch, have.pitch, 1e-2))
  );
}

export const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
