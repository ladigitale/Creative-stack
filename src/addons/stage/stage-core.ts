/**
 * Application du format `nodes` partagé (src/shared/nodes.ts) à des éléments HTML / SVG.
 * Aucun élément n'est créé ni supprimé ici : c'est le rôle du SDUI (et de sonic-list / sonic-states / sonic-if).
 * Un élément qui apparaît reçoit aussitôt le dernier état de son nœud ; un élément qui disparaît est oublié.
 */
import { NodeStates, type NodeState } from "../../shared/node-state";

export type { NodeState } from "../../shared/node-state";
export type StageLayout = "absolute" | "offset";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const DEG = 180 / Math.PI;

function isSvgChild(el: Element): boolean {
  return typeof SVGElement !== "undefined" && el instanceof SVGElement && el.tagName.toLowerCase() !== "svg";
}

/** Écrit l'état d'un nœud sur un élément. Ne touche qu'aux propriétés que le nœud a reçues. */
export function writeElement(el: Element, st: NodeState, layout: StageLayout): void {
  const hasPos = st.x !== undefined || st.y !== undefined;
  const hasRot = st.rz !== undefined;
  const hasScale = st.sx !== undefined || st.sy !== undefined;
  if (isSvgChild(el)) {
    // SVG : unités du viewBox, le dessin est centré sur son origine (0, 0).
    const parts: string[] = [];
    if (hasPos) parts.push(`translate(${r3(st.x ?? 0)} ${r3(st.y ?? 0)})`);
    if (hasRot) parts.push(`rotate(${r3((st.rz ?? 0) * DEG)})`);
    if (hasScale) parts.push(`scale(${r3(st.sx ?? 1)} ${r3(st.sy ?? 1)})`);
    if (parts.length) el.setAttribute("transform", parts.join(" "));
    if (st.opacity !== undefined) el.setAttribute("opacity", String(r3(st.opacity)));
    if (st.visible !== undefined) el.setAttribute("visibility", st.visible ? "visible" : "hidden");
    if (st.color !== undefined) el.setAttribute("fill", st.color);
    return;
  }
  const style = (el as HTMLElement).style;
  if (!style) return;
  const parts: string[] = [];
  if (layout === "absolute") {
    // Le point (x, y) de la scène est le centre de l'élément (comme un corps physique).
    if (style.position !== "absolute") {
      style.position = "absolute";
      style.left = "0";
      style.top = "0";
    }
    parts.push(`translate(${r3(st.x ?? 0)}px, ${r3(st.y ?? 0)}px)`, "translate(-50%, -50%)");
  } else if (hasPos) {
    // Décalage depuis la place donnée par la mise en page (comme sonic-timeline).
    parts.push(`translate(${r3(st.x ?? 0)}px, ${r3(st.y ?? 0)}px)`);
  }
  if (hasRot) parts.push(`rotate(${r3(st.rz ?? 0)}rad)`);
  if (hasScale) parts.push(`scale(${r3(st.sx ?? 1)}, ${r3(st.sy ?? 1)})`);
  if (parts.length) style.transform = parts.join(" ");
  if (st.opacity !== undefined) style.opacity = String(r3(st.opacity));
  if (st.visible !== undefined) style.visibility = st.visible ? "" : "hidden";
  if (st.z !== undefined) style.zIndex = String(Math.round(st.z));
  if (st.color !== undefined) style.color = st.color;
}

/** Retire ce que writeElement a posé (`$reset`). */
export function clearElement(el: Element): void {
  if (isSvgChild(el)) {
    for (const a of ["transform", "opacity", "visibility", "fill"]) el.removeAttribute(a);
    return;
  }
  const style = (el as HTMLElement).style;
  if (!style) return;
  for (const p of ["transform", "opacity", "visibility", "z-index", "color", "position", "left", "top"]) style.removeProperty(p);
}

export type StageNodesOptions = {
  /** Éléments d'un nœud (recherche dans la scène, mise en cache par l'appelant). */
  resolve: (name: string) => Element[];
  layout?: StageLayout;
};

/** État des nœuds appliqué à des éléments HTML / SVG. `apply` puis `step(now)` tant que `active`. */
export class StageNodes extends NodeStates {
  private touched = new Set<Element>();
  layout: StageLayout;

  constructor(private stageOpts: StageNodesOptions) {
    super({
      render: (name, st) => {
        for (const el of stageOpts.resolve(name)) {
          writeElement(el, st, this.layout);
          this.touched.add(el);
        }
      },
      exists: (name) => stageOpts.resolve(name).length > 0,
      onReset: () => {
        for (const el of this.touched) clearElement(el);
        this.touched.clear();
      },
    });
    this.layout = stageOpts.layout ?? "absolute";
  }

  /** Oublie les éléments retirés du document (liste, états, rendu SDUI refait). */
  prune(): void {
    for (const el of this.touched) if (!el.isConnected) this.touched.delete(el);
  }
}
