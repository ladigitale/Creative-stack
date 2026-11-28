/** Banc du composant sonic-procgen (élément complet : DataProvider, chargement, état publié). ?scene=…, ?football=… ou ?race=… */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/procgen";
import { setProcgenCharacterWorkers } from "../src/addons/procgen/scene/char-pool";
import { dp, get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";

// ?workers=0 : personnages construits sur le fil principal (comparaison)
if (new URLSearchParams(location.search).get("workers") !== "0") setProcgenCharacterWorkers(() => new Worker(new URL("./procgen-tiles.worker.ts", import.meta.url), { type: "module" }));

const q = new URLSearchParams(location.search);
set("monde", q.get("football") ? { football: JSON.parse(q.get("football")!) } : q.get("race") ? { race: JSON.parse(q.get("race")!) } : q.get("monde") ? JSON.parse(q.get("monde")!) : { scene: q.get("scene") ?? "village" });
(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
(window as unknown as Record<string, unknown>).__set = set;
(window as unknown as Record<string, unknown>).__dp = dp;
set("demo", { nodes: [{ tagName: "sonic-procgen", attributes: { dataProvider: "monde", "state-out": "etat", style: "display:block;height:100vh" } }] });
document.title = "ready";
