/**
 * Personnage construit ↔ données transférables (worker, cache du navigateur).
 *
 * Les attributs du maillage voyagent en `Float32Array` (et `Uint32Array` pour les indices) : c'est la précision que
 * reçoit la carte graphique (`toGeometry`), le rendu est donc le même qu'une construction sur place. Le squelette est
 * reconstruit depuis ses os, le reste est de la donnée simple.
 */
import { Mesh } from "../../geom/mesh";
import { type BoneDef, Skeleton } from "../../rig/skeleton";
import type { Built } from "./build";

const F32 = ["pos", "nrm", "role", "ao", "flex", "obj"] as const;
const F32_OPT = ["skin", "weight", "morph", "blend"] as const;

export type PackedMesh = Record<(typeof F32)[number], Float32Array> & Record<(typeof F32_OPT)[number], Float32Array | null> & { idx: Uint32Array };
export type PackedBuilt = Omit<Built, "mesh" | "skeleton"> & { mesh: PackedMesh; bones: BoneDef[] };

export function packBuilt(b: Built, transfer?: Transferable[]): PackedBuilt {
  const m = b.mesh;
  const mesh = { idx: new Uint32Array(m.idx) } as PackedMesh;
  for (const k of F32) mesh[k] = new Float32Array(m[k]);
  for (const k of F32_OPT) mesh[k] = m[k] ? new Float32Array(m[k]!) : null;
  if (transfer) for (const v of Object.values(mesh)) if (v) transfer.push(v.buffer);
  const expr = b.expr ? { ...b.expr, data: new Float32Array(b.expr.data) } : undefined;
  if (expr && transfer) transfer.push(expr.data.buffer);
  return {
    mesh,
    bones: b.skeleton.bones.map((d) => ({ ...d })),
    anchors: b.anchors,
    footprint: b.footprint,
    height: b.height,
    soft: b.soft,
    ...(expr ? { expr } : {}),
  };
}

/**
 * Personnage reconstruit. Les attributs restent en tableaux typés (sans recopie) : ils ne sont que lus ensuite
 * (`toGeometry`, longueurs, lectures indexées), comme les maillages des tuiles du monde infini.
 */
export function unpackBuilt(d: PackedBuilt): Built {
  const m = new Mesh();
  const a = m as unknown as Record<string, unknown>;
  for (const k of F32) a[k] = d.mesh[k];
  for (const k of F32_OPT) a[k] = d.mesh[k];
  a.idx = d.mesh.idx;
  return {
    mesh: m,
    skeleton: new Skeleton(d.bones),
    anchors: d.anchors,
    footprint: d.footprint,
    height: d.height,
    soft: d.soft,
    ...(d.expr ? { expr: d.expr } : {}),
  };
}
