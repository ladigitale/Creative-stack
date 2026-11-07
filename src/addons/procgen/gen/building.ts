/**
 * Générateur `building` : grammaire de découpe — volumes (corps, aile, appentis, tourelle, porche) → soubassement →
 * étages → travées → ouvertures — puis toits (deux pans à coyaux, croupe, mansarde, pignon sur rue, monopente,
 * pavillon à courbure japonaise, cône), lucarnes, cheminées, gouttières.
 *
 * La crédibilité vient des **retraits** et des **irrégularités maîtrisées** : encadrements saillants, appuis, linteaux
 * ou arcs à clé, volets pleins ou persiennes, petits bois, jardinières, bandeaux, corniches à modillons, chaînes
 * d'angle, pierres apparentes sous l'enduit, travées de largeur inégale, porte décentrée, faux aplomb.
 *
 * Chaque maison tire son « allure » (matériaux, couleurs par rôle, type d'ouvertures, annexes) de sa propre graine :
 * deux voisines ne se ressemblent pas, la même graine redonne la même maison.
 *
 * Repère : façade principale vers +z, base en y = 0, emprise recentrée en x et z. Ancres `door` (devant la porte)
 * et `roof` (faîte).
 */
import { type Q, type V3, DEG, clamp, m4Compose, mix, qAxis, qEuler, qMul } from "../core/math";
import type { Rng } from "../core/rng";
import { Mesh } from "../geom/mesh";
import { box, cylinder, ellipsoid, extrude, lathe, ngon } from "../geom/prims";
import { ROLE } from "../style/roles";
import { defineGenerator } from "./types";

const STYLES = ["bourg", "colombages", "vapeur", "moderne", "neon", "chaumiere", "pierre", "ferme", "chalet", "mediterraneen", "japonais", "chateau", "tour", "moulin", "chapelle", "phare", "boutique"] as const;
const ROOFS = ["auto", "gable", "pignon", "hip", "mansard", "flat", "shed"] as const;
const WALLS = ["auto", "enduit", "pierre", "brique", "bardage", "colombages"] as const;
const ROOFING = ["auto", "tuile", "ardoise", "chaume", "zinc", "lauze"] as const;

type Style = (typeof STYLES)[number];
type WallFinish = "enduit" | "pierre" | "brique" | "bardage" | "colombages" | "shoji" | "beton";
type RoofMat = "tuile" | "ardoise" | "chaume" | "zinc" | "lauze" | "kawara";
type WinKind = "rect" | "arch" | "segment" | "mullion" | "lancet" | "wide" | "shoji";

/** Allure d'une maison : tirée une fois par graine, partagée par tous ses volumes. */
type Look = {
  finish: WallFinish;
  wall: number;
  base: number;
  trim: number;
  roofMat: RoofMat;
  roof: number;
  shutter: number;
  shutterKind: "none" | "pleins" | "persiennes";
  door: number;
  win: WinKind;
  petitsBois: boolean;
  ornament: number;
  planters: number;
  quoins: boolean;
  bands: boolean;
  modillons: boolean;
  gutters: boolean;
  genoise: boolean;
  coyau: boolean;
  pitch: number;
};

const I: Q = [0, 0, 0, 1];
const yawQ = (a: number): Q => qAxis([0, 1, 0], a);

/** Façade : origine au pied du mur (surface), lacet tel que +z local sorte du mur, +x local vers la droite. */
type Face = { o: V3; yaw: number; w: number; kind: "front" | "back" | "side"; jet: number };

/** Arc (points d'un cercle) de `a0` à `a1`. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): [number, number][] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as [number, number];
  });
}

/** Contour d'une baie (rectangle, plein cintre, arc segmentaire, ogive) de largeur `w`, hauteur totale `h`, élargi de `e`. */
function bayOutline(kind: WinKind, w: number, h: number, e = 0): [number, number][] {
  const hw = w / 2 + e;
  if (kind === "arch") {
    const leg = h - w / 2;
    return [[-hw, -e], [hw, -e], ...arc(0, leg, hw, 0, Math.PI, 8).slice(0, 9), [-hw, -e]].slice(0, -1) as [number, number][];
  }
  if (kind === "segment") {
    const rise = w * 0.16;
    const leg = h - rise;
    const R = (hw * hw + rise * rise) / (2 * rise);
    const a = Math.asin(clamp(hw / R, -1, 1));
    return [[-hw, -e], [hw, -e], ...arc(0, leg + rise + e - R, R + e * 0, Math.PI / 2 - a, Math.PI / 2 + a, 5)];
  }
  if (kind === "lancet") {
    const leg = h - w * 0.8;
    const pts: [number, number][] = [[-hw, -e], [hw, -e], [hw, leg]];
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      pts.push([hw * (1 - t) ** 1.4 * (1 - 0.15 * t), leg + (h + e - leg) * Math.sin((t * Math.PI) / 2)]);
    }
    pts.push([0, h + e]);
    for (let i = 4; i >= 1; i--) {
      const t = i / 5;
      pts.push([-hw * (1 - t) ** 1.4 * (1 - 0.15 * t), leg + (h + e - leg) * Math.sin((t * Math.PI) / 2)]);
    }
    pts.push([-hw, leg]);
    return pts;
  }
  return [[-hw, -e], [hw, -e], [hw, h + e], [-hw, h + e]];
}

/** Bande d'encadrement d'une baie cintrée (forme en U), en plan x/y. */
function archBand(kind: WinKind, w: number, h: number, fr: number): [number, number][] {
  const outer = bayOutline(kind, w, h, fr);
  const inner = bayOutline(kind, w, h, 0);
  // on retire la base (2 premiers points) des deux contours : U ouvert vers le bas
  const o = outer.slice(1).concat([outer[0]]); // départ en bas à droite, sens trigo jusqu'en bas à gauche
  const i = inner.slice(1).concat([inner[0]]).reverse();
  return [...o, ...i];
}

