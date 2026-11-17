/**
 * Format « monde » : description textuelle d'un monde complet (modèles articulés en primitives, palette,
 * animations, placement), lue telle quelle par `sonic-3d` et `sonic-2d` depuis un DataProvider (clé `monde`).
 *
 * Ce fichier ne fait que lire et normaliser (aucune géométrie, aucun rendu) : il transforme le JSON écrit par
 * un agent en structures plates et sûres (bornes, valeurs par défaut, problèmes signalés sans jamais lever).
 */
import { readHerbes, type HerbeField } from "./herbes";
import { readAmbiance, readGrade, readLumiere, GRADE0, type Grade, type Lumiere } from "./ambiance";
import { readBody, readPhysics, type BodySpec, type PhysicsSpec } from "./physique";
import { DEG, Rand, hash32 } from "./math";
import { PRESETS, type PresetOut } from "./presets";
import { readTex, type TexSpec } from "./textures";
import { GEN_ACTIONS, GEN_IDS, genVariants, GEN_ROLES, genPreset, isGenId, type GenRig } from "./gen";
import { expandPrefabs, hasExpr, type Matiere, type PrefabFormat, type PrefabInfo } from "./prefab";
import { boundsOf, DEFAULT_BOUNDS, inPolygon, localOn, surfaceNames, surfaceOf, turnY, type Box3, type Face, type From, type Surface } from "./supports";
import { expandEspace, type EspaceEdge, type EspaceOpening } from "./espace";
import { CATALOGUE } from "./catalogue";
import { findAll, type Obb } from "./collide";
import { readEmitters, type EmitterSpec } from "../sim/emitter";
import { readParticles, readVent, type ParticleSpec, type V3 as PV3 } from "../sim/particles";
import { readInfini, type InfiniSpec } from "./infini";

/* ------------------------------------------------------------------ JSON d'entrée */

export type ShapeKind = "box" | "sphere" | "capsule" | "cylinder" | "cone" | "torus" | "lathe" | "extrude" | "tube" | "plane";
export const SHAPES: ShapeKind[] = ["box", "sphere", "capsule", "cylinder", "cone", "torus", "lathe", "extrude", "tube", "plane"];

export type PartIn = {
  name?: string;
  parent?: string;
  /** Articulation (pivot) dans le repère du parent, en mètres. */
  at?: number[];
  /** Rotation de repos (degrés, ordre XYZ). */
  rot?: number[];
  /** Centre de la forme par rapport à l'articulation (repère de la pièce). */
  off?: number[];
  scale?: number | number[];
  role?: string;
  /** Couleur fixe (prioritaire sur le rôle). */
  color?: string;
  /** `x` : pièce dédoublée en `<nom>L` (telle quelle) et `<nom>R` (symétrique en x). */
  mirror?: "x";
  /** Répétition : `n` copies `<nom>0…`, chacune décalée de `at` et tournée de `rot` (degrés) depuis la précédente. */
  repeat?: { n?: number; at?: number[]; rot?: number[] };
  hidden?: boolean;
  /** Pièce lumineuse (0 à 1) : reflet, lampe, écran. */
  glow?: number;
  /** Texture : `"rayures"` ou `{kind, color2, scale, angle, contrast}` (voir textures.ts). */
  tex?: unknown;
  /** Matière du nuancier (`materiaux` du monde ou matières de base) : donne couleur, texture et éclat à la pièce. */
  matiere?: string;
  /**
   * Surface d'appui : la pièce reçoit les objets posés par `on: "<instance>@<nom>"` (`top` par défaut). Texte = nom
   * (dessus de la pièce) ; objet `{name, face, from}` : `face` `top` | `+z` (face verticale, un mur) | `-y` (dessous, un
   * plafond), `from` `centre` | `origine` | `coin` (d'où `at` se compte).
   */
  surface?: string | { name?: string; face?: string; from?: string };
} & Partial<Record<ShapeKind, unknown>>;

/** Sous-modèle déplié dans un modèle (`use`) : ses pièces deviennent `<nom>_<pièce>`, sous une articulation `<nom>`. */
export type UseIn = {
  model?: string;
  name?: string;
  parent?: string;
  at?: unknown;
  rot?: unknown;
  scale?: unknown;
  /** Nombre de copies ; `i` (rang) et `n` (total) sont lisibles dans `at`, `rot`, `scale`, `params`. */
  repeat?: unknown;
  params?: Record<string, unknown>;
  slots?: Record<string, unknown>;
};

/** Emplacement d'un modèle : accepte un modèle de la famille `accepte`, garni par `default` sauf choix du placement. */
export type SlotIn = { accepte?: string; default?: string; parent?: string; at?: unknown; rot?: unknown; scale?: unknown };

export type TrackIn = Partial<Record<"rx" | "ry" | "rz" | "x" | "y" | "z" | "s", number[]>> & { sync?: boolean; phase?: number };

export type ClipIn = {
  ms?: number;
  loop?: boolean;
  /** Clip enchaîné à la fin d'un clip non bouclé (sinon il reste sur sa dernière clé). */
  then?: string;
  /** `smooth` (défaut, courbe douce) ou `linear`. */
  ease?: "smooth" | "linear";
  /** Modèle `gen` : action du moteur procgen jouée sous les pistes (`wave`, `cheer`, `kick`, `sit`…). */
  action?: string;
  /** Modèle `gen` : vitesse de locomotion procgen en m/s (0 = sur place ; 1.3 marche, 3.8 course). */
  speed?: number;
  tracks?: Record<string, TrackIn>;
};

export type ModelIn = {
  preset?: string;
  /** Générateur procgen (`character`, `animal.dog`, `tree`, `building`…) : forme, squelette et style procgen (3D). */
  gen?: string;
  seed?: string | number;
  /**
   * Arguments d'un préréglage ou d'un générateur, ou paramètres déclarés d'un prefab :
   * `{longueur: {default: 1.6, min: 0.8, max: 4, step: 0.2, unit: "m"}, teinte: {default: "#8b5a2b"}}` (voir prefab.ts).
   */
  params?: Record<string, unknown>;
  parts?: PartIn[];
  clips?: Record<string, ClipIn>;
  /** Clip joué par défaut par les instances nommées. */
  clip?: string;
  /** Sous-modèles dépliés dans celui-ci. */
  use?: UseIn[];
  /** Emplacements à garnir (abat-jour d'une lampe, tête d'un lit). */
  slots?: Record<string, SlotIn>;
  /** Catalogue : famille (`luminaire`, `lit`…), étiquettes, pose prévue (`sol`, `mur`, `plafond`, `dessus`), marge libre. */
  famille?: string;
  tags?: string[];
  pose?: string;
  degagement?: number;
  /** Objet souple (plante, coussin, tissu) : il peut frôler ses voisins sans que ce soit signalé comme une collision. */
  souple?: boolean;
  /**
   * Forme de collision : `"auto"` (défaut : une boîte par pièce), `"none"` (rien ne le touche), ou des formes
   * simples dans le repère du modèle, 8 au plus : `{box: [l, h, p], at?}`, `{sphere: r, at?}`, `{capsule: [r, h], at?}`.
   */
  collider?: unknown;
};

export type PlaceIn = {
  model?: string;
  /** Nom de l'instance : nœud pilotable (`nodes.<nom>`), pièces `<nom>_<pièce>`. Sans nom : décor statique, fusionné. */
  name?: string;
  at?: number[];
  rot?: number[];
  scale?: number | number[];
  roles?: Record<string, string>;
  clip?: string;
  hidden?: boolean;
  /** Grille `[nx, nz]` (ou `[nx, ny, nz]`) espacée de `step`. */
  grid?: number[];
  step?: number[];
  /** Semis de `scatter` copies dans `area` `[x0, z0, x1, z1]`. */
  scatter?: number;
  area?: number[];
  /** Désordre (part du pas) en position, rotation y aléatoire (degrés), échelle `[min, max]`. */
  jitter?: number;
  turn?: number;
  size?: number[];
  seed?: string | number;
  /**
   * Valeurs des paramètres du modèle pour ce placement : retouche des `params` d'un modèle `gen`
   * (`{ animal: "fox" }`) ou valeurs d'un prefab (`{ longueur: 2.4 }`, expressions par copie permises :
   * `"= pick(1.2, 1.6)"`, avec `i` et `n`).
   */
  params?: Record<string, unknown>;
  /** Prefab : garniture de ses emplacements (`{abatJour: "abatJourBoule"}`, `{model, params}`, `null` = vide). */
  slots?: Record<string, unknown>;
  /** Interne (écrit par la passe des prefabs) : modèle et rôles de chaque copie d'une grille ou d'un semis. */
  copies?: { model: string; roles?: Record<string, string> }[];
  /**
   * Appui : `"sol"` (base posée à la hauteur `at[1]`), `"<instance>"` ou `"<instance>@<surface>"` (posé sur le dessus
   * d'une instance nommée). Sur un appui, `at` vaut `[x, z]` depuis le centre de la surface, dans le repère de l'appui.
   */
  on?: string;
  /** Pile de `stack` copies les unes sur les autres. */
  stack?: number;
  /** Semis : écart minimal entre copies (au-delà de leur emprise). */
  spacing?: number;
  /** Semis : ne rien poser sur l'emprise de ces instances, modèles, familles ou étiquettes déjà placés. */
  avoid?: string[];
  /** `false` : pas d'ombre au sol sous cette instance (murs, sols ; automatique pour ce qui est posé sur un appui). */
  shadow?: boolean;
  /** Semis au sol : seulement à l'intérieur de ce polygone `[[x, z], …]`. */
  within?: number[][];
  /** Contre une face verticale (un mur) : `against: "mur0", at: 60` = base au sol, dos contre le mur, à 60 du coin gauche. */
  against?: string;
  /** Modèle `gen` : graine propre à ce placement (autre tirage du même modèle). */
  genSeed?: string | number;
  /** Étiquettes visées par les masques (émetteurs, requêtes, capteurs). */
  tags?: string[];
  /**
   * Capteur : zone qui détecte sans bloquer (ni collision, ni conflit) ; `target` reçoit `enter` / `leave` quand une
   * instance nommée y entre ou en sort.
   */
  sensor?: boolean;
  /** Corps rigide (physique 3D) : `"dynamique"`, `"statique"`, `"cinematique"` ou `{type, masse, friction, rebond, …}`. */
  corps?: unknown;
  body?: unknown;
};

