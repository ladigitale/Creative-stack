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
  formPublisher: { get?: () => Record<string, unknown> } | null;
  outPublisher: unknown;
  bindOutPublisher: () => void;
  outDataProvider?: string;
  dataProvider?: string;
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
  if (src === host.mondeRef && host.mondeParsed) return;
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

export const mondeBind = { sync, hook } as const;
