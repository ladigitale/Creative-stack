/**
 * Rotation de l'objet saisi pendant un glisser : touche R (quart de tour ; Maj+R dans l'autre sens), Q / E (pas de
 * 15°), molette (pas de 15°). Écoute posée au début du glisser, retirée à la fin (fonction rendue).
 */
const QUARTER = Math.PI / 2;
const STEP = Math.PI / 12;

/** `onTurn(delta)` en radians ; `host` reçoit la molette (défilement de la page bloqué pendant le geste). */
export function listenTurn(host: HTMLElement, onTurn: (delta: number) => void): () => void {
  const key = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const d = k === "r" ? (e.shiftKey ? -QUARTER : QUARTER) : k === "q" ? STEP : k === "e" ? -STEP : 0;
    if (!d) return;
    e.preventDefault();
    onTurn(d);
  };
  const wheel = (e: WheelEvent) => {
    if (!e.deltaY) return;
    e.preventDefault();
    e.stopPropagation();
    onTurn(e.deltaY > 0 ? -STEP : STEP);
  };
  window.addEventListener("keydown", key);
  host.addEventListener("wheel", wheel, { passive: false, capture: true });
  return () => {
    window.removeEventListener("keydown", key);
    host.removeEventListener("wheel", wheel, { capture: true });
  };
}

/** Cap ramené à (-π, π]. */
export function wrapAngle(a: number): number {
  const r = Math.atan2(Math.sin(a), Math.cos(a));
  return Math.abs(r) < 1e-9 ? 0 : r;
}
