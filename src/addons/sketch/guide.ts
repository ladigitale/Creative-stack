/**
 * Calque guide : géométrie des repères de dessin (grilles, isométrie, perspectives à 1, 2 ou 3 points de fuite,
 * compositions, symétrie radiale, proportions du visage, mannequin de posture). Fonctions pures : tout est
 * calculé dans le « cadre » (repère en pixels d'écran de la vue d'ancrage), puis porté à l'écran par une
 * similitude (ancré à l'écran : identité ; ancré au dessin : suit déplacement, zoom et rotation).
 */

export type GuideType =
  | "none" | "grid" | "iso" | "perspective1" | "perspective2" | "perspective3"
  | "thirds" | "golden" | "diagonals" | "radial" | "face" | "figure";
export const GUIDE_TYPES: readonly GuideType[] = ["none", "grid", "iso", "perspective1", "perspective2", "perspective3", "thirds", "golden", "diagonals", "radial", "face", "figure"];

export const POSES = ["debout", "contrapposto", "marche", "course", "assis", "bras-leves", "danse", "accroupi"] as const;
export type Pose = (typeof POSES)[number];

export type GuideSettings = {
  type: GuideType;
  color: string;
  /** 0..1 */
  opacity: number;
  /** `screen` : fixe sur l'écran ; `world` : attaché au dessin (suit la vue). */
  anchor: "screen" | "world";
  /** Pas des grilles en px (8..400) ; un trait appuyé tous les `subdiv` (1..10). */
  spacing: number;
  subdiv: number;
  /** Angle des obliques isométriques (degrés, 10..80). */
  angle: number;
  /** Rotation de la grille (degrés). */
  rotation: number;
  /** Ligne d'horizon (0 = haut, 1 = bas) ; points de fuite en fraction du cadre (hors cadre permis). */
  horizon: number;
  vp1: number;
  vp2: number;
  vp3: number;
  /** Fuyantes par point de fuite / rayons de la symétrie (4..96). */
  rays: number;
  /** Visage : rotation gauche / droite et haut / bas (-1..1). */
  yaw: number;
  pitch: number;
  /** Mannequin : pose, hauteur en têtes (6..9), miroir. */
  pose: Pose;
  heads: number;
  mirror: boolean;
};

export const GUIDE_DEFAULTS: GuideSettings = {
  type: "none", color: "#2f7fd8", opacity: 0.55, anchor: "screen", spacing: 48, subdiv: 4, angle: 30, rotation: 0,
  horizon: 0.42, vp1: 0.5, vp2: 1.25, vp3: 1.9, rays: 24, yaw: 0, pitch: 0, pose: "debout", heads: 8, mirror: false,
};

const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/-]+\)|[a-z]{3,20})$/i;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const num = (v: unknown): number => (v === "" || v === null || v === undefined || typeof v === "boolean" ? NaN : Number(v));

/** Réglages assainis : ce qui est invalide garde la valeur de `base`. */
export function sanitizeGuide(raw: unknown, base: GuideSettings = GUIDE_DEFAULTS): GuideSettings {
  const o = { ...base };
  if (!raw || typeof raw !== "object") return o;
  const r = raw as Record<string, unknown>;
  if (typeof r.type === "string" && (GUIDE_TYPES as readonly string[]).includes(r.type)) o.type = r.type as GuideType;
  if (typeof r.color === "string" && COLOR_RE.test(r.color.trim())) o.color = r.color.trim();
  if (r.anchor === "screen" || r.anchor === "world") o.anchor = r.anchor;
  if (typeof r.pose === "string" && (POSES as readonly string[]).includes(r.pose)) o.pose = r.pose as Pose;
  if (typeof r.mirror === "boolean") o.mirror = r.mirror;
  const n = (k: keyof GuideSettings, a: number, b: number, round = false) => {
    const v = num(r[k]);
    if (Number.isFinite(v)) (o as Record<string, unknown>)[k] = clamp(round ? Math.round(v) : v, a, b);
  };
  n("opacity", 0, 1); n("spacing", 8, 400); n("subdiv", 1, 10, true); n("angle", 10, 80); n("rotation", -90, 90);
  n("horizon", -1, 2); n("vp1", -3, 4); n("vp2", -3, 4); n("vp3", -3, 4); n("rays", 4, 96, true);
  n("yaw", -1, 1); n("pitch", -1, 1); n("heads", 6, 9);
  return o;
}

