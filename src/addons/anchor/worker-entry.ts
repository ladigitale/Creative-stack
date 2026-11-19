/**
 * Point d'entrée du Web Worker d'ancrage (empaqueté par scripts/build-anchor-worker.mjs dans worker-source.ts).
 * Garde un AnchorEngine (références décodées, suivi en cours) entre deux images.
 * Messages : {type: "refs", list} → {type: "refs", count} ; {type: "frame", id, width, height, data (ArrayBuffer
 * gris), opts} → {type: "frame", id, result} ou {type: "frame", id, error} ; {type: "reset"}.
 */
import { AnchorEngine, type EngineOptions } from "./core/engine";

type Msg =
  | { type: "refs"; list: unknown[] }
  | { type: "reset" }
  | { type: "frame"; id: number; width: number; height: number; data: ArrayBuffer; opts: Partial<EngineOptions> };

const engine = new AnchorEngine();
const scope = self as unknown as { onmessage: ((e: MessageEvent<Msg>) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "refs") { scope.postMessage({ type: "refs", count: engine.setReferences(m.list) }); return; }
  if (m.type === "reset") { engine.reset(); return; }
  try {
    const result = engine.process({ data: new Uint8Array(m.data), width: m.width, height: m.height }, m.opts);
    scope.postMessage({ type: "frame", id: m.id, result });
  } catch (err) {
    scope.postMessage({ type: "frame", id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
