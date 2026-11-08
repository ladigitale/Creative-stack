import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { parseLangs, readOcrSettings, setOcrEngineFactory, shapeResult, type OcrEngine, type RawResult } from "./index";
import type { SonicOcr } from "./ocr";

const RAW: RawResult = {
  text: "Bonjour le monde\n",
  confidence: 91.4,
  blocks: [{ paragraphs: [{ lines: [
    { text: "Bonjour le monde\n", confidence: 93, bbox: { x0: 10, y0: 20, x1: 210, y1: 50 }, words: [
      { text: "Bonjour", confidence: 96, bbox: { x0: 10, y0: 20, x1: 90, y1: 50 } },
      { text: "le", confidence: 40, bbox: { x0: 100, y0: 20, x1: 120, y1: 50 } },
      { text: "monde", confidence: 90, bbox: { x0: 130, y0: 20, x1: 210, y1: 50 } },
    ] },
    { text: "  \n", confidence: 0, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, words: [] },
  ] }] }],
};

describe("langues", () => {
  it("valide la liste fermée", () => {
    expect(parseLangs("fra")).toEqual(["fra"]);
    expect(parseLangs("FRA+eng+fra")).toEqual(["fra", "eng"]);
    expect(parseLangs("fra+eng+deu+spa")).toBeNull();
    expect(parseLangs("xx")).toBeNull();
    expect(parseLangs("../../evil")).toBeNull();
    expect(parseLangs("")).toBeNull();
  });
});

describe("réglages DataProvider", () => {
  it("lit les clés camelCase ou en tirets, bornées", () => {
    expect(readOcrSettings({ lang: " fra+eng ", minConfidence: 150, "max-size": 10 })).toEqual({ lang: "fra+eng", minConfidence: 100, maxSize: 64 });
    expect(readOcrSettings({ lang: ["fra", "deu"], "min-confidence": "40" })).toEqual({ lang: "fra+deu", minConfidence: 40 });
    expect(readOcrSettings({ n: 3, lang: "", maxSize: "x" })).toEqual({});
    expect(readOcrSettings(null)).toEqual({});
  });
});

describe("mise en forme", () => {
  it("compose texte, lignes et mots", () => {
    const r = shapeResult(RAW, 1);
    expect(r.text).toBe("Bonjour le monde");
    expect(r.lines.length).toBe(1);
    expect(r.words).toBe(3);
    expect(r.lines[0]).toMatchObject({ x: 10, y: 20, w: 200, h: 30 });
  });
  it("ramène les positions à l'image d'origine", () => {
    const r = shapeResult(RAW, 0.5);
    expect(r.lines[0]).toMatchObject({ x: 20, y: 40, w: 400, h: 60 });
  });
  it("écarte les mots peu sûrs", () => {
    const r = shapeResult(RAW, 1, 50);
    expect(r.text).toBe("Bonjour monde");
    expect(r.words).toBe(2);
  });
  it("sans blocs, retombe sur le texte brut", () => {
    const r = shapeResult({ text: " Salut \n", confidence: 80 }, 1);
    expect(r.text).toBe("Salut");
    expect(r.lines).toEqual([]);
  });
  it("assainit les caractères de contrôle et les confiances", () => {
    const r = shapeResult({ blocks: [{ paragraphs: [{ lines: [{ text: "a\u0000b", confidence: 250, bbox: { x0: 0, y0: 0, x1: 4, y1: 4 } }] }] }] }, 1);
    expect(r.text).toBe("ab");
    expect(r.lines[0].confidence).toBe(100);
  });
});

