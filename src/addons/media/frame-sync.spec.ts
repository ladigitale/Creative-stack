import { afterEach, describe, expect, it } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import type { SonicFrameSync } from "./frame-sync";

type FakeSource = HTMLElement & { frameSeq: number; getFrameCanvas: () => HTMLCanvasElement; color: number };

// jsdom n'a pas de canvas 2D : on suit l'identité des copies via un marqueur.
function patchCanvas() {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (t: string) => unknown };
  const orig = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement & { __mark?: number }) {
    return {
      drawImage: (src: HTMLCanvasElement & { __mark?: number }) => {
        this.__mark = src.__mark;
      },
    };
  };
  // La boucle rAF du composant tournerait en parallèle de nos tick() à horloge simulée.
  const origRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
  return () => {
    proto.getContext = orig;
    globalThis.requestAnimationFrame = origRaf;
  };
}

function mountSource(id = "src"): FakeSource {
  const el = document.createElement("div") as unknown as FakeSource;
  el.id = id;
  el.frameSeq = 0;
  el.color = 0;
  const canvas = document.createElement("canvas") as HTMLCanvasElement & { __mark?: number };
  canvas.width = 8;
  canvas.height = 4;
  el.getFrameCanvas = () => {
    canvas.__mark = el.frameSeq;
    return canvas;
  };
  document.body.appendChild(el);
  return el;
}

async function mountSync(attrs: Record<string, string>) {
  const el = document.createElement("sonic-frame-sync") as SonicFrameSync;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const mark = (el: SonicFrameSync) => (el.getFrameCanvas() as (HTMLCanvasElement & { __mark?: number }) | null)?.__mark;

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  document.body.innerHTML = "";
});

