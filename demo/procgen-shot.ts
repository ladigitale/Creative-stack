/** Banc visuel procgen (sans Concorde) : ?scene=…&style=…&camera=…&seed=…&t=… → rendu, puis window.__ready. */
import { composeScene } from "../src/addons/procgen/scene/compose";
import { SCENES } from "../src/addons/procgen/scene/library";
import { resolveStyle } from "../src/addons/procgen/style/style";
import { ProcgenView } from "../src/addons/procgen/render/view";

const q = new URLSearchParams(location.search);
const name = q.get("scene") ?? "village";
const recipe = q.get("recipe") ? JSON.parse(q.get("recipe")!) : SCENES[name];
const t0 = performance.now();
const model = composeScene({ recipe, seed: q.get("seed") ?? 1 });
const ms = performance.now() - t0;
const view = new ProcgenView(document.getElementById("c") as HTMLCanvasElement);
view.dpr = 1;
view.maxDpr = 1;
view.setModel(model);
view.setStyle(resolveStyle(q.get("style") ? (q.get("style")!.startsWith("{") ? JSON.parse(q.get("style")!) : q.get("style")) : model.style ?? "gouache"));
const v: Record<string, unknown> = { ...(model.view ?? {}) };
for (const k of ["camera", "yaw", "pitch", "zoom", "cx", "cy", "cz"]) if (q.get(k) !== null) v[k] = isNaN(Number(q.get(k))) ? q.get(k) : Number(q.get(k));
view.setView(v);
view.setAnim({ play: q.get("play") !== "0" });
if (q.get("actors")) view.setActors(JSON.parse(q.get("actors")!));
(window as any).__view = view;
const wait = Number(q.get("t") ?? 1.5);
setTimeout(() => {
  view.render();
  (window as any).__stats = { compose: Math.round(ms), ...view.stats(), ...model.stats, issues: model.issues.slice(0, 8) };
  (window as any).__ready = true;
}, wait * 1000);
