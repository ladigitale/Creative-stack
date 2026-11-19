import { customElement, property } from "lit/decorators.js";
import { listenDp, plain } from "../../shared/audio/dp";
import { DeviceElement, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-geolocation";

export type GeoPlace = { id?: string; lat: number; lon: number; [k: string]: unknown };
export type NearbyPlace = GeoPlace & {
  /** Distance en mètres. */
  distance: number;
  /** Relèvement depuis la position (degrés, 0 = nord, sens horaire). */
  bearing: number;
};

export type GeolocationState = DeviceBaseState & {
  watching: boolean;
  lat: number | null;
  lon: number | null;
  /** Précision horizontale (mètres, rayon à ~68 %). */
  accuracy: number | null;
  altitude: number | null;
  /** Cap de déplacement (degrés), seulement en mouvement. */
  heading: number | null;
  /** Vitesse (m/s). */
  speed: number | null;
  timestamp: number | null;
  /** Lieux du DP `places` dans le rayon, du plus proche au plus loin. */
  nearby: NearbyPlace[];
  nearest: NearbyPlace | null;
};

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distance (m, haversine) et relèvement initial (degrés) de a vers b. */
export function distanceBearing(lat1: number, lon1: number, lat2: number, lon2: number): { distance: number; bearing: number } {
  const p1 = rad(lat1), p2 = rad(lat2), dp = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const distance = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { distance, bearing };
}

/** Lieux dans le rayon, triés par distance (au plus `max`). */
export function nearbyPlaces(lat: number, lon: number, places: unknown, radius: number, max = 50): NearbyPlace[] {
  const list = Array.isArray(places) ? places : [];
  const out: NearbyPlace[] = [];
  for (const p of list) {
    const la = Number((p as GeoPlace)?.lat), lo = Number((p as GeoPlace)?.lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const { distance, bearing } = distanceBearing(lat, lon, la, lo);
    if (distance > radius) continue;
    out.push({ ...(p as GeoPlace), lat: la, lon: lo, distance: Math.round(distance * 10) / 10, bearing: Math.round(bearing) });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, max);
}

/**
 * Position GPS de l'appareil et lieux proches.
 *
 * - `watch` : suit la position dès que possible (le navigateur demande la permission) ; sinon commande `start`.
 * - `places` (DP) : liste `[{id, lat, lon, …}]` ; l'état publie `nearby` (dans `radius` mètres, avec `distance`
 *   et `bearing`) et `nearest`. Recalculé à chaque position et à chaque changement de la liste.
 * - `control` (DP) : compteurs `{ start, stop, once }`.
 * - État `<id>State` : `{ status, error, supported, allowed, active, watching, lat, lon, accuracy, altitude,
 *   heading, speed, timestamp, nearby, nearest }`.
 *
 * Contexte sécurisé (https) obligatoire ; dans une iframe, l'hôte doit autoriser `geolocation`.
 */
@customElement(tagName)
export class SonicGeolocation extends DeviceElement<GeolocationState> {
  @property({ type: Boolean }) watch = false;
  @property({ type: Boolean, attribute: "high-accuracy" }) highAccuracy = true;
  /** Âge maximal d'une position en cache (ms). */
  @property({ type: Number, attribute: "maximum-age" }) maximumAge = 5000;
  @property({ type: Number }) timeout = 20000;
  @property({ type: String }) places = "";
  /** Rayon des lieux proches (mètres). */
  @property({ type: Number }) radius = 300;
  @property({ type: Number, attribute: "max-nearby" }) maxNearby = 30;

  protected feature = "geolocation";
  protected readonly defaultCommand: string = "start";
  protected state: GeolocationState = {
    status: "idle", error: null, supported: false, allowed: "unknown", active: false,
    watching: false, lat: null, lon: null, accuracy: null, altitude: null, heading: null, speed: null, timestamp: null,
    nearby: [], nearest: null,
  };
  private watchId: number | null = null;
  private placeList: unknown = [];
  private unlistenPlaces: (() => void) | null = null;

  protected commands(): CommandMap {
    return {
      start: () => this.start(),
      stop: () => this.stop(),
      once: () => this.once(),
    };
  }

  private api(): Geolocation | null {
    return typeof navigator !== "undefined" && navigator.geolocation ? navigator.geolocation : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    const supported = !!this.api();
    this.patch({ supported, status: supported ? "idle" : "unsupported", error: supported ? null : "géolocalisation non disponible ici" });
    if (this.watch && supported) this.start();
  }

  disconnectedCallback(): void {
    this.stop();
    this.unlistenPlaces?.();
    this.unlistenPlaces = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    if (changed.has("places")) {
      this.unlistenPlaces?.();
      this.unlistenPlaces = this.places ? listenDp(this.places, (v) => { this.placeList = plain(v); this.refreshNearby(); }) : null;
    }
    if (changed.has("radius") || changed.has("maxNearby")) this.refreshNearby();
  }

  private options(): PositionOptions {
    return { enableHighAccuracy: this.highAccuracy, maximumAge: Math.max(0, this.maximumAge), timeout: Math.max(1000, this.timeout) };
  }

  start(): boolean {
    const api = this.api();
    if (!api) { this.patch({ status: "unsupported", error: "géolocalisation non disponible ici" }); return false; }
    if (this.watchId !== null) return true;
    this.patch({ status: "requesting", error: null, watching: true, active: true });
    this.watchId = api.watchPosition(this.onPosition, this.onError, this.options());
    return true;
  }

  stop(): void {
    if (this.watchId !== null) this.api()?.clearWatch(this.watchId);
    this.watchId = null;
    if (this.state.watching) this.patch({ watching: false, active: false });
  }

  once(): boolean {
    const api = this.api();
    if (!api) { this.patch({ status: "unsupported", error: "géolocalisation non disponible ici" }); return false; }
    if (this.state.status !== "ready") this.patch({ status: "requesting", error: null });
    api.getCurrentPosition(this.onPosition, this.onError, this.options());
    return true;
  }

  /** Position reçue (public pour les tests). */
  onPosition = (p: GeolocationPosition): void => {
    const c = p.coords;
    const fin = (v: number | null) => (v === null || !Number.isFinite(v) ? null : v);
    this.state = {
      ...this.state,
      status: "ready", error: null,
      lat: Math.round(c.latitude * 1e7) / 1e7, lon: Math.round(c.longitude * 1e7) / 1e7,
      accuracy: fin(c.accuracy) === null ? null : Math.round(c.accuracy * 10) / 10,
      altitude: fin(c.altitude), heading: fin(c.heading), speed: fin(c.speed), timestamp: p.timestamp,
    };
    this.refreshNearby(false);
  };

  private onError = (e: GeolocationPositionError): void => {
    if (e.code === 1) this.patch({ status: "denied", error: "géolocalisation refusée (permission ou page hôte)", watching: false, active: false });
    else if (e.code === 3) this.patch({ status: this.state.lat === null ? "error" : "ready", error: "position pas encore obtenue (délai dépassé)" });
    else this.patch({ status: "error", error: "position indisponible (signal GPS, réseau)" });
    if (e.code === 1) this.stop();
  };

  private refreshNearby(force = true): void {
    const { lat, lon } = this.state;
    const nearby = lat === null || lon === null ? [] : nearbyPlaces(lat, lon, this.placeList, Math.max(1, this.radius), Math.max(1, this.maxNearby));
    this.patch({ nearby, nearest: nearby[0] ?? null }, force);
  }
}
