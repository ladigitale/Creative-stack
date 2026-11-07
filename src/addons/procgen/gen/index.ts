/** Registre des générateurs. `prop.lamp` est un raccourci pour `{ gen: "prop", params: { kind: "lamp" } }`. */
import { describeSchema } from "../core/schema";
import { animal } from "./animal";
import { assembly } from "./assembly";
import { ball } from "./ball";
import { building } from "./building";
import { character } from "./character";
import { bush, flowers, grass, rock, tree } from "./nature";
import { emblem, prop } from "./props";
import { plant } from "./plants";
import { seat } from "./seat";
import { vehicle } from "./vehicles";
import { wall } from "./wall";
import type { Generator } from "./types";

export const GENERATORS: Record<string, Generator> = Object.fromEntries(
  [character, animal, tree, bush, grass, flowers, rock, plant, building, prop, vehicle, wall, emblem, ball, seat, assembly].map((g) => [g.id, g as unknown as Generator]),
);

export function resolveGeneratorId(id: string): { gen: Generator | undefined; preset: Record<string, unknown> } {
  if (GENERATORS[id]) return { gen: GENERATORS[id], preset: {} };
  const dot = id.indexOf(".");
  if (dot > 0) {
    const g = GENERATORS[id.slice(0, dot)];
    if (g && "kind" in g.schema) return { gen: g, preset: { kind: id.slice(dot + 1) } };
    if (g && "species" in g.schema) return { gen: g, preset: { species: id.slice(dot + 1) } };
  }
  return { gen: undefined, preset: {} };
}

/** Catalogue lisible par un agent : générateurs, paramètres, ancres connues. */
export function generatorCatalog() {
  return Object.values(GENERATORS).map((g) => ({ id: g.id, label: g.label, doc: g.doc, tags: g.tags, params: describeSchema(g.schema) }));
}

export { animal, building, character, tree, bush, grass, flowers, rock, plant, prop, vehicle, wall, emblem, ball, seat, assembly };
