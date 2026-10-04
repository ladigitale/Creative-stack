import { toMediaUrl, mediaElementKey } from "../../shared/mediaRef";

export const LOG_PREFIX = "[sonic-webgpu]";

export const OUT_META_KEYS = [
  "time",
  "frame",
  "mouseX",
  "mouseY",
  "hovering",
] as const;

export const OUT_PARAM_KEYS = ["param0", "param1", "param2", "param3"] as const;

export const CHANNEL_FORM_KEYS = [
  "channel0",
  "channel1",
  "channel2",
  "channel3",
] as const;

export const FRAME_OUT_KEYS = ["frameUrl", "snapshot"] as const;

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function toNum(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** string (url / #id) | MediaRef → url | { element }. */
export function channelFormValue(value: unknown): string | undefined {
  if (value === null || value === "") return "";
  if (typeof value === "string") return value.trim();
  const url = toMediaUrl(value);
  if (url) return url;
  if (value && typeof value === "object") {
    const el = (value as { element?: unknown }).element;
    const key = mediaElementKey(el);
    if (key) return key;
    return undefined;
  }
  return "";
}
