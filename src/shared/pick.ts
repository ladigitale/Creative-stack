import { isFrameSource } from "./mediaRef";

/**
 * Pipette commune aux toiles (`sonic-sketch`, `sonic-paint`) : la couleur **vue** en un point de l'écran,
 * calques compris. Toutes les sources d'images visibles sous le point (toiles, `sonic-shader`, `sonic-2d`,
 * `sonic-3d`, caméra…) sont lues du dessus vers le dessous (ordre du document : un frère placé après est
 * au-dessus) et composées jusqu'à une couleur opaque. Un calque qui connaît sa couleur exacte (aplat
 * vectoriel) la donne au lieu de son pixel anticrénelé.
 */

/** r, g, b, a de 0 à 255 (non prémultipliés). */
export type Pixel = [number, number, number, number];

/** Une source qui sait lire sa propre couleur sous un point du viewport (repère de l'image, vue, modèle). */
export type PickSource = {
  /** `exact` : couleur du modèle, sans anticrénelage. `null` : rien à dire (on lit alors son canvas). */
  pickAt(clientX: number, clientY: number): { pixel: Pixel; exact?: boolean } | null;
};

const isPickSource = (el: unknown): el is PickSource => !!el && typeof (el as PickSource).pickAt === "function";

let scratch: CanvasRenderingContext2D | null = null;

/** Pixel d'un canvas (2D ou WebGL) en coordonnées de canvas ; null si illisible (origine croisée, contexte perdu). */
export function readCanvasPixel(c: HTMLCanvasElement | OffscreenCanvas, x: number, y: number): Pixel | null {
  if (!(c.width > 0 && c.height > 0) || x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
  try {
    if (!scratch) {
      const s = document.createElement("canvas");
      s.width = s.height = 1;
      scratch = s.getContext("2d", { willReadFrequently: true });
    }
    if (!scratch) return null;
    // drawImage lit aussi un canvas WebGL (au moins juste après son rendu, ou avec preserveDrawingBuffer).
    scratch.clearRect(0, 0, 1, 1);
    scratch.drawImage(c as CanvasImageSource, Math.floor(x), Math.floor(y), 1, 1, 0, 0, 1, 1);
    const d = scratch.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  } catch {
    return null;
  }
}

/** Sources d'images de la page (shadow DOM compris), dans l'ordre du document. */
function frameSources(root: Document | ShadowRoot, out: Element[] = []): Element[] {
  for (const el of root.querySelectorAll("*")) {
    if (isFrameSource(el) || isPickSource(el)) out.push(el);
    if (el.shadowRoot) frameSources(el.shadowRoot, out);
  }
  return out;
}

function visible(el: Element): boolean {
  if (el.hasAttribute("hidden-preview") || el.hasAttribute("hidden")) return false;
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0;
}

const inside = (r: DOMRect, x: number, y: number) => r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;

/** Pixel d'une source sous le point : sa propre lecture si elle en a une, sinon son canvas affiché. */
function layerPixel(el: Element, x: number, y: number): { pixel: Pixel; exact?: boolean } | null {
  if (isPickSource(el)) {
    const p = el.pickAt(x, y);
    if (p) return p;
  }
  if (!isFrameSource(el)) return null;
  const c = el.getFrameCanvas();
  if (!c) return null;
  // Canvas affiché : son propre cadre ; canvas hors page : le cadre de l'élément.
  const r = c.isConnected ? c.getBoundingClientRect() : el.getBoundingClientRect();
  if (!inside(r, x, y)) return null;
  const pixel = readCanvasPixel(c, ((x - r.left) / r.width) * c.width, ((y - r.top) / r.height) * c.height);
  return pixel ? { pixel } : null;
}

/**
 * Couleur vue au point (coordonnées du viewport), #rrggbb, calques compris. Ce qui reste transparent tout
 * en bas est pris sur blanc. `null` : aucune source lisible sous le point.
 */
export function pickColorAt(clientX: number, clientY: number, root: Document = document): string | null {
  const layers = frameSources(root).filter((el) => inside(el.getBoundingClientRect(), clientX, clientY) && visible(el)).reverse();
  // Accumulation « sous » (du dessus vers le dessous), en prémultiplié.
  let r = 0, g = 0, b = 0, a = 0, seen = false;
  for (const el of layers) {
    const got = layerPixel(el, clientX, clientY);
    if (!got) continue;
    seen = true;
    const [pr, pg, pb, pa] = got.pixel;
    const al = pa / 255;
    if (a === 0 && got.exact && al >= 0.999) return hex(pr, pg, pb);
    const k = (1 - a) * al;
    r += k * pr; g += k * pg; b += k * pb; a += k;
    if (a >= 0.999) break;
  }
  if (!seen) return null;
  const rest = (1 - a) * 255;
  return hex(r + rest, g + rest, b + rest);
}

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
