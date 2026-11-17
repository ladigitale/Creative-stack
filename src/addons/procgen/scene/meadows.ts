/**
 * Prairies de `sonic-procgen` (clé de recette `meadows`) : herbes hautes, blé, roseaux, prairies fleuries, gazon, en
 * brins instanciés semés sur une zone. Lecture et semis communs avec le format monde de `sonic-3d`
 * (`shared/monde/herbes.ts`) ; ici, l'adaptation à une scène procgen : zone par défaut (toute la scène) ou nommée
 * (`zones`), brins posés sur le relief, sol libre sur les routes, l'eau et sous les objets qui ne se traversent pas.
 * Pur, sans DOM (testable) ; le rendu (vent et ploiement dans le shader) est dans `render/meadows.ts`.
 */
import { HERBE_BUDGET, type HerbeField, readHerbes, shares, sowField } from "../../../shared/monde/herbes";
import type { Issues } from "../core/schema";
import type { Terrain } from "./terrain";

/** Champ semé : `blades` = `x y z cap hauteur teinte` par brin (6 nombres) ; `custom` : couleurs données par la recette. */
export type Meadow = { field: HerbeField; blades: Float32Array; custom: boolean };

/** Ce qu'un champ doit éviter : emprises des objets (repère monde), terrain (routes, eau). */
export type MeadowObstacle = { x: number; z: number; hx: number; hz: number; yaw: number };

type ZoneLike = { id: string; x: number; z: number; r: number; box: [number, number, number, number] | null };

/** Budget de brins de la scène : `meadowDetail` 0, 1, 2 ou `auto` (0 sur mobile, 1 sinon). */
export function meadowBudget(detail: unknown, mobile: boolean): number {
  const d = typeof detail === "number" && Number.isFinite(detail) ? Math.max(0, Math.min(2, Math.round(detail))) : mobile ? 0 : 1;
  return HERBE_BUDGET[d];
}

/** Normalise les entrées : zone absente = toute la scène, zone nommée = rectangle ou cercle (polygone) de `zones`. */
export function readMeadows(v: unknown, size: [number, number], zones: ZoneLike[], issues: Issues): { fields: HerbeField[]; custom: boolean[] } {
  if (v === undefined || v === null || v === false) return { fields: [], custom: [] };
  const list = (Array.isArray(v) ? v : [v]).slice(0, 16);
  const W = size[0] / 2, D = size[1] / 2;
  const kept: Record<string, unknown>[] = [];
  const index: number[] = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.add({ path: `meadows.${i}`, code: "type", message: "champ attendu : {kind, zone, density, height…}" });
      return;
    }
    const o = { ...(raw as Record<string, unknown>) };
    if (o.kind === undefined && o.type === undefined && typeof o.species === "string") o.kind = o.species;
    const z = o.zone;
    if (z === undefined || z === null) o.zone = [-W, -D, W, D];
    else if (typeof z === "string") {
      const zn = zones.find((q) => q.id === z);
      if (!zn) {
        issues.add({ path: `meadows.${i}.zone`, code: "unknown", message: `zone « ${z} » introuvable`, hint: zones.map((q) => q.id).join(", ") });
        return;
      }
      if (zn.box) o.zone = zn.box;
      else o.zone = Array.from({ length: 20 }, (_, k) => [zn.x + Math.cos((k / 20) * Math.PI * 2) * zn.r, zn.z + Math.sin((k / 20) * Math.PI * 2) * zn.r]);
    }
    if (o.seed === undefined && o.graine === undefined) o.seed = i * 7919 + 13;
    kept.push(o);
    index.push(i);
  });
  const raw: { path: string; message: string }[] = [];
  const read = readHerbes(kept, raw);
  const dropped = new Set<number>();
  for (const r of raw) {
    const m = /^herbes\.(\d+)(.*)$/.exec(r.path);
    if (m) dropped.add(Number(m[1]));
    issues.add({ path: m ? `meadows.${index[Number(m[1])]}${m[2]}` : "meadows", code: /inconnue/.test(r.message) ? "unknown" : "type", message: r.message });
  }
  // couleurs données par la recette (sinon : couleurs de la sorte, accordées au style au rendu)
  const src = kept.filter((_, k) => !dropped.has(k));
  const fields: HerbeField[] = [], custom: boolean[] = [];
  read.forEach((f, k) => {
    // champ ramené à la scène
    f.rect = [Math.max(-W, f.rect[0]), Math.max(-D, f.rect[1]), Math.min(W, f.rect[2]), Math.min(D, f.rect[3])];
    if (f.rect[2] <= f.rect[0] || f.rect[3] <= f.rect[1]) return;
    fields.push(f);
    custom.push(["pied", "base", "pointe", "tip", "fleurs", "flowers"].some((key) => src[k]?.[key] !== undefined));
  });
  return { fields, custom };
}

