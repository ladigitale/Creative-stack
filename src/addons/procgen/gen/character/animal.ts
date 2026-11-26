/**
 * Personnages animaux **décrits par des données** : une espèce = une fiche (oreilles, cornes, museau, truffe, bec,
 * crinière, marques, yeux, crête, queue, pelage). Les espèces livrées sont des fiches ; `animalSpec` (paramètre du
 * générateur) complète ou remplace n'importe quel champ, ce qui permet d'inventer une espèce ou d'ajuster un détail
 * (oreilles plus grandes, museau plus court, queue touffue…) sans toucher au code. Lu par la 3D (tête, corps) et par le
 * dessin vectoriel : même fiche, même animal.
 */

export type EarShape = "pointed" | "round" | "floppy" | "long" | "flap" | "tuft" | "none";
export type TailShape = "curve" | "bushy" | "wag" | "stub" | "pom" | "long" | "curl" | "fan" | "thick" | "tuft" | "none";

export type AnimalSpec = {
  /** Oreilles : forme, taille (1 = normale), écart sur le crâne (0 serrées … 1 sur les côtés), inclinaison vers l'extérieur. */
  ears: { shape: EarShape; size: number; spread: number; tilt: number };
  /** Cornes : none, small (deux cornes), antlers (bois). */
  horns: "none" | "small" | "antlers";
  /** Museau : largeur, hauteur, longueur relatives (0 : pas de museau) ; trompe (éléphant) si long > 1,2. */
  snout: { w: number; h: number; l: number };
  /** Truffe : true (sa couleur : `colors.nose`), false, ou "disc" (groin plat, couleur de l'intérieur des oreilles). */
  nose: boolean | "disc";
  /** Bec (oiseaux) ; sa couleur : `colors.beak`. */
  beak: boolean;
  /** Crinière (lion) ; couleur : `colors.mane`. */
  mane: boolean;
  /** Marques du visage : masque (raton laveur), taches autour des yeux (panda), taches (léopard, girafe), rayures (zèbre). */
  markings: "none" | "mask" | "patches" | "spots" | "stripes";
  /** Yeux globuleux (grenouille), crête (dino), cercles autour des yeux (hibou). */
  eyeBulge: boolean;
  spikes: boolean;
  eyeDiscs: boolean;
  /** Queue : forme, longueur (1 = normale), bout d'une autre couleur (`colors.tailTip`). */
  tail: { shape: TailShape; length: number; tip: boolean };
  /** Couleurs : pelage (une tirée par la graine), museau, truffe, intérieur des oreilles, bec, crinière, marques, bout de queue. */
  colors: { fur: string[]; muzzle: string; nose: string; innerEar: string; beak: string; mane: string; marks: string; tailTip: string };
};

const BASE: AnimalSpec = {
  ears: { shape: "pointed", size: 1, spread: 0.56, tilt: 0.3 },
  horns: "none",
  snout: { w: 0.2, h: 0.12, l: 0.14 },
  nose: true,
  beak: false,
  mane: false,
  markings: "none",
  eyeBulge: false,
  spikes: false,
  eyeDiscs: false,
  tail: { shape: "curve", length: 1, tip: false },
  colors: { fur: ["#9a8f86"], muzzle: "#f2ece4", nose: "#2a2224", innerEar: "#e8a6a2", beak: "#e08a2c", mane: "#8a5a2c", marks: "#2a2224", tailTip: "#f2ece4" },
};

const EARS: EarShape[] = ["pointed", "round", "floppy", "long", "flap", "tuft", "none"];
const TAILS: TailShape[] = ["curve", "bushy", "wag", "stub", "pom", "long", "curl", "fan", "thick", "tuft", "none"];
const HEX = /^#[0-9a-f]{6}$/i;

type Partial2<T> = { [K in keyof T]?: T[K] extends string[] ? string[] : T[K] extends object ? Partial<T[K]> : T[K] };
const S = (o: Partial2<AnimalSpec>): AnimalSpec => mergeSpec(BASE, o);

