/**
 * Démo « Premier son » : clavier → sonic-store → événements → sonic-patch.
 * Zéro JS côté descripteur : ce fichier ne fait que charger les addons et le SDUI.
 */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/audio";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import descriptor from "./audio-demo.sdui.json";
import texts from "./audio-demo.texts.json";

(window as unknown as Record<string, unknown>).__get = get;
set("t", texts);
set("demo", descriptor);
document.title = "ready";
