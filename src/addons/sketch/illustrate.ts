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
  const passes: { radius: number; strokes: number; name?: string }[] = [];
  let held: Record<string, unknown> = {};
  const emit = (brush: Record<string, unknown>, pts: number[]) => {
    const s: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(brush)) if (held[k] !== v) s[k] = v;
    held = { ...held, ...brush };
    s.pts = pts;
    out.push(s);
  };
  const full = () => out.length >= maxStrokes;

  /** Couverture (0..1) d'un trait : capsules à rayon modulé par la pression, bord adouci selon la dureté. */
  const paint = (pts: number[], R: number, color: [number, number, number], b: Brush) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < pts.length; k += 3) { x0 = Math.min(x0, pts[k]); y0 = Math.min(y0, pts[k + 1]); x1 = Math.max(x1, pts[k]); y1 = Math.max(y1, pts[k + 1]); }
    const reach = R * (1 + (b.scatter ?? 0));
    const X0 = Math.max(0, Math.floor(x0 - reach)), Y0 = Math.max(0, Math.floor(y0 - reach));
    const X1 = Math.min(w - 1, Math.ceil(x1 + reach)), Y1 = Math.min(h - 1, Math.ceil(y1 + reach));
    const segs = pts.length / 3;
    const hard = b.hardness;
    // Pointes texturées et dispersion : couverture partielle.
    const texture = b.tip || (b.scatter ?? 0) > 0 ? 0.55 : 1;
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
        const d = Math.sqrt(u * u + v * v);
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
      const i = y * w + x;
      // Empreintes qui se chevauchent : leurs couvertures s'accumulent (bord doux plus étroit qu'une seule).
      const k = (1 - Math.pow(1 - Math.min(0.999, best), overlap)) * a;
      let tr: number, tg: number, tb: number;
      if (b.blend === "multiply") { tr = cr[i] * r; tg = cg[i] * g; tb = cb[i] * bl; }
      else if (b.blend === "screen") { tr = 1 - (1 - cr[i]) * (1 - r); tg = 1 - (1 - cg[i]) * (1 - g); tb = 1 - (1 - cb[i]) * (1 - bl); }
      else { tr = r; tg = g; tb = bl; }
      cr[i] += (tr - cr[i]) * k; cg[i] += (tg - cg[i]) * k; cb[i] += (tb - cb[i]) * k;
    }
  };

  /** Trait émis dans le cadre des gestes ; `b` complet à chaque fois (seuls les changements sont écrits). */
  const stroke = (raw: number[], R: number, color: [number, number, number], b: Brush, extra: Record<string, unknown> = {}, spill = 0) => {
    // Bords nets : près du cadre, la pression (donc la taille) baisse pour que la touche ne déborde pas (au plus
    // `spill` × le rayon pour une touche douce, dont le bord est presque transparent).
    const reach = R * (1 + (b.scatter ?? 0)) * (1 - spill);
    const pts = raw.slice();
    for (let k = 0; k < pts.length; k += 3) {
      const m = 0.2 * reach;
      pts[k] = Math.min(w - 1 - m, Math.max(m, pts[k]));
      pts[k + 1] = Math.min(h - 1 - m, Math.max(m, pts[k + 1]));
      const d = Math.min(pts[k], pts[k + 1], w - 1 - pts[k], h - 1 - pts[k + 1]) + 0.5;
      const pMax = Math.max(0, Math.min(1, (d / reach - 0.2) / 0.8));
      if (pts[k + 2] > pMax) pts[k + 2] = Math.round(pMax * 100) / 100;
    }
    paint(pts, R, color, b);
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
    // Aplat net qui ne déborde pas du cadre : traits durs, axes à un rayon du bord.
    const R = Math.min(w, h) / 8;
    const b: Brush = { size: 2 * R, hardness: 0.95, opacity: 1, blend: "normal", spacing: 0.25 };
    // Les réglages communs vont avec le premier trait.
    const common = { reset: true, tool: "paint", pressure: true, angle: 0, tremble: 0 };
    const rows = Math.max(1, Math.ceil((h - 2 * R) / (1.6 * R)) + 1);
    for (let k = 0; k < rows; k++) {
      const y = rows > 1 ? R + ((h - 2 * R) * k) / (rows - 1) : h / 2;
      stroke([R, y, 1, w - R, y, 1], R, [mr, mg, mb], b, out.length ? {} : common);
    }
    passes.push({ radius: Math.round(R * scale), strokes: out.length, name: "fond" });
  }

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
        ? (i: number) => Math.hypot(ref.r[i] - cr[i], ref.g[i] - cg[i], ref.b[i] - cb[i]) * (fineK ? 0.3 + 0.7 * Math.min(1, sharp[i] * 1.5) : 1)
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
        stroke([x, y, 1], R, color, {
          size: 2 * R, hardness: Math.round((0.04 + 0.8 * Math.min(1, sh * 1.3)) * (grid ? 0.5 : 1) * 100) / 100, opacity: alpha, blend: mode,
          spacing: 0.25, roundness: Math.round(q * 100) / 100, angle,
        }, {}, 0.3);
        n++;
      }
      passes.push({ radius: Math.round(R * scale * 10) / 10, strokes: n, name });
    });
  };
  if (real) {
    // Budget : la base lisse d'abord (complète, sinon il resterait des trous), puis glacis et détails se partagent
    // ce qui reste, les plus grosses touches servies d'abord, les plus fines prennent le reste là où l'écart est fort.
    const left = () => Math.max(0, maxStrokes - out.length);
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