/** Espèces livrées (fiches complètes ; `animalSpec` peut toutes les retoucher). */
export const ANIMAL_SPECS: Record<string, AnimalSpec> = {
  cat: S({ ears: { shape: "pointed", size: 1 }, snout: { w: 0.2, h: 0.12, l: 0.14 }, tail: { shape: "curve" }, colors: { fur: ["#8f8a86", "#d98a3d", "#3b3533", "#e9e1d6", "#b98a5e"] } }),
  fox: S({ ears: { shape: "pointed", size: 1.35 }, snout: { w: 0.16, h: 0.12, l: 0.34 }, tail: { shape: "bushy", tip: true }, colors: { fur: ["#d9682b", "#c75a24", "#e07a34"], innerEar: "#f2ece4" } }),
  dog: S({ ears: { shape: "floppy", size: 1 }, snout: { w: 0.24, h: 0.16, l: 0.28 }, tail: { shape: "wag" }, colors: { fur: ["#b98a5e", "#e2c9a2", "#5a4334", "#8a6a4c", "#efe7dc"], muzzle: "#e8dcc4" } }),
  bear: S({ ears: { shape: "round", size: 0.85 }, snout: { w: 0.24, h: 0.16, l: 0.22 }, tail: { shape: "stub" }, colors: { fur: ["#7a5232", "#5c3d26", "#9a7350"], muzzle: "#e8dcc4", innerEar: "#e8dcc4" } }),
  rabbit: S({ ears: { shape: "long", size: 1 }, snout: { w: 0.18, h: 0.12, l: 0.12 }, tail: { shape: "pom" }, colors: { fur: ["#e8e0d8", "#c9b39a", "#9b8b7e", "#f4efe8"], nose: "#e48a96" } }),
  mouse: S({ ears: { shape: "round", size: 1.4, spread: 0.7 }, snout: { w: 0.14, h: 0.11, l: 0.3 }, tail: { shape: "long" }, colors: { fur: ["#9a9aa3", "#b8aa9a", "#7d7a80"], nose: "#e48a96" } }),
  pig: S({ ears: { shape: "flap", size: 1 }, snout: { w: 0.2, h: 0.15, l: 0.17 }, nose: "disc", tail: { shape: "curl" }, colors: { fur: ["#f0a8a8", "#e89a9a"], muzzle: "#f3b9b5" } }),
  owl: S({ ears: { shape: "tuft", size: 1 }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, eyeDiscs: true, tail: { shape: "fan" }, colors: { fur: ["#8a6a4a", "#a3835e", "#6e5640"] } }),
  frog: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, eyeBulge: true, tail: { shape: "none" }, colors: { fur: ["#5fb34a", "#79c25a", "#4a9a3c"] } }),
  dino: S({ ears: { shape: "none" }, snout: { w: 0.36, h: 0.22, l: 0.42 }, nose: false, spikes: true, tail: { shape: "thick" }, colors: { fur: ["#6cbf5a", "#4fa8a0", "#c86fb4", "#e0a23a"], muzzle: "#9ad48a", marks: "#e8c84a" } }),
  lion: S({ ears: { shape: "round", size: 0.7 }, snout: { w: 0.24, h: 0.15, l: 0.2 }, mane: true, tail: { shape: "tuft" }, colors: { fur: ["#d9a64e", "#c8963f"], muzzle: "#f0dcb0", mane: "#9a5a22" } }),
  tiger: S({ ears: { shape: "round", size: 0.75 }, snout: { w: 0.24, h: 0.15, l: 0.2 }, markings: "mask", tail: { shape: "curve", tip: true }, colors: { fur: ["#e8822e"], marks: "#2a2224", tailTip: "#2a2224" } }),
  panda: S({ ears: { shape: "round", size: 0.85 }, snout: { w: 0.22, h: 0.14, l: 0.16 }, markings: "patches", tail: { shape: "stub" }, colors: { fur: ["#f2efe8"], marks: "#2a2628", innerEar: "#2a2628", muzzle: "#f2efe8" } }),
  koala: S({ ears: { shape: "round", size: 1.35, spread: 0.75 }, snout: { w: 0.14, h: 0.16, l: 0.1 }, tail: { shape: "none" }, colors: { fur: ["#9a9aa0", "#a8a4a0"], innerEar: "#ece6e0", nose: "#3a3436" } }),
  raccoon: S({ ears: { shape: "pointed", size: 0.8 }, snout: { w: 0.16, h: 0.11, l: 0.24 }, markings: "mask", tail: { shape: "bushy", tip: true }, colors: { fur: ["#8a8580", "#7a756f"], marks: "#2a2628", tailTip: "#2a2628" } }),
  monkey: S({ ears: { shape: "round", size: 0.9, spread: 0.9 }, snout: { w: 0.26, h: 0.18, l: 0.12 }, tail: { shape: "long", length: 1.3 }, colors: { fur: ["#7a5232", "#8a6040"], muzzle: "#e8c9a2", innerEar: "#e8c9a2" } }),
  cow: S({ ears: { shape: "flap", size: 1.1, spread: 0.8 }, horns: "small", snout: { w: 0.26, h: 0.18, l: 0.2 }, tail: { shape: "tuft" }, colors: { fur: ["#f2efe8", "#7a5232"], muzzle: "#e8b0a8", nose: "#7a4a4a", marks: "#2a2628" } }),
  sheep: S({ ears: { shape: "flap", size: 0.9, spread: 0.85 }, snout: { w: 0.18, h: 0.14, l: 0.18 }, mane: true, tail: { shape: "pom" }, colors: { fur: ["#3a3436", "#efe8dc"], muzzle: "#3a3436", mane: "#f4efe6" } }),
  deer: S({ ears: { shape: "pointed", size: 1.1, spread: 0.8, tilt: 0.9 }, horns: "antlers", snout: { w: 0.16, h: 0.12, l: 0.26 }, tail: { shape: "pom" }, colors: { fur: ["#b07a48", "#a06a3c"] } }),
  horse: S({ ears: { shape: "pointed", size: 0.8 }, snout: { w: 0.2, h: 0.16, l: 0.4 }, nose: false, mane: true, tail: { shape: "bushy", length: 1.2 }, colors: { fur: ["#8a5a32", "#5a3a26", "#d8c8b0"], mane: "#3a2a20" } }),
  elephant: S({ ears: { shape: "flap", size: 2.1, spread: 0.9 }, snout: { w: 0.12, h: 0.12, l: 1.6 }, nose: false, tail: { shape: "long", length: 0.6 }, colors: { fur: ["#9aa0a8", "#8a9098"], muzzle: "#9aa0a8", innerEar: "#d8a8a8" } }),
  duck: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, tail: { shape: "fan", length: 0.6 }, colors: { fur: ["#f4efe6", "#e8d36a"], beak: "#e8902c" } }),
  // espèces du générateur d'animaux (mêmes noms) et autres animaux courants
  goat: S({ ears: { shape: "flap", size: 0.9, spread: 0.85 }, horns: "small", snout: { w: 0.16, h: 0.13, l: 0.26 }, tail: { shape: "stub" }, colors: { fur: ["#efe8dc", "#8a6a4c", "#3a3436"], muzzle: "#e8dcc4" } }),
  chicken: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, spikes: true, tail: { shape: "fan" }, colors: { fur: ["#f4efe6", "#b5673a", "#3a3436"], beak: "#e8b02c", marks: "#d8322a" } }),
  pigeon: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, tail: { shape: "fan", length: 0.8 }, colors: { fur: ["#8e939c", "#a6abb3"], beak: "#3a3436" } }),
  seagull: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, tail: { shape: "fan", length: 0.7 }, colors: { fur: ["#f4f4f2"], beak: "#e8c02c", tailTip: "#3a3436" } }),
  penguin: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, markings: "mask", tail: { shape: "stub" }, colors: { fur: ["#2a2a30"], beak: "#e8902c", marks: "#f4f2ee" } }),
  parrot: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, eyeDiscs: true, tail: { shape: "long", length: 1.4 }, colors: { fur: ["#3fb84a", "#d8322a", "#2f6bff", "#f2c418"], beak: "#3a3436" } }),
  eagle: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, tail: { shape: "fan" }, colors: { fur: ["#5a3a26", "#7a5232"], beak: "#e8c02c", mane: "#f4f2ee" } }),
  crow: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, tail: { shape: "fan" }, colors: { fur: ["#26262c"], beak: "#26262c" } }),
  swan: S({ ears: { shape: "none" }, snout: { w: 0, h: 0, l: 0 }, nose: false, beak: true, tail: { shape: "fan", length: 0.6 }, colors: { fur: ["#f6f4ee"], beak: "#e8702c" } }),
  wolf: S({ ears: { shape: "pointed", size: 1.15 }, snout: { w: 0.18, h: 0.14, l: 0.36 }, tail: { shape: "bushy" }, colors: { fur: ["#8a8580", "#5a5550", "#b8b0a4"], muzzle: "#e8e2d8" } }),
  squirrel: S({ ears: { shape: "tuft", size: 0.9 }, snout: { w: 0.16, h: 0.12, l: 0.14 }, tail: { shape: "bushy", length: 1.5 }, colors: { fur: ["#c0642a", "#8a5a32", "#9a9aa3"], muzzle: "#f2e6d4" } }),
  hedgehog: S({ ears: { shape: "round", size: 0.6 }, snout: { w: 0.14, h: 0.12, l: 0.28 }, spikes: true, tail: { shape: "none" }, colors: { fur: ["#c9b39a"], marks: "#5a4334", muzzle: "#e8dcc4" } }),
  otter: S({ ears: { shape: "round", size: 0.55 }, snout: { w: 0.24, h: 0.14, l: 0.14 }, tail: { shape: "thick" }, colors: { fur: ["#6e4a30", "#8a5e3c"], muzzle: "#d8c4a8" } }),
  beaver: S({ ears: { shape: "round", size: 0.55 }, snout: { w: 0.22, h: 0.15, l: 0.16 }, tail: { shape: "thick" }, colors: { fur: ["#7a5232", "#5c3d26"], muzzle: "#a88a6a" } }),
  hamster: S({ ears: { shape: "round", size: 0.8 }, snout: { w: 0.2, h: 0.13, l: 0.12 }, tail: { shape: "stub" }, colors: { fur: ["#e0a868", "#f2e6d4"], nose: "#e48a96", muzzle: "#f6efe4" } }),
  rat: S({ ears: { shape: "round", size: 1.1, spread: 0.7 }, snout: { w: 0.13, h: 0.1, l: 0.34 }, tail: { shape: "long", length: 1.4 }, colors: { fur: ["#7d7a80", "#5a5458"], nose: "#e48a96" } }),
  badger: S({ ears: { shape: "round", size: 0.6 }, snout: { w: 0.18, h: 0.12, l: 0.28 }, markings: "stripes", tail: { shape: "stub" }, colors: { fur: ["#8a8580"], marks: "#f4f2ee", muzzle: "#f4f2ee" } }),
  skunk: S({ ears: { shape: "round", size: 0.7 }, snout: { w: 0.16, h: 0.12, l: 0.22 }, markings: "stripes", tail: { shape: "bushy", length: 1.4, tip: true }, colors: { fur: ["#26262c"], marks: "#f4f2ee", tailTip: "#f4f2ee" } }),
  kangaroo: S({ ears: { shape: "pointed", size: 1.3, spread: 0.6 }, snout: { w: 0.16, h: 0.13, l: 0.3 }, tail: { shape: "thick", length: 1.4 }, colors: { fur: ["#b07a48", "#c48e5a"] } }),
  camel: S({ ears: { shape: "round", size: 0.6 }, snout: { w: 0.18, h: 0.16, l: 0.36 }, nose: false, tail: { shape: "tuft" }, colors: { fur: ["#c9a46a", "#b89058"] } }),
  llama: S({ ears: { shape: "long", size: 0.8, tilt: 0.1 }, snout: { w: 0.16, h: 0.14, l: 0.26 }, nose: false, mane: true, tail: { shape: "pom" }, colors: { fur: ["#f2e8da", "#c9a46a", "#7a5232"], mane: "#f2e8da" } }),
  giraffe: S({ ears: { shape: "pointed", size: 0.9, tilt: 0.9 }, horns: "small", snout: { w: 0.16, h: 0.14, l: 0.34 }, markings: "spots", tail: { shape: "tuft" }, colors: { fur: ["#e8c07a"], marks: "#9a5a28" } }),
  zebra: S({ ears: { shape: "pointed", size: 0.9 }, snout: { w: 0.18, h: 0.15, l: 0.38 }, nose: false, mane: true, markings: "stripes", tail: { shape: "tuft" }, colors: { fur: ["#f4f2ee"], marks: "#26262c", mane: "#26262c" } }),
  leopard: S({ ears: { shape: "round", size: 0.7 }, snout: { w: 0.22, h: 0.14, l: 0.18 }, markings: "spots", tail: { shape: "long" }, colors: { fur: ["#e0aa58"], marks: "#3a2a20", muzzle: "#f6ead4" } }),
  cheetah: S({ ears: { shape: "round", size: 0.65 }, snout: { w: 0.2, h: 0.13, l: 0.16 }, markings: "spots", tail: { shape: "long", tip: true }, colors: { fur: ["#e8b868"], marks: "#2a2224", tailTip: "#f4f2ee" } }),
  rhino: S({ ears: { shape: "pointed", size: 0.7 }, horns: "small", snout: { w: 0.28, h: 0.2, l: 0.3 }, nose: false, tail: { shape: "tuft", length: 0.6 }, colors: { fur: ["#8a8a8e", "#9a9a9a"] } }),
  hippo: S({ ears: { shape: "round", size: 0.45 }, snout: { w: 0.36, h: 0.22, l: 0.26 }, nose: false, tail: { shape: "stub" }, colors: { fur: ["#8a7a8a", "#9a8a90"], muzzle: "#d8a8a8" } }),
  gorilla: S({ ears: { shape: "round", size: 0.55, spread: 0.9 }, snout: { w: 0.3, h: 0.2, l: 0.1 }, tail: { shape: "none" }, colors: { fur: ["#2a2a2e"], muzzle: "#4a4448", innerEar: "#4a4448" } }),
  sloth: S({ ears: { shape: "none" }, snout: { w: 0.2, h: 0.14, l: 0.1 }, markings: "mask", tail: { shape: "none" }, colors: { fur: ["#a8987e"], marks: "#5a4334", muzzle: "#e8dcc4" } }),
  bat: S({ ears: { shape: "pointed", size: 1.7, spread: 0.7 }, snout: { w: 0.14, h: 0.1, l: 0.12 }, tail: { shape: "none" }, colors: { fur: ["#3a3436", "#5a4334"], innerEar: "#b88a8a" } }),
  turtle: S({ ears: { shape: "none" }, snout: { w: 0.18, h: 0.12, l: 0.16 }, nose: false, tail: { shape: "stub" }, colors: { fur: ["#7aa05a", "#8ab06a"], muzzle: "#c8d8a0" } }),
  lizard: S({ ears: { shape: "none" }, snout: { w: 0.22, h: 0.12, l: 0.34 }, nose: false, eyeBulge: true, tail: { shape: "long", length: 1.5 }, colors: { fur: ["#6cbf5a", "#4fa8a0"], muzzle: "#9ad48a" } }),
  crocodile: S({ ears: { shape: "none" }, snout: { w: 0.3, h: 0.14, l: 0.7 }, nose: false, eyeBulge: true, spikes: true, tail: { shape: "thick", length: 1.6 }, colors: { fur: ["#5a7a3a", "#4a6a32"], muzzle: "#8aa05a", marks: "#3a5228" } }),
  dragon: S({ ears: { shape: "pointed", size: 0.8, tilt: 1 }, horns: "small", snout: { w: 0.3, h: 0.18, l: 0.46 }, nose: false, spikes: true, tail: { shape: "thick", length: 1.6 }, colors: { fur: ["#c8322a", "#2f8a5a", "#6a3aa8"], muzzle: "#e8a85a", marks: "#e8c84a" } }),
};