export type MondeIn = {
  /**
   * Recherche des collisions entre objets posés (liste `conflicts`) : faite d'office dès que le monde a un `espace`
   * ou pose des objets (`on`, `against`, `stack`) ; `true` la force, `false` la coupe, `"montrer"` la force et
   * entoure de rouge à l'écran les objets en conflit.
   */
  collisions?: boolean | "montrer";
  /** Pièce ou parcelle : contour, bords (murs, clôtures) percés d'ouvertures, zones de sol, plafond (voir espace.ts). */
  espace?: unknown;
  /**
   * Ouvertures de l'espace écrites à part, chacune avec son `bord` (`[{type: "porte", bord: 3, at: 105}]`) : celles-ci
   * se glissent d'un mur à l'autre (drag), `$mondePlace` recopie leur `bord` et leur `at`.
   */
  ouvertures?: unknown[];
  /**
   * Images du monde, par nom : `{"poster1": "data:image/jpeg;base64,…"}` (png, jpeg ou webp, 12 au plus, 600 Ko
   * chacune) ; une pièce les affiche par `image: "poster1"` (prefab `poster` : `params.image`).
   */
  images?: Record<string, unknown>;
  /**
   * Émetteurs : copies d'un modèle qui naissent, bougent et meurent en jeu (projectiles `ballistic`, nuées `flock`),
   * pilotées par la clé DP `emit.<id>` (voir shared/sim/emitter.ts).
   */
  emitters?: Record<string, unknown>;
  /** Particules (feu, fumée, étincelles, pluie…) : préréglages et réglages, salves par la clé DP `fx.<id>`. */
  particles?: Record<string, unknown>;
  /** Vent du monde (m/s), suivi par les particules qui y sont sensibles. */
  vent?: number[];
  /** Monde infini : tuiles générées à la demande autour d'une instance (voir infini.ts). */
  infini?: unknown;
  /** Unité des longueurs écrites (pièces, placements, clips) : `m` (défaut), `cm` ou `mm`. `nodes` reste en mètres. */
  unite?: string;
  /** Nuancier de matières : `{chene: {color: "#b98a56", tex: "bois"}}`, lu par `matiere` des pièces. */
  materiaux?: Record<string, unknown>;
  palette?: Record<string, string>;
  models?: Record<string, ModelIn>;
  place?: PlaceIn[];
  /** `doux` (matière mate, défaut), `toon` (aplats), `brillant`. */
  look?: string;
  /**
   * Reflets de l'environnement (métal, verre, vernis) : `studio` (pièce lumineuse), `exterieur` (ciel et sol),
   * `aucun`. Par défaut : `studio` dès qu'une pièce a un fini qui reflète, sinon `aucun`.
   */
  environnement?: string;
  /**
   * Rendu « photo » (3D) : quand la vue ne bouge plus, l'image est recalculée en lancer de rayons progressif
   * (reflets, ombres douces, verre et lumière indirecte physiquement justes) ; tout mouvement rend la main au rendu
   * temps réel. `true` ou `{echantillons (200), rebonds (5), attente (ms, 600)}`.
   */
  photo?: boolean | { echantillons?: number; rebonds?: number; attente?: number; filtre?: string; tramage?: number | boolean; niveaux?: number; touche?: number; echelle?: number };
  /**
   * Physique 3D (Rapier, chargé à la demande) : `true` ou `{gravite, sol, contactMin, liaisons, pause}`. Les placements
   * nommés avec `corps` tombent, roulent, se heurtent ; le décor et les autres instances sont des obstacles.
   */
  physique?: unknown;
  physics?: unknown;
  /**
   * Direction artistique d'un mot (`realiste`, `militaire`, `cartoon`, `jouet`, `cyber`, `alien`, `silhouette`, `noir`,
   * `voxel`, `retro`, `horreur`, `western`, `pastel`, `onirique`) ou `{base, …}` : rendu, ciel, palette, style `gen`,
   * lumière et étalonnage (voir ambiance.ts). Ce que le monde écrit l'emporte.
   */
  ambiance?: unknown;
  /** Herbes hautes, blé, roseaux, prairies fleuries (3D) : `[{type, zone, densite, hauteur, pied, pointe, …}]`. */
  herbes?: unknown;
  /** Lumière : `{intensite, couleur, hauteur, azimut, ambiante, couleurAmbiante}`. */
  lumiere?: unknown;
  /** Étalonnage de l'image : `{saturation, contraste, teinte, noirEtBlanc, grain, vignette, pixel, silhouette, contours, halo…}`. */
  etalonnage?: unknown;
  /** Finesse des maillages : `low`, `mid` (défaut), `high`. */
  detail?: string;
  /** Vue 2D : `top`, `side`, `front`, `iso` ; `unit` px par mètre ; `origin` position écran de l'origine du monde. */
  view2d?: { view?: string; unit?: number; origin?: number[] };
  /** Ombres portées au sol (3D) et sous les pièces (2D). */
  shadows?: boolean;
  /** Contour sombre des silhouettes (2D). */
  outline?: number;
  /** Textures par rôle (`{"maillot": "rayures", "sol": {"kind": "herbe", "scale": 3}}`). */
  textures?: Record<string, unknown>;
  /** Texture de toutes les pièces sans texture propre (`grain` : rendu gouache). */
  texture?: unknown;
  /** Couleur du ciel (fond 3D ; en 2D, l'attribut `background` reste maître). */
  ciel?: string;
  /** Brume 3D (0 à 1) vers la couleur du ciel. */
  brume?: number;
  /** Style des modèles `gen` : préréglage procgen (`gouache`, `doux`, `bd`, `encre`, `aquarelle`…) ou jetons. */
  style?: unknown;
  /** Importance des traits (contours) des modèles `gen` : 0 aucun, 1 style, jusqu'à 3. */
  traits?: number;
};

/* ------------------------------------------------------------------ structures normalisées */

export type Shape = {
  kind: ShapeKind;
  /** Nombres de la forme (voir doc) ; `pts` pour lathe / extrude / tube. */
  a: number[];
  pts: number[][];
};

/**
 * Fini d'une matière : rugosité, métal, vernis (`clear`), reflet de tissu (`sheen`), opacité, verre (transmission,
 * `ior`), relief tiré de la texture. Tout est de 0 à 1 sauf `ior` (1 à 2,5).
 */
export type Finish = { rough: number; metal: number; clear: number; sheen: number; opacity: number; glass: number; ior: number; relief: number };

/** Finis prêts à l'emploi ; `{"fini": "verre", "rough": 0.3}` part d'un fini et en change une valeur. */
export const FINIS: Record<string, Partial<Finish>> = {
  mat: { rough: 0.9 },
  satine: { rough: 0.5 },
  brillant: { rough: 0.22, clear: 0.3 },
  laque: { rough: 0.12, clear: 1 },
  plastique: { rough: 0.4 },
  ceramique: { rough: 0.25, clear: 0.6 },
  metal: { metal: 1, rough: 0.35 },
  brosse: { metal: 1, rough: 0.55, relief: 0.2 },
  chrome: { metal: 1, rough: 0.04 },
  miroir: { metal: 1, rough: 0 },
  verre: { glass: 1, rough: 0.02, ior: 1.5 },
  depoli: { glass: 1, rough: 0.45, ior: 1.5 },
  eau: { glass: 0.9, rough: 0.05, ior: 1.33 },
  tissu: { rough: 0.95, sheen: 0.7, relief: 0.3 },
  velours: { rough: 1, sheen: 1, relief: 0.2 },
  cuir: { rough: 0.55, clear: 0.15, relief: 0.35 },
  caoutchouc: { rough: 0.9 },
  bois: { rough: 0.7, relief: 0.35 },
  pierre: { rough: 0.85, relief: 0.6 },
  cire: { rough: 0.35, clear: 0.3, sheen: 0.2 },
};

const FINISH0: Finish = { rough: -1, metal: 0, clear: 0, sheen: 0, opacity: 1, glass: 0, ior: 1.5, relief: 0 };

/** Lecture d'un fini : nom d'un fini prêt, ou objet (`fini` de départ et valeurs). `null` : aucun (rendu habituel). */
export function readFinish(v: unknown, issue: (m: string) => void): Finish | null {
  if (v === undefined || v === null) return null;
  const o = typeof v === "string" ? { fini: v } : v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o) {
    issue("nom de fini ou objet {fini, rough, metal, clear, sheen, opacity, glass, ior, relief} attendu");
    return null;
  }
  const out: Finish = { ...FINISH0 };
  if (typeof o.fini === "string") {
    if (Object.prototype.hasOwnProperty.call(FINIS, o.fini)) Object.assign(out, FINIS[o.fini]);
    else issue(`fini inconnu « ${o.fini} » (${Object.keys(FINIS).join(", ")})`);
  }
  for (const k of ["rough", "metal", "clear", "sheen", "opacity", "glass", "relief"] as const) {
    const x = o[k];
    if (typeof x === "number" && Number.isFinite(x)) out[k] = Math.min(1, Math.max(0, x));
  }
  if (typeof o.ior === "number" && Number.isFinite(o.ior)) out.ior = Math.min(2.5, Math.max(1, o.ior));
  return out;
}

/** Signature courte d'un fini (clé de cache des matières). */
export const finishKey = (f: Finish | null) => (f ? `${f.rough},${f.metal},${f.clear},${f.sheen},${f.opacity},${f.glass},${f.ior},${f.relief}` : "");

export type Part = {
  name: string;
  parent: number;
  at: [number, number, number];
  rot: [number, number, number];
  off: [number, number, number];
  scale: [number, number, number];
  role: string;
  color: string;
  shape: Shape | null;
  hidden: boolean;
  glow: number;
  tex: TexSpec | null;
  /** Fini (rugosité, métal, verre…) ; `null` : rendu habituel du style. */
  finish: Finish | null;
  /** Image du monde (`monde.images`) posée sur la face avant (+z) de la pièce, à sa taille ; vide : aucune. */
  image: string;
  /** Nom de surface d'appui (vide : aucune), face qui reçoit et origine de `at`. */
  surface: string;
  face: Face;
  from: From;
};

export type Track = { part: number; ch: number; keys: number[]; phase: number };

export type Clip = {
  name: string;
  ms: number;
  loop: boolean;
  then: string;
  smooth: boolean;
  tracks: Track[];
  /** Modèle `gen` : action procgen (vide = celle du nom du clip, voir GEN_MOTION). */
  action: string;
  /** Modèle `gen` : vitesse de locomotion (m/s), `null` = celle du nom du clip. */
  move: number | null;
};

export type Model = {
  name: string;
  /** Signature (JSON d'entrée normalisé) : un modèle inchangé n'est pas reconstruit. */
  sig: string;
  parts: Part[];
  clips: Map<string, Clip>;
  clip: string;
  /** Rôles utilisés par le modèle, couleur par défaut. */
  roles: Record<string, string>;
  /** Modèle procgen : générateur, paramètres, graine ; les pièces sont alors ses os (sans forme). */
  gen: GenSpec | null;
  /** Problèmes de lecture du modèle (redonnés quand il est réutilisé tel quel). */
  issues: Issue[];
  /** Forme de collision écrite (boîtes du modèle, en mètres) ; `"none"` : aucune ; absente : une boîte par pièce. */
  collider?: Obb[] | "none";
};

export type GenSpec = { id: string; params: Record<string, unknown>; seed: string; rig: GenRig };

export type Placement = {
  model: string;
  /** Vide : décor statique. */
  name: string;
  at: [number, number, number];
  rot: [number, number, number];
  scale: [number, number, number];
  roles: Record<string, string>;
  clip: string;
  hidden: boolean;
  /** Étiquettes écrites sur le placement. */
  tags?: string[];
  /** Capteur (voir `PlaceIn.sensor`). */
  sensor?: boolean;
  /** Corps rigide (instances nommées, voir physique.ts). */
  body?: BodySpec;
  /**
   * Posé sur une instance nommée : position dans le repère de l'appui (unités du modèle d'appui) et cap propre.
   * Une instance nommée ainsi posée suit son appui quand il bouge.
   */
  on?: { support: string; surface: string; local: [number, number, number]; yaw: number };
  /** Pas d'ombre au sol (voir `PlaceIn.shadow`). */
  noShadow?: boolean;
  /** Rang de l'entrée de `place` écrite qui l'a produit (-1 : murs, sols et plafond de l'`espace`). */
  src?: number;
};

