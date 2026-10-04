import { Sonic3dCameraMode } from "./constants";
import type { Sonic3dAsset, Sonic3dAssetKind } from "./types";
import { toMediaUrl } from "../../shared/mediaRef";

const ASSET_KINDS: readonly Sonic3dAssetKind[] = [
  "gltf",
  "glb",
  "obj",
  "ply",
  "url",
];

function guessKind(url: string): Sonic3dAssetKind {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".glb")) return "glb";
  if (path.endsWith(".gltf")) return "gltf";
  if (path.endsWith(".obj")) return "obj";
  if (path.endsWith(".ply")) return "ply";
  return "url";
}

/** Parse `camera` attr → mode connu ou Orbit. */
function parseCameraMode(
  value: string | null | undefined,
): Sonic3dCameraMode {
  const s = (value ?? "").trim().toLowerCase();
  if (
    s === Sonic3dCameraMode.Perspective ||
    s === Sonic3dCameraMode.Ortho ||
    s === Sonic3dCameraMode.Orbit
  ) {
    return s;
  }
  return Sonic3dCameraMode.Orbit;
}

/** Normalise une valeur DP / attr en `Sonic3dAsset | null`. */
function parseAsset(value: unknown): Sonic3dAsset | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const url = value.trim();
    return url ? { kind: guessKind(url), url } : null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const fromMedia = toMediaUrl(record);
  const urlFromField =
    typeof record.url === "string" ? record.url.trim() : "";
  const url = urlFromField || fromMedia || "";
  const blob = record.blob instanceof Blob ? record.blob : undefined;
  if (!url && !blob) return null;
  const kindRaw =
    typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  let kind: Sonic3dAssetKind;
  if (ASSET_KINDS.includes(kindRaw as Sonic3dAssetKind)) {
    kind = kindRaw as Sonic3dAssetKind;
  } else if (url) {
    kind = guessKind(url);
  } else {
    kind = "url";
  }
  const asset: Sonic3dAsset = { kind };
  if (url) asset.url = url;
  if (blob) asset.blob = blob;
  if (record.morphTargets && typeof record.morphTargets === "object") {
    asset.morphTargets = record.morphTargets as Record<string, number>;
  }
  return asset;
}

function toNum(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Flag form type checkbox unique : uniquement les valeurs explicitement vraies.
 * `null` / absent / `"false"` → false (pas de fallback « garder l’ancien »).
 */
function isFormFlagOn(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "on";
}

/** Parse / coerce helpers for sonic-3d attrs & form DP. */
export const parse = {
  cameraMode: parseCameraMode,
  asset: parseAsset,
  guessKind,
  toNum,
  isFormFlagOn,
} as const;
