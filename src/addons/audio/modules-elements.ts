/**
 * Balises déclaratives des modules de patch : aucun rendu, aucun nœud WebAudio.
 * Elles ne servent qu'à décrire le patch que `sonic-patch` compile.
 */
import { MODULES, STRUCTURE_TAGS } from "./patch/modules";

export class SonicPatchModule extends HTMLElement {
  connectedCallback(): void {
    this.style.display = "none";
  }
}

export const MODULE_TAGS = [...Object.keys(MODULES), ...STRUCTURE_TAGS];

for (const tag of MODULE_TAGS) {
  if (!customElements.get(tag)) customElements.define(tag, class extends SonicPatchModule {});
}
