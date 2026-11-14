import { afterEach, describe, expect, it, vi } from "vitest";
import { LayerWorker } from "./layer-worker";
import type { Stroke } from "./model";

const posted: { type: string; rev?: number; strokes?: Stroke[]; id?: number }[] = [];
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(m: { type: string }) { posted.push(m); }
  terminate() {}
}
const st = (id: number): Stroke => ({ id, brush: {} as Stroke["brush"], pts: [], seed: id, bbox: { x: 0, y: 0, w: 1, h: 1 } });
const view = { x: 0, y: 0, zoom: 1, rotation: 0 };

describe("LayerWorker", () => {
  afterEach(() => { vi.unstubAllGlobals(); posted.length = 0; });
  const make = () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    return new LayerWorker(() => {});
  };

  it("envoie la liste entière, puis seulement les traits ajoutés au-dessus", () => {
    const w = make();
    const a = [st(1), st(2)];
    expect(w.request(a, view, 10, 10, 1, null)).toBe(true);
    expect(posted.map((m) => m.type)).toEqual(["set", "render"]);
    const b = [...a, st(3)];
    w.request(b, view, 10, 10, 1, null);
    expect(posted[2]).toMatchObject({ type: "append" });
    expect(posted[2].strokes!.map((s) => s.id)).toEqual([3]);
    expect(w.state(b)).toEqual({ rev: posted[0].rev, len: 3 });
  });

  it("renvoie tout (nouvelle révision) quand un trait est retiré ou remplacé", () => {
    const w = make();
    const a = [st(1), st(2), st(3)];
    w.request(a, view, 10, 10, 1, null);
    const rev0 = posted[0].rev!;
    expect(w.state([a[0], a[1]])).toBeNull();
    w.request([a[0], a[1]], view, 10, 10, 1, null);
    const set = posted.filter((m) => m.type === "set");
    expect(set).toHaveLength(2);
    expect(set[1].rev).toBeGreaterThan(rev0);
  });

  it("ne renvoie pas une demande identique déjà en cours", () => {
    const w = make();
    const a = [st(1)];
    w.request(a, view, 10, 10, 1, null);
    w.request(a, { ...view }, 10, 10, 1, null);
    expect(posted.filter((m) => m.type === "render")).toHaveLength(1);
    w.request(a, { ...view, zoom: 2 }, 10, 10, 1, null);
    expect(posted.filter((m) => m.type === "render")).toHaveLength(2);
  });

  it("se désactive sans Worker ni OffscreenCanvas", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const w = new LayerWorker(() => {});
    expect(w.ok).toBe(false);
    expect(w.request([st(1)], view, 10, 10, 1, null)).toBe(false);
  });
});
