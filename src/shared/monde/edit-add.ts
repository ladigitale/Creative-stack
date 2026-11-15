/**
 * `$mondeAdd($monde, entrée, [x, z]?)` : ajoute un objet au monde écrit, à la place libre la plus proche du point
 * visé (centre de l'espace par défaut), avec l'appui de sa nature (mur, plafond, dessus d'un meuble, sol) — le même
 * rangement que le glisser (arrange.ts). Chargé à la demande par les réducteurs (il lit le monde complet).
 */
import { readMonde } from "./format";
import { MondeDriver } from "./driver";
import { placedInfo } from "./arrange";
import { freeName, mondePlace } from "./edit";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Monde avec l'entrée ajoutée (nommée `<modèle><n>` si elle n'a pas de nom) puis rangée ; tel quel si l'entrée est invalide. */
export function mondeAdd(monde: unknown, entry: unknown, at?: unknown): unknown {
  if (!isObj(monde) || !isObj(entry) || typeof entry.model !== "string" || !entry.model) return monde;
  const name = typeof entry.name === "string" && entry.name ? entry.name : freeName(monde, entry.model);
  const place = Array.isArray(monde.place) ? monde.place : [];
  const added: Obj = { ...entry, name };
  delete added.on;
  delete added.against;
  const next: Obj = { ...monde, place: [...place, added] };
  const m = readMonde(next);
  // point visé : donné (mètres), sinon centre du contour, sinon l'origine
  let x = 0, z = 0;
  if (Array.isArray(at) && typeof at[0] === "number" && typeof at[at.length - 1] === "number") [x, z] = [at[0], at[at.length - 1] as number];
  else if (m.contour?.length) {
    for (const [px, pz] of m.contour) {
      x += px / m.contour.length;
      z += pz / m.contour.length;
    }
  }
  const d = new MondeDriver();
  d.setMonde(m, 0);
  d.step(0);
  const res = d.arrangeTo(name, x, z, 0);
  if (!res) return next;
  return mondePlace(next, placedInfo(name, res, d.bodies(), m.unit));
}
