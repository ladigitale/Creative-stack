import { dispatch } from "../interactive";
import { listenTurn, wrapAngle } from "../../shared/monde/turn-keys";
import { TAP_MAX_MOVE_PX, TAP_MAX_MS } from "./constants";
import type { SceneHit } from "./pick";
import type { SceneRuntime } from "./runtime";

/** Distance (px) au-delà de laquelle un appui sur un objet devient un glisser. */
const DRAG_START_PX = 4;

export type PointerHost = {
  pointerX: number;
  pointerY: number;
  pick: boolean;
  target: string;
  pickActionType: string;
  pickNames: string;
  pickEmpty: boolean;
  drag?: string;
  dragSelected?: boolean;
  keepHeading?: boolean;
  /** Instance sélectionnée (clé `selection` du DataProvider). */
  selectedName?: string;
  dragging?: { name: string; last: unknown; id: number; x: number; y: number; cx: number; cy: number; ry: number | undefined; stop: () => void } | null;
  setPointerCapture?: (id: number) => void;
  releasePointerCapture?: (id: number) => void;
  tapStart: { x: number; y: number; t: number } | null;
  runtime: SceneRuntime | null;
  lastHit: SceneHit | null;
  hovering: boolean;
  getBoundingClientRect: () => DOMRect;
  dispatchEvent: (event: Event) => boolean;
  syncPlayback: () => void;
};

function normPointer(
  host: PointerHost,
  e: PointerEvent,
): { x: number; y: number } {
  const rect = host.getBoundingClientRect();
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);
  return {
    x: (e.clientX - rect.left) / w,
    y: (e.clientY - rect.top) / h,
  };
}

function onMove(host: PointerHost, e: PointerEvent) {
  const p = normPointer(host, e);
  host.pointerX = p.x;
  host.pointerY = p.y;
  if (host.dragging && host.runtime) {
    // un tap qui tremble n'est pas un glisser : l'objet ne part qu'au-delà de quelques pixels
    if (!host.dragging.last && Math.hypot(e.clientX - host.dragging.cx, e.clientY - host.dragging.cy) < DRAG_START_PX) return;
    host.dragging.x = p.x;
    host.dragging.y = p.y;
    const res = host.runtime.dragMove(host.dragging.name, p.x, p.y, host.dragging.ry);
    if (res) host.dragging.last = res;
    return;
  }
  if (host.pick && host.runtime?.ready) {
    // Avec `target`, c'est le store qui pilote l'apparence : pas de surlignage bleu.
    host.runtime.setHoverAt(p.x, p.y, host.pickNames, !host.target);
  }
}

function onDown(host: PointerHost, e: PointerEvent) {
  const p = normPointer(host, e);
  host.pointerX = p.x;
  host.pointerY = p.y;
  if (host.drag && host.runtime?.ready && e.button === 0 && (!host.dragSelected || host.selectedName)) {
    // drag-selected : seul l'objet sélectionné se saisit (et il doit aussi passer le filtre `drag`)
    const only = host.dragSelected ? `^${(host.selectedName ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : host.drag;
    // l'objet sous le doigt doit être le sélectionné lui-même (pas un autre meuble devant lui)
    const front = host.dragSelected ? host.runtime.worldInstanceAt(p.x, p.y) : "";
    let name = !host.dragSelected || front === host.selectedName ? host.runtime.dragStart(p.x, p.y, only) : "";
    if (name && host.dragSelected && !matches(host.drag, name)) {
      host.runtime.dragEnd(name, false);
      name = "";
    }
    if (name) {
      const drag = { name, last: null as unknown, id: e.pointerId, x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, ry: (host.keepHeading ? host.runtime.headingOf(name) : undefined) as number | undefined, stop: () => {} };
      // R, Q / E, molette : tourner l'objet saisi
      drag.stop = listenTurn(host as unknown as HTMLElement, (d) => {
        const rt = host.runtime;
        if (!rt) return;
        drag.ry = wrapAngle((drag.ry ?? rt.headingOf(name)) + d);
        const res = rt.dragMove(name, drag.x, drag.y, drag.ry);
        if (res) drag.last = res;
      });
      host.dragging = drag;
      // l'orbite ne démarre pas : l'objet suit le pointeur
      e.stopPropagation();
      try {
        host.setPointerCapture?.(e.pointerId);
      } catch {
        /* pointeur déjà relâché */
      }
    }
  }
  if (!host.pick || !host.runtime) return;
  if (e.button !== 0) return;
  host.tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
  const hit = host.runtime.pick(p.x, p.y, host.pickNames);
  host.lastHit = hit;
  if (!hit) return;
  host.dispatchEvent(
    new CustomEvent("pick", {
      detail: hit,
      bubbles: true,
      composed: true,
    }),
  );
}

/**
 * Tap (déplacement < 6 px, durée < 400 ms) → action vers `target`.
 * Un drag d'orbite n'envoie rien.
 */
/** `name` passe la regex `re` (regex invalide : non). */
function matches(re: string, name: string): boolean {
  try {
    return new RegExp(re).test(name);
  } catch {
    return false;
  }
}

/** Tap sur un `monde` : l'objet déplaçable touché (`instance`) et le rang de son entrée (`src`). */
function worldOf(host: PointerHost, x: number, y: number): { instance?: string; src?: number } {
  const rt = host.runtime;
  if (!rt) return {};
  const instance = rt.worldInstanceAt?.(x, y) ?? "";
  return instance ? { instance, src: rt.worldSrcOf?.(instance) ?? -1 } : {};
}

function onUp(host: PointerHost, e: PointerEvent) {
  const drag = host.dragging;
  if (drag) {
    host.dragging = null;
    drag.stop();
    host.runtime?.dragEnd(drag.name, !!drag.last);
    try {
      host.releasePointerCapture?.(drag.id);
    } catch {
      /* rien à relâcher */
    }
    // un simple tap sur l'objet reste un tap ; un vrai glisser se conclut par l'action « place »
    if (drag.last) {
      if (host.target) dispatch(host.target, { type: "place", payload: drag.last });
      host.dispatchEvent(new CustomEvent("place", { detail: drag.last, bubbles: true, composed: true }));
      host.tapStart = null;
      return;
    }
  }
  const start = host.tapStart;
  host.tapStart = null;
  if (!start || e.button !== 0) return;
  if (!host.pick || !host.target || !host.runtime?.ready) return;
  const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
  if (moved >= TAP_MAX_MOVE_PX || performance.now() - start.t >= TAP_MAX_MS) {
    return;
  }
  const p = normPointer(host, e);
  // `pick-names` filtre le raycast : les nœuds décoratifs (table, reflets…) sont transparents au tap.
  const hit = host.runtime.pick(p.x, p.y, host.pickNames);
  const type = host.pickActionType || "pick";
  if (hit) {
    dispatch(host.target, {
      type,
      payload: { objectId: hit.objectId, x: hit.x, y: hit.y, z: hit.z, ...worldOf(host, p.x, p.y) },
    });
  } else if (host.pickEmpty) {
    dispatch(host.target, { type, payload: { objectId: null } });
  }
}

function onDblClick(host: PointerHost) {
  if (!host.runtime?.ready) return;
  host.runtime.fitToContent();
  host.runtime.render();
}

function onEnter(host: PointerHost) {
  host.hovering = true;
  host.syncPlayback();
}

function onLeave(host: PointerHost) {
  host.hovering = false;
  host.runtime?.clearHighlight();
  host.syncPlayback();
}

export const pointer = {
  onMove,
  onDown,
  onUp,
  onDblClick,
  onEnter,
  onLeave,
} as const;