export const building = defineGenerator({
  id: "building",
  label: "Bâtiment",
  doc: "Maison ou édifice par grammaire de découpe : corps, ailes, appentis, tourelles, porches, perrons ; fenêtres (rectangulaires, plein cintre, segmentaires, à meneaux, ogives, œils-de-bœuf), volets pleins ou persiennes, petits bois, jardinières, balcons en ferronnerie, corniches à modillons, gouttières ; toits à deux pans (coyaux), pignon sur rue, croupe, mansarde, monopente, terrasse, pavillon. Matériaux : enduit, pierre appareillée, brique, bardage, colombages ; tuile, ardoise, chaume, zinc, lauze. Styles : bourg, colombages, vapeur, moderne, neon, chaumiere, pierre, ferme, chalet, mediterraneen, japonais, chateau, tour, moulin, chapelle, phare, boutique. Chaque graine donne une maison distincte.",
  tags: ["ville", "village", "rue", "architecture", "maison", "monument"],
  schema: {
    style: { type: "enum", default: "bourg", options: STYLES, doc: "Style" },
    floors: { type: "int", default: 2, min: 1, max: 12, doc: "Étages (rez-de-chaussée compris) ; tour, phare, moulin : hauteur" },
    bays: { type: "int", default: 3, min: 1, max: 8, doc: "Travées en façade" },
    depth: { type: "number", default: 7, min: 3, max: 25, unit: "m", doc: "Profondeur" },
    roof: { type: "enum", default: "auto", options: ROOFS, doc: "Toit (auto = selon le style et la graine ; pignon = pignon sur rue ; shed = monopente)" },
    walls: { type: "enum", default: "auto", options: WALLS, doc: "Parement des murs (auto = selon le style)" },
    roofing: { type: "enum", default: "auto", options: ROOFING, doc: "Couverture (auto = selon le style)" },
    shop: { type: "bool", default: false, doc: "Vitrine au rez-de-chaussée" },
    balconies: { type: "number", default: 0.2, min: 0, max: 1, doc: "Probabilité de balcon par fenêtre d'étage" },
    shutters: { type: "number", default: 0.6, min: 0, max: 1, doc: "Probabilité de volets" },
    ornament: { type: "number", default: -1, min: -1, max: 1, doc: "Richesse du décor (modillons, clés, pilastres, jardinières) ; −1 = selon la graine" },
    annexes: { type: "number", default: 0.5, min: 0, max: 1, doc: "Probabilité d'annexes (aile, appentis, porche, tourelle, escalier extérieur)" },
    decay: { type: "number", default: 0.1, min: 0, max: 1, doc: "Usure (volets manquants, enduit tombé, faux aplomb)" },
    chimneys: { type: "int", default: -1, min: -1, max: 4, doc: "Cheminées (−1 = selon la graine)" },
  },
  build(p, ctx) {
    const rng = ctx.rng;
    const st = p.style as Style;
    const mesh = new Mesh();
    const add = (m: Mesh, pos: V3, q: Q = I) => mesh.append(m, m4Compose(pos, q));
    const B = (hx: number, hy: number, hz: number, role: number, pos: V3, q: Q = I, r = 0) => add(box(hx, hy, hz, role, r), pos, q);
    // emprise en plan, suivie pendant la construction (recentrée à la fin)
    const plan = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
    const ext = (x0: number, z0: number, x1: number, z1: number) => {
      plan.x0 = Math.min(plan.x0, x0);
      plan.z0 = Math.min(plan.z0, z0);
      plan.x1 = Math.max(plan.x1, x1);
      plan.z1 = Math.max(plan.z1, z1);
    };
    let roofTop = 0;
    let door: V3 = [0, 0, 0];

    /* ---------- édifices singuliers ---------- */
    if (st === "moulin" || st === "phare" || st === "tour") {
      const r = singular(st, p, rng, mesh, ext);
      roofTop = r.top;
      door = r.door;
    } else {
      const look = pickLook(st, p, rng);
      const modern = st === "moderne" || st === "neon";
      const bayBase = modern ? 3.2 : st === "chaumiere" || st === "ferme" ? 2.6 : st === "japonais" ? 1.8 : 2.7;
      const fhBase = modern ? 3.3 : st === "chaumiere" ? 2.6 : st === "japonais" ? 2.9 : st === "chateau" ? 3.6 : 3;
      const floors = st === "chapelle" ? 1 : p.floors;
      // travées de largeur inégale (±8 %), étages de hauteur légèrement variable
      const bays = p.bays;
      const bayW = Array.from({ length: bays }, () => bayBase * (modern ? 1 : rng.range(0.92, 1.1)));
      const margin = modern ? 0 : st === "chateau" ? 0.9 : 0.35;
      const W = bayW.reduce((s, b) => s + b, 0) + margin * 2;
      const D = st === "chapelle" ? Math.max(p.depth, W * 1.5) : p.depth;
      const fh = Array.from({ length: floors }, (_, f) => (st === "chapelle" ? Math.max(5, W * 0.75) : fhBase * (f === 0 && (st === "bourg" || st === "boutique" || p.shop) ? 1.12 : 1) * (modern ? 1 : rng.range(0.96, 1.04))));
      const plinth = modern ? 0.25 : st === "japonais" ? 0.6 : st === "chalet" || st === "ferme" ? 0.35 : rng.range(0.4, 0.65);
      const wallH = fh.reduce((s, h) => s + h, 0);
      const top = plinth + wallH;
      const floorY = (f: number) => plinth + fh.slice(0, f).reduce((s, h) => s + h, 0);
      // encorbellement des étages (colombages)
      const jet = look.finish === "colombages" && floors > 1 && rng.chance(0.75) ? rng.range(0.22, 0.4) : 0;
      // porte : travée tirée (pas toujours au milieu)
      const doorBay = st === "chapelle" ? Math.floor(bays / 2) : bays <= 2 ? rng.int(0, bays - 1) : rng.chance(0.55) ? Math.floor((bays - 1) / 2) + (bays % 2 === 0 && rng.chance(0.5) ? 1 : 0) : rng.pick([0, bays - 1]);
      const bayX = (b: number) => -W / 2 + margin + bayW.slice(0, b).reduce((s, x) => s + x, 0) + bayW[b] / 2;
      const roofKind = pickRoof(st, p.roof, rng, W, D);

      // ---- corps principal
      body(0, 0, W, D, floors, fh, plinth, jet, look, true);
      ext(-W / 2, -D / 2, W / 2, D / 2 + 0.3);

      // ---- ouvertures du corps principal
      const front: Face = { o: [0, 0, D / 2], yaw: 0, w: W, kind: "front", jet };
      const back: Face = { o: [0, 0, -D / 2], yaw: Math.PI, w: W, kind: "back", jet };
      const shopFront = (p.shop || st === "boutique") && floors >= 1 && !(st === "chapelle");
      for (const face of [front, back]) {
        const r = rng.fork(face.kind);
        const blind = face.kind === "back" ? 0.35 : 0;
        for (let f = 0; f < floors; f++) {
          for (let b = 0; b < bays; b++) {
            const u = face.kind === "front" ? bayX(b) : -bayX(b);
            const y0 = floorY(f);
            if (face.kind === "front" && f === 0 && b === doorBay) {
              const dh = Math.min(fh[0] - 0.45, st === "chapelle" ? 3.6 : modern ? 2.4 : 2.35);
              const dw = st === "chapelle" ? 1.8 : modern ? 1.6 : st === "ferme" && rng.chance(0.3) ? 2.6 : rng.range(1.0, 1.2);
              doorway(face, u, plinth, dw, dh, look, r, st === "chapelle" || (st === "ferme" && dw > 2) || (look.ornament > 0.6 && rng.chance(0.4)));
              door = [u, 0, D / 2 + 0.8];
              continue;
            }
            if (face.kind === "front" && f === 0 && shopFront) {
              shopWindow(face, u, plinth + 0.3, bayW[b] - 0.55, fh[0] - 1.0, look, r);
              continue;
            }
            if (r.chance(blind) || (face.kind === "back" && f === 0 && r.chance(0.3))) continue;
            const ww = modern ? bayW[b] * 0.6 : st === "japonais" ? bayW[b] * 0.7 : st === "chaumiere" || st === "ferme" ? 0.85 : look.win === "mullion" ? 1.25 : rng.range(0.95, 1.1);
            let wh = modern ? fh[f] * 0.58 : st === "chapelle" ? fh[f] * 0.55 : st === "japonais" ? fh[f] * 0.6 : (st === "chaumiere" || st === "ferme" ? 0.95 : 1.45) * (f === floors - 1 && floors > 2 ? 0.85 : 1);
            if (f === 0 && !modern && st !== "chapelle") wh *= 0.92;
            const wy = f === 0 ? y0 + (modern ? 0.5 : st === "chapelle" ? fh[0] * 0.3 : 0.8) : y0 + fh[f] * 0.24;
            const kind: WinKind = st === "chapelle" ? "lancet" : look.win;
            windowAt(face, u, wy, ww, wh, kind, look, r, f, face.kind === "front");
            if (f > 0 && face.kind === "front" && !modern && r.chance(p.balconies)) balcony(face, u, wy, ww, look, r);
          }
          if (f > 0 && look.bands && !modern) bandAround(f);
        }
      }
      // fenêtres de pignon (côtés) pour les corps profonds
      for (const sx of [-1, 1]) {
        const face: Face = { o: [sx * W / 2, 0, 0], yaw: (sx * Math.PI) / 2, w: D, kind: "side", jet: 0 };
        const r = rng.fork(`side${sx}`);
        const n = D > 8.5 ? 2 : D > 5 ? 1 : 0;
        for (let f = 0; f < floors; f++)
          for (let k = 0; k < n; k++) {
            if (!r.chance(f === 0 ? 0.35 : 0.6)) continue;
            const u = n === 1 ? r.range(-0.6, 0.6) : (k - 0.5) * D * 0.45;
            const kind: WinKind = st === "chapelle" ? "lancet" : look.win === "wide" ? "wide" : look.win;
            windowAt(face, u, floorY(f) + (f === 0 ? 0.8 : fh[f] * 0.24), modern ? 1.6 : 0.85, st === "chapelle" ? fh[0] * 0.5 : modern ? 1.8 : 1.2, kind, look, r, f, false);
          }
        // contreforts de chapelle
        if (st === "chapelle")
          for (let k = 0; k < 3; k++) {
            const u = (k - 1) * D * 0.33;
            const h = fh[0] * 0.8;
            B(0.25, h / 2, 0.22, look.base, at(face, u + D * 0.16, h / 2, 0.22), yawQ(face.yaw));
            B(0.2, 0.25, 0.22, look.base, at(face, u + D * 0.16, h + 0.05, 0.1), qMul(yawQ(face.yaw), qAxis([1, 0, 0], -30 * DEG)));
          }
      }

      // ---- toit du corps principal
      const ridgeAlongZ = roofKind === "pignon" || (st === "chalet" && roofKind === "gable") || st === "chapelle";
      const rt = roof(0, 0, W, D, top, roofKind === "pignon" ? "gable" : roofKind, ridgeAlongZ, look, rng.fork("roof"), true);
      roofTop = rt;
      // œil-de-bœuf ou fenêtre haute dans le pignon sur rue
      if (ridgeAlongZ && (roofKind === "gable" || roofKind === "pignon") && st !== "chapelle") {
        const gh = Math.tan(look.pitch) * (W / 2);
        if (gh > 1.4) {
          const r = rng.fork("gable");
          if (r.chance(0.5) || st === "chalet") windowAt(front, 0, top + gh * 0.18, st === "chalet" ? 1.4 : 0.9, Math.min(1.3, gh * 0.5), st === "chalet" ? "rect" : look.win, look, r, floors, true);
          else oculus(front, 0, top + gh * 0.4, 0.38, look);
        }
      }
      if (st === "chapelle") {
        oculus(front, 0, top + Math.tan(look.pitch) * (W / 2) * 0.35, 0.55, look);
        // clocher-porche
        const tw = Math.min(W * 0.42, 2.6);
        const th = top + Math.tan(look.pitch) * (W / 2) + rng.range(1.5, 3);
        B(tw / 2, th / 2, tw / 2, look.wall, [0, th / 2, -D / 2 + tw / 2 + 0.1], I, 0.02);
        for (const sx of [-1, 1]) B(0.06, 0.6, tw / 2 + 0.02, look.trim, [sx * tw / 2, th - 0.9, -D / 2 + tw / 2 + 0.1]);
        const belfry: Face = { o: [0, 0, -D / 2 + tw + 0.1], yaw: 0, w: tw, kind: "side", jet: 0 };
        const hole = extrude(bayOutline("arch", tw * 0.45, 1.3), 0.02, ROLE.ink);
        add(hole, at(belfry, 0, th - 1.6, 0.01));
        const spire = lathe([[tw * 0.72, 0], [tw * 0.08, tw * 2.1], [0, tw * 2.3]], look.roof, 4, true);
        spire.mapPos((q) => [(q[0] - q[2]) * Math.SQRT1_2, q[1], (q[0] + q[2]) * Math.SQRT1_2]).computeNormals();
        add(spire.facet(), [0, th, -D / 2 + tw / 2 + 0.1]);
        add(cylinder(0.03, 0.03, 0.8, ROLE.metal, 4), [0, th + tw * 2.3, -D / 2 + tw / 2 + 0.1]);
        B(0.22, 0.03, 0.03, ROLE.metal, [0, th + tw * 2.3 + 0.55, -D / 2 + tw / 2 + 0.1]);
        roofTop = Math.max(roofTop, th + tw * 2.3 + 0.8);
      }

      // ---- annexes : aile, appentis, tourelle, porche, escalier extérieur, perron
      const ar = rng.fork("annexes");
      const annex = p.annexes;
      if (!modern && st !== "chapelle" && st !== "japonais") {
        const side = ar.chance(0.5) ? 1 : -1;
        if (st === "ferme" || (ar.chance(annex * 0.55) && st !== "boutique")) {
          // aile en retour ou grange accolée : pignon perpendiculaire, plus basse
          const barn = st === "ferme";
          const ww = barn ? ar.range(4.5, 6.5) : ar.range(3, 4.2);
          const wd = barn ? D + ar.range(0, 1.5) : ar.range(D * 0.6, D * 0.95);
          const wf = Math.max(1, floors - (barn ? 0 : 1));
          const wfh = Array.from({ length: wf }, () => (barn ? Math.max(3.4, fh[0] * 1.1) : fh[0]));
          const cx = side * (W / 2 + ww / 2 - 0.02);
          const cz = barn ? -0.4 : -D / 2 + wd / 2 + ar.range(0, D - wd);
          const wlook: Look = barn ? { ...look, finish: "bardage", wall: ROLE.wood, shutterKind: "pleins", quoins: false, modillons: false, door: look.door === ROLE.metal ? ROLE.wood : look.door } : look;
          body(cx, cz, ww, wd, wf, wfh, plinth, 0, wlook, false);
          ext(cx - ww / 2, cz - wd / 2, cx + ww / 2, cz + wd / 2);
          const wTop = plinth + wfh.reduce((s, h) => s + h, 0);
          const wface: Face = { o: [cx, 0, cz + wd / 2], yaw: 0, w: ww, kind: "front", jet: 0 };
          if (barn) {
            // porte charretière à deux vantaux et linteau de bois
            const dw = Math.min(ww - 1.2, 3.2), dh = Math.min(wTop - plinth - 0.6, 3.1);
            B(dw / 2, dh / 2, 0.025, wlook.door, at(wface, 0, plinth + dh / 2, 0.06));
            B(0.04, dh / 2, 0.04, ROLE.wood, at(wface, 0, plinth + dh / 2, 0.1));
            for (const sx of [-1, 1]) {
              add(box(0.03, dh * 0.45, 0.03, ROLE.wood), at(wface, (sx * dw) / 4, plinth + dh / 2, 0.1), qMul(yawQ(0), qAxis([0, 0, 1], sx * Math.atan2(dw / 2, dh) * 0.95)));
              B(0.08, dh / 2 + 0.08, 0.06, ROLE.wood, at(wface, sx * (dw / 2 + 0.08), plinth + dh / 2, 0.05));
            }
            B(dw / 2 + 0.25, 0.1, 0.08, ROLE.wood, at(wface, 0, plinth + dh + 0.1, 0.05));
            // fenestron de fenil
            const hy = wTop + Math.tan(look.pitch) * (ww / 2) * 0.35;
            B(0.35, 0.3, 0.03, ROLE.wood, at(wface, 0, hy, 0.04));
          } else {
            const kind: WinKind = look.win;
            for (let f = 0; f < wf; f++) windowAt(wface, 0, plinth + f * fh[0] + (f === 0 ? 0.8 : fh[0] * 0.24), 0.95, 1.3, kind, look, ar, f, true);
          }
          const wr = roof(cx, cz, ww, wd, wTop, "gable", true, wlook, ar.fork("roof"), false);
          roofTop = Math.max(roofTop, wr);
        } else if (ar.chance(annex * 0.6)) {
          // appentis monopente sur un pignon
          const aw = ar.range(1.8, 2.8), ad = ar.range(D * 0.45, D * 0.8);
          const ah = ar.range(2.2, 2.7);
          const cx = side * (W / 2 + aw / 2 - 0.02), cz = -D / 2 + ad / 2 + ar.range(0, D - ad);
          const alook: Look = ar.chance(0.5) ? { ...look, finish: "bardage", wall: ROLE.wood } : look;
          body(cx, cz, aw, ad, 1, [ah], 0.15, 0, alook, false);
          ext(cx - aw / 2, cz - ad / 2, cx + aw / 2, cz + ad / 2);
          const pitch = 18 * DEG;
          const rise = Math.tan(pitch) * aw;
          const slope = (aw + 0.4) / Math.cos(pitch);
          add(box(slope / 2, 0.05, ad / 2 + 0.25, alook.roof, 0), [cx + side * 0.1, 0.15 + ah + rise / 2 + 0.05, cz], qAxis([0, 0, 1], -side * pitch));
          const tri = extrude([[0, 0], [aw, 0], [aw, rise]].map(([x, y]) => [x, y] as [number, number]), 0.04, alook.wall);
          for (const sz of [-1, 1]) add(tri, [cx - side * aw / 2 * 1, 0.15 + ah, cz + sz * (ad / 2 - 0.02) - 0.02], side > 0 ? I : yawQ(Math.PI));
          const aface: Face = { o: [cx, 0, cz + ad / 2], yaw: 0, w: aw, kind: "front", jet: 0 };
          if (ar.chance(0.6)) B(0.45, 0.9, 0.03, alook.door, at(aface, 0, 1.05, 0.03));
        }
        // tourelle d'angle (château toujours, bourg / pierre riches parfois)
        if (st === "chateau" || ((st === "bourg" || st === "pierre") && floors >= 2 && ar.chance(annex * look.ornament * 0.5))) {
          const corners = st === "chateau" ? [-1, 1] : [ar.chance(0.5) ? 1 : -1];
          for (const sx of corners) {
            const tr = st === "chateau" ? ar.range(1.4, 1.9) : ar.range(0.9, 1.2);
            const corbel = st !== "chateau";
            const y0 = corbel ? floorY(1) : 0;
            const th = top + (st === "chateau" ? ar.range(1.5, 3) : 0.6) - y0;
            const cx = sx * (W / 2 + (corbel ? tr * 0.2 : tr * 0.35)), cz = D / 2 + (corbel ? tr * 0.2 : tr * 0.35) - (st === "chateau" ? 0 : 0);
            add(cylinder(tr, tr, th, look.wall, 14), [cx, y0, cz]);
            if (corbel) add(lathe([[0.05, -1.2], [tr * 0.6, -0.6], [tr, 0]], look.base, 12, false), [cx, y0, cz]);
            else add(cylinder(tr + 0.08, tr + 0.08, 0.6, look.base, 14), [cx, 0, cz]);
            add(cylinder(tr + 0.08, tr + 0.08, 0.14, look.trim, 14), [cx, y0 + th - 0.05, cz]);
            const rh = tr * (st === "chateau" ? 2.6 : 2.1);
            add(lathe([[tr + 0.25, 0], [tr * 0.85, rh * 0.18], [tr * 0.3, rh * 0.7], [0, rh]], look.roof, 14), [cx, y0 + th + 0.05, cz]);
            add(cylinder(0.025, 0.025, 0.7, ROLE.metal, 4), [cx, y0 + th + rh, cz]);
            roofTop = Math.max(roofTop, y0 + th + rh + 0.6);
            ext(cx - tr, cz - tr, cx + tr, cz + tr);
            // meurtrières / petites fenêtres sur la tour
            const n = Math.max(1, Math.floor(th / 3));
            for (let k = 0; k < n; k++) {
              const a = sx * 0.6 + (k % 2) * sx * 0.5;
              const tf: Face = { o: [cx + Math.sin(a) * tr, 0, cz + Math.cos(a) * tr], yaw: a, w: 1, kind: "side", jet: 0 };
              windowAt(tf, 0, y0 + 0.9 + k * 3, st === "chateau" ? 0.55 : 0.5, 1.0, look.win === "mullion" ? "rect" : look.win, look, ar, 1, false);
            }
          }
        }
        // escalier extérieur méditerranéen (vers une porte d'étage)
        if (st === "mediterraneen" && floors >= 2 && ar.chance(0.4 + annex * 0.5)) {
          const sx = -side;
          const y1 = floorY(1);
          const n = Math.round(y1 / 0.2);
          const run = n * 0.28;
          const x0 = sx * (W / 2 - 0.2);
          for (let k = 0; k < n; k++) B(0.14, ((k + 1) * y1) / n / 2, 0.45, look.wall, [x0 - sx * (run - (k + 0.5) * 0.28), ((k + 1) * y1) / n / 2, D / 2 + 0.5]);
          B(run / 2, 0.05, 0.06, look.trim, [x0 - sx * run / 2, y1 / 2 + 0.55, D / 2 + 0.95], qAxis([0, 0, 1], sx * Math.atan2(y1, run)));
          B(0.6, 0.06, 0.6, look.wall, [x0 + sx * 0.25, y1, D / 2 + 0.5]);
          B(0.45, 1.0, 0.03, look.door, at(front, x0 + sx * 0.05, y1 + 1.0, 0.03));
          ext(-W / 2, -D / 2, W / 2, D / 2 + 1.1);
        }
        // porche / auvent sur la porte
        if (st !== "boutique" && !shopFront && (st === "chalet" || ar.chance(annex * 0.5))) {
          const u = door[0];
          const pw = st === "ferme" ? 2.6 : 1.9;
          const ph = Math.min(fh[0] + plinth - 0.2, 3.0);
          const posts = st === "chalet" || st === "ferme" || ar.chance(0.5);
          if (posts) {
            for (const sx of [-1, 1]) {
              add(cylinder(0.07, 0.06, ph, ROLE.wood, 6), [u + sx * pw / 2, 0, D / 2 + 1.5]);
              add(box(0.04, 0.3, 0.04, ROLE.wood), [u + sx * pw / 2, ph - 0.25, D / 2 + 1.25], qAxis([1, 0, 0], 45 * DEG));
            }
            B(pw / 2 + 0.1, 0.06, 0.06, ROLE.wood, [u, ph, D / 2 + 1.5]);
            ext(u - pw / 2, D / 2, u + pw / 2, D / 2 + 1.8);
          } else for (const sx of [-1, 1]) add(box(0.04, 0.35, 0.04, ROLE.metal), [u + sx * (pw / 2 - 0.1), ph - 0.25, D / 2 + 0.45], qAxis([1, 0, 0], 50 * DEG));
          const pd = posts ? 1.8 : 1.0;
          const pp = 24 * DEG;
          add(box(pw / 2 + 0.25, 0.05, pd / 2 / Math.cos(pp), look.roof, 0), [u, ph + 0.12 + (Math.tan(pp) * pd) / 2, D / 2 + pd / 2], qAxis([1, 0, 0], pp));
        }
      }
      // perron : marches devant la porte (selon la hauteur du soubassement)
      if (st !== "japonais") {
        const n = Math.max(1, Math.round(plinth / 0.17));
        for (let k = 0; k < n; k++) {
          const d = (n - k) * 0.3;
          B(0.75 + (n - k) * 0.06, plinth / n / 2 + 0.02, d / 2, look.base, [door[0], ((k + 0.5) * plinth) / n - 0.02, D / 2 + d / 2]);
        }
        ext(-W / 2, -D / 2, W / 2, D / 2 + n * 0.3 + 0.1);
      } else {
        // engawa : plancher périphérique sur pilotis, marche de pierre
        B(W / 2 + 0.7, 0.05, D / 2 + 0.7, ROLE.wood, [0, plinth - 0.05, 0]);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(cylinder(0.07, 0.07, plinth, ROLE.wood, 6), [sx * (W / 2 + 0.6), 0, sz * (D / 2 + 0.6)]);
        B(0.6, 0.15, 0.3, ROLE.stone, [door[0], 0.15, D / 2 + 1.0], I, 0.03);
        ext(-W / 2 - 0.7, -D / 2 - 0.7, W / 2 + 0.7, D / 2 + 1.3);
      }

      // ---- cheminées
      const nCh = p.chimneys >= 0 ? p.chimneys : roofKind === "flat" || st === "japonais" ? 0 : st === "chateau" ? rng.int(2, 3) : rng.int(0, 2);
      const cr = rng.fork("chimney");
      for (let i = 0; i < nCh; i++) {
        const x = nCh === 1 ? cr.range(-W / 2 + 0.8, W / 2 - 0.8) : mix(-W / 2 + 0.7, W / 2 - 0.7, i / Math.max(1, nCh - 1));
        const z = ridgeAlongZ ? cr.range(-D / 2 + 1, D / 2 - 1) : cr.range(-D * 0.15, D * 0.12);
        if (st === "vapeur") {
          add(cylinder(0.25, 0.22, rt - top + 2.6, ROLE.metal, 10), [x, top, z]);
          add(cylinder(0.32, 0.32, 0.2, ROLE.metal, 10), [x, rt + 2.4, z]);
          continue;
        }
        const h = rt - top + cr.range(0.4, 0.9) - (roofKind === "flat" || roofKind === "mansard" ? 0 : Math.tan(look.pitch) * Math.max(0, (ridgeAlongZ ? Math.abs(x) : Math.abs(z)) - 0.5));
        const cw = cr.range(0.28, 0.42), cd = cr.range(0.38, 0.6);
        const role = look.finish === "brique" || cr.chance(0.3) ? ROLE.roof : look.finish === "pierre" ? ROLE.stone : look.wall;
        B(cw, h / 2, cd, role, [x, top + h / 2, z]);
        B(cw + 0.06, 0.05, cd + 0.06, look.trim, [x, top + h + 0.03, z]);
        if (cr.chance(0.6)) for (let k = 0; k < cr.int(1, 3); k++) add(cylinder(0.08, 0.07, 0.3, ROLE.roof, 6), [x, top + h + 0.08, z - cd + 0.2 + k * 0.28]);
      }
      // ---- gouttières et descentes
      if (look.gutters && !modern && look.roofMat !== "chaume" && (roofKind === "gable" || roofKind === "hip" || roofKind === "mansard")) {
        const gy = top - Math.tan(look.pitch) * 0.35 - 0.05;
        for (const sz of ridgeAlongZ ? [] : [1, -1]) {
          add(cylinder(0.06, 0.06, W + 0.7, ROLE.metal, 5), [-W / 2 - 0.35, gy, sz * (D / 2 + 0.3)], qAxis([0, 0, 1], -Math.PI / 2));
          const sx = rng.fork(`gut${sz}`).chance(0.5) ? 1 : -1;
          B(0.04, gy / 2, 0.04, ROLE.metal, [sx * (W / 2 - 0.15), gy / 2, sz * (D / 2 + 0.06)]);
          B(0.04, 0.12, 0.12, ROLE.metal, [sx * (W / 2 - 0.15), gy - 0.06, sz * (D / 2 + 0.2)]);
        }
      }
      // ---- enseignes, néons, tuyauteries
      if (shopFront || st === "boutique") {
        const sr = rng.fork("sign");
        if (sr.chance(0.7)) hangingSign(W / 2 - 0.3, plinth + fh[0] + 0.3, D / 2, sr);
      }
      if (st === "vapeur") {
        const x = W / 2 - 0.4;
        add(cylinder(0.08, 0.08, top - 0.3, ROLE.metal, 8), [x, 0.3, D / 2 + 0.12]);
        for (let y = 1; y < top - 0.5; y += 1.4) B(0.11, 0.03, 0.11, ROLE.metal, [x, y, D / 2 + 0.12]);
      }
      if (st === "neon") {
        const n = rng.int(1, 3);
        for (let i = 0; i < n; i++) {
          const y = plinth + rng.range(1.2, wallH - 1);
          const vertical = rng.chance(0.5);
          B(vertical ? 0.22 : rng.range(0.8, 1.6), vertical ? rng.range(0.8, 1.8) : 0.3, 0.06, ROLE.lamp, [rng.range(-W / 2 + 0.8, W / 2 - 0.8), y, D / 2 + 0.2], I, 0.03);
        }
      }
      // ---- faux aplomb et affaissement
      if (st === "bourg" || st === "colombages" || st === "chaumiere" || st === "ferme") {
        const lean = rng.range(-1, 1) * (0.006 + p.decay * 0.012);
        const sag = p.decay * 0.05;
        mesh.mapPos((q) => [q[0] + q[1] * lean, q[1] - sag * Math.max(0, q[1] - top) * (1 - (q[0] / (W / 2 + 0.5)) ** 2), q[2]]);
      }

      /* ---------- fonctions de construction (fermetures sur l'état de la maison) ---------- */

      // bandeau d'étage tout autour
      function bandAround(f: number) {
        const y = floorY(f);
        const dz = f > 0 ? jet : 0;
        B(W / 2 + 0.05, 0.07, D / 2 + dz + 0.05, look.trim, [0, y, 0]);
      }

      function body(cx: number, cz: number, w: number, d: number, nf: number, fhs: number[], pl: number, jt: number, lk: Look, main: boolean) {
        const h = fhs.reduce((s, x) => s + x, 0);
        const t = pl + h;
        // soubassement
        B(w / 2 + 0.07, pl / 2, d / 2 + 0.07, lk.base, [cx, pl / 2, cz], I, 0.02);
        if (jt > 0) {
          B(w / 2, fhs[0] / 2, d / 2, lk.wall, [cx, pl + fhs[0] / 2, cz]);
          B(w / 2, (h - fhs[0]) / 2, d / 2 + jt, lk.wall, [cx, pl + fhs[0] + (h - fhs[0]) / 2, cz]);
          // consoles sous l'encorbellement
          for (let k = 0; k <= Math.round(w / 1.4); k++)
            for (const sz of [1, -1]) {
              const x = cx - w / 2 + 0.2 + (k * (w - 0.4)) / Math.round(w / 1.4);
              add(box(0.07, 0.07, jt * 0.6, ROLE.wood), [x, pl + fhs[0] - 0.1, cz + sz * (d / 2 + jt * 0.4)], qAxis([1, 0, 0], sz * 35 * DEG));
            }
          B(w / 2 + 0.02, 0.1, d / 2 + jt + 0.02, ROLE.wood, [cx, pl + fhs[0] + 0.05, cz]);
        } else if (st === "japonais" && fhs.length > 1) {
          B(w / 2, h / 2, d / 2, lk.wall, [cx, pl + h / 2, cz]);
          // auvent intermédiaire (mokoshi) qui ceinture l'étage
          const y = pl + fhs[0] + 0.15, o = 0.75, pp = 22 * DEG;
          for (const sz of [1, -1]) add(box(w / 2 + o, 0.05, o / Math.cos(pp) / 2, lk.roof), [cx, y, cz + sz * (d / 2 + o / 2)], qAxis([1, 0, 0], sz * pp));
          for (const sx of [1, -1]) add(box(o / Math.cos(pp) / 2, 0.05, d / 2 + o, lk.roof), [cx + sx * (w / 2 + o / 2), y - 0.01, cz], qAxis([0, 0, 1], -sx * pp));
        } else if (st === "chalet" && fhs.length > 1 && main) {
          // chalet : rez-de-chaussée maçonné, étages en madriers
          B(w / 2 + 0.02, fhs[0] / 2, d / 2 + 0.02, ROLE.stone, [cx, pl + fhs[0] / 2, cz]);
          B(w / 2, (h - fhs[0]) / 2, d / 2, lk.wall, [cx, pl + fhs[0] + (h - fhs[0]) / 2, cz]);
          // balcon de bois filant sur le pignon avant, balustres découpés
          const by = pl + fhs[0] + 0.05;
          B(w / 2 + 0.3, 0.06, 0.55, ROLE.wood, [cx, by, cz + d / 2 + 0.55]);
          for (let x = -w / 2 - 0.25; x <= w / 2 + 0.26; x += 0.16) B(0.05, 0.4, 0.015, ROLE.wood, [cx + x, by + 0.46, cz + d / 2 + 1.05]);
          B(w / 2 + 0.3, 0.04, 0.05, ROLE.wood, [cx, by + 0.9, cz + d / 2 + 1.05]);
          for (const sx of [-1, 1]) add(box(0.05, 0.4, 0.05, ROLE.wood), [cx + sx * (w / 2 - 0.1), by - 0.3, cz + d / 2 + 0.35], qAxis([1, 0, 0], 40 * DEG));
          ext(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2 + 1.1);
        } else B(w / 2, h / 2, d / 2, lk.wall, [cx, pl + h / 2, cz]);
        if (lk.finish !== "japonais" as string) {
          // corniche (avec modillons sur la façade si décor riche)
          if (st !== "chaumiere" && lk.finish !== "bardage" && st !== "japonais") {
            B(w / 2 + 0.14, 0.09, d / 2 + jt + 0.14, lk.trim, [cx, t - 0.07, cz]);
            if (lk.modillons && main) for (const sz of [1]) for (let x = -w / 2 + 0.25; x <= w / 2 - 0.2; x += 0.45) B(0.05, 0.06, 0.08, lk.trim, [cx + x, t - 0.21, cz + sz * (d / 2 + jt + 0.08)]);
          }
        }
        // chaînes d'angle harpées : une pierre par assise, alternativement longue sur chaque face
        if (lk.quoins)
          for (const sx of [-1, 1])
            for (const sz of [-1, 1]) {
              let k = 0;
              for (let y = pl; y < t - 0.35; y += 0.48, k++) {
                const long = k % 2 === 0;
                const dz = y > pl + fhs[0] ? jt : 0;
                const hx = long ? 0.3 : 0.17, hz = long ? 0.17 : 0.3;
                B(hx, 0.2, hz, lk.trim, [cx + sx * (w / 2 - hx + 0.015), y + 0.24, cz + sz * (d / 2 + dz - hz + 0.015)]);
              }
            }
        // parements
        const faces: Face[] = [
          { o: [cx, 0, cz + d / 2], yaw: 0, w, kind: "front", jet: jt },
          { o: [cx, 0, cz - d / 2], yaw: Math.PI, w, kind: "back", jet: jt },
          { o: [cx + w / 2, 0, cz], yaw: Math.PI / 2, w: d, kind: "side", jet: 0 },
          { o: [cx - w / 2, 0, cz], yaw: -Math.PI / 2, w: d, kind: "side", jet: 0 },
        ];
        const fr = rng.fork(`finish${cx.toFixed(1)}`);
        for (const f of faces) finish(f, pl, fhs, lk, fr, main && f.kind === "front", main && st === "chalet");
      }

      function finish(f: Face, pl: number, fhs: number[], lk: Look, r: Rng, mainFront: boolean, isChaletMain = false) {
        const h = fhs.reduce((s, x) => s + x, 0);
        const q = yawQ(f.yaw);
        const w = f.w;
        if (lk.finish === "bardage") {
          // planches verticales et couvre-joints (au-dessus du rez maçonné d'un chalet)
          const y0 = isChaletMain && fhs.length > 1 ? pl + fhs[0] : pl;
          const n = Math.floor(w / 0.6);
          for (let k = 0; k <= n; k++) {
            const u = -w / 2 + 0.1 + (k * (w - 0.2)) / n;
            B(0.025, (pl + h - y0) / 2, 0.02, ROLE.wood, at(f, u, (pl + h + y0) / 2, 0.02), q);
          }
          return;
        }
        if (lk.finish === "colombages") {
          // pans de bois : sablières, poteaux aux limites de travées, décharges en écharpe (étages seulement)
          const k0 = fhs.length > 1 ? 1 : 0;
          let y0 = pl + (k0 ? fhs[0] : 0);
          for (let k = k0; k < fhs.length; k++) {
            const fy = fhs[k];
            const out = 0.03 + (f.kind !== "side" ? f.jet : 0);
            B(w / 2 + 0.02, 0.07, 0.04, ROLE.wood, at(f, 0, y0 + 0.08, out), q);
            B(w / 2 + 0.02, 0.05, 0.04, ROLE.wood, at(f, 0, y0 + fy * 0.22 - 0.06, out), q);
            const posts = f.kind === "side" ? Math.max(2, Math.round(w / 1.6)) : Math.max(2, Math.round(w / 1.35));
            for (let i = 0; i <= posts; i++) {
              const u = -w / 2 + 0.06 + (i * (w - 0.12)) / posts;
              B(0.06, fy / 2, 0.04, ROLE.wood, at(f, u, y0 + fy / 2, out), q);
              if (i < posts && (f.kind === "side" || i % 2 === 0)) {
                const u2 = -w / 2 + 0.06 + ((i + 1) * (w - 0.12)) / posts;
                const span = u2 - u;
                const len = Math.hypot(span, fy * 0.7);
                const ang = Math.atan2(fy * 0.7, span) * ((i + k) % 2 ? 1 : -1);
                add(box(len / 2, 0.045, 0.035, ROLE.wood), at(f, (u + u2) / 2, y0 + fy * 0.22 + fy * 0.35, out), qMul(q, qAxis([0, 0, 1], ang)));
              }
            }
            y0 += fy;
          }
          return;
        }
        if (lk.finish === "pierre" || (lk.finish === "enduit" && (p.decay > 0.15 || r.chance(0.35)))) {
          // pierres apparentes : moellons saillants (pierre) ou plaques d'enduit tombé (enduit)
          const n = lk.finish === "pierre" ? Math.round(w * h * (f.kind === "side" ? 0.15 : 0.3)) : Math.round(2 + p.decay * 8);
          const cx0 = r.range(-w / 2 + 0.8, w / 2 - 0.8), cy0 = r.range(pl + 0.3, pl + h * 0.5);
          for (let k = 0; k < n; k++) {
            const sw = r.range(0.14, 0.32), sh = r.range(0.08, 0.14);
            const u = lk.finish === "pierre" ? r.range(-w / 2 + 0.3, w / 2 - 0.3) : clamp(cx0 + r.range(-0.6, 0.6), -w / 2 + 0.3, w / 2 - 0.3);
            const y = lk.finish === "pierre" ? r.range(pl + 0.15, pl + h - 0.3) : clamp(cy0 + r.range(-0.5, 0.5), pl + 0.2, pl + h - 0.3);
            if (mainFront && Math.abs(u - door[0]) < 0.8 && y < pl + 2.6) continue;
            B(sw, sh, 0.012, lk.finish === "pierre" ? (k % 3 ? ROLE.stone : lk.trim) : ROLE.stone, at(f, u, y, 0.005 + (y > pl + fhs[0] && f.kind !== "side" ? f.jet : 0)), q);
          }
        }
        if (lk.finish === "brique") {
          // cordons de briques en saillie tous les ~1,2 m (lecture des assises)
          for (let y = pl + 1.1; y < pl + h - 0.4; y += 1.15) B(w / 2 + 0.01, 0.025, 0.012, ROLE.roof, at(f, 0, y, 0.006), q);
        }
        if (lk.finish === "shoji") {
          // poteaux et traverses de bois sombre (structure apparente)
          const n = Math.max(2, Math.round(w / 1.8));
          for (let i = 0; i <= n; i++) B(0.07, h / 2, 0.05, ROLE.bark, at(f, -w / 2 + (i * w) / n, pl + h / 2, 0.03), q);
          for (let k = 0; k <= fhs.length; k++) B(w / 2 + 0.05, 0.06, 0.05, ROLE.bark, at(f, 0, pl + fhs.slice(0, k).reduce((s, x) => s + x, 0) + (k === fhs.length ? -0.1 : 0.03), 0.03), q);
        }
      }

      function windowAt(f: Face, u: number, y: number, w: number, h: number, kind: WinKind, lk: Look, r: Rng, floor: number, rich: boolean) {
        const q = yawQ(f.yaw);
        const o = floor > 0 && f.kind !== "side" ? f.jet : 0;
        const skin = lk.finish === "bardage" ? 0.04 : lk.finish === "colombages" && floor > 0 ? 0.04 : 0;
        const P = (du: number, dy: number, dz: number) => at(f, u + du, y + dy, o + skin + dz);
        const modernW = st === "moderne" || st === "neon";
        const frameRole = modernW ? ROLE.metal : lk.finish === "shoji" ? ROLE.bark : lk.trim;
        const fr = lk.win === "mullion" ? 0.12 : 0.08;
        const out = modernW ? 0.03 : 0.07;
        if (kind === "shoji") {
          // panneaux de papier à résille de bois
          B(w / 2, h / 2, 0.02, ROLE.paper, P(0, h / 2, 0.01), q);
          for (let i = 1; i < 4; i++) B(0.015, h / 2, 0.03, ROLE.bark, P(-w / 2 + (i * w) / 4, h / 2, 0.02), q);
          for (let i = 1; i < 5; i++) B(w / 2, 0.015, 0.03, ROLE.bark, P(0, (i * h) / 5, 0.02), q);
          B(w / 2 + 0.05, 0.04, 0.05, ROLE.bark, P(0, h + 0.04, 0.02), q);
          B(w / 2 + 0.05, 0.04, 0.05, ROLE.bark, P(0, -0.04, 0.02), q);
          return;
        }
        if (kind === "arch" || kind === "segment" || kind === "lancet") {
          add(extrude(bayOutline(kind, w, h), 0.02, ROLE.glass), P(0, 0, 0.0), q);
          add(extrude(archBand(kind, w, h, fr), out, frameRole), P(0, 0, 0), q);
          // clé de voûte
          if (kind !== "lancet" && (rich || lk.ornament > 0.5)) B(0.09, 0.14, out * 0.8 + 0.02, lk.trim, P(0, h + (kind === "segment" ? 0.02 : 0.03), out / 2), q);
          if (kind === "lancet") B(0.02, h * 0.42, 0.03, frameRole, P(0, h * 0.42, 0.02), q);
          else {
            B(0.022, h / 2 - 0.05, 0.03, frameRole, P(0, h / 2 - 0.05, 0.02), q);
            if (lk.petitsBois) for (const yy of [0.33, 0.62]) B(w / 2, 0.016, 0.025, frameRole, P(0, h * yy, 0.02), q);
          }
        } else {
          B(w / 2, h / 2, 0.02, ROLE.glass, P(0, h / 2, 0.012), q);
          // encadrement
          B(w / 2 + fr, fr / 2, out, frameRole, P(0, h + fr / 2, out / 2), q);
          B(fr / 2, h / 2, out, frameRole, P(-w / 2 - fr / 2, h / 2, out / 2), q);
          B(fr / 2, h / 2, out, frameRole, P(w / 2 + fr / 2, h / 2, out / 2), q);
          if (kind === "mullion") {
            // croisée de pierre : meneau et traverse
            B(0.06, h / 2, out * 0.8, frameRole, P(0, h / 2, out * 0.4), q);
            B(w / 2, 0.055, out * 0.8, frameRole, P(0, h * 0.62, out * 0.4), q);
          } else if (!modernW) {
            B(0.022, h / 2, 0.03, frameRole, P(0, h / 2, 0.03), q);
            if (lk.petitsBois) for (const yy of [0.34, 0.67]) B(w / 2, 0.016, 0.03, frameRole, P(0, h * yy, 0.03), q);
            else B(w / 2, 0.022, 0.03, frameRole, P(0, h * 0.64, 0.03), q);
          }
          // linteau : clé ou plate-bande
          if (!modernW && rich && lk.ornament > 0.4) B(0.08, 0.1, out + 0.01, lk.trim, P(0, h + fr + 0.04, out / 2), q);
          if (!modernW && lk.finish === "brique") B(w / 2 + fr + 0.04, 0.09, 0.03, lk.trim, P(0, h + fr + 0.09, 0.02), q);
        }
        if (modernW) return;
        // appui
        B(w / 2 + fr * 1.6, 0.045, 0.14, lk.trim, P(0, -0.045, 0.08), q);
        // volets
        const shutters = lk.shutterKind !== "none" && kind !== "lancet" && kind !== "mullion" && r.chance(p.shutters) && !r.chance(p.decay * 0.4);
        if (shutters)
          for (const sx of [-1, 1]) {
            if (r.chance(p.decay * 0.25)) continue;
            const sw = w / 4 + 0.02, sh = h / 2;
            const ajar = r.chance(0.15 + p.decay * 0.3) ? r.range(15, 70) * DEG * sx : 0;
            const hinge = P(sx * (w / 2 + fr), 0, 0.06);
            const sq = qMul(q, yawQ(-ajar));
            const local = (du: number, dy: number, dz: number): V3 => {
              const c = Math.cos(f.yaw - ajar), s = Math.sin(f.yaw - ajar);
              const lu = sx * (sw) + du;
              return [hinge[0] + c * lu + s * dz, hinge[1] + dy, hinge[2] - s * lu + c * dz];
            };
            if (kind === "arch" || kind === "segment") B(sw, sh * 0.82, 0.025, lk.shutter, local(0, sh * 0.82, 0), sq);
            else B(sw, sh, 0.025, lk.shutter, local(0, sh, 0), sq);
            const hh = kind === "arch" || kind === "segment" ? sh * 0.82 : sh;
            if (lk.shutterKind === "persiennes") for (let k = 1; k <= 3; k++) B(sw - 0.03, 0.012, 0.035, lk.shutter, local(0, (k * 2 * hh) / 4, 0.015), qMul(sq, qAxis([1, 0, 0], -25 * DEG)));
            else {
              for (const yy of [0.2, 0.8]) B(sw - 0.02, 0.035, 0.035, lk.shutter, local(0, 2 * hh * yy, 0.02), sq);
              add(box(0.025, Math.hypot(sw * 1.6, hh * 1.2) / 2, 0.03, lk.shutter), local(0, hh, 0.02), qMul(sq, qAxis([0, 0, 1], sx * Math.atan2(sw * 1.6, hh * 1.2))));
            }
          }
        // jardinière fleurie
        if (floor > 0 && r.chance(lk.planters)) {
          B(w / 2 - 0.02, 0.09, 0.1, r.chance(0.5) ? ROLE.wood : ROLE.roof, P(0, 0.07, 0.22), q);
          for (let k = 0; k < 3; k++) add(ellipsoid(0.16, 0.11, 0.1, k === 1 ? ROLE.leaf : r.chance(0.6) ? ROLE.flower : ROLE.accent, 5, 3).setFlex(0.2), P(-w / 3 + (k * w) / 3, 0.2, 0.24), q);
        }
      }

      function oculus(f: Face, u: number, y: number, r0: number, lk: Look) {
        const q = yawQ(f.yaw);
        add(extrude(ngon(14, r0), 0.02, ROLE.glass), at(f, u, y, 0.0), q);
        const ring = [...ngon(14, r0 + 0.1).map(([x, z]) => [x, z] as [number, number])];
        // anneau en deux demi-U
        for (const s of [1, -1]) {
          const outer = arc(0, 0, r0 + 0.1, 0, Math.PI, 8).map(([x, yy]) => [x, yy * s] as [number, number]);
          const inner = arc(0, 0, r0, Math.PI, 0, 8).map(([x, yy]) => [x, yy * s] as [number, number]);
          add(extrude([...outer, ...inner], 0.07, lk.trim), at(f, u, y, 0), q);
        }
        void ring;
        B(0.08, 0.12, 0.08, lk.trim, at(f, u, y + r0 + 0.08, 0.04), q);
        B(0.025, r0, 0.03, lk.trim, at(f, u, y, 0.02), q);
        B(r0, 0.025, 0.03, lk.trim, at(f, u, y, 0.02), q);
      }

      function doorway(f: Face, u: number, y: number, w: number, h: number, lk: Look, r: Rng, arched: boolean) {
        const q = yawQ(f.yaw);
        const P = (du: number, dy: number, dz: number) => at(f, u + du, y + dy, dz + (lk.finish === "bardage" ? 0.04 : 0));
        const modernD = st === "moderne" || st === "neon";
        const kind: WinKind = arched ? (st === "chapelle" ? "lancet" : "arch") : r.chance(0.25) && lk.win === "segment" ? "segment" : "rect";
        if (modernD) {
          B(w / 2, h / 2, 0.02, ROLE.glass, P(0, h / 2, 0.012), q);
          B(w / 2 + 0.06, 0.05, 0.05, ROLE.metal, P(0, h + 0.05, 0.03), q);
          B(w / 2 + 0.6, 0.05, 0.7, ROLE.metal, P(0, h + 0.35, 0.7), q);
          if (f.kind === "front") ext(u - w / 2 - 0.6, f.o[2], u + w / 2 + 0.6, f.o[2] + 1.4);
          return;
        }
        if (kind === "rect") {
          B(w / 2, h / 2, 0.025, lk.door, P(0, h / 2, 0.015), q);
          // panneaux moulurés ou planches
          if (r.chance(0.5)) for (const yy of [0.27, 0.68]) for (const sx of w > 1.3 ? [-1, 1] : [0]) B(w / (w > 1.3 ? 5 : 3), h * 0.16, 0.02, lk.door, P((sx * w) / 4, h * yy, 0.04), q);
          else for (let k = 1; k < 5; k++) B(0.008, h / 2, 0.035, ROLE.ink, P(-w / 2 + (k * w) / 5, h / 2, 0.02), q);
          // imposte vitrée
          if (h > 2.2 && r.chance(0.6)) B(w / 2 - 0.05, 0.14, 0.03, ROLE.glass, P(0, h - 0.18, 0.03), q);
          B(w / 2 + 0.12, 0.08, 0.09, lk.trim, P(0, h + 0.08, 0.045), q);
          for (const sx of [-1, 1]) B(0.1, h / 2, 0.08, lk.trim, P(sx * (w / 2 + 0.06), h / 2, 0.04), q);
          if (lk.ornament > 0.55) B(0.09, 0.13, 0.11, lk.trim, P(0, h + 0.2, 0.05), q);
          // pilastres et fronton pour les décors riches
          if (lk.ornament > 0.75 && f.kind === "front") {
            for (const sx of [-1, 1]) B(0.1, h / 2 + 0.2, 0.06, lk.trim, P(sx * (w / 2 + 0.3), h / 2 + 0.1, 0.03), q);
            add(extrude([[-w / 2 - 0.45, 0], [w / 2 + 0.45, 0], [0, 0.45]], 0.12, lk.trim), P(0, h + 0.3, 0), q);
          }
        } else {
          add(extrude(bayOutline(kind, w, h), 0.03, lk.door), P(0, 0, 0.01), q);
          add(extrude(archBand(kind, w, h, 0.14), 0.1, lk.trim), P(0, 0, 0), q);
          B(0.012, (h - w / 2) / 2, 0.04, ROLE.ink, P(0, (h - w / 2) / 2, 0.03), q);
          if (kind === "arch") B(0.1, 0.16, 0.13, lk.trim, P(0, h + 0.08, 0.06), q);
          for (const yy of [0.25, 0.6]) B(w / 2 - 0.05, 0.025, 0.035, ROLE.metal, P(0, h * yy, 0.04), q);
        }
        // poignée, lanterne murale
        add(ellipsoid(0.03, 0.03, 0.03, ROLE.metal, 4, 3), P(w * 0.32, h * 0.47, 0.06), q);
        if (r.chance(0.4)) {
          const side = r.chance(0.5) ? 1 : -1;
          B(0.02, 0.02, 0.12, ROLE.metal, P(side * (w / 2 + 0.35), h - 0.05, 0.12), q);
          add(lathe([[0.02, 0], [0.09, -0.02], [0.09, -0.22], [0.04, -0.27], [0, -0.27]], ROLE.lamp, 6), P(side * (w / 2 + 0.35), h - 0.05, 0.22), q);
        }
      }

      function shopWindow(f: Face, u: number, y: number, w: number, h: number, lk: Look, r: Rng) {
        const q = yawQ(f.yaw);
        const P = (du: number, dy: number, dz: number) => at(f, u + du, y + dy, dz);
        // devanture en bois : coffrage, pilastres, bandeau d'enseigne, allège
        const wood = r.pick([lk.door, lk.shutter, ROLE.wood, ROLE.cloth2]);
        B(w / 2, h / 2, 0.02, ROLE.glass, P(0, h / 2, 0.02), q);
        B(w / 2 + 0.05, 0.22, 0.08, wood, P(0, -0.1, 0.06), q);
        for (const sx of [-1, 1]) B(0.12, h / 2 + 0.3, 0.1, wood, P(sx * (w / 2 + 0.1), h / 2 + 0.1, 0.06), q);
        B(w / 2 + 0.3, 0.26, 0.12, wood, P(0, h + 0.3, 0.08), q);
        B(w / 2 + 0.36, 0.04, 0.17, lk.trim, P(0, h + 0.58, 0.09), q);
        B(w / 2 - 0.25, 0.12, 0.02, r.chance(0.5) ? ROLE.paper : ROLE.accent, P(0, h + 0.3, 0.21), q);
        // petits bois de vitrine
        const cols = Math.max(2, Math.round(w / 0.55));
        for (let k = 1; k < cols; k++) B(0.02, h / 2, 0.03, wood, P(-w / 2 + (k * w) / cols, h / 2, 0.035), q);
        B(w / 2, 0.025, 0.03, wood, P(0, h * 0.72, 0.035), q);
        // store banne rayé
        if (r.chance(0.7)) {
          const n = Math.max(4, Math.round((w + 0.5) / 0.32));
          const sw = (w + 0.5) / n;
          for (let k = 0; k < n; k++) {
            const m = box(sw / 2, 0.02, 0.5, k % 2 ? ROLE.paper : lk.shutter === ROLE.accent ? ROLE.accent : r.pick([ROLE.accent, ROLE.cloth1, ROLE.leaf2]), 0);
            add(m, P(-w / 2 - 0.25 + (k + 0.5) * sw, h + 0.05, 0.55), qMul(q, qAxis([1, 0, 0], 20 * DEG)));
          }
          for (let k = 0; k < n; k += 1) B(sw / 2, 0.08, 0.012, k % 2 ? ROLE.paper : ROLE.accent, P(-w / 2 - 0.25 + (k + 0.5) * sw, h - 0.17, 1.0), q);
        }
      }

      function balcony(f: Face, u: number, y: number, w: number, lk: Look, r: Rng) {
        const q = yawQ(f.yaw);
        const o = f.jet;
        const deep = r.chance(0.55);
        const d = deep ? 0.55 : 0.18;
        if (deep) {
          B(w / 2 + 0.3, 0.06, d / 2, lk.trim, at(f, u, y - 0.1, o + d / 2), q);
          for (const sx of [-1, 1]) add(box(0.06, 0.16, d * 0.4, lk.trim), at(f, u + sx * (w / 2 + 0.1), y - 0.3, o + d * 0.3), qMul(q, qAxis([1, 0, 0], 30 * DEG)));
        }
        const hw = w / 2 + (deep ? 0.25 : 0.1);
        const bars = Math.round((hw * 2) / 0.13);
        // ferronnerie : main courante, lisse basse, barreaux, volutes (anneaux)
        B(hw, 0.025, 0.025, ROLE.metal, at(f, u, y + 0.85, o + d), q);
        B(hw, 0.015, 0.015, ROLE.metal, at(f, u, y + 0.05, o + d), q);
        for (let k = 0; k <= bars; k++) B(0.01, 0.4, 0.01, ROLE.metal, at(f, u - hw + (k * 2 * hw) / bars, y + 0.45, o + d), q);
        if (lk.ornament > 0.4) for (let k = 0; k < 3; k++) add(lathe([[0.1, -0.012], [0.1, 0.012]], ROLE.metal, 8, false), at(f, u + (k - 1) * hw * 0.6, y + 0.45, o + d), qMul(q, qAxis([1, 0, 0], Math.PI / 2)));
        if (deep) for (const sx of [-1, 1]) B(0.015, 0.4, d / 2, ROLE.metal, at(f, u + sx * hw, y + 0.45, o + d / 2), q);
      }

      function hangingSign(x: number, y: number, z: number, r: Rng) {
        // potence en fer forgé et enseigne suspendue (perpendiculaire à la façade)
        B(0.02, 0.02, 0.4, ROLE.metal, [x, y, z + 0.4]);
        add(box(0.012, 0.012, 0.28, ROLE.metal), [x, y - 0.14, z + 0.2], qAxis([1, 0, 0], -45 * DEG));
        const sh = r.pick(["rect", "round", "shield"]);
        const pts: [number, number][] = sh === "round" ? ngon(12, 0.24) : sh === "shield" ? [[-0.24, 0.2], [0.24, 0.2], [0.24, -0.05], [0, -0.28], [-0.24, -0.05]] : [[-0.25, -0.18], [0.25, -0.18], [0.25, 0.18], [-0.25, 0.18]];
        add(extrude(pts, 0.04, r.pick([ROLE.accent, ROLE.wood, ROLE.paper, ROLE.leaf2]), 0.01), [x - 0.02, y - 0.32, z + 0.55], yawQ(Math.PI / 2));
        for (const dz of [0.4, 0.7]) B(0.006, 0.05, 0.006, ROLE.metal, [x, y - 0.05, z + dz]);
      }

      /**
       * Toit d'un volume centré en (cx, cz), w × d, posé à `top`. `ridgeZ` : faîtage selon z (pignon vers +z).
       * Renvoie la hauteur du faîte.
       */
      function roof(cx: number, cz: number, w: number, d: number, top: number, kind: string, ridgeZ: boolean, lk: Look, r: Rng, main: boolean): number {
        const q = ridgeZ ? yawQ(Math.PI / 2) : I;
        const L = ridgeZ ? d : w, S = ridgeZ ? w : d;
        const over = st === "chalet" ? 0.75 : st === "japonais" ? 0.7 : lk.roofMat === "chaume" ? 0.45 : st === "mediterraneen" ? 0.2 : 0.35;
        const overEnd = st === "chalet" ? 0.9 : lk.roofMat === "chaume" ? 0.35 : st === "mediterraneen" ? 0.1 : r.range(0.2, 0.4);
        const put = (m: Mesh, pos: V3, qq: Q = I) => mesh.append(m, m4Compose([cx + (ridgeZ ? pos[2] : pos[0]), top + pos[1], cz + (ridgeZ ? -pos[0] : pos[2])], qMul(q, qq)));
        const pitch = lk.pitch;
        if (kind === "flat") {
          B(w / 2 - 0.1, 0.05, d / 2 - 0.1, ROLE.road, [cx, top + 0.02, cz]);
          for (const sz of [-1, 1]) B(w / 2, 0.25, 0.1, lk.trim, [cx, top + 0.25, cz + sz * (d / 2 - 0.1)], I, 0.02);
          for (const sx of [-1, 1]) B(0.1, 0.25, d / 2, lk.trim, [cx + sx * (w / 2 - 0.1), top + 0.25, cz], I, 0.02);
          const vents = r.int(1, 3);
          for (let i = 0; i < vents; i++) B(0.4, 0.3, 0.4, ROLE.metal, [cx + r.range(-w / 2 + 1, w / 2 - 1), top + 0.32, cz + r.range(-d / 2 + 1, d / 2 - 1)], I, 0.03);
          if (st === "neon" || r.chance(0.3)) {
            const tank = lathe([[0.7, 0], [0.7, 1.4], [0.2, 1.7], [0, 1.72]], ROLE.wood, 10);
            add(tank, [cx + w * 0.2, top + 0.6, cz - d * 0.15]);
            for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) add(cylinder(0.04, 0.04, 0.6, ROLE.metal, 4), [cx + w * 0.2 + dx, top, cz - d * 0.15 + dz]);
            return top + 2.3;
          }
          if (st === "mediterraneen") {
            // toit-terrasse : pergola d'angle
            for (const [dx, dz] of [[0.3, 0.3], [0.3, 2.3], [2.6, 0.3], [2.6, 2.3]]) B(0.05, 1.1, 0.05, ROLE.wood, [cx - w / 2 + dx, top + 1.1, cz - d / 2 + dz]);
            for (let k = 0; k < 6; k++) B(0.03, 0.04, 1.2, ROLE.wood, [cx - w / 2 + 0.3 + k * 0.46, top + 2.22, cz - d / 2 + 1.3]);
          }
          return top + 0.5;
        }
        if (kind === "shed") {
          const p2 = 16 * DEG;
          const rise = Math.tan(p2) * S;
          const slope = (S + over * 2) / Math.cos(p2);
          put(box(L / 2 + overEnd, 0.07, slope / 2, lk.roof, 0), [0, rise / 2 + 0.07, 0], qAxis([1, 0, 0], p2));
          for (const sx of [-1, 1]) put(extrude([[-S / 2, 0], [S / 2, 0], [-S / 2, rise]], 0.2, lk.wall), [sx * L / 2 - (sx > 0 ? 0.2 : 0), 0, 0], yawQ(Math.PI / 2));
          return top + rise + 0.3;
        }
        if (kind === "hip" || kind === "mansard" || kind === "pavilion") {
          // croupe / mansarde / pavillon : profil tourné à 4 pans, faîtage obtenu en étirant le sommet
          const So = S / 2 + over, Lo = L / 2 + over;
          const ridge = kind === "pavilion" ? 0 : Math.max(0, L - S) ;
          const jp = st === "japonais";
          const rh = (kind === "mansard" ? 0.62 : jp ? 0.5 : Math.tan(pitch) * 0.5) * S;
          const prof: [number, number][] =
            kind === "mansard" ? [[1, 0], [0.8, 0.78], [0.78, 0.8], [0, 1]] : jp ? [[1.04, 0.02], [0.86, 0.12], [0.66, 0.3], [0.44, 0.56], [0.2, 0.85], [0, 1]] : [[1, 0], [0, 1]];
          const pyr = lathe(prof, lk.roof, 4, true);
          pyr.mapPos((qq) => {
            const c = Math.SQRT1_2;
            const xn = (qq[0] * c - qq[2] * c) * Math.SQRT2, zn = (qq[0] * c + qq[2] * c) * Math.SQRT2;
            const s = Math.max(Math.abs(xn), Math.abs(zn));
            const X = xn * So + (s > 1e-6 ? (xn / s) * (ridge / 2) : 0);
            // retroussis des angles (japonais)
            const corner = jp ? (Math.max(0, Math.abs(xn) - 0.55) * Math.max(0, Math.abs(zn) - 0.55)) * 5 : 0;
            return [X, qq[1] * rh - over * Math.tan(pitch) * (jp ? 0.6 : 1) + corner, zn * So];
          });
          put(pyr.facet(), [0, 0, 0]);
          // planches de rive (débord)
          for (const sz of [-1, 1]) put(box(Lo, 0.06, 0.05, jp ? ROLE.bark : lk.trim), [0, -over * Math.tan(pitch) * (jp ? 0.6 : 1) - 0.04, sz * So]);
          for (const sx of [-1, 1]) put(box(0.05, 0.06, So, jp ? ROLE.bark : lk.trim), [sx * Lo, -over * Math.tan(pitch) * (jp ? 0.6 : 1) - 0.04, 0]);
          if (jp) {
            // irimoya : petit pignon en haut de chaque croupe, faîtage épais à épis
            const yT = rh - over * Math.tan(pitch) * 0.6;
            for (const sx of [-1, 1]) put(extrude([[-S * 0.18, 0], [S * 0.18, 0], [0, rh * 0.32]], 0.04, ROLE.paper), [sx * (ridge / 2 + S * 0.1) - (sx > 0 ? 0.04 : 0), yT - rh * 0.3, 0], yawQ(Math.PI / 2));
            put(box(ridge / 2 + 0.3, 0.12, 0.12, ROLE.metal), [0, rh - over * Math.tan(pitch) * 0.6 + 0.05, 0]);
            for (const sx of [-1, 1]) put(box(0.12, 0.25, 0.08, ROLE.metal), [sx * (ridge / 2 + 0.3), rh - over * Math.tan(pitch) * 0.6 + 0.2, 0], qAxis([0, 0, 1], -sx * 0.4));
          }
          // lucarnes de mansarde
          if (kind === "mansard" && main)
            for (let b = 0; b < p.bays; b++) {
              const x = -L / 2 + 0.35 + (b + 0.5) * ((L - 0.7) / p.bays);
              const zf = S / 2 - 0.05;
              put(box(0.42, 0.55, 0.35, lk.wall, 0), [x, 0.6, zf - 0.2]);
              put(box(0.3, 0.38, 0.02, ROLE.glass, 0), [x, 0.6, zf + 0.16]);
              put(box(0.36, 0.04, 0.04, lk.trim, 0), [x, 0.98, zf + 0.17]);
              put(box(0.53, 0.06, 0.45, lk.roof, 0), [x, 1.18, zf - 0.12], qAxis([1, 0, 0], 12 * DEG));
            }
          return top + rh;
        }
        // deux pans (gable), coyaux, rives, faîtage
        const half = S / 2;
        const rh = Math.tan(pitch) * half;
        const th = lk.roofMat === "chaume" ? 0.32 : lk.roofMat === "lauze" ? 0.18 : 0.12;
        const coyau = lk.coyau && lk.roofMat !== "chaume";
        for (const sz of [1, -1]) {
          const z0 = 0, z1 = coyau ? half : half + over;
          const run = z1 - z0;
          const slope = run / Math.cos(pitch);
          const cy = rh - (Math.tan(pitch) * (z0 + z1)) / 2;
          put(box(L / 2 + overEnd, th / 2, slope / 2 + 0.03, lk.roof, lk.roofMat === "chaume" ? 0.12 : 0), [0, cy + th / 2, sz * (z0 + z1) / 2], qAxis([1, 0, 0], sz * pitch));
          if (coyau) {
            const cp = pitch * 0.45;
            const cr2 = (over + 0.15) / Math.cos(cp);
            put(box(L / 2 + overEnd, th / 2, cr2 / 2, lk.roof, 0), [0, -Math.tan(cp) * (over + 0.15) / 2 + th / 2, sz * (half + (over + 0.15) / 2 - 0.08)], qAxis([1, 0, 0], sz * cp));
          }
          if (lk.roofMat === "zinc")
            for (let x = -L / 2 - overEnd + 0.25; x < L / 2 + overEnd; x += 0.5) put(box(0.015, 0.025, slope / 2, ROLE.metal), [x, cy + th + 0.02, sz * (z0 + z1) / 2], qAxis([1, 0, 0], sz * pitch));
          // génoise méditerranéenne : deux rangs de tuiles en encorbellement
          if (lk.genoise) for (let k = 0; k < 2; k++) put(box(L / 2 + 0.02, 0.05, 0.06 + k * 0.06, k ? lk.roof : lk.trim), [0, -0.08 - (1 - k) * 0.1, sz * (half + 0.04 + k * 0.05)]);
        }
        // pignons
        const gableRole = lk.finish === "colombages" || lk.finish === "bardage" || st === "chalet" ? (st === "chalet" || lk.finish === "bardage" ? ROLE.wood : lk.wall) : lk.wall;
        for (const sx of [-1, 1]) put(extrude([[-half, 0], [half, 0], [0, rh - 0.04]], 0.2, gableRole), [sx * L / 2 - (sx > 0 ? 0.2 : 0), 0, 0], yawQ(Math.PI / 2));
        if (st === "chalet" || lk.finish === "bardage")
          for (const sx of [-1, 1]) for (let z = -half + 0.25; z < half - 0.1; z += 0.42) {
            const hh = (rh - 0.04) * (1 - Math.abs(z) / half);
            if (hh > 0.1) put(box(0.02, hh / 2, 0.025, ROLE.wood), [sx * (L / 2 + 0.01), hh / 2, z], I);
          }
        if (lk.finish === "colombages") for (const sx of [-1, 1]) {
          put(box(0.04, 0.06, half * 0.7, ROLE.wood), [sx * (L / 2 + 0.02), rh * 0.3, 0]);
          put(box(0.04, (rh * 0.7) / 2, 0.06, ROLE.wood), [sx * (L / 2 + 0.02), rh * 0.3 + (rh * 0.62) / 2, 0]);
        }
        // planches de rive et faîtage
        const bl = (half + over) / Math.cos(pitch);
        if (lk.roofMat !== "chaume")
          for (const sx of [-1, 1]) for (const sz of [1, -1]) put(box(0.04, 0.1, bl / 2, ROLE.trim), [sx * (L / 2 + overEnd + 0.02), rh - (Math.tan(pitch) * (half + over)) / 2 - 0.02, (sz * (half + over)) / 2], qAxis([1, 0, 0], sz * pitch));
        if (lk.roofMat === "chaume") put(cylinder(0.22, 0.22, L + overEnd * 2, ROLE.leaf2, 6), [-(L / 2 + overEnd), rh + th * 0.6, 0], qAxis([0, 0, 1], -Math.PI / 2));
        else put(box(L / 2 + overEnd + 0.04, 0.09, 0.09, lk.roofMat === "tuile" ? ROLE.roof : ROLE.metal), [0, rh + th * 0.75, 0], qAxis([1, 0, 0], Math.PI / 4));
        if (st === "chalet") for (const sx of [-1, 1]) put(box(0.05, 0.45, 0.05, ROLE.wood), [sx * (L / 2 + overEnd + 0.05), rh + 0.15, 0]);
        // lucarnes (corps principal, ardoise / tuile, toits assez hauts)
        if (main && !ridgeZ && rh > 1.6 && st !== "chalet" && st !== "japonais") {
          const nD = r.chance(0.55 + lk.ornament * 0.3) ? r.int(1, Math.max(1, p.bays - 1)) : 0;
          const dk = r.pick(["pignon", "pignon", "rampant", "oeil", "chien"] as const);
          for (let i = 0; i < nD; i++) {
            const x = nD === 1 ? r.range(-0.6, 0.6) : mix(-L / 2 + 1.4, L / 2 - 1.4, i / (nD - 1));
            const zf = half - 0.75;
            const yb = Math.tan(pitch) * 0.75;
            const dw = dk === "oeil" ? 0.42 : 0.5;
            if (dk === "oeil") {
              put(ellipsoid(0.45, 0.42, 0.5, lk.roof, 8, 4), [x, yb, zf - 0.05]);
              put(extrude(ngon(10, 0.22), 0.02, ROLE.glass), [x, yb + 0.12, zf + 0.33]);
              continue;
            }
            const dh = dk === "chien" ? 0.45 : 0.7;
            put(box(dw, dh / 2 + yb / 2, 0.6, lk.wall), [x, (dh + yb) / 2 - 0.1, zf - 0.25]);
            put(box(dw - 0.12, dh / 2 - 0.08, 0.02, ROLE.glass), [x, yb + dh / 2 - 0.02, zf + 0.36]);
            put(box(dw - 0.05, 0.04, 0.05, lk.trim), [x, yb + dh - 0.05, zf + 0.37]);
            put(box(0.02, dh / 2 - 0.08, 0.03, lk.trim), [x, yb + dh / 2 - 0.02, zf + 0.38]);
            if (dk === "pignon") {
              const dp = 45 * DEG;
              const dr = Math.tan(dp) * (dw + 0.1);
              for (const sx of [-1, 1]) put(box((dw + 0.15) / Math.cos(dp) / 2, 0.04, 0.5, lk.roof), [x + (sx * (dw + 0.15)) / 2, yb + dh + dr / 2 - 0.02, zf - 0.1], qAxis([0, 0, 1], -sx * dp));
              put(extrude([[-dw, 0], [dw, 0], [0, dr]], 0.04, lk.wall), [x, yb + dh, zf + 0.33]);
            } else put(box(dw + 0.12, 0.04, 0.55, lk.roof), [x, yb + dh + 0.08, zf - 0.15], qAxis([1, 0, 0], (dk === "chien" ? 8 : 14) * DEG));
          }
        }
        return top + rh + th;
      }
    }

    // recentrage de l'emprise (la façade reste vers +z ; l'ancre suit)
    const cx = (plan.x0 + plan.x1) / 2, cz = (plan.z0 + plan.z1) / 2;
    if (Math.abs(cx) > 1e-6 || Math.abs(cz) > 1e-6) mesh.mapPos((q) => [q[0] - cx, q[1], q[2] - cz]);
    const hx = (plan.x1 - plan.x0) / 2 + 0.15, hz = (plan.z1 - plan.z0) / 2 + 0.1;
    return {
      generator: "building",
      mesh,
      anchors: { door: { pos: [door[0] - cx, 0, door[2] - cz], rot: [0, 0, 0, 1], scale: 1 }, roof: { pos: [-cx, roofTop, -cz], rot: [0, 0, 0, 1], scale: hx } },
      footprint: { hx, hz, r: Math.hypot(hx, hz) },
      height: clamp(roofTop + 1, 0, 200),
      extra: { width: hx * 2, depth: hz * 2, style: st },
    };
  },
});

