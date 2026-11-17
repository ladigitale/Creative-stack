/**
 * Clé DP / attribut `monde` de `sonic-3d` : lecture, reconstruction incrémentale (modèles inchangés réutilisés),
 * réapplication des `nodes` après reconstruction, résumé publié dans `out-data-provider` (`monde`).
 */
import { hash32 } from "../../shared/monde/math";
import { mondeSummary, readMonde, type Monde } from "../../shared/monde/format";
import { formFields } from "./form-fields";
import { reload } from "./reload";
import { asset } from "./asset";
import type { SceneRuntime } from "./runtime";
import { dispatch } from "../interactive";

export type MondeHost = {
  monde: string;
  glb: string;
  src: string;
  asset: unknown;
  runtime: SceneRuntime | null;
  mondeRef: unknown;
  mondeSig: string;
  mondeParsed: Monde | null;
  lastNodesJson: string;
  raf: number;
  mondeRemeasure?: ReturnType<typeof setTimeout> | 0;
  /** Instance sélectionnée (clé `selection`). */
  selectedName?: string;
  formPublisher: { get?: () => Record<string, unknown> } | null;
  outPublisher: unknown;
  bindOutPublisher: () => void;
  outDataProvider?: string;
  dataProvider?: string;
  /** Store qui reçoit les événements du monde (`hit`, `expire`). */
  target?: string;
  dispatchEvent?: (e: Event) => boolean;
  /** Derniers ordres `emit` appliqués (idempotence). */
  lastEmitJson?: string;
  lastFxJson?: string;
  lastQueriesJson?: string;
  queriesOut?: Record<string, unknown>;
};

function sourceOf(host: MondeHost, data: Record<string, unknown>): unknown {
  if ("monde" in data && data.monde) return data.monde;
  const attr = host.monde?.trim();
  if (!attr) return null;
  try {
    return JSON.parse(attr);
  } catch {
    return { invalide: attr.length };
  }
}

function publish(host: MondeHost, m: Monde) {
  // jamais dans le DP lu (la clé `monde` y est l'entrée) : seulement un out-data-provider distinct
  const out = host.outDataProvider?.trim();
  if (!out || out === host.dataProvider?.trim()) return;
  if (!host.outPublisher) host.bindOutPublisher();
  const pub = host.outPublisher as Record<string, { set: (v: unknown) => void }> | null;
  try {
    pub?.mondeInfo?.set(mondeSummary(m));
  } catch {
    /* pas de DP de sortie */
  }
}

/** Branche sur le runtime courant ce que le monde signale après coup (appelé à chaque création de runtime). */
function hook(host: MondeHost) {
  if (!host.runtime) return;
  host.runtime.monde.select(host.selectedName ?? "");
  // résultat d'un rangement demandé par nodes.<instance>.move : publié dans la sortie (clé `placed`)
  host.runtime.monde.onPlaced = (info) => {
    const out = host.outDataProvider?.trim();
    if (!out || out === host.dataProvider?.trim()) return;
    if (!host.outPublisher) host.bindOutPublisher();
    try {
      (host.outPublisher as Record<string, { set: (v: unknown) => void }> | null)?.placed?.set(info);
    } catch {
      /* pas de DP de sortie */
    }
  };
  // déplacement en jeu gêné par un obstacle (`collide`) : clé de sortie `contact`
  host.runtime.monde.onContact = (c) => {
    const out = host.outDataProvider?.trim();
    if (!out || out === host.dataProvider?.trim()) return;
    if (!host.outPublisher) host.bindOutPublisher();
    try {
      (host.outPublisher as Record<string, { set: (v: unknown) => void }> | null)?.contact?.set({ ...c, t: Date.now() });
    } catch {
      /* pas de DP de sortie */
    }
  };
  const outKey = (key: string, v: unknown) => {
    const out = host.outDataProvider?.trim();
    if (!out || out === host.dataProvider?.trim()) return;
    if (!host.outPublisher) host.bindOutPublisher();
    try {
      (host.outPublisher as Record<string, { set: (v: unknown) => void }> | null)?.[key]?.set(v);
    } catch {
      /* pas de DP de sortie */
    }
  };
  // émetteurs : touches regroupées par image vers `target` (et la sortie `hits`), état 10 fois par seconde
  host.runtime.monde.onHits = (hits) => {
    const payload = { hits: hits.slice(0, 64), t: Date.now() };
    if (host.target) dispatch(host.target, { type: "hit", payload });
    host.dispatchEvent?.(new CustomEvent("monde-hit", { detail: payload, bubbles: true, composed: true }));
    outKey("hits", payload);
  };
  host.runtime.monde.onExpire = (e) => {
    if (host.target) dispatch(host.target, { type: "expire", payload: e });
  };
  host.runtime.monde.onEmitStats = (stats) => outKey("emitters", stats);
  // requêtes : réponses rangées par identifiant dans la sortie `queries` ; capteurs : `enter` / `leave` vers target
  host.runtime.monde.onQueries = (r) => {
    host.queriesOut = { ...(host.queriesOut ?? {}), ...r };
    outKey("queries", host.queriesOut);
  };
  host.runtime.monde.onSensor = (e) => {
    const { type, ...payload } = e;
    if (host.target) dispatch(host.target, { type, payload });
    host.dispatchEvent?.(new CustomEvent(`monde-${type}`, { detail: payload, bubbles: true, composed: true }));
  };
  // conflits recalculés après un rangement : le résumé publié suit la scène
  host.runtime.monde.onConflicts = (conflicts) => {
    if (!host.mondeParsed) return;
    const out = host.outDataProvider?.trim();
    if (!out || out === host.dataProvider?.trim()) return;
    if (!host.outPublisher) host.bindOutPublisher();
    const sum = mondeSummary(host.mondeParsed) as Record<string, unknown>;
    delete sum.conflicts;
    if (conflicts.length) sum.conflicts = conflicts.slice(0, 50);
    try {
      (host.outPublisher as Record<string, { set: (v: unknown) => void }> | null)?.mondeInfo?.set(sum);
    } catch {
      /* pas de DP de sortie */
    }
  };
  // un modèle procgen mesuré après coup : le monde est relu une fois (objets posés à leur vraie taille, collisions)
  host.runtime.monde.onMeasured = () => {
    if (host.mondeRemeasure) return;
    host.mondeRemeasure = setTimeout(() => {
      host.mondeRemeasure = 0;
      if (!host.runtime || !host.mondeRef) return;
      const again = readMonde(host.mondeRef, host.mondeParsed);
      host.mondeParsed = again;
      publish(host, again);
      if (host.runtime.setMonde(again)) {
        host.lastNodesJson = "";
        formFields.applyNodes(host as never, (host.formPublisher?.get?.() ?? {}) as Record<string, unknown>);
        host.runtime.render();
      }
    }, 120);
  };
}

