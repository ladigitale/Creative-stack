/**
 * Démo SDUI du système son : un `sonic-store` pilote `sonic-sound` par DataProvider,
 * exactement comme le ferait un artefact.
 */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/sound";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import bank from "../src/addons/sound/examples/neon-run.bank.json";
import descriptor from "./sound-demo.sdui.json";

(window as any).__get = get;
(window as any).__set = set;
set("bank", bank);
set("t", {
  title: "Sound lab",
  coin: "Pièce", jump: "Saut", hit: "Coup", boom: "Boum", power: "Bonus", win: "Victoire", lose: "Défaite",
  theme: "Thème", boss: "Boss", stop: "Stop", mute: "Muet", pause: "Pause",
  score: "Score", combo: "Combo", bar: "Mesure", beat: "Temps", music: "Musique", unlocked: "Son actif",
});
set("demo", descriptor);
document.title = "ready";
