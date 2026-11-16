import { css } from "lit";

export const sonic3dStyles = css`
  :host {
    display: block;
    position: relative;
    width: 100%;
    max-width: 100%;
    height: auto;
    aspect-ratio: var(--sonic-3d-ar, 16 / 9);
    overflow: hidden;
    background: #0a0a0a;
    color: #f87171;
    font: 12px/1.4 ui-monospace, monospace;
    touch-action: none;
    cursor: grab;
  }
  :host(:active) {
    cursor: grabbing;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  /* bulle de la sélection : posée au-dessus de l'objet, centrée, au-dessus du canvas */
  .anchor {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 2;
    width: 0;
    height: 0;
    pointer-events: none;
    color: var(--sonic-3d-overlay-color, #1f2328);
    font: var(--sonic-3d-overlay-font, 14px/1.4 system-ui, sans-serif);
    cursor: auto;
  }
  .anchor[hidden] {
    display: none;
  }
  .bubble {
    position: absolute;
    left: 0;
    bottom: 10px;
    transform: translateX(-50%);
    pointer-events: auto;
    white-space: nowrap;
  }
  .err {
    position: absolute;
    inset: 0;
    z-index: 1;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.85);
    white-space: pre-wrap;
    overflow: auto;
    pointer-events: none;
  }
`;
