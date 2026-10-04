/** Démo « Vie sonore » : zéro JS côté descripteur. */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/shader";
import "../src/addons/audio";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import descriptor from "./vie-sonore.sdui.json";
import texts from "./vie-sonore.texts.json";

(window as unknown as Record<string, unknown>).__get = get;
set("t", texts);
set("demo", descriptor);
document.title = "ready";
