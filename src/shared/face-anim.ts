/**
 * Visage d'une photo qui cligne et parle (calcul pur, sans DOM) : yeux et bouche repérés par les points du visage d'un
 * tracker de pose (`leftEye`, `leftEyeInner`, `leftEyeOuter`, `mouthLeft`, `mouthRight`…), en pixels de l'image.
 *
 * Le rendu (voir `drawFace`) retouche l'image elle-même, dans le repère de chaque œil ou de la bouche (tourné comme la tête) :
 * - clignement : la peau de la paupière, juste au-dessus de l'œil, est étirée vers le bas jusqu'à couvrir l'œil ;
 * - bouche : la lèvre inférieure et le menton descendent, l'intérieur de la bouche apparaît (ombre sombre).
 * Les retouches sont fondues sur les bords (masque elliptique dégradé) : pas de contour visible.
 */
import type { Joints, Pt } from "./puppet";

export type FeatureBox = {
  /** Centre (pixels de l'image). */
  cx: number;
  cy: number;
  /** Largeur de l'œil (coin à coin) ou de la bouche (commissure à commissure). */
  w: number;
  /** Angle de la ligne des yeux ou de la bouche (radians, sens horaire à l'écran ; 0 = horizontale). */
  angle: number;
};

export type Face = { eyes: FeatureBox[]; mouth: FeatureBox | null };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Yeux et bouche visibles ; `null` si rien n'est mesurable. */
export function measureFace(joints: Joints, w: number, h: number, minVisibility = 0.5): Face | null {
  const pt = (name: string): Pt | null => {
    const j = joints[name];
    if (!j || !Number.isFinite(j.x) || !Number.isFinite(j.y)) return null;
    if ((Number.isFinite(j.v) ? (j.v as number) : 1) < minVisibility) return null;
    if (j.x < 0 || j.x > 1 || j.y < 0 || j.y > 1) return null;
    return { x: j.x * w, y: j.y * h };
  };
  const le = pt("leftEye");
  const re = pt("rightEye");
  // Angle de la tête : ligne des yeux (de l'œil gauche de l'écran vers le droit), sinon ligne de la bouche.
  const ml = pt("mouthLeft");
  const mr = pt("mouthRight");
  const lineAngle = (a: Pt, b: Pt) => {
    const [l, r] = a.x <= b.x ? [a, b] : [b, a];
    return Math.atan2(r.y - l.y, r.x - l.x);
  };
  const headAngle = le && re ? lineAngle(le, re) : ml && mr ? lineAngle(ml, mr) : 0;
  const interEye = le && re ? dist(le, re) : 0;

  const eyes: FeatureBox[] = [];
  for (const side of ["left", "right"] as const) {
    const c = pt(`${side}Eye`);
    if (!c) continue;
    const inner = pt(`${side}EyeInner`);
    const outer = pt(`${side}EyeOuter`);
    // Le modèle de pose place les coins assez près du centre : on élargit un peu ; repli sur l'écart entre les yeux.
    let ew = inner && outer ? dist(inner, outer) * 1.15 : 0;
    if (interEye > 0) ew = ew > 0 ? Math.min(Math.max(ew, interEye * 0.32), interEye * 0.6) : interEye * 0.42;
    if (!(ew >= 4)) continue;
    eyes.push({ cx: c.x, cy: c.y, w: ew, angle: headAngle });
  }
  let mouth: FeatureBox | null = null;
  if (ml && mr && dist(ml, mr) >= 4) {
    mouth = { cx: (ml.x + mr.x) / 2, cy: (ml.y + mr.y) / 2, w: dist(ml, mr), angle: lineAngle(ml, mr) };
  }
  if (!eyes.length && !mouth) return null;
  return { eyes, mouth };
}

/** Rectangles (repère de l'œil : centre, axe x le long de l'œil, y vers le bas) de la paupière pour un clignement `k` (0..1). */
export function lidRects(eyeW: number, k: number): { src: [number, number, number, number]; dst: [number, number, number, number] } {
  const h = eyeW * 0.55;
  const top = -1.05 * h;
  const open = -0.45 * h; // bord de la paupière, œil ouvert
  const closed = 0.5 * h; // œil fermé
  const edge = open + (closed - open) * Math.max(0, Math.min(1, k));
  const half = eyeW * 0.7;
  return { src: [-half, top, 2 * half, open - top], dst: [-half, top, 2 * half, edge - top] };
}

/** Bouche ouverte de `k` (0..1) : hauteur de l'ouverture et zone (sous la ligne des lèvres) qui descend, repère de la bouche. */
export function mouthRects(mouthW: number, k: number): { gap: number; lower: [number, number, number, number] } {
  const gap = mouthW * 0.32 * Math.max(0, Math.min(1, k));
  const half = mouthW * 0.85;
  return { gap, lower: [-half, -mouthW * 0.04, 2 * half, mouthW * 0.95] };
}

/**
 * Clignements automatiques : `blinkAt(t)` vaut 0 (ouvert) à 1 (fermé), un clignement de `durMs` toutes les 2,5 à 5,5 s
 * (pseudo-aléatoire, reproductible pour une graine), parfois double.
 */
