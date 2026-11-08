/** Addon ocr : reconnaissance de texte sur toute source d'images (Tesseract.js, local). */
export { SonicOcr, readOcrSettings, type OcrState, type OcrSettings } from "./ocr";
export { parseLangs, shapeResult, setOcrEngineFactory, OCR_LANGS, TESSERACT_VERSION, type OcrEngine, type OcrEngineFactory, type OcrResult, type OcrLine, type OcrWord, type RawResult } from "./engine";
