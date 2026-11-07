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
import { ellipsoid, lathe, tube } from "../geom/prims";
import { ROLE } from "../style/roles";
import { defineGenerator } from "./types";

const SPECIES = ["oak", "birch", "pine", "fir", "palm", "willow", "dead", "fruit"] as const;

type Branch = { pts: V3[]; radii: number[]; level: number };

function growBranches(rng: Rng, height: number, species: string, trunkR: number): { branches: Branch[]; tips: { p: V3; d: V3; level: number }[] } {
  const branches: Branch[] = [];
  const tips: { p: V3; d: V3; level: number }[] = [];
  const conifer = species === "pine" || species === "fir";
  const levels = species === "dead" ? 4 : conifer ? 2 : species === "palm" ? 1 : 3;
  const grow = (start: V3, dir: V3, length: number, radius: number, level: number) => {
    const n = Math.max(3, Math.round(6 - level));
    const pts: V3[] = [start];
    const radii: number[] = [radius];
    let p = start;
    let d = norm(dir);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      // tropisme : vers le haut pour le tronc, gravité pour les branches (saule, palmier)
      const up: V3 = [0, 1, 0];
      const droop = species === "willow" ? 0.35 * level : species === "palm" ? 0.5 : 0;
      d = norm(add(add(d, scale(up, level === 0 ? 0.08 : 0.04 - droop * t)), [rng.range(-0.12, 0.12), rng.range(-0.05, 0.05), rng.range(-0.12, 0.12)]));
      p = madd(p, d, length / n);
      pts.push(p);
      radii.push(radius * mix(1, level === 0 ? 0.55 : 0.3, t));
    }
    branches.push({ pts, radii, level });
    if (level >= levels) {
      tips.push({ p, d, level });
      return;
    }
    const kids = level === 0 ? (conifer ? 0 : species === "palm" ? 0 : rng.int(3, 5)) : rng.int(2, 3);
    let phi = rng.range(0, Math.PI * 2);
    for (let k = 0; k < kids; k++) {
      phi += 137.5 * (Math.PI / 180);
      const t = level === 0 ? rng.range(0.45, 0.85) : rng.range(0.35, 0.9);
      const idx = Math.min(pts.length - 1, Math.round(t * (pts.length - 1)));
      const base = pts[idx];
      const tilt = level === 0 ? rng.range(0.6, 1.0) : rng.range(0.5, 0.9);
      const side = norm(cross(d, [Math.cos(phi), 0.01, Math.sin(phi)]));
      const ax = norm(cross(d, side));
      const nd = norm(add(scale(d, Math.cos(tilt)), scale(norm(cross(ax, d)), Math.sin(tilt))));
      grow(base, nd, length * rng.range(0.45, 0.65), radii[idx] * 0.7, level + 1);
    }
    if (level === 0 && kids === 0) tips.push({ p, d, level });
  };
  grow([0, 0, 0], [rng.range(-0.05, 0.05), 1, rng.range(-0.05, 0.05)], height * (species === "palm" ? 0.92 : conifer ? 0.82 : 0.55), trunkR, 0);
  return { branches, tips };
}

