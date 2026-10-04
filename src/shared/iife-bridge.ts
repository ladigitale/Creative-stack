/**
 * Passerelle des bundles autonomes (IIFE) vers une page qui a déjà chargé Concorde core.
 *
 * Un bundle IIFE embarque sa propre copie de Concorde. Sans cette passerelle :
 *  - ses DataProviders seraient isolés de ceux de la page (PublisherManager distinct) ;
 *  - la redéfinition des composants Concorde qu'il embarque lèverait une erreur.
 *
 * Concorde core publie sa classe PublisherManager sur `window.SonicPublisherManager`
 * mais ne la relit pas : on branche ici la copie embarquée sur l'instance partagée.
 * Temporaire, en attendant que Concorde core expose son API en global.
 */
import { PublisherManager } from "@supersoniks/concorde/core/utils/PublisherProxy";

type ManagerClass = { getInstance(): unknown; instance: unknown };

if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  const shared = w.SonicPublisherManager as ManagerClass | undefined;
  const local = PublisherManager as unknown as ManagerClass;
  if (shared && shared !== local) local.instance = shared.getInstance();

  if (!w.__creativeStackDefineGuard && typeof customElements !== "undefined") {
    w.__creativeStackDefineGuard = true;
    const define = customElements.define.bind(customElements);
    customElements.define = (name, ctor, options) => {
      if (customElements.get(name)) return; // déjà fourni par Concorde core ou un autre bundle
      define(name, ctor, options);
    };
  }
}
