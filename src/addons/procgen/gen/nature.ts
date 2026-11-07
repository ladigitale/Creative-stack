/**
 * Végétation et minéral : arbres, buissons, touffes d'herbe, fleurs, rochers.
 *
 * Arbres : ramification récursive (3–4 niveaux, phyllotaxie 137,5°, gravité / tropisme), branches en tubes soudés
 * au départ ; canopée en 3–7 **masses implicites** à normales transférées d'un ellipsoïde englobant (lecture « peinte »),
 * silhouette cassée par du bruit. Le paramètre `variant` (0–7) permet d'instancier quelques variantes par espèce.
 * Rochers : polyèdre convexe découpé par plans aléatoires, biseauté, en groupe gros/petits, enfoui de 20–30 %.
 */
import { type V3, add, clamp, cross, len, lerp3, m4Compose, madd, mix, norm, qAxis, qFromTo, scale, sub } from "../core/math";
import { Rng } from "../core/rng";
import { Field, type FieldPrim, polygonize } from "../geom/implicit";
import { Mesh } from "../geom/mesh";
import { box, cylinder, ellipsoid, extrude, icosphere, lathe, tube } from "../geom/prims";
import { ROLE } from "../style/roles";
import { type Asset, defineGenerator } from "./types";

const SPECIES = ["oak", "beech", "maple", "birch", "willow", "poplar", "cypress", "stonepine", "olive", "cherry", "fruit", "pine", "fir", "palm", "dead"] as const;

type Branch = { pts: V3[]; radii: number[]; level: number };

/** Profil d'espèce : port (ramification) et forme de canopée. */
type Profile = {
  levels: number;
  kids0: [number, number];
  kids: [number, number];
  trunk: number; // part de la hauteur occupée par le fût
  trunkR: number;
  tilt0: [number, number];
  tilt: [number, number];
  droop: number;
  wobble: number;
  canopy: "clusters" | "column" | "flame" | "umbrella" | "tiers" | "palm" | "willow" | "none";
  R: number; // rayon de canopée (part de la hauteur)
  clusters: [number, number];
  flat: number; // aplatissement des grappes
  inner: number; // masse intérieure (0 = canopée ajourée)
  bark: number;
  leaf: number;
};

const PROFILES: Record<(typeof SPECIES)[number], Profile> = {
  oak: { levels: 3, kids0: [3, 5], kids: [2, 3], trunk: 0.42, trunkR: 0.04, tilt0: [0.7, 1.1], tilt: [0.5, 0.9], droop: 0, wobble: 0.16, canopy: "clusters", R: 0.3, clusters: [6, 9], flat: 0.78, inner: 0.45, bark: ROLE.bark, leaf: ROLE.leaf },
  beech: { levels: 3, kids0: [3, 4], kids: [2, 3], trunk: 0.48, trunkR: 0.032, tilt0: [0.5, 0.8], tilt: [0.5, 0.8], droop: 0.05, wobble: 0.08, canopy: "clusters", R: 0.27, clusters: [6, 8], flat: 0.9, inner: 0.75, bark: ROLE.stone, leaf: ROLE.leaf },
  maple: { levels: 3, kids0: [3, 5], kids: [2, 3], trunk: 0.45, trunkR: 0.034, tilt0: [0.55, 0.9], tilt: [0.5, 0.85], droop: 0, wobble: 0.1, canopy: "clusters", R: 0.29, clusters: [7, 9], flat: 0.85, inner: 0.65, bark: ROLE.bark, leaf: ROLE.leaf2 },
  birch: { levels: 3, kids0: [3, 5], kids: [2, 3], trunk: 0.55, trunkR: 0.022, tilt0: [0.35, 0.6], tilt: [0.4, 0.7], droop: 0.12, wobble: 0.1, canopy: "clusters", R: 0.2, clusters: [5, 8], flat: 1.1, inner: 0.2, bark: ROLE.paper, leaf: ROLE.leaf2 },
  willow: { levels: 2, kids0: [4, 5], kids: [2, 3], trunk: 0.45, trunkR: 0.045, tilt0: [0.8, 1.1], tilt: [0.5, 0.9], droop: 0.12, wobble: 0.12, canopy: "willow", R: 0.3, clusters: [5, 6], flat: 0.55, inner: 0.6, bark: ROLE.bark, leaf: ROLE.leaf2 },
  poplar: { levels: 2, kids0: [5, 7], kids: [2, 2], trunk: 0.3, trunkR: 0.025, tilt0: [0.12, 0.25], tilt: [0.1, 0.2], droop: 0, wobble: 0.04, canopy: "column", R: 0.11, clusters: [5, 6], flat: 1, inner: 1, bark: ROLE.bark, leaf: ROLE.leaf },
  cypress: { levels: 0, kids0: [0, 0], kids: [0, 0], trunk: 0.3, trunkR: 0.025, tilt0: [0, 0], tilt: [0, 0], droop: 0, wobble: 0.03, canopy: "flame", R: 0.12, clusters: [0, 0], flat: 1, inner: 1, bark: ROLE.bark, leaf: ROLE.leaf },
  stonepine: { levels: 3, kids0: [3, 4], kids: [2, 3], trunk: 0.68, trunkR: 0.028, tilt0: [0.8, 1.15], tilt: [0.6, 1.0], droop: 0, wobble: 0.14, canopy: "umbrella", R: 0.34, clusters: [5, 7], flat: 0.38, inner: 0.5, bark: ROLE.bark, leaf: ROLE.leaf },
  olive: { levels: 3, kids0: [2, 3], kids: [2, 3], trunk: 0.3, trunkR: 0.06, tilt0: [0.6, 1.0], tilt: [0.5, 0.9], droop: 0.05, wobble: 0.35, canopy: "clusters", R: 0.3, clusters: [7, 10], flat: 0.7, inner: 0.15, bark: ROLE.bark, leaf: ROLE.leaf2 },
  cherry: { levels: 3, kids0: [3, 5], kids: [2, 3], trunk: 0.38, trunkR: 0.035, tilt0: [0.8, 1.2], tilt: [0.5, 0.9], droop: 0, wobble: 0.15, canopy: "clusters", R: 0.31, clusters: [7, 10], flat: 0.7, inner: 0.35, bark: ROLE.bark, leaf: ROLE.flower },
  fruit: { levels: 3, kids0: [3, 5], kids: [2, 3], trunk: 0.38, trunkR: 0.035, tilt0: [0.7, 1.1], tilt: [0.5, 0.9], droop: 0, wobble: 0.15, canopy: "clusters", R: 0.29, clusters: [6, 8], flat: 0.8, inner: 0.55, bark: ROLE.bark, leaf: ROLE.leaf },
  pine: { levels: 0, kids0: [0, 0], kids: [0, 0], trunk: 0.82, trunkR: 0.03, tilt0: [0, 0], tilt: [0, 0], droop: 0, wobble: 0.05, canopy: "tiers", R: 0.24, clusters: [4, 4], flat: 1, inner: 1, bark: ROLE.bark, leaf: ROLE.leaf },
  fir: { levels: 0, kids0: [0, 0], kids: [0, 0], trunk: 0.82, trunkR: 0.03, tilt0: [0, 0], tilt: [0, 0], droop: 0, wobble: 0.04, canopy: "tiers", R: 0.3, clusters: [5, 5], flat: 1, inner: 1, bark: ROLE.bark, leaf: ROLE.leaf },
  palm: { levels: 0, kids0: [0, 0], kids: [0, 0], trunk: 0.92, trunkR: 0.022, tilt0: [0, 0], tilt: [0, 0], droop: 0.5, wobble: 0.06, canopy: "palm", R: 0.3, clusters: [0, 0], flat: 1, inner: 0, bark: ROLE.bark, leaf: ROLE.leaf },
  dead: { levels: 4, kids0: [3, 4], kids: [2, 3], trunk: 0.5, trunkR: 0.035, tilt0: [0.6, 1.0], tilt: [0.5, 0.9], droop: 0, wobble: 0.2, canopy: "none", R: 0, clusters: [0, 0], flat: 1, inner: 0, bark: ROLE.bark, leaf: ROLE.leaf },
};

