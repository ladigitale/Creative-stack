import { PublisherManager } from "@supersoniks/concorde/utils";
import { parse } from "./parse";
import type { Sonic3dAsset } from "./types";

/** Résout asset prioritaire : prop → src → DP. */
function resolve(
  host: { asset: Sonic3dAsset | null; src: string },
  formPublisher: ReturnType<typeof PublisherManager.get> | null,
): Sonic3dAsset | null {
  if (host.asset?.url || host.asset?.blob) return host.asset;
  const fromSrc = parse.asset(host.src);
  if (fromSrc) return fromSrc;
  const data = (formPublisher?.get() ?? {}) as Record<string, unknown>;
  if ("asset" in data) {
    const a = parse.asset(data.asset);
    if (a) return a;
  }
  if ("src" in data) return parse.asset(data.src);
  return null;
}

export const asset = { resolve } as const;
