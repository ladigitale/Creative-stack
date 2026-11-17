/**
 * Édition du JSON d'un `monde` écrit (celui du store), pour les réducteurs : `$mondePlace`, `$mondeRemove`,
 * `$mondeAdd` (edit-add.ts). Fonctions pures : elles rendent un nouveau monde, jamais ne modifient celui reçu.
 *
 * Un glisser ou `nodes.<instance>.move` publie `placed = {objectId, place, src, …}` ; `$mondePlace($state.monde,
 * $action.payload)` recopie cette pose dans l'entrée de l'objet, ce qui la rend durable (le monde relu la redonne).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Entrées qui produisent plusieurs objets : une pose d'objet ne peut pas s'y recopier. */
const MANY = ["stack", "grid", "scatter", "copies"];

/** Rang de l'entrée de `place` qui a produit l'objet `name` (`src` : rang connu par le rendu), -1 sinon. */
function entryOf(place: unknown[], name: string, src: unknown): number {
  const byName = place.findIndex((e) => isObj(e) && e.name === name);
  if (byName >= 0) return byName;
  if (typeof src === "number" && Number.isInteger(src) && src >= 0 && src < place.length) {
    const e = place[src];
    if (isObj(e) && !e.name) return src;
  }
  return -1;
}

/**
 * Recopie un résultat de rangement (`placed`, `payload` de l'action `place`) dans le monde : `on` / `against` /
 * `at` / `rot` de l'entrée de l'objet (clé `null` : retirée). Un objet nommé d'office (`bureau-lampe1`) reçoit ce
 * nom dans son entrée. Monde rendu tel quel si l'objet est introuvable ou vient d'une entrée à plusieurs copies.
 */
export function mondePlace(monde: unknown, placed: unknown): unknown {
  if (isObj(monde) && isObj(placed) && isObj(placed.ouverture)) return openingPlace(monde, placed.ouverture);
  if (!isObj(monde) || !isObj(placed) || !Array.isArray(monde.place)) return monde;
  const name = typeof placed.objectId === "string" ? placed.objectId : "";
  const keys = placed.place;
  if (!name || !isObj(keys)) return monde;
  const i = entryOf(monde.place, name, placed.src);
  if (i < 0) return monde;
  const e = monde.place[i] as Obj;
  if (MANY.some((k) => e[k] !== undefined)) return monde;
  const next: Obj = { ...e };
  if (!next.name) next.name = name;
  for (const k of ["on", "against", "at", "rot"]) {
    if (!(k in keys)) continue;
    if (keys[k] === null) delete next[k];
    else next[k] = keys[k];
  }
  const place = monde.place.slice();
  place[i] = next;
  return { ...monde, place };
}

/** Ouverture glissée (`placed.ouverture = {index, bord, at}`) : son `bord` et son `at` dans `monde.ouvertures`. */
function openingPlace(monde: Obj, o: Obj): unknown {
  const list = monde.ouvertures;
  const i = o.index;
  if (!Array.isArray(list) || typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= list.length || !isObj(list[i])) return monde;
  if (typeof o.bord !== "number" || typeof o.at !== "number" || !Number.isFinite(o.at)) return monde;
  const ouvertures = list.slice();
  ouvertures[i] = { ...(list[i] as Obj), bord: o.bord, at: o.at };
  return { ...monde, ouvertures };
}

/**
 * Rang dans `monde.ouvertures` de l'ouverture nommée `name` : son `name`, sinon `<type|model><n>` dans l'ordre de la
 * liste (les noms que leur donne l'espace) ; -1 si aucune.
 */
export function openingIndex(monde: unknown, name: string): number {
  if (!isObj(monde) || !Array.isArray(monde.ouvertures)) return -1;
  const counters: Record<string, number> = {};
  return monde.ouvertures.findIndex((o) => {
    if (!isObj(o)) return false;
    const model = typeof o.model === "string" ? o.model : typeof o.type === "string" ? o.type : "";
    const c = (counters[model] = (counters[model] ?? -1) + 1);
    return (typeof o.name === "string" && o.name ? o.name : `${model}${c}`) === name;
  });
}