function growBranches(rng: Rng, height: number, pr: Profile, trunkR: number, palm: boolean): { branches: Branch[]; tips: { p: V3; d: V3; level: number }[] } {
  const branches: Branch[] = [];
  const tips: { p: V3; d: V3; level: number }[] = [];
  const grow = (start: V3, dir: V3, length: number, radius: number, level: number) => {
    const n = Math.max(3, Math.round(6 - level));
    const pts: V3[] = [start];
    const radii: number[] = [radius];
    let p = start;
    let d = norm(dir);
    const w = pr.wobble * (level === 0 ? 0.6 : 1);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      // tropisme : vers le haut pour le tronc, gravité pour les branches (saule, palmier)
      const droop = palm ? 0.04 : pr.droop * level;
      d = norm(add(add(d, [0, level === 0 ? 0.08 : 0.04 - droop * t, 0]), [rng.range(-w, w), rng.range(-0.05, 0.05), rng.range(-w, w)]));
      p = madd(p, d, length / n);
      pts.push(p);
      radii.push(radius * mix(1, level === 0 ? 0.55 : 0.3, t));
    }
    branches.push({ pts, radii, level });
    if (level >= pr.levels) {
      tips.push({ p, d, level });
      return;
    }
    const kids = level === 0 ? rng.int(pr.kids0[0], pr.kids0[1]) : rng.int(pr.kids[0], pr.kids[1]);
    let phi = rng.range(0, Math.PI * 2);
    for (let k = 0; k < kids; k++) {
      phi += 137.5 * (Math.PI / 180);
      const t = level === 0 ? rng.range(pr.trunk * 0.85, 0.95) / 1 : rng.range(0.35, 0.9);
      const idx = Math.min(pts.length - 1, Math.max(1, Math.round(t * (pts.length - 1))));
      const base = pts[idx];
      const tilt = level === 0 ? rng.range(pr.tilt0[0], pr.tilt0[1]) : rng.range(pr.tilt[0], pr.tilt[1]);
      const side = norm(cross(d, [Math.cos(phi), 0.01, Math.sin(phi)]));
      const ax = norm(cross(d, side));
      const nd = norm(add(scale(d, Math.cos(tilt)), scale(norm(cross(ax, d)), Math.sin(tilt))));
      grow(base, nd, length * rng.range(0.5, 0.7) * (level === 0 ? 1.1 : 1), radii[idx] * 0.7, level + 1);
    }
    if (level === 0 && kids === 0) tips.push({ p, d, level });
  };
  const trunkLen = height * (pr.levels === 0 ? pr.trunk : pr.trunk + 0.18);
  grow([0, 0, 0], [rng.range(-0.05, 0.05) + (palm ? rng.range(-0.25, 0.25) : 0), 1, rng.range(-0.05, 0.05)], trunkLen, trunkR, 0);
  return { branches, tips };
}

/** Échantillonnage par point le plus éloigné : `n` bouts de branche bien répartis. */
function spread(points: V3[], n: number): V3[] {
  if (points.length <= n) return points.slice();
  const out: V3[] = [points[0]];
  while (out.length < n) {
    let best = points[0], bd = -1;
    for (const q of points) {
      const d = Math.min(...out.map((o) => len(sub(o, q))));
      if (d > bd) {
        bd = d;
        best = q;
      }
    }
    out.push(best);
  }
  return out;
}