/**
 * Masque du sol semable (routes, rivières, eau) sur une grille, et emprises des objets par case de 2 m : le test d'un
 * brin coûte une lecture de grille et quelques boîtes, quel que soit le nombre de routes et d'objets.
 */
export function meadowKeep(size: [number, number], terrain: Terrain | null, obstacles: MeadowObstacle[]): { ground: (x: number, z: number) => boolean; all: (x: number, z: number) => boolean } {
  const [w, d] = size;
  const cell = Math.max(0.25, Math.sqrt((w * d) / 60000));
  const nx = Math.ceil(w / cell), nz = Math.ceil(d / cell);
  const ok = new Uint8Array(nx * nz);
  const water = terrain?.spec.water ?? null;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x = -w / 2 + (i + 0.5) * cell, z = -d / 2 + (j + 0.5) * cell;
      let good = true;
      if (terrain) {
        const pi = terrain.pathInfo(x, z);
        if (pi.path) {
          const margin = pi.path.kind === "street" ? pi.path.sidewalk + 0.1 : pi.path.kind === "path" ? 0.05 : pi.path.kind === "river" ? -0.2 : 0.15;
          if (pi.d < margin) good = false;
        }
        if (good && water !== null && terrain.height(x, z) < water + 0.03) good = false;
      }
      ok[j * nx + i] = good ? 1 : 0;
    }
  const B = 2;
  const bx = Math.ceil(w / B), bz = Math.ceil(d / B);
  const buckets = new Map<number, MeadowObstacle[]>();
  for (const o of obstacles) {
    const r = Math.hypot(o.hx, o.hz);
    const i0 = Math.max(0, Math.floor((o.x - r + w / 2) / B)), i1 = Math.min(bx - 1, Math.floor((o.x + r + w / 2) / B));
    const j0 = Math.max(0, Math.floor((o.z - r + d / 2) / B)), j1 = Math.min(bz - 1, Math.floor((o.z + r + d / 2) / B));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * bx + i;
        const l = buckets.get(k);
        if (l) l.push(o);
        else buckets.set(k, [o]);
      }
  }
  const ground = (x: number, z: number) => {
    const i = Math.floor((x + w / 2) / cell), j = Math.floor((z + d / 2) / cell);
    return i >= 0 && j >= 0 && i < nx && j < nz && ok[j * nx + i] === 1;
  };
  const all = (x: number, z: number) => {
    if (!ground(x, z)) return false;
    const l = buckets.get(Math.floor((z + d / 2) / B) * bx + Math.floor((x + w / 2) / B));
    if (l)
      for (const o of l) {
        const dx = x - o.x, dz = z - o.z;
        const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) < o.hx && Math.abs(lz) < o.hz) return false;
      }
    return true;
  };
  return { ground, all };
}

/** Sème les champs dans le budget ; brins posés sur le relief. */
export function sowMeadows(fields: HerbeField[], custom: boolean[], budget: number, terrain: Terrain | null, keep: { ground: (x: number, z: number) => boolean; all: (x: number, z: number) => boolean }): Meadow[] {
  const parts = shares(fields, budget);
  return fields.map((f, i) => {
    const flat = sowField(f, parts[i], [], f.clear ? keep.all : keep.ground);
    const n = flat.length / 6;
    const out = new Float32Array(n * 6);
    for (let b = 0; b < n; b++) {
      const k = b * 6;
      const x = flat[k], z = flat[k + 1];
      out[k] = x;
      out[k + 1] = terrain ? terrain.height(x, z) : 0;
      out[k + 2] = z;
      out[k + 3] = flat[k + 2];
      out[k + 4] = flat[k + 3];
      out[k + 5] = flat[k + 4];
    }
    return { field: f, blades: out, custom: !!custom[i] };
  });
}