/**
 * Pose à revoir : `hors-appui` (objet plus grand que sa surface, ou ramené dans son contour), `chevauchement` (deux
 * objets se pénètrent, ou un objet traverse un mur), `degagement` (objet dans le passage d'une porte ou devant une
 * fenêtre), `hors-espace` (objet hors du contour de la pièce). Voir collide.ts.
 */
export type Conflict = { a: string; b: string; type: "chevauchement" | "hors-appui" | "degagement" | "hors-espace" };

export type View2d = { view: "top" | "side" | "front" | "iso"; unit: number; origin: [number, number] };

export type Issue = { path: string; message: string };

export type PhotoSpec = {
  echantillons: number;
  rebonds: number;
  attente: number;
  /** Filtre de l'image calculée : `peinture` (Kuwahara anisotrope), `lisse` (débruitage qui garde les arêtes), vide : aucun. */
  filtre: "" | "peinture" | "lisse";
  /** Tramage avant la peinture (0 à 1) et niveaux par couleur. */
  tramage: number;
  niveaux: number;
  /** Rayon des touches de peinture (px). */
  touche: number;
  /** Échelle de calcul (0,25 à 1) : 0,5 en peinture, le filtre efface la différence. */
  echelle: number;
};

/** Réglages du rendu photo ; `null` : désactivé. */
export function readPhoto(v: unknown): PhotoSpec | null {
  if (v === undefined || v === null || v === false) return null;
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const n = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d);
  const f = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d);
  const filtre = o.filtre === "peinture" || o.filtre === "lisse" ? o.filtre : "";
  // filtré : peu d'échantillons et de rebonds suffisent (le filtre efface le bruit)
  return {
    echantillons: n(o.echantillons, filtre === "peinture" ? 12 : filtre === "lisse" ? 32 : 200, 1, 4000),
    rebonds: n(o.rebonds, filtre ? 3 : 5, 1, 12),
    attente: n(o.attente, 600, 0, 10000),
    filtre,
    tramage: o.tramage === true ? 0.6 : f(o.tramage, 0, 0, 1),
    niveaux: n(o.niveaux, 6, 2, 64),
    touche: f(o.touche, 5, 1, 12),
    echelle: f(o.echelle, filtre === "peinture" ? 0.5 : 1, 0.25, 1),
  };
}

export type Monde = {
  palette: Record<string, string>;
  models: Map<string, Model>;
  place: Placement[];
  look: "doux" | "toon" | "brillant";
  environnement: "studio" | "exterieur" | "aucun";
  /** Rendu photo (lancer de rayons à l'arrêt), `null` : temps réel seulement. */
  photo: PhotoSpec | null;
  /** Physique 3D, `null` : aucune. */
  physics: PhysicsSpec | null;
  /** Champs de brins instanciés (3D). */
  herbes: HerbeField[];
  /** Ambiance appliquée (nom), vide : aucune. */
  ambiance: string;
  /** Lumière réglée par l'ambiance ou `lumiere`, null : celle de la scène. */
  lumiere: Lumiere | null;
  /** Étalonnage de l'image, null : aucun. */
  grade: Grade | null;
  detail: number;
  view2d: View2d;
  shadows: boolean;
  outline: number;
  textures: Record<string, TexSpec>;
  texture: TexSpec | null;
  ciel: string;
  brume: number;
  /** Style procgen des modèles `gen` (préréglage ou jetons, lu par le rendu). */
  style: unknown;
  traits: number;
  /** Prefabs déclarés : paramètres, famille, emplacements, variantes construites. */
  prefabs: Record<string, PrefabInfo>;
  /** Poses à revoir (voir `Conflict`). */
  conflicts: Conflict[];
  /** `collisions: "montrer"` : boîtes des objets en conflit, à dessiner par le rendu. */
  marks: Obb[];
  /** Recherche des collisions : `non`, `oui` (liste `conflicts`), `montrer` (liste et arêtes rouges). */
  collide: "non" | "oui" | "montrer";
  /** Contour de l'`espace` en mètres (`null` sans espace) et facteur de l'unité du document vers le mètre. */
  contour: number[][] | null;
  /** Bords de l'espace où une ouverture peut glisser, et ouvertures posées par nom (voir espace.ts). */
  edges: EspaceEdge[];
  openings: Record<string, EspaceOpening>;
  /** Images valides de `images` (URL `data:`), par nom. */
  images: Record<string, string>;
  /** Émetteurs lus, modèles et variantes résolus (en mètres). */
  emitters: EmitterSpec[];
  /** Systèmes de particules lus (en mètres) et vent. */
  particles: ParticleSpec[];
  vent: PV3;
  /** Monde infini lu (en mètres), ou `null`. */
  infini: InfiniSpec | null;
  unit: number;
  issues: Issue[];
};

/** Canaux d'une piste : rotations (radians), translations (m), échelle. */
export const CHANNELS = ["rx", "ry", "rz", "x", "y", "z", "s"] as const;

export const LIMITS = {
  models: 64,
  partsPerModel: 160,
  placements: 4000,
  named: 400,
  /** Pièces dessinées au total (copies × pièces) et pièces des instances nommées (animées). */
  parts: 40000,
  namedParts: 6000,
  clipsPerModel: 32,
  keys: 32,
  points: 64,
} as const;

const DEFAULT_PALETTE: Record<string, string> = {
  peau: "#f2c29b",
  maillot: "#2563eb",
  short: "#1e293b",
  chaussure: "#111827",
  cheveux: "#3b2416",
  oeil: "#ffffff",
  pupille: "#111827",
  accent: "#facc15",
  bois: "#8b5a2b",
  feuillage: "#3f9d4a",
  pierre: "#9ca3af",
  metal: "#cbd5e1",
  sol: "#6b8f4e",
  eau: "#38bdf8",
  blanc: "#f8fafc",
  noir: "#0f172a",
};

/* ------------------------------------------------------------------ lecture */

/** Lecture d'une clé propre (jamais un membre hérité comme `constructor`). */
export function own<T>(o: Record<string, T> | undefined | null, k: string): T | undefined {
  return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clampN = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** Dimension de forme : positive, jamais nulle (normales finies), bornée. */
const dim = (v: number) => clampN(Math.abs(v), 1e-4, 1000);

function vec3(v: unknown, d: [number, number, number]): [number, number, number] {
  if (!Array.isArray(v)) return [...d];
  return [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])];
}

function scale3(v: unknown): [number, number, number] {
  if (typeof v === "number" && Number.isFinite(v)) return [v, v, v];
  return vec3(v, [1, 1, 1]);
}

export function isColor(s: unknown): s is string {
  return typeof s === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());
}

const safeColor = (s: unknown): string | undefined => (isColor(s) ? s : undefined);

function readSurface(v: PartIn["surface"]): { surface: string; face: Face; from: From } {
  const o = typeof v === "string" ? { name: v } : v && typeof v === "object" ? v : {};
  const face = o.face === "+z" || o.face === "-y" ? o.face : "top";
  const from = o.from === "origine" || o.from === "coin" ? o.from : "centre";
  return { surface: typeof o.name === "string" ? o.name.replace(/[^\w.-]/g, "") : "", face, from };
}

function readShape(p: PartIn, path: string, issues: Issue[]): Shape | null {
  const kinds = SHAPES.filter((k) => p[k] !== undefined);
  if (!kinds.length) return null;
  if (kinds.length > 1) issues.push({ path, message: `une seule forme par pièce (${kinds.join(", ")}) : ${kinds[0]} retenue` });
  const kind = kinds[0];
  const raw = p[kind];
  const arr = (v: unknown) => (Array.isArray(v) ? v : typeof v === "number" ? [v] : []);
  const nums = (v: unknown) => arr(v).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const ptsOf = (v: unknown, dim: number) =>
    (Array.isArray(v) ? v : [])
      .filter((q): q is number[] => Array.isArray(q) && q.length >= dim && q.slice(0, dim).every((x) => typeof x === "number" && Number.isFinite(x)))
      .slice(0, LIMITS.points)
      .map((q) => q.slice(0, dim));
  switch (kind) {
    case "box": {
      const a = nums(raw);
      return { kind, a: [dim(num(a[0], 1)), dim(num(a[1], a[0] ?? 1)), dim(num(a[2], a[0] ?? 1)), Math.max(0, num(a[3], 0))], pts: [] };
    }
    case "sphere": {
      const a = nums(raw);
      const r = dim(num(a[0], 0.5));
      return { kind, a: [r, dim(num(a[1], r)), dim(num(a[2], a[0] ?? r))], pts: [] };
    }
    case "capsule": {
      const a = nums(raw);
      return { kind, a: [dim(num(a[0], 0.2)), Math.max(0, num(a[1], 0.5))], pts: [] };
    }
    case "cylinder": {
      const a = nums(raw);
      const r = dim(num(a[0], 0.3));
      return { kind, a: [r, dim(num(a[1], 1)), dim(num(a[2], r))], pts: [] };
    }
    case "cone": {
      const a = nums(raw);
      return { kind: "cylinder", a: [dim(num(a[0], 0.3)), dim(num(a[1], 1)), 0], pts: [] };
    }
    case "torus": {
      const a = nums(raw);
      return { kind, a: [dim(num(a[0], 0.5)), dim(num(a[1], 0.1)), clampN(num(a[2], 360), 1, 360)], pts: [] };
    }
    case "plane": {
      const a = nums(raw);
      return { kind, a: [dim(num(a[0], 1)), dim(num(a[1], a[0] ?? 1))], pts: [] };
    }
    case "lathe": {
      const pts = ptsOf(raw, 2);
      if (pts.length < 2) {
        issues.push({ path, message: "lathe : au moins 2 points [rayon, y]" });
        return null;
      }
      return { kind, a: [], pts: pts.map(([r, y]) => [Math.abs(r), y]) };
    }
    case "extrude": {
      const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { pts: raw }) as { pts?: unknown; depth?: unknown };
      const pts = ptsOf(o.pts, 2);
      if (pts.length < 3) {
        issues.push({ path, message: "extrude : au moins 3 points [x, y] dans pts" });
        return null;
      }
      return { kind, a: [dim(num(o.depth, 0.1))], pts };
    }
    case "tube": {
      const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { pts: raw }) as { pts?: unknown; r?: unknown; r2?: unknown };
      const pts = ptsOf(o.pts, 3);
      if (pts.length < 2) {
        issues.push({ path, message: "tube : au moins 2 points [x, y, z] dans pts" });
        return null;
      }
      const r = dim(num(o.r, 0.05));
      return { kind, a: [r, dim(num(o.r2, r))], pts };
    }
  }
  return null;
}

