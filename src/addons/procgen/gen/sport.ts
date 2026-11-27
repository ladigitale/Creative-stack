/**
 * Terrains de sport (`sport`, raccourci `sport.<kind>`) : terrain de football tracé (`pitch` : herbe tondue en bandes,
 * lignes réglementaires, poteaux de corner, panneaux publicitaires), but avec filet (`goal`), tribune garnie de
 * spectateurs (`stand`).
 *
 * Repère : base au sol, avant = +z. Terrain : longueur selon x, largeur selon z, centré. But : la ligne de but est en
 * z = 0 (poteaux en x = ±largeur/2), le filet part vers +z. Tribune : bord bas en z = 0 face à +z, gradins qui
 * montent vers -z.
 */
import { type V3, clamp, m4Compose } from "../core/math";
import { Mesh } from "../geom/mesh";
import { box } from "../geom/prims";
import { ROLE, type Role } from "../style/roles";
import { type PartList, partsBounds, partsToMesh } from "./parts";
import type { Rng } from "../core/rng";
import { pickTrade, resolveText, shopName, townName } from "../core/names";
import { textMesh } from "../geom/text";
import { AD_FONTS, FONT_IDS, pickFont } from "../fonts/index";

/** Textes des panneaux du stade : liste « A|B|C », ou commerces et villes générés. */
function adTexts(v: unknown, rng: Rng): string[] {
  const auto = () =>
    Array.from({ length: 8 }, (_, i) => {
      const r = rng.fork(`pub${i}`);
      return i % 3 === 2 ? `${townName(r)} Sports` : shopName(pickTrade(r), r.fork("nom"));
    }).join("|");
  // « auto » dans une liste (« Allez les Lions !|auto|auto ») : un nom généré à cette place
  const gen = auto().split("|");
  return resolveText(v, auto)
    .split("|")
    .map((x, i) => (x.trim() === "auto" ? gen[i % gen.length] : x.trim()))
    .filter(Boolean);
}
import { type Anchor, defineGenerator } from "./types";

export const SPORT_KINDS = ["pitch", "goal", "stand"] as const;

const Y: V3 = [0, 1, 0];
/**
 * Hauteur de l'herbe tondue au-dessus du pied de l'objet : la composition enfonce les objets de 2 cm, le terrain
 * affleure donc à 1,5 cm au-dessus du sol (le mode football y pose joueurs et ballon).
 */
export const PITCH_Y = 0.035;
export const PITCH_TOP = PITCH_Y - 0.02;

/** Bande plate horizontale (ligne tracée, bande d'herbe) de `a` à `b`, demi-largeur `w`, à la hauteur `y`. */
function strip(m: Mesh, a: [number, number], b: [number, number], w: number, y: number, role: number, ao = 1) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * w, nz = (dx / l) * w;
  const v0 = m.vertex([a[0] + nx, y, a[1] + nz], Y, role, ao);
  const v1 = m.vertex([b[0] + nx, y, b[1] + nz], Y, role, ao);
  const v2 = m.vertex([b[0] - nx, y, b[1] - nz], Y, role, ao);
  const v3 = m.vertex([a[0] - nx, y, a[1] - nz], Y, role, ao);
  // v0 → v1 → v2 tourne dans le sens direct vu d'en haut : face vers le haut quel que soit le sens du tracé
  m.quad(v0, v1, v2, v3);
}

function arc(m: Mesh, c: [number, number], r: number, a0: number, a1: number, w: number, y: number, role: number, keep?: (x: number, z: number) => boolean) {
  const n = Math.max(6, Math.ceil((Math.abs(a1 - a0) * r) / 0.5));
  for (let i = 0; i < n; i++) {
    const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 1)) / n;
    const p: [number, number] = [c[0] + Math.cos(t0) * r, c[1] + Math.sin(t0) * r];
    const q: [number, number] = [c[0] + Math.cos(t1) * r, c[1] + Math.sin(t1) * r];
    if (keep && !keep((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)) continue;
    strip(m, p, q, w, y, role);
  }
}

function disc(m: Mesh, c: [number, number], r: number, y: number, role: number) {
  const n = 14;
  const o = m.vertex([c[0], y, c[1]], Y, role);
  const ring = Array.from({ length: n }, (_, i) => m.vertex([c[0] + Math.cos((i / n) * Math.PI * 2) * r, y, c[1] + Math.sin((i / n) * Math.PI * 2) * r], Y, role));
  for (let i = 0; i < n; i++) m.tri(o, ring[(i + 1) % n], ring[i]);
}