/** Réglages d'une ouverture glissable (porte, fenêtre) : dans ses `params`, sauf sa taille (le mur est percé d'après elle). */
function openingParams(monde: Obj, name: string, params: Obj): unknown {
  const i = openingIndex(monde, name);
  if (i < 0) return monde;
  const list = monde.ouvertures as unknown[];
  const o = list[i] as Obj;
  const ps: Obj = { ...(isObj(o.params) ? o.params : {}) };
  for (const [k, v] of Object.entries(params)) {
    if (k === "largeur" || k === "hauteur") continue;
    if (v === null) delete ps[k];
    else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") ps[k] = v;
  }
  const ouvertures = list.slice();
  ouvertures[i] = { ...o, params: ps };
  return { ...monde, ouvertures };
}

/** Appui nommé d'une entrée (`on` ou `against`, sans `@surface`), vide sinon. */
function supportOf(e: Obj): string {
  const v = typeof e.on === "string" && e.on !== "sol" ? e.on : typeof e.against === "string" ? e.against : "";
  return v.split("@")[0];
}

/**
 * Retire l'objet `name` du monde, et ce qui est posé dessus (de proche en proche : la lampe part avec le bureau).
 * `src` (rang de l'entrée, comme dans `placed`) retrouve un objet nommé d'office.
 */
export function mondeRemove(monde: unknown, name: unknown, src?: unknown): unknown {
  if (!isObj(monde) || !Array.isArray(monde.place) || typeof name !== "string" || !name) return monde;
  const i = entryOf(monde.place, name, src);
  if (i < 0) return monde;
  const gone = new Set<number>([i]);
  const names = new Set<string>([name]);
  for (let again = true, pass = 0; again && pass < 8; pass++) {
    again = false;
    monde.place.forEach((e, k) => {
      if (gone.has(k) || !isObj(e) || !names.has(supportOf(e))) return;
      gone.add(k);
      if (typeof e.name === "string" && e.name) names.add(e.name);
      again = true;
    });
  }
  return { ...monde, place: monde.place.filter((_, k) => !gone.has(k)) };
}

/** Nom libre pour un nouvel objet : `<base><n>` (lit1, lit2…). */
export function freeName(monde: unknown, base: string): string {
  const taken = new Set<string>();
  if (isObj(monde) && Array.isArray(monde.place)) for (const e of monde.place) if (isObj(e) && typeof e.name === "string") taken.add(e.name);
  const stem = base.replace(/[^\w-]/g, "") || "objet";
  let n = 1;
  while (taken.has(`${stem}${n}`)) n++;
  return `${stem}${n}`;
}

/**
 * Change des paramètres de prefab d'un objet (`{"largeur": 1.4, "couette": "#e07a5f"}` fusionnés dans son
 * `params` ; valeur `null` : paramètre retiré, retour au défaut). `src` retrouve un objet nommé d'office.
 */
export function mondeParams(monde: unknown, name: unknown, params: unknown, src?: unknown): unknown {
  if (!isObj(monde) || typeof name !== "string" || !name || !isObj(params)) return monde;
  const i = Array.isArray(monde.place) ? entryOf(monde.place, name, src) : -1;
  if (i < 0) return openingParams(monde, name, params);
  if (!Array.isArray(monde.place)) return monde;
  const e = monde.place[i] as Obj;
  const next: Obj = { ...e, params: { ...(isObj(e.params) ? e.params : {}) } };
  if (!next.name && !MANY.some((k) => e[k] !== undefined)) next.name = name;
  const ps = next.params as Obj;
  for (const [k, v] of Object.entries(params)) {
    if (v === null) delete ps[k];
    else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") ps[k] = v;
  }
  const place = monde.place.slice();
  place[i] = next;
  return { ...monde, place };
}