/** Point d'une façade (u le long du mur, y, out vers l'extérieur) en coordonnées de l'objet. */
function at(f: Face, u: number, y: number, out: number): V3 {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  return [f.o[0] + c * u + s * out, y, f.o[2] - s * u + c * out];
}

function pickRoof(st: Style, asked: string, rng: Rng, W: number, D: number): string {
  if (st === "moderne" || st === "neon") return "flat";
  if (st === "japonais") return "hip";
  if (st === "chapelle") return "gable";
  if (asked !== "auto") return asked;
  const r = rng.fork("roofkind");
  switch (st) {
    case "chalet":
      return "pignon";
    case "chateau":
      return r.pick(["hip", "mansard", "hip"]);
    case "mediterraneen":
      return r.pick(["gable", "hip", "flat", "gable"]);
    case "chaumiere":
    case "ferme":
      return r.chance(0.8) ? "gable" : "hip";
    case "boutique":
      return r.pick(["gable", "pignon", "mansard"]);
    case "vapeur":
      return r.pick(["flat", "gable"]);
    default:
      return W < 6.5 && r.chance(0.35) ? "pignon" : r.weighted([["gable", 5], ["hip", 2], ["mansard", D > 8 ? 2 : 0.5], ["pignon", 1.5]] as const);
  }
}

