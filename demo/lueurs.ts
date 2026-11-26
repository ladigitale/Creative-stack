/** Démo locale de l'artefact Lueurs : stores et transforms du document montés à la main (le viewer Artefacts le fait en prod). */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/2d";
import "../src/addons/swarm";
import "../src/addons/shader";
import "../src/addons/sound";
import "../src/addons/controller";
import "../src/addons/device";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import doc from "./lueurs.sdui.json";

const d = doc as any;
set("jour", new Date().toISOString().slice(0, 10));
set("reglages", { pixel: "non", son: "non" });
const host = document.getElementById("stores")!;
for (const [id, def] of Object.entries<any>(d.data.stores)) {
  const s = document.createElement("sonic-store");
  s.id = id;
  s.setAttribute("dataProvider", id);
  s.setAttribute("initial", JSON.stringify(def.initial));
  s.setAttribute("reducer", def.reducer);
  s.setAttribute("budget-ms", String(def.budgetMs ?? 8));
  s.setAttribute("max-state-bytes", String(def.maxStateBytes ?? 262144));
  host.appendChild(s);
}
(window as any).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
set("demo", d.views[0].root);
document.title = "ready";
