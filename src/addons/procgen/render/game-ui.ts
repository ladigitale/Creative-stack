/**
 * Commandes tactiles des modes de jeu (course, personnage, combat, football).
 *
 * L'habillage est posé dans la scène de `sonic-procgen`, qui capture chaque appui pour son orbite de caméra
 * (`setPointerCapture` sur la toile) : sans précaution, un bouton reçoit l'appui puis perd le pointeur, et son
 * relâchement part ailleurs (bouton coincé enfoncé, ou relâché aussitôt). `shieldUi` arrête les événements de
 * pointeur à l'habillage ; `holdButton` capture le pointeur sur la commande et la relâche à coup sûr (fin, annulation,
 * perte de capture).
 */

const POINTER_EVENTS = ["pointerdown", "pointermove", "pointerup", "pointercancel", "click", "dblclick", "contextmenu", "wheel", "touchstart", "touchmove", "touchend"] as const;

/** Les appuis sur l'habillage (boutons, stick) ne remontent pas jusqu'à la scène. */
export function shieldUi(ui: HTMLElement) {
  for (const t of POINTER_EVENTS) ui.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
  ui.addEventListener("contextmenu", (e) => e.preventDefault());
}

/**
 * Bouton tenu : `on(true)` à l'appui, `on(false)` au relâchement (doigt levé, geste annulé, capture perdue). Plusieurs
 * doigts sur l'écran : chaque bouton suit son propre pointeur.
 */
export function holdButton(el: HTMLElement, on: (down: boolean) => void) {
  let pid: number | null = null;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pid = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* pointeur déjà relâché */
    }
    on(true);
  });
  const up = (e: PointerEvent) => {
    if (pid === null || e.pointerId !== pid) return;
    pid = null;
    on(false);
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("lostpointercapture", up);
}
