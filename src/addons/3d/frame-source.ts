import { publisherFieldHasListener } from "./publisher-listen";

type OutPublisherLike = {
  _proxies_?: Map<string, { hasListener?: () => boolean }>;
  frameSource?: { set: (v: unknown) => void };
};

export type FrameSourceHost = {
  outPublisher: OutPublisherLike | null;
  bindOutPublisher: () => void;
  ready: boolean;
};

/**
 * Publie `{ element: host }` une fois au ready si un lecteur écoute `frameSource`.
 * Aucun coût pendant l’animation.
 */
function maybePublish(host: FrameSourceHost & Element) {
  if (!host.ready) return;
  if (!host.outPublisher) host.bindOutPublisher();
  const pub = host.outPublisher;
  if (!pub || !publisherFieldHasListener(pub, "frameSource")) return;
  try {
    pub.frameSource?.set({ element: host });
  } catch {
    /* leaf manquant */
  }
}

export const frameSource = { maybePublish } as const;