function readModel(name: string, src: ModelIn, palette: Record<string, string>, ownPal: Record<string, string>, issues: Issue[]): Model {
  const path = `models.${name}`;
  let preset: PresetOut | null = null;
  let gen: GenSpec | null = null;
  if (src.gen !== undefined) {
    if (!isGenId(src.gen)) issues.push({ path: `${path}.gen`, message: `générateur inconnu « ${String(src.gen)} » (${GEN_IDS.join(", ")})` });
    else {
      const params = src.params && typeof src.params === "object" && !Array.isArray(src.params) ? { ...src.params } : {};
      const gp = genPreset(src.gen, params);
      preset = gp;
      gen = { id: src.gen, params, seed: `${src.seed ?? name}`, rig: gp.rig };
      if (src.preset !== undefined) issues.push({ path: `${path}.preset`, message: "ignoré : le modèle a déjà un générateur (gen)" });
      if (Array.isArray(src.parts) && src.parts.length) issues.push({ path: `${path}.parts`, message: "ignorées : un modèle gen n'a que ses os (pièces sans forme)" });
    }
  }
  if (!gen && typeof src.preset === "string") {
    const gen = own(PRESETS, src.preset);
    if (!gen) issues.push({ path: `${path}.preset`, message: `préréglage inconnu « ${src.preset} » (${Object.keys(PRESETS).join(", ")})` });
    else preset = gen.build(new Rand(`${src.seed ?? name}`), src.params ?? {});
  }
  // Pièces du préréglage puis pièces écrites (même nom = remplace, sinon ajoute)
  const inParts: PartIn[] = [...(preset?.parts ?? [])];
  for (const p of !gen && Array.isArray(src.parts) ? src.parts : []) {
    if (!p || typeof p !== "object") continue;
    const i = typeof p.name === "string" ? inParts.findIndex((q) => q.name === p.name) : -1;
    if (i >= 0) {
      // remplacement partiel : la forme écrite remplace toute forme du préréglage
      const base = { ...inParts[i] };
      if (SHAPES.some((k) => (p as PartIn)[k] !== undefined)) for (const k of SHAPES) delete base[k];
      inParts[i] = { ...base, ...p };
    } else inParts.push(p);
  }

  const parts: Part[] = [];
  const index = new Map<string, number>();
  const mirrors = new Map<string, [string, string]>();
  const repeats = new Map<string, string[]>();
  const pending: { part: Part; parentName: string }[] = [];

  const add = (p: Part, parentName: string, path2: string) => {
    if (parts.length >= LIMITS.partsPerModel) {
      issues.push({ path: path2, message: `plus de ${LIMITS.partsPerModel} pièces : ignorée` });
      return;
    }
    if (index.has(p.name)) {
      issues.push({ path: path2, message: `nom de pièce en double « ${p.name} »` });
      return;
    }
    index.set(p.name, parts.length);
    parts.push(p);
    pending.push({ part: p, parentName });
  };

  inParts.forEach((p, i) => {
    const path2 = `${path}.parts.${i}`;
    const base = typeof p.name === "string" && p.name ? p.name.replace(/[^\w-]/g, "") : `piece${i}`;
    const role = typeof p.role === "string" ? p.role : "";
    const color = isColor(p.color) ? p.color : "";
    const make = (nm: string, at: [number, number, number], rot: [number, number, number], off: [number, number, number]): Part => ({
      name: nm,
      parent: -1,
      at,
      rot,
      off,
      scale: scale3(p.scale),
      role,
      color,
      shape: readShape(p, path2, issues),
      hidden: p.hidden === true,
      glow: clampN(num(p.glow, 0), 0, 1),
      tex: readTex(p.tex, (message) => issues.push({ path: `${path2}.tex`, message })),
      finish: readFinish((p as { finish?: unknown }).finish, (message) => issues.push({ path: `${path2}.finish`, message })),
      image: typeof (p as { image?: unknown }).image === "string" ? ((p as { image: string }).image).slice(0, 64) : "",
      ...readSurface(p.surface),
    });
    const at = vec3(p.at, [0, 0, 0]);
    const rot = vec3(p.rot, [0, 0, 0]).map((v) => v * DEG) as [number, number, number];
    const off = vec3(p.off, [0, 0, 0]);
    const parentName = typeof p.parent === "string" ? p.parent : "";
    // l'enfant d'une pièce dédoublée est dédoublé aussi (main d'un bras, pupille d'un œil)
    if (p.mirror === "x" || (parentName && mirrors.has(parentName) && !index.has(parentName))) {
      add(make(`${base}L`, at, rot, off), parentName, path2);
      add(make(`${base}R`, [-at[0], at[1], at[2]], [rot[0], -rot[1], -rot[2]], [-off[0], off[1], off[2]]), parentName, path2);
      mirrors.set(base, [`${base}L`, `${base}R`]);
    } else if (p.repeat && typeof p.repeat === "object") {
      const n = clampN(Math.round(num(p.repeat.n, 2)), 1, 64);
      const dAt = vec3(p.repeat.at, [0, 0, 0]);
      const dRot = vec3(p.repeat.rot, [0, 0, 0]).map((v) => v * DEG);
      const names: string[] = [];
      for (let k = 0; k < n; k++) {
        const nm = `${base}${k}`;
        names.push(nm);
        add(
          make(nm, [at[0] + dAt[0] * k, at[1] + dAt[1] * k, at[2] + dAt[2] * k], [rot[0] + dRot[0] * k, rot[1] + dRot[1] * k, rot[2] + dRot[2] * k], off),
          parentName,
          path2,
        );
      }
      repeats.set(base, names);
    } else add(make(base, at, rot, off), parentName, path2);
  });

  // Parents (un parent dédoublé se résout du même côté : brasL → épauleL)
  for (const { part, parentName } of pending) {
    if (!parentName) continue;
    let pi = index.get(parentName);
    if (pi === undefined && mirrors.has(parentName)) {
      const side = part.name.endsWith("R") ? 1 : 0;
      pi = index.get(mirrors.get(parentName)![side]);
    }
    if (pi === undefined || pi === index.get(part.name)) {
      issues.push({ path: `${path}.parts.${part.name}`, message: `parent inconnu « ${parentName} »` });
      continue;
    }
    part.parent = pi;
  }
  // Les parents doivent précéder leurs enfants (ordre topologique, cycles cassés)
  const order: number[] = [];
  const state = new Uint8Array(parts.length);
  const visit = (i: number) => {
    if (state[i] === 2) return;
    if (state[i] === 1) {
      parts[i].parent = -1;
      issues.push({ path: `${path}.parts.${parts[i].name}`, message: "cycle de parents : pièce détachée" });
      return;
    }
    state[i] = 1;
    if (parts[i].parent >= 0) visit(parts[i].parent);
    state[i] = 2;
    order.push(i);
  };
  parts.forEach((_, i) => visit(i));
  const remap = new Map<number, number>();
  order.forEach((old, i) => remap.set(old, i));
  const sorted = order.map((old) => {
    const p = parts[old];
    return { ...p, parent: p.parent >= 0 ? remap.get(p.parent)! : -1 };
  });
  const idx = new Map(sorted.map((p, i) => [p.name, i]));

  // Clips
  const clips = new Map<string, Clip>();
  const ownClips = src.clips && typeof src.clips === "object" ? src.clips : {};
  const clipSrc: Record<string, ClipIn> = { ...(preset?.clips ?? {}), ...ownClips };
  let nClips = 0;
  for (const [cname, c] of Object.entries(clipSrc)) {
    if (!c || typeof c !== "object") continue;
    if (++nClips > LIMITS.clipsPerModel) {
      issues.push({ path: `${path}.clips`, message: `plus de ${LIMITS.clipsPerModel} clips` });
      break;
    }
    const tracks: Track[] = [];
    for (const [pname, t] of Object.entries(c.tracks ?? {})) {
      if (!t || typeof t !== "object") continue;
      const targets: { i: number; phase: number }[] = [];
      const ph = num(t.phase, 0);
      if (idx.has(pname)) targets.push({ i: idx.get(pname)!, phase: ph });
      else if (mirrors.has(pname)) {
        const [l, r] = mirrors.get(pname)!;
        targets.push({ i: idx.get(l)!, phase: ph }, { i: idx.get(r)!, phase: ph + (t.sync ? 0 : 0.5) });
      } else if (repeats.has(pname)) {
        const names = repeats.get(pname)!;
        names.forEach((nm, k) => targets.push({ i: idx.get(nm)!, phase: ph + (t.sync ? 0 : k / names.length) }));
      } else {
        // les clips d'un préréglage visent des pièces facultatives (queue, oreilles) : pas de bruit
        if (Object.prototype.hasOwnProperty.call(ownClips, cname)) issues.push({ path: `${path}.clips.${cname}.tracks.${pname}`, message: "pièce inconnue" });
        continue;
      }
      CHANNELS.forEach((ch, ci) => {
        const raw = t[ch];
        if (!Array.isArray(raw)) return;
        const keys = raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(0, LIMITS.keys);
        if (!keys.length) return;
        const k = ci < 3 ? keys.map((v) => v * DEG) : keys;
        for (const tg of targets) {
          // Côté droit d'un miroir : rotations y / z et translation x inversées
          const flip = sorted[tg.i].name.endsWith("R") && mirrors.has(pname) && (ch === "ry" || ch === "rz" || ch === "x");
          tracks.push({ part: tg.i, ch: ci, keys: flip ? k.map((v) => -v) : k, phase: tg.phase });
        }
      });
    }
    clips.set(cname, {
      name: cname,
      ms: clampN(num(c.ms, 800), 30, 60000),
      loop: c.loop !== false,
      then: typeof c.then === "string" ? c.then : "",
      smooth: c.ease !== "linear",
      tracks,
      ...clipMotion(c, `${path}.clips.${cname}`, issues),
    });
  }

  const roles: Record<string, string> = {};
  if (gen) for (const [k, v] of Object.entries(GEN_ROLES)) roles[k] = roles[v] = own(ownPal, k) ?? "";
  for (const p of sorted) if (p.role && !Object.prototype.hasOwnProperty.call(roles, p.role)) roles[p.role] = own(ownPal, p.role) ?? safeColor(own(preset?.roles, p.role)) ?? own(palette, p.role) ?? "#94a3b8";
  const clip = typeof src.clip === "string" ? src.clip : preset?.clip ?? (clips.has("idle") ? "idle" : "");
  return { name, sig: "", parts: sorted, clips, clip, roles, gen, issues: [] };
}

/** Emprise au sol : cercle `r` (écart entre copies) et rectangle orienté `hx` × `hz` (zones à éviter). */
type Foot = { x: number; z: number; r: number; hx: number; hz: number; yaw: number; name: string; base: string };

/**
 * Les objets sans nom posés sur un meuble nommé (lampe sur un bureau) en reçoivent un, `<appui>-<modèle><n>` : ils
 * suivent alors leur appui quand on le déplace, et se déplacent eux-mêmes. Pas sur les murs ni les menuiseries, qui
 * ne bougent pas (le décor y reste instancié), et dans la limite des instances nommées.
 */
