/**
 * Finis par rôle (procgen) : `{"metal": "chrome", "cloth1": "velours", "maillot": {"fini": "cuir", "rough": 0.3}}`.
 * Mêmes finis que le format monde : rugosité, métal, reflet de tissu, vernis, et les **finis texturés** (relief,
 * profondeur, usure, occlusion des creux) tirés d'un motif des textures du format (brique, pierre, dalles…). Le
 * verre et l'eau sont rendus par un reflet de Fresnel sur un fond assombri (pas de transparence : rendu opaque) ;
 * l'opacité n'a pas d'équivalent et est ignorée.
 */
import { readFinish, type Finish } from "../../../shared/monde/format";
import { genRole } from "../../../shared/monde/gen";
import { readTex, type TexKind } from "../../../shared/monde/textures";
import { ROLES } from "./roles";

/** Motif des finis texturés : texture du format (sa seconde couleur = les creux) et répétitions par mètre. */
export type FinishMotif = { kind: TexKind; scale: number; seed: number };
/** Fini d'un rôle : celui du format, plus le motif des cartes (facultatif : sinon motif par défaut du fini ou du rôle). */
export type RoleFinish = Finish & { motif?: FinishMotif; base?: string };
export type RoleFinishes = Partial<Record<string, RoleFinish>>;

/** Motif par défaut d'un fini prêt (nom du format). */
const FINISH_MOTIF: Record<string, [TexKind, number]> = {
  pierre: ["pierre", 0.7],
  pave: ["dalles", 3.5],
  brique: ["brique", 2.5],
  ecorce: ["fourrure", 0.8],
  bois: ["bois", 1.5],
  cuir: ["grain", 3],
  tissu: ["tissu", 6],
  velours: ["moquette", 3],
  brosse: ["metal", 2],
  rouille: ["bruit", 3],
  caoutchouc: ["grain", 5],
};
/** Motif par défaut d'un rôle procgen (fini sans nom : modèle gen du format monde, valeurs réglées à la main). */
const ROLE_MOTIF: Partial<Record<string, [TexKind, number]>> = {
  ground: ["bruit", 1], grass: ["herbe", 2], path: ["gravier", 1.2], road: ["dalles", 3.5], stone: ["pierre", 0.7], wall: ["beton", 0.6],
  trim: ["pierre", 1.2], roof: ["ecailles", 2.5], wood: ["bois", 1.5], bark: ["fourrure", 0.8], metal: ["metal", 2], cloth1: ["tissu", 6],
  cloth2: ["tissu", 6], cloth3: ["tissu", 6], leather: ["grain", 3], snow: ["bruit", 2],
};
/** Rehausse propre à procgen : le caoutchouc du format est un simple mat ; ici un grain fin le distingue. */
const PROCGEN_EXTRA: Record<string, Partial<Finish>> = { caoutchouc: { relief: 0.25, ao: 0.2, sheen: 0.1 } };

/** Le fini a-t-il des cartes tirées d'un motif (relief, profondeur, usure, occlusion) ? */
export const hasTexMaps = (f: Finish) => f.relief > 0 || f.depth > 0 || f.wear > 0 || f.ao > 0;

/** Motif des cartes d'un rôle : écrit, sinon celui du fini prêt, sinon celui du rôle, sinon `bruit`. */
export function finishMotif(role: string, f: RoleFinish): FinishMotif {
  if (f.motif) return f.motif;
  const d = (f.base && FINISH_MOTIF[f.base]) || ROLE_MOTIF[role] || (["bruit", 3] as [TexKind, number]);
  return { kind: d[0], scale: d[1], seed: 7 };
}

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
    const f = readFinish(raw, (m) => issue(k, m)) as RoleFinish | null;
    if (!f) continue;
    const o = typeof raw === "string" ? { fini: raw } : (raw as Record<string, unknown>);
    if (typeof o.fini === "string") {
      f.base = o.fini;
      const extra = PROCGEN_EXTRA[o.fini];
      if (extra) for (const [ek, ev] of Object.entries(extra)) if (!(ek in o)) (f as Record<string, unknown>)[ek] = ev;
    }
    // motif des cartes : `motif` (ou `texture`) = texture du format ; `echelle` = répétitions par mètre
    const m = o.motif ?? o.texture;
    if (m !== undefined) {
      const t = readTex(m, (msg) => issue(k, msg));
      if (t) f.motif = { kind: t.kind, scale: t.scale, seed: t.seed };
    }
    const sc = o.echelle ?? o.scale;
    if (typeof sc === "number" && Number.isFinite(sc)) {
      const mo = finishMotif(r, f);
      f.motif = { ...mo, scale: Math.max(0.05, Math.min(50, sc)) };
    }
    out[r] = f;
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

/** Nombre de texels par rôle dans la table des finis texturés (`uRoleFin`, largeur = nombre de rôles). */
export const FIN_ROWS = 2;

/**
 * Table des finis texturés (RGBA flottant, `ROLES.length` × 2, rangée par rangée) :
 * rangée 0 = relief, profondeur, usure, occlusion ; rangée 1 = couche du motif + 1 (0 : aucun), répétitions par
 * mètre, verre, indice de réfraction. `layerOf` donne (et réserve) la couche d'un motif dans la banque de hauteurs.
 * `on` : au moins un rôle a des cartes ou du verre.
 */
export function encodeRoleTex(layerOf: (m: FinishMotif) => number, ...layers: RoleFinishes[]): { data: Float32Array; on: boolean } {
  const n = ROLES.length;
  const a = new Float32Array(n * FIN_ROWS * 4);
  const merged: RoleFinishes = {};
  for (const layer of layers) Object.assign(merged, layer);
  let on = false;
  for (const [r, f] of Object.entries(merged)) {
    const i = (ROLES as readonly string[]).indexOf(r);
    if (i < 0 || !f) continue;
    const maps = hasTexMaps(f);
    if (!maps && f.glass <= 0) continue;
    on = true;
    a[i * 4] = f.relief;
    a[i * 4 + 1] = f.depth;
    a[i * 4 + 2] = f.wear;
    a[i * 4 + 3] = f.ao;
    const j = (n + i) * 4;
    if (maps) {
      const m = finishMotif(r, f);
      a[j] = layerOf(m) + 1;
      a[j + 1] = m.scale;
    }
    a[j + 2] = f.glass;
    a[j + 3] = f.ior;
  }
  return { data: a, on };
}