export function autoBlink(tMs: number, seed = 1, durMs = 170): number {
  let t = 0;
  let i = 0;
  const rnd = (n: number) => {
    const x = Math.sin((n + 1) * 12.9898 + seed * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  // Parcours des clignements jusqu'à tMs (au plus quelques milliers d'itérations sur des heures : borné).
  const start = Math.max(0, tMs - 12000);
  while (t < start && i < 100000) t += 2500 + rnd(i++) * 3000;
  while (i < 100000) {
    const at = t;
    if (tMs < at) return 0;
    const u = (tMs - at) / durMs;
    if (u < 1) return Math.sin(u * Math.PI);
    if (rnd(i + 5000) < 0.18) {
      const u2 = (tMs - at - durMs * 1.6) / durMs;
      if (u2 >= 0 && u2 < 1) return Math.sin(u2 * Math.PI);
    }
    t += 2500 + rnd(i++) * 3000;
  }
  return 0;
}

type Ctx = CanvasRenderingContext2D;
type MakeLayer = (name: string, w: number, h: number) => { canvas: HTMLCanvasElement; ctx: Ctx } | null;

/** Recopie dans `layer` (carré `size`) l'image `base` vue dans le repère de `box` (centre au milieu, tourné). */
function aligned(base: HTMLCanvasElement, box: FeatureBox, size: number, layer: { canvas: HTMLCanvasElement; ctx: Ctx }): void {
  const c = layer.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, size, size);
  c.translate(size / 2, size / 2);
  c.rotate(-box.angle);
  c.translate(-box.cx, -box.cy);
  c.drawImage(base, 0, 0);
  c.setTransform(1, 0, 0, 1, 0, 0);
}

/** Masque elliptique fondu (alpha) appliqué à `layer` : `rx`, `ry` autour de (`x`, `y`) du calque. */
function feather(layer: { ctx: Ctx }, x: number, y: number, rx: number, ry: number): void {
  const c = layer.ctx;
  c.save();
  c.globalCompositeOperation = "destination-in";
  c.translate(x, y);
  c.scale(1, ry / rx);
  const g = c.createRadialGradient(0, 0, rx * 0.55, 0, 0, rx);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g;
  c.fillRect(-rx, -rx, 2 * rx, 2 * rx);
  c.restore();
}

/** Pose `layer` (repère de `box`) sur `out`, à sa place dans l'image. */
function place(out: Ctx, layer: HTMLCanvasElement, box: FeatureBox, size: number): void {
  out.save();
  out.translate(box.cx, box.cy);
  out.rotate(box.angle);
  out.drawImage(layer, -size / 2, -size / 2);
  out.restore();
}

/**
 * Dessine `base` dans `out` (même taille) avec les yeux fermés de `blink` et la bouche ouverte de `mouth` (0..1).
 * `layer` fournit des canvas de travail réutilisés.
 */
export function drawFace(out: Ctx, base: HTMLCanvasElement, face: Face, blink: number, mouth: number, layer: MakeLayer): void {
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.clearRect(0, 0, base.width, base.height);
  out.drawImage(base, 0, 0);
  if (blink > 0.02) {
    for (const eye of face.eyes) {
      const size = Math.ceil(eye.w * 3);
      const src = layer("eyeSrc", size, size);
      const lid = layer("eyeLid", size, size);
      if (!src || !lid) continue;
      aligned(base, eye, size, src);
      const { src: s, dst: d } = lidRects(eye.w, blink);
      const o = size / 2;
      lid.ctx.setTransform(1, 0, 0, 1, 0, 0);
      lid.ctx.clearRect(0, 0, size, size);
      lid.ctx.drawImage(src.canvas, o + s[0], o + s[1], s[2], s[3], o + d[0], o + d[1], d[2], d[3]);
      // Ligne de cils, quand l'œil est presque fermé.
      if (blink > 0.55) {
        lid.ctx.fillStyle = `rgba(35,22,20,${(0.45 * (blink - 0.55)) / 0.45})`;
        lid.ctx.fillRect(o + d[0] + d[2] * 0.12, o + d[1] + d[3] - eye.w * 0.035, d[2] * 0.76, eye.w * 0.05);
      }
      feather(lid, o, o + (d[1] + d[3] / 2) * 0.6, eye.w * 0.72, Math.max(eye.w * 0.42, d[3] * 0.62));
      place(out, lid.canvas, eye, size);
    }
  }
  const m = face.mouth;
  if (m && mouth > 0.02) {
    const size = Math.ceil(m.w * 3.2);
    const src = layer("mouthSrc", size, size);
    const low = layer("mouthLow", size, size);
    if (src && low) {
      aligned(base, m, size, src);
      const o = size / 2;
      const { gap, lower } = mouthRects(m.w, mouth);
      const c = low.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, size, size);
      // Intérieur de la bouche, puis lèvre inférieure et menton descendus de `gap`.
      c.fillStyle = "rgb(48,16,18)";
      c.beginPath();
      c.ellipse(o, o + gap * 0.45, m.w * 0.42, Math.max(1, gap * 0.62), 0, 0, Math.PI * 2);
      c.fill();
      c.drawImage(src.canvas, o + lower[0], o + lower[1], lower[2], lower[3], o + lower[0], o + lower[1] + gap, lower[2], lower[3]);
      feather(low, o, o + m.w * 0.35, m.w * 0.95, m.w * 0.75 + gap);
      place(out, low.canvas, m, size);
    }
  }
}
