/**
 * Export SVG : mêmes formes et même résolution de peinture que le rendu Canvas. Document autonome, sans script ni
 * ressource externe (dégradé de ciel, motifs de hachures / trame, ombre portée des plans en filtre).
 */
import type { SceneModel } from "../scene/compose";
import { ActorSim } from "./actors";
import { Painter, strokeScale } from "./paint";
import { VectorScene, mergeSorted, type ViewOpts } from "./scene";
import { PATH_UNIT, type Shape } from "./shape";
import { type Inks, type VectorStyle, makeInks, resolveVectorStyle } from "./vstyle";

export type SvgFrame = { width: number; height: number; scale: number; cu: number; cv: number };

const HEXRE = /^#[0-9a-f]{6}$/i;
const col = (c: string | null) => (c && HEXRE.test(c) ? c : "none");
const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** Écrit un document SVG à partir de formes triées. */
export function renderSVG(shapes: Shape[], vs: VectorStyle, inks: Inks, f: SvgFrame): string {
  const painter = new Painter(vs, inks);
  const k = strokeScale(f.scale);
  const tx = f.width / 2 - f.cu * f.scale, ty = f.height / 2 + f.cv * f.scale;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}">`);
  const hatchStep = (4.5 * PATH_UNIT) / f.scale;
  out.push(
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col(inks.sky.top)}"/><stop offset="1" stop-color="${col(inks.sky.horizon)}"/></linearGradient>` +
      `<pattern id="h1" patternUnits="userSpaceOnUse" width="${num(hatchStep)}" height="${num(hatchStep)}" patternTransform="rotate(45)"><rect width="${num(hatchStep * 0.22)}" height="${num(hatchStep)}" fill="${col(inks.ink)}"/></pattern>` +
      `<pattern id="h2" patternUnits="userSpaceOnUse" width="${num(hatchStep)}" height="${num(hatchStep)}" patternTransform="rotate(45)"><rect width="${num(hatchStep * 0.22)}" height="${num(hatchStep)}" fill="${col(inks.ink)}"/><rect width="${num(hatchStep)}" height="${num(hatchStep * 0.22)}" fill="${col(inks.ink)}"/></pattern>` +
      `<pattern id="dt" patternUnits="userSpaceOnUse" width="${num(hatchStep * 1.3)}" height="${num(hatchStep * 1.3)}" patternTransform="rotate(30)"><circle cx="${num(hatchStep * 0.65)}" cy="${num(hatchStep * 0.65)}" r="${num(hatchStep * 0.28)}" fill="${col(inks.ink)}"/></pattern>` +
      (vs.papercut > 0 ? `<filter id="pc" x="-5%" y="-5%" width="110%" height="115%"><feDropShadow dx="0" dy="${num(vs.papercut * 0.25)}" stdDeviation="${num(vs.papercut * 0.5)}" flood-color="#000" flood-opacity="0.35"/></filter>` : "") +
      `</defs>`,
  );
  out.push(`<rect width="${f.width}" height="${f.height}" fill="url(#sky)"/>`);
  out.push(`<g transform="matrix(${num(f.scale / PATH_UNIT)} 0 0 ${num(-f.scale / PATH_UNIT)} ${num(tx)} ${num(ty)})" stroke-linejoin="round" stroke-linecap="round">`);
  let layer = -1;
  const halos = new Map<string, string>();
  for (const s of shapes) {
    if (vs.papercut > 0 && s.layer > layer) {
      if (layer >= 0) out.push("</g>");
      out.push(`<g filter="url(#pc)">`);
      layer = s.layer;
    }
    const p = painter.paint(s);
    const attrs: string[] = [`d="${s.d}"`];
    const tk = s.t ? s.t[0] : 1;
    if (s.t) attrs.push(`transform="matrix(${num(s.t[0])} 0 0 ${num(s.t[0])} ${num(s.t[1] * PATH_UNIT)} ${num(s.t[2] * PATH_UNIT)})"`);
    let fill = p.fill ? col(p.fill) : p.hatch ? `url(#h${p.hatch})` : "none";
    if (p.halo && p.fill) {
      let id = halos.get(p.fill);
      if (!id) {
        id = `g${halos.size}`;
        halos.set(p.fill, id);
        out.push(`<defs><radialGradient id="${id}"><stop offset="0" stop-color="${col(p.fill)}"/><stop offset="0.35" stop-color="${col(p.fill)}" stop-opacity="0.45"/><stop offset="1" stop-color="${col(p.fill)}" stop-opacity="0"/></radialGradient></defs>`);
      }
      fill = `url(#${id})`;
    }
    attrs.push(`fill="${fill}"`);
    if (p.alpha < 1) attrs.push(`opacity="${num(p.alpha)}"`);
    if (p.blend !== "normal") attrs.push(`style="mix-blend-mode:${p.blend}"`);
    if (p.stroke) attrs.push(`stroke="${col(p.stroke)}" stroke-width="${num((p.strokePx * k * PATH_UNIT) / (f.scale * tk))}"`);
    out.push(`<path ${attrs.join(" ")}/>`);
    const tr = s.t ? ` ${attrs[1]}` : "";
    if (p.fill && p.hatch) out.push(`<path d="${s.d}"${tr} fill="url(#h${p.hatch})" opacity="${num(0.55 * p.alpha)}"/>`);
    if (p.dots && p.fill) out.push(`<path d="${s.d}"${tr} fill="url(#dt)" opacity="${num(0.22 * vs.halftone)}"/>`);
  }
  if (layer >= 0) out.push("</g>");
  out.push("</g></svg>");
  return out.join("");
}