function nameCarried(place: Placement[], models: Map<string, Model>, prefabs: Record<string, PrefabInfo>): void {
  const byName = new Map(place.filter((p) => p.name).map((p) => [p.name, p]));
  let named = byName.size;
  let parts = 0;
  for (const p of byName.values()) parts += models.get(p.model)?.parts.length ?? 0;
  const fixed = (p: Placement) => p.model.startsWith("espace:") || (Object.prototype.hasOwnProperty.call(prefabs, p.model.split("~")[0]) && prefabs[p.model.split("~")[0]].famille === "ouverture");
  const count: Record<string, number> = {};
  // un objet posé sur un objet tout juste nommé (vase sur un plateau posé sur la table) : plusieurs passes
  for (let pass = 0, again = true; again && pass < 4; pass++) {
    again = false;
    for (const pl of place) {
      if (pl.name || !pl.on) continue;
      const sup = byName.get(pl.on.support);
      if (!sup || fixed(sup)) continue;
      const n = models.get(pl.model)?.parts.length ?? 0;
      if (named + 1 > LIMITS.named || parts + n > LIMITS.namedParts) return;
      const base = pl.model.split("~")[0].replace(/[^\w-]/g, "");
      let name = "";
      do name = `${pl.on.support}-${base}${(count[`${pl.on.support}-${base}`] = (count[`${pl.on.support}-${base}`] ?? 0) + 1)}`;
      while (byName.has(name));
      pl.name = name;
      byName.set(name, pl);
      named++;
      parts += n;
      again = true;
    }
  }
}

function readPlacements(list: unknown, models: Map<string, Model>, prefabs: Record<string, PrefabInfo>, issues: Issue[], conflicts: Conflict[]): Placement[] {
  const out: Placement[] = [];
  const names = new Set<string>();
  const byName = new Map<string, Placement>();
  let named = 0;
  const arr = (Array.isArray(list) ? list : []).slice(0, 2000);
  if (Array.isArray(list) && list.length > 2000) issues.push({ path: "place", message: "plus de 2000 entrées : la suite est ignorée" });
  let budget: number = LIMITS.parts;
  let namedParts = 0;
  const entry = (raw: unknown) => (raw && typeof raw === "object" ? raw : {}) as PlaceIn;
  const onOf = (p: PlaceIn) => (typeof p.against === "string" && p.against ? p.against : typeof p.on === "string" && p.on !== "sol" ? p.on : "");
  const supportOf = (p: PlaceIn) => onOf(p).split("@")[0];
  // Emprises au sol : tenues seulement si un semis les consulte (`spacing`, `avoid`)
  const trackGround = arr.some((r) => entry(r).spacing !== undefined || Array.isArray(entry(r).avoid));
  const ground: Foot[] = [];
  /** Emprises déjà posées sur chaque surface (`instance@surface`, repère de l'appui). */
  const onSurface = new Map<string, Foot[]>();
  const boxOf = (name: string): Box3 => boundsOf(models.get(name)!) ?? DEFAULT_BOUNDS;
  const radius = (b: Box3, sc: [number, number, number]) => Math.max(Math.abs(b.min[0]), Math.abs(b.max[0])) * Math.abs(sc[0]) > Math.max(Math.abs(b.min[2]), Math.abs(b.max[2])) * Math.abs(sc[2]) ? Math.max(Math.abs(b.min[0]), Math.abs(b.max[0])) * Math.abs(sc[0]) : Math.max(Math.abs(b.min[2]), Math.abs(b.max[2])) * Math.abs(sc[2]);

  const handle = (raw: unknown, i: number) => {
    const p = entry(raw);
    const path = `place.${i}`;
    const model = typeof p.model === "string" ? p.model : "";
    if (!models.has(model)) {
      issues.push({ path, message: `modèle inconnu « ${model.split("~")[0]} »` });
      return;
    }
    const roles: Record<string, string> = {};
    if (p.roles && typeof p.roles === "object") for (const [k, v] of Object.entries(p.roles)) if (isColor(v)) roles[k] = v;
    const base: Placement = {
      model,
      name: "",
      at: vec3(p.at, [0, 0, 0]),
      rot: vec3(p.rot, [0, 0, 0]).map((v) => v * DEG) as [number, number, number],
      scale: scale3(p.scale),
      roles,
      clip: typeof p.clip === "string" ? p.clip : "",
      hidden: p.hidden === true,
      ...(p.shadow === false ? { noShadow: true } : {}),
      ...(Array.isArray(p.tags) ? { tags: p.tags.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 40).slice(0, 8) } : {}),
      ...(p.sensor === true ? { sensor: true } : {}),
    };
    const body = readBody(p.corps ?? p.body, `${path}.corps`, issues);
    if (body) {
      if (typeof p.name === "string" && p.name) base.body = body;
      else issues.push({ path: `${path}.corps`, message: "un corps physique demande un placement nommé (name)" });
    }

    // Appui : surface d'une instance nommée déjà placée, ou le sol
    const onSol = p.on === "sol";
    const supName = supportOf(p);
    let sup: { pl: Placement; s: Surface; key: string; surface: string } | null = null;
    if (supName) {
      const surface = onOf(p).split("@")[1] || "top";
      const spl = byName.get(supName);
      const sm = spl ? models.get(spl.model)! : null;
      const s = sm ? surfaceOf(sm, surface) : null;
      if (!spl || !sm) issues.push({ path: `${path}.on`, message: `appui inconnu « ${supName} » (une instance nommée)` });
      else if (!s) issues.push({ path: `${path}.on`, message: sm.gen ? `« ${supName} » vient d'un générateur : pas de surface d'appui mesurable` : `surface inconnue « ${surface} » sur « ${supName} » (${surfaceNames(sm).join(", ")})` });
      else sup = { pl: spl, s, key: `${supName}@${surface}`, surface };
    }
    const measured = !!sup || onSol || trackGround || typeof p.stack === "number";

    // Prefab aux paramètres tirés par copie : chaque copie a son modèle (variante) et ses rôles de couleur
    const copies = Array.isArray(p.copies) ? p.copies : null;
    let copy = 0;
    const shapedOf = (name: string) => models.get(name)!.parts.filter((q) => q.shape).length || 1;
    let shaped = shapedOf(model);
    const full = () => out.length >= LIMITS.placements || budget < shaped;
    /** Ajoute une copie ; `mk` reçoit le modèle de la copie et son emprise, et rend le placement (ou `null` : copie sautée). */
    const emit = (mk: (b: Box3) => Placement | null) => {
      if (full()) return;
      const c = copies?.[copy++];
      let mname = model;
      const cr: Record<string, string> = {};
      if (c && typeof c.model === "string" && models.has(c.model)) {
        mname = c.model;
        if (c.roles && typeof c.roles === "object") for (const [k, v] of Object.entries(c.roles)) if (isColor(v)) cr[k] = v;
        shaped = shapedOf(mname);
        if (budget < shaped) return;
      }
      const b = measured ? boxOf(mname) : DEFAULT_BOUNDS;
      const made = mk(b);
      if (!made) return;
      const pl: Placement = { ...made, model: mname, roles: { ...cr, ...made.roles }, src: i };
      if (pl.name) {
        if (namedParts + shaped > LIMITS.namedParts) {
          issues.push({ path, message: `plus de ${LIMITS.namedParts} pièces animées : instance ignorée` });
          return;
        }
        namedParts += shaped;
        byName.set(pl.name, pl);
      }
      budget -= shaped;
      out.push(pl);
      if (trackGround && !pl.on)
        ground.push({
          x: pl.at[0] + ((b.min[0] + b.max[0]) / 2) * pl.scale[0],
          z: pl.at[2] + ((b.min[2] + b.max[2]) / 2) * pl.scale[2],
          r: radius(b, pl.scale),
          hx: ((b.max[0] - b.min[0]) / 2) * Math.abs(pl.scale[0]),
          hz: ((b.max[2] - b.min[2]) / 2) * Math.abs(pl.scale[2]),
          yaw: pl.rot[1],
          name: pl.name,
          base: mname.split("~")[0],
        });
    };

    const rnd = new Rand(`${p.seed ?? i}/${model}`);
    const jitter = Math.max(0, num(p.jitter, 0));
    const turn = dim(num(p.turn, 0)) * DEG;
    const size = Array.isArray(p.size) ? [num(p.size[0], 1), num(p.size[1], num(p.size[0], 1))] : null;
    const spacing = Math.max(0, num(p.spacing, 0));
    const avoid = Array.isArray(p.avoid) ? p.avoid.filter((v): v is string => typeof v === "string").slice(0, 16) : [];
    const avoided = (f: Foot) => avoid.includes(f.name) || avoid.includes(f.base) || avoid.includes(own(prefabs, f.base)?.famille ?? "\u0000") || (own(prefabs, f.base)?.tags ?? []).some((t) => avoid.includes(t));
    const vary = (pl: Placement, step: number): Placement => {
      const s = size ? rnd.range(size[0], size[1]) : 1;
      return {
        ...pl,
        at: [pl.at[0] + rnd.range(-1, 1) * jitter * step, pl.at[1], pl.at[2] + rnd.range(-1, 1) * jitter * step],
        rot: [pl.rot[0], pl.rot[1] + rnd.range(-1, 1) * turn, pl.rot[2]],
        scale: [pl.scale[0] * s, pl.scale[1] * s, pl.scale[2] * s],
      };
    };
    /** Base posée au sol (`on: "sol"`) ; `level` : rang dans une pile. */
    const rest = (pl: Placement, b: Box3, level = 0): Placement => (onSol || level ? { ...pl, at: [pl.at[0], pl.at[1] - (onSol ? b.min[1] * pl.scale[1] : 0) + level * (b.max[1] - b.min[1]) * pl.scale[1], pl.at[2]] } : pl);
    /** Pose sur l'appui : `a0`, `a1` = `at` sur la surface (voir `localOn`), ramenés dans son contour. */
    const settle = (pl: Placement, b: Box3, a0: number, a1: number, level: number, who: string, strict: boolean): Placement | null => {
      const S = sup!;
      const k = S.pl.scale[0] || 1;
      const got = localOn(S.s, b, pl.scale, k, [a0, a1], level, pl.rot[1]);
      if (strict && !level && (!got.fits || got.clamped)) conflicts.push({ a: who, b: S.key, type: "hors-appui" });
      const feet = onSurface.get(S.key) ?? [];
      if (!level) {
        const hit = feet.find((f) => Math.hypot(f.x - got.u, f.z - got.v) < f.r + got.r + spacing - 1e-6);
        // semis et grilles : la copie cherche une autre place ; un objet placé à la main est jugé par ses boîtes (collide.ts)
        if (hit && !strict) return null;
        feet.push({ x: got.u, z: got.v, r: got.r, hx: got.r, hz: got.r, yaw: 0, name: who, base: "" });
        onSurface.set(S.key, feet);
      }
      const yaw = S.pl.rot[1];
      const [wx, wz] = turnY(got.local[0] * k, got.local[2] * k, yaw);
      return {
        ...pl,
        at: [S.pl.at[0] + wx, S.pl.at[1] + got.local[1] * k, S.pl.at[2] + wz],
        rot: [pl.rot[0], pl.rot[1] + yaw, pl.rot[2]],
        on: { support: supName, surface: S.surface, local: got.local, yaw: pl.rot[1] },
        noShadow: true,
      };
    };
    /** Origine de `at` ramenée au centre de la surface (grilles et semis se répartissent autour du centre). */
    const centred = (S: Surface, x: number, z: number): [number, number] =>
      S.face === "+z"
        ? [x + (S.from === "coin" ? (S.x1 - S.x0) / 2 : S.from === "origine" ? (S.x0 + S.x1) / 2 : 0), z + (S.from === "coin" ? (S.y - S.y0) / 2 : S.from === "origine" ? (S.y0 + S.y) / 2 : 0)]
        : [x + (S.from === "coin" ? (S.x1 - S.x0) / 2 : S.from === "origine" ? (S.x0 + S.x1) / 2 : 0), z + (S.from === "coin" ? (S.z1 - S.z0) / 2 : S.from === "origine" ? (S.z0 + S.z1) / 2 : 0)];
    const TRIES = 30;
    let skipped = 0;

    if (Array.isArray(p.grid)) {
      const g = p.grid.map((v) => clampN(Math.round(num(v, 1)), 1, 200));
      const [nx, ny, nz] = g.length >= 3 ? g : [g[0] ?? 1, 1, g[1] ?? 1];
      if (nx * ny * nz > LIMITS.placements) issues.push({ path, message: `grille de ${nx * ny * nz} copies : limitée à ${LIMITS.placements}` });
      if (sup) {
        // grille répartie sur la surface (ou au pas donné), centrée
        const w = sup.s.x1 - sup.s.x0, d = sup.s.face === "+z" ? sup.s.y - sup.s.y0 : sup.s.z1 - sup.s.z0;
        const st = Array.isArray(p.step) ? [num(p.step[0], w / nx), num(p.step[p.step.length > 2 ? 2 : 1], d / nz)] : [w / nx, d / nz];
        for (let a = 0; a < nx && !full(); a++)
          for (let c = 0; c < nz && !full(); c++) emit((b) => settle(vary({ ...base, at: [0, 0, 0] }, 0), b, ...centred(sup!.s, (a - (nx - 1) / 2) * st[0], (c - (nz - 1) / 2) * st[1]), 0, path, false));
      } else {
        const st = vec3(p.step, [1, 1, 1]);
        for (let a = 0; a < nx && !full(); a++)
          for (let b2 = 0; b2 < ny && !full(); b2++)
            for (let c = 0; c < nz && !full(); c++)
              emit((b) => rest(vary({ ...base, at: [base.at[0] + a * st[0], base.at[1] + b2 * st[1], base.at[2] + c * st[2]] }, Math.min(Math.abs(st[0]) || 1, Math.abs(st[2]) || 1)), b));
      }
    } else if (typeof p.scatter === "number") {
      const n = clampN(Math.round(p.scatter), 0, LIMITS.placements);
      if (sup) {
        const hw = (sup.s.x1 - sup.s.x0) / 2, hd = (sup.s.face === "+z" ? sup.s.y - sup.s.y0 : sup.s.z1 - sup.s.z0) / 2;
        for (let k = 0; k < n && !full(); k++)
          emit((b) => {
            const pl0 = vary({ ...base, at: [0, 0, 0] }, 0);
            // sur une face verticale l'objet garde son dos au mur
            if (!turn && sup!.s.face !== "+z") pl0.rot = [pl0.rot[0], rnd.range(0, Math.PI * 2), pl0.rot[2]];
            for (let t = 0; t < TRIES; t++) {
              const got = settle(pl0, b, ...centred(sup!.s, rnd.range(-hw, hw), rnd.range(-hd, hd)), 0, path, false);
              if (got) return got;
            }
            skipped++;
            return null;
          });
      } else {
        const within = Array.isArray(p.within) ? p.within.filter((q) => Array.isArray(q) && q.length >= 2 && q.every((v) => typeof v === "number" && Number.isFinite(v))).slice(0, 256) : [];
        const poly = within.length >= 3 ? within : null;
        const ar = Array.isArray(p.area)
          ? p.area.map((v) => num(v, 0))
          : poly
            ? [Math.min(...poly.map((q) => q[0])), Math.min(...poly.map((q) => q[1])), Math.max(...poly.map((q) => q[0])), Math.max(...poly.map((q) => q[1]))]
            : [-5, -5, 5, 5];
        const mine: Foot[] = [];
        for (let k = 0; k < n && !full(); k++)
          emit((b) => {
            for (let t = 0; t < (spacing || avoid.length || poly ? TRIES : 1); t++) {
              const pl = vary({ ...base, at: [rnd.range(ar[0], ar[2]), base.at[1], rnd.range(ar[1], ar[3])] }, 0);
              if (!turn) pl.rot = [pl.rot[0], rnd.range(0, Math.PI * 2), pl.rot[2]];
              if (poly && !inPolygon(pl.at[0], pl.at[2], poly)) continue;
              if (spacing || avoid.length) {
                const r = radius(b, pl.scale);
                const near = (f: Foot, gap: number) => Math.hypot(f.x - pl.at[0], f.z - pl.at[2]) < f.r + r + gap;
                // zone à éviter : rectangle de l'emprise, tourné comme l'objet
                const inside = (f: Foot) => {
                  const [lx, lz] = turnY(pl.at[0] - f.x, pl.at[2] - f.z, -f.yaw);
                  return Math.hypot(Math.max(0, Math.abs(lx) - f.hx), Math.max(0, Math.abs(lz) - f.hz)) < r + spacing;
                };
                if ((spacing && mine.some((f) => near(f, spacing))) || (avoid.length && ground.some((f) => avoided(f) && inside(f)))) continue;
                mine.push({ x: pl.at[0], z: pl.at[2], r, hx: r, hz: r, yaw: 0, name: "", base: "" });
              }
              return rest(pl, b);
            }
            skipped++;
            return null;
          });
      }
    } else {
      const name = typeof p.name === "string" ? p.name.replace(/[^\w-]/g, "") : "";
      const stack = typeof p.stack === "number" ? clampN(Math.round(p.stack), 1, 64) : 1;
      if (name && stack === 1) {
        if (names.has(name)) {
          issues.push({ path, message: `nom d'instance en double « ${name} »` });
          return;
        }
        if (++named > LIMITS.named) {
          issues.push({ path, message: `plus de ${LIMITS.named} instances nommées` });
          return;
        }
        names.add(name);
      }
      // sur un appui, `at` = [x, z] (ou [x, y, z]) depuis le centre de la surface
      const la = typeof p.against === "string" && p.against ? [num(Array.isArray(p.at) ? p.at[0] : p.at, 0), 0] : Array.isArray(p.at) ? [num(p.at[0], 0), num(p.at[p.at.length > 2 ? 2 : 1], 0)] : [0, 0];
      for (let level = 0; level < stack && !full(); level++)
        emit((b) => {
          let pl = vary({ ...base, name: stack === 1 ? name : "" }, 0);
          if (level) {
            // pile : léger désordre, comme une pile faite à la main
            const r = radius(b, pl.scale);
            pl = { ...pl, at: [pl.at[0] + rnd.range(-1, 1) * r * 0.04, pl.at[1], pl.at[2] + rnd.range(-1, 1) * r * 0.04], rot: [pl.rot[0], pl.rot[1] + rnd.range(-1, 1) * (turn || 6 * DEG), pl.rot[2]] };
          }
          if (sup) return settle({ ...pl, at: [0, 0, 0] }, b, la[0] + (pl.at[0] - base.at[0]), la[1] + (pl.at[2] - base.at[2]), level, name || path, level === 0);
          return rest(pl, b, level);
        });
    }
    if (skipped) issues.push({ path, message: `${skipped} copie(s) sans place libre (appui plein, spacing ou avoid trop stricts)` });
  };

  // Les objets posés sur une instance viennent après elle, quel que soit l'ordre d'écriture
  const waiting: number[] = [];
  arr.forEach((raw, i) => (supportOf(entry(raw)) ? waiting.push(i) : handle(raw, i)));
  for (let round = 0; round < 8 && waiting.length; round++) {
    const still: number[] = [];
    for (const i of waiting) (byName.has(supportOf(entry(arr[i]))) ? handle(arr[i], i) : still.push(i));
    if (still.length === waiting.length) break;
    waiting.length = 0;
    waiting.push(...still);
  }
  for (const i of waiting) handle(arr[i], i);
  if (budget <= 0 || out.length >= LIMITS.placements) issues.push({ path: "place", message: `budget atteint (${LIMITS.placements} copies, ${LIMITS.parts} pièces) : placements suivants ignorés` });
  return out;
}