export const tree = defineGenerator({
  id: "tree",
  label: "Arbre",
  doc: "Arbre ramifié (tronc et branches soudés, canopée en grappes ajourées à contour dentelé, branches visibles entre les masses). Espèces : oak (chêne), beech (hêtre), maple (érable), birch (bouleau), willow (saule), poplar (peuplier), cypress (cyprès), stonepine (pin parasol), olive (olivier), cherry (cerisier en fleurs), fruit (fruitier), pine, fir (sapin), palm (palmier), dead (arbre mort). Saisons : spring, summer, autumn (teintes mêlées), winter (branches nues, neige sur les conifères).",
  tags: ["végétation", "forêt", "parc", "nature"],
  schema: {
    species: { type: "enum", default: "oak", options: SPECIES, doc: "Espèce" },
    height: { type: "number", default: 6, min: 1, max: 30, unit: "m", doc: "Hauteur" },
    density: { type: "number", default: 0.7, min: 0, max: 1, doc: "Densité du feuillage (0 = très ajouré)" },
    season: { type: "enum", default: "summer", options: ["spring", "summer", "autumn", "winter"], doc: "Saison (couleur, feuillage)" },
    variant: { type: "int", default: -1, min: -1, max: 7, doc: "Variante (−1 = selon la graine) ; peu de variantes = instanciation efficace" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 7);
    const sp = p.species as (typeof SPECIES)[number];
    const pr = PROFILES[sp] ?? PROFILES.oak;
    const rng = new Rng(`tree/${sp}/${variant}`);
    const H = p.height;
    const conifer = pr.canopy === "tiers" || pr.canopy === "flame";
    const trunkR = H * pr.trunkR * rng.vary(1, 0.15);
    const { branches, tips } = growBranches(rng, H, pr, trunkR, sp === "palm");
    const mesh = new Mesh();
    const winterBare = p.season === "winter" && !conifer && sp !== "palm" && sp !== "olive";
    for (const b of branches) {
      // en hiver ou pour l'arbre mort, on garde les rameaux fins ; sinon la canopée les cache
      const radii = b.radii.slice();
      if (b.level === 0) radii[0] *= sp === "olive" ? 1.8 : 1.45; // empattement
      const t = tube(b.pts, radii, pr.bark, b.level === 0 ? 10 : b.level === 1 ? 6 : 4, false, true);
      t.setFlex((q) => clamp(q[1] / H, 0, 1) ** 2 * 0.4 * (1 + b.level * 0.5));
      mesh.append(t);
      // bouleau : lenticelles sombres sur l'écorce blanche
      if (sp === "birch" && b.level === 0)
        for (let k = 0; k < 7; k++) {
          const i = 1 + (k % (b.pts.length - 2));
          mesh.append(box(radii[i] * 0.6, 0.02, radii[i] * 1.02, ROLE.ink), m4Compose(add(b.pts[i], [0, rng.range(-0.3, 0.3), 0]), qAxis([0, 1, 0], rng.range(0, 6.28))));
        }
    }
    const leafy = pr.canopy !== "none" && !winterBare;
    // rôles de feuillage selon saison et espèce
    const blossom = sp === "cherry" && (p.season === "spring" || p.season === "summer");
    const leafRoles: number[] =
      p.season === "autumn" && !conifer && sp !== "palm" && sp !== "olive"
        ? sp === "maple"
          ? [ROLE.accent, ROLE.flower, ROLE.roof]
          : sp === "birch" || sp === "poplar"
            ? [ROLE.flower, ROLE.leaf2, ROLE.flower]
            : [ROLE.flower, ROLE.leaf2, ROLE.roof, ROLE.leaf]
        : blossom
          ? [ROLE.paper, ROLE.flower, ROLE.paper]
          : sp === "cherry"
            ? [ROLE.leaf, ROLE.leaf2]
            : [pr.leaf, pr.leaf === ROLE.leaf ? ROLE.leaf2 : ROLE.leaf];
    if (leafy) {
      const prims: FieldPrim[] = [];
      const blends: { a: number; b: number; k: number }[] = [];
      const bump = (r: number, amp = 0.2) => ({ amp: r * amp, freq: 3.2 / r, seed: rng.range(0, 99) });
      let hull: { c: V3; r: V3 };
      let transfer = 0.45;
      if (pr.canopy === "tiers") {
        const tiers = sp === "fir" ? 5 : 4;
        const base = sp === "pine" ? H * 0.38 : H * 0.18;
        for (let i = 0; i < tiers; i++) {
          const t = i / (tiers - 1);
          const y = mix(base, H * 0.78, t);
          const r = H * mix(pr.R, 0.1, t) * rng.vary(1, 0.08);
          const spacing = (H * 0.78 - base) / (tiers - 1);
          const h = Math.max(spacing * 1.7, H * 0.16);
          // étage = cône évasé (jupe), pointe fine, bord dentelé : la silhouette garde ses « marches »
          prims.push({ kind: "cone", a: [rng.range(-0.05, 0.05) * H * 0.1, y, 0], b: [0, y + h, 0], ra: r, rb: r * 0.06, round: r * 0.12, role: leafRoles[i % 2 === 0 ? 0 : Math.min(1, leafRoles.length - 1)], tag: 0, bump: bump(r * 0.45, 0.24) });
          if (i > 0) blends.push({ a: i - 1, b: i, k: H * 0.012 });
        }
        hull = { c: [0, H * 0.58, 0], r: [H * 0.3, H * 0.45, H * 0.3] };
        transfer = 0.25;
      } else if (pr.canopy === "flame") {
        // cyprès : flamme élancée, légère torsion
        const r = H * pr.R;
        prims.push({ kind: "capsule", a: [0, H * 0.25, 0], b: [rng.range(-0.04, 0.04) * H, H * 0.82, 0], ra: r, rb: r * 0.35, role: leafRoles[0], tag: 0, bump: bump(r, 0.22) });
        prims.push({ kind: "capsule", a: [0, H * 0.06, 0], b: [0, H * 0.3, 0], ra: r * 0.55, rb: r * 0.95, role: leafRoles[0], tag: 0, bump: bump(r, 0.2) });
        prims.push({ kind: "cone", a: [0, H * 0.78, 0], b: [0, H, 0], ra: r * 0.42, rb: 0.02, round: r * 0.05, role: leafRoles[1], tag: 0, bump: bump(r * 0.4, 0.2) });
        blends.push({ a: 0, b: 1, k: r * 0.4 }, { a: 0, b: 2, k: r * 0.3 });
        hull = { c: [0, H * 0.5, 0], r: [r * 1.2, H * 0.5, r * 1.2] };
        transfer = 0.3;
      } else if (pr.canopy === "column") {
        // peuplier d'Italie : colonne de masses superposées
        const r = H * pr.R;
        const n = 5;
        for (let i = 0; i < n; i++) {
          const t = i / (n - 1);
          const rr = r * (1 - 0.45 * Math.abs(t - 0.35)) * rng.vary(1, 0.1);
          prims.push({ kind: "ellipsoid", c: [rng.range(-0.3, 0.3) * rr, mix(H * 0.3, H * 0.86, t), rng.range(-0.3, 0.3) * rr], r: [rr, H * 0.15, rr], role: leafRoles[i % leafRoles.length], tag: 0, bump: bump(rr, 0.22) });
          if (i > 0) blends.push({ a: i - 1, b: i, k: rr * 0.5 });
        }
        hull = { c: [0, H * 0.58, 0], r: [r * 1.3, H * 0.4, r * 1.3] };
        transfer = 0.35;
      } else if (pr.canopy === "palm") {
        const top = branches[0].pts[branches[0].pts.length - 1];
        const nf = 9;
        for (let k = 0; k < nf; k++) {
          const a = (k / nf) * Math.PI * 2 + rng.range(-0.2, 0.2);
          const up = k % 3 === 0 ? 0.35 : rng.range(-0.1, 0.15);
          const d: V3 = [Math.cos(a), 0, Math.sin(a)];
          const L = H * rng.range(0.34, 0.42);
          const pts: V3[] = [];
          for (let i = 0; i <= 7; i++) {
            const t = i / 7;
            pts.push(add(top, [d[0] * L * t, L * ((0.35 + up) * t - 0.75 * t * t), d[2] * L * t]));
          }
          // palme aplatie : un tube écrasé dans le plan de la feuille, folioles en dents de scie
          const frond = tube(pts, pts.map((_, i) => H * 0.05 * Math.sin((i / 7) * Math.PI) ** 0.7 + 0.004), k % 2 ? ROLE.leaf : ROLE.leaf2, 4, true, true);
          const side: V3 = [-d[2], 0, d[0]];
          frond.mapPos((q) => {
            const rel = sub(q, top);
            const along = rel[0] * d[0] + rel[2] * d[2];
            const lat = rel[0] * side[0] + rel[2] * side[2];
            const teeth = 1 + 0.35 * Math.sign(Math.sin(along * 40));
            return [top[0] + d[0] * along + side[0] * lat * 1.6 * teeth, q[1] - Math.abs(lat) * 0.6, top[2] + d[2] * along + side[2] * lat * 1.6 * teeth];
          });
          frond.computeNormals();
          frond.setFlex(0.9);
          mesh.append(frond);
        }
        for (let k = 0; k < 4; k++) mesh.append(ellipsoid(H * 0.022, H * 0.026, H * 0.022, ROLE.wood, 6, 4), m4Compose(add(top, [Math.cos(k * 1.7) * H * 0.03, -H * 0.03, Math.sin(k * 1.7) * H * 0.03])));
        // anneaux du stipe
        const tr = branches[0];
        for (let i = 1; i < tr.pts.length - 1; i++) mesh.append(cylinder(tr.radii[i] * 1.15, tr.radii[i] * 1.05, H * 0.025, ROLE.bark, 8), m4Compose(tr.pts[i]));
        hull = { c: top, r: [H * 0.3, H * 0.1, H * 0.3] };
      } else {
        // grappes en bout de branches, bien réparties : des trous laissent voir la charpente
        const tipPts = (tips.length ? tips : [{ p: [0, H * 0.7, 0] as V3, d: [0, 1, 0] as V3, level: 1 }]).map((t) => t.p);
        const nC = clamp(Math.round(mix(pr.clusters[0], pr.clusters[1], p.density)), 3, 12);
        const chosen = spread(tipPts, nC);
        const crown = tipPts.reduce((s, c) => add(s, scale(c, 1 / tipPts.length)), [0, 0, 0] as V3);
        const R = H * pr.R * mix(0.85, 1.1, p.density);
        const willow = pr.canopy === "willow";
        const umbrella = pr.canopy === "umbrella";
        // regroupement des bouts de branche autour des centres choisis (k-moyennes, 3 passes) : chaque rameau finit
        // dans une grappe, les grappes restent distinctes
        let centers = chosen.slice();
        let groups: V3[][] = [];
        for (let it = 0; it < 3; it++) {
          groups = centers.map(() => []);
          for (const q of tipPts) {
            let bi = 0, bd = Infinity;
            centers.forEach((c, i) => {
              const d = len(sub(c, q));
              if (d < bd) {
                bd = d;
                bi = i;
              }
            });
            groups[bi].push(q);
          }
          centers = groups.map((g, i) => (g.length ? g.reduce((s2, q) => add(s2, scale(q, 1 / g.length)), [0, 0, 0] as V3) : centers[i]));
        }
        centers.forEach((c0, i) => {
          const g = groups[i];
          const spreadR = g.length ? Math.max(...g.map((q) => len(sub(q, c0)))) : 0;
          const r = Math.max(R * rng.range(0.42, 0.55), spreadR * 0.9 + R * 0.22) * (umbrella ? 1.15 : 1);
          const c = umbrella ? ([c0[0], mix(c0[1], crown[1], 0.5) + R * 0.12, c0[2]] as V3) : add(lerp3(crown, c0, 1.05), [0, r * 0.15, 0]);
          prims.push({ kind: "ellipsoid", c, r: [r, r * pr.flat, r * rng.range(0.85, 1.1)], role: rng.pick(leafRoles), tag: 0, bump: bump(r, sp === "olive" ? 0.26 : 0.2) });
        });
        if (pr.inner * p.density > 0.2) {
          const r = R * mix(0.45, 0.75, pr.inner);
          prims.push({ kind: "ellipsoid", c: add(crown, [0, umbrella ? R * 0.05 : -R * 0.05, 0]), r: [r * 1.1, r * pr.flat * 0.9, r * 1.1], role: leafRoles[0], tag: 0, bump: bump(r, 0.15) });
        }
        if (willow)
          // rideaux de rameaux retombants : fines colonnes pendues sous chaque grappe et sur le pourtour
          for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2 + rng.range(-0.15, 0.15);
            const rr = R * rng.range(1.0, 1.25);
            const top: V3 = add(crown, [Math.cos(a) * rr, R * 0.25, Math.sin(a) * rr]);
            const r = R * rng.range(0.13, 0.18);
            prims.push({ kind: "capsule", a: top, b: add(top, [Math.cos(a) * R * 0.15, -H * rng.range(0.35, 0.5), Math.sin(a) * R * 0.15]), ra: r, rb: r * 0.45, role: leafRoles[i % leafRoles.length], tag: 0, bump: bump(r, 0.3) });
          }
        // soudures entre voisines seulement (les grappes éloignées restent séparées)
        for (let i = 0; i < prims.length; i++) {
          const ci = prims[i].kind === "ellipsoid" ? (prims[i] as { c: V3 }).c : (prims[i] as { a: V3 }).a;
          const near = prims
            .map((q, j) => ({ j, d: len(sub(q.kind === "ellipsoid" ? (q as { c: V3 }).c : (q as { a: V3 }).a, ci)) }))
            .filter((e) => e.j > i)
            .sort((x, y) => x.d - y.d)
            .slice(0, 2);
          for (const e of near) blends.push({ a: i, b: e.j, k: R * 0.18 });
        }
        const ys = prims.map((q) => (q.kind === "ellipsoid" ? q.c[1] : crown[1]));
        hull = { c: [crown[0], (Math.min(...ys) + Math.max(...ys)) / 2, crown[2]], r: [R * 1.6, R * (willow ? 1.6 : 1.2) * pr.flat + R * 0.2, R * 1.6] };
      }
      if (prims.length) {
        const f = new Field(prims, blends);
        const cell = clamp(H * (pr.canopy === "umbrella" ? 0.065 : pr.canopy === "clusters" || pr.canopy === "willow" ? 0.05 : 0.045), 0.06, 0.6);
        const { mesh: canopy } = polygonize(f, { cell, smooth: 2, ao: true });
        // transfert partiel de normales depuis l'ellipsoïde englobant : masse lue comme un volume peint
        for (let i = 0; i < canopy.vertexCount; i++) {
          const q = canopy.getPos(i);
          const e = norm([(q[0] - hull.c[0]) / (hull.r[0] * hull.r[0]), (q[1] - hull.c[1]) / (hull.r[1] * hull.r[1]), (q[2] - hull.c[2]) / (hull.r[2] * hull.r[2])]);
          canopy.setNrm(i, norm(lerp3(canopy.getNrm(i), e, transfer)));
          canopy.flex[i] = clamp((q[1] / H) * 0.9, 0.2, 1);
          // AO de canopée : le dessous et le cœur sont plus sombres
          const inner = len([(q[0] - hull.c[0]) / hull.r[0], (q[1] - hull.c[1]) / hull.r[1], (q[2] - hull.c[2]) / hull.r[2]]);
          canopy.ao[i] = clamp(canopy.ao[i] * mix(0.55, 1, clamp(inner * 1.2, 0, 1)) * mix(0.65, 1, clamp((q[1] - hull.c[1] + hull.r[1]) / (2 * hull.r[1]), 0, 1)), 0.2, 1);
          // neige sur les conifères en hiver
          if (p.season === "winter" && conifer && canopy.getNrm(i)[1] > 0.45) canopy.role[i] = ROLE.snow;
        }
        mesh.append(canopy);
      }
      if (sp === "fruit" || (sp === "olive" && variant % 2 === 0))
        for (let i = 0; i < 12; i++) {
          const t = tips[rng.int(0, Math.max(0, tips.length - 1))]?.p ?? [0, H * 0.7, 0];
          const fr = H * (sp === "olive" ? 0.012 : 0.025);
          mesh.append(ellipsoid(fr, fr * 1.1, fr, sp === "olive" ? ROLE.ink : ROLE.accent, 5, 3), m4Compose(add(t, [rng.range(-1, 1) * H * 0.12, rng.range(-1, 0) * H * 0.1, rng.range(-1, 1) * H * 0.12])), { flex: 0.6 });
        }
    }
    // pétales ou feuilles tombés au pied (cerisier en fleurs, automne)
    if ((blossom || (p.season === "autumn" && !conifer)) && variant % 2 === 0)
      for (let i = 0; i < 10; i++) {
        const a = rng.range(0, 6.28), d = rng.range(0.3, H * pr.R * 1.2);
        mesh.append(box(0.06, 0.004, 0.05, rng.pick(leafRoles)), m4Compose([Math.cos(a) * d, 0.01, Math.sin(a) * d], qAxis([0, 1, 0], a)));
      }
    const b = mesh.bounds();
    const hx = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
    const hz = Math.max(Math.abs(b.min[2]), Math.abs(b.max[2]));
    return { generator: "tree", mesh, anchors: { top: { pos: [0, b.max[1], 0], rot: [0, 0, 0, 1], scale: hx } }, footprint: { hx: trunkR * 2, hz: trunkR * 2, r: Math.max(hx, hz) }, height: b.max[1] };
  },
});

