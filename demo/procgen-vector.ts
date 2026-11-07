/**
 * Banc visuel du mode vectoriel (sans Concorde) :
 * ?scene=…&style=…&camera=side|oblique&zoom=…&cx=…&cy=…&cz=…&lift=…&actors=…&t=…&step=…&svg=1
 * → rendu, puis `window.__ready` et `window.__stats`.
 */
import { SCENES } from "../src/addons/procgen/scene/library";
import { composeVector } from "../src/addons/procgen/vector/compose";
import { VectorView } from "../src/addons/procgen/vector/view";

const q = new URLSearchParams(location.search);
const name = q.get("scene") ?? "village";
const recipe = q.get("recipe") ? JSON.parse(q.get("recipe")!) : SCENES[name];
const t0 = performance.now();
const model = composeVector({ recipe, seed: q.get("seed") ?? 1, params: q.get("params") ? JSON.parse(q.get("params")!) : undefined });
const ms = performance.now() - t0;
const canvas = document.getElementById("c") as HTMLCanvasElement;
const view = new VectorView(canvas);
view.maxDpr = Number(q.get("dpr") ?? 1);
view.dpr = view.maxDpr;
view.setModel(model);
const st = q.get("style") ?? "flat";
view.setStyle(st.startsWith("{") ? JSON.parse(st) : st);
const v: Record<string, unknown> = {};
for (const k of ["camera", "zoom", "cx", "cy", "cz", "lift", "actor"]) if (q.get(k) !== null) v[k] = isNaN(Number(q.get(k))) ? q.get(k) : Number(q.get(k));
view.setView(v);
view.setAnim({ play: q.get("play") !== "0" });
if (q.get("actors")) view.setActors(JSON.parse(q.get("actors")!));
if (q.get("step")) view.step(Number(q.get("step")));
(window as any).__view = view;
canvas.addEventListener("click", (e) => console.log(JSON.stringify(view.pick(e.clientX, e.clientY))));
const wait = Number(q.get("t") ?? 0.6);
setTimeout(() => {
  view.setAnim({ play: false });
  view.render();
  (window as any).__stats = { compose: Math.round(ms), ...view.stats(), objects: model.objects.length, actors: model.actors.length, issues: model.issues.slice(0, 5) };
  if (q.get("svg")) (window as any).__svg = view.toSVG();
  (window as any).__ready = true;
}, wait * 1000);
