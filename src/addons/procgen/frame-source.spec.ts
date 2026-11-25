import { describe, expect, it } from "vitest";
import { isFrameSource } from "../../shared/mediaRef";
import "./index";

describe("sonic-procgen comme source d'images", () => {
  it("suit le contrat SonicFrameSource (channel0 d'un sonic-shader)", () => {
    const el = document.createElement("sonic-procgen");
    expect(isFrameSource(el)).toBe(true);
    expect((el as unknown as { frameSeq: number }).frameSeq).toBe(0);
    // sans vue (pas encore montée, ou WebGL absent) : pas de toile à relire
    expect((el as unknown as { getFrameCanvas: () => unknown }).getFrameCanvas()).toBeNull();
  });
});