export type PitchSpec = { L: number; W: number; gw: number; box: number; boxW: number; six: number; sixW: number; spot: number; circle: number; margin: number; boards: boolean; /** Textes des panneaux (tour à tour) ; vide : bande blanche stylisée. */ ads?: string[]; /** Police de chaque texte (même rang). */ adFonts?: string[] };

/** Terrain tracé : bandes de tonte, lignes, points, arcs, poteaux de corner, panneaux. */
export function pitchMesh(s: PitchSpec): Mesh {
  const m = new Mesh();
  const g = ROLE.grass, wh = ROLE.white;
  const { L, W, margin } = s;
  // bandes de tonte (alternées claires / sombres) sur tout le terrain et ses abords
  const n = Math.max(6, Math.round(L / 5.5) | 1);
  const sw = (L + 2 * margin) / (n + Math.round((2 * margin) / (L / n)));
  const x0 = -L / 2 - margin, z0 = -W / 2 - margin, z1 = W / 2 + margin;
  for (let i = 0, x = x0; x < L / 2 + margin - 1e-6; i++, x += sw) {
    const xe = Math.min(L / 2 + margin, x + sw);
    for (let z = z0; z < z1 - 1e-6; z += 8) {
      const hw = (Math.min(z1, z + 8) - z) / 2;
      strip(m, [x, z + hw], [xe, z + hw], hw, PITCH_Y, g);
    }
  }
  const y = PITCH_Y + 0.008, lw = 0.06;
  const line = (a: [number, number], b: [number, number]) => strip(m, a, b, lw, y, wh);
  // touches, lignes de but, médiane
  line([-L / 2 - lw, -W / 2], [L / 2 + lw, -W / 2]);
  line([-L / 2 - lw, W / 2], [L / 2 + lw, W / 2]);
  line([-L / 2, -W / 2], [-L / 2, W / 2]);
  line([L / 2, -W / 2], [L / 2, W / 2]);
  line([0, -W / 2], [0, W / 2]);
  arc(m, [0, 0], s.circle, 0, Math.PI * 2, lw, y, wh);
  disc(m, [0, 0], 0.15, y, wh);
  for (const sd of [-1, 1]) {
    const gx = (sd * L) / 2;
    // surface de réparation, surface de but, point de penalty, arc
    const bx = gx - sd * s.box;
    line([gx, -s.boxW / 2], [bx, -s.boxW / 2]);
    line([gx, s.boxW / 2], [bx, s.boxW / 2]);
    line([bx, -s.boxW / 2], [bx, s.boxW / 2]);
    if (s.six > 0) {
      const sx = gx - sd * s.six;
      line([gx, -s.sixW / 2], [sx, -s.sixW / 2]);
      line([gx, s.sixW / 2], [sx, s.sixW / 2]);
      line([sx, -s.sixW / 2], [sx, s.sixW / 2]);
    }
    const px = gx - sd * s.spot;
    disc(m, [px, 0], 0.12, y, wh);
    arc(m, [px, 0], s.circle, 0, Math.PI * 2, lw, y, wh, (x) => (x - bx) * -sd > 0.05);
    // arcs de coin
    for (const sz of [-1, 1]) {
      const a0 = Math.atan2(-sz, -sd);
      arc(m, [gx, (sz * W) / 2], 1, a0 - Math.PI / 4, a0 + Math.PI / 4, lw, y, wh);
    }
  }
  // poteaux de corner et panneaux autour du terrain
  const P: PartList = [];
  for (const sd of [-1, 1])
    for (const sz of [-1, 1]) {
      const c: V3 = [(sd * L) / 2, 0, (sz * W) / 2];
      P.push({ t: "rod", a: c, b: [c[0], 1.5, c[2]], r: 0.02, role: "yellow" });
      P.push({ t: "box", c: [c[0] - sd * 0.17, 1.38, c[2]], h: [0.17, 0.11, 0.008], role: sd > 0 ? "red" : "yellow" });
    }
  const texts = new Mesh();
  if (s.boards) {
    const roles: Role[] = ["red", "blue", "white", "yellow", "black", "accent", "green", "orange"];
    const d = Math.min(4, margin - 1.5);
    let k = 0;
    const ads = s.ads ?? [];
    const run = (a: [number, number], b: [number, number]) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), seg = 6, nn = Math.max(1, Math.round(len / seg));
      for (let i = 0; i < nn; i++) {
        const t = (i + 0.5) / nn;
        const cx = a[0] + (b[0] - a[0]) * t, cz = a[1] + (b[1] - a[1]) * t;
        const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
        const role = roles[(k++ * 5 + 3) % roles.length];
        const hl = len / nn / 2 - 0.04;
        P.push({ t: "box", c: [cx, 0.45, cz], h: alongX ? [hl, 0.45, 0.04] : [0.04, 0.45, hl], role });
        const ink = role === "white" || role === "yellow" ? "black" : "white";
        const ad = ads.length ? ads[(k - 1) % ads.length] : "";
        const font = s.adFonts?.[(k - 1) % ads.length];
        if (ad) {
          // texte face au terrain
          const t = textMesh(ad, { height: 0.42, maxWidth: hl * 2 - 0.5, maxHeight: 0.72, role: ROLE[ink], depth: 0.012, flat: true, weight: 0.12, font });
          const inward = alongX ? (cz < 0 ? 0 : Math.PI) : cx < 0 ? Math.PI / 2 : -Math.PI / 2;
          const off: V3 = alongX ? [0, 0, cz < 0 ? 0.045 : -0.045] : [cx < 0 ? 0.045 : -0.045, 0, 0];
          texts.append(t.mesh, m4Compose([cx + off[0], 0.47, cz + off[2]], [0, Math.sin(inward / 2), 0, Math.cos(inward / 2)]));
        } else
          // bande blanche (logo stylisé)
          P.push({ t: "box", c: [cx, 0.5, cz], h: alongX ? [hl * 0.5, 0.12, 0.045] : [0.045, 0.12, hl * 0.5], role: ink });
      }
    };
    run([-L / 2 + 2, -W / 2 - d], [L / 2 - 2, -W / 2 - d]);
    run([-L / 2 + 2, W / 2 + d], [L / 2 - 2, W / 2 + d]);
    for (const sd of [-1, 1]) {
      run([(sd * L) / 2 + sd * d, -W / 2 + 2], [(sd * L) / 2 + sd * d, -6]);
      run([(sd * L) / 2 + sd * d, 6], [(sd * L) / 2 + sd * d, W / 2 - 2]);
    }
  }
  m.append(partsToMesh(P, 0.7));
  if (texts.vertexCount) m.append(texts);
  return m;
}