/** À appeler à chaque mutation du DP et quand l'attribut `monde` change. */
function sync(host: MondeHost, data: Record<string, unknown>) {
  const src = sourceOf(host, data);
  // pas de court-circuit sur la référence : une écriture imbriquée (`<dp>.monde.espace`) modifie l'objet en place,
  // seule la signature dit si le monde a changé
  host.mondeRef = src;
  // la vue 2D ne change rien à la scène 3D : pas de reconstruction pour elle
  const sig = src ? String(hash32(JSON.stringify(src, (k, v) => (k === "view2d" ? undefined : v)))) : "";
  if (sig === host.mondeSig) return;
  host.mondeSig = sig;
  const parsed = src ? readMonde(src, host.mondeParsed) : null;
  if (parsed && src && typeof src === "object" && "invalide" in src) parsed.issues.push({ path: "", message: "attribut monde : JSON invalide" });
  const first = !host.mondeParsed && !!parsed;
  host.mondeParsed = parsed;
  if (parsed) publish(host, parsed);
  if (!host.runtime) return;
  hook(host);
  if (first && asset.resolve(host as never, host.formPublisher as never)?.empty) {
    // la scène affichait le cube de démo : rechargement sur une scène vide, le monde y est monté une seule fois
    host.runtime.stageMonde(parsed);
    void reload.run(host as never);
    return;
  }
  if (host.runtime.setMonde(parsed)) {
    host.lastNodesJson = "";
    formFields.applyNodes(host as never, data);
    host.runtime.render();
  }
}

/** Clé `selection` du DataProvider : instance sélectionnée (contour, seule déplaçable avec `drag-selected`). */
function select(host: MondeHost, data: Record<string, unknown>) {
  const raw = data.selection;
  // valeur brute ou proxy Concorde d'une chaîne
  const v = raw != null && typeof raw === "object" ? (raw as { valueOf: () => unknown }).valueOf() : raw;
  const name = typeof v === "string" ? v : "";
  if (name === host.selectedName) return;
  host.selectedName = name;
  host.runtime?.monde.select(name);
  host.runtime?.render();
}

/**
 * Clé `emit` du DataProvider : `{<émetteur>: {n, count, at, dir, toward, clear, kill: {n, ids}}}`. Chaque hausse
 * de `n` tire une salve ; la première lecture ne fait que mémoriser les compteurs.
 */
function emit(host: MondeHost, data: Record<string, unknown>) {
  if (!("emit" in data) || !host.runtime?.ready) return;
  let json: string;
  try {
    json = JSON.stringify(data.emit);
  } catch {
    return;
  }
  if (!json || json === host.lastEmitJson) return;
  host.lastEmitJson = json;
  if (host.runtime.monde.applyEmit(JSON.parse(json))) host.runtime.render();
}

/** Clé `fx` du DataProvider : `{<système>: {n, at, scale, color, count}}`, une salve à chaque hausse de `n`. */
function fx(host: MondeHost, data: Record<string, unknown>) {
  if (!("fx" in data) || !host.runtime?.ready) return;
  let json: string;
  try {
    json = JSON.stringify(data.fx);
  } catch {
    return;
  }
  if (!json || json === host.lastFxJson) return;
  host.lastFxJson = json;
  if (host.runtime.monde.applyParticles(JSON.parse(json))) host.runtime.render();
}

/** Clé `queries` du DataProvider : `{<id>: {n, ray | sphere | box, mask, ignore, live}}` (voir shared/sim/queries.ts). */
function queries(host: MondeHost, data: Record<string, unknown>) {
  if (!("queries" in data) || !host.runtime?.ready) return;
  let json: string;
  try {
    json = JSON.stringify(data.queries);
  } catch {
    return;
  }
  if (!json || json === host.lastQueriesJson) return;
  host.lastQueriesJson = json;
  host.runtime.monde.applyQueries(JSON.parse(json));
}

export const mondeBind = { sync, hook, select, emit, fx, queries } as const;
