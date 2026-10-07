/**
 * URL de média acceptées par les composants creative-stack :
 * https, blob:, relative (même origine), et data: du type attendu.
 * Refuse javascript:, http: et tout autre schéma.
 */
export function safeMediaUrl(url: string, kind: "audio" | "video" | "image"): boolean {
  const u = String(url ?? "").trim();
  if (!u) return false;
  if (/^(javascript|vbscript|file):/i.test(u)) return false;
  if (/^data:/i.test(u)) return new RegExp(`^data:${kind}/`, "i").test(u);
  if (/^blob:/i.test(u)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return /^https:/i.test(u);
  return !u.startsWith("//");
}
