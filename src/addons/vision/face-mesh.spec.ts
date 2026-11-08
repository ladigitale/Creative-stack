import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicFaceMesh } from "./face-mesh";
import { FACE_TRIANGLES } from "../../shared/ml/face-mesh-data";

void SonicFaceMesh;

type Call = [string, ...unknown[]];

function fakeGl() {
  const calls: Call[] = [];
  const gl: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, key: string) {
        if (/^[A-Z][A-Z0-9_]+$/.test(key)) return 1;
        return (...a: unknown[]) => {
          calls.push([key, ...a]);
          if (key === "getShaderParameter" || key === "getProgramParameter") return true;
          if (key === "getAttribLocation") return 0;
          return {};
        };
      },
    },
  );
  return { gl, calls };
}

const face = (dx = 0) => Array.from({ length: 478 }, (_, i) => ({ x: 0.2 + dx + (i % 20) * 0.01, y: 0.2 + Math.floor(i / 20) * 0.01, z: 0 }));
const count = (calls: Call[], name: string) => calls.filter((c) => c[0] === name).length;
const settle = () => new Promise((r) => setTimeout(r, 0));

let fake: ReturnType<typeof fakeGl>;
let glAvailable = true;
beforeEach(() => {
  fake = fakeGl();
  glAvailable = true;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((type: string) => {
    if (type === "webgl") return glAvailable ? fake.gl : null;
    return null; // pas de canvas 2D sous jsdom : la correction de couleur est simplement ignorée
  }) as never);
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-face-mesh") as SonicFaceMesh;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function addSource(id: string) {
  const src = document.createElement("div") as unknown as HTMLElement & { getFrameCanvas: () => HTMLCanvasElement; frameSeq: number };
  src.id = id;
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 480;
  src.getFrameCanvas = () => c;
  src.frameSeq = 1;
  document.body.appendChild(src);
  return src;
}

describe("sonic-face-mesh", () => {
  it("sans WebGL : rien n'est dessiné et l'état le dit", async () => {
    glAvailable = false;
    const el = await mount({ source: "fm0", "out-data-provider": "fm0State" });
    expect(el.draw()).toBe(0);
    expect(dp("fm0State").get()).toMatchObject({ ready: false, error: "WebGL indisponible" });
  });

  it("un seul visage et pas de texture : rien à greffer", async () => {
    addSource("camfm1");
    const el = await mount({ source: "fm1", background: "camfm1", "out-data-provider": "fm1State" });
    set("fm1", { present: true, faces: [{ landmarks: face() }] });
    await settle();
    expect(el.draw()).toBe(0);
    expect(count(fake.calls, "drawElements")).toBe(0);
    expect(count(fake.calls, "drawArrays")).toBe(1); // l'image de fond
    expect(dp("fm1State").get()).toMatchObject({ ready: true, mode: "none", faces: 1, drawn: 0 });
  });

  it("deux visages : échange, un maillage complet par visage", async () => {
    addSource("camfm2");
    const el = await mount({ source: "fm2", background: "camfm2", "out-data-provider": "fm2State" });
    set("fm2", { present: true, faces: [{ landmarks: face() }, { landmarks: face(0.4) }] });
    await settle();
    fake.calls.length = 0;
    const before = el.frameSeq;
    expect(el.draw()).toBe(2);
    const draws = fake.calls.filter((c) => c[0] === "drawElements");
    expect(draws).toHaveLength(2);
    expect(draws[0][2]).toBe(FACE_TRIANGLES.length);
    expect(el.frameSeq).toBe(before + 1);
    expect(dp("fm2State").get()).toMatchObject({ mode: "swap", faces: 2, drawn: 2 });
  });

  it("face=0 : seul le premier visage reçoit la texture", async () => {
    addSource("camfm3");
    const el = await mount({ source: "fm3", background: "camfm3", face: "0" });
    set("fm3", { present: true, faces: [{ landmarks: face() }, { landmarks: face(0.4) }] });
    await settle();
    expect(el.draw()).toBe(1);
  });

  it("points incomplets ou visage absent : ignorés", async () => {
    addSource("camfm4");
    const el = await mount({ source: "fm4", background: "camfm4" });
    set("fm4", { present: true, faces: [{ landmarks: face().slice(0, 100) }, { landmarks: face() }] });
    await settle();
    expect(el.draw()).toBe(0);
    set("fm4", { present: false, faces: [{ landmarks: face() }, { landmarks: face(0.4) }] });
    await settle();
    expect(el.draw()).toBe(0);
  });

  it("portrait : texture-source + texture-landmarks", async () => {
    addSource("camfm5");
    addSource("portraitfm5");
    const el = await mount({ source: "fm5", background: "camfm5", "texture-source": "portraitfm5", "texture-landmarks": "fm5tex", "out-data-provider": "fm5State" });
    set("fm5", { present: true, faces: [{ landmarks: face() }] });
    set("fm5tex", { present: true, faces: [{ landmarks: face(0.1) }] });
    await settle();
    expect(el.draw()).toBe(1);
    expect(dp("fm5State").get()).toMatchObject({ mode: "portrait", drawn: 1 });
  });

  it("portrait sans visage dans l'image de référence : pas de greffe", async () => {
    addSource("camfm6");
    addSource("portraitfm6");
    const el = await mount({ source: "fm6", background: "camfm6", "texture-source": "portraitfm6", "texture-landmarks": "fm6tex" });
    set("fm6", { present: true, faces: [{ landmarks: face() }] });
    await settle();
    expect(el.draw()).toBe(0);
    expect(el.resolveMode()).toBe("none");
  });

  it("texture refusée (schéma dangereux) : erreur publiée, aucune requête", async () => {
    const el = await mount({ source: "fm7", texture: "javascript:alert(1)", "out-data-provider": "fm7State" });
    set("fm7", { present: true, faces: [{ landmarks: face() }] });
    await settle();
    expect(el.draw()).toBe(0);
    expect(dp("fm7State").get()).toMatchObject({ error: "URL de texture refusée" });
  });

  it("texture à plat : un visage suffit", async () => {
    const el = await mount({ source: "fm8", texture: "https://example.com/masque.png", "out-data-provider": "fm8State" });
    (el as unknown as { textureImage: unknown }).textureImage = { naturalWidth: 4, naturalHeight: 4 };
    set("fm8", { present: true, faces: [{ landmarks: face() }] });
    await settle();
    expect(el.resolveMode()).toBe("canonical");
    expect(el.draw()).toBe(1);
  });

  it("est une source d'images une fois dessinée", async () => {
    const el = await mount({ source: "fm9" });
    expect(el.getFrameCanvas()).toBeNull();
    el.draw();
    expect(el.getFrameCanvas()).not.toBeNull();
    expect(el.frameSeq).toBeGreaterThan(0);
  });

  it("feather=0 : bords nets (poids tous à 1)", async () => {
    addSource("camfm10");
    const el = await mount({ source: "fm10", background: "camfm10", feather: "0" });
    set("fm10", { present: true, faces: [{ landmarks: face() }, { landmarks: face(0.4) }] });
    await settle();
    fake.calls.length = 0;
    el.draw();
    const buf = fake.calls.find((c) => c[0] === "bufferData" && c[2] instanceof Float32Array && c[2].length === 468);
    expect(buf).toBeTruthy();
    expect([...(buf![2] as Float32Array)].every((v) => v === 1)).toBe(true);
  });
});

