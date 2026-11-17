/**
 * Finis par rôle (procgen) : `{"metal": "chrome", "cloth1": "velours", "maillot": {"fini": "cuir", "rough": 0.3}}`.
 * Mêmes finis que le format monde (rugosité, métal, reflet de tissu, vernis) ; le verre et l'opacité n'ont pas
 * d'équivalent dans le rendu procgen (couleurs par rôle) et sont ignorés.
 */
import { readFinish, type Finish } from "../../../shared/monde/format";
import { genRole } from "../../../shared/monde/gen";
import { ROLES } from "./roles";

export type RoleFinishes = Partial<Record<string, Finish>>;

/** Lecture des finis par rôle (noms procgen ou du format : `maillot` → `cloth1`). */
export function readRoleFinishes(v: unknown, issue: (path: string, message: string) => void): RoleFinishes {
  const out: RoleFinishes = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const r = genRole(k, ROLES);
    if (!r) {
      issue(k, `rôle « ${k} » inconnu`);
      continue;
    }
    const f = readFinish(raw, (m) => issue(k, m));
    if (f) out[r] = f;
  }
  return out;
}

/** Tableau d'uniformes `uRoleMat` (vec4 par rôle : rugosité + 1, métal, tissu, vernis ; 0 = rôle sans fini). */
export function encodeRoleFinishes(...layers: RoleFinishes[]): Float32Array {
  const a = new Float32Array(ROLES.length * 4);
  for (const layer of layers)
    for (const [r, f] of Object.entries(layer)) {
      const i = (ROLES as readonly string[]).indexOf(r);
      if (i < 0 || !f) continue;
      a[i * 4] = (f.rough >= 0 ? f.rough : 0.5) + 1;
      a[i * 4 + 1] = f.metal;
      a[i * 4 + 2] = f.sheen;
      a[i * 4 + 3] = f.clear;
    }
  return a;
}
