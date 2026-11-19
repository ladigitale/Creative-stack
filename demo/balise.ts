/** Démo « balise » : photographier une surface, la retrouver, y projeter du contenu. */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/shader";
import "../src/addons/media";
import "../src/addons/device";
import "../src/addons/anchor";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import descriptor from "../src/addons/anchor/examples/balise.sdui.json";

(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
set("demo", descriptor);
document.title = "ready";
