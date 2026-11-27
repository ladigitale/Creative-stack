#!/usr/bin/env node
/**
 * Polices et icônes de procgen : contours des glyphes (Google Fonts, paquets @fontsource) et tracés des icônes
 * (Lucide) convertis en JSON compact dans src/addons/procgen/fonts/data/. Fichiers générés : ne pas les écrire à la
 * main ; relancer ce script pour en ajouter ou les mettre à jour (il a besoin du registre npm).
 *
 *   node scripts/build-procgen-fonts.mjs
 *
 * Police : { id, family, license, copyright, upm: 1000, cap, xh, asc, desc, glyphs: { "A": [avance, contour…] },
 * kern: { "AV": -80 } } ; un contour = suite d'entiers x0, y0, dx1, dy1… (millièmes d'em, y vers le haut, fermé).
 * Icônes : { size: 1000 (le carré de 24 px de Lucide), stroke: largeur du trait, icons: { nom: [tracé…] } } ;
 * un tracé = polyligne codée de même (fermée si son dernier point répète le premier).
 */
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import opentype from "opentype.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "src/addons/procgen/fonts/data");
const FONTSOURCE = "5.3.0";
const LUCIDE = "0.468.0";

/** Polices retenues : caractères bien distincts, toutes sous licence libre (OFL ou Apache). */
const FONTS = [
  { id: "inter", pkg: "inter", weight: 700 },
  { id: "playfair", pkg: "playfair-display", weight: 700 },
  { id: "slab", pkg: "roboto-slab", weight: 700 },
  { id: "pacifico", pkg: "pacifico", weight: 400 },
  { id: "lobster", pkg: "lobster", weight: 400 },
  { id: "fraktur", pkg: "unifrakturmaguntia", weight: 400 },
  { id: "rye", pkg: "rye", weight: 400 },
  { id: "stencil", pkg: "black-ops-one", weight: 400 },
  { id: "pixel", pkg: "press-start-2p", weight: 400 },
  { id: "bebas", pkg: "bebas-neue", weight: 400 },
  { id: "caveat", pkg: "caveat", weight: 700 },
  { id: "bangers", pkg: "bangers", weight: 400 },
];

/** Icônes retenues (noms Lucide) : commerces, transports, signalétique, lieux, nature, sport, météo. */
const ICONS = `croissant coffee cup-soda beer wine martini pizza utensils utensils-crossed chef-hat soup salad sandwich cake cake-slice cookie ice-cream-cone ice-cream-bowl candy popcorn egg-fried milk apple carrot cherry citrus grape banana wheat fish beef ham drumstick shrimp
shopping-cart shopping-bag shopping-basket store gift tag percent euro badge-euro wallet receipt package scissors shirt glasses gem watch spray-can paintbrush palette brush pen-tool hammer wrench drill axe shovel
pill cross stethoscope syringe hospital heart-pulse bandage thermometer ambulance baby accessibility
book book-open library newspaper graduation-cap school pencil music guitar piano drum mic theater film clapperboard camera ticket gamepad-2 dices puzzle
bus car car-front bike train-front tram-front plane ship sailboat anchor fuel truck tractor rocket circle-parking traffic-cone construction
arrow-up arrow-down arrow-left arrow-right arrow-up-right arrow-up-left move-up-right undo-2 corner-up-right circle-arrow-right
info circle-help triangle-alert octagon-x ban circle-check circle-x wifi phone mail bell clock alarm-clock calendar key lock door-open door-closed map map-pin compass navigation flag signpost milestone footprints
house home hotel bed bath shower-head toilet sofa lamp lightbulb landmark church castle factory warehouse tent-tree tent building building-2 store
sun moon cloud cloud-rain cloud-snow cloud-lightning snowflake umbrella zap flame droplet droplets leaf flower flower-2 sprout trees tree-pine tree-palm tree-deciduous mountain mountain-snow waves sunrise rainbow wind
dog cat bird rabbit squirrel turtle snail bug fish-symbol paw-print bone egg feather rat
trophy medal award crown star heart smile dumbbell bike volleyball goal target swords sword shield anchor
recycle trash-2 cigarette cigarette-off battery plug power phone-call camera-off eye eye-off skull ghost sparkles party-popper balloon`
  .split(/\s+/)
  .filter(Boolean);

/** Jeu de caractères : ASCII imprimable et latin courant (français, espagnol, allemand…). */
const CHARS = [...new Set([...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ..."ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿŒœŸß«»‘’“”–—…€°·×¡¿©®™"])];