/**
 * Noms d'animaux reconnus en plus des fiches (français, synonymes, espèces voisines) → fiche la plus proche. Un nom
 * absent de cette table et des fiches prend la fiche dont le nom est le plus proche, ou la fiche générique.
 */
export const ANIMAL_ALIASES: Record<string, string> = {
  chat: "cat", renard: "fox", chien: "dog", ours: "bear", lapin: "rabbit", lievre: "rabbit", hare: "rabbit", souris: "mouse", cochon: "pig", porc: "pig", sanglier: "pig", boar: "pig",
  hibou: "owl", chouette: "owl", grenouille: "frog", crapaud: "frog", toad: "frog", dinosaure: "dino", dinosaur: "dino", tigre: "tiger", ourspolaire: "bear",
  ratonlaveur: "raccoon", singe: "monkey", chimpanze: "monkey", chimpanzee: "monkey", ape: "gorilla", vache: "cow", taureau: "cow", bull: "cow", boeuf: "cow", ox: "cow", bison: "cow", buffalo: "cow",
  mouton: "sheep", brebis: "sheep", agneau: "sheep", lamb: "sheep", cerf: "deer", biche: "deer", chevreuil: "deer", renne: "deer", reindeer: "deer", moose: "deer", elan: "deer", orignal: "deer",
  cheval: "horse", poney: "horse", pony: "horse", ane: "horse", donkey: "horse", mule: "horse", licorne: "horse", unicorn: "horse", elephant: "elephant", mammouth: "elephant", mammoth: "elephant",
  canard: "duck", oie: "duck", goose: "duck", chevre: "goat", bouc: "goat", poule: "chicken", coq: "chicken", rooster: "chicken", hen: "chicken", poussin: "chicken", dinde: "chicken", turkey: "chicken",
  colombe: "pigeon", dove: "pigeon", mouette: "seagull", goeland: "seagull", gull: "seagull", pingouin: "penguin", manchot: "penguin", perroquet: "parrot", perruche: "parrot", toucan: "parrot",
  aigle: "eagle", faucon: "eagle", falcon: "eagle", hawk: "eagle", vautour: "eagle", vulture: "eagle", corbeau: "crow", corneille: "crow", raven: "crow", pie: "crow", magpie: "crow", cygne: "swan",
  oiseau: "pigeon", bird: "pigeon", moineau: "pigeon", sparrow: "pigeon", merle: "crow", blackbird: "crow",
  loup: "wolf", coyote: "wolf", chacal: "wolf", jackal: "wolf", husky: "wolf", hyene: "wolf", hyena: "wolf", ecureuil: "squirrel", chipmunk: "squirrel", tamia: "squirrel",
  herisson: "hedgehog", porcupine: "hedgehog", porcepic: "hedgehog", loutre: "otter", furet: "otter", ferret: "otter", belette: "otter", weasel: "otter", vison: "otter", mink: "otter", hermine: "otter",
  castor: "beaver", marmotte: "beaver", marmot: "beaver", cochondinde: "hamster", guineapig: "hamster", gerbille: "hamster", gerbil: "hamster", blaireau: "badger", moufette: "skunk", mouffette: "skunk",
  kangourou: "kangaroo", wallaby: "kangaroo", chameau: "camel", dromadaire: "camel", dromedary: "camel", lama: "llama", alpaga: "llama", alpaca: "llama", girafe: "giraffe", zebre: "zebra",
  leopard: "leopard", panthere: "leopard", panther: "leopard", jaguar: "leopard", lynx: "cat", guepard: "cheetah", lionne: "lion", lioness: "lion",
  rhinoceros: "rhino", hippopotame: "hippo", hippopotamus: "hippo", gorille: "gorilla", orangoutan: "gorilla", orangutan: "gorilla", paresseux: "sloth", chauvesouris: "bat",
  tortue: "turtle", tortoise: "turtle", lezard: "lizard", iguane: "lizard", iguana: "lizard", gecko: "lizard", cameleon: "lizard", chameleon: "lizard", salamandre: "lizard", salamander: "lizard",
  crocodile: "crocodile", alligator: "crocodile", caiman: "crocodile", dragon: "dragon",
  pandaroux: "raccoon", redpanda: "raccoon", koala: "koala",
};

