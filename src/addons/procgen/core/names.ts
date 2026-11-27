/**
 * Noms générés : villes et villages, commerces, joueurs. Le texte vaut « auto » par défaut dans les générateurs qui
 * écrivent (enseignes, panneaux, maillots) : la graine choisit alors un nom plausible, toujours le même pour la même
 * graine. Listes génériques (racines toponymiques, noms de famille très répandus) : aucune marque, aucune personne.
 */
import type { Rng } from "./rng";
import { PROP_FONTS, SIGN_FONTS, pickFont } from "../fonts/index";

const ROOTS = ["Beau", "Bel", "Mont", "Roche", "Fon", "Clair", "Mar", "Lan", "Pont", "Val", "Bois", "Champ", "Bourg", "Ver", "Mor", "Bran", "Cour", "Pré", "Lou", "Bel-Air", "Haut", "Ros", "Cha", "Gué", "Mai", "Ker", "Ville", "Lor", "Sar"];
const SUFFIXES = ["ac", "ville", "court", "y", "ières", "ange", "heim", "mont", "val", "fort", "lieu", "bourg", "ière", "ay", "oux", "eilles", "agne", "is", "on", "ain"];
const SAINTS = ["Martin", "Jean", "Pierre", "Clair", "Rémy", "Agathe", "Hilaire", "Germain", "Brice", "Lucie", "Aubin", "Cyr", "Malo", "Gilles", "Anne", "Denis"];
const RIVERS = ["Loire", "Vienne", "Marne", "Lys", "Orne", "Aure", "Dives", "Cher", "Ain", "Meuse", "Sèvre", "Vire", "Mer", "Rive", "Lande"];
const ADJ = ["Grand", "Petit", "Vieux", "Haut", "Bas", "Neuf", "Beau"];
const SURNAMES = ["Martin", "Bernard", "Dubois", "Moreau", "Laurent", "Lefèvre", "Roux", "Fournier", "Girard", "Bonnet", "Mercier", "Blanc", "Garnier", "Faure", "Rousseau", "Morel", "Perrin", "Lambert", "Fontaine", "Chevalier", "Robin", "Masson", "Gauthier", "Picard", "Renard", "Brun", "Barbier", "Leroy", "Colin", "Vidal", "Caron", "Meunier", "Boyer", "Clément", "Royer", "Lemaire", "Marchand", "Duval", "Benoît", "Arnaud"];
const FIRST = ["Jean", "Louise", "Paul", "Marie", "Léon", "Rose", "Jules", "Alice", "Lucien", "Jeanne", "Marcel", "Odette", "Henri", "Lili", "Max", "Zoé", "Nino", "Inès", "Sam", "Lina"];
const PLACES = ["du Port", "de la Place", "des Amis", "du Marché", "de la Gare", "du Centre", "de l'Église", "du Pont", "des Halles", "du Coin", "de la Mairie", "du Lac", "des Arts", "du Parc"];
const GOOD = ["Au Bon Pain", "Au Petit Bonheur", "À la Bonne Heure", "Au Panier Fleuri", "Au Coin Gourmand", "Le Bon Accueil", "La Belle Époque", "Le Petit Zinc", "Au Bon Coin", "La Bonne Table"];

/** Métiers (enseigne en façade). */
export const TRADES = ["boulangerie", "patisserie", "cafe", "bar", "restaurant", "hotel", "epicerie", "librairie", "fleuriste", "boucherie", "fromagerie", "poissonnerie", "pharmacie", "coiffeur", "quincaillerie", "tabac", "cinema", "banque", "poste", "garage"] as const;
const TRADE_LABEL: Record<string, string> = {
  boulangerie: "Boulangerie", patisserie: "Pâtisserie", cafe: "Café", bar: "Bar", restaurant: "Restaurant", hotel: "Hôtel", epicerie: "Épicerie", librairie: "Librairie", fleuriste: "Fleuriste", boucherie: "Boucherie", fromagerie: "Fromagerie", poissonnerie: "Poissonnerie", pharmacie: "Pharmacie", coiffeur: "Coiffure", quincaillerie: "Quincaillerie", tabac: "Tabac", cinema: "Cinéma", banque: "Banque", poste: "Poste", garage: "Garage",
};

/** Nom de ville ou de village. */
export function townName(r: Rng): string {
  const root = r.pick(ROOTS);
  const one = () => (root.includes("-") ? root : root + r.pick(SUFFIXES));
  switch (r.weighted([["plain", 5], ["saint", 2], ["river", 2], ["adj", 1], ["the", 1]] as const)) {
    case "saint":
      return `Saint-${r.pick(SAINTS)}${r.chance(0.35) ? `-sur-${r.pick(RIVERS)}` : ""}`;
    case "river":
      return `${one()}-sur-${r.pick(RIVERS)}`;
    case "adj":
      return `${r.pick(ADJ)}-${one()}`;
    case "the":
      return `Le ${one()}`;
  }
  return one();
}

export const surname = (r: Rng) => r.pick(SURNAMES);