export const tree = defineGenerator({
  id: "tree",
  label: "Arbre",
  doc: "Arbre ramifié (tronc et branches soudés, canopée en masses peintes). Espèces : oak, birch, pine, fir, palm, willow, dead, fruit.",
  tags: ["végétation", "forêt", "parc", "nature"],
  schema: {
    species: { type: "enum", default: "oak", options: SPECIES, doc: "Espèce" },
    height: { type: "number", default: 6, min: 1, max: 30, unit: "m", doc: "Hauteur" },
    density: { type: "number", default: 0.7, min: 0, max: 1, doc: "Densité du feuillage" },
    season: { type: "enum", default: "summer", options: ["spring", "summer", "autumn", "winter"], doc: "Saison (couleur, feuillage)" },
    variant: { type: "int", default: -1, min: -1, max: 7, doc: "Variante (−1 = selon la graine) ; peu de variantes = instanciation efficace" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 7);
    const rng = new Rng(`tree/${p.species}/${variant}`);
    const H = p.height;
    const sp = p.species;
    const conifer = sp === "pine" || sp === "fir";
    const trunkR = H * (sp === "palm" ? 0.022 : conifer ? 0.03 : 0.035) * rng.vary(1, 0.15);
    const { branches, tips } = growBranches(rng, H, sp, trunkR);
    const mesh = new Mesh();
    const bark = sp === "birch" ? ROLE.paper : ROLE.bark;
    for (const b of branches) {
      const radii = b.radii.slice();
      if (b.level === 0) radii[0] *= 1.45; // empattement
      const t = tube(b.pts, radii, bark, b.level === 0 ? 10 : 6, false, true);
      t.setFlex((q) => clamp(q[1] / H, 0, 1) ** 2 * 0.4 * (1 + b.level * 0.5));
      mesh.append(t);
    }
    const leafy = sp !== "dead" && !(p.season === "winter" && !conifer);
    if (leafy) {
      const prims: FieldPrim[] = [];
      const leafRole = p.season === "autumn" && !conifer ? ROLE.flower : ROLE.leaf;
      const bump = (r: number) => ({ amp: r * 0.16, freq: 2.4 / r, seed: rng.range(0, 99) });
      let hull: { c: V3; r: V3 };
      if (conifer) {
        const tiers = sp === "fir" ? 5 : 4;
        const base = sp === "pine" ? H * 0.38 : H * 0.18;
        for (let i = 0; i < tiers; i++) {
          const t = i / (tiers - 1);
          const y = mix(base, H * 0.78, t);
          const r = H * mix(sp === "pine" ? 0.24 : 0.3, 0.1, t);
          const spacing = (H * 0.78 - base) / (tiers - 1);
          const h = Math.max(spacing * 1.7, H * 0.16);
          // étage = cône évasé (jupe), pointe fine : la silhouette garde ses « marches »
          prims.push({ kind: "cone", a: [0, y, 0], b: [0, y + h, 0], ra: r, rb: r * 0.06, round: r * 0.12, role: leafRole, tag: 0, bump: bump(r * 0.45) });
        }
        hull = { c: [0, H * 0.58, 0], r: [H * 0.3, H * 0.45, H * 0.3] };
      } else if (sp === "palm") {
        const top = branches[0].pts[branches[0].pts.length - 1];
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2 + rng.range(-0.2, 0.2);
          const d: V3 = [Math.cos(a), -0.15, Math.sin(a)];
          const L = H * 0.28;
          const pts: V3[] = [];
          for (let i = 0; i <= 6; i++) {
            const t = i / 6;
            pts.push(add(top, [d[0] * L * t, L * (0.25 * t - 0.55 * t * t), d[2] * L * t]));
          }
          const frond = tube(pts, pts.map((_, i) => H * 0.035 * Math.sin((i / 6) * Math.PI) + 0.005), ROLE.leaf, 4, true, true);
          frond.mapPos((q) => [q[0], top[1] + (q[1] - top[1]), q[2]]);
          frond.setFlex(0.9);
          mesh.append(frond);
        }
        hull = { c: top, r: [H * 0.3, H * 0.1, H * 0.3] };
      } else {
        // masses en bout de branches de premier niveau
        const lvl1 = tips.length ? tips : [{ p: [0, H * 0.7, 0] as V3, d: [0, 1, 0] as V3, level: 1 }];
        const nMass = clamp(Math.round(3 + p.density * 4), 3, 7);
        const chosen: V3[] = [];
        for (let i = 0; i < nMass; i++) chosen.push(lvl1[Math.floor((i / nMass) * lvl1.length)].p);
        const crown = chosen.reduce((s, c) => add(s, scale(c, 1 / chosen.length)), [0, 0, 0] as V3);
        const R = H * (sp === "willow" ? 0.3 : sp === "birch" ? 0.22 : 0.27) * mix(0.8, 1.15, p.density);
        prims.push({ kind: "ellipsoid", c: add(crown, [0, R * 0.1, 0]), r: [R * 1.05, R * 0.85, R * 1.05], role: leafRole, tag: 0, bump: bump(R) });
        for (const c of chosen) {
          const r = R * rng.range(0.5, 0.75);
          prims.push({ kind: "ellipsoid", c: lerp3(crown, c, 1.25), r: [r, r * (sp === "willow" ? 1.4 : 0.85), r], role: rng.chance(0.35) ? ROLE.leaf2 : leafRole, tag: 0, bump: bump(r) });
        }
        if (sp === "willow") prims.push({ kind: "capsule", a: add(crown, [0, 0, 0]), b: add(crown, [0, -R * 1.6, 0]), ra: R * 0.95, rb: R * 1.25, role: ROLE.leaf2, tag: 0, bump: bump(R) });
        const ys = prims.map((q) => (q.kind === "ellipsoid" ? q.c[1] : crown[1]));
        hull = { c: [crown[0], (Math.min(...ys) + Math.max(...ys)) / 2 + R * 0.1, crown[2]], r: [R * 1.7, R * 1.25, R * 1.7] };
      }
      if (prims.length) {
        const f = new Field(prims, conifer ? prims.slice(1).map((_, i) => ({ a: i, b: i + 1, k: H * 0.012 })) : prims.map((_, i) => ({ a: 0, b: i, k: H * 0.06 })).slice(1));
        const cell = clamp(H * 0.045, 0.06, 0.6);
        const { mesh: canopy } = polygonize(f, { cell, smooth: 2, ao: true });
        // transfert de normales depuis l'ellipsoïde englobant : masse lue comme un volume peint
        for (let i = 0; i < canopy.vertexCount; i++) {
          const q = canopy.getPos(i);
          const e = norm([(q[0] - hull.c[0]) / (hull.r[0] * hull.r[0]), (q[1] - hull.c[1]) / (hull.r[1] * hull.r[1]), (q[2] - hull.c[2]) / (hull.r[2] * hull.r[2])]);
          canopy.setNrm(i, norm(lerp3(canopy.getNrm(i), e, conifer ? 0.25 : 0.6)));
          canopy.flex[i] = clamp((q[1] / H) * 0.9, 0.2, 1);
          // AO de canopée : le dessous et le cœur sont plus sombres
          const inner = len([(q[0] - hull.c[0]) / hull.r[0], (q[1] - hull.c[1]) / hull.r[1], (q[2] - hull.c[2]) / hull.r[2]]);
          canopy.ao[i] = clamp(canopy.ao[i] * mix(0.55, 1, clamp(inner, 0, 1)) * mix(0.7, 1, clamp((q[1] - hull.c[1] + hull.r[1]) / (2 * hull.r[1]), 0, 1)), 0.2, 1);
        }
        mesh.append(canopy);
      }
      if (sp === "fruit")
        for (let i = 0; i < 9; i++) {
          const t = tips[rng.int(0, Math.max(0, tips.length - 1))]?.p ?? [0, H * 0.7, 0];
          mesh.append(ellipsoid(H * 0.025, H * 0.025, H * 0.025, ROLE.accent, 6, 4), m4Compose(add(t, [rng.range(-1, 1) * H * 0.12, rng.range(-1, 0) * H * 0.1, rng.range(-1, 1) * H * 0.12])), { flex: 0.6 });
        }
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
  doc: "Buisson en masses implicites, fleuri ou non.",
  tags: ["végétation", "jardin", "nature"],
  schema: {
    size: { type: "number", default: 1, min: 0.2, max: 5, unit: "m", doc: "Diamètre" },
    flowers: { type: "number", default: 0, min: 0, max: 1, doc: "Floraison" },
    variant: { type: "int", default: -1, min: -1, max: 5, doc: "Variante" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 5);
    const rng = new Rng(`bush/${variant}`);
    const S = p.size;
    const prims: FieldPrim[] = [];
    const n = rng.int(3, 5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const r = S * rng.range(0.25, 0.38);
      prims.push({ kind: "ellipsoid", c: [Math.cos(a) * S * 0.2, r * 0.75, Math.sin(a) * S * 0.2], r: [r, r * 0.85, r], role: i % 3 === 0 ? ROLE.leaf2 : ROLE.leaf, tag: 0, bump: { amp: r * 0.18, freq: 2.8 / r, seed: rng.range(0, 99) } });
    }
    const f = new Field(prims, prims.map((_, i) => ({ a: 0, b: i, k: S * 0.12 })).slice(1));
    const { mesh } = polygonize(f, { cell: clamp(S * 0.07, 0.03, 0.3), smooth: 2, ao: true });
    const hc: V3 = [0, S * 0.32, 0];
    for (let i = 0; i < mesh.vertexCount; i++) {
      const q = mesh.getPos(i);
      mesh.setNrm(i, norm(lerp3(mesh.getNrm(i), norm(sub(q, hc)), 0.55)));
      mesh.flex[i] = clamp(q[1] / S, 0, 1) * 0.5;
    }
    mesh.mapPos((q) => [q[0], q[1] - S * 0.05, q[2]]);
    if (p.flowers > 0)
      for (let i = 0; i < Math.round(p.flowers * 14); i++) {
        const a = rng.range(0, Math.PI * 2), e = rng.range(0.1, 1.2);
        const dir: V3 = [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)];
        mesh.append(ellipsoid(S * 0.05, S * 0.03, S * 0.05, ROLE.flower, 6, 3), m4Compose(madd([0, S * 0.3, 0], dir, S * 0.42), qFromTo([0, 1, 0], dir)), { flex: 0.4 });
      }
    return { generator: "bush", mesh, anchors: {}, footprint: { hx: S * 0.4, hz: S * 0.4, r: S * 0.5 }, height: S * 0.75 };
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
  doc: "Rocher taillé par plans (facettes nettes, biseau), seul ou en groupe gros/petits, enfoui dans le sol.",
  tags: ["minéral", "nature", "montagne", "décor"],
  schema: {
    size: { type: "number", default: 1.2, min: 0.1, max: 20, unit: "m", doc: "Taille du plus gros bloc" },
    pieces: { type: "int", default: 3, min: 1, max: 6, doc: "Blocs dans le groupe" },
    sharpness: { type: "number", default: 0.6, min: 0, max: 1, doc: "0 roulé … 1 anguleux" },
    flat: { type: "number", default: 0.3, min: 0, max: 1, doc: "Aplatissement (dalles, strates)" },
    moss: { type: "number", default: 0.2, min: 0, max: 1, doc: "Mousse sur le dessus" },
    variant: { type: "int", default: -1, min: -1, max: 7, doc: "Variante" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 7);
    const rng = new Rng(`rock/${variant}`);
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
  doc: "Parterre de fleurs sur tiges, souples.",
  tags: ["végétation", "jardin", "détail"],
  schema: {
    size: { type: "number", default: 0.8, min: 0.2, max: 4, unit: "m", doc: "Diamètre" },
    count: { type: "int", default: 14, min: 3, max: 60, doc: "Fleurs" },
  },
  build(p, ctx) {
    const rng = ctx.rng;
    const mesh = new Mesh();
    for (let i = 0; i < p.count; i++) {
      const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * p.size * 0.5;
      const h = rng.range(0.15, 0.4);
      const base: V3 = [Math.cos(a) * r, 0, Math.sin(a) * r];
      const top = add(base, [rng.range(-0.04, 0.04), h, rng.range(-0.04, 0.04)]);
      mesh.append(tube([base, top], [0.008, 0.005], ROLE.leaf, 4, false, false).setFlex((q) => q[1] * 2));
      mesh.append(ellipsoid(0.035, 0.02, 0.035, rng.chance(0.3) ? ROLE.accent : ROLE.flower, 6, 3), m4Compose(top), { flex: 0.8 });
    }
    return { generator: "flowers", mesh, anchors: {}, footprint: { hx: p.size * 0.5, hz: p.size * 0.5, r: p.size * 0.5 }, height: 0.4 };
  },
});

export { qAxis, lathe };
