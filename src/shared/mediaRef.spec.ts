import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  attachMediaUrls,
  cloneMediaRef,
  isFrameSource,
  isMediaBlobObject,
  mediaElementKey,
  registerLiveElement,
  revokeMediaUrls,
  toMediaUrl,
} from "./mediaRef";

describe("toMediaUrl", () => {
  it("accepte string / url / blobUrl", () => {
    expect(toMediaUrl(" https://x/a.png ")).toBe("https://x/a.png");
    expect(toMediaUrl({ url: "blob:abc" })).toBe("blob:abc");
    expect(toMediaUrl({ blobUrl: "blob:xyz" })).toBe("blob:xyz");
    expect(toMediaUrl(null)).toBeNull();
    expect(toMediaUrl({ blob: new Blob() })).toBeNull();
  });

  it("ignore element (pas d’URL)", () => {
    expect(toMediaUrl({ element: "#plateau" })).toBeNull();
  });
});

describe("isFrameSource / mediaElementKey", () => {
  it("détecte SonicFrameSource", () => {
    expect(
      isFrameSource({
        getFrameCanvas: () => null,
        frameSeq: 0,
      }),
    ).toBe(true);
    expect(isFrameSource({})).toBe(false);
    expect(isFrameSource(null)).toBe(false);
  });

  it("FrameConsumerRegistry register / unregister", async () => {
    const { FrameConsumerRegistry, isFrameConsumerHost } = await import(
      "./mediaRef"
    );
    const tokens: object[] = [];
    const host = {
      registerFrameConsumer(t: object = {}) {
        tokens.push(t);
      },
      unregisterFrameConsumer(t: object = {}) {
        const i = tokens.indexOf(t);
        if (i >= 0) tokens.splice(i, 1);
      },
      getFrameCanvas: () => null,
      frameSeq: 0,
    };
    expect(isFrameConsumerHost(host)).toBe(true);
    const reg = new FrameConsumerRegistry();
    // FrameConsumerRegistry expects Element — cast for unit test
    reg.sync([host as unknown as Element]);
    expect(tokens.length).toBe(1);
    reg.clear();
    expect(tokens.length).toBe(0);
  });

  it("normalise element string / Element avec id", () => {
    expect(mediaElementKey("#plateau")).toBe("#plateau");
    expect(mediaElementKey("plateau")).toBe("#plateau");
    expect(mediaElementKey("")).toBeNull();
    const el = document.createElement("div");
    el.id = "scene";
    expect(mediaElementKey(el)).toBe("#scene");
  });

  it("enregistre un Element sans id", () => {
    const el = document.createElement("div");
    const key = registerLiveElement(el);
    expect(key.startsWith("#__sonic_frame_")).toBe(true);
    expect(mediaElementKey(el)).toBe(key);
  });
});

describe("attachMediaUrls / revokeMediaUrls", () => {
  const createSpy = vi.fn(() => "blob:mock-1");
  const revokeSpy = vi.fn();

  beforeEach(() => {
    createSpy.mockClear();
    revokeSpy.mockClear();
    URL.createObjectURL = createSpy as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeSpy as typeof URL.revokeObjectURL;
  });

  it("ajoute url sur les images Blob et collectes les ObjectURL", () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const depth: {
      width: number;
      height: number;
      channels: number;
      blob: Blob;
      url?: string;
    } = { width: 2, height: 2, channels: 1, blob };
    const tree = { depth, other: 1 };
    const created: string[] = [];
    attachMediaUrls(tree, created);
    expect(depth.url).toBe("blob:mock-1");
    expect(created).toEqual(["blob:mock-1"]);
    expect(isMediaBlobObject(depth)).toBe(true);
    expect(createSpy).toHaveBeenCalledOnce();
  });

  it("conserve une url déjà présente (pas de nouvel ObjectURL)", () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const depth = {
      width: 2,
      height: 2,
      blob,
      url: "https://cdn.example/depth.png",
    };
    const created: string[] = [];
    attachMediaUrls(depth, created);
    expect(depth.url).toBe("https://cdn.example/depth.png");
    expect(created).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("appelle revokeObjectURL", () => {
    revokeMediaUrls(["blob:a", "blob:b"]);
    expect(revokeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("cloneMediaRef", () => {
  it("recrée un ObjectURL depuis un blob", async () => {
    URL.createObjectURL = vi.fn(
      () => "blob:cloned",
    ) as typeof URL.createObjectURL;
    const blob = new Blob([new Uint8Array([1, 2])], { type: "image/jpeg" });
    const out = await cloneMediaRef({
      url: "blob:old",
      blob,
      width: 2,
      height: 2,
    });
    expect(out?.url).toBe("blob:cloned");
    expect(out?.blob).toBe(blob);
  });
});
