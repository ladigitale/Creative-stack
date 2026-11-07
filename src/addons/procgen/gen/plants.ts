/**
 * Petite végétation et débris naturels (`plant.*`) : fougères, herbes hautes, roseaux, nénuphars, champignons, souche,
 * tronc couché, cactus, bambous, lierre, lavande. Objets nombreux et instanciés : chacun reste sous ~600 triangles.
 *
 * Repère : base au sol en y = 0, avant = +z. Le lierre est une nappe verticale plaquée contre un mur situé en −z.
 * Les nénuphars flottent : à poser avec `onWater` (la couche les descend de 15 cm, la feuille est relevée d'autant).
 */
import { type V3, add, clamp, m4Compose, mix, qAxis, qEuler } from "../core/math";
import { Rng } from "../core/rng";
import { Mesh } from "../geom/mesh";
import { cylinder, ellipsoid, extrude, lathe, ngon, tube } from "../geom/prims";
import { ROLE } from "../style/roles";
import { defineGenerator } from "./types";

const SPECIES = ["fern", "tallgrass", "reeds", "waterlily", "mushrooms", "stump", "log", "cactus", "bamboo", "ivy", "lavender"] as const;

/** Feuille plate (fronde, lame) le long d'une courbe : tube écrasé, dents optionnelles. */
function blade(pts: V3[], width: number, role: number, teeth = 0): Mesh {
  const n = pts.length - 1;
  const m = tube(pts, pts.map((_, i) => width * Math.sin(((i + 0.3) / (n + 0.3)) * Math.PI) ** 0.8 + 0.003), role, 4, false, false);
  // écrasement : on aplatit la section dans la direction verticale locale
  const a = pts[0], b = pts[n];
  const dir = [b[0] - a[0], 0, b[2] - a[2]];
  const L = Math.hypot(dir[0], dir[2]) || 1;
  const side: V3 = [-dir[2] / L, 0, dir[0] / L];
  m.mapPos((q, i) => {
    const k = Math.floor(i / 5);
    const c = pts[Math.min(n, k)] ?? pts[n];
    const rel: V3 = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
    const lat = rel[0] * side[0] + rel[2] * side[2];
    const tooth = teeth > 0 ? 1 + 0.4 * Math.sign(Math.sin(k * teeth)) : 1;
    return [c[0] + side[0] * lat * 1.8 * tooth, c[1] + rel[1] * 0.25, c[2] + side[2] * lat * 1.8 * tooth];
  });
  return m.computeNormals();
}

