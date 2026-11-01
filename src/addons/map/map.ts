/**
 * <sonic-map> : carte MapLibre GL JS pilotée par DataProviders Concorde (addon `map`).
 *
 * Aucun JS dans le document : tout passe par des DataProviders (DP).
 *
 *   <sonic-map dataProvider="carte"></sonic-map>
 *     lit   carte/view     caméra, projection, relief, contraintes, interactions, contrôles, sélection
 *     lit   carte/style    style MapLibre complet, patches, états d'objets, style des points
 *     lit   carte/points   tableau [{id, lat, lon, ...}] ou {data, cluster, clusterRadius}
 *     écrit carte/state    état de la vue et événements (caméra, bornes, visibles, survol, clic, erreurs)
 *
 * Chaque DP peut être redirigé : view-provider, style-provider, points-provider, state-provider.
 * Contrat détaillé : map.md
 */
import { LitElement, html, css, unsafeCSS } from "lit";
import { customElement, property } from "lit/decorators.js";
import * as maplibregl from "maplibre-gl";
import mlCss from "maplibre-gl/dist/maplibre-gl.css?inline";
import { PublisherManager } from "@supersoniks/concorde/utils";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { firstForbiddenUrl, hostAllowed as hostAllowedCore, readPointsSpec, round, sameCamera, toGeoJSON } from "./map-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ml = (): Any => maplibregl;

const DEFAULT_STYLE: Any = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#eef0ee" } }],
};

const SEL = ["boolean", ["feature-state", "selected"], false];
const HOV = ["boolean", ["feature-state", "hover"], false];
const DEFAULT_POINT_PAINT: Any = {
  "circle-radius": ["case", SEL, 9, HOV, 7, 5],
  "circle-color": ["case", SEL, "#e9a23b", HOV, "#2b8a96", "#1f5b63"],
  "circle-stroke-width": 1.5,
  "circle-stroke-color": "#ffffff",
};
const DEFAULT_CLUSTER_PAINT: Any = {
  "circle-radius": ["step", ["get", "point_count"], 12, 10, 16, 50, 22],
  "circle-color": "#1f5b63",
  "circle-opacity": 0.8,
  "circle-stroke-width": 2,
  "circle-stroke-color": "#ffffff",
};

const POINTS = "points";
const L_POINTS = "points";
const L_CLUSTERS = "points-clusters";

const same = (a: Any, b: Any) => JSON.stringify(a) === JSON.stringify(b);
const finite = (n: Any) => typeof n === "number" && Number.isFinite(n);

@customElement("sonic-map")
export default class SonicMap extends LitElement {
  static styles = [
    unsafeCSS(mlCss),
    css`
      :host { display: block; position: relative; min-height: 120px; height: 400px; }
      .map { position: absolute; inset: 0; }
    `,
  ];

  /** Base : les DP sont `${dataProvider}/view`, `/style`, `/points`, `/state`. */
  @property({ type: String }) dataProvider = "";
  @property({ type: String, attribute: "view-provider" }) viewProvider = "";
  @property({ type: String, attribute: "style-provider" }) styleProvider = "";
  @property({ type: String, attribute: "points-provider" }) pointsProvider = "";
  @property({ type: String, attribute: "state-provider" }) stateProvider = "";
  /** Hôtes autorisés pour les URL du style (tuiles, glyphes, sprites). data: et blob: sont toujours permis. */
  /** Hôtes https autorisés (tuiles, glyphes, sprites), séparés par des espaces ou des virgules. */
  @property({ type: String, attribute: "allowed-hosts" }) allowedHostsAttr = "";
  /** Store qui reçoit les clics sur un point : {type: pick-action-type, payload: {id, lngLat}}. */
  @property({ type: String }) target = "";
  @property({ type: String, attribute: "pick-action-type" }) pickActionType = "select";