const tmp = mkdtempSync(path.join(os.tmpdir(), "procgen-fonts-"));
function unpack(spec) {
  const file = execSync(`npm pack ${spec} --silent --pack-destination ${tmp}`, { encoding: "utf8" }).trim().split("\n").pop();
  const dir = path.join(tmp, file.replace(/\.tgz$/, ""));
  mkdirSync(dir, { recursive: true });
  execSync(`tar xzf ${path.join(tmp, file)} -C ${dir}`);
  return path.join(dir, "package");
}

/** Polyligne → entiers relatifs. */
function encode(pts) {
  const out = [];
  let px = 0, py = 0;
  for (const [x, y] of pts) {
    const ix = Math.round(x), iy = Math.round(y);
    if (out.length && ix === px && iy === py) continue;
    out.push(out.length ? ix - px : ix, out.length ? iy - py : iy);
    px = ix;
    py = iy;
  }
  return out;
}

/** Courbes aplaties : nombre de segments selon la longueur du polygone de contrôle. */
const steps = (len, unit) => Math.max(2, Math.min(12, Math.ceil(len / unit)));
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function quad(p0, p1, p2, out, unit) {
  const n = steps(dist(p0, p1) + dist(p1, p2), unit);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}
function cubic(p0, p1, p2, p3, out, unit) {
  const n = steps(dist(p0, p1) + dist(p1, p2) + dist(p2, p3), unit);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
}

function buildFont(f) {
  const dir = unpack(`@fontsource/${f.pkg}@${FONTSOURCE}`);
  const file = path.join(dir, "files", `${f.pkg}-latin-${f.weight}-normal.woff`);
  const buf = readFileSync(file);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const s = 1000 / font.unitsPerEm;
  const glyphs = {};
  const gl = {};
  for (const ch of CHARS) {
    const g = font.charToGlyph(ch);
    if (!g || (g.index === 0 && ch !== " ")) continue;
    gl[ch] = g;
    const contours = [];
    let cur = null, last = [0, 0], start = [0, 0];
    for (const c of g.path.commands) {
      const P = (x, y) => [x * s, y * s];
      if (c.type === "M") {
        if (cur && cur.length > 2) contours.push(cur);
        start = last = P(c.x, c.y);
        cur = [last];
      } else if (c.type === "L") {
        last = P(c.x, c.y);
        cur.push(last);
      } else if (c.type === "Q") {
        const p = P(c.x, c.y);
        quad(last, P(c.x1, c.y1), p, cur, 45);
        last = p;
      } else if (c.type === "C") {
        const p = P(c.x, c.y);
        cubic(last, P(c.x1, c.y1), P(c.x2, c.y2), p, cur, 45);
        last = p;
      } else if (c.type === "Z") {
        if (cur && cur.length > 2) {
          if (dist(cur[0], cur[cur.length - 1]) < 0.5) cur.pop();
          contours.push(cur);
        }
        cur = null;
        last = start;
      }
    }
    if (cur && cur.length > 2) contours.push(cur);
    glyphs[ch] = [Math.round(g.advanceWidth * s), ...contours.map(encode).filter((c) => c.length >= 6)];
  }
  // crénage : paires de lettres, chiffres et ponctuation dont l'écart dépasse 1 % d'em
  const kern = {};
  const keys = Object.keys(gl).filter((c) => c !== " ");
  for (const a of keys)
    for (const b of keys) {
      let k = 0;
      try {
        k = font.getKerningValue(gl[a], gl[b]);
      } catch {
        k = 0;
      }
      if (Math.abs(k * s) >= 10) kern[a + b] = Math.round(k * s);
    }
  const box = (ch) => gl[ch]?.getBoundingBox();
  const cap = Math.round((box("H")?.y2 ?? font.ascender * 0.7) * s);
  const xh = Math.round((box("x")?.y2 ?? cap * 0.7) * s);
  const lic = readFileSync(path.join(dir, "LICENSE"), "utf8");
  const copyright = lic.split("\n")[0].replace(/\s+[\w-]+(\[[^\]]*\])?\.ttf:.*$/, "").trim();
  const license = /Apache License/.test(lic) ? "Apache-2.0" : "OFL-1.1";
  const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const family = (meta.description ?? "").match(/(?:for|the)\s+(.+?)\s+font/i)?.[1] ?? f.pkg;
  writeFileSync(path.join(OUT, `${f.id}.json`), JSON.stringify({ id: f.id, family, weight: f.weight, license, copyright, upm: 1000, cap, xh, asc: Math.round(font.ascender * s), desc: Math.round(font.descender * s), glyphs, kern }));
  return { id: f.id, family, license, copyright, glyphs: Object.keys(glyphs).length, kern: Object.keys(kern).length, licenseText: lic };
}