export const bush = defineGenerator({
  id: "bush",
  label: "Buisson",
  doc: "Buisson en masses implicites, fleuri ou non, ou arbuste taillé : shape = round (libre), ball (boule), cone (topiaire), box (cube de buis), cloud (nuages taillés à la japonaise), spiral (topiaire en spirale).",
  tags: ["végétation", "jardin", "nature"],
  schema: {
    size: { type: "number", default: 1, min: 0.2, max: 5, unit: "m", doc: "Diamètre" },
    flowers: { type: "number", default: 0, min: 0, max: 1, doc: "Floraison" },
    shape: { type: "enum", default: "round", options: ["round", "ball", "cone", "box", "cloud", "spiral"], doc: "Silhouette (libre ou taillée)" },
    variant: { type: "int", default: -1, min: -1, max: 5, doc: "Variante" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 5);
    const rng = new Rng(`bush/${p.shape}/${variant}`);
    const S = p.size;
    const prims: FieldPrim[] = [];
    const blends: { a: number; b: number; k: number }[] = [];
    const extra = new Mesh();
    const shape = p.shape;
    // arbustes taillés : surface plus lisse (petites bosses), tronc ou pot visibles
    const trim = shape !== "round";
    const bump = (r: number) => ({ amp: r * (trim ? 0.06 : 0.18), freq: (trim ? 5 : 2.8) / r, seed: rng.range(0, 99) });
    let H = S * 0.75;
    if (shape === "round") {
      const n = rng.int(3, 5);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng.range(-0.4, 0.4);
        const r = S * rng.range(0.25, 0.38);
        prims.push({ kind: "ellipsoid", c: [Math.cos(a) * S * 0.2, r * 0.75, Math.sin(a) * S * 0.2], r: [r, r * 0.85, r], role: i % 3 === 0 ? ROLE.leaf2 : ROLE.leaf, tag: 0, bump: bump(r) });
        if (i > 0) blends.push({ a: 0, b: i, k: S * 0.12 });
      }
    } else if (shape === "ball") {
      prims.push({ kind: "ellipsoid", c: [0, S * 0.5, 0], r: [S * 0.5, S * 0.47, S * 0.5], role: ROLE.leaf, tag: 0, bump: bump(S * 0.5) });
      H = S;
    } else if (shape === "cone") {
      prims.push({ kind: "cone", a: [0, S * 0.15, 0], b: [0, S * 1.9, 0], ra: S * 0.5, rb: S * 0.03, round: S * 0.08, role: ROLE.leaf, tag: 0, bump: bump(S * 0.4) });
      extra.append(cylinder(0.06 * S, 0.06 * S, S * 0.2, ROLE.bark, 6));
      H = S * 1.9;
    } else if (shape === "box") {
      prims.push({ kind: "box", c: [0, S * 0.4, 0], h: [S * 0.5, S * 0.4, S * 0.5], round: S * 0.08, role: ROLE.leaf, tag: 0, bump: bump(S * 0.4) });
      H = S * 0.8;
    } else if (shape === "spiral") {
      // topiaire en spirale : boudins superposés de rayon décroissant
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const r = S * mix(0.45, 0.12, t);
        prims.push({ kind: "ellipsoid", c: [Math.cos(i * 2.4) * S * 0.04, S * (0.25 + t * 1.5), Math.sin(i * 2.4) * S * 0.04], r: [r, S * 0.16, r], role: ROLE.leaf, tag: 0, bump: bump(r) });
      }
      extra.append(cylinder(0.05 * S, 0.04 * S, S * 1.8, ROLE.bark, 6));
      H = S * 1.9;
    } else {
      // nuages : tronc tortueux et coussins aplatis au bout des branches (niwaki)
      const pads: V3[] = [[0, S * 1.25, 0]];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + rng.range(-0.4, 0.4);
        pads.push([Math.cos(a) * S * rng.range(0.45, 0.65), S * rng.range(0.45, 0.95), Math.sin(a) * S * rng.range(0.45, 0.65)]);
      }
      extra.append(tube([[0, 0, 0], [S * 0.06, S * 0.5, 0], [-S * 0.04, S * 1.1, S * 0.03]], [S * 0.07, S * 0.05, S * 0.035], ROLE.bark, 6));
      for (let i = 0; i < pads.length; i++) {
        const c = pads[i];
        const r = S * (i === 0 ? 0.36 : rng.range(0.24, 0.32));
        prims.push({ kind: "ellipsoid", c, r: [r, r * 0.5, r], role: i % 2 ? ROLE.leaf2 : ROLE.leaf, tag: 0, bump: bump(r) });
        if (i > 0) extra.append(tube([[0, Math.min(c[1] * 0.6, S * 0.6), 0], [c[0] * 0.6, c[1] * 0.85, c[2] * 0.6], [c[0], c[1], c[2]]], [S * 0.035, S * 0.028, S * 0.02], ROLE.bark, 5));
      }
      H = S * 1.45;
    }
    const f = new Field(prims, blends);
    const { mesh } = polygonize(f, { cell: clamp(S * (trim ? 0.06 : 0.07), 0.03, 0.3), smooth: 2, ao: true });
    const hc: V3 = [0, H * 0.45, 0];
    for (let i = 0; i < mesh.vertexCount; i++) {
      const q = mesh.getPos(i);
      if (shape === "round") mesh.setNrm(i, norm(lerp3(mesh.getNrm(i), norm(sub(q, hc)), 0.55)));
      mesh.flex[i] = clamp(q[1] / H, 0, 1) * (trim ? 0.15 : 0.5);
    }
    if (shape === "round") mesh.mapPos((q) => [q[0], q[1] - S * 0.05, q[2]]);
    mesh.append(extra);
    if (p.flowers > 0)
      for (let i = 0; i < Math.round(p.flowers * 14); i++) {
        const a = rng.range(0, Math.PI * 2), e = rng.range(0.1, 1.2);
        const dir: V3 = [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)];
        mesh.append(ellipsoid(S * 0.05, S * 0.03, S * 0.05, ROLE.flower, 6, 3), m4Compose(madd([0, Math.min(H, S) * 0.4, 0], dir, S * 0.45), qFromTo([0, 1, 0], dir)), { flex: 0.4 });
      }
    const r = shape === "cloud" ? S * 0.9 : S * 0.5;
    return { generator: "bush", mesh, anchors: {}, footprint: { hx: S * 0.4, hz: S * 0.4, r }, height: H };
  },
});

