/**
 * HPGL / HP-GL/2 (.plt, .hpgl, .hgl : CorelDraw, découpeuses vinyle, RDWorks, anciens traceurs) → formes.
 *
 * Lu : IN, PU, PD, PA, PR, SP (une couleur par plume), CI (cercle), AA / AR (arcs), EA / ER / RA / RR
 * (rectangles), IP / SC (mise à l'échelle utilisateur), PE (polyligne encodée HP-GL/2). Unité : 1/40 mm.
 * Textes (LB) ignorés.
 */
import { addArc, MAX_SHAPES, PathBuilder, Skips, type Shape } from "./geom";

/** Couleurs des plumes : une par numéro, pour leur attribuer une opération. */
export const PEN_COLORS = ["#000000", "#000000", "#ff0000", "#00a000", "#d0a000", "#0000ff", "#ff00ff", "#00c0c0", "#ff8000"];
export const penColor = (n: number) => PEN_COLORS[n] ?? PEN_COLORS[1 + ((n - 1) % 8)];

export type HpglResult = { shapes: Shape[]; unitMm: number; skipped: Record<string, number>; issues: string[] };

export function readHpgl(text: string): HpglResult {
  const skips = new Skips();
  const issues: string[] = [];
  const shapes: Shape[] = [];
  let x = 0, y = 0;
  let down = false;
  let relative = false;
  let pen = 1;
  let p = new PathBuilder();
  // Mise à l'échelle utilisateur (IP + SC).
  let ip = [0, 0, 10_000, 10_000];
  let sc: number[] | null = null;
  const map = (ux: number, uy: number): [number, number] => {
    if (!sc) return [ux, uy];
    const [x1, x2, y1, y2] = sc;
    return [ip[0] + ((ux - x1) * (ip[2] - ip[0])) / (x2 - x1 || 1), ip[1] + ((uy - y1) * (ip[3] - ip[1])) / (y2 - y1 || 1)];
  };
  const flush = () => {
    if (!p.empty && shapes.length < MAX_SHAPES) shapes.push({ segs: p.take(), stroke: penColor(pen) });
    else p.clear();
    p = new PathBuilder();
  };
  const moveAbs = (nx: number, ny: number) => {
    if (down) {
      if (!p.current) p.moveTo(x, y);
      p.lineTo(nx, ny);
    } else {
      flush();
    }
    x = nx;
    y = ny;
  };
  const coords = (args: number[]) => {
    for (let k = 0; k + 1 < args.length; k += 2) {
      if (relative) {
        // En mode relatif, les déplacements sont en unités traceur (l'échelle ne s'applique qu'aux absolus).
        moveAbs(x + args[k], y + args[k + 1]);
      } else {
        const [nx, ny] = map(args[k], args[k + 1]);
        moveAbs(nx, ny);
      }
    }
  };
  const src = text.replace(/\x1b[.%][^A-Za-z]*[A-Za-z]/g, "");
  let i = 0;
  const n = src.length;
  let count = 0;
  while (i < n) {
    const ch = src[i];
    if (!/[A-Za-z]/.test(ch)) {
      i++;
      continue;
    }
    const cmd = src.substr(i, 2).toUpperCase();
    i += 2;
    if (cmd === "LB") {
      // Texte jusqu'au terminateur (ETX par défaut).
      const end = src.indexOf("\x03", i);
      i = end < 0 ? n : end + 1;
      skips.add("texte");
      continue;
    }
    if (cmd === "PE") {
      const end = src.indexOf(";", i);
      const body = src.slice(i, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
      readPolylineEncoded(body, {
        up: () => { down = false; flush(); },
        down: () => { down = true; },
        rel: (dx, dy) => moveAbs(x + dx, y + dy),
        abs: (ax, ay) => moveAbs(ax, ay),
        pen: (np) => { flush(); pen = np; },
      });
      continue;
    }
    let j = i;
    while (j < n && !/[A-Za-z;]/.test(src[j])) j++;
    const args = src.slice(i, j).split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    i = j < n && src[j] === ";" ? j + 1 : j;
    if (++count > 5_000_000) {
      issues.push("fichier trop long : lecture arrêtée");
      break;
    }
    switch (cmd) {
      case "IN":
      case "DF":
        flush();
        down = false;
        relative = false;
        sc = null;
        ip = [0, 0, 10_000, 10_000];
        break;
      case "IP":
        if (args.length >= 4) ip = args.slice(0, 4);
        break;
      case "SC":
        sc = args.length >= 4 ? args.slice(0, 4) : null;
        break;
      case "PU":
        down = false;
        flush();
        coords(args);
        break;
      case "PD":
        down = true;
        coords(args);
        break;
      case "PA":
        relative = false;
        coords(args);
        break;
      case "PR":
        relative = true;
        coords(args);
        break;
      case "SP":
        flush();
        pen = Math.max(0, Math.round(args[0] ?? 0));
        break;
      case "CI": {
        const r = Math.abs(args[0] ?? 0);
        if (!r) break;
        flush();
        const c = new PathBuilder();
        addArc(c, x, y, r, r, 0, 2 * Math.PI, undefined, 0, true);
        c.close();
        shapes.push({ segs: c.take(), stroke: penColor(pen) });
        break;
      }
      case "AA":
      case "AR": {
        if (args.length < 3) break;
        const [cx, cy] = cmd === "AR" ? [x + args[0], y + args[1]] : map(args[0], args[1]);
        const sweep = (args[2] * Math.PI) / 180;
        const r = Math.hypot(x - cx, y - cy);
        const a1 = Math.atan2(y - cy, x - cx);
        if (down) {
          if (!p.current) p.moveTo(x, y);
          addArc(p, cx, cy, r, r, a1, a1 + sweep);
        }
        x = cx + r * Math.cos(a1 + sweep);
        y = cy + r * Math.sin(a1 + sweep);
        break;
      }
      case "EA":
      case "ER":
      case "RA":
      case "RR": {
        if (args.length < 2) break;
        const [ex, ey] = cmd === "EA" || cmd === "RA" ? map(args[0], args[1]) : [x + args[0], y + args[1]];
        const r = new PathBuilder();
        r.moveTo(x, y);
        r.lineTo(ex, y);
        r.lineTo(ex, ey);
        r.lineTo(x, ey);
        r.close();
        shapes.push(cmd[0] === "R" ? { segs: r.take(), fill: penColor(pen) } : { segs: r.take(), stroke: penColor(pen) });
        break;
      }
      case "WG":
      case "EW":
      case "PM":
      case "FP":
      case "EP":
        skips.add("remplissage HP-GL/2");
        break;
      default:
        break;
    }
  }
  flush();
  return { shapes, unitMm: 0.025, skipped: skips.counts, issues };
}

/** Polyligne encodée HP-GL/2 (PE) : nombres en base 64 (32 si `7`), signe dans le bit de poids faible. */
function readPolylineEncoded(body: string, on: { up(): void; down(): void; rel(dx: number, dy: number): void; abs(x: number, y: number): void; pen(n: number): void }): void {
  let base = 64;
  let frac = 0;
  let i = 0;
  const readNum = (): number | null => {
    let v = 0, mult = 1;
    while (i < body.length) {
      const c = body.charCodeAt(i++);
      if (base === 64) {
        if (c >= 63 && c <= 126) { v += (c - 63) * mult; mult *= 64; continue; }
        if (c >= 191 && c <= 254) { v += (c - 191) * mult; break; }
      } else {
        if (c >= 63 && c <= 94) { v += (c - 63) * mult; mult *= 32; continue; }
        if (c >= 95 && c <= 126) { v += (c - 95) * mult; break; }
      }
      return null;
    }
    const sign = v & 1 ? -1 : 1;
    return (sign * Math.floor(v / 2)) / Math.pow(2, frac);
  };
  let pendingAbs = false;
  let penUp = false;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "<") { i++; penUp = true; on.up(); continue; }
    if (ch === ">") { i++; frac = readNum() ?? 0; continue; }
    if (ch === "=") { i++; pendingAbs = true; continue; }
    if (ch === "7") { i++; base = 32; continue; }
    if (ch === ":") { i++; on.pen(readNum() ?? 1); continue; }
    const a = readNum();
    const b = readNum();
    if (a === null || b === null) break;
    if (!penUp) on.down();
    if (pendingAbs) on.abs(a, b);
    else on.rel(a, b);
    pendingAbs = false;
    if (penUp) { penUp = false; on.down(); }
  }
}
