import { isFrameSource } from "../../shared/mediaRef";
import { toGray, type Gray } from "./core/image";
import { isIosMotion, upInImage } from "./core/gravity";
import type { Pt } from "./core/homography";

/** Élément désigné par `#id` (même racine que `host`, sinon le document). */
export function resolveSource(host: Element, source: string): Element | null {
  if (!source.startsWith("#")) return null;
  const id = source.slice(1);
  const root = host.getRootNode() as ParentNode & { getElementById?: (id: string) => Element | null };
  return root.getElementById?.(id) ?? document.getElementById(id);
}

let scratch: HTMLCanvasElement | null = null;

/** Image courante d'une source (`sonic-camera`, `sonic-still`…) en gris, plus grand côté ≤ `maxSize`. */
export function grabGray(el: Element | null, maxSize: number): { gray: Gray; canvas: HTMLCanvasElement } | null {
  if (!el || !isFrameSource(el)) return null;
  const src = el.getFrameCanvas();
  if (!src || !src.width || !src.height) return null;
  const s = Math.min(1, Math.max(96, Math.min(1600, maxSize)) / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
  scratch ??= document.createElement("canvas");
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { gray: toGray(img.data, w, h), canvas: scratch };
}

/** « Haut » dans l'image depuis l'état de `sonic-orientation` (`ax`, `ay`, `angle`). */
export function upFromOrientation(v: unknown): Pt | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (o.ax === null || o.ay === null || o.ax === undefined || o.ay === undefined) return null;
  return upInImage(o.ax, o.ay, o.angle ?? 0, isIosMotion());
}
