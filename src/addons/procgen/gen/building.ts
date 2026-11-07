/**
 * Générateur `building` : grammaire de découpe simple — volume → soubassement → étages → travées → ouvertures —
 * puis toit, corniche, cheminées. La crédibilité vient des **retraits** : encadrements saillants, appuis, linteaux,
 * volets, bandeaux d'étage, toit débordant ; léger faux aplomb en style `bourg`.
 *
 * Repère : façade principale vers +z, base en y = 0, centré en x et z. Ancre `door` devant la porte.
 */
import { type V3, DEG, clamp, m4Compose, mix, qAxis } from "../core/math";
import { Rng } from "../core/rng";
import { Mesh } from "../geom/mesh";
import { box, cylinder, extrude, lathe, tube } from "../geom/prims";
import { ROLE } from "../style/roles";
import { defineGenerator } from "./types";

const STYLES = ["bourg", "colombages", "vapeur", "moderne", "neon", "chaumiere", "pierre"] as const;
const ROOFS = ["gable", "hip", "flat", "mansard"] as const;

export const building = defineGenerator({
  id: "building",
  label: "Bâtiment",
  doc: "Maison ou immeuble par grammaire de découpe : soubassement, étages, travées, fenêtres à encadrements, porte, vitrine, balcons, toit (gable, hip, flat, mansard), cheminées. Styles : bourg, colombages, vapeur, moderne, neon, chaumiere, pierre.",
  tags: ["ville", "village", "rue", "architecture", "maison"],
  schema: {
    style: { type: "enum", default: "bourg", options: STYLES, doc: "Style" },
    floors: { type: "int", default: 2, min: 1, max: 12, doc: "Étages (rez-de-chaussée compris)" },
    bays: { type: "int", default: 3, min: 1, max: 8, doc: "Travées en façade" },
    depth: { type: "number", default: 7, min: 3, max: 25, unit: "m", doc: "Profondeur" },
    roof: { type: "enum", default: "gable", options: ROOFS, doc: "Toit" },
    shop: { type: "bool", default: false, doc: "Vitrine au rez-de-chaussée" },
    balconies: { type: "number", default: 0.2, min: 0, max: 1, doc: "Probabilité de balcon par fenêtre d'étage" },
    shutters: { type: "number", default: 0.6, min: 0, max: 1, doc: "Probabilité de volets" },
    decay: { type: "number", default: 0.1, min: 0, max: 1, doc: "Usure (volets manquants, faux aplomb)" },
    chimneys: { type: "int", default: -1, min: -1, max: 4, doc: "Cheminées (−1 = selon la graine)" },
  },
  build(p, ctx) {
    const rng = ctx.rng;
    const st = p.style;
    const mesh = new Mesh();
    const bayW = st === "moderne" || st === "neon" ? 3.2 : st === "chaumiere" ? 2.6 : 2.7;
    const W = p.bays * bayW + (st === "moderne" ? 0 : 0.6);
    const D = p.depth;
    const fh = st === "moderne" || st === "neon" ? 3.3 : st === "chaumiere" ? 2.6 : 3;
    const plinth = st === "moderne" ? 0.25 : 0.5;
    const wallH = p.floors * fh;
    const top = plinth + wallH;
    const W2 = W / 2, D2 = D / 2;
    const add = (m: Mesh, pos: V3, rotY = 0, rotX = 0) => mesh.append(m, m4Compose(pos, rotX ? qAxis([1, 0, 0], rotX) : qAxis([0, 1, 0], rotY)));
    // vapeur : brique (rôle terre cuite) ; pierre : moellons
    const wallRole = st === "pierre" ? ROLE.stone : st === "vapeur" ? ROLE.roof : ROLE.wall;
    // volume
    add(box(W2 + 0.07, plinth / 2, D2 + 0.07, ROLE.stone, 0.02), [0, plinth / 2, 0]);
    add(box(W2, wallH / 2, D2, wallRole, 0.015), [0, plinth + wallH / 2, 0]);
    // chaînes d'angle et bandeaux
    if (st === "bourg" || st === "pierre" || st === "vapeur")
      for (const sx of [-1, 1])
        for (const sz of [-1, 1])
          for (let y = plinth; y < top - 0.2; y += 0.5) add(box(0.22, 0.2, 0.22, ROLE.trim, 0.01), [sx * (W2 - 0.15), y + 0.25, sz * (D2 - 0.15)]);
    for (let f = 1; f < p.floors; f++) if (st !== "moderne" && st !== "chaumiere") add(box(W2 + 0.05, 0.07, D2 + 0.05, ROLE.trim, 0.01), [0, plinth + f * fh, 0]);
    if (st !== "chaumiere") add(box(W2 + 0.16, 0.12, D2 + 0.16, ROLE.trim, 0.02), [0, top - 0.06, 0]);
    // colombages : poutres apparentes sur les étages
    if (st === "colombages") {
      for (let f = 1; f < p.floors; f++) {
        const y0 = plinth + f * fh;
        for (let b = 0; b <= p.bays; b++) add(box(0.09, fh / 2, 0.05, ROLE.wood, 0), [-W2 + 0.3 + b * bayW, y0 + fh / 2, D2 + 0.02]);
        add(box(W2, 0.08, 0.05, ROLE.wood, 0), [0, y0 + 0.08, D2 + 0.02]);
        for (let b = 0; b < p.bays; b++) {
          const x = -W2 + 0.3 + (b + 0.5) * bayW;
          const diag = box(0.06, fh * 0.32, 0.04, ROLE.wood, 0);
          mesh.append(diag, m4Compose([x + (b % 2 ? 0.45 : -0.45) * bayW, y0 + fh * 0.3, D2 + 0.02], qAxis([0, 0, 1], (b % 2 ? 1 : -1) * 38 * DEG)));
        }
      }
    }
    // ouvertures
    const winW = st === "moderne" || st === "neon" ? 1.9 : st === "chaumiere" ? 0.9 : 1.05;
    const winH = st === "moderne" || st === "neon" ? 1.9 : st === "chaumiere" ? 1.0 : 1.45;
    const doorBay = Math.floor((p.bays - 1) / 2);
    const facades: { z: number; rot: number; front: boolean }[] = [{ z: D2, rot: 0, front: true }, { z: -D2, rot: Math.PI, front: false }];
    const opening = (x: number, y: number, w: number, h: number, face: { z: number; rot: number }, kind: "window" | "door" | "shop", r: Rng) => {
      const s = face.rot === 0 ? 1 : -1;
      const P = (dx: number, dy: number, dz: number): V3 => [s * (x + dx), y + dy, face.z + s * dz];
      const fr = 0.08;
      const out = st === "moderne" ? 0.03 : 0.07;
      const frameRole = st === "moderne" || st === "neon" ? ROLE.metal : ROLE.trim;
      // vitre / panneau légèrement en avant du mur (les encadrements saillants créent le retrait)
      const fill = kind === "door" ? (st === "moderne" ? ROLE.glass : ROLE.wood) : ROLE.glass;
      add(box(w / 2, h / 2, 0.02, fill, 0), P(0, h / 2, 0.012), face.rot);
      if (kind === "door" && st !== "moderne") add(box(w / 2 - 0.12, h * 0.18, 0.025, ROLE.wood, 0.01), P(0, h * 0.7, 0.035), face.rot);
      // encadrement
      add(box(w / 2 + fr, fr / 2, out, frameRole, 0.01), P(0, h + fr / 2, out / 2), face.rot);
      add(box(fr / 2, h / 2, out, frameRole, 0.01), P(-w / 2 - fr / 2, h / 2, out / 2), face.rot);
      add(box(fr / 2, h / 2, out, frameRole, 0.01), P(w / 2 + fr / 2, h / 2, out / 2), face.rot);
      if (kind === "window") {
        add(box(w / 2 + fr * 1.6, 0.045, 0.14, ROLE.trim, 0.01), P(0, -0.045, 0.08), face.rot); // appui
        if (st !== "moderne" && st !== "neon") {
          add(box(0.025, h / 2, 0.03, frameRole, 0), P(0, h / 2, 0.03), face.rot);
          add(box(w / 2, 0.025, 0.03, frameRole, 0), P(0, h * 0.62, 0.03), face.rot);
        }
        if (r.chance(p.shutters) && st !== "moderne" && st !== "neon" && !r.chance(p.decay * 0.5))
          for (const sx of [-1, 1]) add(box(w / 4, h / 2, 0.03, ROLE.accent, 0.01), P(sx * (w * 0.75 + fr), h / 2, 0.06), face.rot);
      }
      if (kind === "door") add(box(w / 2 + 0.25, 0.08, 0.35, ROLE.stone, 0.02), P(0, -0.08 - (y - plinth) + plinth * 0, 0.3), face.rot);
      if (kind === "shop") {
        add(box(w / 2 + 0.2, 0.25, 0.06, ROLE.accent, 0.02), P(0, h + 0.4, 0.06), face.rot); // enseigne
        const aw = box(w / 2 + 0.25, 0.04, 0.6, ROLE.cloth1, 0.02);
        mesh.append(aw, m4Compose(P(0, h + 0.1, 0.55), qAxis([1, 0, 0], s * 22 * DEG)));
      }
    };
    for (const face of facades) {
      const r = rng.fork(face.front ? "front" : "back");
      for (let f = 0; f < p.floors; f++) {
        const y = plinth + f * fh + (f === 0 ? 0.0 : fh * 0.22);
        for (let b = 0; b < p.bays; b++) {
          const x = -W / 2 + (st === "moderne" ? 0 : 0.3) + (b + 0.5) * bayW;
          if (f === 0 && face.front && b === doorBay) {
            opening(x, plinth, st === "moderne" ? 1.6 : 1.05, Math.min(fh - 0.5, 2.3), face, "door", r);
            continue;
          }
          if (f === 0 && face.front && p.shop) {
            opening(x, plinth + 0.35, bayW - 0.7, fh - 1.1, face, "shop", r);
            continue;
          }
          if (f === 0 && st !== "moderne" && st !== "neon") {
            opening(x, plinth + 0.75, winW, winH * 0.9, face, "window", r);
            continue;
          }
          opening(x, y, winW, winH, face, "window", r);
          if (f > 0 && face.front && r.chance(p.balconies)) {
            const s = face.rot === 0 ? 1 : -1;
            add(box(winW / 2 + 0.3, 0.06, 0.4, ROLE.stone, 0.02), [s * x, y - 0.1, face.z + s * 0.4]);
            for (let k = 0; k <= 6; k++) add(cylinder(0.015, 0.015, 0.9, ROLE.metal, 5), [s * (x - winW / 2 - 0.25 + (k / 6) * (winW + 0.5)), y - 0.04, face.z + s * 0.75]);
            add(box(winW / 2 + 0.3, 0.025, 0.025, ROLE.metal, 0), [s * x, y + 0.88, face.z + s * 0.75]);
          }
        }
      }
    }
    // fenêtres de pignon pour les bâtiments profonds
    if (D > 8)
      for (let f = 1; f < p.floors; f++)
        for (const sx of [-1, 1]) {
          const r = rng.fork(`side${sx}${f}`);
          if (!r.chance(0.6)) continue;
          const g = new Mesh();
          g.append(box(0.02, winH / 2, winW / 2, ROLE.glass, 0), m4Compose([0, winH / 2, 0]));
          g.append(box(0.06, winH / 2 + 0.08, 0.04, ROLE.trim, 0.01), m4Compose([0.03, winH / 2, winW / 2 + 0.04]));
          g.append(box(0.06, winH / 2 + 0.08, 0.04, ROLE.trim, 0.01), m4Compose([0.03, winH / 2, -winW / 2 - 0.04]));
          g.append(box(0.12, 0.045, winW / 2 + 0.1, ROLE.trim, 0.01), m4Compose([0.06, -0.045, 0]));
          mesh.append(g, m4Compose([sx * (W2 + 0.012), plinth + f * fh + fh * 0.22, 0], qAxis([0, 1, 0], sx > 0 ? 0 : Math.PI)));
        }
    // toit
    const over = st === "moderne" ? 0 : 0.35;
    const roof = st === "moderne" || st === "neon" ? "flat" : p.roof;
    const roofRole = st === "chaumiere" ? ROLE.path : st === "vapeur" ? ROLE.metal : ROLE.roof;
    let roofTop = top;
    if (roof === "gable") {
      const pitch = (st === "chaumiere" ? 48 : 38) * DEG;
      const half = D2 + over;
      const rh = Math.tan(pitch) * half;
      const slope = half / Math.cos(pitch);
      const th = st === "chaumiere" ? 0.35 : 0.14;
      for (const sz of [1, -1]) {
        const m = box(W2 + over, th / 2, slope / 2, roofRole, st === "chaumiere" ? 0.12 : 0.02, 2);
        mesh.append(m, m4Compose([0, top + rh / 2 + 0.02, (sz * half) / 2], qAxis([1, 0, 0], sz * pitch)));
      }
      // pignons
      for (const sx of [-1, 1]) {
        const g = (rh * over) / half;
        const tri = extrude([[-D2, 0], [D2, 0], [D2, g], [0, rh - 0.05], [-D2, g]], 0.2, wallRole);
        mesh.append(tri, m4Compose([sx * W2 - (sx > 0 ? 0.2 : 0), top, 0], qAxis([0, 1, 0], Math.PI / 2)));
      }
      add(box(W2 + over, 0.08, 0.1, ROLE.trim, 0.03), [0, top + rh + 0.02, 0]);
      roofTop = top + rh;
    } else if (roof === "hip" || roof === "mansard") {
      const rh = (roof === "hip" ? 0.42 : 0.55) * Math.min(W, D);
      const pyr = lathe(roof === "hip" ? [[1, 0], [0.18, 1]] : [[1, 0], [0.72, 0.7], [0.7, 0.7], [0, 0.72]], roofRole, 4, true);
      pyr.mapPos((q) => {
        // carré tourné de 45° → rectangle W × D avec débord
        const c = Math.SQRT1_2;
        const x = (q[0] * c - q[2] * c) * (W2 + over), z = (q[0] * c + q[2] * c) * (D2 + over);
        return [x * Math.SQRT2, q[1] * rh, z * Math.SQRT2];
      }).computeNormals();
      add(pyr.facet(), [0, top, 0]);
      roofTop = top + rh * (roof === "hip" ? 1 : 0.72);
      if (roof === "mansard")
        for (let b = 0; b < p.bays; b++) {
          const x = -W2 + 0.3 + (b + 0.5) * bayW;
          add(box(0.45, 0.5, 0.3, wallRole, 0.03), [x, top + 0.55, D2 - 0.1]);
          add(box(0.32, 0.36, 0.03, ROLE.glass, 0), [x, top + 0.55, D2 + 0.22]);
          add(box(0.55, 0.06, 0.4, roofRole, 0.03), [x, top + 1.08, D2 - 0.05]);
        }
    } else {
      add(box(W2 - 0.1, 0.05, D2 - 0.1, ROLE.road, 0), [0, top + 0.02, 0]);
      for (const sz of [-1, 1]) add(box(W2, 0.25, 0.1, ROLE.trim, 0.02), [0, top + 0.25, sz * (D2 - 0.1)]);
      for (const sx of [-1, 1]) add(box(0.1, 0.25, D2, ROLE.trim, 0.02), [sx * (W2 - 0.1), top + 0.25, 0]);
      const vents = rng.int(1, 3);
      for (let i = 0; i < vents; i++) add(box(0.4, 0.3, 0.4, ROLE.metal, 0.03), [rng.range(-W2 + 1, W2 - 1), top + 0.32, rng.range(-D2 + 1, D2 - 1)]);
      if (st === "neon" || rng.chance(0.3)) {
        const tank = lathe([[0.7, 0], [0.7, 1.4], [0.2, 1.7], [0, 1.72]], ROLE.wood, 12);
        add(tank, [W2 * 0.4, top + 0.6, -D2 * 0.3]);
        for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) add(cylinder(0.04, 0.04, 0.6, ROLE.metal, 5), [W2 * 0.4 + dx, top, -D2 * 0.3 + dz]);
      }
      roofTop = top + 0.5;
    }
    // cheminées
    const nCh = p.chimneys >= 0 ? p.chimneys : roof === "flat" ? 0 : rng.int(0, 2);
    for (let i = 0; i < nCh; i++) {
      const x = mix(-W2 + 0.8, W2 - 0.8, nCh === 1 ? rng.range(0.15, 0.85) : i / Math.max(1, nCh - 1));
      const z = rng.range(-D2 * 0.3, D2 * 0.2);
      if (st === "vapeur") {
        add(cylinder(0.25, 0.22, roofTop - top + 2.6, ROLE.metal, 10), [x, top, z]);
        add(cylinder(0.32, 0.32, 0.2, ROLE.metal, 10), [x, roofTop + 2.4, z]);
      } else {
        const h = roofTop - top + 0.9;
        add(box(0.32, h / 2, 0.42, ROLE.stone, 0.02), [x, top + h / 2, z]);
        add(box(0.4, 0.06, 0.5, ROLE.trim, 0.02), [x, top + h + 0.06, z]);
      }
    }
    // tuyauteries (vapeur), enseignes lumineuses (néon)
    if (st === "vapeur") {
      const x = W2 - 0.4;
      add(tube([[x, 0.3, D2 + 0.12], [x, top - 0.3, D2 + 0.12], [x, top - 0.3, D2 - 0.2]], [0.08, 0.08, 0.08], ROLE.metal, 8, true, true), [0, 0, 0]);
    }
    if (st === "neon") {
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const y = plinth + rng.range(1.2, wallH - 1);
        const vertical = rng.chance(0.5);
        add(box(vertical ? 0.22 : rng.range(0.8, 1.6), vertical ? rng.range(0.8, 1.8) : 0.3, 0.06, ROLE.lamp, 0.03), [rng.range(-W2 + 0.8, W2 - 0.8), y, D2 + 0.2]);
      }
    }
    // faux aplomb et affaissement (bourg, colombages, chaumière)
    if (st === "bourg" || st === "colombages" || st === "chaumiere") {
      const lean = rng.range(-1, 1) * (0.006 + p.decay * 0.012);
      const sag = p.decay * 0.04;
      mesh.mapPos((q) => [q[0] + q[1] * lean, q[1] - sag * Math.max(0, q[1] - top) * (1 - (q[0] / (W2 + over)) ** 2), q[2]]);
    }
    const fp = { hx: W2 + over, hz: D2 + over + 0.2, r: Math.hypot(W2, D2) };
    return {
      generator: "building",
      mesh,
      anchors: { door: { pos: [-W / 2 + (st === "moderne" ? 0 : 0.3) + (doorBay + 0.5) * bayW, 0, D2 + 0.8], rot: [0, 0, 0, 1], scale: 1 }, roof: { pos: [0, roofTop, 0], rot: [0, 0, 0, 1], scale: W2 } },
      footprint: fp,
      height: clamp(roofTop + 1, 0, 200),
      extra: { width: W, depth: D },
    };
  },
});
