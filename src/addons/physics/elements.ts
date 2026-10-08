/**
 * Balises déclaratives du monde physique : aucun rendu, aucune logique.
 * `sonic-physics` lit leurs attributs (et suit leurs changements).
 */
class SonicPhysicsPart extends HTMLElement {
  connectedCallback(): void {
    this.style.display = "none";
  }
}

export const PHYSICS_PART_TAGS = ["sonic-body", "sonic-joint"];

for (const tag of PHYSICS_PART_TAGS) {
  if (!customElements.get(tag)) customElements.define(tag, class extends SonicPhysicsPart {});
}
