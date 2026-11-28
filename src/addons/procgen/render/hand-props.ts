/**
 * Objets tenus le temps d'une action (tasse pour boire, assiette et fourchette pour manger, casserole et cuillère pour
 * cuisiner, planche et couteau pour couper). Petits maillages hors du personnage : posés en coordonnées du modèle au
 * repos et suivis par l'os de la main (matrice de skinning), ou fixés au repère de l'acteur (casserole, planche).
 * Aucun objet quand l'acteur tient déjà quelque chose (`item`).
 */
import { type V3, add, len, m4Compose, norm, qAxis, scale, sub } from "../core/math";
import { Mesh } from "../geom/mesh";
import { box, cylinder, ellipsoid, tube } from "../geom/prims";
import { ROLE } from "../style/roles";
import type { Skeleton } from "../rig/skeleton";

export type HandProp = {
  /** Os porteur (`hand.r`, `hand.l`) ou `null` : repère de l'acteur. */
  bone: string | null;
  mesh: Mesh;
  /**
   * Objet qui reste à plat (assiette) : il suit le point `at` de la main (coordonnées du modèle au repos) sans tourner
   * avec elle ; son maillage est alors centré sur l'origine.
   */
  flat?: V3;
};

/** Actions qui font apparaître un objet en main. */
export const PROP_ACTIONS = new Set(["drink", "eat", "cook", "chop"]);

const at = (m: Mesh, part: Mesh, p: V3, axis?: V3, ang = 0) => m.append(part, m4Compose(p, axis ? qAxis(axis, ang) : [0, 0, 0, 1]));

export function propsFor(action: string, sk: Skeleton): HandProp[] {
  const hr = sk.bone("hand.r"), hl = sk.bone("hand.l"), ua = sk.bone("upperarm.r"), th = sk.bone("thigh.l");
  if (!hr || !hl || !ua || !th) return [];
  const u = len(sub(ua.tail, ua.head));
  // échelle : objets à taille réelle pour un adulte, réduits avec la main (enfant, chibi)
  const k = Math.max(0.55, Math.min(1.25, len(sub(hr.tail, hr.head)) / 0.19));
  const hipY = th.head[1];
  // milieu de la paume (repos : bras le long du corps, paume tournée vers le corps) ; côté intérieur
  const palm = (b: { head: V3; tail: V3 }, side: number): V3 => add(add(b.head, scale(sub(b.tail, b.head), 0.5)), [-side * 0.03 * k, 0, 0.012 * k]);
  const out: HandProp[] = [];
  switch (action) {
    case "drink": {
      // tasse : axe dans le creux de la main fermée (vers l'avant au repos), anse côté pouce
      const m = new Mesh();
      const c = palm(hr, -1);
      const r = 0.04 * k, h = 0.09 * k;
      at(m, cylinder(r, r * 1.08, h, ROLE.paper, 14), add(c, [0, 0, -h / 2]), [1, 0, 0], Math.PI / 2);
      at(m, cylinder(r * 0.9, r * 0.9, 0.004, ROLE.ink, 12), add(c, [0, 0, h / 2 - 0.012 * k]), [1, 0, 0], Math.PI / 2);
      out.push({ bone: "hand.r", mesh: m });
      break;
    }
    case "eat": {
      // assiette posée sur la paume gauche, fourchette dans la main droite
      const m = new Mesh();
      at(m, cylinder(0.105 * k, 0.12 * k, 0.014 * k, ROLE.paper, 18), [0, 0.03 * k, 0]);
      at(m, ellipsoid(0.045 * k, 0.014 * k, 0.04 * k, ROLE.orange, 8, 5), [0, 0.048 * k, 0]);
      out.push({ bone: "hand.l", mesh: m, flat: palm(hl, 1) });
      const f = new Mesh();
      const d = norm(sub(hr.tail, hr.head));
      const p0 = palm(hr, -1);
      at(f, tube([add(p0, scale(d, -0.05 * k)), add(p0, scale(d, 0.12 * k))], [0.005 * k, 0.004 * k], ROLE.metal, 5, true, true), [0, 0, 0]);
      out.push({ bone: "hand.r", mesh: f });
      break;
    }
    case "cook": {
      // casserole devant le ventre (repère de l'acteur, là où la main gauche tient le manche), cuillère en bois
      const m = new Mesh();
      const pot: V3 = [0.03, hipY + u * 0.22, u * 0.95];
      const r = 0.12 * k;
      at(m, cylinder(r, r * 1.05, 0.11 * k, ROLE.metal, 16), add(pot, [0, -0.11 * k, 0]));
      at(m, cylinder(r * 0.95, r * 0.95, 0.004, ROLE.orange, 14), add(pot, [0, -0.03 * k, 0]));
      at(m, tube([add(pot, [r, -0.02 * k, 0]), [pot[0] + u * 0.42, pot[1] - u * 0.02, pot[2] - u * 0.12]], [0.012 * k, 0.012 * k], ROLE.ink, 6, true, true), [0, 0, 0]);
      out.push({ bone: null, mesh: m });
      // cuillère serrée dans le poing : le manche sort côté pouce, le cuilleron côté auriculaire (vers la casserole)
      const s = new Mesh();
      const z: V3 = [0, 0, 1];
      const p0 = palm(hr, -1);
      at(s, tube([add(p0, scale(z, 0.06 * k)), add(p0, scale(z, -0.22 * k))], [0.008 * k, 0.007 * k], ROLE.wood, 5, true, true), [0, 0, 0]);
      at(s, ellipsoid(0.02 * k, 0.012 * k, 0.03 * k, ROLE.wood, 8, 5), add(p0, scale(z, -0.24 * k)));
      out.push({ bone: "hand.r", mesh: s });
      break;
    }
    case "chop": {
      // planche devant soi (repère de l'acteur), légume dessus ; couteau dans la main droite, lame vers le bas
      const m = new Mesh();
      const board: V3 = [0, hipY + u * 0.18, u * 1.0];
      at(m, box(0.2 * k, 0.012 * k, 0.13 * k, ROLE.wood, 0.006 * k), board);
      at(m, tube([add(board, [u * 0.05, 0.03 * k, 0]), add(board, [u * 0.32, 0.03 * k, 0])], [0.018 * k, 0.012 * k], ROLE.orange, 7, true, true), [0, 0, 0]);
      out.push({ bone: null, mesh: m });
      // couteau dans le poing : manche dans la main, lame côté auriculaire, tranchant vers le bas
      const kn = new Mesh();
      const p0 = palm(hr, -1);
      at(kn, box(0.012 * k, 0.009 * k, 0.05 * k, ROLE.ink, 0.004 * k), add(p0, [0, 0, -0.01 * k]));
      at(kn, box(0.003 * k, 0.018 * k, 0.07 * k, ROLE.metal, 0.002 * k), add(p0, [0, 0.006 * k, -0.12 * k]));
      out.push({ bone: "hand.r", mesh: kn });
      break;
    }
  }
  return out;
}