export const grass = defineGenerator({
  id: "grass",
  label: "Touffe d'herbe",
  doc: "Touffe de brins (lames effilées), souple au vent. À semer en nombre aux raccords (pied des murs, bords de route).",
  tags: ["végétation", "détail", "sol"],
  schema: {
    size: { type: "number", default: 0.35, min: 0.05, max: 2, unit: "m", doc: "Hauteur" },
    blades: { type: "int", default: 9, min: 3, max: 24, doc: "Nombre de brins" },
    flowers: { type: "number", default: 0, min: 0, max: 1, doc: "Fleurs des champs" },
    variant: { type: "int", default: -1, min: -1, max: 3, doc: "Variante" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 3);
    const rng = new Rng(`grass/${variant}`);
    const mesh = new Mesh();
    for (let i = 0; i < p.blades; i++) {
      const a = rng.range(0, Math.PI * 2);
      const lean = rng.range(0.1, 0.5);
      const h = p.size * rng.range(0.6, 1.1);
      const base: V3 = [Math.cos(a) * p.size * 0.08, 0, Math.sin(a) * p.size * 0.08];
      const tip = add(base, [Math.cos(a) * h * lean, h, Math.sin(a) * h * lean]);
      const mid = add(lerp3(base, tip, 0.5), [0, h * 0.05, 0]);
      const blade = tube([base, mid, tip], [p.size * 0.03, p.size * 0.02, p.size * 0.003], i % 3 ? ROLE.grass : ROLE.leaf2, 3, false, false);
      blade.setFlex((q) => clamp(q[1] / p.size, 0, 1) * 0.9);
      blade.ao.forEach((_, k) => (blade.ao[k] = mix(0.55, 1, clamp(blade.getPos(k)[1] / p.size, 0, 1))));
      mesh.append(blade);
      if (p.flowers > 0 && rng.chance(p.flowers * 0.3)) mesh.append(ellipsoid(p.size * 0.05, p.size * 0.03, p.size * 0.05, ROLE.flower, 5, 3), m4Compose(tip), { flex: 0.9 });
    }
    return { generator: "grass", mesh, anchors: {}, footprint: { hx: 0.05, hz: 0.05, r: p.size * 0.3 }, height: p.size };
  },
});

