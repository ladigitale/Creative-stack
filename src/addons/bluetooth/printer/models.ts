import { escposProtocol } from "./escpos";
import { luckProtocol } from "./luck";
import type { PrinterProtocol } from "./protocol";

export type PrinterModel = {
  protocol: string;
  /** Largeur de la tête en points. */
  widthPx: number;
  dpi: number;
  /** Étiquette par défaut, longueur × largeur en millimètres. */
  labelMm: [number, number];
};

/** Protocoles disponibles dans cette version (`cat`, `phomemo`, `niimbot` : prévus, pas encore écrits). */
export const PROTOCOLS = ["luck-aiyin", "luck-lujiang", "escpos"] as const;
export type ProtocolId = (typeof PROTOCOLS)[number];

export function createProtocol(id: string): PrinterProtocol | null {
  if (id === "luck-aiyin") return luckProtocol("aiyin");
  if (id === "luck-lujiang") return luckProtocol("lujiang");
  if (id === "escpos") return escposProtocol();
  return null;
}

/** Préfixe du nom annoncé → modèle. Le plus long préfixe gagne. */
const BY_NAME: [string, PrinterModel][] = [
  ["FICHERO", { protocol: "luck-aiyin", widthPx: 96, dpi: 203, labelMm: [30, 12] }],
  ["D11s_", { protocol: "luck-aiyin", widthPx: 96, dpi: 203, labelMm: [30, 12] }],
];

/** Modèle confirmé par la réponse de l'imprimante (`10 FF 20 F0`). */
const BY_MODEL: Record<string, PrinterModel> = {
  D11s: { protocol: "luck-aiyin", widthPx: 96, dpi: 203, labelMm: [30, 12] },
};

export const DEFAULT_MODELS: Record<ProtocolId, PrinterModel> = {
  "luck-aiyin": { protocol: "luck-aiyin", widthPx: 96, dpi: 203, labelMm: [30, 12] },
  "luck-lujiang": { protocol: "luck-lujiang", widthPx: 96, dpi: 203, labelMm: [30, 12] },
  escpos: { protocol: "escpos", widthPx: 384, dpi: 203, labelMm: [60, 48] },
};

export function modelFromName(name: string): PrinterModel | null {
  let best: [string, PrinterModel] | null = null;
  for (const entry of BY_NAME) {
    if (name.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

export function modelFromReply(model: string | null): PrinterModel | null {
  return model && Object.prototype.hasOwnProperty.call(BY_MODEL, model) ? BY_MODEL[model] : null;
}