export type P = [number, number];
/** Une ligne du guide : `w` 0 = fine, 1 = appuyée, 2 = accent ; `dot` = petit disque au point. */
export type GuidePath = { pts: P[]; closed?: boolean; w: 0 | 1 | 2; dot?: boolean };

/** Similitude cadre → écran et son inverse ; `k` = échelle. */
export type GuideMap = { to: (p: P) => P; from: (p: P) => P; k: number };
export const IDENTITY: GuideMap = { to: (p) => p, from: (p) => p, k: 1 };

const ellipse = (cx: number, cy: number, rx: number, ry: number, rot = 0, a0 = 0, a1 = Math.PI * 2, n = 48): P[] => {
  const out: P[] = [];
  const c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
};

/**
 * Famille de droites parallèles du cadre (normale à l'angle `phi`, pas `step`), limitée à l'écran `w`×`h` :
 * le pas s'adapte au zoom (×`base` ou ÷`base`) pour rester entre `step` et `step·base` pixels à l'écran.
 */
function family(phi: number, step: number, base: number, w: number, h: number, m: GuideMap, out: GuidePath[]): void {
  const b = Math.max(2, base);
  const e = Math.ceil(Math.log(1 / m.k) / Math.log(b) - 1e-9);
  const s = step * Math.pow(b, e);
  const nx = Math.cos(phi), ny = Math.sin(phi), dx = -ny, dy = nx;
  const corners = [m.from([0, 0]), m.from([w, 0]), m.from([w, h]), m.from([0, h])];
  const ns = corners.map(([x, y]) => x * nx + y * ny), ds = corners.map(([x, y]) => x * dx + y * dy);
  const i0 = Math.ceil(Math.min(...ns) / s), i1 = Math.floor(Math.max(...ns) / s);
  const t0 = Math.min(...ds), t1 = Math.max(...ds);
  if (i1 - i0 > 600) return;
  for (let i = i0; i <= i1; i++) {
    const c = i * s;
    const major = base > 1 && ((i % base) + base) % base === 0;
    out.push({ pts: [m.to([nx * c + dx * t0, ny * c + dy * t0]), m.to([nx * c + dx * t1, ny * c + dy * t1])], w: major ? 1 : 0 });
  }
}

/** Fuyantes autour d'un point de fuite (rayons réguliers, assez longs pour sortir du cadre). */
function rays(cx: number, cy: number, n: number, len: number, out: P[][]): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([[cx, cy], [cx + Math.cos(a) * len, cy + Math.sin(a) * len]]);
  }
}

/* ------------------------------------------------------------ mannequin */

type Angles = {
  lean: number; head: number; shoulder: number; hip: number;
  armL: [number, number]; armR: [number, number]; legL: [number, number]; legR: [number, number];
};
/** Angles en degrés : 0 = vers le bas, positif = vers la droite de l'image ; [segment, articulation suivante]. */
const POSE_ANGLES: Record<Pose, Angles> = {
  debout: { lean: 0, head: 0, shoulder: 0, hip: 0, armL: [8, 4], armR: [-8, -4], legL: [4, 0], legR: [-4, 0] },
  contrapposto: { lean: 4, head: -6, shoulder: -6, hip: 7, armL: [14, 30], armR: [-6, -2], legL: [-2, 4], legR: [-12, 10] },
  marche: { lean: 3, head: 0, shoulder: 3, hip: -3, armL: [-28, -18], armR: [26, 30], legL: [24, -14], legR: [-22, -30] },
  course: { lean: 14, head: 6, shoulder: 5, hip: -5, armL: [-60, -100], armR: [55, 95], legL: [45, -10], legR: [-35, -95] },
  assis: { lean: -4, head: 0, shoulder: 0, hip: 0, armL: [10, 70], armR: [-10, -70], legL: [92, -92], legR: [86, -86] },
  "bras-leves": { lean: 0, head: -4, shoulder: 0, hip: 0, armL: [150, 20], armR: [-150, -20], legL: [6, 0], legR: [-6, 0] },
  danse: { lean: -8, head: -12, shoulder: 8, hip: -6, armL: [130, 40], armR: [-85, -50], legL: [-4, 2], legR: [-70, 75] },
  accroupi: { lean: 18, head: 0, shoulder: 0, hip: 0, armL: [30, 60], armR: [-30, -60], legL: [125, -150], legR: [118, -145] },
};