/** Tire l'allure d'une maison selon le style et les surcharges. */
function pickLook(st: Style, p: { walls: string; roofing: string; ornament: number; shutters: number }, rng0: Rng): Look {
  const r = rng0.fork("look");
  const orn = p.ornament >= 0 ? p.ornament : r.range(0, 1);
  // façades : enduits clairs variés (le shader varie déjà la teinte par objet)
  const enduit = r.weighted([[ROLE.wall, 5], [ROLE.paper, 2], [ROLE.cloth3, 2], [ROLE.trim, 1.5], [ROLE.path, 1]] as const);
  const shutterColor = r.weighted([[ROLE.accent, 2], [ROLE.leaf2, 2], [ROLE.water, 2], [ROLE.wood, 2], [ROLE.cloth2, 1], [ROLE.metal, 1], [ROLE.paper, 0.7], [ROLE.cloth1, 1]] as const);
  const doorColor = r.weighted([[ROLE.wood, 4], [shutterColor, 3], [ROLE.cloth2, 1], [ROLE.accent, 1], [ROLE.leaf2, 1]] as const);
  const L: Look = {
    finish: "enduit",
    wall: enduit,
    base: ROLE.stone,
    trim: r.chance(0.7) ? ROLE.trim : ROLE.stone,
    roofMat: "tuile",
    roof: ROLE.roof,
    shutter: shutterColor,
    shutterKind: r.chance(0.55) ? "persiennes" : "pleins",
    door: doorColor,
    win: r.weighted([["rect", 6], ["segment", 2], ["arch", 1]] as const),
    petitsBois: r.chance(0.55),
    ornament: orn,
    planters: r.chance(0.45) ? r.range(0.15, 0.6) : 0,
    quoins: r.chance(0.5),
    bands: r.chance(0.6),
    modillons: orn > 0.6,
    gutters: r.chance(0.7),
    genoise: false,
    coyau: r.chance(0.35),
    pitch: r.range(36, 46) * DEG,
  };
  switch (st) {
    case "colombages":
      Object.assign(L, { finish: "colombages", quoins: false, bands: false, pitch: r.range(48, 56) * DEG, roofMat: r.chance(0.75) ? "tuile" : "ardoise", win: "rect" });
      break;
    case "chaumiere":
      Object.assign(L, { finish: r.chance(0.6) ? "pierre" : "enduit", roofMat: "chaume", pitch: r.range(46, 52) * DEG, quoins: false, bands: false, shutterKind: "pleins", win: "rect", gutters: false, petitsBois: true });
      break;
    case "pierre":
      Object.assign(L, { finish: "pierre", wall: ROLE.stone, trim: ROLE.trim, quoins: true, roofMat: r.weighted([["tuile", 2], ["ardoise", 2], ["lauze", 1]] as const) });
      break;
    case "vapeur":
      Object.assign(L, { finish: "brique", wall: ROLE.roof, trim: ROLE.stone, roofMat: "zinc", win: r.chance(0.6) ? "segment" : "arch", shutterKind: "none", planters: 0 });
      break;
    case "moderne":
    case "neon":
      Object.assign(L, { finish: "beton", wall: ROLE.wall, base: ROLE.road, trim: ROLE.metal, roofMat: "zinc", shutterKind: "none", win: "wide", quoins: false, bands: false, planters: 0, gutters: false, coyau: false });
      break;
    case "ferme":
      Object.assign(L, { finish: r.chance(0.55) ? "pierre" : "enduit", pitch: r.range(34, 42) * DEG, shutterKind: "pleins", win: "rect", quoins: r.chance(0.6), bands: false, modillons: false, petitsBois: true });
      break;
    case "chalet":
      Object.assign(L, { finish: "bardage", wall: ROLE.wood, base: ROLE.stone, pitch: r.range(22, 28) * DEG, roofMat: r.chance(0.5) ? "lauze" : "ardoise", shutterKind: "pleins", win: "rect", quoins: false, bands: false, gutters: false, coyau: false, planters: r.range(0.4, 0.9), shutter: r.pick([ROLE.accent, ROLE.leaf2, ROLE.paper, ROLE.wood]) });
      break;
    case "mediterraneen":
      Object.assign(L, { wall: r.pick([ROLE.paper, ROLE.wall, ROLE.cloth3, ROLE.path, ROLE.flower]), pitch: r.range(20, 26) * DEG, roofMat: "tuile", shutterKind: "persiennes", genoise: true, coyau: false, gutters: false, quoins: false, bands: false, win: r.pick(["rect", "arch", "rect"]), shutter: r.pick([ROLE.water, ROLE.leaf2, ROLE.accent, ROLE.wood, ROLE.paper]) });
      break;
    case "japonais":
      Object.assign(L, { finish: "shoji", wall: ROLE.paper, base: ROLE.stone, trim: ROLE.bark, roofMat: "kawara", roof: ROLE.metal, shutterKind: "none", win: "shoji", door: ROLE.paper, quoins: false, bands: false, gutters: false, planters: 0, pitch: 30 * DEG, coyau: false });
      break;
    case "chateau":
      Object.assign(L, { finish: "pierre", wall: r.chance(0.6) ? ROLE.stone : ROLE.wall, trim: ROLE.trim, roofMat: "ardoise", win: "mullion", quoins: true, bands: true, pitch: r.range(52, 58) * DEG, ornament: Math.max(orn, 0.7), modillons: true, shutterKind: "none" });
      break;
    case "chapelle":
      Object.assign(L, { finish: "pierre", wall: ROLE.stone, trim: ROLE.trim, roofMat: r.chance(0.5) ? "ardoise" : "tuile", win: "lancet", quoins: true, bands: false, pitch: r.range(48, 55) * DEG, shutterKind: "none", planters: 0, coyau: false });
      break;
    case "boutique":
      Object.assign(L, { ornament: Math.max(orn, 0.4), planters: r.range(0.2, 0.7) });
      break;
    case "bourg":
      if (r.chance(0.18)) Object.assign(L, { finish: "brique", wall: ROLE.roof, trim: ROLE.trim });
      else if (r.chance(0.15)) Object.assign(L, { finish: "pierre", wall: ROLE.stone });
      Object.assign(L, { roofMat: r.weighted([["tuile", 7], ["ardoise", 2], ["zinc", 0.5]] as const) });
      break;
  }
  if (p.walls !== "auto") {
    L.finish = p.walls as WallFinish;
    L.wall = p.walls === "pierre" ? ROLE.stone : p.walls === "brique" ? ROLE.roof : p.walls === "bardage" ? ROLE.wood : L.wall === ROLE.stone || L.wall === ROLE.wood || L.wall === ROLE.roof ? ROLE.wall : L.wall;
  }
  if (p.roofing !== "auto") L.roofMat = p.roofing as RoofMat;
  L.roof = L.roofMat === "tuile" ? ROLE.roof : L.roofMat === "chaume" ? ROLE.path : L.roofMat === "lauze" ? ROLE.stone : L.roofMat === "kawara" ? ROLE.metal : ROLE.metal;
  if (L.wall === ROLE.roof && L.roof === ROLE.roof) L.roof = ROLE.metal;
  if (L.shutter === L.wall) L.shutter = ROLE.wood;
  if (p.shutters <= 0) L.shutterKind = "none";
  return L;
}