/** Métier tiré au sort (enseigne). */
export const pickTrade = (r: Rng) => r.pick(TRADES as readonly string[]);

/** Enseigne d'un commerce : métier seul, métier et nom, « Café du Port », « Chez Louise », « Au Bon Pain »… */
export function shopName(trade: string, r: Rng): string {
  const label = TRADE_LABEL[trade] ?? trade;
  const kind = r.weighted([["trade", 3], ["family", 3], ["place", trade === "cafe" || trade === "bar" || trade === "hotel" || trade === "restaurant" ? 4 : 1], ["chez", trade === "cafe" || trade === "bar" || trade === "restaurant" || trade === "coiffeur" ? 2 : 0.3], ["good", trade === "boulangerie" || trade === "restaurant" || trade === "epicerie" ? 1.5 : 0.3]] as const);
  switch (kind) {
    case "family":
      return `${label} ${surname(r)}`;
    case "place":
      return `${label} ${r.pick(PLACES)}`;
    case "chez":
      return `Chez ${r.pick(FIRST)}`;
    case "good":
      return r.pick(GOOD);
  }
  return label;
}

/** Nom de joueur pour un dos de maillot. */
export const playerName = (r: Rng) => r.pick(SURNAMES);

/**
 * Texte d'un paramètre `text` : « auto » (ou absent) → nom généré par `auto`, « none » ou vide → aucun texte, sinon le
 * texte tel quel.
 */
export function resolveText(v: unknown, auto: () => string): string {
  const s = typeof v === "string" ? v.trim() : v == null ? "auto" : String(v);
  if (s === "auto") return auto();
  if (s === "none") return "";
  return s;
}

const STREET_KIND = ["Rue", "Rue", "Rue", "Place", "Avenue", "Impasse", "Chemin", "Allée", "Quai"];
const STREET_OF = ["du Moulin", "des Lilas", "de l'Église", "des Écoles", "du Château", "des Peupliers", "de la Fontaine", "du Four", "des Vignes", "de la Paix", "du Marché", "des Tilleuls", "de la Gare", "du Lavoir", "des Roses", "de la Forge"];

/** Nom de rue : « Rue du Moulin », « Place des Tilleuls », « Rue Fontaine »… */
export function streetName(r: Rng): string {
  const k = r.pick(STREET_KIND);
  if (k === "Quai") return `Quai ${r.pick(["du Port", "des Pêcheurs", "de la Loire", "Saint-" + r.pick(SAINTS)])}`;
  return r.chance(0.25) ? `${k} ${r.pick(FIRST)} ${surname(r)}` : `${k} ${r.pick(STREET_OF)}`;
}

/** Texte de l'enseigne d'une boutique (même nom en 3D et en 2D pour une même graine). */
export function signText(p: Record<string, unknown>, rng: Rng): string {
  const trade = !p.trade || p.trade === "auto" ? pickTrade(rng.fork("métier")) : String(p.trade);
  return resolveText(p.sign, () => shopName(trade, rng.fork("enseigne"))).replace(/\\n/g, "\n");
}


/**
 * Texte d'un objet de décor qui en porte (même résultat en 3D et en 2D pour une même graine) : townsign (ville),
 * streetsign (rue), signpost (destinations « A|B »), billboard (affiche), hangingsign (mot de métier), milestone.
 */
export function propText(kind: string, v: unknown, rng: Rng, variant = 0): string {
  const t = typeof v === "string" ? v.replace(/\\n/g, "\n") : v;
  switch (kind) {
    case "townsign":
      return resolveText(t, () => townName(rng.fork("ville")));
    case "streetsign":
      return resolveText(t, () => streetName(rng.fork("rue")));
    case "signpost":
      return resolveText(t, () => Array.from({ length: 2 + (variant % 2) }, (_, i) => `${townName(rng.fork(`dir${i}`))} ${rng.fork(`km${i}`).int(1, 24)}`).join("|"));
    case "billboard":
      return resolveText(t, () => shopName(pickTrade(rng.fork("métier")), rng.fork("enseigne")).replace(" ", "\n"));
    case "hangingsign":
      return resolveText(t, () => rng.fork("mot").pick(["CAFÉ", "PAIN", "HÔTEL", "VINS", "THÉ", "BAR", "AUBERGE", "TABAC", "LIVRES", "FLEURS"]));
    case "milestone":
      return resolveText(t, () => String(rng.fork("borne").int(1, 40)));
  }
  return "";
}

/** Police de l'enseigne d'une boutique : donnée, ou tirée selon le style du bâtiment. */
export function signFont(p: Record<string, unknown>, rng: Rng): string {
  const st = String(p.style ?? "bourg");
  return pickFont(p.font, SIGN_FONTS[st] ?? SIGN_FONTS.bourg, (l) => rng.fork("police").pick(l));
}

/** Police d'un objet de décor qui écrit. */
export function propFont(kind: string, p: unknown, rng: Rng): string {
  return pickFont(p, PROP_FONTS[kind] ?? [], (l) => rng.fork("police").pick(l));
}
