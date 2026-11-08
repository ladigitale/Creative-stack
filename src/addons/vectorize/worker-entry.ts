/**
 * Point d'entrée du Web Worker de vectorisation (empaqueté par scripts/build-vectorize-worker.mjs
 * dans worker-source.ts). Reçoit {id, width, height, data (ArrayBuffer RGBA), opts} et renvoie
 * {id, result} ou {id, error}.
 */
import { trace, type TraceOptions } from "./trace";

type Job = { id: number; width: number; height: number; data: ArrayBuffer; opts: TraceOptions };

const scope = self as unknown as { onmessage: ((e: MessageEvent<Job>) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = (e) => {
  const { id, width, height, data, opts } = e.data;
  try {
    const result = trace({ width, height, data: new Uint8ClampedArray(data) }, opts);
    scope.postMessage({ id, result });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