  private get allowedHosts(): string[] {
    return this.allowedHostsAttr.split(/[\s,]+/).filter(Boolean);
  }
  /** "end" : état publié en fin de mouvement ; "move" : aussi pendant, limité par throttle-ms. */
  @property({ type: String, attribute: "emit" }) emit: "end" | "move" = "end";
  @property({ type: Number, attribute: "throttle-ms" }) throttleMs = 100;
  /** Si présent, un clic sur un point le sélectionne (publié dans state.selected). */
  @property({ type: Boolean, attribute: "auto-select" }) autoSelect = false;

  private map: Any = null;
  private subs: Array<() => void> = [];
  private lastView: Any = {};
  private lastStyleSpec: Any = undefined;
  private lastPatchKey = "";
  private lastFeatureStates: Any[] = [];
  private points: Any[] = [];
  private pointsOpts: Any = {};
  private pointStyle: Any = {};
  private selectedId: Any = null;
  private hoverId: Any = null;
  private clickSeq = 0;
  private appliedSeq: Any = null;
  private errors: string[] = [];
  private ready = false;
  private styleLoaded = false;
  private styleFallback = false;
  private controls = new Map<string, Any>();
  private lastEmit = 0;
  private emitTimer: Any = null;
  private resizeObs?: ResizeObserver;
  private lastClick: Any = null;
  private origin: "init" | "user" | "data" = "init";

  private name(kind: "view" | "style" | "points" | "state"): string {
    const explicit = { view: this.viewProvider, style: this.styleProvider, points: this.pointsProvider, state: this.stateProvider }[kind];
    if (explicit) return explicit;
    return this.dataProvider ? `${this.dataProvider}/${kind}` : "";
  }

