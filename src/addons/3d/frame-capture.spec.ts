import { describe, expect, it, vi, beforeEach } from "vitest";
import { DEFAULT_SNAPSHOT_INTERVAL_MS } from "./constants";
import { frameCapture, type FrameCaptureHost } from "./frame-capture";

function makeHost(
  overrides: Partial<FrameCaptureHost> = {},
): FrameCaptureHost {
  return {
    outPublisher: null,
    runtime: null,
    snapshotInterval: DEFAULT_SNAPSHOT_INTERVAL_MS,
    frameOut: false,
    snapshotBusy: false,
    lastSnapshotAt: 0,
    frameUrls: [],
    snapshotSeq: 0,
    ...overrides,
  };
}

describe("frameCapture.wantsFrameCapture", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:x") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });

  it("exige un outPublisher", () => {
    expect(
      frameCapture.wantsFrameCapture(makeHost({ frameOut: true })),
    ).toBe(false);
  });

  it("active avec frameOut", () => {
    expect(
      frameCapture.wantsFrameCapture(
        makeHost({ outPublisher: {}, frameOut: true }),
      ),
    ).toBe(true);
  });

  it("active si listener sur frameUrl", () => {
    const proxies = new Map([["frameUrl", { hasListener: () => true }]]);
    expect(
      frameCapture.wantsFrameCapture(
        makeHost({
          outPublisher: { _proxies_: proxies },
          frameOut: false,
        }),
      ),
    ).toBe(true);
  });
});

describe("frameCapture.revokeAll", () => {
  it("révoque les urls et invalide la séquence", () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke as typeof URL.revokeObjectURL;
    const host = makeHost({
      outPublisher: {},
      frameOut: true,
      snapshotBusy: true,
      lastSnapshotAt: 1,
      frameUrls: ["blob:a", "blob:b"],
      snapshotSeq: 3,
    });
    frameCapture.revokeAll(host);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(host.frameUrls).toEqual([]);
    expect(host.snapshotBusy).toBe(false);
    expect(host.snapshotSeq).toBe(4);
  });
});
