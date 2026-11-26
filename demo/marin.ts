/** Démo du préréglage monde2d `marin` : chaque espèce vue de dessus (rangée du haut) et de profil (rangée du bas). */
import "@supersoniks/concorde/index";
import "../src/addons/interactive";
import "../src/addons/2d";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";

const especes = ["poisson", "banc", "requin", "meduse", "anguille", "raie", "plongeur"];
const models: Record<string, unknown> = {};
const place: unknown[] = [];
especes.forEach((espece, i) => {
  for (const [j, vue] of ["dessus", "profil"].entries()) {
    const id = `${espece}-${vue}`;
    models[id] = { preset: "marin", seed: 3, params: { espece, vue, taille: espece === "banc" ? 30 : espece === "requin" ? 110 : 70 } };
    place.push({ model: id, name: id, at: [70 + i * 125, 110 + j * 200] });
  }
});
set("aquarium", { monde2d: { ciel: ["#0c4a6e", "#020617"], style: "doux", models, place } });
(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
set("demo", { nodes: [{ tagName: "sonic-2d", attributes: { dataProvider: "aquarium", width: "900", height: "420", "out-data-provider": "aquariumOut" } }] });
document.title = "ready";
