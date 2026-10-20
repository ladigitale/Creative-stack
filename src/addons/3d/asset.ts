import { PublisherManager } from "@supersoniks/concorde/utils";
import { parse } from "./parse";
import { DEFAULT_MAX_GLB_BYTES } from "./constants";
import type { Sonic3dAsset } from "./types";

type ResolveHost = {
  asset: Sonic3dAsset | null;
  src: string;
  glb?: string;
  maxGlbBytes?: number;
};

function withLimit(a: Sonic3dAsset | null, host: ResolveHost, data: Record<string, unknown>) {
  if (a?.glb && a.maxBytes === undefined) {
    const fromData = "maxGlbBytes" in data ? Number(data.maxGlbBytes) : NaN;
    const max = Number.isFinite(fromData) ? fromData : host.maxGlbBytes;
    a.maxBytes = max && max > 0 ? max : DEFAULT_MAX_GLB_BYTES;
  }
  return a;
}

/** Résout asset prioritaire : prop asset → glb → src → DP (glb, asset, src). */
function resolve(
  host: ResolveHost,
  formPublisher: ReturnType<typeof PublisherManager.get> | null,
): Sonic3dAsset | null {
  const data = (formPublisher?.get() ?? {}) as Record<string, unknown>;
  if (host.asset?.url || host.asset?.blob || host.asset?.glb) {
    return withLimit(host.asset, host, data);
  }
  if (host.glb) return withLimit(parse.asset({ glb: host.glb }), host, data);
  const fromSrc = parse.asset(host.src);
  if (fromSrc) return withLimit(fromSrc, host, data);
  if ("glb" in data && typeof data.glb === "string" && data.glb) {
    return withLimit(parse.asset({ glb: data.glb }), host, data);
  }
  if ("asset" in data) {
    const a = parse.asset(data.asset);
    if (a) return withLimit(a, host, data);
  }
  if ("src" in data) return withLimit(parse.asset(data.src), host, data);
  return null;
}

export const asset = { resolve } as const;
