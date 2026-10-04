/**
 * Routage des canaux post-* (sonic-3d) : scene | depth | buffers | url | #id.
 */

export type PostPassId =
  | "image"
  | "bufferA"
  | "bufferB"
  | "bufferC"
  | "bufferD";

export type PostChannelSource =
  | { kind: "scene" }
  | { kind: "depth" }
  | { kind: "buffer"; buffer: Exclude<PostPassId, "image"> }
  | { kind: "self" }
  | { kind: "none" }
  | { kind: "url"; url: string }
  | { kind: "element"; key: string };

export type PostChannels = [
  PostChannelSource,
  PostChannelSource,
  PostChannelSource,
  PostChannelSource,
];

export type PostSources = {
  common: string;
  image: string;
  bufferA: string;
  bufferB: string;
  bufferC: string;
  bufferD: string;
};

/** Parse un slot canal post (défaut `scene` pour ch0 si vide). */
export function parsePostChannelSource(
  value: string | undefined | null,
  fallback: string,
  slot: 0 | 1 | 2 | 3,
): PostChannelSource {
  const v = (value ?? "").trim() || (fallback ?? "").trim();
  if (!v) return slot === 0 ? { kind: "scene" } : { kind: "none" };
  if (v.startsWith("#")) return { kind: "element", key: v };
  const lower = v.toLowerCase();
  if (lower === "scene") return { kind: "scene" };
  if (lower === "depth") return { kind: "depth" };
  if (lower === "self") return { kind: "self" };
  if (lower === "none" || lower === "null") return { kind: "none" };
  if (lower === "buffer-a" || lower === "buffera" || lower === "a") {
    return { kind: "buffer", buffer: "bufferA" };
  }
  if (lower === "buffer-b" || lower === "bufferb" || lower === "b") {
    return { kind: "buffer", buffer: "bufferB" };
  }
  if (lower === "buffer-c" || lower === "bufferc" || lower === "c") {
    return { kind: "buffer", buffer: "bufferC" };
  }
  if (lower === "buffer-d" || lower === "bufferd" || lower === "d") {
    return { kind: "buffer", buffer: "bufferD" };
  }
  return { kind: "url", url: v };
}

export function clampPostScale(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0.25, v));
}