export const plant = defineGenerator({
  id: "plant",
  label: "Petite végétation",
  doc: "Plantes et débris naturels instanciables : fern (fougère), tallgrass (herbes hautes à épis), reeds (roseaux et massettes, bord d'eau), waterlily (nénuphars, onWater), mushrooms (champignons), stump (souche), log (tronc couché moussu), cactus, bamboo (bosquet de bambous), ivy (lierre plaqué contre un mur en −z ; placement edges + yaw path), lavender (touffe de lavande).",
  tags: ["végétation", "détail", "sol", "jardin", "forêt", "eau"],
  schema: {
    species: { type: "enum", default: "fern", options: SPECIES, doc: "Espèce" },
    size: { type: "number", default: 1, min: 0.2, max: 4, doc: "Échelle" },
    variant: { type: "int", default: -1, min: -1, max: 3, doc: "Variante" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 3);
    const rng = new Rng(`plant/${p.species}/${variant}`);
    const m = new Mesh();
    const S = p.size;
    let h = 0.5, r = 0.4, block = false;
    switch (p.species) {
      case "fern": {
        const n = rng.int(7, 10);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
          const L = S * rng.range(0.55, 0.8);
          const up = rng.range(0.5, 0.9);
          const pts: V3[] = [];
          for (let k = 0; k <= 6; k++) {
            const t = k / 6;
            pts.push([Math.cos(a) * L * t, L * (up * t - 0.75 * t * t) + 0.02, Math.sin(a) * L * t]);
          }
          m.append(blade(pts, S * 0.09, i % 3 ? ROLE.leaf : ROLE.leaf2, 9).setFlex((q) => clamp(Math.hypot(q[0], q[2]) / L, 0, 1) * 0.8));
        }
        h = S * 0.5;
        r = S * 0.6;
        break;
      }
      case "tallgrass":
      case "reeds": {
        const reeds = p.species === "reeds";
        const n = reeds ? 16 : 22;
        for (let i = 0; i < n; i++) {
          const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * S * 0.25;
          const H = S * rng.range(0.7, 1.2) * (reeds ? 1.5 : 1);
          const lean = rng.range(0.05, reeds ? 0.15 : 0.35);
          const base: V3 = [Math.cos(a) * d, 0, Math.sin(a) * d];
          const tip = add(base, [Math.cos(a) * H * lean, H, Math.sin(a) * H * lean]);
          const mid = add(base, [Math.cos(a) * H * lean * 0.35, H * 0.55, Math.sin(a) * H * lean * 0.35]);
          const role = reeds ? (i % 3 ? ROLE.leaf2 : ROLE.leaf) : i % 4 === 0 ? ROLE.path : i % 2 ? ROLE.grass : ROLE.leaf2;
          const t = tube([base, mid, tip], [S * 0.012, S * 0.009, S * 0.002], role, 3, false, false);
          t.setFlex((q) => clamp(q[1] / H, 0, 1) * 0.95);
          m.append(t);
          // épis (herbes) ou massettes (roseaux)
          if (reeds && i % 3 === 0) m.append(cylinder(S * 0.025, S * 0.025, S * 0.16, ROLE.bark, 6), m4Compose(add(mid, [0, H * 0.25, 0])), { flex: 0.8 });
          else if (!reeds && i % 2 === 0) m.append(ellipsoid(S * 0.018, S * 0.06, S * 0.018, ROLE.path, 4, 3), m4Compose(tip), { flex: 1 });
        }
        h = S * (reeds ? 1.6 : 1.1);
        r = S * 0.35;
        break;
      }
      case "waterlily": {
        // feuilles rondes échancrées posées à la surface, une fleur en coupe
        const n = rng.int(3, 5);
        for (let i = 0; i < n; i++) {
          const a = rng.range(0, Math.PI * 2), d = i === 0 ? 0 : S * rng.range(0.25, 0.5);
          const R = S * rng.range(0.16, 0.24);
          const notch = rng.range(0, Math.PI * 2);
          const pts = ngon(12, R, notch + 0.25).slice(0, 11);
          pts.push([0, 0]);
          const leaf = extrude(pts, 0.015, i % 2 ? ROLE.leaf : ROLE.leaf2);
          m.append(leaf, m4Compose([Math.cos(a) * d, 0.16, Math.sin(a) * d], qAxis([1, 0, 0], -Math.PI / 2)), { flex: 0.15 });
        }
        const fl = new Mesh();
        for (let k = 0; k < 6; k++) fl.append(ellipsoid(S * 0.05, S * 0.02, S * 0.022, k % 2 ? ROLE.paper : ROLE.flower, 5, 3), m4Compose([Math.cos(k) * S * 0.04, S * 0.03, Math.sin(k) * S * 0.04], qEuler(0, -k, 0.6)));
        fl.append(ellipsoid(S * 0.02, S * 0.02, S * 0.02, ROLE.accent, 5, 3), m4Compose([0, S * 0.04, 0]));
        m.append(fl, m4Compose([S * 0.05, 0.17, 0]));
        h = 0.25;
        r = S * 0.5;
        break;
      }
      case "mushrooms": {
        const n = rng.int(3, 5);
        const red = rng.chance(0.5);
        for (let i = 0; i < n; i++) {
          const a = rng.range(0, Math.PI * 2), d = i === 0 ? 0 : S * rng.range(0.06, 0.16);
          const H = S * rng.range(0.06, 0.14) * (i === 0 ? 1.4 : 1);
          const R = H * rng.range(0.6, 0.9);
          const pos: V3 = [Math.cos(a) * d, 0, Math.sin(a) * d];
          m.append(cylinder(R * 0.28, R * 0.22, H, ROLE.paper, 6), m4Compose(pos));
          const cap = lathe([[R * 0.3, 0], [R, R * 0.12], [R * 0.85, R * 0.45], [R * 0.4, R * 0.7], [0, R * 0.75]], red ? ROLE.accent : ROLE.wood, 8);
          m.append(cap, m4Compose(add(pos, [0, H * 0.92, 0]), qEuler(rng.range(-0.2, 0.2), 0, rng.range(-0.2, 0.2))));
          if (red) for (let k = 0; k < 4; k++) m.append(ellipsoid(R * 0.1, R * 0.05, R * 0.1, ROLE.paper, 4, 2), m4Compose(add(pos, [Math.cos(k * 1.6) * R * 0.55, H * 0.92 + R * 0.55, Math.sin(k * 1.6) * R * 0.55])));
        }
        h = S * 0.25;
        r = S * 0.2;
        break;
      }
      case "stump": {
        const R = S * 0.32;
        const prof: [number, number][] = [[R * 1.35, 0], [R * 1.05, R * 0.25], [R, R * 0.9], [R * 0.98, R * 1.3]];
        const st = lathe(prof, ROLE.bark, 10, false);
        // dessus scié irrégulier
        st.mapPos((q) => (q[1] > R * 1.2 ? [q[0], q[1] + Math.sin(Math.atan2(q[2], q[0]) * 3) * R * 0.08, q[2]] : q));
        m.append(st);
        m.append(cylinder(R * 0.97, R * 0.97, 0.02, ROLE.wood, 10), m4Compose([0, R * 1.24, 0]));
        m.append(cylinder(R * 0.45, R * 0.45, 0.01, ROLE.bark, 8), m4Compose([0, R * 1.26, 0]));
        // racines
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + rng.range(-0.3, 0.3);
          m.append(tube([[Math.cos(a) * R * 0.8, R * 0.25, Math.sin(a) * R * 0.8], [Math.cos(a) * R * 1.5, R * 0.05, Math.sin(a) * R * 1.5], [Math.cos(a) * R * 1.9, -R * 0.05, Math.sin(a) * R * 1.9]], [R * 0.25, R * 0.15, R * 0.06], ROLE.bark, 5));
        }
        if (rng.chance(0.6)) m.append(ellipsoid(R * 0.5, R * 0.12, R * 0.4, ROLE.leaf2, 6, 3), m4Compose([R * 0.5, R * 0.6, R * 0.6]));
        h = R * 1.35;
        r = R * 1.6;
        block = true;
        break;
      }
      case "log": {
        const L = S * rng.range(2.2, 3.2), R = S * rng.range(0.18, 0.26);
        const lg = tube([[-L / 2, R * 0.85, 0], [0, R * 0.9, rng.range(-0.1, 0.1)], [L / 2, R * 0.8, 0]], [R, R * 0.95, R * 0.85], ROLE.bark, 9, true, true);
        m.append(lg);
        for (const sx of [-1, 1]) m.append(cylinder(R * (sx < 0 ? 0.95 : 0.82), R * (sx < 0 ? 0.95 : 0.82), 0.02, ROLE.wood, 9), m4Compose([(sx * L) / 2 + sx * 0.005, R * (sx < 0 ? 0.85 : 0.8), 0], qAxis([0, 0, 1], (-sx * Math.PI) / 2)));
        // mousse sur le dessus, branche cassée
        for (let k = 0; k < 3; k++) m.append(ellipsoid(R * 0.7, R * 0.25, R * 0.6, ROLE.leaf2, 6, 3), m4Compose([mix(-L / 2, L / 2, 0.2 + k * 0.3), R * 1.65, rng.range(-0.1, 0.1)]));
        m.append(tube([[L * 0.1, R * 1.4, 0], [L * 0.18, R * 2.6, R * 0.5]], [R * 0.3, R * 0.15], ROLE.bark, 5));
        if (rng.chance(0.6)) m.append(lathe([[0, 0], [R * 0.4, R * 0.08], [0, R * 0.15]], ROLE.wood, 7), m4Compose([-L * 0.2, R * 0.6, R * 0.9], qAxis([1, 0, 0], Math.PI / 2)));
        h = R * 2;
        r = L / 2;
        block = true;
        break;
      }
      case "cactus": {
        // cierge à côtes (profil tourné aux sommets alternés), bras coudés, fleur
        const ribbed = (R: number, H: number) => {
          const c = lathe([[R, 0], [R, H * 0.85], [R * 0.75, H * 0.97], [0, H]], ROLE.leaf2, 16);
          return c.mapPos((q) => {
            const a = Math.atan2(q[2], q[0]);
            const k = 1 + 0.12 * Math.cos(a * 8);
            return [q[0] * k, q[1], q[2] * k];
          }).computeNormals();
        };
        const H = S * rng.range(1.6, 2.4);
        const R = S * 0.18;
        m.append(ribbed(R, H));
        const arms = rng.int(1, 2);
        for (let k = 0; k < arms; k++) {
          const sx = k === 0 ? 1 : -1;
          const y = H * rng.range(0.35, 0.55), L = S * rng.range(0.35, 0.5);
          m.append(tube([[0, y, 0], [sx * L * 0.7, y + 0.02, 0], [sx * L, y + 0.25, 0]], [R * 0.7, R * 0.66, R * 0.62], ROLE.leaf2, 8, false, false));
          m.append(ribbed(R * 0.62, H * 0.35), m4Compose([sx * L, y + 0.2, 0]));
        }
        if (rng.chance(0.6)) m.append(ellipsoid(R * 0.35, R * 0.2, R * 0.35, ROLE.flower, 6, 3), m4Compose([0, H, 0]));
        h = H;
        r = S * 0.5;
        block = true;
        break;
      }
      case "bamboo": {
        const n = rng.int(6, 10);
        for (let i = 0; i < n; i++) {
          const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * S * 0.45;
          const H = S * rng.range(2.6, 4.2);
          const R = S * rng.range(0.025, 0.04);
          const base: V3 = [Math.cos(a) * d, 0, Math.sin(a) * d];
          const lean: V3 = [Math.cos(a) * H * 0.08, H, Math.sin(a) * H * 0.08];
          const top = add(base, lean);
          m.append(tube([base, add(base, [lean[0] * 0.5, H * 0.5, lean[2] * 0.5]), top], [R, R * 0.95, R * 0.8], i % 3 ? ROLE.leaf2 : ROLE.path, 5, false, true).setFlex((q) => clamp(q[1] / H, 0, 1) ** 2 * 0.7));
          // nœuds
          for (let k = 1; k < 6; k++) {
            const t = k / 6;
            m.append(cylinder(R * 1.25, R * 1.25, 0.03, ROLE.leaf, 5), m4Compose(add(base, [lean[0] * t, H * t, lean[2] * t])), { flex: t * t * 0.7 });
          }
          // plumets de feuilles fines au sommet
          for (let k = 0; k < 4; k++) {
            const t = 0.7 + k * 0.09;
            const b = add(base, [lean[0] * t, H * t, lean[2] * t]);
            const aa = a + k * 1.9;
            m.append(blade([b, add(b, [Math.cos(aa) * 0.25 * S, 0.02, Math.sin(aa) * 0.25 * S]), add(b, [Math.cos(aa) * 0.45 * S, -0.08 * S, Math.sin(aa) * 0.45 * S])], S * 0.05, ROLE.leaf).setFlex(0.9));
          }
        }
        h = S * 4;
        r = S * 0.6;
        block = true;
        break;
      }
      case "ivy": {
        // nappe de lierre contre un mur (−z) : tiges ramifiées et feuilles en écailles décollées de 4 cm
        const W = S * rng.range(0.8, 1.4), H = S * rng.range(1.8, 3.2);
        const stems = 4;
        for (let k = 0; k < stems; k++) {
          const x0 = (k / (stems - 1) - 0.5) * W * 0.5;
          const pts: V3[] = [];
          for (let i = 0; i <= 5; i++) pts.push([x0 + Math.sin(i * 1.3 + k) * W * 0.15, (i / 5) * H * rng.range(0.7, 1), 0.02]);
          m.append(tube(pts, pts.map(() => 0.012), ROLE.bark, 3, false, false));
        }
        const n = Math.round(W * H * 22);
        for (let i = 0; i < n; i++) {
          const y = H * Math.sqrt(rng.next());
          const spreadW = W * (0.35 + 0.65 * (1 - y / H) ** 0.5);
          const x = rng.range(-0.5, 0.5) * spreadW;
          const s = rng.range(0.06, 0.1) * S;
          m.append(ellipsoid(s, s * 0.9, 0.02, i % 3 ? ROLE.leaf : ROLE.leaf2, 4, 2), m4Compose([x, y, 0.04 + rng.range(0, 0.04)], qEuler(rng.range(-0.5, -0.1), 0, rng.range(-0.6, 0.6))), { flex: 0.15 });
        }
        h = H;
        r = W / 2;
        break;
      }
      case "lavender": {
        const n = 26;
        for (let i = 0; i < n; i++) {
          const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * S * 0.18;
          const H = S * rng.range(0.4, 0.6);
          const base: V3 = [Math.cos(a) * d, 0.1 * S, Math.sin(a) * d];
          const tip = add(base, [Math.cos(a) * H * 0.4, H, Math.sin(a) * H * 0.4]);
          m.append(tube([base, tip], [S * 0.006, S * 0.004], ROLE.leaf2, 3, false, false).setFlex((q) => clamp(q[1] / H, 0, 1)));
          m.append(ellipsoid(S * 0.018, S * 0.06, S * 0.018, ROLE.flower, 4, 3), m4Compose(tip, qAxis([Math.sin(a), 0, -Math.cos(a)], 0.38)), { flex: 1 });
        }
        m.append(ellipsoid(S * 0.28, S * 0.16, S * 0.28, ROLE.leaf2, 8, 4), m4Compose([0, S * 0.08, 0]));
        h = S * 0.7;
        r = S * 0.35;
        break;
      }
    }
    void block;
    return { generator: "plant", mesh: m, anchors: {}, footprint: { hx: r * 0.5, hz: p.species === "ivy" ? 0.1 : r * 0.5, r }, height: h };
  },
});
