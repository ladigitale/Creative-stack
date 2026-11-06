import { afterEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { fileKind, type SonicFileOpen } from "./file-open";
import type { SonicStill } from "./still";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

/** jsdom ne décode pas les images : Image simulée qui réussit ou échoue selon l'URL. */
function stubImage(w = 40, h = 20) {
  class FakeImage {
    naturalWidth = w;
    naturalHeight = h;
    width = w;
    height = h;
    crossOrigin = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) {
      setTimeout(() => (/broken/.test(v) ? this.onerror?.() : this.onload?.()), 0);
    }
  }
  vi.stubGlobal("Image", FakeImage);
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("sonic-still", () => {
  it("charge une URL sûre, expose canvas, frameSeq et état", async () => {
    stubImage();
    const el = document.createElement("sonic-still") as SonicStill;
    el.id = "imgA";
    document.body.append(el);
    expect(el.getFrameCanvas()).toBeNull();
    el.src = "/a.png";
    await settle();
    expect(el.getFrameCanvas()).not.toBeNull();
    expect(el.frameSeq).toBe(1);
    expect(el.getState()).toMatchObject({ status: "ready", width: 40, height: 20 });
    expect((dp("imgAState").get() as { status: string }).status).toBe("ready");
  });

  it("refuse javascript: et http:", async () => {
    stubImage();
    const el = document.createElement("sonic-still") as SonicStill;
    document.body.append(el);
    expect(await el.loadUrl("javascript:alert(1)")).toBe(false);
    expect(await el.loadUrl("http://x.test/a.png")).toBe(false);
    expect(el.getState().status).toBe("error");
  });

  it("signale une image illisible", async () => {
    stubImage();
    const el = document.createElement("sonic-still") as SonicStill;
    document.body.append(el);
    expect(await el.loadUrl("/broken.png")).toBe(false);
    expect(el.getState().error).toMatch(/illisible/);
  });

  it("réduit une image plus grande que max-size", async () => {
    stubImage(1000, 500);
    const el = document.createElement("sonic-still") as SonicStill;
    el.maxSize = 100;
    document.body.append(el);
    await el.loadUrl("/big.png");
    expect(el.getState()).toMatchObject({ width: 100, height: 50 });
  });

  it("suit un SonicMediaRef publié dans un DataProvider (gelé par Concorde 6)", async () => {
    stubImage();
    const el = document.createElement("sonic-still") as SonicStill;
    el.inDataProvider = "imgIn";
    document.body.append(el);
    await settle();
    set("imgIn", { url: "/b.png" });
    await settle();
    expect(el.getState().status).toBe("ready");
  });

  it("une seconde image remplace la première (la plus récente gagne)", async () => {
    stubImage();
    const el = document.createElement("sonic-still") as SonicStill;
    document.body.append(el);
    const first = el.loadUrl("/broken.png");
    const second = el.loadUrl("/ok.png");
    await Promise.all([first, second]);
    expect(el.getState().status).toBe("ready");
  });

  it("refuse un fichier qui n'est pas une image", async () => {
    stubImage();
    const el = document.createElement("sonic-still") as SonicStill;
    document.body.append(el);
    expect(await el.loadFile(new Blob(["a"], { type: "text/plain" }))).toBe(false);
  });
});

describe("sonic-file-open", () => {
  it("classe les fichiers par type", () => {
    expect(fileKind("image/png")).toBe("image");
    expect(fileKind("audio/wav")).toBe("audio");
    expect(fileKind("", "data.csv")).toBe("text");
    expect(fileKind("application/zip")).toBe("other");
  });

  it("publie un SonicMediaRef et le texte d'un CSV", async () => {
    URL.createObjectURL = vi.fn(() => "blob:test/1");
    URL.revokeObjectURL = vi.fn();
    const el = document.createElement("sonic-file-open") as SonicFileOpen;
    el.refProvider = "fileRef";
    el.id = "fo";
    document.body.append(el);
    const ok = await el.openFile(new File(["a,b\n1,2"], "d.csv", { type: "text/csv" }));
    await settle();
    expect(ok).toBe(true);
    expect(el.getState()).toMatchObject({ name: "d.csv", kind: "text", text: "a,b\n1,2" });
    expect((dp("fileRef").get() as { url: string }).url).toBe("blob:test/1");
  });

  it("refuse un fichier trop gros", async () => {
    const el = document.createElement("sonic-file-open") as SonicFileOpen;
    el.maxBytes = 2;
    document.body.append(el);
    expect(await el.openFile(new File(["abc"], "x.txt", { type: "text/plain" }))).toBe(false);
    expect(el.getState().error).toMatch(/volumineux/);
  });
});
