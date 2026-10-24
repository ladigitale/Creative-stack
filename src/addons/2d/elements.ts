/**
 * Balise déclarative d'un sprite : aucun rendu, aucune logique.
 * `sonic-2d` lit ses attributs (et suit leurs changements), comme `sonic-body` pour `sonic-physics`.
 */
class SonicSprite extends HTMLElement {
  connectedCallback(): void {
    this.style.display = "none";
  }
}

if (!customElements.get("sonic-sprite")) customElements.define("sonic-sprite", SonicSprite);
