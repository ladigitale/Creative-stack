import * as THREE from "three";

export type SceneHit = {
  x: number;
  y: number;
  z: number;
  objectId: string;
};

export type PickCtx = {
  content: THREE.Object3D | null;
  activeCam: THREE.Camera;
  raycaster: THREE.Raycaster;
  pointerNdc: THREE.Vector2;
};

export type HighlightCtx = PickCtx & {
  highlighted: THREE.Mesh | null;
  prevEmissive: THREE.Color;
  prevEmissiveIntensity: number;
};

function raycastHits(
  ctx: PickCtx,
  normX: number,
  normY: number,
): THREE.Intersection[] {
  if (!ctx.content) return [];
  ctx.pointerNdc.set(normX * 2 - 1, -(normY * 2 - 1));
  ctx.raycaster.setFromCamera(ctx.pointerNdc, ctx.activeCam);
  return ctx.raycaster.intersectObject(ctx.content, true);
}

function hitFromIntersection(h: THREE.Intersection): SceneHit {
  return {
    x: h.point.x,
    y: h.point.y,
    z: h.point.z,
    objectId: h.object.name || h.object.uuid,
  };
}

/** Pick en coords normalisées host (0–1, origine haut-gauche CSS). */
function hit(ctx: PickCtx, normX: number, normY: number): SceneHit | null {
  const hits = raycastHits(ctx, normX, normY);
  if (!hits.length) return null;
  return hitFromIntersection(hits[0]);
}

function clearHighlight(ctx: HighlightCtx) {
  if (!ctx.highlighted) return;
  const mat = ctx.highlighted.material;
  const std = (Array.isArray(mat) ? mat[0] : mat) as THREE.MeshStandardMaterial;
  if (std && "emissive" in std) {
    std.emissive.copy(ctx.prevEmissive);
    std.emissiveIntensity = ctx.prevEmissiveIntensity;
  }
  ctx.highlighted = null;
}

/** Survol : léger emissive sur le mesh sous le pointeur. */
function setHoverAt(
  ctx: HighlightCtx,
  normX: number,
  normY: number,
): SceneHit | null {
  const hits = raycastHits(ctx, normX, normY);
  const mesh = hits[0]?.object as THREE.Mesh | undefined;
  const next = mesh?.isMesh ? mesh : null;
  if (next === ctx.highlighted) {
    return hits.length ? hitFromIntersection(hits[0]) : null;
  }
  clearHighlight(ctx);
  if (!next) return null;
  const mat = next.material;
  const std = (Array.isArray(mat) ? mat[0] : mat) as THREE.MeshStandardMaterial;
  if (std && "emissive" in std) {
    ctx.highlighted = next;
    ctx.prevEmissive.copy(std.emissive);
    ctx.prevEmissiveIntensity = std.emissiveIntensity ?? 1;
    std.emissive.set(0x3b82f6);
    std.emissiveIntensity = 0.45;
  }
  return hitFromIntersection(hits[0]);
}

export const pick = {
  hit,
  setHoverAt,
  clearHighlight,
  raycastHits,
} as const;