/** Nom libre → clé de fiche : minuscules, sans accents ni espaces ni tirets. */
export function animalKey(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Espèce d'un personnage pour n'importe quel nom d'animal : fiche livrée, alias (français, synonymes, espèces
 * voisines), sinon nom de fiche ou d'alias le plus proche (fautes de frappe) ; `null` si rien d'assez proche (la fiche
 * générique sert alors).
 */
export function matchAnimal(name: string): { species: string; exact: boolean } | null {
  const k = animalKey(name);
  if (!k) return null;
  if (ANIMAL_SPECS[k]) return { species: k, exact: true };
  if (ANIMAL_ALIASES[k]) return { species: ANIMAL_ALIASES[k], exact: true };
  // pluriel simple
  const sing = k.replace(/(s|x)$/, "");
  if (ANIMAL_SPECS[sing]) return { species: sing, exact: true };
  if (ANIMAL_ALIASES[sing]) return { species: ANIMAL_ALIASES[sing], exact: true };
  let best: string | null = null, bd = Infinity;
  for (const cand of [...Object.keys(ANIMAL_SPECS), ...Object.keys(ANIMAL_ALIASES)]) {
    const d = lev(k, cand);
    if (d < bd) (bd = d), (best = cand);
  }
  if (best && bd <= Math.max(1, Math.floor(k.length / 4))) return { species: ANIMAL_SPECS[best] ? best : ANIMAL_ALIASES[best], exact: false };
  return null;
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export const ANIMAL_NAMES = Object.keys(ANIMAL_SPECS);


/** Fusion tolérante (JSON d'agent) : valeurs inconnues ignorées, nombres bornés. */
export function mergeSpec(base: AnimalSpec, o: unknown): AnimalSpec {
  const src = o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  const obj = (k: string) => (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) ? (src[k] as Record<string, unknown>) : {});
  const n = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const e = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
  const c = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v : d);
  const ea = obj("ears"), sn = obj("snout"), tl = obj("tail"), co = obj("colors");
  const fur = Array.isArray(co.fur) ? co.fur.filter((x): x is string => typeof x === "string" && HEX.test(x)) : typeof co.fur === "string" && HEX.test(co.fur) ? [co.fur] : [];
  return {
    ears: { shape: e(ea.shape, EARS, base.ears.shape), size: n(ea.size, base.ears.size, 0, 3), spread: n(ea.spread, base.ears.spread, 0, 1), tilt: n(ea.tilt, base.ears.tilt, -1, 1.5) },
    horns: e(src.horns, ["none", "small", "antlers"] as const, base.horns),
    snout: { w: n(sn.w, base.snout.w, 0, 0.6), h: n(sn.h, base.snout.h, 0, 0.4), l: n(sn.l, base.snout.l, 0, 2.2) },
    nose: src.nose === "disc" ? "disc" : typeof src.nose === "boolean" ? src.nose : base.nose,
    beak: b(src.beak, base.beak),
    mane: b(src.mane, base.mane),
    markings: e(src.markings, ["none", "mask", "patches", "spots", "stripes"] as const, base.markings),
    eyeBulge: b(src.eyeBulge, base.eyeBulge),
    spikes: b(src.spikes, base.spikes),
    eyeDiscs: b(src.eyeDiscs, base.eyeDiscs),
    tail: { shape: e(tl.shape, TAILS, base.tail.shape), length: n(tl.length, base.tail.length, 0, 3), tip: b(tl.tip, base.tail.tip) },
    colors: {
      fur: fur.length ? fur : base.colors.fur,
      muzzle: c(co.muzzle, base.colors.muzzle),
      nose: c(co.nose, base.colors.nose),
      innerEar: c(co.innerEar, base.colors.innerEar),
      beak: c(co.beak, base.colors.beak),
      mane: c(co.mane, base.colors.mane),
      marks: c(co.marks, base.colors.marks),
      tailTip: c(co.tailTip, base.colors.tailTip),
    },
  };
}

/** Fiche d'un personnage : espèce livrée (ou `custom` / inconnue → base) retouchée par `animalSpec`. */
export function resolveAnimal(name: string, spec: unknown): AnimalSpec | null {
  const hasSpec = spec && typeof spec === "object" && Object.keys(spec as object).length > 0;
  if (name === "none" && !hasSpec) return null;
  return mergeSpec(ANIMAL_SPECS[name] ?? BASE, spec);
}

/**
 * Rôles de couleur réservés au personnage animal (le même rôle peut servir ailleurs sur un humain) :
 * museau → white, truffe → black, intérieur des oreilles → sky, bec → orange, crinière / oreilles tombantes → hair,
 * marques → bark, bout de queue → paper.
 */
export const ANIMAL_ROLE = { muzzle: "white", nose: "black", innerEar: "sky", beak: "orange", mane: "hair", marks: "bark", tailTip: "paper" } as const;