/* ---------- icônes : SVG de Lucide (traits de 2 px sur 24) → polylignes ---------- */

function arcPoints(p0, rx, ry, phi, large, sweep, p1, out) {
  // conversion de l'arc elliptique SVG (extrémités) vers son centre, puis échantillonnage
  if (rx === 0 || ry === 0) return void out.push(p1);
  const c = Math.cos(phi), s = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = c * dx + s * dy, y1 = -s * dx + c * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const L = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (L > 1) (rx *= Math.sqrt(L)), (ry *= Math.sqrt(L));
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = c * cx1 - s * cy1 + (p0[0] + p1[0]) / 2, cy = s * cx1 + c * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(2, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / 1.2));
  for (let i = 1; i <= n; i++) {
    const t = t0 + (dt * i) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push([c * ex - s * ey + cx, s * ex + c * ey + cy]);
  }
}

function pathPolylines(d) {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  let i = 0;
  const num = () => parseFloat(toks[i++]);
  const flag = () => {
    // drapeaux d'arc collés (« 0 0 1 » ou « 011 ») : un chiffre à la fois
    const t = toks[i];
    if (t.length > 1 && /^[01]/.test(t)) {
      toks[i] = t.slice(1);
      return +t[0];
    }
    i++;
    return +t;
  };
  const lines = [];
  let cur = null, p = [0, 0], start = [0, 0], cmd = "", lastCtrl = null, lastCmd = "";
  const isNum = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const R = (x, y) => (rel ? [p[0] + x, p[1] + y] : [x, y]);
    switch (cmd.toUpperCase()) {
      case "M": {
        p = R(num(), num());
        start = p;
        cur = [p];
        lines.push(cur);
        cmd = rel ? "l" : "L";
        break;
      }
      case "L":
        p = R(num(), num());
        cur.push(p);
        break;
      case "H":
        p = [rel ? p[0] + num() : num(), p[1]];
        cur.push(p);
        break;
      case "V":
        p = [p[0], rel ? p[1] + num() : num()];
        cur.push(p);
        break;
      case "C": {
        const c1 = R(num(), num()), c2 = R(num(), num()), e = R(num(), num());
        cubic(p, c1, c2, e, cur, 1.5);
        lastCtrl = c2;
        p = e;
        break;
      }
      case "S": {
        const c1 = /[CS]/i.test(lastCmd) && lastCtrl ? [2 * p[0] - lastCtrl[0], 2 * p[1] - lastCtrl[1]] : p;
        const c2 = R(num(), num()), e = R(num(), num());
        cubic(p, c1, c2, e, cur, 1.5);
        lastCtrl = c2;
        p = e;
        break;
      }
      case "Q": {
        const c1 = R(num(), num()), e = R(num(), num());
        quad(p, c1, e, cur, 1.5);
        lastCtrl = c1;
        p = e;
        break;
      }
      case "T": {
        const c1 = /[QT]/i.test(lastCmd) && lastCtrl ? [2 * p[0] - lastCtrl[0], 2 * p[1] - lastCtrl[1]] : p;
        const e = R(num(), num());
        quad(p, c1, e, cur, 1.5);
        lastCtrl = c1;
        p = e;
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = (num() * Math.PI) / 180, large = flag(), sweep = flag();
        const e = R(num(), num());
        arcPoints(p, rx, ry, rot, large, sweep, e, cur);
        p = e;
        break;
      }
      case "Z":
        cur.push(start);
        p = start;
        break;
      default:
        i++;
    }
    lastCmd = cmd;
    if (cmd.toUpperCase() === "Z" && isNum()) cmd = "L";
  }
  return lines;
}

