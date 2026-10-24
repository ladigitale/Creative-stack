import type { NodePatch } from "../../shared/nodes";
import type { BodyState } from "./core";

/**
 * Projection des corps vers le format `nodes` partagé (src/shared/nodes.ts) : un rendu
 * (`sonic-3d`, `sonic-stage`) pointé sur `<id>State` suit les corps sans adaptateur.
 * `xz` / `xy` posent le monde 2D (px, y vers le bas) sur un plan 3D (y vers le haut) ;
 * `screen` garde le repère de l'écran (y vers le bas) pour une scène 2D.
 */
export type NodesMap = {
  /** `xz` : table vue de dessus (x → x, y → z, hauteur y fixe). `xy` : mur (x → x, y → -y). `screen` : 2D, y vers le bas. */
  plane: "xz" | "xy" | "screen";
  /** Unités 3D par pixel du monde. */
  scale: number;
  /** Point du monde (px) placé à l'origine 3D. */
  origin: [number, number];
  /** Hauteur fixe des nœuds sur le plan `xz` (absent : non publiée, le nœud garde sa hauteur). */
  height?: number;
  /** Interpolation (ms) ajoutée à chaque nœud (`ease.ms`) : lisse le rendu entre deux publications. */
  ease?: number;
};

const RAD = Math.PI / 180;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function parseNodesMap(
  plane: string,
  scale: number,
  origin: string,
  height: string,
  world: { width: number; height: number },
): NodesMap | null {
  const p = plane.trim().toLowerCase();
  if (!p && !(scale > 0)) return null;
  const kind: NodesMap["plane"] = p === "xy" ? "xy" : p === "screen" ? "screen" : "xz";
  const nums = origin.trim().split(/[\s,]+/).map(Number);
  const fallback: [number, number] = kind === "screen" ? [0, 0] : [world.width / 2, world.height / 2];
  const o: [number, number] = nums.length >= 2 && nums.every(Number.isFinite) ? [nums[0], nums[1]] : fallback;
  const h = height.trim() === "" ? undefined : Number(height);
  return {
    plane: kind,
    scale: scale > 0 ? scale : kind === "screen" ? 1 : 0.01,
    origin: o,
    height: h !== undefined && Number.isFinite(h) ? h : undefined,
  };
}

export function toNodes(bodies: Record<string, BodyState>, m: NodesMap): Record<string, NodePatch> {
  const out: Record<string, NodePatch> = {};
  const ease = m.ease && m.ease > 0 ? { ms: m.ease } : undefined;
  for (const [name, b] of Object.entries(bodies)) {
    const x = r4((b.x - m.origin[0]) * m.scale);
    const d = r4((b.y - m.origin[1]) * m.scale);
    const a = r4(-b.angle * RAD);
    if (m.plane === "screen") {
      out[name] = { x, y: d, rz: r4(b.angle * RAD), ...(ease ? { ease } : {}) };
    } else if (m.plane === "xz") {
      const n: NodePatch = { x, z: d, ry: a };
      if (m.height !== undefined) n.y = m.height;
      if (ease) n.ease = ease;
      out[name] = n;
    } else {
      out[name] = { x, y: r4(-d), rz: a, ...(ease ? { ease } : {}) };
    }
  }
  return out;
}
