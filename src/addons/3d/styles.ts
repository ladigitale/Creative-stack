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
