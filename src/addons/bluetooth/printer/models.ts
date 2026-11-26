import { catProtocol } from "./cat";
import { escposProtocol } from "./escpos";
import { luckProtocol } from "./luck";
import { NIIMBOT_MODELS, NIIMBOT_TASKS, niimbotProtocol, type NiimbotTask } from "./niimbot";
import { PHOMEMO_VARIANTS, phomemoProtocol, type PhomemoVariant } from "./phomemo";
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
 * Protocoles disponibles. `niimbot` choisit la variante d'après le modèle lu sur l'imprimante ; `niimbot-<variante>`
 * l'impose. `phomemo` choisit d'après le nom de l'appareil ; `phomemo-<variante>` l'impose.
 */
export const PROTOCOLS = [
  "luck-aiyin", "luck-lujiang", "escpos", "niimbot", "niimbot-d110", "niimbot-b1", "niimbot-d11v1", "niimbot-b21v1", "niimbot-v4",
  "cat", "phomemo", "phomemo-m02", "phomemo-m110", "phomemo-d30",
] as const;
export type ProtocolId = (typeof PROTOCOLS)[number];

export function createProtocol(id: string): PrinterProtocol | null {
  if (id === "luck-aiyin") return luckProtocol("aiyin");
  if (id === "luck-lujiang") return luckProtocol("lujiang");
  if (id === "escpos") return escposProtocol();
  if (id === "niimbot") return niimbotProtocol();
  if (id === "cat") return catProtocol();
  if (id === "phomemo") return phomemoProtocol();
  if (id.startsWith("phomemo-") && PHOMEMO_VARIANTS.includes(id.slice(8) as PhomemoVariant)) return phomemoProtocol(id.slice(8) as PhomemoVariant);
  if (id.startsWith("niimbot-") && NIIMBOT_TASKS.includes(id.slice(8) as NiimbotTask)) return niimbotProtocol(id.slice(8) as NiimbotTask);
  return null;
}

const CAT_MODEL: PrinterModel = { protocol: "cat", widthPx: 384, dpi: 203, labelMm: [60, 48] };

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
  // Imprimantes « chat » : papier continu de 57 mm, 48 mm imprimables.
  ...(["GB01", "GB02", "GB03", "GT01", "YT01", "MX05", "MX06", "MX07", "MX08", "MX09", "MX10", "X5"] as const).map((n): [string, PrinterModel] => [n, CAT_MODEL]),
  // Phomemo : tickets (M02, T02), étiquettes (M110), petites étiquettes (D30).
  ...(["M02", "T02"] as const).map((n): [string, PrinterModel] => [n, { protocol: "phomemo-m02", widthPx: 384, dpi: 203, labelMm: [60, 48] }]),
  ...(["M110", "M120", "M200"] as const).map((n): [string, PrinterModel] => [n, { protocol: "phomemo-m110", widthPx: 384, dpi: 203, labelMm: [40, 30] }]),
  ...(["D30", "D35"] as const).map((n): [string, PrinterModel] => [n, { protocol: "phomemo-d30", widthPx: 96, dpi: 203, labelMm: [40, 12] }]),
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
  cat: CAT_MODEL,
  phomemo: { protocol: "phomemo", widthPx: 384, dpi: 203, labelMm: [60, 48] },
  "phomemo-m02": { protocol: "phomemo-m02", widthPx: 384, dpi: 203, labelMm: [60, 48] },
  "phomemo-m110": { protocol: "phomemo-m110", widthPx: 384, dpi: 203, labelMm: [40, 30] },
  "phomemo-d30": { protocol: "phomemo-d30", widthPx: 96, dpi: 203, labelMm: [40, 12] },
};

/** Protocole supposé quand le nom n'est pas reconnu, d'après le profil retenu par le transport. */
export function protocolFromProfile(profile: string | undefined): ProtocolId {
  if (profile === "niimbot") return "niimbot";
  if (profile === "cat") return "cat";
  if (profile === "phomemo") return "phomemo";
  return "luck-aiyin";
}

/** Le modèle reconnu au nom convient-il au protocole choisi (même famille) ? */
export function sameFamily(a: string, b: string): boolean {
  const family = (id: string): string => (id.startsWith("niimbot") ? "niimbot" : id.startsWith("phomemo") ? "phomemo" : id);
  return family(a) === family(b);
}

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
