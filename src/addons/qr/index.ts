/** Addon qr : QR codes dessinés en SVG, lecteur de QR codes et flux de QR codes animés (fichier d'un écran à une caméra). */
export { SonicQr, type QrState } from "./qr";
export { SonicQrReader, JSQR_SCRIPT, JSQR_SRI, JSQR_VERSION, loadJsQr, type QrReaderSettings, type QrReaderState } from "./reader";
export { SonicQrSender, type QrSenderSettings, type QrSenderState } from "./sender";
export { SonicQrReceiver, type QrReceivedFile, type QrReceiverState } from "./receiver";
export { MAX_QR_TEXT, qrMatrix, qrPath, safeHref, sanitizeEcc, type QrEcc, type QrMatrix } from "./core";
export {
  QR_STREAM_CHUNK,
  QR_STREAM_MAX_BYTES,
  QR_STREAM_PREFIX,
  QrStreamAssembler,
  base64ToBytes,
  bytesToBase64,
  parseDataUrl,
  qrStreamFrames,
  qrStreamHash,
  type QrStreamFile,
  type QrStreamMeta,
} from "./stream";