export const rock = defineGenerator({
  id: "rock",
  label: "Rocher",
  doc: "Minéral : kind = boulder (rocher taillé par plans, en groupe, enfoui), pebbles (galets roulés), cliff (falaise à strates), slab (dalle plate), steps (pas japonais en file), scree (éboulis).",
  tags: ["minéral", "nature", "montagne", "décor"],
  schema: {
    kind: { type: "enum", default: "boulder", options: ["boulder", "pebbles", "cliff", "slab", "steps", "scree"], doc: "Type" },
    size: { type: "number", default: 1.2, min: 0.1, max: 20, unit: "m", doc: "Taille du plus gros bloc" },
    pieces: { type: "int", default: 3, min: 1, max: 6, doc: "Blocs dans le groupe" },
    sharpness: { type: "number", default: 0.6, min: 0, max: 1, doc: "0 roulé … 1 anguleux" },
    flat: { type: "number", default: 0.3, min: 0, max: 1, doc: "Aplatissement (dalles, strates)" },
    moss: { type: "number", default: 0.2, min: 0, max: 1, doc: "Mousse sur le dessus" },
    variant: { type: "int", default: -1, min: -1, max: 7, doc: "Variante" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 7);
    const rng = new Rng(`rock/${p.kind}/${variant}`);
    if (p.kind !== "boulder") return mineral(p.kind, p.size, p.moss, rng);
    const prims: FieldPrim[] = [];
    const S = p.size;
    for (let k = 0; k < p.pieces; k++) {
      const s = k === 0 ? S : S * rng.range(0.25, 0.5);
      const a = rng.range(0, Math.PI * 2);
      const c: V3 = k === 0 ? [0, 0, 0] : [Math.cos(a) * S * rng.range(0.55, 0.85), 0, Math.sin(a) * S * rng.range(0.55, 0.85)];
      const planes: [V3, number][] = [];
      const np = 9 + Math.round(p.sharpness * 7);
      for (let i = 0; i < np; i++) {
        const u = rng.range(-1, 1), th = rng.range(0, Math.PI * 2);
        let n: V3 = [Math.sqrt(1 - u * u) * Math.cos(th), u, Math.sqrt(1 - u * u) * Math.sin(th)];
        n = norm([n[0], n[1] * (1 + p.flat * 1.5), n[2]]);
        planes.push([n, s * 0.5 * rng.range(0.75, 1) * (Math.abs(n[1]) > 0.7 ? 1 - p.flat * 0.45 : 1)]);
      }
      planes.push([[0, 1, 0], s * 0.5 * (1 - p.flat * 0.4)]);
      prims.push({ kind: "planes", c: [c[0], s * 0.5 * (1 - p.flat * 0.4) * 0.45, c[2]], planes, round: s * mix(0.12, 0.03, p.sharpness), reach: s * 0.6, role: ROLE.stone, tag: k, bump: { amp: s * 0.025, freq: 3 / s, seed: rng.range(0, 99) } });
    }
    const f = new Field(prims);
    const { mesh } = polygonize(f, { cell: clamp(S * 0.05, 0.02, 0.5), smooth: 1, ao: true });
    // enfoui de 25 % ; mousse sur les faces tournées vers le ciel
    const bb = mesh.bounds();
    const sink = (bb.max[1] - bb.min[1]) * 0.25 - bb.min[1] * 0;
    mesh.mapPos((q) => [q[0], q[1] - bb.min[1] - sink, q[2]]);
    for (let i = 0; i < mesh.vertexCount; i++) if (p.moss > 0 && mesh.getNrm(i)[1] > mix(0.95, 0.55, p.moss)) mesh.role[i] = ROLE.leaf2;
    const b = mesh.bounds();
    const hx = Math.max(-b.min[0], b.max[0]), hz = Math.max(-b.min[2], b.max[2]);
    return { generator: "rock", mesh, anchors: {}, footprint: { hx, hz, r: Math.max(hx, hz) }, height: b.max[1] };
  },
});

