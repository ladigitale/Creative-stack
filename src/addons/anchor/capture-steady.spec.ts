import { describe, expect, it, vi } from "vitest";

vi.mock("./core/rectify", () => ({
  rectify: (frame: { id: number }, zone: { x: number }[]) => ({ url: `data:image/jpeg;base64,${frame.id}`, width: 10, height: 10, mime: "image/jpeg", pad: 1, x0: zone[0].x }),
}));

import "./index";
import type { SonicAnchor } from "./anchor";

type Inner = {
  running: boolean;
  pendingCapture: { t0: number; shots: { frame: unknown; corners: { x: number; y: number }[]; refId: string | null }[] } | null;
  settleCapture(): void;
};
const quad = (dx = 0) => [{ x: 0.2 + dx, y: 0.2 }, { x: 0.8 + dx, y: 0.2 }, { x: 0.8 + dx, y: 0.8 }, { x: 0.2 + dx, y: 0.8 }];

describe("sonic-anchor : prise de vue calée sur l'image mesurée", () => {
  it("attend que la zone soit immobile, puis redresse l'image mesurée avec la médiane des coins", () => {
    const el = document.createElement("sonic-anchor") as SonicAnchor;
    document.body.append(el);
    const inner = el as unknown as Inner;
    inner.running = true;
    el.capture();
    expect(el.stateValue.capture).toBeNull();
    const shots = inner.pendingCapture!.shots;
    shots.push({ frame: { id: 1 }, corners: quad(0.05), refId: "mur" });
    shots.push({ frame: { id: 2 }, corners: quad(0.001), refId: "mur" });
    inner.settleCapture();
    expect(el.stateValue.capture).toBeNull();
    shots.push({ frame: { id: 3 }, corners: quad(0), refId: "mur" });
    shots.push({ frame: { id: 4 }, corners: quad(0.002), refId: "mur" });
    inner.settleCapture();
    const c = el.stateValue.capture as unknown as { url: string; refId: string; steady: boolean; seq: number; x0: number };
    expect(c).toMatchObject({ url: "data:image/jpeg;base64,4", refId: "mur", steady: true, seq: 1 });
    expect(c.x0).toBeCloseTo(0.201, 6);
    expect(inner.pendingCapture).toBeNull();
    el.remove();
  });

  it("au bout de 1,5 s : la dernière mesure, ou une erreur si le mur n'a jamais été vu", () => {
    const el = document.createElement("sonic-anchor") as SonicAnchor;
    document.body.append(el);
    const inner = el as unknown as Inner;
    inner.running = true;
    el.capture();
    inner.pendingCapture!.t0 -= 2000;
    inner.settleCapture();
    expect(el.stateValue.capture).toMatchObject({ error: "vise le mur pour le prendre en photo", seq: 1 });
    el.capture();
    inner.pendingCapture!.shots.push({ frame: { id: 9 }, corners: quad(0.03), refId: "mur" });
    inner.pendingCapture!.t0 -= 2000;
    inner.settleCapture();
    expect(el.stateValue.capture).toMatchObject({ url: "data:image/jpeg;base64,9", steady: false, seq: 2 });
    el.remove();
  });
});
