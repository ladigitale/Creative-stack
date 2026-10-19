/** Démo « animation » : trois exemples zéro JS côté descripteur (`?ex=reveal|horloge|scrub`). */
import "@supersoniks/concorde/index";
import "../src/addons/animation";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { validateSduiAnimation } from "../src/addons/animation";
import reveal from "../src/addons/animation/examples/reveal-liste.sdui.json";
import horloge from "../src/addons/animation/examples/horloge-timeline.sdui.json";
import scrub from "../src/addons/animation/examples/scrub.sdui.json";

const examples = { reveal, horloge, scrub } as const;
const key = (new URLSearchParams(location.search).get("ex") ?? "reveal") as keyof typeof examples;
const descriptor = examples[key] ?? reveal;

(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
(window as unknown as Record<string, unknown>).__issues = validateSduiAnimation(descriptor);
set("demo", descriptor);
document.title = "ready";
