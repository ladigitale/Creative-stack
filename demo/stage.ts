/** Démo sonic-stage : la physique place des éléments HTML. */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/physics";
import "../src/addons/stage";
import "../src/addons/animation";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import descriptor from "../src/addons/stage/examples/billes-dom.sdui.json";

(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
set("demo", descriptor);
document.title = "ready";