describe("sonic-face-mesh : params et état", () => {
  it("état dès la connexion : status idle, error null, réglages", async () => {
    await mount({ source: "fmp0", "out-data-provider": "fmp0State", opacity: "0.5" });
    expect(dp("fmp0State").get()).toMatchObject({ status: "idle", error: null, ready: false, settings: { opacity: 0.5, feather: 6, colorMatch: 0.8, face: "all" } });
  });

  it("params : opacité, visage, fondu, correction en direct, prioritaires sur les attributs", async () => {
    addSource("camfmp1");
    set("fmp1P", { opacity: 0.25, face: 1, feather: 0, colorMatch: 2 });
    const el = await mount({ source: "fmp1", background: "camfmp1", params: "fmp1P", opacity: "1", "out-data-provider": "fmp1State" });
    set("fmp1", { present: true, faces: [{ landmarks: face() }, { landmarks: face(0.4) }] });
    await settle();
    expect(el).toMatchObject({ opacity: 0.25, face: "1", feather: 0, colorMatch: 1 });
    fake.calls.length = 0;
    expect(el.draw()).toBe(1);
    expect(fake.calls.some((c) => c[0] === "uniform1f" && c[2] === 0.25)).toBe(true);
    expect(dp("fmp1State").get()).toMatchObject({ status: "ready", error: null, mode: "swap", drawn: 1, settings: { opacity: 0.25, face: "1" } });

    set("fmp1P", {}); // clés retirées : retour aux attributs
    await el.updateComplete;
    expect(el).toMatchObject({ opacity: 1, face: "all", feather: 6, colorMatch: 0.8 });
    expect(el.draw()).toBe(2);
  });

  it("WebGL indisponible : status error", async () => {
    glAvailable = false;
    const el = await mount({ source: "fmp2", "out-data-provider": "fmp2State" });
    el.draw();
    expect(dp("fmp2State").get()).toMatchObject({ status: "error", error: "WebGL indisponible", ready: false });
  });
});
