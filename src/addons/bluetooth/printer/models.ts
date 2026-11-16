import { escposProtocol } from "./escpos";
import { luckProtocol } from "./luck";
import { NIIMBOT_MODELS, NIIMBOT_TASKS, niimbotProtocol, type NiimbotTask } from "./niimbot";
import type { PrinterProtocol } from "./protocol";

export type PrinterModel = {
  protocol: string;
  /** Largeur de la tête en points. */
  widthPx: number;
  dpi: number;
  /** Étiquette par défaut, longueur × largeur en millimètres. */
  labelMm: [number, number];
};

/**
 * Protocoles disponibles dans cette version (`cat`, `phomemo` : prévus, pas encore écrits).
 * `niimbot` choisit la variante d'après le modèle lu sur l'imprimante ; `niimbot-<variante>` l'impose.
 */
export const PROTOCOLS = ["luck-aiyin", "luck-lujiang", "escpos", "niimbot", "niimbot-d110", "niimbot-b1", "niimbot-d11v1", "niimbot-b21v1", "niimbot-v4"] as const;
export type ProtocolId = (typeof PROTOCOLS)[number];

export function createProtocol(id: string): PrinterProtocol | null {
  if (id === "luck-aiyin") return luckProtocol("aiyin");
  if (id === "luck-lujiang") return luckProtocol("lujiang");
  if (id === "escpos") return escposProtocol();
  if (id === "niimbot") return niimbotProtocol();
  if (id.startsWith("niimbot-") && NIIMBOT_TASKS.includes(id.slice(8) as NiimbotTask)) return niimbotProtocol(id.slice(8) as NiimbotTask);
  return null;
}

/** Préfixe du nom annoncé → modèle. Le plus long préfixe gagne. */
const BY_NAME: [string, PrinterModel][] = [
  ["FICHERO", { protocol: "luck-aiyin", widthPx: 96, dpi: 203, labelMm: [30, 12] }],
  ["D11s_", { protocol: "luck-aiyin", widthPx: 96, dpi: 203, labelMm: [30, 12] }],
  // Niimbot : le nom annoncé est le modèle suivi d'un numéro de série (« D110-E1234… »). Le modèle exact est
  // confirmé ensuite par la réponse de l'imprimante.
  ...(["D11-", "D11S-", "D110", "B16", "B18"] as const).map((n): [string, PrinterModel] => [n, { protocol: "niimbot", widthPx: 96, dpi: 203, labelMm: [30, 12] }]),
  ["D101", { protocol: "niimbot", widthPx: 192, dpi: 203, labelMm: [40, 25] }],
  ["D11_H", { protocol: "niimbot", widthPx: 136, dpi: 300, labelMm: [30, 12] }],
  ...(["B1-", "B1_", "B21", "B3S"] as const).map((n): [string, PrinterModel] => [n, { protocol: "niimbot", widthPx: 384, dpi: 203, labelMm: [50, 30] }]),
];

/** Modèle confirmé par la réponse de l'imprimante (`10 FF 20 F0`). */
const BY_MODEL: Record<string, PrinterModel> = {
  D11s: { protocol: "luck-aiyin", widthPx: 96, dpi: 203, labelMm: [30, 12] },
  ...Object.fromEntries(Object.values(NIIMBOT_MODELS).map((m) => [m.name, { protocol: "niimbot", widthPx: m.widthPx, dpi: m.dpi, labelMm: m.labelMm }])),
};

export const DEFAULT_MODELS: Record<ProtocolId, PrinterModel> = {
  "luck-aiyin": { protocol: "luck-aiyin", widthPx: 96, dpi: 203, labelMm: [30, 12] },
  "luck-lujiang": { protocol: "luck-lujiang", widthPx: 96, dpi: 203, labelMm: [30, 12] },
  escpos: { protocol: "escpos", widthPx: 384, dpi: 203, labelMm: [60, 48] },
  ...(Object.fromEntries(
    (["niimbot", "niimbot-d110", "niimbot-b1", "niimbot-d11v1", "niimbot-b21v1", "niimbot-v4"] as const).map((id) => [id, { protocol: id, widthPx: 96, dpi: 203, labelMm: [30, 12] }]),
  ) as Record<"niimbot" | `niimbot-${NiimbotTask}`, PrinterModel>),
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
