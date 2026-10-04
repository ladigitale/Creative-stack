export type PointerHost = {
  mouse: boolean;
  hovering: boolean;
  mouseVec: [number, number, number, number];
  runtime: {
    canvas: HTMLCanvasElement;
    draw: (opts: {
      width: number;
      height: number;
      time: number;
      frame: number;
      mouse: [number, number, number, number];
      params: [number, number, number, number];
    }) => void;
  } | null;
  raf: number;
  ready: boolean;
  startTime: number;
  frame: number;
  param0: number;
  param1: number;
  param2: number;
  param3: number;
  getBoundingClientRect: () => DOMRect;
};

function pointerToMouse(host: PointerHost, e: PointerEvent) {
  if (!host.mouse || !host.runtime) return;
  const rect = host.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  // Même convention que sonic-shader (px drawing buffer, origine bas-gauche)
  const dpr = host.runtime.canvas.width / Math.max(rect.width, 1);
  const x = (e.clientX - rect.left) * dpr;
  const y = (rect.height - (e.clientY - rect.top)) * dpr;
  host.mouseVec[0] = x;
  host.mouseVec[1] = y;
  // Redessine même si la boucle est en pause
  if (!host.raf && host.ready && host.runtime) {
    const time = host.startTime
      ? (performance.now() - host.startTime) / 1000
      : 0;
    host.runtime.draw({
      width: host.runtime.canvas.width,
      height: host.runtime.canvas.height,
      time,
      frame: host.frame,
      mouse: host.mouseVec,
      params: [host.param0, host.param1, host.param2, host.param3],
    });
  }
}

function onMove(host: PointerHost, e: PointerEvent) {
  pointerToMouse(host, e);
}

function onDown(host: PointerHost, e: PointerEvent) {
  pointerToMouse(host, e);
  host.mouseVec[2] = host.mouseVec[0];
  host.mouseVec[3] = host.mouseVec[1];
}

function onUp(host: PointerHost) {
  host.mouseVec[2] = 0;
  host.mouseVec[3] = 0;
}

function onEnter(host: PointerHost) {
  host.hovering = true;
}

function onLeave(host: PointerHost) {
  host.hovering = false;
  host.mouseVec[2] = 0;
  host.mouseVec[3] = 0;
}

export const pointer = {
  pointerToMouse,
  onMove,
  onDown,
  onUp,
  onEnter,
  onLeave,
} as const;
