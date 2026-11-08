/**
 * Clé DP / attribut `monde` de `sonic-3d` : lecture, reconstruction incrémentale (modèles inchangés réutilisés),
 * réapplication des `nodes` après reconstruction, résumé publié dans `out-data-provider` (`monde`).
 */
import { hash32 } from "../../shared/monde/math";
import { mondeSummary, readMonde, type Monde } from "../../shared/monde/format";
import { formFields } from "./form-fields";
import { reload } from "./reload";
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
    return { __error: "attribut monde : JSON invalide" };
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
  const first = !host.mondeParsed && !!parsed;
  host.mondeParsed = parsed;
  if (parsed) publish(host, parsed);
  if (!host.runtime) return;
  const noAsset = !host.glb && !host.src && !host.asset && !("glb" in data) && !("src" in data) && !("asset" in data);
  if (first && noAsset) {
    // la scène affichait le cube de démo : rechargement sur une scène vide
    host.runtime.setMonde(parsed);
    void reload.run(host as never);
    return;
  }
  if (host.runtime.setMonde(parsed)) {
    host.lastNodesJson = "";
    formFields.applyNodes(host as never, data);
    host.runtime.render();
  }
}

export const mondeBind = { sync } as const;