describe("composant", () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = (() => ({ fillRect() {}, drawImage() {}, set fillStyle(_v: string) {} })) as never;
  });
  afterEach(() => setOcrEngineFactory(null));

  function source(id: string): HTMLElement {
    const el = document.createElement("div") as unknown as HTMLElement & { getFrameCanvas: () => HTMLCanvasElement; frameSeq: number };
    el.id = id;
    const c = document.createElement("canvas");
    c.width = 400; c.height = 100;
    el.getFrameCanvas = () => c;
    el.frameSeq = 1;
    document.body.append(el);
    return el;
  }
  function make(attrs: Record<string, string>): SonicOcr {
    const el = document.createElement("sonic-ocr") as SonicOcr;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.append(el);
    return el;
  }
  const fake = (calls: { created: number; terminated: number; langs: string[][] }): void =>
    setOcrEngineFactory(async (langs): Promise<OcrEngine> => {
      calls.created++;
      calls.langs.push(langs);
      return {
        recognize: async (_img, onProgress) => { onProgress?.(0.5); return RAW; },
        terminate: async () => void calls.terminated++,
      };
    });

  it("lit l'image sur hausse du compteur", async () => {
    const calls = { created: 0, terminated: 0, langs: [] as string[][] };
    fake(calls);
    const src = source("ocr-src-1");
    const el = make({ source: "#ocr-src-1", lang: "fra", control: "ocr.ctl", "out-data-provider": "ocr.out" });
    set("ocr.ctl", { n: 0 });
    expect((dp("ocr.out").get() as { status: string }).status).toBe("idle");
    set("ocr.ctl", { n: 1 });
    await vi.waitFor(() => expect((dp("ocr.out").get() as { status: string }).status).toBe("ready"));
    const out = dp("ocr.out").get() as { text: string; width: number; lines: unknown[]; lang: string };
    expect(out.text).toBe("Bonjour le monde");
    expect(out.width).toBe(400);
    expect(out.lang).toBe("fra");
    set("ocr.ctl", { n: 2 });
    await vi.waitFor(() => expect(calls.created).toBe(1));
    expect(calls.langs).toEqual([["fra"]]);
    el.remove(); src.remove();
    expect(calls.terminated).toBe(1);
  });

  it("signale les erreurs de configuration", async () => {
    fake({ created: 0, terminated: 0, langs: [] });
    const el = make({ lang: "klingon", source: "#nope", "out-data-provider": "ocr.err" });
    await el.run();
    expect((dp("ocr.err").get() as { error: string }).error).toMatch(/langue/);
    el.lang = "eng";
    await el.run();
    expect((dp("ocr.err").get() as { error: string }).error).toMatch(/source/);
    el.remove();
  });

  it("remonte l'échec du moteur", async () => {
    setOcrEngineFactory(async () => { throw new Error("réseau coupé"); });
    const src = source("ocr-src-2");
    const el = make({ source: "#ocr-src-2", "out-data-provider": "ocr.fail" });
    await el.run();
    expect(dp("ocr.fail").get()).toMatchObject({ status: "error", error: "réseau coupé" });
    el.remove(); src.remove();
  });

  it("une seule lecture à la fois", async () => {
    let n = 0, release: (() => void) | null = null;
    setOcrEngineFactory(async () => ({
      recognize: () => { n++; return new Promise<RawResult>((r) => (release = () => r(RAW))); },
      terminate: async () => {},
    }));
    const src = source("ocr-src-3");
    const el = make({ source: "#ocr-src-3", "out-data-provider": "ocr.one" });
    const a = el.run();
    await vi.waitFor(() => expect(release).toBeTruthy());
    await el.run();
    expect(n).toBe(1);
    release!();
    await a;
    el.remove(); src.remove();
  });

  it("publie les réglages effectifs : attributs < control < params", async () => {
    fake({ created: 0, terminated: 0, langs: [] });
    set("ocrPrioParams", {});
    const el = make({ lang: "fra", "min-confidence": "20", "max-size": "999999", control: "ocrPrioCtl", params: "ocrPrioParams", "out-data-provider": "ocr.prio" });
    await el.updateComplete;
    expect((dp("ocr.prio").get() as { settings: unknown }).settings).toEqual({ lang: "fra", minConfidence: 20, maxSize: 4000 });
    set("ocrPrioCtl", { n: 0, lang: "deu", minConfidence: 30 });
    expect(el.settings()).toEqual({ lang: "deu", minConfidence: 30, maxSize: 4000 });
    set("ocrPrioParams", { lang: "ENG+fra", maxSize: 800 });
    expect(el.settings()).toEqual({ lang: "eng+fra", minConfidence: 30, maxSize: 800 });
    expect((dp("ocr.prio").get() as { settings: unknown }).settings).toEqual({ lang: "eng+fra", minConfidence: 30, maxSize: 800 });
    el.remove();
  });

  it("minConfidence en direct : remise en forme sans relire", async () => {
    let reads = 0;
    setOcrEngineFactory(async () => ({ recognize: async () => { reads++; return RAW; }, terminate: async () => {} }));
    const src = source("ocr-src-4");
    set("ocrMcParams", {});
    const el = make({ source: "#ocr-src-4", params: "ocrMcParams", "out-data-provider": "ocr.mc" });
    await el.run();
    expect((dp("ocr.mc").get() as { text: string }).text).toBe("Bonjour le monde");
    set("ocrMcParams", { minConfidence: 50 });
    await vi.waitFor(() => expect((dp("ocr.mc").get() as { text: string }).text).toBe("Bonjour monde"));
    expect(reads).toBe(1);
    expect((dp("ocr.mc").get() as { settings: { minConfidence: number } }).settings.minConfidence).toBe(50);
    el.remove(); src.remove();
  });

  it("changer de langue libère le moteur et relit", async () => {
    const calls = { created: 0, terminated: 0, langs: [] as string[][] };
    fake(calls);
    const src = source("ocr-src-5");
    set("ocrLangParams", {});
    const el = make({ source: "#ocr-src-5", lang: "fra", params: "ocrLangParams", "out-data-provider": "ocr.lang" });
    await el.run();
    expect(calls.langs).toEqual([["fra"]]);
    set("ocrLangParams", { lang: "deu+eng" });
    await vi.waitFor(() => expect((dp("ocr.lang").get() as { lang: string; status: string })).toMatchObject({ lang: "deu+eng", status: "ready" }));
    expect(calls.langs).toEqual([["fra"], ["deu", "eng"]]);
    expect(calls.terminated).toBe(1);
    expect((dp("ocr.lang").get() as { runs: number }).runs).toBe(2);
    set("ocrLangParams", { lang: "klingon" });
    await vi.waitFor(() => expect((dp("ocr.lang").get() as { error: string }).error).toMatch(/langue/));
    el.remove(); src.remove();
  });

  it("un changement de langue pendant une lecture s'applique ensuite", async () => {
    const langs: string[][] = [];
    let release: (() => void) | null = null;
    setOcrEngineFactory(async (l) => {
      langs.push(l);
      return { recognize: () => new Promise<RawResult>((r) => (release = () => r(RAW))), terminate: async () => {} };
    });
    const src = source("ocr-src-6");
    set("ocrBusyParams", {});
    const el = make({ source: "#ocr-src-6", params: "ocrBusyParams", "out-data-provider": "ocr.busy" });
    const a = el.run();
    await vi.waitFor(() => expect(release).toBeTruthy());
    set("ocrBusyParams", { lang: "ita" });
    const r1 = release!; release = null;
    r1();
    await a;
    await vi.waitFor(() => expect(release).toBeTruthy());
    release!();
    await vi.waitFor(() => expect((dp("ocr.busy").get() as { lang: string; status: string })).toMatchObject({ lang: "ita", status: "ready" }));
    expect(langs).toEqual([["eng"], ["ita"]]);
    el.remove(); src.remove();
  });

  it("auto relit à chaque nouvelle image de la source", async () => {
    let reads = 0;
    setOcrEngineFactory(async () => ({ recognize: async () => { reads++; return RAW; }, terminate: async () => {} }));
    const src = source("ocr-src-7") as HTMLElement & { frameSeq: number };
    const el = make({ source: "#ocr-src-7", auto: "", interval: "100", "out-data-provider": "ocr.auto" });
    await vi.waitFor(() => expect(reads).toBe(1));
    await new Promise((r) => setTimeout(r, 250));
    expect(reads).toBe(1);
    src.frameSeq = 2;
    await vi.waitFor(() => expect(reads).toBe(2));
    expect((dp("ocr.auto").get() as { runs: number }).runs).toBe(2);
    el.remove(); src.remove();
  });
});