/** But : poteaux et barre, cadre arrière, filet en mailles. */
export function goalParts(w: number, h: number, depth: number): PartList {
  const P: PartList = [];
  const r = 0.06;
  const hw = w / 2;
  P.push({ t: "rod", a: [-hw - r, 0, 0], b: [-hw - r, h + r, 0], r, role: "white" });
  P.push({ t: "rod", a: [hw + r, 0, 0], b: [hw + r, h + r, 0], r, role: "white" });
  P.push({ t: "rod", a: [-hw - r * 2, h + r, 0], b: [hw + r * 2, h + r, 0], r, role: "white" });
  // cadre arrière : montants, barre haute, barres au sol
  const top = depth * 0.5;
  for (const sx of [-1, 1]) {
    P.push({ t: "rod", a: [sx * hw, h, 0], b: [sx * hw, h * 0.92, top], r: 0.025, role: "metal" });
    P.push({ t: "rod", a: [sx * hw, h * 0.92, top], b: [sx * hw, 0, depth], r: 0.025, role: "metal" });
    P.push({ t: "rod", a: [sx * hw, 0, 0], b: [sx * hw, 0, depth], r: 0.02, role: "metal" });
  }
  P.push({ t: "rod", a: [-hw, h * 0.92, top], b: [hw, h * 0.92, top], r: 0.025, role: "metal" });
  P.push({ t: "rod", a: [-hw, 0, depth], b: [hw, 0, depth], r: 0.02, role: "metal" });
  // filet : mailles de 18 cm (fils fins)
  const mesh = 0.18, fr = 0.007;
  const nx = Math.max(2, Math.round(w / mesh));
  const back = (x: number, t: number): V3 => (t < 0.5 ? [x, h - (h - h * 0.92) * (t / 0.5), top * (t / 0.5)] : [x, h * 0.92 * (1 - (t - 0.5) / 0.5), top + (depth - top) * ((t - 0.5) / 0.5)]);
  for (let i = 0; i <= nx; i++) {
    const x = -hw + (w * i) / nx;
    P.push({ t: "rod", a: back(x, 0), b: back(x, 0.5), r: fr, role: "white" });
    P.push({ t: "rod", a: back(x, 0.5), b: back(x, 1), r: fr, role: "white" });
  }
  const nt = Math.max(4, Math.round((top + Math.hypot(depth - top, h)) / mesh));
  for (let j = 1; j < nt; j++) P.push({ t: "rod", a: back(-hw, j / nt), b: back(hw, j / nt), r: fr, role: "white" });
  // côtés
  for (const sx of [-1, 1]) {
    const nz = Math.max(3, Math.round(depth / mesh));
    for (let i = 1; i < nz; i++) {
      const z = (depth * i) / nz;
      const yt = z < top ? h - (h - h * 0.92) * (z / top) : h * 0.92 * (1 - (z - top) / (depth - top));
      P.push({ t: "rod", a: [sx * hw, 0, z], b: [sx * hw, yt, z], r: fr, role: "white" });
    }
    const ny = Math.max(3, Math.round(h / mesh));
    for (let j = 1; j < ny; j++) {
      const yy = (h * j) / ny;
      const zb = yy > h * 0.92 ? top * ((h - yy) / (h - h * 0.92)) : top + (depth - top) * (1 - yy / (h * 0.92));
      P.push({ t: "rod", a: [sx * hw, yy, 0], b: [sx * hw, yy, Math.max(0, zb)], r: fr, role: "white" });
    }
  }
  return P;
}

