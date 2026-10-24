import type { BodyState } from "./core";

/**
 * Projection des corps 2D vers le format `nodes` de `sonic-3d` (un `sonic-3d dataProvider="monde"` suffit).
 * Le monde 2D (px, y vers le bas) est posé sur un plan de la scène 3D (y vers le haut).
 */
export type NodesMap = {
  /** `xz` : table vue de dessus (x → x, y → z, hauteur y fixe). `xy` : mur (x → x, y → -y). */
  plane: "xz" | "xy";
  /** Unités 3D par pixel du monde. */
  scale: number;
  /** Point du monde (px) placé à l'origine 3D. */
  origin: [number, number];
  /** Hauteur fixe des nœuds sur le plan `xz` (absent : non publiée, le nœud garde sa hauteur). */
  height?: number;
};

export type NodePatch = { x: number; y?: number; z?: number; ry?: number; rz?: number };

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
  const nums = origin.trim().split(/[\s,]+/).map(Number);
  const o: [number, number] =
    nums.length >= 2 && nums.every(Number.isFinite) ? [nums[0], nums[1]] : [world.width / 2, world.height / 2];
  const h = height.trim() === "" ? undefined : Number(height);
  return {
    plane: p === "xy" ? "xy" : "xz",
    scale: scale > 0 ? scale : 0.01,
    origin: o,
    height: h !== undefined && Number.isFinite(h) ? h : undefined,
  };
}

export function toNodes(bodies: Record<string, BodyState>, m: NodesMap): Record<string, NodePatch> {
  const out: Record<string, NodePatch> = {};
  for (const [name, b] of Object.entries(bodies)) {
    const x = r4((b.x - m.origin[0]) * m.scale);
    const d = r4((b.y - m.origin[1]) * m.scale);
    const a = r4(-b.angle * RAD);
    if (m.plane === "xz") {
      const n: NodePatch = { x, z: d, ry: a };
      if (m.height !== undefined) n.y = m.height;
      out[name] = n;
    } else {
      out[name] = { x, y: r4(-d), rz: a };
    }
  }
  return out;
}
