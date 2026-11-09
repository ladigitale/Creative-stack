/**
 * Cohabitation des scènes interactives (sonic-3d, sonic-2d, sonic-procgen) avec le défilement de la page.
 *
 * `gestures` :
 * - `capture` : la scène prend tous les gestes (un doigt tourne / glisse, molette = zoom) — plein écran, jeux ;
 * - `cooperative` : un glissement vertical d'un doigt fait défiler la page, la molette aussi (zoom avec Ctrl / ⌘
 *   ou pincement du pavé tactile) ; glissement horizontal et deux doigts restent à la scène ;
 * - `auto` (défaut) : `cooperative` si la scène est dans une zone qui défile vraiment, sinon `capture`.
 */
export type GestureMode = "auto" | "capture" | "cooperative";

export function gestureMode(v: unknown): GestureMode {
  return v === "capture" || v === "cooperative" ? v : "auto";
}

/** Un ancêtre (ombres traversées) ou la page défile-t-il verticalement ? */
export function inScrollingArea(el: Element): boolean {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return false;
  let n: Node | null = el.parentNode;
  while (n) {
    if (n instanceof ShadowRoot) {
      n = n.host;
      continue;
    }
    if (!(n instanceof Element)) break;
    if (n === document.documentElement || n === document.body) break;
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return true;
    n = n.parentNode;
  }
  const se = document.scrollingElement ?? document.documentElement;
  if (!se) return false;
  const rootOy = getComputedStyle(document.body ?? se).overflowY;
  return rootOy !== "hidden" && se.scrollHeight > window.innerHeight + 1;
}

export function isCooperative(mode: GestureMode, el: Element): boolean {
  return mode === "cooperative" || (mode === "auto" && inScrollingArea(el));
}

/** Applique `touch-action` à l'hôte et aux surfaces tactiles ; renvoie le mode coopératif retenu. */
export function applyGestures(host: HTMLElement, surfaces: (HTMLElement | null | undefined)[], mode: GestureMode): boolean {
  const coop = isCooperative(mode, host);
  const ta = coop ? "pan-y" : "none";
  host.style.touchAction = ta;
  for (const s of surfaces) if (s) s.style.touchAction = ta;
  return coop;
}

/** La molette doit-elle revenir à la page (mode coopératif sans Ctrl / ⌘) ? */
export function wheelToPage(coop: boolean, e: WheelEvent): boolean {
  return coop && !e.ctrlKey && !e.metaKey;
}