  render() {
    return html`<div class="map" part="map"></div>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    this.subs.forEach((off) => off());
    this.subs = [];
    this.resizeObs?.disconnect();
    clearTimeout(this.emitTimer);
    this.map?.remove();
    this.map = null;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.initMap();
  }

  private initMap(): void {
    const container = this.renderRoot.querySelector(".map") as HTMLElement;
    const self = this;
    this.map = new (ml()).Map({
      container,
      style: DEFAULT_STYLE,
      center: [2.4, 46.6],
      zoom: 4,
      attributionControl: false,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
      transformRequest(url: string) {
        if (self.hostAllowed(url)) return { url };
        self.fail(`Requête bloquée (hôte non autorisé) : ${url}`);
        return { url: "data:application/json,{}" };
      },
    });
    this.map.on("load", () => {
      this.ready = true;
      this.styleLoaded = true;
      this.ensurePoints();
      this.reapplyAll();
      this.emitState(true);
    });
    this.map.on("style.load", () => {
      this.ready = true;
      this.styleLoaded = true;
      this.ensurePoints();
      this.reapplyAll();
    });
    this.map.on("error", (e: Any) => {
      this.fail(String(e?.error?.message ?? e?.message ?? e));
      // Style inaccessible (réseau, hôte, quota) : on revient au fond uni pour garder les points visibles.
      if (!this.styleLoaded && this.lastStyleSpec && !this.styleFallback) {
        this.styleFallback = true;
        this.map.setStyle(DEFAULT_STYLE, { diff: false });
      }
    });
    this.map.on("movestart", (e: Any) => { this.origin = e?.originalEvent ? "user" : this.origin === "init" ? "init" : "data"; });
    this.map.on("moveend", () => { this.emitState(true); if (this.origin !== "init") this.origin = "data"; });
    this.map.on("move", () => { if (this.emit === "move") this.emitState(false); });
    this.map.on("idle", () => this.emitState(true));
    this.map.on("click", (e: Any) => this.onClick(e));
    this.map.on("mousemove", (e: Any) => this.onHover(e));
    this.map.on("mouseout", () => this.setHover(null));

    this.resizeObs = new ResizeObserver(() => this.map?.resize());
    this.resizeObs.observe(this);
    this.subscribe();
  }

  // ---------- DataProviders ----------

  private watch(name: string, apply: (v: Any) => void) {
    if (!name) return;
    const pub: Any = PublisherManager.get(name);
    const handler = (v: Any) => { try { apply(v); } catch (e: Any) { this.fail(`${name} : ${e?.message ?? e}`); } };
    const onMut = () => handler(pub.get());
    pub.onAssign(handler, true);
    pub.onInternalMutation?.(onMut);
    this.subs.push(() => { pub.offAssign(handler); pub.offInternalMutation?.(onMut); });
  }

  private subscribe() {
    this.watch(this.name("points"), (v) => this.setPoints(v));
    this.watch(this.name("style"), (v) => this.applyStyleDp(v));
    this.watch(this.name("view"), (v) => this.applyView(v));
  }

  private publish(state: Any) {
    const n = this.name("state");
    if (!n) return;
    set(n, state);
  }

  private fail(message: string) {
    if (!this.errors.includes(message)) this.errors = [...this.errors.slice(-9), message];
    this.emitState(true);
  }

  // ---------- Sécurité ----------

  private hostAllowed(url: string): boolean {
    return hostAllowedCore(url, this.allowedHosts || [], location.href);
  }

  private validateStyle(style: Any): string | null {
    const bad = firstForbiddenUrl(style, this.allowedHosts || [], location.href);
    return bad ? `URL non autorisée dans le style : ${bad}` : null;
  }

  // ---------- Points ----------

  private setPoints(v: Any) {
    const spec = readPointsSpec(v);
    const rebuild = !same(
      { c: this.pointsOpts.cluster, r: this.pointsOpts.clusterRadius, m: this.pointsOpts.clusterMaxZoom },
      { c: spec.cluster, r: spec.clusterRadius, m: spec.clusterMaxZoom },
    );
    this.pointsOpts = spec;
    this.points = spec.data;
    if (!this.styleLoaded) return;
    if (rebuild) this.ensurePoints(true); else this.updatePointsSource();
    this.emitState(true);
  }

  private geojson() {
    return toGeoJSON(this.points);
  }

  private updatePointsSource() {
    const src: Any = this.map.getSource(POINTS);
    if (src) src.setData(this.geojson());
    else this.ensurePoints();
    this.reapplyFeatureStates();
    if (this.lastView?.fit === "points") this.fitToPoints(this.lastView);
  }

  /** (Re)crée la source et les couches de points si le style courant n'en fournit pas. */
  private ensurePoints(force = false) {
    const m = this.map;
    if (!m || !this.styleLoaded) return;
    const cluster = !!this.pointsOpts.cluster;
    if (force) {
      [L_CLUSTERS, L_POINTS].forEach((id) => m.getLayer(id) && m.removeLayer(id));
      m.getSource(POINTS) && m.removeSource(POINTS);
    }
    if (!m.getSource(POINTS)) {
      m.addSource(POINTS, {
        type: "geojson", data: this.geojson(), promoteId: "id",
        cluster, clusterRadius: this.pointsOpts.clusterRadius ?? 50, clusterMaxZoom: this.pointsOpts.clusterMaxZoom ?? 14,
      });
    }
    const ps = this.pointStyle || {};
    if (cluster && !m.getLayer(L_CLUSTERS)) {
      m.addLayer({ id: L_CLUSTERS, type: "circle", source: POINTS, filter: ["has", "point_count"],
        paint: { ...DEFAULT_CLUSTER_PAINT, ...(ps.clusterPaint || {}) }, layout: ps.clusterLayout || {} });
    }
    if (!m.getLayer(L_POINTS)) {
      m.addLayer({ id: L_POINTS, type: "circle", source: POINTS,
        ...(cluster ? { filter: ["!", ["has", "point_count"]] } : {}),
        paint: { ...DEFAULT_POINT_PAINT, ...(ps.paint || {}) }, layout: ps.layout || {} });
    }
  }

  private fitToPoints(v: Any) {
    const g = this.geojson().features;
    if (!g.length) return;
    const b = new (ml()).LngLatBounds();
    g.forEach((f: Any) => b.extend(f.geometry.coordinates));
    this.moveTo({ bounds: b.toArray(), boundsPadding: v.boundsPadding ?? 40, maxZoomOnFit: v.maxZoomOnFit ?? 12 }, v);
  }

  // ---------- Style ----------

  private applyStyleDp(v: Any) {
    if (!v || typeof v !== "object") return;
    if (v.pointStyle !== undefined && !same(v.pointStyle, this.pointStyle)) {
      this.pointStyle = v.pointStyle || {};
      if (this.styleLoaded) this.ensurePoints(true);
    }
    if (v.style !== undefined && !same(v.style, this.lastStyleSpec)) {
      const err = v.style ? this.validateStyle(v.style) : null;
      if (err) { this.fail(err); } else {
        this.lastStyleSpec = v.style;
        this.styleLoaded = false;
        this.styleFallback = false;
        this.map.setStyle(v.style || DEFAULT_STYLE, { diff: false });
      }
    }
    const key = JSON.stringify([v.patchSeq ?? null, v.patches ?? null]);
    if (v.patches && key !== this.lastPatchKey) {
      this.lastPatchKey = key;
      if (this.styleLoaded) this.applyPatches(v.patches);
    }
    if (Array.isArray(v.featureStates)) {
      this.lastFeatureStates = v.featureStates;
      if (this.styleLoaded) this.reapplyFeatureStates();
    }
  }

  private applyPatches(patches: Any[]) {
    const m = this.map;
    for (const p of patches) {
      try {
        switch (p.op) {
          case "paint": m.setPaintProperty(p.layer, p.prop, p.value); break;
          case "layout": m.setLayoutProperty(p.layer, p.prop, p.value); break;
          case "filter": m.setFilter(p.layer, p.value ?? null); break;
          case "zoomRange": m.setLayerZoomRange(p.layer, p.min ?? 0, p.max ?? 24); break;
          case "addSource": { const e = this.validateStyle({ sources: { x: p.source } }); if (e) throw new Error(e); m.addSource(p.id, p.source); break; }
          case "removeSource": m.getSource(p.id) && m.removeSource(p.id); break;
          case "addLayer": m.addLayer(p.layer, p.before); break;
          case "removeLayer": m.getLayer(p.id) && m.removeLayer(p.id); break;
          case "setData": m.getSource(p.source)?.setData(p.data); break;
          case "light": m.setLight(p.value); break;
          case "sky": m.setSky(p.value); break;
          case "terrain": m.setTerrain(p.value ?? null); break;
          case "projection": m.setProjection(p.value); break;
          default: throw new Error(`patch inconnu : ${p.op}`);
        }
      } catch (e: Any) { this.fail(`patch ${p?.op} : ${e?.message ?? e}`); }
    }
  }

  private setFeatureState(id: Any, state: Any, source = POINTS) {
    try { this.map.setFeatureState({ source, id }, state); } catch { /* source absente */ }
  }

  private reapplyFeatureStates() {
    if (!this.map?.getSource(POINTS)) return;
    if (this.selectedId !== null) this.setFeatureState(this.selectedId, { selected: true });
    if (this.hoverId !== null) this.setFeatureState(this.hoverId, { hover: true });
    for (const f of this.lastFeatureStates) {
      if (f?.source && f?.id !== undefined) this.setFeatureState(f.id, f.state ?? {}, f.source);
    }
  }

  private reapplyAll() {
    this.applyView(this.lastView, true);
    if (this.lastPatchKey) { /* patches déjà appliqués au style précédent : rejoués si présents */ }
    this.reapplyFeatureStates();
  }

  // ---------- Vue ----------

  private applyView(v: Any, force = false) {
    if (!v || typeof v !== "object" || !this.map) return;
    const m = this.map;
    const prev = force ? {} : this.lastView;
    const diff = (k: string) => !same(v[k], prev[k]);
    this.lastView = v;
    if (!this.styleLoaded) return;

    for (const k of ["minZoom", "maxZoom", "minPitch", "maxPitch"]) {
      if (diff(k) && finite(v[k])) m[`set${k[0].toUpperCase()}${k.slice(1)}`](v[k]);
    }
    if (diff("maxBounds")) m.setMaxBounds(v.maxBounds ?? null);
    if (diff("projection") && v.projection) m.setProjection({ type: v.projection });
    if (diff("terrain")) { try { m.setTerrain(v.terrain ?? null); } catch (e: Any) { this.fail(`terrain : ${e?.message ?? e}`); } }
    if (diff("interactions")) this.applyInteractions(v.interactions || {});
    if (diff("controls")) this.applyControls(v.controls || {});
    if (diff("cursor")) m.getCanvas().style.cursor = v.cursor ?? "";
    if (diff("selectedId")) this.select(v.selectedId ?? null, false);

    const camKeys = ["center", "zoom", "bearing", "pitch", "padding", "bounds", "fit", "mode", "duration", "seq"];
    const camChanged = camKeys.some((k) => diff(k));
    if (!camChanged) return;
    if (finite(v.seq)) this.appliedSeq = v.seq;
    if (v.fit === "points") return this.fitToPoints(v);
    if (v.fit === "selection" && this.selectedId !== null) {
      const p = this.points.find((q) => q.id === this.selectedId);
      if (p) return this.moveTo({ center: [Number(p.lon ?? p.lng), Number(p.lat)], zoom: v.zoom ?? Math.max(m.getZoom(), 11) }, v);
    }
    this.moveTo(v, v);
  }

  private moveTo(target: Any, v: Any) {
    const m = this.map;
    const opts: Any = {};
    if (Array.isArray(target.center)) opts.center = target.center;
    for (const k of ["zoom", "bearing", "pitch"]) if (finite(target[k])) opts[k] = target[k];
    if (target.padding) opts.padding = target.padding;
    // Évite de rejouer une caméra renvoyée par l'état (boucle vue -> état -> vue)
    const c = m.getCenter();
    const sameCam = !target.bounds && sameCamera(opts, { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() });
    if (sameCam && !finite(v.seq)) return;
    if (!Object.keys(opts).length && !target.bounds) return;
    const anim: Any = { duration: finite(v.duration) ? v.duration : 600 };
    const mode = v.mode || "jump";
    this.origin = "data";
    if (target.bounds) {
      m.fitBounds(target.bounds, { padding: target.boundsPadding ?? 40, maxZoom: target.maxZoomOnFit ?? 15, duration: mode === "jump" ? 0 : anim.duration, ...(finite(target.bearing) ? { bearing: target.bearing } : {}), ...(finite(target.pitch) ? { pitch: target.pitch } : {}) });
    } else if (mode === "fly") m.flyTo({ ...opts, duration: anim.duration });
    else if (mode === "ease") m.easeTo({ ...opts, duration: anim.duration });
    else m.jumpTo(opts);
  }

  private applyInteractions(i: Any) {
    const m = this.map;
    const handlers: Record<string, Any> = {
      dragPan: m.dragPan, scrollZoom: m.scrollZoom, boxZoom: m.boxZoom, dragRotate: m.dragRotate,
      keyboard: m.keyboard, doubleClickZoom: m.doubleClickZoom, touchZoomRotate: m.touchZoomRotate, touchPitch: m.touchPitch,
    };
    for (const [k, h] of Object.entries(handlers)) {
      if (k in i && h) i[k] ? h.enable() : h.disable();
    }
  }

  private applyControls(c: Any) {
    const m = this.map;
    const want: Record<string, Any> = {
      navigation: () => new (ml()).NavigationControl({ visualizePitch: true }),
      scale: () => new (ml()).ScaleControl({}),
      attribution: () => new (ml()).AttributionControl({ compact: true }),
    };
    for (const [k, make] of Object.entries(want)) {
      const val = c[k];
      const existing = this.controls.get(k);
      const pos = typeof val === "string" ? val : k === "scale" ? "bottom-left" : k === "attribution" ? "bottom-right" : "top-right";
      if (val && !existing) { const ctl = make(); m.addControl(ctl, pos); this.controls.set(k, ctl); }
      else if (!val && existing) { m.removeControl(existing); this.controls.delete(k); }
    }
  }

  // ---------- Interaction ----------

  private select(id: Any, publish = true) {
    if (this.selectedId === id) return;
    if (this.selectedId !== null) this.setFeatureState(this.selectedId, { selected: false });
    this.selectedId = id;
    if (id !== null) this.setFeatureState(id, { selected: true });
    if (publish) this.emitState(true);
  }

  private setHover(id: Any) {
    if (this.hoverId === id) return;
    if (this.hoverId !== null) this.setFeatureState(this.hoverId, { hover: false });
    this.hoverId = id;
    if (id !== null) this.setFeatureState(id, { hover: true });
    this.map.getCanvas().style.cursor = id !== null ? "pointer" : (this.lastView?.cursor ?? "");
    this.emitState(true);
  }

  private pointAt(e: Any) {
    const layers = [L_POINTS, L_CLUSTERS].filter((l) => this.map.getLayer(l));
    if (!layers.length) return null;
    return this.map.queryRenderedFeatures(e.point, { layers })[0] ?? null;
  }

  private onClick(e: Any) {
    const f = this.pointAt(e);
    const isCluster = f && f.properties && f.properties.point_count;
    this.clickSeq += 1;
    this.lastClick = { seq: this.clickSeq, id: f && !isCluster ? f.properties.id ?? f.id ?? null : null,
      cluster: !!isCluster, count: isCluster ? f.properties.point_count : undefined,
      lngLat: [e.lngLat.lng, e.lngLat.lat] };
    if (this.autoSelect && this.lastClick.id !== null) this.select(this.lastClick.id, false);
    if (this.target && this.lastClick.id !== null) {
      dispatch(this.target, { type: this.pickActionType || "select", payload: { id: this.lastClick.id, lngLat: this.lastClick.lngLat } });
    }
    this.emitState(true);
  }

  private onHover(e: Any) {
    const f = this.pointAt(e);
    this.setHover(f && !(f.properties && f.properties.point_count) ? f.properties.id ?? f.id ?? null : null);
  }

  // ---------- État publié ----------

  private emitState(now: boolean) {
    if (!this.map) return;
    const t = performance.now();
    if (!now && t - this.lastEmit < this.throttleMs) {
      if (!this.emitTimer) this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emitState(true); }, this.throttleMs);
      return;
    }
    this.lastEmit = t;
    const m = this.map;
    let visible: Any[] = [];
    try {
      if (this.styleLoaded && m.getLayer(L_POINTS)) {
        const ids = new Set<Any>();
        for (const f of m.queryRenderedFeatures({ layers: [L_POINTS] })) ids.add(f.properties.id);
        visible = [...ids].slice(0, 2000);
      }
    } catch { /* style en cours de chargement */ }
    const c = m.getCenter(), b = m.getBounds();
    const cv = m.getCanvas();
    this.publish({
      ready: this.ready,
      loaded: this.styleLoaded,
      moving: m.isMoving(),
      origin: this.origin,
      appliedSeq: this.appliedSeq,
      center: [round(c.lng, 6), round(c.lat, 6)],
      zoom: round(m.getZoom(), 3),
      bearing: round(m.getBearing(), 2),
      pitch: round(m.getPitch(), 2),
      bounds: [[round(b.getWest(), 6), round(b.getSouth(), 6)], [round(b.getEast(), 6), round(b.getNorth(), 6)]],
      projection: m.getProjection?.()?.type ?? "mercator",
      size: { w: cv.clientWidth, h: cv.clientHeight },
      pointCount: this.geojson().features.length,
      visibleIds: visible,
      visibleCount: visible.length,
      hover: this.hoverId,
      selected: this.selectedId,
      click: this.lastClick,
      errors: this.errors,
    });
  }
}

