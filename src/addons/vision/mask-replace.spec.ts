import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicMaskReplace } from "./mask-replace";

void SonicMaskReplace;

type Call = [string, ...unknown[]];
const log = new Map<HTMLCanvasElement, Call[]>();
const sizeOf = (c: HTMLCanvasElement) => `${c.width}x${c.height}`;

function fakeCtx(canvas: HTMLCanvasElement) {
  const calls: Call[] = [];
  log.set(canvas, calls);
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key === "getImageData")
        return (x: number, y: number, w: number, h: number) => {
          calls.push(["getImageData", w, h]);
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 100, (data[i + 3] = 255);
          return { data, width: w, height: h };
        };
      return (...a: unknown[]) => void calls.push([key, ...a.map((v) => (v instanceof HTMLCanvasElement ? `canvas:${sizeOf(v)}` : v))]);
    },
    set(t, key: string, v) {
      t[key] = v;
      calls.push([`set:${key}`, v]);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const ctxs = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
beforeEach(() => {
  log.clear();
  ctxs.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let c = ctxs.get(this);
    if (!c) {
      c = fakeCtx(this);
      ctxs.set(this, c);
    }
    return c as never;
  } as never);
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const names = (c: HTMLCanvasElement) => (log.get(c) ?? []).map((x) => x[0]);
const callsOf = (c: HTMLCanvasElement, n: string) => (log.get(c) ?? []).filter((x) => x[0] === n);

type Src = HTMLElement & { getFrameCanvas?: () => HTMLCanvasElement | null; getFrameSource?: () => unknown; mode?: string };
function addCanvasSource(id: string, w = 640, h = 480, extra: Partial<Src> = {}) {
  const el = document.createElement("div") as Src;
  el.id = id;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  el.getFrameCanvas = () => c;
  Object.assign(el, extra);
  document.body.appendChild(el);
  return { el, canvas: c };
}
function addVideoSource(id: string, w = 640, h = 480) {
  const el = document.createElement("div") as Src;
  el.id = id;
  el.getFrameSource = () => ({ readyState: 4, videoWidth: w, videoHeight: h });
  document.body.appendChild(el);
  return el;
}

async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-mask-replace") as SonicMaskReplace;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  const canvas = el.shadowRoot!.querySelector("canvas") as HTMLCanvasElement;
  return { el, canvas };
}

