import * as THREE from "three";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { parse } from "./parse";
import type { Sonic3dAsset } from "./types";
import { demoContent } from "./demo-content";
import { pick, type HighlightCtx } from "./pick";

export type LoadCtx = HighlightCtx & {
  root: THREE.Group;
  content: THREE.Object3D | null;
  bbox: THREE.Box3;
  blobUrl: string | null;
  loader: GLTFLoader;
  fitEnabled: boolean;
  fitToContent: () => void;
};

function revokeBlob(ctx: { blobUrl: string | null }) {
  if (ctx.blobUrl) {
    try {
      URL.revokeObjectURL(ctx.blobUrl);
    } catch {
      /* ignore */
    }
    ctx.blobUrl = null;
  }
}

function clearContent(ctx: LoadCtx) {
  pick.clearHighlight(ctx);
  if (!ctx.content) return;
  ctx.root.remove(ctx.content);
  ctx.content.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const m of mats) m?.dispose?.();
    }
  });
  ctx.content = null;
  ctx.bbox.makeEmpty();
}

function updateBBox(ctx: LoadCtx) {
  ctx.bbox.makeEmpty();
  if (ctx.content) ctx.bbox.setFromObject(ctx.content);
}

function applyMorphTargets(
  root: THREE.Object3D,
  weights: Record<string, number>,
) {
  root.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences)
      return;
    for (const [name, w] of Object.entries(weights)) {
      const idx = mesh.morphTargetDictionary[name];
      if (idx !== undefined) {
        mesh.morphTargetInfluences[idx] = w;
      }
    }
  });
}

/**
 * Charge un asset (URL / blob) ou affiche le cube de démo si vide.
 * Retourne `{ ready, error }` ; lève si load échoue après fallback démo.
 */
async function asset(
  ctx: LoadCtx,
  asset: Sonic3dAsset | null,
  token: number,
  isCurrent: (t: number) => boolean,
): Promise<{ ready: boolean; error: string | null }> {
  clearContent(ctx);

  try {
    let url = asset?.url?.trim() ?? "";
    if (!url && asset?.blob) {
      revokeBlob(ctx);
      ctx.blobUrl = URL.createObjectURL(asset.blob);
      url = ctx.blobUrl;
    }

    if (!url) {
      ctx.content = demoContent.create();
      ctx.root.add(ctx.content);
    } else {
      const kind = asset?.kind ?? parse.guessKind(url);
      if (kind === "obj" || kind === "ply") {
        throw new Error(
          `Format "${kind}" non supporté en V1 — utilisez glTF/GLB.`,
        );
      }
      const gltf = await ctx.loader.loadAsync(url);
      if (!isCurrent(token)) return { ready: false, error: null };
      ctx.content = gltf.scene;
      ctx.root.add(ctx.content);
      if (asset?.morphTargets) {
        applyMorphTargets(ctx.content, asset.morphTargets);
      }
    }

    if (!isCurrent(token)) return { ready: false, error: null };
    updateBBox(ctx);
    if (ctx.fitEnabled) ctx.fitToContent();
    return { ready: true, error: null };
  } catch (err) {
    if (!isCurrent(token)) return { ready: false, error: null };
    const error = err instanceof Error ? err.message : String(err);
    ctx.content = demoContent.create();
    ctx.root.add(ctx.content);
    updateBBox(ctx);
    if (ctx.fitEnabled) ctx.fitToContent();
    throw err instanceof Error ? err : new Error(error);
  }
}

export const load = {
  asset,
  applyMorphTargets,
  clearContent,
  updateBBox,
  revokeBlob,
} as const;