function figure(s: GuideSettings, w: number, h: number): GuidePath[] {
  const out: GuidePath[] = [];
  const H = (h * 0.88) / s.heads;
  const cx = w / 2, top = h * 0.06;
  const P0 = POSE_ANGLES[s.pose];
  const flip = s.mirror ? -1 : 1;
  const rad = (d: number) => (d * Math.PI * flip) / 180;
  // Direction « vers le bas » tournée de a (0 = bas, positif = droite de l'image).
  const dir = (a: number): P => [Math.sin(a), Math.cos(a)];
  const add = (p: P, a: number, l: number): P => { const [x, y] = dir(a); return [p[0] + x * l, p[1] + y * l]; };
  // Repères de hauteur en têtes.
  for (let i = 0; i <= Math.floor(s.heads); i++) out.push({ pts: [[cx - 2.2 * H, top + i * H], [cx - 1.9 * H, top + i * H]], w: i === 0 ? 1 : 0 });
  out.push({ pts: [[cx - 2.05 * H, top], [cx - 2.05 * H, top + s.heads * H]], w: 0 });
  const lean = rad(P0.lean);
  const sit = s.pose === "assis" || s.pose === "accroupi";
  const pelvis: P = [cx, top + (sit ? 0.55 : 0.5) * s.heads * H + (s.pose === "accroupi" ? 1.2 * H : 0)];
  const neck = add(pelvis, Math.PI + lean, 2.6 * H);
  const headC = add(neck, Math.PI + lean + rad(P0.head), 0.62 * H);
  out.push({ pts: ellipse(headC[0], headC[1], 0.4 * H, 0.52 * H, rad(P0.head) + lean), closed: true, w: 2 });
  // Cage thoracique et bassin.
  const chest = add(pelvis, Math.PI + lean, 1.75 * H);
  out.push({ pts: ellipse(chest[0], chest[1], 0.78 * H, 0.95 * H, lean), closed: true, w: 1 });
  const sh = rad(P0.shoulder), hp = rad(P0.hip);
  const shoulderL: P = [neck[0] - Math.cos(sh + lean) * 0.95 * H, neck[1] - Math.sin(sh + lean) * 0.95 * H + 0.15 * H];
  const shoulderR: P = [neck[0] + Math.cos(sh + lean) * 0.95 * H, neck[1] + Math.sin(sh + lean) * 0.95 * H + 0.15 * H];
  const hipL: P = [pelvis[0] - Math.cos(hp) * 0.7 * H, pelvis[1] - Math.sin(hp) * 0.7 * H];
  const hipR: P = [pelvis[0] + Math.cos(hp) * 0.7 * H, pelvis[1] + Math.sin(hp) * 0.7 * H];
  out.push({ pts: [hipL, hipR, add(hipR, Math.PI + hp * 0.5, 0.55 * H), add(hipL, Math.PI + hp * 0.5, 0.55 * H)], closed: true, w: 1 });
  out.push({ pts: [shoulderL, shoulderR], w: 1 });
  out.push({ pts: [pelvis, add(pelvis, Math.PI + lean, 1.0 * H), chest, neck, headC], w: 2 });
  const limb = (root: P, [a, b]: [number, number], l1: number, l2: number, l3: number) => {
    const j = add(root, rad(a), l1);
    const e = add(j, rad(a + b), l2);
    const t = add(e, rad(a + b), l3);
    out.push({ pts: [root, j, e], w: 2 });
    out.push({ pts: [e, t], w: 1 });
    for (const p of [root, j, e]) out.push({ pts: [p], w: 1, dot: true });
  };
  limb(shoulderL, [P0.armL[0], P0.armL[1]], 1.5 * H, 1.3 * H, 0.75 * H);
  limb(shoulderR, [P0.armR[0], P0.armR[1]], 1.5 * H, 1.3 * H, 0.75 * H);
  limb(hipL, [P0.legL[0], P0.legL[1]], 2.0 * H, 2.0 * H, 0.35 * H);
  limb(hipR, [P0.legR[0], P0.legR[1]], 2.0 * H, 2.0 * H, 0.35 * H);
  return out;
}

/* ------------------------------------------------------------ visage */