describe("sonic-mask-replace", () => {
  it("sans source d'images : rien n'est dessiné, état non prêt", async () => {
    const { el } = await mount({ source: "absent", mask: "seg", "out-data-provider": "mr0" });
    expect(el.draw()).toBe(false);
    expect((dp("mr0") as { get?: () => unknown }).get?.() ?? null).toMatchObject({ ready: false });
    expect(el.getFrameCanvas()).toBeNull();
  });

  it("source sans masque configuré ni encore produit : l'image passe telle quelle", async () => {
    addCanvasSource("cam");
    addCanvasSource("seg0", 0, 0); // masque sans image
    const { el, canvas } = await mount({ source: "cam", mask: "seg0" });
    expect(el.draw()).toBe(true);
    expect(callsOf(canvas, "fillRect")).toHaveLength(0);
    expect(callsOf(canvas, "drawImage")).toHaveLength(1);
    expect(el.getFrameCanvas()).toBe(canvas);
    expect(el.frameSeq).toBe(1);
  });

  it("fond remplacé par une couleur : couche gardée = image ∩ masque (destination-in), puis dessinée sur la couleur", async () => {
    addCanvasSource("cam");
    addCanvasSource("seg", 256, 256, { mode: "alpha" });
    const { el, canvas } = await mount({ source: "cam", mask: "seg", effect: "color", color: "#0f0", feather: "0", smooth: "0", "out-data-provider": "mr1" });
    expect(el.draw()).toBe(true);
    const out = log.get(canvas)!;
    const fill = out.findIndex((c) => c[0] === "fillRect");
    const last = out.map((c) => c[0]).lastIndexOf("drawImage");
    expect(fill).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(fill);
    expect(out.find((c) => c[0] === "set:fillStyle")?.[1]).toBe("#0f0");
    // la couche « keep » : composition destination-in avec le masque
    const keep = [...log.entries()].find(([, calls]) => calls.some((c) => c[0] === "set:globalCompositeOperation" && c[1] === "destination-in"));
    expect(keep).toBeTruthy();
    expect((dp("mr1") as { get?: () => unknown }).get?.()).toMatchObject({ ready: true, effect: "color", target: "background", mask: true, regions: 0 });
  });

  it("target=subject : destination-out (la zone masquée est remplacée)", async () => {
    addCanvasSource("cam");
    addCanvasSource("seg", 256, 256, { mode: "alpha" });
    const { el } = await mount({ source: "cam", mask: "seg", target: "subject", effect: "color", feather: "0", smooth: "0" });
    el.draw();
    const ops = [...log.values()].flat().filter((c) => c[0] === "set:globalCompositeOperation").map((c) => c[1]);
    expect(ops).toContain("destination-out");
    expect(ops).not.toContain("destination-in");
  });

  it("masque « gris » converti en alpha ; masque « alpha » utilisé tel quel", async () => {
    addCanvasSource("cam");
    addCanvasSource("segGray", 64, 64, { mode: "gray" });
    const a = await mount({ source: "cam", mask: "segGray", feather: "0", smooth: "0" });
    a.el.draw();
    expect([...log.values()].flat().filter((c) => c[0] === "getImageData")).toHaveLength(1);
    expect([...log.values()].flat().filter((c) => c[0] === "putImageData")).toHaveLength(1);
    log.clear();
    addCanvasSource("segAlpha", 64, 64, { mode: "alpha" });
    const b = await mount({ source: "cam", mask: "segAlpha", feather: "0", smooth: "0" });
    b.el.draw();
    expect([...log.values()].flat().filter((c) => c[0] === "getImageData")).toHaveLength(0);
  });

  it("flou : copie réduite par le diviseur de `amount`, agrandie avec lissage ; pixellisation : sans lissage", async () => {
    addCanvasSource("cam", 640, 480);
    addCanvasSource("seg", 64, 64, { mode: "alpha" });
    const blur = await mount({ source: "cam", mask: "seg", effect: "blur", amount: "0", feather: "0", smooth: "0" });
    blur.el.draw();
    const smallBlur = [...log.keys()].find((c) => sizeOf(c) === "320x240");
    expect(smallBlur).toBeTruthy(); // 640/2 × 480/2
    const upBlur = callsOf(blur.canvas, "set:imageSmoothingEnabled").map((c) => c[1]);
    expect(upBlur[0]).toBe(true);

    log.clear();
    const pix = await mount({ source: "cam", mask: "seg", effect: "pixelate", amount: "1", feather: "0", smooth: "0" });
    pix.el.draw();
    expect([...log.keys()].some((c) => sizeOf(c) === "10x8")).toBe(true); // 640/64 × 480/64
    expect(callsOf(pix.canvas, "set:imageSmoothingEnabled").map((c) => c[1])[0]).toBe(false);
  });

  it("cutout : aucun effet dessiné, seul l'objet gardé", async () => {
    addCanvasSource("cam");
    addCanvasSource("seg", 64, 64, { mode: "alpha" });
    const { el, canvas } = await mount({ source: "cam", mask: "seg", effect: "cutout", feather: "0", smooth: "0" });
    el.draw();
    expect(callsOf(canvas, "fillRect")).toHaveLength(0);
    expect(callsOf(canvas, "drawImage")).toHaveLength(1); // la couche gardée seule
  });

  it("effet source : une autre source d'images remplit le fond (recadrée) ; absente : repli en flou", async () => {
    addCanvasSource("cam", 640, 480);
    addCanvasSource("seg", 64, 64, { mode: "alpha" });
    addCanvasSource("fond", 1600, 900);
    const { el, canvas } = await mount({ source: "cam", mask: "seg", effect: "source", "with-source": "#fond", feather: "0", smooth: "0" });
    el.draw();
    const crop = callsOf(canvas, "drawImage").find((c) => c.length === 10);
    expect(crop).toBeTruthy();
    expect(crop![1]).toBe("canvas:1600x900");
    log.clear();
    const missing = await mount({ source: "cam", mask: "seg", effect: "source", "with-source": "nope", feather: "0", smooth: "0" });
    missing.el.draw();
    expect([...log.keys()].some((c) => sizeOf(c) === "38x28")).toBe(true); // repli en flou : amount 0,5 → diviseur 17
  });

  it("objets détectés : ellipses aux bonnes tailles, étiquettes filtrées", async () => {
    addCanvasSource("cam", 1000, 500);
    const { el } = await mount({ source: "cam", detections: "dets", labels: "cell_phone", target: "subject", effect: "color", pad: "0", feather: "0", smooth: "0", "out-data-provider": "mr2" });
    set("dets", {
      objects: [
        { label: "cell phone", score: 0.9, x: 0.1, y: 0.2, w: 0.2, h: 0.4 },
        { label: "person", score: 0.9, x: 0.5, y: 0.1, w: 0.4, h: 0.8 },
      ],
    });
    el.draw();
    const ell = [...log.values()].flat().filter((c) => c[0] === "ellipse");
    expect(ell).toHaveLength(1);
    const e = ell[0].slice(1, 5) as number[]; // centre (0,2 × 1000 ; 0,4 × 500), rayons 100 et 100
    [200, 200, 100, 100].forEach((v, i) => expect(e[i]).toBeCloseTo(v, 5));
    expect((dp("mr2") as { get?: () => unknown }).get?.()).toMatchObject({ regions: 1, mask: false, target: "subject" });
  });

  it("forme rect, marge et plafond d'objets", async () => {
    addCanvasSource("cam", 1000, 1000);
    const { el } = await mount({ source: "cam", detections: "dets2", shape: "rect", pad: "0.5", "max-objects": "1", feather: "0", smooth: "0" });
    set("dets2", {
      objects: [
        { label: "a", score: 0.9, x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
        { label: "b", score: 0.8, x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      ],
    });
    el.draw();
    const rects = [...log.values()].flat().filter((c) => c[0] === "rect");
    expect(rects).toHaveLength(1);
    ([300, 300, 400, 400] as number[]).forEach((v, i) => expect(rects[0][i + 1] as number).toBeCloseTo(v, 5));
  });

  it("lissage temporel : le masque précédent est repris, puis mélangé (lighter)", async () => {
    addCanvasSource("cam");
    addCanvasSource("seg", 64, 64, { mode: "alpha" });
    const { el } = await mount({ source: "cam", mask: "seg", feather: "0", smooth: "0.5" });
    el.draw();
    el.draw();
    const alphas = [...log.values()].flat().filter((c) => c[0] === "set:globalAlpha").map((c) => c[1]);
    expect(alphas).toContain(0.5);
    const ops = [...log.values()].flat().filter((c) => c[0] === "set:globalCompositeOperation").map((c) => c[1]);
    expect(ops).toContain("lighter");
  });

  it("vidéo native : retournée en miroir (auto) ; canvas déjà dessiné : non retourné", async () => {
    addVideoSource("camv");
    addCanvasSource("seg", 64, 64, { mode: "alpha" });
    const v = await mount({ source: "camv", mask: "seg", feather: "0", smooth: "0", effect: "cutout" });
    v.el.draw();
    expect([...log.values()].flat().some((c) => c[0] === "scale" && c[1] === -1)).toBe(true);
    log.clear();
    ctxs.clear();
    addCanvasSource("camc");
    const c = await mount({ source: "camc", mask: "seg", feather: "0", smooth: "0", effect: "cutout" });
    c.el.draw();
    expect([...log.values()].flat().some((x) => x[0] === "scale")).toBe(false);
  });

  it("image refusée (URL non sûre) : erreur publiée, repli en flou ; couleur non sûre : couleur par défaut", async () => {
    addCanvasSource("cam");
    addCanvasSource("seg", 64, 64, { mode: "alpha" });
    const { el, canvas } = await mount({ source: "cam", mask: "seg", effect: "image", image: "javascript:alert(1)", feather: "0", smooth: "0", "out-data-provider": "mr3" });
    el.draw();
    expect((dp("mr3") as { get?: () => unknown }).get?.()).toMatchObject({ error: "URL d'image refusée" });
    expect(names(canvas)).toContain("drawImage");
    const col = await mount({ source: "cam", mask: "seg", effect: "color", color: "red;x:url(y)", feather: "0", smooth: "0" });
    col.el.draw();
    expect(callsOf(col.canvas, "set:fillStyle")[0][1]).toBe("#101820");
  });

  it("Canvas 2D indisponible : erreur lisible", async () => {
    addCanvasSource("cam");
    addCanvasSource("seg", 64, 64, { mode: "alpha" });
    const { el } = await mount({ source: "cam", mask: "seg", "out-data-provider": "mr4" });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(el.draw()).toBe(false);
    expect((dp("mr4") as { get?: () => unknown }).get?.()).toMatchObject({ ready: false, error: "Canvas 2D indisponible" });
  });
});
