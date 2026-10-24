/** Démo sonic-2d : physique + parallaxe + caméra, sans JS côté descripteur. */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/physics";
import "../src/addons/2d";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import descriptor from "../src/addons/2d/examples/parallaxe.sdui.json";

(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
set("demo", descriptor);
document.title = "ready";
