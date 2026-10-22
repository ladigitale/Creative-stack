import { dispatch } from "../interactive";
import { TAP_MAX_MOVE_PX, TAP_MAX_MS } from "./constants";
import type { SceneHit } from "./pick";
import type { SceneRuntime } from "./runtime";

export type PointerHost = {
  pointerX: number;
  pointerY: number;
  pick: boolean;
  target: string;
  pickActionType: string;
  pickNames: string;
  pickEmpty: boolean;
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
  if (host.pick && host.runtime?.ready) {
    // Avec `target`, c'est le store qui pilote l'apparence : pas de surlignage bleu.
    host.runtime.setHoverAt(p.x, p.y, host.pickNames, !host.target);
  }
}

function onDown(host: PointerHost, e: PointerEvent) {
  const p = normPointer(host, e);
  host.pointerX = p.x;
  host.pointerY = p.y;
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
function onUp(host: PointerHost, e: PointerEvent) {
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
      payload: { objectId: hit.objectId, x: hit.x, y: hit.y, z: hit.z },
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
