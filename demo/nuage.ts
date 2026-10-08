/** Démo « nuage » : zéro JS côté descripteur. */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/shader";
import "../src/addons/audio";
import "../src/addons/media";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import descriptor from "./nuage.sdui.json";
import texts from "./nuage.texts.json";

(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
set("t", texts);
set("demo", descriptor);
document.title = "ready";
