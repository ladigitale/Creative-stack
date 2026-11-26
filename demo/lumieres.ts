/** Démo de l'éclairage sonic-2d : une scène marine dans le noir, lumières fixes, qui suivent des instances, qui scintillent. */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/2d";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";

const especes = ["poisson", "requin", "meduse", "raie", "plongeur"];
const models: Record<string, unknown> = {};
const place: unknown[] = [];
especes.forEach((espece, i) => {
  const id = `${espece}`;
  models[id] = { preset: "marin", seed: 3, params: { espece, taille: espece === "requin" ? 120 : 70 } };
  place.push({ model: id, name: id, at: [110 + i * 170, 200 + (i % 2) * 60] });
});
set("aquarium", { monde2d: { ciel: ["#0c4a6e", "#020617"], style: "doux", models, place } });
set("eclairage", {
  ambient: "#0a1428",
  lights: [
    { name: "lampe", follow: "plongeur", r: 220, color: "#fde68a", intensity: 1.4, flicker: 0.4 },
    { name: "meduse", follow: "meduse", r: 120, color: "#a5b4fc", intensity: 1 },
    { name: "fond", x: 120, y: 380, r: 90, color: "#22d3ee", intensity: 0.8 },
  ],
});
(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
(window as unknown as Record<string, unknown>).__set = set;
set("demo", { nodes: [{ tagName: "sonic-2d", attributes: { dataProvider: "aquarium", lights: "eclairage", width: "900", height: "420", "out-data-provider": "aquariumOut" } }] });
document.title = "ready";