function svgPolylines(svg) {
  const lines = [];
  const attr = (el, k) => {
    const m = el.match(new RegExp(`\\s${k}="([^"]*)"`));
    return m ? m[1] : null;
  };
  const N = (el, k) => parseFloat(attr(el, k) ?? "0");
  const ellipse = (cx, cy, rx, ry) => {
    const n = Math.max(12, Math.ceil(Math.max(rx, ry) * 4));
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = (i / n) * Math.PI * 2;
      return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
    });
  };
  for (const el of svg.match(/<(path|line|circle|ellipse|rect|polyline|polygon)\b[^>]*>/g) ?? []) {
    const tag = el.match(/^<(\w+)/)[1];
    if (tag === "path") lines.push(...pathPolylines(attr(el, "d")));
    else if (tag === "line") lines.push([[N(el, "x1"), N(el, "y1")], [N(el, "x2"), N(el, "y2")]]);
    else if (tag === "circle") lines.push(ellipse(N(el, "cx"), N(el, "cy"), N(el, "r"), N(el, "r")));
    else if (tag === "ellipse") lines.push(ellipse(N(el, "cx"), N(el, "cy"), N(el, "rx"), N(el, "ry")));
    else if (tag === "rect") {
      const x = N(el, "x"), y = N(el, "y"), w = N(el, "width"), h = N(el, "height");
      const r = Math.min(parseFloat(attr(el, "rx") ?? attr(el, "ry") ?? "0"), w / 2, h / 2);
      if (r > 0) {
        const pts = [];
        const corner = (cx, cy, a0) => {
          for (let k = 0; k <= 4; k++) {
            const t = a0 + (k / 4) * (Math.PI / 2);
            pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
          }
        };
        corner(x + w - r, y + r, -Math.PI / 2);
        corner(x + w - r, y + h - r, 0);
        corner(x + r, y + h - r, Math.PI / 2);
        corner(x + r, y + r, Math.PI);
        pts.push(pts[0]);
        lines.push(pts);
      } else lines.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
    } else {
      const v = (attr(el, "points") ?? "").trim().split(/[\s,]+/).map(Number);
      const pts = [];
      for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
      if (tag === "polygon" && pts.length) pts.push(pts[0]);
      lines.push(pts);
    }
  }
  // 24 px → 1000, y vers le haut (bas du carré en 0)
  const k = 1000 / 24;
  return lines.filter((l) => l.length >= 2).map((l) => encode(l.map(([x, y]) => [x * k, (24 - y) * k])));
}

function buildIcons() {
  const dir = unpack(`lucide-static@${LUCIDE}`);
  const icons = {};
  const missing = [];
  for (const name of [...new Set(ICONS)]) {
    let svg;
    try {
      svg = readFileSync(path.join(dir, "icons", `${name}.svg`), "utf8");
    } catch {
      missing.push(name);
      continue;
    }
    icons[name] = svgPolylines(svg);
  }
  writeFileSync(path.join(OUT, "icons.json"), JSON.stringify({ source: `lucide-static ${LUCIDE}`, license: "ISC", size: 1000, stroke: Math.round((2 / 24) * 1000), icons }));
  return { count: Object.keys(icons).length, missing, licenseText: readFileSync(path.join(dir, "LICENSE"), "utf8") };
}

mkdirSync(OUT, { recursive: true });
const done = FONTS.map(buildFont);
const ic = buildIcons();
const notices = [
  "# Polices et icônes de procgen",
  "",
  "Fichiers générés par `scripts/build-procgen-fonts.mjs` (contours convertis en JSON, glyphes latins seulement).",
  "",
  "## Polices",
  "",
  ...done.map((d) => `- \`${d.id}\` : ${d.family} — ${d.license} — ${d.copyright}`),
  "",
  "Licence SIL Open Font License 1.1 (texte ci-dessous) ; les polices ne sont pas vendues seules et gardent leurs noms d'origine dans `family`.",
  "",
  "```",
  done.find((d) => d.license === "OFL-1.1")?.licenseText.split(/\n(?=SIL OPEN FONT LICENSE)/)[1] ?? "",
  "```",
  "",
  "## Icônes",
  "",
  `Lucide (lucide-static ${LUCIDE}), licence ISC :`,
  "",
  "```",
  ic.licenseText.trim(),
  "```",
  "",
].join("\n");
writeFileSync(path.join(OUT, "NOTICE.md"), notices);
for (const d of done) console.log(`${d.id.padEnd(10)} ${d.family} : ${d.glyphs} glyphes, ${d.kern} paires de crénage`);
console.log(`icônes : ${ic.count}${ic.missing.length ? ` (absentes : ${ic.missing.join(", ")})` : ""}`);
for (const f of readdirSync(OUT)) console.log(`  ${f} ${(readFileSync(path.join(OUT, f)).length / 1024).toFixed(0)} Ko`);
