import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicLandmarksOverlay } from "./landmarks-overlay";

void SonicLandmarksOverlay;

type Call = [string, ...unknown[]];

function fakeCtx() {
  const calls: Call[] = [];
  const rec = (name: string) => (...a: unknown[]) => void calls.push([name, ...a]);
  const ctx = {
    clearRect: rec("clearRect"), fillRect: rec("fillRect"), beginPath: rec("beginPath"), moveTo: rec("moveTo"),
    lineTo: rec("lineTo"), closePath: rec("closePath"), stroke: rec("stroke"), arc: rec("arc"), fill: rec("fill"),
    drawImage: rec("drawImage"), strokeRect: rec("strokeRect"), fillText: rec("fillText"), save: rec("save"), restore: rec("restore"), translate: rec("translate"), scale: rec("scale"),
    fillStyle: "", strokeStyle: "", lineWidth: 0, lineJoin: "", lineCap: "", font: "",
  };
  return { ctx, calls };
}

const lm = (n: number, dx = 0) => Array.from({ length: n }, (_, i) => ({ x: (i / n) * 0.5 + dx, y: 0.5, z: 0 }));
const count = (calls: Call[], name: string) => calls.filter((c) => c[0] === name).length;

let fake: ReturnType<typeof fakeCtx>;
beforeEach(() => {
  fake = fakeCtx();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fake.ctx as never);
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-landmarks-overlay") as SonicLandmarksOverlay;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("sonic-landmarks-overlay", () => {
  it("dessine segments et points des mains, d'après le DataProvider", async () => {
    const el = await mount({ source: "ovh1" });
    set("ovh1", { hands: [{ role: "left", landmarks: lm(21) }, { role: "right", landmarks: lm(21, 0.4) }] });
    await new Promise((r) => setTimeout(r, 0));
    fake.calls.length = 0;
    const n = el.draw();
    expect(n).toBe(21 * 2 + 2); // 21 segments × 2 mains + 2 jeux de points
    expect(count(fake.calls, "stroke")).toBe(42);
    expect(count(fake.calls, "arc")).toBe(42);
    expect(fake.calls[0][0]).toBe("clearRect");
  });

  it("couleurs : principale pour la gauche, secondaire pour la droite", async () => {
    const el = await mount({ source: "ovh2", color: "#111111", color2: "#222222", bones: "false" });
    set("ovh2", { hands: [{ role: "left", landmarks: lm(21) }, { role: "right", landmarks: lm(21, 0.4) }] });
    await new Promise((r) => setTimeout(r, 0));
    const styles: string[] = [];
    Object.defineProperty(fake.ctx, "fillStyle", { set: (v: string) => void styles.push(v), get: () => "" });
    el.draw();
    expect(styles).toEqual(["#111111", "#222222"]);
  });

  it("points / bones désactivables", async () => {
    const el = await mount({ source: "ovh3", points: "false" });
    set("ovh3", { hands: [{ role: "left", landmarks: lm(21) }] });
    await new Promise((r) => setTimeout(r, 0));
    fake.calls.length = 0;
    el.draw();
    expect(count(fake.calls, "arc")).toBe(0);
    expect(count(fake.calls, "stroke")).toBe(21);
  });

  it("corps (kind forcé) et visage sans points : rien à dessiner pour le visage", async () => {
    const el = await mount({ source: "ovh4", kind: "face" });
    set("ovh4", { faces: [{ blend: {} }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(el.draw()).toBe(0);
    el.setAttribute("kind", "pose");
    el.setAttribute("source", "ovh5");
    await el.updateComplete;
    set("ovh5", { poses: [{ landmarks: lm(33) }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(el.draw()).toBeGreaterThan(30);
  });

  it("fond uni, taille du canvas selon width / height", async () => {
    const el = await mount({ source: "ovh6", fill: "#000", width: "320", height: "240" });
    el.draw();
    expect(fake.calls.some((c) => c[0] === "fillRect")).toBe(true);
    const canvas = el.shadowRoot!.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([320, 240]);
  });

  it("image de fond : redessinée, retournée en miroir", async () => {
    const cam = document.createElement("div") as unknown as HTMLElement & { getFrameSource: () => unknown };
    cam.id = "camov";
    cam.getFrameSource = () => ({ readyState: 4, videoWidth: 640, videoHeight: 360 });
    document.body.appendChild(cam);
    const el = await mount({ source: "ovh7", background: "camov" });
    fake.calls.length = 0;
    el.draw();
    expect(count(fake.calls, "drawImage")).toBe(1);
    expect(fake.calls.some((c) => c[0] === "scale" && c[1] === -1)).toBe(true);
    const canvas = el.shadowRoot!.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
  });

  it("objets : rectangle et étiquette", async () => {
    const el = await mount({ source: "ovh10" });
    set("ovh10", { objects: [{ label: "cup", score: 0.9, x: 0.1, y: 0.2, w: 0.3, h: 0.4 }] });
    await new Promise((r) => setTimeout(r, 0));
    fake.calls.length = 0;
    expect(el.draw()).toBe(1);
    expect(fake.calls.find((c) => c[0] === "strokeRect")).toEqual(["strokeRect", 64, 96, 192, 192]);
    expect(fake.calls.find((c) => c[0] === "fillText")?.[1]).toBe("cup 90%");
  });

  it("fond = source à canvas (masque) : dessinée sans retournement en mode auto", async () => {
    const seg = document.createElement("div") as unknown as HTMLElement & { getFrameCanvas: () => unknown };
    seg.id = "segov";
    seg.getFrameCanvas = () => ({ width: 256, height: 256 });
    document.body.appendChild(seg);
    const el = await mount({ source: "ovh11", background: "segov" });
    fake.calls.length = 0;
    el.draw();
    expect(fake.calls.some((c) => c[0] === "drawImage")).toBe(true);
    expect(fake.calls.some((c) => c[0] === "scale")).toBe(false);
  });

  it("données absentes ou mal formées : aucun dessin, aucune exception", async () => {
    const el = await mount({ source: "ovh8" });
    expect(el.draw()).toBe(0);
    set("ovh8", { hands: [{ landmarks: "x" }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(el.draw()).toBe(0);
  });

  it("sans contexte 2D (environnement sans canvas) : 0, pas d'exception", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const el = await mount({ source: "ovh9" });
    expect(el.draw()).toBe(0);
  });
});