function face(s: GuideSettings, w: number, h: number): GuidePath[] {
  const out: GuidePath[] = [];
  const H = Math.min(h * 0.82, w * 1.05);
  const cx = w / 2, top = (h - H) / 2;
  const r = H * 0.34; // rayon du crâne (méthode Loomis simplifiée)
  const cy = top + r;
  const yaw = s.yaw, pitch = s.pitch;
  out.push({ pts: ellipse(cx, cy, r, r), closed: true, w: 2 });
  // Côté du crâne : disque aplati déplacé avec la rotation.
  const sideX = cx - yaw * r * 0.55;
  out.push({ pts: ellipse(sideX, cy, r * 0.62 * (0.35 + 0.65 * Math.abs(yaw)), r * 0.62, 0), closed: true, w: 0 });
  // Lignes de latitude : arcs dont la courbure suit l'inclinaison.
  const lat = (y: number, half: number, wgt: 0 | 1 | 2) => {
    const pts: P[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = -1 + (2 * i) / 24;
      const x = cx + (t + yaw * 0.35) * half;
      pts.push([x, y + pitch * half * 0.35 * (1 - t * t)]);
    }
    out.push({ pts, w: wgt });
  };
  const brow = cy, nose = cy + r * 1.0, chin = cy + r * 1.95;
  // Mâchoire : de la tempe au menton, déportée avec la rotation.
  const jawShift = yaw * r * 0.3;
  const jaw: P[] = [];
  for (let i = 0; i <= 32; i++) {
    const t = (i / 32) * Math.PI;
    const x = cx + jawShift * Math.sin(t) + Math.cos(t) * r * (0.92 - 0.25 * Math.sin(t) * Math.sin(t));
    const y = brow + Math.sin(t) * (chin - brow);
    jaw.push([x, y]);
  }
  out.push({ pts: jaw, w: 2 });
  // Ligne médiane : courbe qui tourne avec le visage.
  const mid: P[] = [];
  for (let i = 0; i <= 32; i++) {
    const y = cy - r + (i / 32) * (chin - (cy - r));
    const k = Math.sqrt(Math.max(0, 1 - ((y - cy) / (chin - cy + r * 0.01)) ** 2));
    mid.push([cx + yaw * r * 0.85 * (y < chin ? Math.max(k, 0.25) : 0.25), y]);
  }
  out.push({ pts: mid, w: 1 });
  lat(cy - r * 0.55, r * 0.8, 0); // naissance des cheveux
  lat(brow, r, 1); // sourcils
  lat((brow + nose) / 2 + r * 0.05, r * 0.95, 1); // yeux
  lat(nose, r * 0.85, 1); // base du nez
  lat(nose + (chin - nose) * 0.38, r * 0.6, 0); // bouche
  lat(chin, r * 0.3, 0);
  // Places des yeux : un œil de largeur entre les deux.
  const ey = (brow + nose) / 2 + r * 0.05;
  const ew = r * 0.36;
  for (const sgn of [-1, 1]) {
    const ex = cx + yaw * r * 0.35 + sgn * ew * (1 - sgn * yaw * 0.3);
    out.push({ pts: ellipse(ex, ey + pitch * r * 0.3, ew * 0.5 * (1 - sgn * yaw * 0.35), ew * 0.22), closed: true, w: 0 });
  }
  // Oreilles : entre sourcils et base du nez, côté visible.
  const earX = sideX + (yaw >= 0 ? -1 : 1) * r * 0.05 * 0;
  out.push({ pts: ellipse(earX, (brow + nose) / 2, r * 0.13, (nose - brow) / 2), closed: true, w: 0 });
  return out;
}