const VIEWS = ["top", "side", "front", "iso"] as const;
const LOOKS = ["doux", "toon", "brillant"] as const;

/** Lecture tolérante : jamais d'exception, les problèmes vont dans `issues`. */
export function readMonde(input: unknown, previous?: Monde | null): Monde {
  try {
    return readMondeUnsafe(input, previous);
  } catch (err) {
    const m = readMondeUnsafe({}, null);
    m.issues.push({ path: "", message: `monde illisible : ${err instanceof Error ? err.message : String(err)}` });
    return m;
  }
}

function readMondeUnsafe(input: unknown, previous?: Monde | null): Monde {
  const issues: Issue[] = [];
  const raw0 = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as MondeIn;
  const unit = readUnit(raw0.unite, issues);
  const esp = expandEspace(raw0, issues, unit);
  const emitters = readEmitters(raw0.emitters, unit, issues);
  // le modèle de chaque émetteur passe par la même lecture qu'un placement (prefab paramétré, variantes, modèle gen) :
  // placements cachés ajoutés en fin de liste, retirés après la résolution
  // modèles du monde infini : résolus de la même façon (un prefab du catalogue y devient un modèle du monde)
  const infModels = infiniModels(raw0.infini);
  const resolved = new Map<string, string>();
  const raw = emitters.length || infModels.length ? withEmitterPlaces(esp.src, emitters, infModels) : esp.src;
  const expanded = expandPrefabs(raw, issues, prefabFormat(unit, readMatieres(raw.materiaux, issues)));
  const src = emitters.length || infModels.length ? takeEmitterPlaces(genVariants(expanded.src, issues), emitters, resolved) : genVariants(expanded.src, issues);
  const amb = readAmbiance((src as MondeIn).ambiance, (message) => issues.push({ path: "ambiance", message }));
  const palette: Record<string, string> = { ...DEFAULT_PALETTE, ...(amb?.palette ?? {}) };
  const ownPal: Record<string, string> = { ...(amb?.palette ?? {}) };
  if (src.palette && typeof src.palette === "object") {
    for (const [k, v] of Object.entries(src.palette)) {
      if (isColor(v)) palette[k] = ownPal[k] = v;
      else issues.push({ path: `palette.${k}`, message: "couleur #rrggbb attendue" });
    }
  }
  const models = new Map<string, Model>();
  // Le plafond porte sur les modèles écrits ; les variantes (`nom~clé`) ont le leur (prefab.ts, gen.ts)
  const all = Object.entries(src.models && typeof src.models === "object" ? src.models : {});
  const written = all.filter(([n]) => !n.includes("~") && !n.startsWith("espace:"));
  if (written.length > LIMITS.models) issues.push({ path: "models", message: `plus de ${LIMITS.models} modèles` });
  const entries = [...written.slice(0, LIMITS.models), ...all.filter(([n]) => n.includes("~") || n.startsWith("espace:"))];
  for (const [name, m] of entries) {
    if (!m || typeof m !== "object") continue;
    const sig = `${hash32(JSON.stringify(m))}/${hash32(JSON.stringify(src.palette ?? {}))}`;
    const prev = previous?.models.get(name);
    if (prev && prev.sig === sig) {
      models.set(name, prev);
      issues.push(...prev.issues);
      continue;
    }
    const own0 = issues.length;
    const model = readModel(name, m, palette, ownPal, issues);
    const col = readCollider((m as ModelIn).collider, unit, `models.${name}.collider`, issues);
    if (col) model.collider = col;
    model.sig = sig;
    model.issues = issues.slice(own0);
    models.set(name, model);
  }
  const v = src.view2d ?? {};
  const view = (VIEWS as readonly string[]).includes(String(v.view)) ? (v.view as View2d["view"]) : "top";
  const look = (LOOKS as readonly string[]).includes(String(src.look)) ? (src.look as Monde["look"]) : (amb?.look ?? "doux");
  // fini par défaut de l'ambiance : pièces sans fini propre
  if (amb?.finish) {
    const f = readFinish(amb.finish, (message) => issues.push({ path: "ambiance.finish", message }));
    if (f) for (const model of models.values()) for (const p of model.parts) if (!p.finish) p.finish = f;
  }
  const gradeIn = (src as MondeIn).etalonnage;
  const grade = amb || gradeIn ? readGrade(gradeIn, amb?.grade ?? {}) : null;
  const lumIn = (src as MondeIn).lumiere;
  const envIn = (src as MondeIn).environnement;
  const detail = src.detail === "low" ? 0 : src.detail === "high" ? 2 : 1;
  const conflicts: Conflict[] = [];
  const textures: Record<string, TexSpec> = {};
  if (src.textures && typeof src.textures === "object")
    for (const [k, t] of Object.entries(src.textures)) {
      const r = readTex(t, (message) => issues.push({ path: `textures.${k}`, message }));
      if (r) textures[k] = r;
    }
  const place = readPlacements(src.place, models, expanded.prefabs, issues, conflicts);
  // rangs des entrées écrites : l'espace ajoute ses murs, sols et plafond en tête
  const added = (Array.isArray(src.place) ? src.place.length : 0) - (Array.isArray(raw0.place) ? raw0.place.length : 0);
  for (const pl of place) pl.src = (pl.src ?? 0) - added >= 0 ? (pl.src ?? 0) - added : -1;
  nameCarried(place, models, expanded.prefabs);
  const posed = place.some((p) => p.on) || (Array.isArray(raw0.place) && raw0.place.some((p) => p && typeof p === "object" && (p as PlaceIn).stack !== undefined));
  let marks: Obb[] = [];
  const collide = raw0.collisions === "montrer" ? "montrer" : raw0.collisions === true || (raw0.collisions !== false && (esp.contour || posed)) ? "oui" : "non";
  if (collide !== "non") {
    const found = findAll(place, models, { contour: esp.contour, familleOf: (base) => own(expanded.prefabs, base)?.famille ?? "", softOf: (base) => own(expanded.prefabs, base)?.souple === true });
    conflicts.push(...found.conflicts);
    if (raw0.collisions === "montrer") marks = found.marks;
  }
  return {
    palette,
    models,
    textures,
    texture: readTex(src.texture ?? amb?.texture, (message) => issues.push({ path: "texture", message })),
    ciel: isColor(src.ciel) ? src.ciel : (amb?.ciel ?? ""),
    brume: clampN(num(src.brume, amb?.brume ?? 0), 0, 1),
    style: src.style ?? amb?.style ?? null,
    traits: clampN(num(src.traits, 1), 0, 3),
    place,
    look,
    environnement: envIn === "studio" || envIn === "exterieur" || envIn === "aucun" ? envIn : (amb?.environnement ?? (reflects(models) ? "studio" : "aucun")),
    ambiance: amb?.name ?? "",
    herbes: readHerbes((src as MondeIn).herbes ?? raw0.herbes, issues),
    lumiere: amb || lumIn ? readLumiere(lumIn, amb?.lumiere ?? {}) : null,
    grade: grade && JSON.stringify(grade) !== JSON.stringify(GRADE0) ? grade : null,
    photo: readPhoto((src as MondeIn).photo),
    physics: readPhysics((src as MondeIn).physique ?? (src as MondeIn).physics, issues),
    detail,
    view2d: { view, unit: clampN(num(v.unit, 48), 1, 2000), origin: [num(v.origin?.[0], 0), num(v.origin?.[1], 0)] },
    shadows: src.shadows !== false,
    outline: clampN(num(src.outline, 1), 0, 6),
    prefabs: expanded.prefabs,
    conflicts,
    marks,
    collide,
    contour: esp.contour,
    edges: esp.edges,
    openings: esp.openings,
    images: readImages(raw0.images, issues),
    emitters: emitters.filter((e) => {
      const known = e.variants.filter((v) => models.has(v.model));
      e.variants = known.filter((v) => !models.get(v.model)!.gen);
      if (e.variants.length) return true;
      issues.push({ path: `emitters.${e.id}.model`, message: known.length ? `« ${e.model} » vient d'un générateur procgen : pas encore émis (modèle en pièces attendu)` : `modèle inconnu « ${e.model} »` });
      return false;
    }),
    particles: readParticles(raw0.particles, unit, issues),
    vent: readVent(raw0.vent, unit),
    infini: readInfini(raw0.infini, unit, (n) => models.has(n) && !models.get(n)!.gen, issues, (n) => resolved.get(n) ?? n),
    unit,
    issues,
  };
}

