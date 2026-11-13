/**
 * Deux manières, choisies par `style` :
 *
 * - `realiste` : l'image est reconstruite par touches posées (une empreinte par trait), comme à l'aérographe :
 *   touches régulières qui se recouvrent, du très gros au moyen (reconstruction lisse), glacis en Produit et en
 *   Écran, puis touches de plus en plus fines seulement là où l'écart reste fort. Chaque touche est douce là où
 *   l'image est floue et nette là où elle est nette, ronde, ou ovale et orientée le long des arêtes. On ne voit pas
 *   le pinceau : le résultat est proche de l'image (photo, rendu), et reste un dessin retouchable touche à touche.
 * - `illustration` : peinture « en illustrateur » (ci-dessous).
 *
 * Peinture d'une image « en illustrateur » : au lieu d'accumuler des milliers de touches opaques, l'image est
 * construite en passes qui ont chacune un rôle et un outil, comme le ferait un peintre numérique :
 *
 * 1. fond (imprimature) ;
 * 2. masses : grandes zones posées au pinceau plat, du très gros au moyen ;
 * 3. ombres : glacis doux en mode Produit (multiply), là où la toile est plus claire que l'image ;
 * 4. lumières : glacis doux en mode Écran (screen), là où elle est plus sombre ;
 * 5. couleur : voiles translucides là où la teinte s'écarte encore ;
 * 6. matière : pointe « craie » dispersée sur les zones texturées ;
 * 7. détails : quelques touches fines et opaques, seulement là où l'écart reste fort ;
 * 8. contours : traits fins effilés, en Produit, sur les arêtes nettes ;
 * 9. accents : petites touches dures en Écran sur les reflets.
 *
 * La toile est simulée avec les mêmes modes de fusion que `sonic-sketch` (un trait = ses empreintes réunies,
 * fusionnées en bloc avec son opacité) : chaque passe corrige ce que les précédentes ont laissé. Traits tracés le
 * long des formes (orientation du tenseur de structure). Fonction pure, utilisable dans le navigateur et dans Node.
 */
import { blurImg, hex, rng, toFloat, type Img, type PainterlyOptions, type PainterlyResult, type PaintSource } from "./painterly";

type Blend = "normal" | "multiply" | "screen";
type Brush = {
  size: number; hardness: number; opacity: number; blend: Blend; spacing: number;
  tip?: string; roundness?: number; angle?: number; angleFollow?: boolean; angleJitter?: number; sizeJitter?: number; scatter?: number;
};

/** Pointe carrée (aplats du fond). */
const SQUARE = "M0,0 L100,0 L100,100 L0,100 Z";

/** Pointe « craie » d'Abysse (polygone irrégulier). */
const CHALK = "M10,30 L35,5 L70,12 L95,40 L88,75 L60,95 L25,88 L5,62 Z";

/** Nombre de traits par défaut de chaque manière : peu de coups de pinceau, chacun utile. */
export const STROKES_DEFAULT = { realiste: 5000, illustration: 3000, huile: 12000 } as const;