/** Repères du guide pour un écran `w`×`h` (pixels), à travers `m` (cadre → écran). */
export function guidePaths(s: GuideSettings, w: number, h: number, m: GuideMap = IDENTITY, frame: { w: number; h: number } = { w, h }): GuidePath[] {
  const out: GuidePath[] = [];
  const fw = frame.w, fh = frame.h;
  const port = (paths: GuidePath[]) => paths.map((p) => ({ ...p, pts: p.pts.map(m.to) }));
  const lines: P[][] = [];
  const long = Math.hypot(fw, fh) * 6;
  switch (s.type) {
    case "grid": {
      const a = (s.rotation * Math.PI) / 180;
      family(a, s.spacing, s.subdiv, w, h, m, out);
      family(a + Math.PI / 2, s.spacing, s.subdiv, w, h, m, out);
      return out;
    }
    case "iso": {
      const a = (s.angle * Math.PI) / 180;
      family(0, s.spacing, s.subdiv, w, h, m, out);
      family(Math.PI / 2 + a, s.spacing, s.subdiv, w, h, m, out);
      family(Math.PI / 2 - a, s.spacing, s.subdiv, w, h, m, out);
      return out;
    }
    case "perspective1":
    case "perspective2":
    case "perspective3": {
      const hy = fh * s.horizon;
      const extra: GuidePath[] = [{ pts: [[-long, hy], [fw + long, hy]], w: 2 }];
      const vps: P[] = [[fw * s.vp1, hy]];
      if (s.type !== "perspective1") vps.push([fw * s.vp2, hy]);
      if (s.type === "perspective3") vps.push([fw * 0.5 * (s.vp1 + s.vp2), fh * s.vp3]);
      for (const v of vps) {
        rays(v[0], v[1], s.rays, long, lines);
        extra.push({ pts: [v], w: 2, dot: true });
      }
      // Une perspective à un point garde ses verticales et horizontales.
      if (s.type === "perspective1") {
        const n = Math.max(2, Math.round(s.rays / 3));
        for (let i = 1; i < n; i++) extra.push({ pts: [[(fw * i) / n, 0], [(fw * i) / n, fh]], w: 0 });
      }
      return [...port(lines.map((pts) => ({ pts, w: 0 as const }))), ...port(extra)];
    }
    case "thirds": {
      for (const t of [1 / 3, 2 / 3]) {
        out.push({ pts: [[fw * t, 0], [fw * t, fh]], w: 1 }, { pts: [[0, fh * t], [fw, fh * t]], w: 1 });
        for (const u of [1 / 3, 2 / 3]) out.push({ pts: [[fw * t, fh * u]], w: 2, dot: true });
      }
      out.push({ pts: [[0, 0], [fw, 0], [fw, fh], [0, fh]], closed: true, w: 0 });
      return port(out);
    }
    case "golden": {
      const g = 0.381966;
      for (const t of [g, 1 - g]) out.push({ pts: [[fw * t, 0], [fw * t, fh]], w: 1 }, { pts: [[0, fh * t], [fw, fh * t]], w: 1 });
      // Spirale d'or : quarts de cercle dans des carrés successifs.
      let x = 0, y = 0, ww = fw, hh = fh;
      const spiral: P[] = [];
      for (let i = 0; i < 9 && ww > 1 && hh > 1; i++) {
        const side = Math.min(ww, hh);
        const dirn = i % 4;
        let cxs = 0, cys = 0, a0 = 0;
        if (dirn === 0) { cxs = x + side; cys = y + side; a0 = Math.PI; x += side; ww -= side; }
        else if (dirn === 1) { cxs = x; cys = y + side; a0 = -Math.PI / 2; y += side; hh -= side; }
        else if (dirn === 2) { cxs = x + ww - side; cys = y + hh - side; a0 = 0; ww -= side; }
        else { cxs = x + side; cys = y + hh - side; a0 = Math.PI / 2; hh -= side; }
        spiral.push(...ellipse(cxs, cys, side, side, 0, a0, a0 + Math.PI / 2, 16));
      }
      out.push({ pts: spiral, w: 2 });
      return port(out);
    }
    case "diagonals": {
      out.push({ pts: [[0, 0], [fw, fh]], w: 1 }, { pts: [[fw, 0], [0, fh]], w: 1 });
      // Réciproques (symétrie dynamique) : perpendiculaires aux diagonales passant par les coins.
      const k = (fh * fh) / fw;
      out.push({ pts: [[0, fh], [Math.min(fw, k), 0]], w: 0 }, { pts: [[fw, fh], [Math.max(0, fw - k), 0]], w: 0 });
      out.push({ pts: [[0, 0], [Math.min(fw, k), fh]], w: 0 }, { pts: [[fw, 0], [Math.max(0, fw - k), fh]], w: 0 });
      out.push({ pts: [[fw / 2, 0], [fw / 2, fh]], w: 0 }, { pts: [[0, fh / 2], [fw, fh / 2]], w: 0 });
      return port(out);
    }
    case "radial": {
      const c: P = [fw / 2, fh / 2];
      rays(c[0], c[1], s.rays, long, lines);
      const R = Math.hypot(fw, fh) / 2;
      for (let r = s.spacing, i = 1; r < R && i < 80; r += s.spacing, i++) out.push({ pts: ellipse(c[0], c[1], r, r, 0, 0, Math.PI * 2, 64), closed: true, w: i % s.subdiv === 0 ? 1 : 0 });
      out.push({ pts: [c], w: 2, dot: true });
      return [...port(lines.map((pts, i) => ({ pts, w: (i % Math.max(1, Math.round(s.rays / 4)) === 0 ? 1 : 0) as 0 | 1 }))), ...port(out)];
    }
    case "face": return port(face(s, fw, fh));
    case "figure": return port(figure(s, fw, fh));
    default: return out;
  }
}
