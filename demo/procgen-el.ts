/** Banc du composant sonic-procgen (élément complet : DataProvider, chargement, état publié). ?scene=… ou ?football=… */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/procgen";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";

const q = new URLSearchParams(location.search);
set("monde", q.get("football") ? { football: JSON.parse(q.get("football")!) } : { scene: q.get("scene") ?? "village" });
(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
(window as unknown as Record<string, unknown>).__set = set;
set("demo", { nodes: [{ tagName: "sonic-procgen", attributes: { dataProvider: "monde", style: "display:block;height:100vh" } }] });
document.title = "ready";