/** Vrai si une pièce d'un modèle a un fini qui reflète (métal, verre, vernis). */
function reflects(models: Map<string, Model>): boolean {
  for (const m of models.values()) for (const p of m.parts) if (p.finish && (p.finish.metal > 0.2 || p.finish.glass > 0 || p.finish.clear > 0.2)) return true;
  return false;
}

/** Forme de collision écrite d'un modèle : boîtes dans son repère (une sphère ou une capsule comptent pour leur boîte). */
function readCollider(v: unknown, u: number, path: string, issues: Issue[]): Obb[] | "none" | null {
  if (v === undefined || v === "auto") return null;
  if (v === "none") return "none";
  const list = Array.isArray(v) ? v : [v];
  const out: Obb[] = [];
  const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  for (const c of list.slice(0, 8)) {
    if (!c || typeof c !== "object") continue;
    const o = c as { box?: unknown; sphere?: unknown; capsule?: unknown; at?: unknown };
    const at = Array.isArray(o.at) && o.at.length >= 3 && o.at.slice(0, 3).every(fin) ? (o.at.slice(0, 3) as number[]).map((x) => x * u) : null;
    let h: [number, number, number] | null = null;
    let c0: [number, number, number] = [0, 0, 0];
    let round: "sphere" | "capsule" | undefined;
    if (Array.isArray(o.box) && o.box.length >= 3 && o.box.slice(0, 3).every(fin)) {
      h = [(o.box[0] * u) / 2, (o.box[1] * u) / 2, (o.box[2] * u) / 2];
      c0 = [0, h[1], 0];
    } else if (fin(o.sphere)) {
      const r = o.sphere * u;
      h = [r, r, r];
      c0 = [0, r, 0];
      round = "sphere";
    } else if (Array.isArray(o.capsule) && fin(o.capsule[0]) && fin(o.capsule[1])) {
      const r = o.capsule[0] * u, hh = (o.capsule[1] * u) / 2 + r;
      h = [r, hh, r];
      c0 = [0, hh, 0];
      round = "capsule";
    }
    if (!h || h.some((x) => x <= 0)) {
      issues.push({ path, message: 'forme attendue : {box: [l, h, p]}, {sphere: r} ou {capsule: [r, h]} (posée au sol, "at" pour la décaler)' });
      continue;
    }
    out.push({ c: (at as [number, number, number] | null) ?? c0, ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h, ...(round ? { round } : {}) });
  }
  return out.length ? out : null;
}

type EmitPlace = PlaceIn & { emitter?: string; infiniModel?: string; copies?: { model: string; roles?: Record<string, string> }[] };

/** Noms des modèles des calques de `infini`. */
function infiniModels(v: unknown): string[] {
  if (!v || typeof v !== "object" || !Array.isArray((v as { layers?: unknown }).layers)) return [];
  const out = new Set<string>();
  for (const l of (v as { layers: unknown[] }).layers.slice(0, 12)) {
    if (!l || typeof l !== "object") continue;
    const o = l as { model?: unknown; models?: unknown };
    for (const m of Array.isArray(o.models) ? o.models : [o.model]) if (typeof m === "string" && m) out.add(m);
  }
  return [...out].slice(0, 32);
}

/** Un placement caché par émetteur (semis de quelques copies si ses paramètres sont tirés au hasard) et par modèle du monde infini. */
function withEmitterPlaces<T extends { place?: unknown }>(src: T, list: EmitterSpec[], inf: string[] = []): T {
  const place = Array.isArray(src.place) ? [...(src.place as unknown[])] : [];
  for (const m of inf) place.push({ model: m, hidden: true, infiniModel: m } as EmitPlace);
  for (const e of list) {
    const p: EmitPlace = { model: e.model, hidden: true, emitter: e.id, seed: e.seed };
    if (e.params) {
      p.params = e.params;
      if (hasExpr(e.params)) {
        p.scatter = Math.min(8, e.max);
        p.area = [0, 0, 1, 1];
      }
    }
    place.push(p);
  }
  return { ...src, place };
}

/** Récupère les modèles résolus des placements d'émetteurs et les retire de la liste. */
function takeEmitterPlaces<T extends { place?: unknown }>(src: T, list: EmitterSpec[], resolved?: Map<string, string>): T {
  if (!Array.isArray(src.place)) return src;
  const byId = new Map(list.map((e) => [e.id, e]));
  const place = (src.place as EmitPlace[]).filter((p) => {
    if (p && typeof p === "object" && typeof p.infiniModel === "string") {
      resolved?.set(p.infiniModel, String(p.model));
      return false;
    }
    const e = p && typeof p === "object" && typeof p.emitter === "string" ? byId.get(p.emitter) : undefined;
    if (!e) return true;
    const roles = (r: unknown) => (r && typeof r === "object" ? (r as Record<string, string>) : {});
    e.variants = Array.isArray(p.copies) && p.copies.length ? p.copies.slice(0, 8).map((c) => ({ model: c.model, roles: roles(c.roles) })) : [{ model: String(p.model), roles: roles(p.roles) }];
    return false;
  });
  return { ...src, place };
}

/** `images` : URL `data:` d'images (png, jpeg, webp) ; jamais d'URL réseau. */
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
function readImages(v: unknown, issues: Issue[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  let n = 0;
  for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z][\w-]{0,63}$/.test(k)) {
      issues.push({ path: `images.${k}`, message: "nom d'image : lettres, chiffres, - et _" });
      continue;
    }
    if (typeof d !== "string" || d.length > 820_000 || !IMAGE_RE.test(d)) {
      issues.push({ path: `images.${k}`, message: "image attendue : data:image/png|jpeg|webp;base64,… (600 Ko au plus)" });
      continue;
    }
    if (++n > 12) {
      issues.push({ path: `images.${k}`, message: "plus de 12 images : ignorée" });
      continue;
    }
    out[k] = d;
  }
  return out;
}

