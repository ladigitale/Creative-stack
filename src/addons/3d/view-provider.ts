import { PublisherManager } from "@supersoniks/concorde/utils";
import { publisherAt } from "../../shared/dp-path";

/**
 * `view-provider` : DataProvider de réglages de vue en direct, `{camera, eyeHeight}` ; `camera` (orbit, yeux, map…)
 * remplace l'attribut du même nom tant qu'il est présent. Permet de passer en vue à hauteur d'yeux depuis un bouton
 * radio sans remonter la scène.
 */
type Pub = ReturnType<typeof PublisherManager.get>;
type Host = { viewProvider: string; camera: string; runtime: { setEyeHeight: (h: number) => void } | null; viewPub?: Pub | null; onViewMutation?: () => void };

function read(host: Host) {
  const v = host.viewPub?.get?.() as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return;
  const cam = typeof v.camera === "string" ? v.camera : String(v.camera?.valueOf?.() ?? "");
  if (cam && cam !== "undefined" && cam !== host.camera) host.camera = cam;
  const h = Number(v.eyeHeight?.valueOf?.() ?? v.eyeHeight);
  if (Number.isFinite(h)) host.runtime?.setEyeHeight(h);
}

function bind(host: Host) {
  unbind(host);
  if (!host.viewProvider) return;
  host.viewPub = publisherAt(host.viewProvider);
  host.onViewMutation = () => read(host);
  host.viewPub.onInternalMutation(host.onViewMutation);
  read(host);
}

function unbind(host: Host) {
  if (host.viewPub && host.onViewMutation) host.viewPub.offInternalMutation(host.onViewMutation);
  host.viewPub = null;
}

export const viewProvider = { bind, unbind, read } as const;