/** Cadrage par défaut d'une scène (échelle d'ajustement et centre). */
export function fitFrame(scene: VectorScene, width: number, height: number, zoom = 1): SvgFrame {
  const m = scene.model, pr = scene.pr;
  const W = m.size[0], D = m.size[1];
  let vTop = -Infinity, vBot = Infinity;
  for (const o of m.objects) vTop = Math.max(vTop, pr.p(o.pos[0], o.pos[1] + o.height, o.pos[2])[1]);
  for (const a of m.actors) vTop = Math.max(vTop, pr.p(a.pos[0], a.pos[1] + a.asset.height, a.pos[2])[1]);
  vBot = pr.p(0, m.bounds.min[1] + 0.5, D / 2)[1] - 0.5;
  const farTop = pr.p(0, 0, -D / 2)[1] + 6;
  if (!Number.isFinite(vTop)) vTop = farTop;
  vTop = Math.max(vTop, farTop);
  const spanU = W + Math.abs(pr.ax) * D, spanV = vTop - vBot + 1;
  const s0 = Math.min(width / (spanU * 0.8), height / (spanV * 1.08));
  // bas de la scène calé près du bord inférieur : la marge va au ciel
  const cv = Math.max((vTop + vBot) / 2, vBot + (height * 0.47) / s0);
  return { width, height, scale: s0 * zoom, cu: 0, cv };
}

/** Export SVG d'une scène (personnages dans leur pose de départ). */
export function toSVG(model: SceneModel, style: unknown, view: Partial<ViewOpts> & { width?: number; height?: number; zoom?: number; cx?: number; cy?: number; cz?: number } = {}): string {
  const vs = resolveVectorStyle(style ?? model.style ?? "flat");
  const inks = makeInks(vs);
  const scene = new VectorScene(model, { camera: view.camera ?? "side", lift: view.lift, angle: view.angle, k: view.k }, { lightElevation: vs.tokens.lightElevation });
  const sim = new ActorSim();
  sim.setModel(model);
  const st = scene.staticShapes(vs.tokens.night).shapes;
  const dyn = scene.dynamicShapes(0, vs.tokens.night, sim.poses(), sim.ballPoses());
  const f = fitFrame(scene, view.width ?? 1280, view.height ?? 720, view.zoom ?? 1);
  if (Number.isFinite(view.cx) || Number.isFinite(view.cy) || Number.isFinite(view.cz)) {
    const [u, v] = scene.pr.p(Number(view.cx ?? 0), Number(view.cy ?? 0), Number(view.cz ?? 0));
    f.cu = u;
    f.cv = v;
  }
  return renderSVG(mergeSorted(st, dyn), vs, inks, f);
}