/** Direction de touche par défaut (légère diagonale montante). */
const DEF_X = Math.cos(-0.4), DEF_Y = Math.sin(-0.4);

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function illustrateImage(src: PaintSource, opts: PainterlyOptions = {}): PainterlyResult {
  const detail = clamp01(opts.detail ?? 0.6);
  const im = toFloat(src, Math.max(48, Math.min(1200, opts.maxSide ?? 360)));
  const { w, h } = im;
  const N = w * h;
  const side = Math.max(w, h);
  const rand = rng(opts.seed ?? 7);
  const maxStrokes = Math.max(1, Math.min(20000, opts.maxStrokes ?? (opts.style === "realiste" ? STROKES_DEFAULT.realiste : STROKES_DEFAULT.illustration)));
  const scale = (opts.frame ?? 1000) / side;

  // ---------------------------------------------------------------- toile simulée
  const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
  const L0 = new Float32Array(N);
  for (let i = 0; i < N; i++) L0[i] = lum(im.r[i], im.g[i], im.b[i]);
  // Réaliste : touches fondues, dureté prise sur la netteté de l'image (net là où elle est nette, flou ailleurs),
  // ni contours dessinés ni texture de pointe : on ne doit pas voir le pinceau.
  const real = opts.style === "realiste";
  const sharp = (() => {
    const Ls = blurImg({ w, h, r: L0, g: L0, b: L0 }, 0.7).r;
    const m = new Float32Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      m[i] = Math.min(1, Math.hypot(Ls[i + 1] - Ls[i - 1], Ls[i + w] - Ls[i - w]) / 0.12);
    }
    return blurImg({ w, h, r: m, g: m, b: m }, 1.5).r;
  })();

  /**
   * Distance (en pixels d'analyse) à l'arête nette la plus proche (transformée de distance en chanfrein) : une
   * grosse touche douce posée à cheval sur une arête y laisserait un halo ; près d'une arête, on prend un pinceau
   * plus petit, comme un peintre.
   */
  const edgeDist = (() => {
    // Arêtes des formes (pas de la texture) : gradient d'une image adoucie, seuil haut.
    const Lb = blurImg({ w, h, r: L0, g: L0, b: L0 }, Math.max(1.5, side / 200)).r;
    const d = new Float32Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      d[i] = Math.hypot(Lb[i + 1] - Lb[i - 1], Lb[i + w] - Lb[i - w]) > 0.07 ? 0 : 1e6;
    }
    for (let x = 0; x < w; x++) { d[x] = 1e6; d[(h - 1) * w + x] = 1e6; }
    for (let y = 0; y < h; y++) { d[y * w] = 1e6; d[y * w + w - 1] = 1e6; }
    const D1 = 1, D2 = 1.414;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + D1);
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - w] + D1);
        if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + D2);
        if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + D2);
      }
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + D1);
      if (y < h - 1) {
        d[i] = Math.min(d[i], d[i + w] + D1);
        if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + D2);
        if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + D2);
      }
    }
    return d;
  })();

  /**
   * Point focal : où l'œil va (contraste local, couleur qui se distingue du reste, plutôt vers le centre, ou la
   * zone `focus` indiquée). Les touches fines et l'ajustement y portent leur effort ; le reste reste plus lâche.
   * Poids 0.25 (fond) à 1 (point focal).
   */
  const focal = (() => {
    const sb = blurImg({ w, h, r: sharp, g: sharp, b: sharp }, side / 40).r;
    const cb0 = blurImg(im, side / 30);
    let mr0 = 0, mg0 = 0, mb0 = 0;
    for (let i = 0; i < N; i++) { mr0 += cb0.r[i]; mg0 += cb0.g[i]; mb0 += cb0.b[i]; }
    mr0 /= N; mg0 /= N; mb0 /= N;
    const sal = new Float32Array(N);
    let sMax = 1e-6, dMax = 1e-6;
    const dist = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      dist[i] = Math.hypot(cb0.r[i] - mr0, cb0.g[i] - mg0, cb0.b[i] - mb0);
      if (sb[i] > sMax) sMax = sb[i];
      if (dist[i] > dMax) dMax = dist[i];
    }
    const f = opts.focus;
    const fx = f ? f.x * w : w / 2, fy = f ? f.y * h : h / 2, fr = (f ? Math.max(0.05, f.r ?? 0.25) : 0.6) * side;
    let m = 1e-6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const near = Math.exp(-((x - fx) ** 2 + (y - fy) ** 2) / (2 * fr * fr));
      let v = (0.6 * sb[i] / sMax + 0.4 * dist[i] / dMax) * (f ? 0.35 + 0.65 * near : 0.6 + 0.4 * near);
      if (f) v = Math.max(v, near);
      sal[i] = v;
      if (v > m) m = v;
    }
    const s = blurImg({ w, h, r: sal, g: sal, b: sal }, side / 60).r;
    let sm = 1e-6;
    for (let i = 0; i < N; i++) if (s[i] > sm) sm = s[i];
    for (let i = 0; i < N; i++) s[i] = 0.25 + 0.75 * Math.min(1, s[i] / sm);
    void m;
    return s;
  })();

  // Tenseur de structure de l'image (orientation des formes), à une échelle donnée.
  const orient = (sigma: number) => {
    const Lb = blurImg({ w, h, r: L0, g: L0, b: L0 }, Math.max(0.5, sigma * 0.5)).r;
    const jxx = new Float32Array(N), jyy = new Float32Array(N), jxy = new Float32Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Lb[i + 1] - Lb[i - 1], gy = Lb[i + w] - Lb[i - w];
      jxx[i] = gx * gx; jyy[i] = gy * gy; jxy[i] = gx * gy;
    }
    const s = Math.max(1, sigma);
    const t = blurImg({ w, h, r: jxx, g: jyy, b: jxy }, s);
    const dx = new Float32Array(N), dy = new Float32Array(N), coh = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = t.r[i], c = t.g[i], b = t.b[i];
      // Direction de moindre variation (le long des isophotes).
      const th = 0.5 * Math.atan2(2 * b, a - c) + Math.PI / 2;
      const l1 = (a + c) / 2 + Math.sqrt(((a - c) / 2) ** 2 + b * b), l2 = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
      coh[i] = l1 + l2 > 1e-9 ? (l1 - l2) / (l1 + l2) : 0;
      // Zones sans forme nette (fonds, flous) : une direction de touche constante, comme un peintre.
      const k = Math.min(1, coh[i] * 3 * Math.min(1, (l1 + l2) * 4000));
      let ux = Math.cos(th), uy = Math.sin(th);
      if (ux * DEF_X + uy * DEF_Y < 0) { ux = -ux; uy = -uy; }
      const vx = k * ux + (1 - k) * DEF_X, vy = k * uy + (1 - k) * DEF_Y, m = Math.hypot(vx, vy) || 1;
      dx[i] = vx / m; dy[i] = vy / m;
    }
    return { dx, dy, coh };
  };

  const at = (x: number, y: number) => Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)));

  // ---------------------------------------------------------------- émission et simulation d'un trait
  const out: Record<string, unknown>[] = [];
  type Box = [number, number, number, number];
  /** Trait enregistré ; `under` : la toile sous lui juste avant qu'il soit posé (zone `ubox`), pour l'ajustement. */
  type Rec = { pts: number[]; R: number; color: [number, number, number]; b: Brush; extra: Record<string, unknown>; box: Box; under?: Float32Array; ubox?: Box };
  const recs: Rec[] = [];
  const passes: { radius: number; strokes: number; name?: string }[] = [];
  let held: Record<string, unknown> = {};
  const emit = (brush: Record<string, unknown>, pts: number[]) => {
    const s: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(brush)) if (held[k] !== v) s[k] = v;
    held = { ...held, ...brush };
    s.pts = pts;
    out.push(s);
  };
  const full = () => recs.length >= maxStrokes;

  /** Couverture (0..1) d'un trait : capsules à rayon modulé par la pression, bord adouci selon la dureté. */
  const boxOf = (pts: number[], R: number, b: Brush): [number, number, number, number] => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < pts.length; k += 3) { x0 = Math.min(x0, pts[k]); y0 = Math.min(y0, pts[k + 1]); x1 = Math.max(x1, pts[k]); y1 = Math.max(y1, pts[k + 1]); }
    const reach = R * (1 + (b.scatter ?? 0)) * (b.tip === SQUARE ? 1.42 : 1);
    return [Math.max(0, Math.floor(x0 - reach)), Math.max(0, Math.floor(y0 - reach)), Math.min(w - 1, Math.ceil(x1 + reach)), Math.min(h - 1, Math.ceil(y1 + reach))];
  };
  /**
   * Pose un trait sur une toile (`C`, par défaut la toile simulée) ; `clip` limite la zone recalculée, `C` peut
   * être un morceau de toile commençant en (`ox`, `oy`) de largeur `cw`.
   */
  const paint = (pts: number[], R: number, color: [number, number, number], b: Brush,
    C: { r: Float32Array; g: Float32Array; b: Float32Array; ox: number; oy: number; cw: number } = { r: cr, g: cg, b: cb, ox: 0, oy: 0, cw: w },
    clip?: [number, number, number, number]) => {
    const reach = R * (1 + (b.scatter ?? 0));
    let [X0, Y0, X1, Y1] = boxOf(pts, R, b);
    if (clip) { X0 = Math.max(X0, clip[0]); Y0 = Math.max(Y0, clip[1]); X1 = Math.min(X1, clip[2]); Y1 = Math.min(Y1, clip[3]); }
    const pr = C.r, pg = C.g, pb = C.b;
    const segs = pts.length / 3;
    const hard = b.hardness;
    // Pointes texturées et dispersion : couverture partielle.
    const texture = (b.tip && b.tip !== SQUARE) || (b.scatter ?? 0) > 0 ? 0.55 : 1;
    const square = b.tip === SQUARE;
    const a = b.opacity * texture;
    const overlap = pts.length === 3 ? 1 : Math.max(1, 0.65 / Math.max(0.05, b.spacing));
    const [r, g, bl] = color;
    // Empreinte unique (touche posée) : ellipse orientée, comme la pointe ronde écrasée et tournée du rendu.
    const single = segs === 1 ? { c: Math.cos(((b.angle ?? 0) * Math.PI) / 180), s: Math.sin(((b.angle ?? 0) * Math.PI) / 180), q: b.roundness ?? 1, r: reach * (0.2 + 0.8 * pts[2]) } : null;
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      let best = 0;
      if (single) {
        const ddx = x - pts[0], ddy = y - pts[1];
        const u = (ddx * single.c + ddy * single.s) / Math.max(0.3, single.r * single.q), v = (-ddx * single.s + ddy * single.c) / Math.max(0.3, single.r);
        const d = square ? Math.max(Math.abs(u), Math.abs(v)) : Math.sqrt(u * u + v * v);
        best = d <= hard ? 1 : d >= 1 ? 0 : (1 - d) / (1 - hard);
      } else for (let s = 0; s < segs; s++) {
        const ax = pts[s * 3], ay = pts[s * 3 + 1], ap = pts[s * 3 + 2];
        const last = s + 1 >= segs;
        const bx = last ? ax : pts[s * 3 + 3], by = last ? ay : pts[s * 3 + 4], bp = last ? ap : pts[s * 3 + 5];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const rr = reach * (0.2 + 0.8 * (ap + (bp - ap) * t));
        const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) / Math.max(0.5, rr);
        const c = d <= hard ? 1 : d >= 1 ? 0 : (1 - d) / (1 - hard);
        if (c > best) best = c;
        if (best >= 1) break;
      }
      if (best <= 0) continue;
      const i = (y - C.oy) * C.cw + (x - C.ox);
      // Empreintes qui se chevauchent : leurs couvertures s'accumulent (bord doux plus étroit qu'une seule).
      const k = (1 - Math.pow(1 - Math.min(0.999, best), overlap)) * a;
      let tr: number, tg: number, tb: number;
      if (b.blend === "multiply") { tr = pr[i] * r; tg = pg[i] * g; tb = pb[i] * bl; }
      else if (b.blend === "screen") { tr = 1 - (1 - pr[i]) * (1 - r); tg = 1 - (1 - pg[i]) * (1 - g); tb = 1 - (1 - pb[i]) * (1 - bl); }
      else { tr = r; tg = g; tb = bl; }
      pr[i] += (tr - pr[i]) * k; pg[i] += (tg - pg[i]) * k; pb[i] += (tb - pb[i]) * k;
    }
  };

  /** Trait émis dans le cadre des gestes ; `b` complet à chaque fois (seuls les changements sont écrits). */
  let keepUnder = false;
  const stroke = (raw: number[], R: number, color: [number, number, number], b: Brush, extra: Record<string, unknown> = {}, spill = 0) => {
    // Bords nets : près du cadre, la pression (donc la taille) baisse pour que la touche ne déborde pas (au plus
    // `spill` × le rayon pour une touche douce, dont le bord est presque transparent).
    const reach = R * (1 + (b.scatter ?? 0)) * (1 - spill);
    const pts = raw.slice();
    for (let k = 0; k < pts.length; k += 3) {
      // Centre gardé à 0,6 rayon du bord : la touche y garde au moins la moitié de sa taille (pas de chapelet de
      // points minuscules le long du cadre).
      const m = 0.6 * reach;
      pts[k] = Math.min(w - 1 - m, Math.max(m, pts[k]));
      pts[k + 1] = Math.min(h - 1 - m, Math.max(m, pts[k + 1]));
      const d = Math.min(pts[k], pts[k + 1], w - 1 - pts[k], h - 1 - pts[k + 1]) + 0.5;
      const pMax = Math.max(0, Math.min(1, (d / reach - 0.2) / 0.8));
      if (pts[k + 2] > pMax) pts[k + 2] = Math.round(pMax * 100) / 100;
    }
    const rec: Rec = { pts, R, color, b, extra, box: boxOf(pts, R, b) };
    if (keepUnder && pts.length === 3 && R <= side / 34) {
      // Zone un peu plus large que la touche : les essais de déplacement et d'agrandissement y tiennent.
      const m = Math.ceil(R * 0.6) + 1;
      const ub: Box = [Math.max(0, rec.box[0] - m), Math.max(0, rec.box[1] - m), Math.min(w - 1, rec.box[2] + m), Math.min(h - 1, rec.box[3] + m)];
      const cw = ub[2] - ub[0] + 1, n = cw * (ub[3] - ub[1] + 1);
      const u = new Float32Array(n * 3);
      for (let y = ub[1]; y <= ub[3]; y++) for (let x = ub[0]; x <= ub[2]; x++) {
        const i = y * w + x, j = ((y - ub[1]) * cw + (x - ub[0])) * 3;
        u[j] = cr[i]; u[j + 1] = cg[i]; u[j + 2] = cb[i];
      }
      rec.under = u; rec.ubox = ub;
    }
    paint(pts, R, color, b);
    recs.push(rec);
  };
  /** Écrit un trait enregistré dans le jeu de gestes (cadre des gestes, réglages qui changent seulement). */
  const emitRec = ({ pts, R, color, b, extra }: Rec) => {
    const fp: number[] = [];
    for (let k = 0; k < pts.length; k += 3) fp.push(Math.round(pts[k] * scale * 10) / 10, Math.round(pts[k + 1] * scale * 10) / 10, Math.round(pts[k + 2] * 100) / 100);
    emit({
      tool: "paint",
      ...extra,
      color: hex(color[0], color[1], color[2]), size: Math.max(0.6, Math.round(2 * R * scale * 10) / 10),
      hardness: Math.round(b.hardness * 100) / 100, opacity: Math.round(b.opacity * 100) / 100, blend: b.blend,
      spacing: b.spacing, tip: b.tip ?? "", roundness: b.roundness ?? 1, angle: b.angle ?? 0, angleFollow: b.angleFollow ?? false,
      angleJitter: b.angleJitter ?? 0, sizeJitter: b.sizeJitter ?? 0, scatter: b.scatter ?? 0,
    }, fp);
  };

  /**
   * Trace un trait depuis (x, y) le long des formes, dans les deux sens, tant que `ok(i)` et sans virage brusque.
   * Retourne les points [x, y, pression…] avec des extrémités effilées.
   */
  const trace = (x: number, y: number, R: number, maxLen: number, field: { dx: Float32Array; dy: Float32Array }, ok: (i: number) => boolean) => {
    const walk = (sx: number, sy: number, sgn: number) => {
      const pts: [number, number][] = [];
      let px = sx, py = sy, vx = 0, vy = 0;
      for (let k = 0; k < maxLen; k++) {
        const i = at(px, py);
        let nx = field.dx[i] * sgn, ny = field.dy[i] * sgn;
        if (k === 0) { vx = nx; vy = ny; }
        if (nx * vx + ny * vy < 0) { nx = -nx; ny = -ny; }
        if (nx * vx + ny * vy < 0.5) break; // virage trop serré
        // inertie : le trait garde sa courbe
        nx = 0.5 * vx + 0.5 * nx; ny = 0.5 * vy + 0.5 * ny;
        const m = Math.hypot(nx, ny) || 1;
        nx /= m; ny /= m;
        const qx = px + nx * R * 0.9, qy = py + ny * R * 0.9;
        if (qx < 0 || qy < 0 || qx > w - 1 || qy > h - 1 || !ok(at(qx, qy))) break;
        px = qx; py = qy; vx = nx; vy = ny;
        pts.push([px, py]);
      }
      return pts;
    };
    const fwd = walk(x, y, 1), back = walk(x, y, -1);
    const all = [...back.reverse(), [x, y] as [number, number], ...fwd];
    const n = all.length;
    const pts: number[] = [];
    all.forEach(([px, py], k) => {
      const t = n > 1 ? k / (n - 1) : 0.5;
      const p = n > 1 ? 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, Math.max(0, t))) : 0.9;
      pts.push(px, py, Math.round(p * 100) / 100);
    });
    return pts;
  };

  const avgAlong = (pts: number[], f: (i: number) => [number, number, number]): [number, number, number] => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = 0; k < pts.length; k += 3) { const c = f(at(pts[k], pts[k + 1])); r += c[0]; g += c[1]; b += c[2]; n++; }
    return [r / n, g / n, b / n];
  };

  /** Cellules d'une grille triées par besoin décroissant (seuil `T`), à revérifier avant chaque trait. */
  const cells = (step: number, need: (i: number) => number, T: number) => {
    const list: { i: number; e: number }[] = [];
    for (let gy = 0; gy < h; gy += step) for (let gx = 0; gx < w; gx += step) {
      let sum = 0, cnt = 0, worst = -1, wi = 0;
      for (let y = gy; y < Math.min(h, gy + step); y++) for (let x = gx; x < Math.min(w, gx + step); x++) {
        const i = y * w + x, e = need(i);
        sum += e; cnt++;
        if (e > worst) { worst = e; wi = i; }
      }
      if (cnt && sum / cnt > T) list.push({ i: wi, e: sum / cnt });
    }
    // Ordre : du plus besoin au moins, avec un peu de hasard (touches posées à la main).
    list.sort((a, b) => b.e * (0.85 + 0.3 * rand()) - a.e * (0.85 + 0.3 * rand()));
    return list;
  };

  // Parts de chaque passe sur un budget de base (au plus 4000 traits) ; `maxStrokes` reste le plafond absolu.
  const base = Math.min(maxStrokes, 4000);
  const budget = (share: number) => Math.max(1, Math.round(base * share));
  /** Dureté d'un trait selon la netteté de l'image sous lui. */
  const hardAt = (pts: number[], lo = 0.12, hi = 0.85) => {
    let s = 0, n = 0;
    for (let k = 0; k < pts.length; k += 3) { s += sharp[at(pts[k], pts[k + 1])]; n++; }
    return Math.round((lo + (hi - lo) * Math.min(1, (s / Math.max(1, n)) * 1.4)) * 100) / 100;
  };

  // ---------------------------------------------------------------- 1. fond
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < N; i++) { mr += im.r[i]; mg += im.g[i]; mb += im.b[i]; }
  mr /= N; mg /= N; mb /= N;
  const bgm = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(opts.background ?? "");
  if (bgm) { mr = parseInt(bgm[1], 16) / 255; mg = parseInt(bgm[2], 16) / 255; mb = parseInt(bgm[3], 16) / 255; }
  cr.fill(mr); cg.fill(mg); cb.fill(mb);
  {
    // Imprimature en aplats : des tuiles carrées jointives (pointe carrée, une empreinte), chacune de la couleur
    // moyenne de l'image sous elle. Bords du cadre nets, et des bords déjà dans le bon ton.
    const nx = Math.max(1, Math.round(w / (Math.min(w, h) / 6))), ny = Math.max(1, Math.round(h / (Math.min(w, h) / 6)));
    const tw = w / nx, th = h / ny;
    const soft0 = blurImg(im, Math.min(tw, th) * 0.6);
    // Les réglages communs vont avec le premier trait.
    const common = { reset: true, tool: "paint", pressure: true, angle: 0, angleFollow: false, tremble: 0 };
    for (let j = 0; j < ny; j++) for (let k = 0; k < nx; k++) {
      // Ton de l'image très adoucie au centre de la tuile : des tuiles voisines proches, pas de joint visible.
      const i0 = at((k + 0.5) * tw, (j + 0.5) * th);
      const c: [number, number, number] = bgm ? [mr, mg, mb] : [soft0.r[i0], soft0.g[i0], soft0.b[i0]];
      // Tuiles un peu plus grandes que la grille (pas de joint visible), celles du bord rentrées d'autant (pas de
      // débord hors du cadre).
      const R = (th * 1.1) / 2, ex = tw * 0.05, ey = th * 0.05;
      const cx = (k + 0.5) * tw + (k === 0 ? ex : k === nx - 1 ? -ex : 0), cy = (j + 0.5) * th + (j === 0 ? ey : j === ny - 1 ? -ey : 0);
      stroke([nx === 1 ? w / 2 : cx, ny === 1 ? h / 2 : cy, 1], R, c, {
        size: 2 * R, hardness: 1, opacity: 1, blend: "normal", spacing: 0.25, tip: SQUARE, roundness: Math.round((tw / th) * 1000) / 1000, angle: 0,
      }, recs.length ? {} : common, 1);
    }
    passes.push({ radius: Math.round(th * scale), strokes: recs.length, name: "fond" });
  }
  // Toile après le fond : point de départ des recalculs locaux de l'ajustement.
  const nFond = recs.length;
  const baseR = cr.slice(), baseG = cg.slice(), baseB = cb.slice();
  keepUnder = real && (opts.optimizeMs ?? 4000) > 0;

  /**
   * Touches posées (réaliste) : une empreinte par trait, ronde, ou ovale orientée le long des arêtes nettes ;
   * douce là où l'image est floue, nette là où elle est nette. `grid` : toute la toile en touches régulières qui se
   * recouvrent (reconstruction lisse de l'image à cette échelle) ; sinon seulement là où l'écart dépasse le seuil.
   * Modes Produit / Écran : la couleur est celle qui, à cette opacité, amène la toile sur l'image (glacis).
   * Aucun tracé visible : les touches se fondent comme des projections d'aérographe.
   */
  const splat = (radii: number[], shares: number[] | ((li: number) => number), alpha: number, name: string, mode: Blend = "normal", grid = false) => {
    radii.forEach((R, li) => {
      const ref = blurImg(im, Math.max(0.4, R * 0.45));
      const field = orient(Math.max(1, R * 0.8));
      // Petites touches : réservées aux endroits nets (une petite touche dans un flou se verrait en tache).
      const fineK = !grid && R < side / 45;
      const need = mode === "normal"
        ? (i: number) => Math.hypot(ref.r[i] - cr[i], ref.g[i] - cg[i], ref.b[i] - cb[i]) * (fineK ? 0.3 + 0.7 * Math.min(1, sharp[i] * 1.5) : 1) * (grid ? 1 : focal[i])
        : (i: number) => {
          const t = lum(ref.r[i], ref.g[i], ref.b[i]), c = lum(cr[i], cg[i], cb[i]);
          return mode === "multiply" ? c - t : t - c;
        };
      const T = grid ? 0.012 : (0.03 + 0.035 * (1 - detail)) * (1 + 0.5 * (li / Math.max(1, radii.length - 1)));
      const step = Math.max(1, Math.round(R * (grid ? 0.7 : 0.8)));
      const list = cells(step, need, T);
      const cap = typeof shares === "function" ? shares(li) : budget(shares[li]);
      let n = 0;
      for (const c of list) {
        if (n >= cap || full()) break;
        if (need(c.i) < T) continue;
        // En grille : centre de cellule (avec un peu de jeu) ; sinon le point le plus faux.
        let x = c.i % w, y = Math.floor(c.i / w);
        if (grid) { x = Math.floor(x / step) * step + step / 2 + (rand() - 0.5) * 0.5 * step; y = Math.floor(y / step) * step + step / 2 + (rand() - 0.5) * 0.5 * step; }
        x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y));
        const i = at(x, y);
        const sh = sharp[i];
        const coh = field.coh[i];
        const q = coh > 0.3 && sh > 0.25 ? Math.max(0.35, 1 - 0.7 * coh) : 1;
        const angle = Math.round((Math.atan2(-field.dx[i], field.dy[i]) * 180) / Math.PI);
        const ch = (t: number, cv: number) => mode === "multiply"
          ? clamp01(1 - (1 - Math.min(1, t / Math.max(0.02, cv))) / alpha)
          : mode === "screen" ? clamp01(Math.max(0, t - cv) / (alpha * Math.max(0.02, 1 - cv))) : t;
        const color: [number, number, number] = [ch(ref.r[i], cr[i]), ch(ref.g[i], cg[i]), ch(ref.b[i], cb[i])];
        // Matière fine et orientée (herbe, poils, laine, fibres) : une touche filée le long du fil couvre ce que
        // dix touches posées rendraient mal ; elle s'arrête quand la couleur change.
        if (!grid && mode === "normal" && R <= side / 140 && coh > 0.45 && sh > 0.3) {
          const c0 = color;
          const pts = trace(x, y, R, 9, field, (j) => Math.hypot(ref.r[j] - c0[0], ref.g[j] - c0[1], ref.b[j] - c0[2]) < 0.09);
          if (pts.length >= 9) {
            stroke(pts, R, avgAlong(pts, (j) => [ref.r[j], ref.g[j], ref.b[j]]), {
              size: 2 * R, hardness: Math.round((0.3 + 0.6 * Math.min(1, sh * 1.3)) * 100) / 100, opacity: Math.min(1, alpha + 0.15), blend: "normal", spacing: 0.25,
            }, {}, 0);
            n++;
            continue;
          }
        }
        // Près d'une arête nette, pinceau plus petit (pas de halo de part et d'autre).
        // (La première grille garde sa taille : elle fond les tuiles du fond entre elles.)
        const Re = grid && li === 0 ? R : Math.max(Math.min(R, 1.2), Math.min(R, Math.max(R * (grid ? 0.55 : 0.4), edgeDist[i] * 1.3 + 1)));
        stroke([x, y, 1], Re, color, {
          size: 2 * Re, hardness: Math.round((0.04 + 0.8 * Math.min(1, sh * 1.3)) * (grid ? 0.5 : 1) * 100) / 100, opacity: alpha, blend: mode,
          spacing: 0.25, roundness: Math.round(q * 100) / 100, angle,
        }, {}, 0);
        n++;
      }
      passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name });
    });
  };
  if (real) {
    // Budget : la base lisse d'abord (complète, sinon il resterait des trous), puis glacis et détails se partagent
    // ce qui reste, les plus grosses touches servies d'abord, les plus fines prennent le reste là où l'écart est fort.
    const left = () => Math.max(0, maxStrokes - recs.length);
    const gridR = [side / 8, side / 13, side / 21];
    // Base plus grosse quand le budget est serré : elle doit tenir dans un tiers du budget.
    const gridCount = (k: number) => gridR.slice(0, k).reduce((a, r) => a + Math.ceil(w / (r * 0.7)) * Math.ceil(h / (r * 0.7)), 0);
    const nGrid = gridCount(3) <= maxStrokes / 3 ? 3 : gridCount(2) <= maxStrokes / 3 ? 2 : 1;
    splat(gridR.slice(0, nGrid), () => left(), 0.6, "masses", "normal", true);
    splat([side / 30, side / 50], () => Math.round(left() * 0.06), 0.35, "ombres", "multiply");
    splat([side / 34, side / 56], () => Math.round(left() * 0.05), 0.35, "lumières", "screen");
    const fr = [0.12, 0.2, 0.3, 0.45, 1];
    splat([side / 34, side / 55, side / 90, side / 150, side / 250].map((r) => Math.max(0.8, r)), (li) => Math.round(left() * fr[li]), 0.7, "détails");
  }

  // ---------------------------------------------------------------- 2. masses : pinceau plat, opaque
  if (!real) {
    const radii = [side / 13, side / 22, side / 36];
    if (detail > 0.5 || real) radii.push(side / 56);
    const share = real ? [0.02, 0.04, 0.06, 0.08] : [0.04, 0.07, 0.1, 0.12];
    radii.forEach((R, li) => {
      const ref = blurImg(im, R * 0.55);
      const field = orient(R * 0.8);
      const T = 0.1 - 0.03 * li - 0.02 * detail;
      const diffC = (i: number) => Math.hypot(ref.r[i] - cr[i], ref.g[i] - cg[i], ref.b[i] - cb[i]);
      const list = cells(Math.max(2, Math.round(R)), diffC, T);
      const cap = budget(share[li]);
      let n = 0;
      for (const c of list) {
        if (n >= cap || full()) break;
        if (diffC(c.i) < T) continue;
        const x = c.i % w, y = Math.floor(c.i / w);
        const col: [number, number, number] = [ref.r[c.i], ref.g[c.i], ref.b[c.i]];
        // le trait reste dans la même couleur
        const pts = trace(x, y, R, real ? 10 : 7, field, (i) => Math.hypot(ref.r[i] - col[0], ref.g[i] - col[1], ref.b[i] - col[2]) < 0.12 + 0.05 * (1 - detail));
        const jit = (rand() - 0.5) * 0.03;
        const color = avgAlong(pts, (i) => [ref.r[i], ref.g[i], ref.b[i]]).map((v) => clamp01(v + jit)) as [number, number, number];
        stroke(pts, R, color, real
          ? { size: 2 * R, hardness: hardAt(pts, 0.1, 0.7), opacity: 0.8, blend: "normal", spacing: 0.2 }
          : { size: 2 * R, hardness: 0.6, opacity: 0.92, blend: "normal", spacing: 0.2, roundness: 0.6, angleFollow: true, sizeJitter: 0.1 });
        n++;
      }
      passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name: "masses" });
    });
  }

  // ---------------------------------------------------------------- 3-4. ombres (Produit) puis lumières (Écran)
  const glaze = (mode: "multiply" | "screen", radii: number[], shares: number[], alpha: number) => {
    radii.forEach((R, li) => {
      const ref = blurImg(im, R * 0.5);
      const field = orient(R * 0.7);
      // Besoin : assombrir (Produit) ou éclaircir (Écran), en clarté.
      const need = (i: number) => {
        const t = lum(ref.r[i], ref.g[i], ref.b[i]), c = lum(cr[i], cg[i], cb[i]);
        return mode === "multiply" ? c - t : t - c;
      };
      const T = 0.035 + 0.02 * (1 - detail);
      const list = cells(Math.max(2, Math.round(R)), need, T);
      const cap = budget(shares[li]);
      let n = 0;
      for (const c of list) {
        if (n >= cap || full()) break;
        if (need(c.i) < T) continue;
        const x = c.i % w, y = Math.floor(c.i / w);
        const pts = trace(x, y, R, 8, field, (i) => need(i) > T * 0.6);
        // Couleur du glacis : celle qui, à cette opacité, amène la toile sur l'image.
        const color = avgAlong(pts, (i) => {
          const ch = (t: number, cv: number) => mode === "multiply"
            ? clamp01(1 - (1 - Math.min(1, t / Math.max(0.02, cv))) / alpha)
            : clamp01(Math.max(0, t - cv) / (alpha * Math.max(0.02, 1 - cv)));
          return [ch(ref.r[i], cr[i]), ch(ref.g[i], cg[i]), ch(ref.b[i], cb[i])];
        });
        stroke(pts, R, color, { size: 2 * R, hardness: real ? hardAt(pts, 0.05, 0.6) : 0.1, opacity: alpha, blend: mode, spacing: 0.25, sizeJitter: real ? 0 : 0.08 });
        n++;
      }
      passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name: mode === "multiply" ? "ombres" : "lumières" });
    });
  };
  if (!real) {
    glaze("multiply", [side / 18, side / 34, side / 60], [0.06, 0.08, 0.08], 0.5);
    glaze("screen", [side / 22, side / 42, side / 75], [0.04, 0.06, 0.06], 0.45);
  }

  // ---------------------------------------------------------------- 5. couleur : voiles translucides
  for (const R of real ? [] : [side / 40]) {
    const ref = blurImg(im, R * 0.5);
    const field = orient(R);
    const need = (i: number) => Math.hypot(ref.r[i] - cr[i], ref.g[i] - cg[i], ref.b[i] - cb[i]);
    const T = 0.06 + 0.03 * (1 - detail);
    const list = cells(Math.max(2, Math.round(R)), need, T);
    const cap = budget(0.06);
    let n = 0;
    for (const c of list) {
      if (n >= cap || full()) break;
      if (need(c.i) < T) continue;
      const x = c.i % w, y = Math.floor(c.i / w);
      const col: [number, number, number] = [ref.r[c.i], ref.g[c.i], ref.b[c.i]];
      const pts = trace(x, y, R, 6, field, (i) => need(i) > T * 0.6 && Math.hypot(ref.r[i] - col[0], ref.g[i] - col[1], ref.b[i] - col[2]) < 0.15);
      stroke(pts, R, avgAlong(pts, (i) => [ref.r[i], ref.g[i], ref.b[i]]), { size: 2 * R, hardness: real ? hardAt(pts, 0.05, 0.6) : 0.2, opacity: real ? 0.35 : 0.4, blend: "normal", spacing: 0.25 });
      n++;
    }
    passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name: "couleur" });
  }

  // ---------------------------------------------------------------- 6. matière : craie sur les zones texturées
  if (!real) {
    const fine = blurImg({ w, h, r: L0, g: L0, b: L0 }, 1.2).r;
    const hp = new Float32Array(N);
    for (let i = 0; i < N; i++) hp[i] = (L0[i] - fine[i]) ** 2;
    const energy = blurImg({ w, h, r: hp, g: hp, b: hp }, 3).r;
    const R = Math.max(1.2, side / 110);
    const soft = blurImg(im, 0.8);
    const field = orient(2);
    const T = 0.0012 + 0.002 * (1 - detail);
    const list = cells(Math.max(2, Math.round(R * 1.6)), (i) => energy[i], T);
    const cap = budget(0.14);
    let n = 0;
    for (const c of list) {
      if (n >= cap || full()) break;
      const x = c.i % w, y = Math.floor(c.i / w);
      // Zone à fil (tricot, herbe, bois) : petits traits orientés ; sinon grain dispersé.
      const directional = field.coh[c.i] > 0.4;
      const pts = trace(x, y, R, directional ? 4 : 2, field, () => true);
      const color = avgAlong(pts, (i) => [0.6 * soft.r[i] + 0.4 * cr[i], 0.6 * soft.g[i] + 0.4 * cg[i], 0.6 * soft.b[i] + 0.4 * cb[i]]);
      stroke(pts, R, color, directional
        ? { size: 2 * R, hardness: 0.5, opacity: 0.3, blend: "normal", spacing: 0.3, roundness: 0.35, angleFollow: true, sizeJitter: 0.3 }
        : { size: 2 * R, hardness: 0.9, opacity: 0.55, blend: "normal", spacing: 0.35, tip: CHALK, angleJitter: 180, sizeJitter: 0.5, scatter: 0.35 });
      n++;
    }
    passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name: "matière" });
  }

  // ---------------------------------------------------------------- 7. détails : touches fines opaques où l'écart reste fort
  if (!real) {
    const radii = (real ? [side / 90, side / 150, side / 240] : [side / 90, side / 150]).map((r) => Math.max(real ? 0.8 : 0.9, r * (1.4 - 0.6 * detail)));
    radii.forEach((R, li) => {
      const ref = blurImg(im, Math.max(0.4, R * 0.5));
      const field = orient(Math.max(1, R));
      const diffC = (i: number) => Math.hypot(ref.r[i] - cr[i], ref.g[i] - cg[i], ref.b[i] - cb[i]);
      const T = real ? 0.08 - 0.03 * detail : 0.12 - 0.04 * detail;
      const list = cells(Math.max(1, Math.round(R * 1.5)), diffC, T);
      const cap = budget(real ? [0.1, 0.12, 0.12][li] : li ? 0.08 : 0.07);
      let n = 0;
      for (const c of list) {
        if (n >= cap || full()) break;
        if (diffC(c.i) < T) continue;
        const x = c.i % w, y = Math.floor(c.i / w);
        const col: [number, number, number] = [ref.r[c.i], ref.g[c.i], ref.b[c.i]];
        const pts = trace(x, y, R, 5, field, (i) => Math.hypot(ref.r[i] - col[0], ref.g[i] - col[1], ref.b[i] - col[2]) < 0.1);
        stroke(pts, R, col, { size: 2 * R, hardness: real ? hardAt(pts, 0.2, 0.9) : 0.75, opacity: real ? 0.85 : 0.9, blend: "normal", spacing: 0.25 });
        n++;
      }
      passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name: "détails" });
    });
  }

  // ---------------------------------------------------------------- 8. contours : arêtes nettes, traits effilés en Produit
  if (!real) {
    const Ls = blurImg({ w, h, r: L0, g: L0, b: L0 }, 0.8).r;
    const mag = new Float32Array(N), gxA = new Float32Array(N), gyA = new Float32Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (Ls[i - w + 1] + 2 * Ls[i + 1] + Ls[i + w + 1]) - (Ls[i - w - 1] + 2 * Ls[i - 1] + Ls[i + w - 1]);
      const gy = (Ls[i + w - 1] + 2 * Ls[i + w] + Ls[i + w + 1]) - (Ls[i - w - 1] + 2 * Ls[i - w] + Ls[i - w + 1]);
      mag[i] = Math.hypot(gx, gy); gxA[i] = gx; gyA[i] = gy;
    }
    // Seuil : quantile haut des gradients (seules les arêtes franches).
    const sorted = Float32Array.from(mag).sort();
    const thr = Math.max(0.25, sorted[Math.floor(N * (0.965 - 0.02 * detail))]);
    const edge = new Uint8Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < thr) continue;
      const m = mag[i] || 1, ux = gxA[i] / m, uy = gyA[i] / m;
      if (mag[at(x + ux, y + uy)] > mag[i] || mag[at(x - ux, y - uy)] > mag[i]) continue; // non-maxima
      edge[i] = 1;
    }
    const seen = new Uint8Array(N);
    const cap = budget(0.08);
    const R = Math.max(0.55, side / 520);
    let n = 0;
    const order: number[] = [];
    for (let i = 0; i < N; i++) if (edge[i]) order.push(i);
    order.sort((a, b) => mag[b] - mag[a]);
    for (const s of order) {
      if (n >= cap || full()) break;
      if (seen[s]) continue;
      // Chaîne : on suit les voisins d'arête dans les deux sens.
      const chain = (start: number, dirSign: number) => {
        const pts: number[] = [];
        let i = start;
        let px = gyA[i] * -dirSign, py = gxA[i] * dirSign;
        for (let k = 0; k < 400; k++) {
          seen[i] = 1;
          const x = i % w, y = Math.floor(i / w);
          let best = -1, bs = -2;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const j = (y + dy) * w + (x + dx);
            if (j < 0 || j >= N || !edge[j] || seen[j]) continue;
            const sc = (dx * px + dy * py) / Math.hypot(dx, dy);
            if (sc > bs) { bs = sc; best = j; }
          }
          if (best < 0 || bs < -0.2) break;
          px = (best % w) - x; py = Math.floor(best / w) - y;
          i = best;
          pts.push(i);
        }
        return pts;
      };
      const a = chain(s, 1), b = chain(s, -1);
      const idx = [...b.reverse(), s, ...a];
      if (idx.length < 6) continue;
      const pts: number[] = [];
      const step = 2;
      for (let k = 0; k < idx.length; k += step) {
        const i = idx[k];
        const t = k / (idx.length - 1);
        pts.push(i % w, Math.floor(i / w), Math.round((0.25 + 0.75 * Math.sin(Math.PI * t)) * 100) / 100);
      }
      // Couleur : le côté sombre de l'arête, en Produit (assombrit sans boucher).
      const color = avgAlong(pts, (i) => {
        const m = mag[i] || 1;
        const x = i % w, y = Math.floor(i / w);
        const j = at(x - (gxA[i] / m) * 1.5, y - (gyA[i] / m) * 1.5);
        return [clamp01(im.r[j] * 0.75 + 0.1), clamp01(im.g[j] * 0.7 + 0.1), clamp01(im.b[j] * 0.7 + 0.12)];
      });
      stroke(pts, R, color, { size: 2 * R, hardness: 0.85, opacity: 0.55, blend: "multiply", spacing: 0.3 });
      n++;
    }
    passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name: "contours" });
  }

  // ---------------------------------------------------------------- 9. accents : reflets en Écran
  if (!real) {
    const Lb = blurImg({ w, h, r: L0, g: L0, b: L0 }, 3).r;
    const R = Math.max(0.8, side / 260);
    const cand: number[] = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = L0[i];
      if (l < 0.62 || l - Lb[i] < 0.1) continue;
      if (l < L0[i - 1] || l < L0[i + 1] || l < L0[i - w] || l < L0[i + w]) continue;
      if (lum(cr[i], cg[i], cb[i]) > l - 0.04) continue;
      cand.push(i);
    }
    cand.sort((a, b) => (L0[b] - Lb[b]) - (L0[a] - Lb[a]));
    const cap = budget(0.015);
    let n = 0;
    const taken: number[] = [];
    for (const i of cand) {
      if (n >= cap || full()) break;
      const x = i % w, y = Math.floor(i / w);
      if (taken.some((j) => Math.hypot((j % w) - x, Math.floor(j / w) - y) < R * 6)) continue;
      taken.push(i);
      const pts = [x, y, 0.8, x + 0.4, y + 0.2, 1];
      stroke(pts, R, [im.r[i], im.g[i], im.b[i]], { size: 2 * R, hardness: 0.6, opacity: 0.8, blend: "screen", spacing: 0.25 });
      n++;
    }
    passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name: "accents" });
  }

  // ---------------------------------------------------------------- ajustement des touches posées
  // Chaque touche est retouchée (couleur, place, taille, orientation) tant que l'écart pondéré par le point focal
  // baisse. Une retouche ne change la toile que sous la touche : on recalcule cette zone en rejouant, dans l'ordre,
  // les touches qui la recouvrent depuis le fond.
  const optimizeMs = opts.optimizeMs ?? (real ? 4000 : 0);
  let tuned = 0, visited = 0;
  if (optimizeMs > 0 && recs.length > nFond) {
    const t0 = Date.now();
    const T = 16, tx = Math.ceil(w / T), ty = Math.ceil(h / T);
    const buckets: number[][] = Array.from({ length: tx * ty }, () => []);
    const index = (k: number, box: [number, number, number, number]) => {
      for (let y = Math.floor(box[1] / T); y <= Math.floor(box[3] / T); y++) for (let x = Math.floor(box[0] / T); x <= Math.floor(box[2] / T); x++) {
        const bk = buckets[y * tx + x];
        if (bk[bk.length - 1] !== k) bk.push(k);
      }
    };
    for (let k = nFond; k < recs.length; k++) index(k, recs[k].box);
    // Touches posées après chacune et qui recouvrent sa zone gardée : seules à rejouer pour l'évaluer.
    const later: number[][] = [];
    for (let k = nFond; k < recs.length; k++) {
      const ub = recs[k].ubox;
      if (!ub) continue;
      const ids = new Set<number>();
      for (let y = Math.floor(ub[1] / T); y <= Math.floor(ub[3] / T); y++) for (let x = Math.floor(ub[0] / T); x <= Math.floor(ub[2] / T); x++) for (const q of buckets[y * tx + x]) {
        if (q <= k) continue;
        const bx = recs[q].box;
        if (bx[2] < ub[0] || bx[0] > ub[2] || bx[3] < ub[1] || bx[1] > ub[3]) continue;
        ids.add(q);
      }
      later[k] = [...ids].sort((a, b) => a - b);
    }
    /** Zone recalculée avec la touche `k` remplacée par `alt` ; renvoie l'écart pondéré et le morceau de toile. */
    const region = (box: [number, number, number, number], k: number, alt: Rec) => {
      const [x0, y0, x1, y1] = box;
      const cw = x1 - x0 + 1, n = cw * (y1 - y0 + 1);
      const C = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), ox: x0, oy: y0, cw };
      // Rapide : la toile gardée sous la touche (approchée si des touches d'avant ont été retouchées depuis), puis
      // seulement les touches posées après. Sinon : tout rejouer depuis le fond.
      const own = recs[k];
      const ub = own.ubox;
      const fast = !!(own.under && ub && x0 >= ub[0] && y0 >= ub[1] && x1 <= ub[2] && y1 <= ub[3]);
      const ucw = ub ? ub[2] - ub[0] + 1 : 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const j = (y - y0) * cw + (x - x0);
        if (fast) {
          const u = ((y - ub![1]) * ucw + (x - ub![0])) * 3;
          C.r[j] = own.under![u]; C.g[j] = own.under![u + 1]; C.b[j] = own.under![u + 2];
        } else {
          const i = y * w + x;
          C.r[j] = baseR[i]; C.g[j] = baseG[i]; C.b[j] = baseB[i];
        }
      }
      let list: number[];
      if (fast) list = [k, ...(later[k] ?? [])];
      else {
        const ids = new Set<number>();
        for (let y = Math.floor(y0 / T); y <= Math.floor(y1 / T); y++) for (let x = Math.floor(x0 / T); x <= Math.floor(x1 / T); x++) for (const q of buckets[y * tx + x]) ids.add(q);
        ids.add(k);
        list = [...ids].sort((a, b) => a - b);
      }
      for (const q of list) {
        const rc = q === k ? alt : recs[q];
        if (rc.box[2] < x0 || rc.box[0] > x1 || rc.box[3] < y0 || rc.box[1] > y1) continue;
        paint(rc.pts, rc.R, rc.color, rc.b, C, box);
      }
      let e = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * w + x, j = (y - y0) * cw + (x - x0);
        const dr = C.r[j] - im.r[i], dg = C.g[j] - im.g[i], db = C.b[j] - im.b[i];
        e += focal[i] * (dr * dr + dg * dg + db * db);
      }
      return { e, C };
    };
    const union = (a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] =>
      [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
    const order: number[] = [];
    for (let k = nFond; k < recs.length; k++) if (recs[k].pts.length === 3 && recs[k].R <= side / 34) order.push(k);
    // D'abord les touches du point focal.
    order.sort((a, b) => focal[at(recs[b].pts[0], recs[b].pts[1])] * (0.8 + 0.4 * rand()) - focal[at(recs[a].pts[0], recs[a].pts[1])] * (0.8 + 0.4 * rand()));
    outer: for (let pass = 0; pass < 3; pass++) {
      for (const k of order) {
        if (Date.now() - t0 > optimizeMs) break outer;
        const cur = recs[k];
        visited++;
        const base = region(cur.box, k, cur);
        // Couleur visée : écart moyen sous la touche, ramené à son opacité.
        let sr = 0, sg = 0, sb = 0, sw = 0;
        const [x0, y0, x1, y1] = cur.box;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const dx = x - cur.pts[0], dy = y - cur.pts[1];
          const wgt = Math.max(0, 1 - Math.hypot(dx, dy) / cur.R);
          if (!wgt) continue;
          const i = y * w + x, j = (y - y0) * (x1 - x0 + 1) + (x - x0);
          sr += wgt * (im.r[i] - base.C.r[j]); sg += wgt * (im.g[i] - base.C.g[j]); sb += wgt * (im.b[i] - base.C.b[j]); sw += wgt;
        }
        const tries: Rec[] = [];
        const kAlpha = 0.8 / Math.max(0.2, cur.b.opacity);
        if (sw > 0 && cur.b.blend === "normal") {
          tries.push({ ...cur, color: [clamp01(cur.color[0] + (sr / sw) * kAlpha), clamp01(cur.color[1] + (sg / sw) * kAlpha), clamp01(cur.color[2] + (sb / sw) * kAlpha)] });
        }
        const a = rand() * Math.PI * 2, d = cur.R * 0.35;
        const moved = [Math.min(w - 1, Math.max(0, cur.pts[0] + Math.cos(a) * d)), Math.min(h - 1, Math.max(0, cur.pts[1] + Math.sin(a) * d)), cur.pts[2]];
        tries.push({ ...cur, pts: moved, box: boxOf(moved, cur.R, cur.b) });
        const f = rand() < 0.5 ? 0.8 : 1.22;
        tries.push({ ...cur, R: cur.R * f, b: { ...cur.b, size: cur.b.size * f }, box: boxOf(cur.pts, cur.R * f, cur.b) });
        if ((cur.b.roundness ?? 1) < 1) tries.push({ ...cur, b: { ...cur.b, angle: (cur.b.angle ?? 0) + (rand() < 0.5 ? -18 : 18) } });
        else if (cur.b.blend === "normal" && sharp[at(cur.pts[0], cur.pts[1])] < 0.3) tries.push({ ...cur, b: { ...cur.b, hardness: Math.max(0, cur.b.hardness - 0.15) } });
        let best = cur, bestE = base.e, bestBox = cur.box;
        for (const t of tries) {
          const box = union(cur.box, t.box);
          const e0 = box === cur.box ? base.e : region(box, k, cur).e;
          const e1 = region(box, k, t).e;
          if (e1 < e0 - 1e-6 && e1 - e0 < bestE - base.e) { best = t; bestE = base.e + (e1 - e0); bestBox = box; }
        }
        if (best !== cur) {
          recs[k] = best;
          index(k, best.box);
          // la toile simulée suit
          const { C } = region(bestBox, k, best);
          for (let y = bestBox[1]; y <= bestBox[3]; y++) for (let x = bestBox[0]; x <= bestBox[2]; x++) {
            const i = y * w + x, j = (y - bestBox[1]) * C.cw + (x - bestBox[0]);
            cr[i] = C.r[j]; cg[i] = C.g[j]; cb[i] = C.b[j];
          }
          tuned++;
        }
      }
    }
    passes.push({ radius: 0, strokes: tuned, name: "ajustement", visited } as { radius: number; strokes: number; name: string });
    // Toile finale exacte : on rejoue tout depuis le fond.
    cr.set(baseR); cg.set(baseG); cb.set(baseB);
    for (let k = nFond; k < recs.length; k++) paint(recs[k].pts, recs[k].R, recs[k].color, recs[k].b);
  }
  for (const r of recs) emitRec(r);

  let err = 0;
  for (let i = 0; i < N; i++) err += Math.hypot(im.r[i] - cr[i], im.g[i] - cg[i], im.b[i] - cb[i]);
  let preview: PainterlyResult["preview"];
  if (opts.preview) {
    const data = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) { data[i * 4] = cr[i] * 255; data[i * 4 + 1] = cg[i] * 255; data[i * 4 + 2] = cb[i] * 255; data[i * 4 + 3] = 255; }
    preview = { width: w, height: h, data };
  }
  return { width: Math.round(w * scale), height: Math.round(h * scale), strokes: out, error: err / N / Math.sqrt(3), layers: passes, preview };
}

export type { Img };
