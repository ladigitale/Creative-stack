import type { SceneHit } from "./pick";
import type { SceneRuntime } from "./runtime";

export type PointerHost = {
  pointerX: number;
  pointerY: number;
  pick: boolean;
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
    host.runtime.setHoverAt(p.x, p.y);
  }
}

function onDown(host: PointerHost, e: PointerEvent) {
  const p = normPointer(host, e);
  host.pointerX = p.x;
  host.pointerY = p.y;
  if (!host.pick || !host.runtime) return;
  if (e.button !== 0) return;
  const hit = host.runtime.pick(p.x, p.y);
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
  onDblClick,
  onEnter,
  onLeave,
} as const;