/** Tribune : gradins en béton, spectateurs (buste et tête) qui ondulent un peu, mur de fond. */
export function standMesh(length: number, rows: number, seed: number, fill: number): Mesh {
  const m = new Mesh();
  const rowD = 0.85, rowH = 0.42, seat = 0.62;
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const shirts: Role[] = ["cloth1", "cloth1", "cloth2", "cloth2", "white", "black", "red", "blue", "yellow", "green", "orange", "purple", "cloth3"];
  const skins: Role[] = ["skin", "leather", "path", "skin"];
  for (let r = 0; r < rows; r++) {
    const z = -r * rowD, y = 0.35 + r * rowH;
    m.append(box(length / 2, y / 2, rowD / 2, r % 2 ? ROLE.stone : ROLE.wall), m4Compose([0, y / 2, z - rowD / 2]));
    const n = Math.floor(length / seat);
    for (let i = 0; i < n; i++) {
      if (rnd() > fill) continue;
      const x = -length / 2 + seat * (i + 0.5) + (rnd() - 0.5) * 0.12;
      const zz = z - rowD * 0.45;
      const stand = rnd() < 0.25 ? 0.35 : 0;
      const torso = box(0.19, 0.27 + stand * 0.4, 0.12, ROLE[shirts[Math.floor(rnd() * shirts.length)]]);
      const head = box(0.1, 0.12, 0.1, ROLE[skins[Math.floor(rnd() * skins.length)]]);
      const by = y + 0.27 + stand * 0.4;
      // souplesse : les spectateurs bougent un peu avec le vent de la scène (foule vivante, sans coût)
      m.append(torso, m4Compose([x, by, zz]), { flex: 0.12 });
      m.append(head, m4Compose([x, by + 0.27 + stand * 0.4 + 0.13, zz]), { flex: 0.25 });
    }
  }
  const backH = 0.35 + rows * rowH + 1.6;
  m.append(box(length / 2, backH / 2, 0.15, ROLE.wall), m4Compose([0, backH / 2, -rows * rowD - 0.15]));
  return m;
}