/* ------------------------------------------------------------------ prefabs : ce qui est propre au format 3D */

const UNITS: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001 };

function readUnit(v: unknown, issues: Issue[]): number {
  if (v === undefined || v === null) return 1;
  const u = own(UNITS, String(v));
  if (u === undefined) issues.push({ path: "unite", message: `unité inconnue (${Object.keys(UNITS).join(", ")}) : mètres` });
  return u ?? 1;
}

/** Matières de base, complétées ou remplacées par `materiaux` du monde. */
export const MATIERES: Record<string, Matiere> = {
  chene: { color: "#b98a56", tex: "bois", finish: "bois" },
  pin: { color: "#dcbf8a", tex: "bois", finish: "bois" },
  noyer: { color: "#6b4426", tex: "bois", finish: { fini: "bois", clear: 0.25 } },
  hetre: { color: "#d8b48a", tex: "bois", finish: "bois" },
  "bois-blanc": { color: "#ece6da", tex: { kind: "bois", contrast: 0.18 }, finish: "satine" },
  "bois-noir": { color: "#2a2623", tex: { kind: "bois", contrast: 0.3 }, finish: "satine" },
  acier: { color: "#aab2bd", tex: "metal", finish: "brosse" },
  laiton: { color: "#b08d57", tex: "metal", finish: "metal" },
  "metal-noir": { color: "#23262b", tex: "metal", finish: { fini: "metal", rough: 0.5 } },
  chrome: { color: "#e5e7eb", finish: "chrome" },
  or: { color: "#e3b04b", finish: { fini: "metal", rough: 0.2 } },
  cuivre: { color: "#c8744a", finish: { fini: "metal", rough: 0.3 } },
  aluminium: { color: "#cfd4da", finish: { fini: "metal", rough: 0.45 } },
  verre: { color: "#e8f2f4", finish: "verre" },
  "verre-depoli": { color: "#eef3f5", finish: "depoli" },
  "verre-fume": { color: "#5b6670", finish: { fini: "verre", opacity: 0.85 } },
  plastique: { color: "#e5e7eb", finish: "plastique" },
  "plastique-brillant": { color: "#ef4444", finish: "brillant" },
  laque: { color: "#1f2937", finish: "laque" },
  ceramique: { color: "#f5f5f0", finish: "ceramique" },
  cuir: { color: "#7a4a2a", tex: { kind: "tissu", contrast: 0.15 }, finish: "cuir" },
  velours: { color: "#5b4b8a", tex: { kind: "tissu", contrast: 0.12 }, finish: "velours" },
  caoutchouc: { color: "#262626", finish: "caoutchouc" },
  lin: { color: "#d9d0c1", tex: "tissu", finish: "tissu" },
  coton: { color: "#f1eee8", tex: "tissu", finish: "tissu" },
  laine: { color: "#c9c2b6", tex: "tricot", finish: "tissu" },
  marbre: { color: "#e9e7e3", tex: "marbre", finish: "ceramique" },
  pierre: { color: "#9ca3af", tex: "pierre", finish: "pierre" },
  blanc: { color: "#f8fafc" },
  noir: { color: "#16181d" },
};

export function readMatieres(v: unknown, issues: Issue[]): Record<string, Matiere> {
  const out: Record<string, Matiere> = { ...MATIERES };
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, m] of Object.entries(v as Record<string, unknown>).slice(0, 64)) {
    const o = typeof m === "string" ? { color: m } : m && typeof m === "object" ? (m as Record<string, unknown>) : null;
    if (!o) continue;
    const mat: Matiere = {};
    if (isColor(o.color)) mat.color = o.color;
    else if (o.color !== undefined) issues.push({ path: `materiaux.${k}.color`, message: "couleur #rrggbb attendue" });
    if (o.tex !== undefined) mat.tex = o.tex;
    if (typeof o.glow === "number" && Number.isFinite(o.glow)) mat.glow = o.glow;
    if (o.finish !== undefined) mat.finish = o.finish;
    out[k] = mat;
  }
  return out;
}

const mulN = (v: unknown, u: number): unknown => (typeof v === "number" ? v * u : v);
const mulList = (v: unknown, u: number): unknown => (Array.isArray(v) ? v.map((x) => mulN(x, u)) : mulN(v, u));
const mulPts = (v: unknown, u: number): unknown => (Array.isArray(v) ? v.map((q) => mulList(q, u)) : v);

/** Longueurs d'une pièce écrite multipliées par `u` (les angles et les échelles ne bougent pas). */
function scalePart(part: Record<string, unknown>, u: number): Record<string, unknown> {
  const p: Record<string, unknown> = { ...part };
  for (const k of ["at", "off", "box", "sphere", "capsule", "cylinder", "cone", "plane"]) if (p[k] !== undefined) p[k] = mulList(p[k], u);
  if (Array.isArray(p.torus)) p.torus = p.torus.map((x, i) => (i < 2 ? mulN(x, u) : x));
  else if (p.torus !== undefined) p.torus = mulN(p.torus, u);
  if (p.lathe !== undefined) p.lathe = mulPts(p.lathe, u);
  for (const k of ["extrude", "tube"]) {
    const v = p[k];
    if (Array.isArray(v)) p[k] = mulPts(v, u);
    else if (v && typeof v === "object") {
      const o = { ...(v as Record<string, unknown>) };
      o.pts = mulPts(o.pts, u);
      for (const kk of ["depth", "r", "r2"]) if (o[kk] !== undefined) o[kk] = mulN(o[kk], u);
      p[k] = o;
    }
  }
  if (p.repeat && typeof p.repeat === "object") {
    const r = { ...(p.repeat as Record<string, unknown>) };
    if (r.at !== undefined) r.at = mulList(r.at, u);
    p.repeat = r;
  }
  return p;
}

function scaleClip(clip: Record<string, unknown>, u: number): Record<string, unknown> {
  const tracks = clip.tracks;
  if (!tracks || typeof tracks !== "object") return clip;
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(tracks as Record<string, unknown>)) {
    if (!t || typeof t !== "object") continue;
    const tr = { ...(t as Record<string, unknown>) };
    for (const ch of ["x", "y", "z"]) if (tr[ch] !== undefined) tr[ch] = mulList(tr[ch], u);
    out[k] = tr;
  }
  return { ...clip, tracks: out };
}

function scalePlace(place: Record<string, unknown>, u: number): Record<string, unknown> {
  const p = { ...place };
  for (const k of ["at", "step", "area", "spacing"]) if (p[k] !== undefined) p[k] = mulList(p[k], u);
  if (p.within !== undefined) p.within = mulPts(p.within, u);
  return p;
}

/** Nombre de copies d'un placement (même calcul que `readPlacements`). */
function copiesOf(p: Record<string, unknown>): number {
  if (Array.isArray(p.grid)) {
    const g = p.grid.map((v) => clampN(Math.round(num(v, 1)), 1, 200));
    const [nx, ny, nz] = g.length >= 3 ? g : [g[0] ?? 1, 1, g[1] ?? 1];
    return Math.min(LIMITS.placements, nx * ny * nz);
  }
  if (typeof p.scatter === "number") return clampN(Math.round(p.scatter), 0, LIMITS.placements);
  if (typeof p.stack === "number") return clampN(Math.round(p.stack), 1, 64);
  return 1;
}

function prefabFormat(unit: number, matieres: Record<string, Matiere>): PrefabFormat {
  return {
    unit,
    unitName: Object.keys(UNITS).find((k) => UNITS[k] === unit) ?? "m",
    catalogue: CATALOGUE,
    scalePart,
    scaleClip,
    scalePlace,
    isGen: (m) => m.gen !== undefined,
    matieres,
    copies: copiesOf,
    presetParts(model, params, seed) {
      const builder = typeof model.preset === "string" ? own(PRESETS, model.preset) : undefined;
      if (!builder) return null;
      const out = builder.build(new Rand(seed), params);
      return { parts: out.parts as Record<string, unknown>[], roles: out.roles };
    },
  };
}

/** Couleur effective d'une pièce pour une instance (couleur fixe > rôle de l'instance > palette du modèle). */
export function partColor(model: Model, part: Part, roles: Record<string, string> | undefined, palette: Record<string, string>): string {
  if (part.color) return part.color;
  if (part.role) return safeColor(own(roles, part.role)) ?? own(model.roles, part.role) ?? own(palette, part.role) ?? "#94a3b8";
  return "#94a3b8";
}

/** Texture effective d'une pièce (propre > rôle > défaut du monde). */
export function partTex(m: Monde, part: Part): TexSpec | null {
  if (part.glow > 0) return part.tex;
  return part.tex ?? (part.role ? own(m.textures, part.role) : undefined) ?? m.texture;
}

/** Résumé publié par les rendus (sortie `monde`) : ce qui existe et peut être piloté. */
export function mondeSummary(m: Monde) {
  const models: Record<string, { parts: string[]; clips: string[]; roles: Record<string, string>; clip: string }> = {};
  for (const [k, md] of m.models) models[k] = { parts: md.parts.map((p) => p.name), clips: [...md.clips.keys()], roles: md.roles, clip: md.clip };
  const hasPrefabs = Object.keys(m.prefabs).length > 0;
  return {
    models,
    // `prefab` : nom écrit du modèle quand l'instance est une variante de prefab (`table~k3x` → `table`)
    instances: m.place
      .filter((p) => p.name)
      .map((p) => ({ name: p.name, model: p.model, ...(own(m.prefabs, p.model.split("~")[0]) ? { prefab: p.model.split("~")[0] } : {}), ...(p.on ? { on: `${p.on.support}@${p.on.surface}` } : {}) })),
    ...(m.conflicts.length ? { conflicts: m.conflicts.slice(0, 50) } : {}),
    ...(hasPrefabs ? { prefabs: m.prefabs } : {}),
    decor: m.place.filter((p) => !p.name).length,
    ...(m.infini ? { infini: { tile: m.infini.tile, radius: m.infini.radius, layers: m.infini.layers.length, biomes: m.infini.biomes.map((b) => b.name) } } : {}),
    ...(m.particles.length ? { particles: m.particles.map((p) => ({ id: p.id, preset: p.preset, max: p.max })) } : {}),
    ...(m.emitters.length ? { emitters: m.emitters.map((e) => ({ id: e.id, model: e.model, behavior: e.behavior, max: e.max, variants: e.variants.length })) } : {}),
    issues: m.issues.slice(0, 50),
  };
}

/** `action` / `speed` d'un clip (modèles `gen`) ; action inconnue signalée et ignorée. */
export function clipMotion(c: { action?: unknown; speed?: unknown }, path: string, issues: { path: string; message: string }[]): { action: string; move: number | null } {
  let action = "";
  if (typeof c.action === "string" && c.action) {
    if ((GEN_ACTIONS as readonly string[]).includes(c.action)) action = c.action;
    else issues.push({ path: `${path}.action`, message: `action inconnue (${GEN_ACTIONS.join(", ")})` });
  }
  const move = typeof c.speed === "number" && Number.isFinite(c.speed) ? clampN(c.speed, 0, 12) : null;
  return { action, move };
}
