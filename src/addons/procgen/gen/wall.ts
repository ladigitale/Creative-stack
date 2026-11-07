/**
 * Générateur `wall` : clôtures en série le long d'une polyligne (`points`, coordonnées locales de l'objet ; placé à
 * l'origine avec `place: { at: [[0, 0]] }`, les points sont des coordonnées de scène). Muret de pierre sèche, muret
 * maçonné à chaperon, clôture de bois, palissade, haie taillée, grille sur mur bahut, clôture de bambou.
 *
 * Le maillage est **drapé** sur le relief par la composition (`extra.drape`) et chaque tronçon bloque la navigation
 * (`extra.segments`) sans occuper un grand disque d'emprise.
 */
import { type V3, clamp, m4Compose, mix, qAxis, qEuler, qMul } from "../core/math";
import { Field, type FieldPrim, polygonize } from "../geom/implicit";
import { Mesh } from "../geom/mesh";
import { box, cylinder, ellipsoid, lathe } from "../geom/prims";
import { ROLE } from "../style/roles";
import { defineGenerator } from "./types";

const KINDS = ["drystone", "coping", "fence", "picket", "hedge", "railing", "bamboo"] as const;

export const wall = defineGenerator({
  id: "wall",
  label: "Mur, clôture, haie",
  doc: "Clôture continue le long de `points` (coordonnées de scène ; placer la couche à l'origine : place {at: [[0,0]]}). kind = drystone (muret de pierre sèche à couronnement), coping (muret maçonné à chaperon), fence (piquets et lisses), picket (palissade à lattes), hedge (haie taillée), railing (grille de fer forgé sur mur bahut), bamboo (clôture japonaise). Drapé sur le relief, brèches et portillons selon `gaps`.",
  tags: ["clôture", "mur", "haie", "jardin", "ferme", "village"],
  schema: {
    kind: { type: "enum", default: "drystone", options: KINDS, doc: "Type de clôture" },
    points: { type: "points", default: [[-5, 0], [5, 0]], doc: "Tracé [[x, z], …] (m)" },
    height: { type: "number", default: 0, min: 0, max: 4, unit: "m", doc: "Hauteur (0 = selon le type)" },
    gaps: { type: "number", default: 0.1, min: 0, max: 1, doc: "Brèches, portillons, piquets manquants" },
    closed: { type: "bool", default: false, doc: "Boucle fermée (enclos)" },
  },
  build(p, ctx) {
    const rng = ctx.rng;
    const m = new Mesh();
    const pts = p.points.length >= 2 ? p.points.slice() : ([[-5, 0], [5, 0]] as [number, number][]);
    if (p.closed) pts.push(pts[0]);
    const kind = p.kind;
    const H: number = p.height > 0 ? p.height : ({ drystone: 0.85, coping: 1.0, fence: 1.1, picket: 1.0, hedge: 1.4, railing: 1.5, bamboo: 1.6 } as Record<string, number>)[kind] ?? 1;
    const segments: [number, number, number, number, number][] = [];
    const halfW = kind === "hedge" ? 0.45 : kind === "drystone" ? 0.28 : kind === "coping" ? 0.22 : 0.1;
    const hedgePrims: FieldPrim[] = [];
    for (let s = 0; s < pts.length - 1; s++) {
      const [x0, z0] = pts[s], [x1, z1] = pts[s + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 0.05) continue;
      segments.push([x0, z0, x1, z1, halfW]);
      const yaw = Math.atan2(x1 - x0, z1 - z0) - Math.PI / 2; // +x local = direction du tronçon
      const q = qAxis([0, 1, 0], yaw);
      const P = (u: number, y: number, v: number): V3 => {
        const t = u / L;
        const nx = -(z1 - z0) / L, nz = (x1 - x0) / L;
        return [mix(x0, x1, t) + nx * v, y, mix(z0, z1, t) + nz * v];
      };
      const B = (hx: number, hy: number, hz: number, role: number, u: number, y: number, v: number, extra?: [number, number, number]) =>
        m.append(box(hx, hy, hz, role), m4Compose(P(u, y, v), extra ? qEuler(extra[0], yaw + extra[1], extra[2]) : q));
      // brèche ou portillon : un intervalle de 1,2 m tiré par tronçon
      const gapAt = L > 4 && rng.chance(p.gaps) ? rng.range(1, L - 2.2) : -10;
      const inGap = (u: number) => u > gapAt && u < gapAt + 1.2;
      switch (kind) {
        case "drystone": {
          // assises de pierres irrégulières (pleine épaisseur), noyau en retrait, couronnement de pierres debout
          m.append(box(L / 2, H / 2 - 0.05, halfW - 0.06, ROLE.stone), m4Compose(P(L / 2, H / 2 - 0.05, 0), q));
          const courses = Math.max(2, Math.round(H / 0.22));
          for (let c = 0; c < courses; c++) {
            let u = (c % 2) * 0.2 * rng.range(0.5, 1);
            const ch = (H - 0.15) / courses;
            const taper = 1 - (c / courses) * 0.25;
            while (u < L) {
              const sw = rng.range(0.22, 0.42);
              const uu = Math.min(L, u + sw);
              if (!(inGap(u) && c >= courses - 1 - Math.floor(rng.next() * courses * 0.7))) B((uu - u) / 2 - 0.012, ch / 2 * rng.range(0.82, 0.98), halfW * taper + rng.range(-0.03, 0.02), rng.chance(0.2) ? ROLE.trim : ROLE.stone, (u + uu) / 2, c * ch + ch / 2, rng.range(-0.02, 0.02), [rng.range(-0.06, 0.06), rng.range(-0.05, 0.05), rng.range(-0.05, 0.05)]);
              u = uu + 0.02;
            }
          }
          for (let u = 0.1; u < L; u += 0.26) {
            if (inGap(u)) continue;
            B(0.06, 0.12, halfW * 0.7, ROLE.stone, u, H - 0.08, 0, [rng.range(-0.1, 0.1), rng.range(-0.08, 0.08), rng.range(-0.25, 0.25)]);
          }
          // mousse et touffes au pied
          for (let k = 0; k < Math.round(L / 2.5); k++) m.append(ellipsoid(rng.range(0.2, 0.35), 0.08, 0.12, ROLE.leaf2, 6, 3), m4Compose(P(rng.range(0, L), H - 0.02, rng.range(-0.1, 0.1)), q));
          break;
        }
        case "coping": {
          // muret enduit, chaperon en dos d'âne, piliers aux extrémités et tous les 4 m
          m.append(box(L / 2, H / 2 - 0.06, halfW, ROLE.wall), m4Compose(P(L / 2, H / 2 - 0.06, 0), q));
          m.append(box(L / 2 + 0.04, 0.05, halfW + 0.06, ROLE.trim), m4Compose(P(L / 2, H - 0.07, 0), q));
          m.append(box(L / 2 + 0.04, 0.06, 0.06, ROLE.trim), m4Compose(P(L / 2, H + 0.0, 0), qMul(q, qAxis([1, 0, 0], Math.PI / 4))));
          m.append(box(L / 2 + 0.02, 0.12, halfW + 0.02, ROLE.stone), m4Compose(P(L / 2, 0.12, 0), q));
          const n = Math.max(1, Math.round(L / 4));
          for (let k = 0; k <= n; k++) {
            const u = (k * L) / n;
            B(0.2, H / 2 + 0.12, halfW + 0.06, ROLE.wall, u, H / 2 + 0.12, 0);
            B(0.25, 0.05, halfW + 0.11, ROLE.trim, u, H + 0.28, 0);
            if (rng.chance(0.4)) m.append(lathe([[0.1, 0], [0.12, 0.1], [0, 0.22]], ROLE.trim, 8), m4Compose(P(u, H + 0.33, 0)));
          }
          // plaques d'enduit tombé
          for (let k = 0; k < Math.round(L / 3); k++) B(rng.range(0.15, 0.3), rng.range(0.08, 0.14), halfW + 0.005, ROLE.stone, rng.range(0.4, L - 0.4), rng.range(0.3, H - 0.3), 0);
          break;
        }
        case "fence":
        case "picket":
        case "bamboo": {
          const step = kind === "fence" ? 2 : kind === "picket" ? 0.14 : 1.8;
          const posts = Math.max(1, Math.round(L / (kind === "picket" ? 1.8 : step)));
          for (let k = 0; k <= posts; k++) {
            const u = (k * L) / posts;
            if (inGap(u) && kind === "fence" && rng.chance(0.5)) continue;
            const lean = rng.range(-0.06, 0.06) * (kind === "fence" ? 1 : 0.3);
            if (kind === "bamboo") m.append(cylinder(0.045, 0.045, H + 0.1, ROLE.path, 6), m4Compose(P(u, 0, 0)));
            else B(0.045, (H + 0.1) / 2, 0.045, ROLE.wood, u, (H + 0.1) / 2, 0, [lean, 0, lean * 0.5]);
          }
          if (kind === "fence") {
            for (const y of [0.38, 0.85].map((f) => f * H)) {
              // lisses légèrement voilées, une parfois cassée et pendante
              if (inGap(L / 2) && y > 0.5) continue;
              B(L / 2, 0.035, 0.022, ROLE.wood, L / 2, y + rng.range(-0.03, 0.03), 0.06, [0, 0, rng.range(-0.015, 0.015)]);
            }
          } else if (kind === "picket") {
            for (const y of [0.25, 0.7].map((f) => f * H)) B(L / 2, 0.03, 0.02, ROLE.paper, L / 2, y, 0.05);
            for (let u = 0.07; u < L; u += 0.14) {
              if (inGap(u)) continue;
              const h = H * rng.range(0.95, 1.02);
              B(0.045, h / 2 - 0.04, 0.012, ROLE.paper, u, h / 2 - 0.04, 0.08);
              m.append(box(0.032, 0.032, 0.012, ROLE.paper), m4Compose(P(u, h - 0.06, 0.08), qEuler(0, yaw, Math.PI / 4)));
            }
          } else {
            // kenninji : cannes verticales serrées, traverses liées
            for (let u = 0.03; u < L; u += 0.065) B(0.028, H / 2 - 0.05, 0.028, (Math.round(u / 0.065) % 3) ? ROLE.path : ROLE.leaf2, u, H / 2, 0.03);
            for (const y of [0.3, 0.65, 0.95].map((f) => f * H)) B(L / 2, 0.03, 0.03, ROLE.bark, L / 2, y, 0.08);
          }
          break;
        }
        case "railing": {
          // mur bahut et grille à barreaux lancés, pilastres
          m.append(box(L / 2, 0.3, 0.18, ROLE.stone), m4Compose(P(L / 2, 0.3, 0), q));
          m.append(box(L / 2 + 0.03, 0.04, 0.22, ROLE.trim), m4Compose(P(L / 2, 0.62, 0), q));
          B(L / 2, 0.02, 0.02, ROLE.metal, L / 2, 0.75, 0);
          B(L / 2, 0.02, 0.02, ROLE.metal, L / 2, H - 0.15, 0);
          for (let u = 0.06; u < L; u += 0.12) {
            B(0.012, (H - 0.66) / 2, 0.012, ROLE.metal, u, 0.66 + (H - 0.66) / 2, 0);
            m.append(lathe([[0.03, 0], [0.012, 0.08], [0, 0.1]], ROLE.metal, 4), m4Compose(P(u, H, 0)));
          }
          const n = Math.max(1, Math.round(L / 3.5));
          for (let k = 0; k <= n; k++) {
            B(0.16, (H + 0.2) / 2, 0.16, ROLE.stone, (k * L) / n, (H + 0.2) / 2, 0);
            B(0.2, 0.05, 0.2, ROLE.trim, (k * L) / n, H + 0.23, 0);
          }
          break;
        }
        case "hedge": {
          // haie : capsules épaisses soudées le long du tracé (polygonisées en une passe à la fin)
          const a: V3 = [x0, H / 2, z0], b: V3 = [x1, H / 2, z1];
          hedgePrims.push({ kind: "capsule", a, b, ra: halfW, rb: halfW, role: s % 2 ? ROLE.leaf : ROLE.leaf2, tag: s, bump: { amp: 0.04, freq: 4, seed: s } });
          break;
        }
      }
    }
    if (hedgePrims.length) {
      // haie taillée : base aplatie au sol, dessus plat, flancs légèrement irréguliers
      const f = new Field(hedgePrims.flatMap((c) => (c.kind === "capsule" ? [c, { ...c, a: [c.a[0], H * 0.85 - halfW * 0.5, c.a[2]] as V3, b: [c.b[0], H * 0.85 - halfW * 0.5, c.b[2]] as V3, tag: c.tag + 100 }] : [])), hedgePrims.flatMap((_, i) => [{ a: i * 2, b: i * 2 + 1, k: 0.3 }, ...(i > 0 ? [{ a: (i - 1) * 2, b: i * 2, k: 0.2 }, { a: (i - 1) * 2 + 1, b: i * 2 + 1, k: 0.2 }] : [])]));
      const { mesh } = polygonize(f, { cell: clamp(halfW * 0.22, 0.07, 0.15), smooth: 2, ao: true });
      mesh.mapPos((q) => [q[0], Math.min(Math.max(q[1], 0) * 1.0, H), q[2]]).computeNormals();
      mesh.setFlex(0.08);
      m.append(mesh);
    }
    const b = m.bounds();
    const hx = Math.max(-b.min[0], b.max[0]), hz = Math.max(-b.min[2], b.max[2]);
    return { generator: "wall", mesh: m, anchors: {}, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: H, extra: { drape: true, segments } };
  },
});