export const sport = defineGenerator({
  id: "sport",
  label: "Terrains de sport",
  doc:
    "Stade de football : pitch (terrain tracé : herbe tondue en bandes, lignes réglementaires, surfaces, points, arcs, poteaux de corner, panneaux publicitaires si boards ; length × width, centré, longueur selon x), goal (but avec filet : width, height, depth ; ligne de but en z = 0, filet vers +z), stand (tribune garnie : length, rows, fill 0…1 ; bord bas en z = 0 face à +z ; spectateurs aux couleurs cloth1 / cloth2 de l'objet, qui ondulent au vent de la scène). Utilisé par le mode football de sonic-procgen.",
  tags: ["football", "stade", "terrain", "but", "tribune", "sport"],
  schema: {
    kind: { type: "enum", default: "pitch", options: SPORT_KINDS, doc: "Objet" },
    length: { type: "number", default: 105, min: 4, max: 140, unit: "m", doc: "Longueur (terrain, tribune)" },
    width: { type: "number", default: 68, min: 2, max: 100, unit: "m", doc: "Largeur du terrain ou du but" },
    height: { type: "number", default: 2.44, min: 0.5, max: 4, unit: "m", doc: "Hauteur du but" },
    depth: { type: "number", default: 2, min: 0.5, max: 4, unit: "m", doc: "Profondeur du filet" },
    goalWidth: { type: "number", default: 7.32, min: 1, max: 12, unit: "m", doc: "Largeur des buts (terrain)" },
    box: { type: "number", default: 16.5, min: 0, max: 30, unit: "m", doc: "Profondeur de la surface de réparation" },
    boxWidth: { type: "number", default: 40.32, min: 0, max: 60, unit: "m", doc: "Largeur de la surface de réparation" },
    six: { type: "number", default: 5.5, min: 0, max: 10, unit: "m", doc: "Profondeur de la surface de but (0 : aucune)" },
    sixWidth: { type: "number", default: 18.32, min: 0, max: 30, unit: "m", doc: "Largeur de la surface de but" },
    spot: { type: "number", default: 11, min: 2, max: 15, unit: "m", doc: "Distance du point de penalty" },
    circle: { type: "number", default: 9.15, min: 1, max: 12, unit: "m", doc: "Rayon du rond central" },
    margin: { type: "number", default: 6, min: 1, max: 15, unit: "m", doc: "Herbe tondue autour des lignes" },
    boards: { type: "bool", default: true, doc: "Panneaux publicitaires autour du terrain" },
    adsFont: { type: "enum", default: "auto", options: ["auto", ...FONT_IDS], doc: "Police des panneaux (auto : variée d'un panneau à l'autre)" },
    ads: { type: "string", default: "auto", doc: "Textes des panneaux, séparés par `|` (tour à tour) ; « auto » = commerces et villes générés (aussi un élément de la liste : « Allez !|auto|auto ») ; « none » = bandes blanches sans texte ; `{nom}` = icône" },
    rows: { type: "int", default: 10, min: 1, max: 30, doc: "Rangs de gradins" },
    fill: { type: "number", default: 0.85, min: 0, max: 1, doc: "Taux de remplissage de la tribune" },
    color1: { type: "string", default: "", doc: "Maillots des supporters (1re équipe), #rrggbb" },
    color2: { type: "string", default: "", doc: "Maillots des supporters (2e équipe), #rrggbb" },
  },
  build(p, ctx) {
    const kind = p.kind as (typeof SPORT_KINDS)[number];
    const rot: [number, number, number, number] = [0, 0, 0, 1];
    if (kind === "goal") {
      const P = goalParts(p.width === 68 ? 7.32 : p.width, p.height, p.depth);
      const mesh = partsToMesh(P, 0.6);
      const bb = partsBounds(P);
      const hx = Math.max(Math.abs(bb.min[0]), bb.max[0]);
      return { generator: "sport", mesh, anchors: { center: { pos: [0, 0, p.depth / 2], rot, scale: 1 } }, footprint: { hx, hz: p.depth / 2 + 0.1, r: Math.hypot(hx, p.depth) }, height: p.height + 0.12, extra: { label: "but", affords: ["look"] } };
    }
    if (kind === "stand") {
      const mesh = standMesh(p.length, p.rows, Math.floor(ctx.rng.next() * 1e6) + 1, clamp(p.fill, 0, 1));
      const depth = p.rows * 0.85 + 0.3;
      const h = 0.35 + p.rows * 0.42 + 1.6;
      const hex = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : undefined);
      const colors = { ...(hex(p.color1) ? { cloth1: p.color1 } : {}), ...(hex(p.color2) ? { cloth2: p.color2 } : {}) };
      return { generator: "sport", mesh, colors, anchors: { top: { pos: [0, h, -depth], rot, scale: 1 } }, footprint: { hx: p.length / 2, hz: depth / 2, r: Math.hypot(p.length / 2, depth / 2) }, height: h, extra: { label: "tribune", affords: ["look"] } };
    }
    const spec: PitchSpec = { L: p.length, W: p.width, gw: p.goalWidth, box: p.box, boxW: p.boxWidth, six: p.six, sixW: p.sixWidth, spot: p.spot, circle: p.circle, margin: p.margin, boards: !!p.boards, ads: adTexts(p.ads, ctx.rng) };
    spec.adFonts = spec.ads!.map((_, i) => pickFont(p.adsFont, AD_FONTS, (l) => ctx.rng.fork(`police${i}`).pick(l)));
    const mesh = pitchMesh(spec);
    const anchors: Record<string, Anchor> = { center: { pos: [0, 0, 0], rot, scale: 1 } };
    for (const sd of [-1, 1]) anchors[sd > 0 ? "goal.east" : "goal.west"] = { pos: [(sd * spec.L) / 2, 0, 0], rot, scale: 1 };
    const hx = spec.L / 2 + spec.margin, hz = spec.W / 2 + spec.margin;
    return { generator: "sport", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: 1, extra: { label: "terrain de football", affords: ["look"] } };
  },
});