describe("sonic-frame-sync", () => {
  it("mode sync : montre l'image annoncée par le tracker, pas la plus récente", async () => {
    restore = patchCanvas();
    const src = mountSource();
    const el = await mountSync({ for: "src", sync: "trk1", "out-data-provider": "fs1" });
    for (let s = 1; s <= 6; s++) {
      src.frameSeq = s;
      el.tick(s * 33);
    }
    PublisherManager.get("trk1").set({ frameSeq: 3, latencyMs: 80 });
    el.tick(7 * 33);
    expect(mark(el)).toBe(3);
    expect(PublisherManager.get("fs1").get()).toMatchObject({ mode: "sync", matched: true, seq: 3, trackerSeq: 3 });
    PublisherManager.get("trk1").set({ frameSeq: 5, latencyMs: 80 });
    el.tick(8 * 33);
    expect(mark(el)).toBe(5);
    expect(el.frameSeq).toBeGreaterThan(0);
  });

  it("mode sync sans publication récente : retombe sur la dernière latence, puis sur le direct", async () => {
    restore = patchCanvas();
    const src = mountSource();
    const el = await mountSync({ for: "src", sync: "trk2", "stale-ms": "50", "out-data-provider": "fs2" });
    const t0 = performance.now();
    for (let s = 1; s <= 10; s++) {
      src.frameSeq = s;
      el.tick(t0 + s * 40);
    }
    PublisherManager.get("trk2").set({ frameSeq: 2, latencyMs: 100 });
    for (let s = 11; s <= 20; s++) {
      src.frameSeq = s;
      el.tick(t0 + 500 + (s - 10) * 40); // le tracker n'a rien publié depuis > stale-ms
    }
    expect(PublisherManager.get("fs2").get()).toMatchObject({ mode: "delay", matched: false });
    expect(mark(el)).toBeLessThan(20); // retard ≈ latence (100 ms), pas la dernière image
    expect(mark(el)).toBeGreaterThan(10);
  });

  it("mode delay : retard fixe en ms", async () => {
    restore = patchCanvas();
    const src = mountSource();
    const el = await mountSync({ for: "src", "delay-ms": "100" });
    for (let s = 1; s <= 10; s++) {
      src.frameSeq = s;
      el.tick(s * 40);
    }
    expect(el.resolveMode()).toBe("delay");
    expect(mark(el)).toBe(7); // 400 - 100 = 300 → dernière image prise à t ≤ 300 : seq 7 (t=280)
  });

  it("mode live : toujours la dernière image ; auto sans réglage = live", async () => {
    restore = patchCanvas();
    const src = mountSource();
    const el = await mountSync({ for: "src" });
    expect(el.resolveMode()).toBe("live");
    for (let s = 1; s <= 4; s++) {
      src.frameSeq = s;
      el.tick(s * 40);
    }
    expect(mark(el)).toBe(4);
  });

  it("garde au plus `history` images", async () => {
    restore = patchCanvas();
    const src = mountSource();
    const el = await mountSync({ for: "src", history: "4", sync: "trk4", "out-data-provider": "fs4" });
    for (let s = 1; s <= 20; s++) {
      src.frameSeq = s;
      el.tick(s * 10);
    }
    PublisherManager.get("trk4").set({ frameSeq: 1, latencyMs: 10 });
    el.tick(210);
    expect(PublisherManager.get("fs4").get()).toMatchObject({ filled: 4, matched: false });
  });

  it("hold : fige la dernière image et frameSeq ; le gel se lève", async () => {
    restore = patchCanvas();
    const src = mountSource();
    const el = await mountSync({ for: "src" });
    for (let s = 1; s <= 3; s++) {
      src.frameSeq = s;
      el.tick(s * 40);
    }
    expect(mark(el)).toBe(3);
    el.setAttribute("hold", "true");
    await el.updateComplete;
    src.frameSeq = 4;
    el.tick(200); // l'image 4 est captée puis figée
    const seq = el.frameSeq;
    expect(mark(el)).toBe(4);
    for (let s = 5; s <= 9; s++) {
      src.frameSeq = s;
      el.tick(200 + s * 40);
    }
    expect(mark(el)).toBe(4);
    expect(el.frameSeq).toBe(seq);
    el.setAttribute("hold", "false");
    await el.updateComplete;
    src.frameSeq = 10;
    el.tick(900);
    expect(mark(el)).toBe(10);
  });

  it("hold par commande : { hold: true } d'un DataProvider prime sur l'attribut", async () => {
    restore = patchCanvas();
    const src = mountSource();
    const el = await mountSync({ for: "src", control: "photoCtl" });
    src.frameSeq = 1;
    el.tick(40);
    PublisherManager.get("photoCtl").set({ hold: true });
    src.frameSeq = 2;
    el.tick(80);
    src.frameSeq = 3;
    el.tick(120);
    expect(el.held).toBe(true);
    expect(mark(el)).toBe(2);
    PublisherManager.get("photoCtl").set({ hold: false });
    src.frameSeq = 4;
    el.tick(160);
    expect(el.held).toBe(false);
    expect(mark(el)).toBe(4);
  });

  it("source par commande : { source: \"#autre\" } remplace for, puis revient à for", async () => {
    restore = patchCanvas();
    const cam = mountSource("cam");
    const photo = mountSource("photo");
    const el = await mountSync({ for: "cam", control: "srcCtl" });
    cam.frameSeq = 1;
    el.tick(40);
    const fromCam = mark(el);
    PublisherManager.get("srcCtl").set({ hold: false, source: "#photo" });
    photo.frameSeq = 7;
    el.tick(80);
    const fromPhoto = mark(el);
    expect(fromCam).toBe(1);
    expect(fromPhoto).toBe(7);
    PublisherManager.get("srcCtl").set({ hold: false, source: "" });
    cam.frameSeq = 2;
    el.tick(120);
    expect(mark(el)).toBe(2);
    PublisherManager.get("srcCtl").set({ source: "<script>" });
    cam.frameSeq = 3;
    el.tick(160);
    expect(mark(el)).toBe(3); // valeur invalide ignorée : on reste sur for
  });

  it("snapshot-provider : publie l'image figée (url blob:) au gel, null à la levée", async () => {
    restore = patchCanvas();
    const proto = HTMLCanvasElement.prototype as unknown as { toBlob: (cb: (b: Blob | null) => void) => void };
    const origToBlob = proto.toBlob;
    proto.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(["x"], { type: "image/png" }));
    };
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    let n = 0;
    URL.createObjectURL = () => `blob:test/${++n}`;
    URL.revokeObjectURL = () => {};
    try {
      const src = mountSource();
      const el = await mountSync({ for: "src", control: "snapCtl", "snapshot-provider": "snap.image" });
      src.frameSeq = 1;
      el.tick(40);
      expect(PublisherManager.get("snap").get()?.image ?? null).toBeNull();
      PublisherManager.get("snapCtl").set({ hold: true });
      src.frameSeq = 2;
      el.tick(80);
      const img = PublisherManager.get("snap").get().image;
      expect(img.url).toBe("blob:test/1");
      expect(img.width).toBe(8);
      expect(img.height).toBe(4);
      el.tick(120); // toujours figé : pas de nouvelle image
      expect(n).toBe(1);
      PublisherManager.get("snapCtl").set({ hold: false });
      src.frameSeq = 3;
      el.tick(160);
      expect(PublisherManager.get("snap").get().image).toBeNull();
    } finally {
      proto.toBlob = origToBlob;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});