export const flowers = defineGenerator({
  id: "flowers",
  label: "Massif de fleurs",
  doc: "Parterre de fleurs sur tiges, souples. kind = mixed, round (pompons), daisy (marguerites), tulip (tulipes), spike (épis : lupins, lavande), bell (clochettes).",
  tags: ["végétation", "jardin", "détail"],
  schema: {
    size: { type: "number", default: 0.8, min: 0.2, max: 4, unit: "m", doc: "Diamètre" },
    count: { type: "int", default: 14, min: 3, max: 60, doc: "Fleurs" },
    kind: { type: "enum", default: "mixed", options: ["mixed", "round", "daisy", "tulip", "spike", "bell"], doc: "Forme des fleurs" },
  },
  build(p, ctx) {
    const rng = ctx.rng;
    const mesh = new Mesh();
    // têtes partagées (construites une fois)
    const heads: Record<string, Mesh> = {
      round: ellipsoid(0.035, 0.022, 0.035, ROLE.flower, 6, 3),
      daisy: (() => {
        const m = lathe([[0.005, 0.004], [0.05, 0.0], [0.055, -0.006], [0, -0.006]], ROLE.paper, 7);
        m.append(ellipsoid(0.016, 0.012, 0.016, ROLE.accent, 5, 3));
        return m;
      })(),
      tulip: lathe([[0, -0.01], [0.022, 0.0], [0.03, 0.035], [0.022, 0.06], [0.0, 0.05]], ROLE.flower, 6, false),
      spike: (() => {
        const m = new Mesh();
        for (let k = 0; k < 4; k++) m.append(ellipsoid(0.02 - k * 0.003, 0.025, 0.02 - k * 0.003, k % 2 ? ROLE.flower : ROLE.accent, 5, 3), m4Compose([0, k * 0.035, 0]));
        return m;
      })(),
      bell: (() => {
        const m = new Mesh();
        for (let k = 0; k < 3; k++) m.append(lathe([[0, 0.02], [0.012, 0.015], [0.018, -0.01], [0.014, -0.014]], ROLE.paper, 5, false), m4Compose([Math.cos(k * 2.1) * 0.03, -k * 0.02, Math.sin(k * 2.1) * 0.03]));
        return m;
      })(),
    };
    const kinds = p.kind === "mixed" ? ["round", "daisy", "tulip", "spike", "round"] : [p.kind];
    for (let i = 0; i < p.count; i++) {
      const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * p.size * 0.5;
      const k = rng.pick(kinds);
      const h = rng.range(0.15, 0.4) * (k === "spike" ? 1.4 : k === "tulip" ? 1.1 : 1);
      const base: V3 = [Math.cos(a) * r, 0, Math.sin(a) * r];
      const top = add(base, [rng.range(-0.04, 0.04), h, rng.range(-0.04, 0.04)]);
      mesh.append(tube([base, top], [0.008, 0.005], ROLE.leaf, 3, false, false).setFlex((q) => q[1] * 2));
      // feuilles basales
      if (i % 2 === 0) mesh.append(ellipsoid(0.05, 0.008, 0.018, ROLE.leaf2, 4, 2), m4Compose(add(base, [0, 0.04, 0]), qAxis([0, 1, 0], a)), { flex: 0.3 });
      const head = heads[k];
      const tint = k === "daisy" || k === "bell" ? undefined : rng.chance(0.3) ? ROLE.accent : rng.chance(0.2) ? ROLE.paper : undefined;
      mesh.append(head, m4Compose(top, qAxis([0, 1, 0], rng.range(0, 6.28))), { flex: 0.8, role: tint });
    }
    return { generator: "flowers", mesh, anchors: {}, footprint: { hx: p.size * 0.5, hz: p.size * 0.5, r: p.size * 0.5 }, height: 0.5 };
  },
});

