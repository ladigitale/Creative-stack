/**
 * Objets tenus, modélisés debout (axe y = axe du manche), poignée à l'origine. `handle` = rayon du manche (la main se
 * referme dessus).
 */
import { m4Compose, qAxis } from "../../core/math";
import { Mesh } from "../../geom/mesh";
import { box, cylinder, ellipsoid, lathe } from "../../geom/prims";
import { ROLE } from "../../style/roles";

export function buildItem(kind: string, H: number): { mesh: Mesh; handle: number } | null {
  const m = new Mesh();
  const W = ROLE.wood, M = ROLE.metal;
  const prof = (pts: number[][]) => pts.map(([r, y]) => [r * H, y * H] as [number, number]);
  switch (kind) {
    case "staff":
      m.append(cylinder(H * 0.012, H * 0.01, H * 0.66, W, 8), m4Compose([0, -H * 0.27, 0]));
      m.append(ellipsoid(H * 0.016, H * 0.02, H * 0.016, W, 8, 5), m4Compose([0, H * 0.395, 0]));
      m.append(ellipsoid(H * 0.026, H * 0.032, H * 0.026, ROLE.accent, 10, 6), m4Compose([0, H * 0.43, 0]));
      return { mesh: m, handle: H * 0.012 };
    case "wand":
      m.append(cylinder(H * 0.006, H * 0.003, H * 0.2, W, 6), m4Compose([0, -H * 0.03, 0]));
      m.append(ellipsoid(H * 0.008, H * 0.008, H * 0.008, ROLE.lamp, 6, 4), m4Compose([0, H * 0.175, 0]));
      return { mesh: m, handle: H * 0.007 };
    case "sword":
      m.append(cylinder(H * 0.01, H * 0.01, H * 0.06, ROLE.leather, 8), m4Compose([0, -H * 0.03, 0]));
      m.append(ellipsoid(H * 0.012, H * 0.012, H * 0.012, M, 8, 5), m4Compose([0, -H * 0.035, 0]));
      m.append(box(H * 0.045, H * 0.007, H * 0.012, M, H * 0.003), m4Compose([0, H * 0.035, 0]));
      m.append(lathe(prof([[0, 0], [0.011, 0.0], [0.011, 0.2], [0.0, 0.23]]), M, 4), m4Compose([0, H * 0.04, 0], qAxis([0, 1, 0], Math.PI / 4), [1, 1, 0.3]));
      return { mesh: m, handle: H * 0.01 };
    case "spear":
      m.append(cylinder(H * 0.009, H * 0.009, H * 0.9, W, 7), m4Compose([0, -H * 0.35, 0]));
      m.append(lathe(prof([[0, 0], [0.012, 0.0], [0.016, 0.03], [0.0, 0.12]]), M, 6), m4Compose([0, H * 0.55, 0], qAxis([0, 1, 0], 0), [1, 1, 0.35]));
      return { mesh: m, handle: H * 0.009 };
    case "pitchfork":
      m.append(cylinder(H * 0.009, H * 0.009, H * 0.72, W, 7), m4Compose([0, -H * 0.3, 0]));
      m.append(box(H * 0.04, H * 0.006, H * 0.006, M, H * 0.002), m4Compose([0, H * 0.43, 0]));
      for (const x of [-1, 0, 1]) m.append(cylinder(H * 0.0035, H * 0.002, H * 0.1, M, 5), m4Compose([x * H * 0.035, H * 0.432, 0]));
      return { mesh: m, handle: H * 0.009 };
    case "hammer":
      m.append(cylinder(H * 0.009, H * 0.008, H * 0.2, W, 7), m4Compose([0, H * 0.03, 0]));
      m.append(box(H * 0.05, H * 0.022, H * 0.022, M, H * 0.004), m4Compose([H * 0.012, H * 0.14, 0]));
      return { mesh: m, handle: H * 0.009 };
    case "lantern":
      m.append(lathe(prof([[0.002, 0.03], [0.012, 0.025], [0.014, 0.0], [0.012, -0.025], [0.002, -0.03]]), M, 8), m4Compose([0, 0, 0], qAxis([0, 0, 1], Math.PI / 2)));
      m.append(cylinder(H * 0.003, H * 0.003, H * 0.06, M, 5), m4Compose([0, -H * 0.06, 0]));
      m.append(lathe(prof([[0, -0.06], [0.03, -0.062], [0.036, -0.11], [0.03, -0.15], [0.012, -0.16], [0, -0.16]]), ROLE.lamp, 10), m4Compose([0, 0, 0]));
      m.append(box(H * 0.032, H * 0.006, H * 0.032, M, H * 0.002), m4Compose([0, -H * 0.058, 0]));
      return { mesh: m, handle: H * 0.006 };
    case "book":
      m.append(box(H * 0.012, H * 0.06, H * 0.045, ROLE.accent, H * 0.004), m4Compose([0, -H * 0.01, 0]));
      m.append(box(H * 0.009, H * 0.057, H * 0.042, ROLE.paper, 0), m4Compose([0, -H * 0.01, H * 0.004]));
      return { mesh: m, handle: H * 0.014 };
    case "umbrella":
      // parapluie fermé (canne) : manche recourbé, toile roulée
      m.append(cylinder(H * 0.005, H * 0.005, H * 0.52, ROLE.ink, 6), m4Compose([0, -H * 0.42, 0]));
      m.append(lathe(prof([[0, -0.4], [0.006, -0.39], [0.02, -0.3], [0.024, -0.2], [0.012, -0.08], [0.006, -0.06], [0, -0.06]]), ROLE.accent, 8), m4Compose([0, 0, 0]));
      m.append(lathe(prof([[0, 0.0], [0.009, 0.0], [0.009, 0.05], [0, 0.06]]), ROLE.wood, 8), m4Compose([0, -H * 0.02, 0]));
      return { mesh: m, handle: H * 0.009 };
    case "torch":
      m.append(cylinder(H * 0.012, H * 0.016, H * 0.24, W, 8), m4Compose([0, -H * 0.06, 0]));
      m.append(ellipsoid(H * 0.03, H * 0.05, H * 0.03, ROLE.fire, 10, 6), m4Compose([0, H * 0.2, 0]));
      return { mesh: m, handle: H * 0.013 };
    case "flower":
      m.append(cylinder(H * 0.003, H * 0.003, H * 0.14, ROLE.leaf, 5), m4Compose([0, -H * 0.02, 0]));
      m.append(ellipsoid(H * 0.022, H * 0.012, H * 0.022, ROLE.flower, 10, 5), m4Compose([0, H * 0.125, 0]));
      m.append(ellipsoid(H * 0.008, H * 0.006, H * 0.008, ROLE.lamp, 6, 4), m4Compose([0, H * 0.133, 0]));
      return { mesh: m, handle: H * 0.006 };
    case "mug":
      m.append(lathe(prof([[0, 0], [0.026, 0], [0.028, 0.055], [0.024, 0.055], [0.022, 0.008], [0, 0.008]]), ROLE.paper, 12, false), m4Compose([H * 0.035, -H * 0.03, 0]));
      return { mesh: m, handle: H * 0.007 };
  }
  return null;
}