/** Moulin, phare, tour : silhouettes de révolution. */
function singular(st: Style, p: { floors: number; depth: number; ornament: number }, rng: Rng, mesh: Mesh, ext: (a: number, b: number, c: number, d: number) => void): { top: number; door: V3 } {
  const add = (m: Mesh, pos: V3, q: Q = I) => mesh.append(m, m4Compose(pos, q));
  const r = rng.fork("singular");
  const window = (a: number, y: number, rad: number, w: number, h: number, frame: number) => {
    const pos: V3 = [Math.sin(a) * rad, y, Math.cos(a) * rad];
    const q = yawQ(a);
    mesh.append(box(w / 2, h / 2, 0.03, ROLE.glass), m4Compose(pos, q));
    mesh.append(extrude(archBand("arch", w, h, 0.08), 0.06, frame), m4Compose([pos[0], y - h / 2, pos[2]], q));
    mesh.append(box(w / 2 + 0.1, 0.04, 0.1, frame), m4Compose([pos[0] + Math.sin(a) * 0.05, y - h / 2 - 0.04, pos[2] + Math.cos(a) * 0.05], q));
  };
  if (st === "moulin") {
    const H = 6 + p.floors * 1.6;
    const R0 = 2.6, R1 = 1.8;
    add(lathe([[R0 + 0.15, 0], [R0 + 0.15, 0.5], [R0, 0.5], [R1, H], [R1 + 0.15, H], [R1 + 0.15, H + 0.12]], ROLE.wall, 16), [0, 0, 0]);
    // calotte orientable (bonnet) en bardeaux
    const capH = 2.2;
    add(lathe([[R1 + 0.3, 0], [R1 + 0.2, 0.5], [R1 * 0.7, capH * 0.8], [0, capH]], ROLE.roof, 14), [0, H + 0.12, 0]);
    // moyeu et ailes (4 bras à treillis, toiles)
    const hub: V3 = [0, H + 0.5, R1 + 0.7];
    add(cylinder(0.22, 0.22, 1.2, ROLE.wood, 8), [0, H + 0.5, R1 - 0.4], qAxis([1, 0, 0], Math.PI / 2));
    const tilt = r.range(0, 45) * DEG;
    const L = H * 0.75;
    for (let k = 0; k < 4; k++) {
      const a = tilt + (k * Math.PI) / 2;
      const q = qMul(qAxis([0, 0, 1], a), I);
      const dir: V3 = [Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2), 0];
      add(box(0.07, L / 2, 0.07, ROLE.wood), [hub[0] + dir[0] * L / 2, hub[1] + dir[1] * L / 2, hub[2]], q);
      // treillis : barreaux transverses + longerons, toile sur 2/3
      const side = 0.75;
      for (let i = 1; i <= 7; i++) {
        const t = 0.22 + (i / 7) * 0.76;
        add(box(side / 2 + 0.05, 0.025, 0.025, ROLE.wood), [hub[0] + dir[0] * L * t + Math.cos(a) * side / 2, hub[1] + dir[1] * L * t + Math.sin(a) * side / 2, hub[2] + 0.04], q);
      }
      add(box(0.025, L * 0.38, 0.025, ROLE.wood), [hub[0] + dir[0] * L * 0.6 + Math.cos(a) * side, hub[1] + dir[1] * L * 0.6 + Math.sin(a) * side, hub[2] + 0.04], q);
      if (k % 2 === 0 || r.chance(0.6)) add(box(side / 2 - 0.02, L * 0.3, 0.01, ROLE.cloth3), [hub[0] + dir[0] * L * 0.65 + Math.cos(a) * side / 2, hub[1] + dir[1] * L * 0.65 + Math.sin(a) * side / 2, hub[2] + 0.07], q);
    }
    // porte, fenêtres, galerie basse
    const dface: Face = { o: [0, 0, R0 - 0.05], yaw: 0, w: 2, kind: "front", jet: 0 };
    mesh.append(extrude(bayOutline("arch", 1.0, 2.1), 0.05, ROLE.wood), m4Compose(at(dface, 0, 0.5, 0.02)));
    mesh.append(extrude(archBand("arch", 1.0, 2.1, 0.12), 0.1, ROLE.trim), m4Compose(at(dface, 0, 0.5, 0)));
    for (let k = 0; k < 3; k++) window(r.range(-2.4, 2.4) + (k - 1) * 1.2, 2.6 + k * (H - 3.5) / 3, mix(R0, R1, (2.6 + k * (H - 3.5) / 3) / H) - 0.02, 0.5, 0.75, ROLE.trim);
    ext(-R0 - 0.3, -R0 - 0.3, R0 + 0.3, R0 + 1.2);
    return { top: H + capH + L * 0.55, door: [0, 0, R0 + 0.8] };
  }
  if (st === "phare") {
    const H = 9 + p.floors * 2.2;
    const R0 = 1.9, R1 = 1.25;
    // fût à bandes alternées
    const bands = 5 + (p.floors % 3);
    for (let k = 0; k < bands; k++) {
      const y0 = (k / bands) * H, y1 = ((k + 1) / bands) * H;
      add(lathe([[mix(R0, R1, y0 / H), 0], [mix(R0, R1, y1 / H), y1 - y0]], k % 2 ? ROLE.accent : ROLE.wall, 16, false), [0, y0, 0]);
    }
    add(cylinder(R0 + 0.3, R0 + 0.3, 0.6, ROLE.stone, 16), [0, 0, 0]);
    // galerie, garde-corps, lanterne vitrée, dôme
    add(cylinder(R1 + 0.6, R1 + 0.6, 0.16, ROLE.stone, 16), [0, H, 0]);
    add(lathe([[R1, -0.6], [R1 + 0.6, 0]], ROLE.stone, 16, false), [0, H, 0]);
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      add(box(0.015, 0.45, 0.015, ROLE.metal), [Math.cos(a) * (R1 + 0.55), H + 0.6, Math.sin(a) * (R1 + 0.55)]);
    }
    add(lathe([[R1 + 0.55, -0.02], [R1 + 0.55, 0.02]], ROLE.metal, 20, false), [0, H + 1.05, 0]);
    add(cylinder(R1 * 0.75, R1 * 0.75, 0.5, ROLE.metal, 12), [0, H + 0.16, 0]);
    add(cylinder(R1 * 0.7, R1 * 0.7, 1.4, ROLE.lamp, 10), [0, H + 0.66, 0]);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      add(box(0.03, 0.7, 0.03, ROLE.metal), [Math.cos(a) * R1 * 0.72, H + 1.36, Math.sin(a) * R1 * 0.72]);
    }
    add(lathe([[R1 * 0.85, 0], [R1 * 0.6, 0.45], [0.12, 0.9], [0, 1.0]], ROLE.metal, 12), [0, H + 2.06, 0]);
    add(cylinder(0.03, 0.03, 0.6, ROLE.metal, 4), [0, H + 3.0, 0]);
    // fenêtres en spirale, porte, maison du gardien
    for (let k = 0; k < 4; k++) {
      const y = 3 + k * (H - 4) / 4;
      window(0.6 * k - 0.4, y, mix(R0, R1, y / H) - 0.03, 0.4, 0.7, ROLE.trim);
    }
    const kx = r.chance(0.5) ? 1 : -1;
    const hw = 4.2, hd = 3.4, hh = 2.8;
    mesh.append(box(hw / 2, hh / 2, hd / 2, ROLE.wall), m4Compose([kx * (R0 + hw / 2 - 0.2), hh / 2, -0.3]));
    const pitch = 34 * DEG;
    const rr = Math.tan(pitch) * (hd / 2 + 0.3);
    for (const sz of [1, -1]) mesh.append(box(hw / 2 + 0.25, 0.06, (hd / 2 + 0.3) / Math.cos(pitch) / 2, ROLE.roof), m4Compose([kx * (R0 + hw / 2 - 0.2), hh + rr / 2 - 0.1, -0.3 + (sz * (hd / 2 + 0.3)) / 2], qAxis([1, 0, 0], sz * pitch)));
    for (const sx of [-1, 1]) mesh.append(extrude([[-hd / 2, 0], [hd / 2, 0], [0, rr * (hd / 2) / (hd / 2 + 0.3)]], 0.05, ROLE.wall), m4Compose([kx * (R0 + hw / 2 - 0.2) + sx * (hw / 2 - 0.02), hh, -0.3], yawQ(Math.PI / 2)));
    const hf: Face = { o: [kx * (R0 + hw / 2 - 0.2), 0, -0.3 + hd / 2], yaw: 0, w: hw, kind: "front", jet: 0 };
    mesh.append(box(0.45, 0.4, 0.02, ROLE.glass), m4Compose(at(hf, kx * 0.8, 1.6, 0.01)));
    mesh.append(box(0.55, 0.05, 0.1, ROLE.trim), m4Compose(at(hf, kx * 0.8, 1.15, 0.05)));
    for (const sx of [-1, 1]) mesh.append(box(0.24, 0.42, 0.025, ROLE.water), m4Compose(at(hf, kx * 0.8 + sx * 0.72, 1.6, 0.03)));
    mesh.append(box(0.45, 1.0, 0.03, ROLE.wood), m4Compose([0, 1.15, R0 + 0.02]));
    mesh.append(box(0.55, 0.06, 0.1, ROLE.trim), m4Compose([0, 2.2, R0 + 0.05]));
    mesh.append(box(0.7, 0.1, 0.4, ROLE.stone), m4Compose([0, 0.1, R0 + 0.3]));
    ext(Math.min(-R0 - 0.3, kx < 0 ? -R0 - hw : -R0), -hd / 2 - 0.4, Math.max(R0 + 0.3, kx > 0 ? R0 + hw : R0), R0 + 0.7);
    return { top: H + 3.6, door: [0, 0, R0 + 0.9] };
  }
  // tour / donjon : carrée ou ronde, mâchicoulis et créneaux, ou toit en poivrière
  const round = r.chance(0.5);
  const H = 8 + p.floors * 2.4;
  const R = round ? r.range(2.6, 3.4) : r.range(2.6, 3.4);
  const crenel = r.chance(0.55);
  if (round) add(lathe([[R + 0.35, 0], [R + 0.1, 1.2], [R, 1.4], [R, H]], ROLE.stone, 18, false), [0, 0, 0]);
  else {
    mesh.append(box(R + 0.25, 0.6, R + 0.25, ROLE.stone, 0.02), m4Compose([0, 0.6, 0]));
    mesh.append(box(R, H / 2, R, ROLE.stone), m4Compose([0, H / 2, 0]));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let y = 1.2; y < H - 0.4; y += 0.5) mesh.append(box(0.25, 0.2, 0.25, ROLE.trim), m4Compose([sx * (R - 0.2), y + 0.25, sz * (R - 0.2)]));
  }
  // mâchicoulis : consoles et parapet en saillie
  const n = round ? 18 : 6;
  if (round)
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      mesh.append(box(0.12, 0.3, 0.25, ROLE.trim), m4Compose([Math.sin(a) * (R + 0.15), H - 0.2, Math.cos(a) * (R + 0.15)], yawQ(a)));
    }
  else
    for (const [yaw, sx, sz] of [[0, 0, 1], [Math.PI, 0, -1], [Math.PI / 2, 1, 0], [-Math.PI / 2, -1, 0]] as const)
      for (let k = 0; k < n; k++) {
        const u = -R + 0.4 + (k * (2 * R - 0.8)) / (n - 1);
        const c = Math.cos(yaw), s = Math.sin(yaw);
        mesh.append(box(0.12, 0.3, 0.25, ROLE.trim), m4Compose([sx * (R + 0.15) + c * u, H - 0.2, sz * (R + 0.15) - s * u], yawQ(yaw)));
      }
  const PR = R + 0.35;
  if (round) add(cylinder(PR, PR, 1.0, ROLE.stone, 18), [0, H, 0]);
  else mesh.append(box(PR, 0.5, PR, ROLE.stone), m4Compose([0, H + 0.5, 0]));
  let top = H + 1.0;
  if (crenel) {
    const m = round ? 14 : 5;
    for (let k = 0; k < (round ? m : m * 4); k++) {
      if (round) {
        const a = ((k + 0.5) / m) * Math.PI * 2;
        mesh.append(box(0.32, 0.3, 0.22, ROLE.stone), m4Compose([Math.sin(a) * (PR - 0.2), H + 1.3, Math.cos(a) * (PR - 0.2)], yawQ(a)));
      } else {
        const side = Math.floor(k / m), i = k % m;
        const yaw = (side * Math.PI) / 2;
        const u = -PR + 0.3 + (i * (2 * PR - 0.6)) / (m - 1);
        const c = Math.cos(yaw), s = Math.sin(yaw);
        mesh.append(box(0.3, 0.3, 0.2, ROLE.stone), m4Compose([c * u + s * (PR - 0.2), H + 1.3, -s * u + c * (PR - 0.2)], yawQ(yaw)));
      }
    }
    top = H + 1.6;
    // échauguette de guet : petit mât et bannière
    add(cylinder(0.04, 0.04, 2.5, ROLE.wood, 5), [0, H + 1.0, 0]);
    mesh.append(extrude([[0, 0], [1.0, -0.1], [0.8, -0.35], [1.0, -0.6], [0, -0.7]], 0.02, ROLE.accent), m4Compose([0.04, H + 3.4, 0]));
    top = H + 3.5;
  } else {
    const rh = R * 2.2;
    add(lathe([[PR + 0.3, 0], [PR * 0.9, rh * 0.15], [PR * 0.35, rh * 0.7], [0, rh]], ROLE.metal, round ? 18 : 4), [0, H + 1.0, 0], round ? I : yawQ(Math.PI / 4));
    top = H + 1.0 + rh;
  }
  // porte en arc, archères, fenêtres à meneaux en haut
  const front: Face = { o: [0, 0, R], yaw: 0, w: 2 * R, kind: "front", jet: 0 };
  mesh.append(extrude(bayOutline("arch", 1.3, 2.5), 0.04, ROLE.wood), m4Compose(at(front, 0, 0.5, 0.02)));
  mesh.append(extrude(archBand("arch", 1.3, 2.5, 0.2), 0.12, ROLE.trim), m4Compose(at(front, 0, 0.5, 0)));
  mesh.append(box(1.0, 0.12, 0.6, ROLE.stone), m4Compose([0, 0.12, R + 0.5]));
  for (let k = 0; k < Math.floor(H / 3.2); k++) {
    const y = 3.8 + k * 3.2;
    for (const a of [0.0 + (k % 2) * 0.5, Math.PI / 2 + 0.2, -Math.PI / 2 - 0.2]) {
      const rad = round ? R : R / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const pos: V3 = [Math.sin(a) * rad, y, Math.cos(a) * rad];
      if (k < Math.floor(H / 3.2) - 1) mesh.append(box(0.06, 0.4, 0.05, ROLE.ink), m4Compose(pos, yawQ(a)));
      else window(a, y, rad, 0.6, 1.1, ROLE.trim);
    }
  }
  ext(-PR - 0.3, -PR - 0.3, PR + 0.3, PR + 0.9);
  return { top, door: [0, 0, R + 1.0] };
}