/** Minéraux légers (sans surface implicite sauf la falaise) : galets, dalles, pas japonais, éboulis, strates. */
function mineral(kind: string, S: number, moss: number, rng: Rng): Asset {
  const mesh = new Mesh();
  const slab = (w: number, d: number, h: number, role: number) => {
    // dalle irrégulière : polygone bruité extrudé, biseau
    const n = rng.int(6, 8);
    const pts: [number, number][] = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
      return [Math.cos(a) * w * rng.range(0.82, 1), Math.sin(a) * d * rng.range(0.82, 1)] as [number, number];
    });
    const m = extrude(pts, h, role, h * 0.35);
    m.transform(m4Compose([0, 0, 0], qAxis([1, 0, 0], -Math.PI / 2)));
    return m;
  };
  if (kind === "pebbles" || kind === "scree") {
    const n = kind === "scree" ? 22 : rng.int(7, 12);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * S * (kind === "scree" ? 1 : 0.6);
      const r = S * (kind === "scree" ? rng.range(0.05, 0.16) * (1.3 - d / S) : rng.range(0.06, 0.16));
      const g = kind === "scree" ? icoRock(r, rng) : ellipsoid(r, r * rng.range(0.45, 0.7), r * rng.range(0.7, 1), rng.chance(0.25) ? ROLE.trim : ROLE.stone, 7, 4);
      mesh.append(g, m4Compose([Math.cos(a) * d, r * 0.3, Math.sin(a) * d], qAxis([0, 1, 0], rng.range(0, 6.28))));
    }
    return { generator: "rock", mesh, anchors: {}, footprint: { hx: S * 0.6, hz: S * 0.6, r: S * 0.7 }, height: S * 0.2 };
  }
  if (kind === "slab") {
    mesh.append(slab(S * 0.5, S * 0.4, Math.max(0.05, S * 0.1), ROLE.stone), m4Compose([0, -S * 0.03, 0]));
    return { generator: "rock", mesh, anchors: {}, footprint: { hx: S * 0.5, hz: S * 0.4, r: S * 0.5 }, height: S * 0.08 };
  }
  if (kind === "steps") {
    // pas japonais : 5 dalles en file légèrement sinueuse
    for (let i = 0; i < 5; i++) mesh.append(slab(S * rng.range(0.24, 0.32), S * rng.range(0.2, 0.26), 0.08, ROLE.stone), m4Compose([Math.sin(i * 1.3) * S * 0.12, -0.02, (i - 2) * S * 0.6], qAxis([0, 1, 0], rng.range(-0.4, 0.4))));
    return { generator: "rock", mesh, anchors: {}, footprint: { hx: S * 0.4, hz: S * 1.5, r: S * 1.5 }, height: 0.08 };
  }
  // falaise : strates empilées en retrait, arêtes vives, mousse sur les replats
  const prims: FieldPrim[] = [];
  const layers = rng.int(4, 6);
  let y = 0;
  for (let i = 0; i < layers; i++) {
    const th = S * rng.range(0.16, 0.26);
    const w = S * mix(1.0, 0.55, i / layers) * rng.range(0.9, 1.1);
    const d = S * mix(0.55, 0.3, i / layers);
    const c: V3 = [rng.range(-0.1, 0.1) * S, y + th / 2, rng.range(-0.12, 0.05) * S - i * S * 0.04];
    const planes: [V3, number][] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + rng.range(-0.2, 0.2);
      planes.push([norm([Math.cos(a), rng.range(-0.15, 0.15), Math.sin(a)]), (Math.abs(Math.cos(a)) > 0.7 ? w : d) * rng.range(0.85, 1)]);
    }
    planes.push([[0, 1, 0], th / 2], [[0, -1, 0], th / 2]);
    prims.push({ kind: "planes", c, planes, round: S * 0.02, reach: Math.max(w, d) * 1.2, role: i % 2 ? ROLE.stone : ROLE.trim, tag: i, bump: { amp: S * 0.015, freq: 4 / S, seed: rng.range(0, 99) } });
    y += th * 0.92;
  }
  const f = new Field(prims);
  const { mesh: m } = polygonize(f, { cell: clamp(S * 0.045, 0.03, 0.5), smooth: 0, ao: true });
  for (let i = 0; i < m.vertexCount; i++) if (moss > 0 && m.getNrm(i)[1] > mix(0.95, 0.6, moss)) m.role[i] = ROLE.grass;
  m.mapPos((q) => [q[0], q[1] - S * 0.1, q[2]]);
  const b = m.bounds();
  return { generator: "rock", mesh: m, anchors: {}, footprint: { hx: Math.max(-b.min[0], b.max[0]), hz: Math.max(-b.min[2], b.max[2]), r: Math.max(-b.min[0], b.max[0], -b.min[2], b.max[2]) }, height: b.max[1] };
}

/** Caillou anguleux (icosphère facettée et déformée), pour les éboulis. */
function icoRock(r: number, rng: Rng): Mesh {
  const k = [rng.range(0.7, 1.2), rng.range(0.5, 0.8), rng.range(0.7, 1.1)];
  return icosphere(0, ROLE.stone).mapPos((q) => [q[0] * r * k[0] * rng.range(0.85, 1.1), q[1] * r * k[1], q[2] * r * k[2] * rng.range(0.85, 1.1)]).facet();
}

export { qAxis, lathe };
