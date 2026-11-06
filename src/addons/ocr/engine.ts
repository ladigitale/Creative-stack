/**
 * Moteur de reconnaissance de texte : Tesseract.js (WebAssembly, LSTM), version exacte servie par
 * jsDelivr avec empreinte d'intégrité. Chargé à la demande, dans un worker, sans qu'aucune image ne
 * quitte l'appareil. Les langues viennent d'une liste fermée.
 */

export const TESSERACT_VERSION = "7.0.0";
export const TESSERACT_SCRIPT = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
export const TESSERACT_SRI = "sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM";
export const TESSERACT_WORKER = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`;
export const TESSERACT_CORE = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VERSION}`;

/** Langues acceptées (codes Tesseract). */
export const OCR_LANGS = ["eng", "fra", "deu", "spa", "ita", "por", "nld", "pol", "ces", "swe", "dan", "nor", "fin", "tur", "ron", "hun", "ell", "rus"] as const;
export const MAX_LANGS = 3;

/** `fra`, `fra+eng` → liste validée ; `null` si un code est inconnu ou s'il y en a trop. */
export function parseLangs(value: string): string[] | null {
  const parts = value.split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length || parts.length > MAX_LANGS) return null;
  if (!parts.every((p) => (OCR_LANGS as readonly string[]).includes(p))) return null;
  return [...new Set(parts)];
}

export type RawBox = { x0: number; y0: number; x1: number; y1: number };
export type RawWord = { text: string; confidence: number; bbox: RawBox };
export type RawLine = { text: string; confidence: number; bbox: RawBox; words?: RawWord[] };
export type RawResult = { text?: string; confidence?: number; blocks?: Array<{ paragraphs?: Array<{ lines?: RawLine[] }> }> | null };

export type OcrEngine = {
  recognize(image: HTMLCanvasElement, onProgress?: (p: number) => void): Promise<RawResult>;
  terminate(): Promise<void>;
};

export type OcrEngineFactory = (langs: string[], onStatus: (s: string) => void) => Promise<OcrEngine>;

type TesseractGlobal = {
  createWorker(
    langs: string | string[],
    oem: number,
    options: Record<string, unknown>,
  ): Promise<{
    recognize(img: unknown, opts: Record<string, unknown>, output: Record<string, boolean>): Promise<{ data: RawResult }>;
    terminate(): Promise<unknown>;
  }>;
};

let scriptPromise: Promise<TesseractGlobal> | null = null;

/** Charge le script épinglé (une seule fois par page). */
export function loadTesseract(): Promise<TesseractGlobal> {
  const w = window as unknown as { Tesseract?: TesseractGlobal };
  if (w.Tesseract) return Promise.resolve(w.Tesseract);
  scriptPromise ??= new Promise<TesseractGlobal>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_SCRIPT;
    s.integrity = TESSERACT_SRI;
    s.crossOrigin = "anonymous";
    s.async = true;
    s.onload = () => (w.Tesseract ? resolve(w.Tesseract) : reject(new Error("Tesseract indisponible")));
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("chargement du moteur de reconnaissance impossible (réseau ou CSP)"));
    };
    document.head.append(s);
  });
  return scriptPromise;
}

const tesseractFactory: OcrEngineFactory = async (langs, onStatus) => {
  const T = await loadTesseract();
  let progress: ((p: number) => void) | undefined;
  const worker = await T.createWorker(langs, 1, {
    workerPath: TESSERACT_WORKER,
    corePath: TESSERACT_CORE,
    logger: (m: { status?: string; progress?: number }) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") progress?.(m.progress);
      else if (m.status) onStatus(m.status);
    },
  });
  return {
    async recognize(image, onProgress) {
      progress = onProgress;
      const r = await worker.recognize(image, {}, { text: true, blocks: true });
      progress = undefined;
      return r.data;
    },
    terminate: async () => void (await worker.terminate()),
  };
};

let factory: OcrEngineFactory = tesseractFactory;

/** Remplace le moteur (tests, autre implémentation fournie par l'application). */
export function setOcrEngineFactory(f: OcrEngineFactory | null): void {
  factory = f ?? tesseractFactory;
}

export function createOcrEngine(langs: string[], onStatus: (s: string) => void): Promise<OcrEngine> {
  return factory(langs, onStatus);
}

/* ------------------------------------------------------------------ résultat */

export type OcrWord = { text: string; confidence: number; x: number; y: number; w: number; h: number };
export type OcrLine = { text: string; confidence: number; x: number; y: number; w: number; h: number; words: OcrWord[] };
export type OcrResult = { text: string; confidence: number; lines: OcrLine[]; words: number };

const box = (b: RawBox, k: number) => ({ x: Math.round(b.x0 * k), y: Math.round(b.y0 * k), w: Math.round((b.x1 - b.x0) * k), h: Math.round((b.y1 - b.y0) * k) });
const clean = (s: unknown) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
const conf = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : 0);

/**
 * Met en forme le résultat brut : coordonnées ramenées à l'image d'origine (`scale` = analysée / origine),
 * mots sous `minConfidence` écartés, lignes vides retirées, texte recomposé ligne par ligne.
 */
export function shapeResult(raw: RawResult, scale: number, minConfidence = 0): OcrResult {
  const k = scale > 0 ? 1 / scale : 1;
  const lines: OcrLine[] = [];
  let words = 0;
  for (const block of raw.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const ws: OcrWord[] = (line.words ?? [])
          .filter((w) => clean(w.text) && conf(w.confidence) >= minConfidence)
          .map((w) => ({ text: clean(w.text), confidence: conf(w.confidence), ...box(w.bbox, k) }));
        const text = line.words ? ws.map((w) => w.text).join(" ") : clean(line.text);
        if (!text) continue;
        words += ws.length;
        lines.push({ text, confidence: conf(line.confidence), ...box(line.bbox, k), words: ws });
      }
    }
  }
  const text = lines.length || raw.blocks ? lines.map((l) => l.text).join("\n") : clean(raw.text);
  return { text, confidence: conf(raw.confidence), lines, words };
}
