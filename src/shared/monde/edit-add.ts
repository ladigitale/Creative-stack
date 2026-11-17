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
  // décoration murale ajoutée sans hauteur (cadre, poster) : accrochée vers 1,2 m plutôt qu'au ras du sol
  const base = String(entry.model).split("~")[0];
  const pf = Object.prototype.hasOwnProperty.call(m.prefabs, base) ? m.prefabs[base] : null;
  const inst = d.instances.get(name);
  const hasY = Array.isArray(entry.at) && entry.at.length >= 3;
  // applique : vers 1,7 m
  if (inst && pf?.pose === "mur" && !hasY && inst.t.y < 0.05) {
    if (pf.famille === "decoration") inst.t.y = WALL_DECO_Y;
    else if (pf.famille === "luminaire") inst.t.y = WALL_LAMP_Y;
  }
  const res = d.arrangeTo(name, x, z, 0);
  if (!res) return next;
  return mondePlace(next, placedInfo(name, res, d.bodies(), m.unit));
}

/** Hauteur (m) du bas d'une décoration murale ajoutée sans hauteur. */
export const WALL_DECO_Y = 1.2;
/** Hauteur (m) du bas d'une applique ajoutée sans hauteur. */
export const WALL_LAMP_Y = 1.7;

/**
 * `$mondeTurn($monde, nom, degrés?, src?)` : tourne l'objet sur place (quart de tour par défaut) puis le range comme
 * un glisser au même point avec ce cap (place libre la plus proche s'il gêne), et garde la pose dans le monde.
 */
export function mondeTurn(monde: unknown, name: unknown, deg?: unknown, src?: unknown): unknown {
  if (!isObj(monde) || typeof name !== "string" || !name) return monde;
  const m = readMonde(monde);
  const d = new MondeDriver();
  d.setMonde(m, 0);
  d.step(0);
  // objet nommé d'office : retrouvé par le rang de son entrée
  const id = d.instances.has(name) ? name : [...d.instances.values()].find((i) => i.placement.src === src)?.name ?? "";
  const inst = id ? d.instances.get(id) : undefined;
  if (!inst || !d.movable(id)) return monde;
  const step = typeof deg === "number" && isFinite(deg) ? deg : 90;
  const res = d.arrangeTo(id, inst.t.x, inst.t.z, 0, 0, "inOut", { ry: inst.t.ry + (step * Math.PI) / 180 });
  if (!res) return monde;
  return mondePlace(monde, placedInfo(id, res, d.bodies(), m.unit));
}
