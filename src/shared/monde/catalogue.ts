/**
 * Catalogue de mobilier du format « monde » : des prefabs (voir prefab.ts) disponibles par leur nom, sans les écrire
 * dans `models`. `{"model": "lit", "against": "mur2", "at": 70, "params": {"type": "mezzanine", "largeur": 90}}` suffit.
 *
 * Tous sont écrits en mètres (`unite: "m"`) ; leurs longueurs se donnent dans l'unité du document. Conventions :
 * base en y = 0 ; un meuble qui va contre un mur a son dos en z = 0 et s'étend vers +z ; un objet mural aussi ; une
 * suspension s'accroche en y = 0 et descend. Un modèle du monde du même nom remplace celui du catalogue.
 *
 * Les assises (chaise, fauteuil, canapé, pouf, banc, transat…) et le végétal (arbres, buissons, fleurs) viennent des
 * générateurs procgen (`{"gen": "seat.armchair"}`, `{"gen": "tree"}`) : ils ne sont pas refaits ici.
 */
type Obj = Record<string, unknown>;

/** Longueur réglable (mètres dans ce fichier, unité du document pour l'auteur). */
const len = (def: number, min: number, max: number, step: number): Obj => ({ default: def, min, max, step, unit: "m" });
const pick = (def: string | number, ...options: (string | number)[]): Obj => ({ default: def, options: [def, ...options.filter((o) => o !== def)] });
const lens = (def: number, ...options: number[]): Obj => ({ ...pick(def, ...options), unit: "m" });
const mat = (def: string): Obj => ({ type: "matiere", default: def });
const col = (def: string): Obj => ({ default: def });
const yes = (def: boolean): Obj => ({ type: "bool", default: def });
/** Éclat d'une source de lumière selon `allume`. */
const GLOW = "= allume ? 0.75 : 0";

const lit: Obj = {
  famille: "lit",
  pose: "sol",
  tags: ["chambre"],
  params: {
    type: pick("simple", "mezzanine", "superpose"),
    largeur: lens(0.9, 1.2, 1.4, 1.6),
    longueur: lens(2, 1.9, 2.1),
    structure: mat("pin"),
    drap: col("#f4f1ea"),
    couette: col("#7fa6c9"),
    tete: yes(true),
  },
  vars: { H: "= type == 'simple' ? 0.3 : type == 'mezzanine' ? 1.7 : 1.5", W: "= largeur + 0.06", L: "= longueur + 0.06", haut: "= type != 'simple'" },
  parts: [
    { name: "sommier", box: ["= W", 0.12, "= L"], at: [0, "= H - 0.06", "= L / 2"], matiere: "= structure" },
    { name: "matelas", box: ["= largeur", 0.16, "= longueur", 0.03], at: [0, "= H + 0.08", "= L / 2"], color: "= drap" },
    { name: "couette", box: ["= largeur + 0.02", 0.06, "= longueur * 0.62", 0.03], at: [0, "= H + 0.18", "= L - longueur * 0.31 - 0.03"], color: "= couette", tex: "tissu", surface: "top" },
    { name: "oreiller", if: "= largeur < 1.3", box: ["= largeur * 0.72", 0.1, 0.36, 0.04], at: [0, "= H + 0.2", 0.26], color: "#ffffff" },
    { name: "oreillers", if: "= largeur >= 1.3", box: ["= largeur * 0.42", 0.1, 0.36, 0.04], at: ["= largeur / 4", "= H + 0.2", 0.26], mirror: "x", color: "#ffffff" },
    { name: "piedTete", box: [0.07, "= haut ? H + 0.4 : H - 0.12", 0.07], at: ["= W / 2 - 0.035", "= (haut ? H + 0.4 : H - 0.12) / 2", 0.035], mirror: "x", matiere: "= structure" },
    { name: "piedPied", box: [0.07, "= haut ? H + 0.4 : H - 0.12", 0.07], at: ["= W / 2 - 0.035", "= (haut ? H + 0.4 : H - 0.12) / 2", "= L - 0.035"], mirror: "x", matiere: "= structure" },
    { name: "tete", if: "= tete and not haut", box: ["= W", 0.55, 0.04], at: [0, "= H + 0.2", 0.02], matiere: "= structure" },
    { name: "garde", if: "= haut", box: [0.03, 0.09, "= L - 0.14"], at: ["= W / 2 - 0.015", "= H + 0.32", "= L / 2"], mirror: "x", matiere: "= structure" },
    { name: "gardeTete", if: "= haut", box: ["= W - 0.14", 0.09, 0.03], at: [0, "= H + 0.32", 0.015], matiere: "= structure" },
    { name: "echelle", if: "= haut", box: [0.04, "= H + 0.3", 0.04], at: ["= W / 2 + 0.03", "= (H + 0.3) / 2", "= L - 0.15"], matiere: "= structure" },
    { name: "echelle2", if: "= haut", box: [0.04, "= H + 0.3", 0.04], at: ["= W / 2 + 0.03", "= (H + 0.3) / 2", "= L - 0.55"], matiere: "= structure" },
    { name: "barreau", if: "= haut", box: [0.03, 0.03, 0.4], at: ["= W / 2 + 0.03", 0.3, "= L - 0.35"], repeat: { n: "= floor(H / 0.3)", at: [0, 0.3, 0] }, matiere: "= structure" },
    { name: "sommierBas", if: "= type == 'superpose'", box: ["= W", 0.12, "= L"], at: [0, 0.24, "= L / 2"], matiere: "= structure" },
    { name: "matelasBas", if: "= type == 'superpose'", box: ["= largeur", 0.16, "= longueur", 0.03], at: [0, 0.38, "= L / 2"], color: "= drap" },
    { name: "couetteBas", if: "= type == 'superpose'", box: ["= largeur + 0.02", 0.06, "= longueur * 0.62", 0.03], at: [0, 0.48, "= L - longueur * 0.31 - 0.03"], color: "= couette", tex: "tissu" },
  ],
};

const bureau: Obj = {
  famille: "bureau",
  pose: "sol",
  tags: ["chambre", "bureau"],
  params: { largeur: len(1.2, 0.8, 2.4, 0.1), profondeur: lens(0.6, 0.5, 0.7, 0.8), hauteur: len(0.74, 0.5, 1.1, 0.02), plateau: mat("chene"), pietement: pick("panneaux", "metal", "treteaux"), teinte: col("#f1eee8"), caisson: yes(false) },
  vars: { h: "= hauteur - 0.03" },
  parts: [
    { name: "plateau", box: ["= largeur", 0.03, "= profondeur", 0.004], at: [0, "= hauteur - 0.015", "= profondeur / 2"], matiere: "= plateau", surface: "top" },
    { name: "panneau", if: "= pietement == 'panneaux'", box: [0.03, "= h", "= profondeur - 0.04"], at: ["= largeur / 2 - 0.04", "= h / 2", "= profondeur / 2"], mirror: "x", color: "= teinte" },
    { name: "voile", if: "= pietement == 'panneaux'", box: ["= largeur - 0.1", "= h * 0.4", 0.02], at: [0, "= h * 0.75", 0.05], color: "= teinte" },
    { name: "piedAr", if: "= pietement == 'metal'", cylinder: [0.02, "= h"], at: ["= largeur / 2 - 0.06", "= h / 2", 0.06], mirror: "x", matiere: "metal-noir" },
    { name: "piedAv", if: "= pietement == 'metal'", cylinder: [0.02, "= h"], at: ["= largeur / 2 - 0.06", "= h / 2", "= profondeur - 0.06"], mirror: "x", matiere: "metal-noir" },
    { name: "treteauAr", if: "= pietement == 'treteaux'", box: [0.04, "= h - 0.005", 0.04], at: ["= largeur / 2 - 0.22", "= h / 2", 0.1], rot: [-9, 0, 0], mirror: "x", matiere: "pin" },
    { name: "treteauAv", if: "= pietement == 'treteaux'", box: [0.04, "= h - 0.005", 0.04], at: ["= largeur / 2 - 0.22", "= h / 2", "= profondeur - 0.1"], rot: [9, 0, 0], mirror: "x", matiere: "pin" },
    { name: "caisson", if: "= caisson", box: [0.4, "= h - 0.1", "= profondeur - 0.08"], at: ["= largeur / 2 - 0.27", "= (h - 0.1) / 2 + 0.1", "= profondeur / 2"], color: "= teinte" },
    { name: "tiroir", if: "= caisson", box: [0.36, 0.015, 0.02], at: ["= largeur / 2 - 0.27", "= h * 0.3", "= profondeur - 0.03"], repeat: { n: 3, at: [0, "= (h - 0.1) / 3.4", 0] }, matiere: "acier" },
  ],
};

const table: Obj = {
  famille: "table",
  pose: "sol",
  tags: ["salon", "jardin", "cuisine"],
  params: { forme: pick("rectangle", "ronde"), largeur: len(1.2, 0.4, 3, 0.1), profondeur: len(0.8, 0.4, 1.6, 0.1), hauteur: len(0.74, 0.3, 1.1, 0.02), plateau: mat("chene"), pieds: mat("metal-noir") },
  vars: { h: "= hauteur - 0.03" },
  parts: [
    { name: "plateau", if: "= forme == 'rectangle'", box: ["= largeur", 0.03, "= profondeur", 0.005], at: [0, "= hauteur - 0.015", 0], matiere: "= plateau", surface: "top" },
    { name: "piedAv", if: "= forme == 'rectangle'", box: [0.05, "= h", 0.05], at: ["= largeur / 2 - 0.06", "= h / 2", "= profondeur / 2 - 0.06"], mirror: "x", matiere: "= pieds" },
    { name: "piedAr", if: "= forme == 'rectangle'", box: [0.05, "= h", 0.05], at: ["= largeur / 2 - 0.06", "= h / 2", "= 0.06 - profondeur / 2"], mirror: "x", matiere: "= pieds" },
    { name: "rond", if: "= forme == 'ronde'", cylinder: ["= largeur / 2", 0.03], at: [0, "= hauteur - 0.015", 0], matiere: "= plateau", surface: "top" },
    { name: "fut", if: "= forme == 'ronde'", cylinder: [0.04, "= h"], at: [0, "= h / 2", 0], matiere: "= pieds" },
    { name: "base", if: "= forme == 'ronde'", cylinder: ["= largeur * 0.28", 0.025], at: [0, 0.0125, 0], matiere: "= pieds" },
  ],
};

const etagere: Obj = {
  famille: "etagere",
  pose: "mur",
  tags: ["chambre", "salon", "bureau"],
  params: { pose: pick("mur", "sol"), largeur: len(0.8, 0.3, 2.4, 0.1), niveaux: pick(3, 1, 2, 4, 5, 6), ecart: len(0.32, 0.2, 0.5, 0.02), profondeur: lens(0.22, 0.15, 0.3, 0.4), structure: mat("chene"), fond: yes(false) },
  vars: { base: "= pose == 'sol' ? 0.08 : 0", HT: "= (niveaux - 1) * ecart + 0.025 + (pose == 'sol' ? 0.08 : 0)" },
  parts: [
    { name: "planche", box: ["= largeur", 0.025, "= profondeur"], at: [0, "= base + 0.0125", "= profondeur / 2"], repeat: { n: "= niveaux", at: [0, "= ecart", 0] }, matiere: "= structure" },
    { name: "montant", if: "= niveaux > 1 or pose == 'sol'", box: [0.025, "= HT", "= profondeur"], at: ["= largeur / 2 - 0.0125", "= HT / 2", "= profondeur / 2"], mirror: "x", matiere: "= structure" },
    { name: "fond", if: "= fond", box: ["= largeur", "= HT", 0.008], at: [0, "= HT / 2", 0.004], matiere: "blanc" },
  ],
};

const armoire: Obj = {
  famille: "rangement",
  pose: "sol",
  tags: ["chambre", "entree"],
  params: { largeur: len(1, 0.5, 3, 0.25), hauteur: len(2, 1.2, 2.6, 0.1), profondeur: lens(0.6, 0.45, 0.65), portes: pick("battantes", "coulissantes"), structure: mat("bois-blanc"), facade: col("#f1eee8") },
  vars: { N: "= portes == 'battantes' ? max(1, round(largeur / 0.5)) : max(2, round(largeur / 0.9))", w: "= largeur / (portes == 'battantes' ? max(1, round(largeur / 0.5)) : max(2, round(largeur / 0.9)))" },
  parts: [
    { name: "caisse", box: ["= largeur", "= hauteur", "= profondeur - 0.03"], at: [0, "= hauteur / 2", "= (profondeur - 0.03) / 2"], matiere: "= structure" },
    { name: "porte", if: "= portes == 'battantes'", box: ["= w - 0.006", "= hauteur - 0.06", 0.02], at: ["= w / 2 - largeur / 2", "= hauteur / 2", "= profondeur - 0.02"], repeat: { n: "= N", at: ["= w", 0, 0] }, color: "= facade" },
    { name: "poignee", if: "= portes == 'battantes'", box: [0.015, 0.18, 0.02], at: ["= w - 0.05 - largeur / 2", "= min(1.1, hauteur / 2)", "= profondeur"], repeat: { n: "= N", at: ["= w", 0, 0] }, matiere: "acier" },
    { name: "vantailA", if: "= portes == 'coulissantes'", box: ["= w + 0.02", "= hauteur - 0.06", 0.015], at: ["= w / 2 - largeur / 2", "= hauteur / 2", "= profondeur - 0.03"], repeat: { n: "= ceil(N / 2)", at: ["= 2 * w", 0, 0] }, color: "= facade" },
    { name: "vantailB", if: "= portes == 'coulissantes'", box: ["= w + 0.02", "= hauteur - 0.06", 0.015], at: ["= 1.5 * w - largeur / 2", "= hauteur / 2", "= profondeur - 0.012"], repeat: { n: "= floor(N / 2)", at: ["= 2 * w", 0, 0] }, color: "= facade", tex: { kind: "rayures", scale: 1, contrast: 0.08 } },
  ],
};

const commode: Obj = {
  famille: "rangement",
  pose: "sol",
  tags: ["chambre", "entree"],
  params: { largeur: len(0.8, 0.4, 1.8, 0.1), hauteur: len(0.8, 0.4, 1.3, 0.1), profondeur: lens(0.45, 0.35, 0.55), tiroirs: pick(3, 1, 2, 4, 5), structure: mat("chene"), facade: col("#f1eee8") },
  vars: { h: "= (hauteur - 0.1) / tiroirs" },
  parts: [
    { name: "caisse", box: ["= largeur", "= hauteur - 0.08", "= profondeur - 0.02"], at: [0, "= (hauteur - 0.08) / 2 + 0.08", "= (profondeur - 0.02) / 2"], matiere: "= structure", surface: "top" },
    { name: "pied", box: [0.04, 0.08, 0.04], at: ["= largeur / 2 - 0.05", 0.04, "= profondeur / 2"], mirror: "x", matiere: "= structure" },
    { name: "tiroir", box: ["= largeur - 0.03", "= h - 0.012", 0.02], at: [0, "= 0.09 + h / 2", "= profondeur - 0.01"], repeat: { n: "= tiroirs", at: [0, "= h", 0] }, color: "= facade" },
    { name: "bouton", sphere: 0.014, at: [0, "= 0.09 + h / 2", "= profondeur + 0.012"], repeat: { n: "= tiroirs", at: [0, "= h", 0] }, matiere: "laiton" },
  ],
};

const tapis: Obj = {
  famille: "tapis",
  pose: "sol",
  tags: ["chambre", "salon"],
  params: {
    forme: pick("rectangle", "rond"),
    largeur: len(1.6, 0.5, 4, 0.1),
    longueur: len(1.1, 0.5, 4, 0.1),
    teinte: col("#3d6b8c"),
    motif: pick("uni", "tricot", "rayures", "pois", "damier", "chevron", "ecailles", "hachures", "carrelage", "brique", "nuages", "camouflage", "fourrure"),
    // seconde couleur et dessin du motif (pas de motif sans contraste : `uni` garde un léger grain)
    teinte2: col("#f1eee8"),
    echelle: { default: 6, min: 1, max: 24, step: 1 },
    angle: { default: 0, min: 0, max: 165, step: 15 },
  },
  vars: { tex: "= motif == 'uni' ? 'tissu' : motif" },
  parts: [
    { name: "tapis", if: "= forme == 'rectangle'", box: ["= largeur", 0.012, "= longueur", 0.004], at: [0, 0.006, 0], color: "= teinte", tex: { kind: "= tex", color2: "= teinte2", scale: "= echelle", angle: "= angle", contrast: "= motif == 'uni' ? 0.3 : 0.85" } },
    { name: "rond", if: "= forme == 'rond'", cylinder: ["= largeur / 2", 0.012], at: [0, 0.006, 0], color: "= teinte", tex: { kind: "= tex", color2: "= teinte2", scale: "= echelle", angle: "= angle", contrast: "= motif == 'uni' ? 0.3 : 0.85" } },
  ],
};

const coussin: Obj = {
  famille: "coussin",
  souple: true,
  pose: "dessus",
  tags: ["chambre", "salon"],
  params: { forme: pick("carre", "rond"), taille: len(0.45, 0.3, 0.8, 0.05), teinte: col("#e0a458") },
  parts: [
    { name: "carre", if: "= forme == 'carre'", box: ["= taille", 0.14, "= taille", 0.06], at: [0, 0.07, 0], color: "= teinte", tex: "tissu" },
    { name: "rond", if: "= forme == 'rond'", sphere: ["= taille / 2", 0.08, "= taille / 2"], at: [0, 0.08, 0], color: "= teinte", tex: "tissu" },
  ],
};

const rideau: Obj = {
  famille: "rideau",
  souple: true,
  pose: "mur",
  tags: ["chambre", "salon"],
  params: { largeur: len(1.6, 0.6, 4, 0.1), hauteur: len(2.2, 1, 3, 0.1), ouverture: pick(0.5, 0, 0.25, 0.75, 1), teinte: col("#d9d0c1"), tringle: mat("metal-noir") },
  vars: { w: "= max(0.14, (largeur / 2) * (1 - ouverture * 0.8))" },
  parts: [
    { name: "tringle", cylinder: [0.012, "= largeur + 0.12"], at: [0, "= hauteur", 0.07], rot: [0, 0, 90], matiere: "= tringle" },
    { name: "embout", sphere: 0.022, at: ["= largeur / 2 + 0.06", "= hauteur", 0.07], mirror: "x", matiere: "= tringle" },
    { name: "pan", box: ["= w", "= hauteur - 0.03", 0.05, 0.02], at: ["= largeur / 2 - w / 2", "= (hauteur - 0.03) / 2", 0.07], mirror: "x", color: "= teinte", tex: { kind: "rayures", scale: 16, contrast: 0.22 } },
  ],
};

const shade = (y: string): Obj[] => [
  { name: "abatCone", if: "= abat == 'cone'", cylinder: [0.2, 0.24, 0.1], at: [0, y, 0], color: "= teinte", glow: GLOW },
  { name: "abatCylindre", if: "= abat == 'cylindre'", cylinder: [0.17, 0.24, 0.17], at: [0, y, 0], color: "= teinte", glow: GLOW },
  { name: "abatBoule", if: "= abat == 'boule'", sphere: 0.16, at: [0, y, 0], color: "= teinte", glow: GLOW },
];
const lampParams = { abat: pick("cone", "cylindre", "boule"), teinte: col("#fff1c9"), structure: mat("laiton"), allume: yes(true) };

const lampadaire: Obj = {
  famille: "luminaire",
  pose: "sol",
  tags: ["salon", "chambre"],
  params: { hauteur: len(1.5, 1.1, 1.9, 0.1), ...lampParams },
  parts: [
    { name: "socle", cylinder: [0.14, 0.02], at: [0, 0.01, 0], matiere: "= structure" },
    { name: "tige", cylinder: [0.012, "= hauteur - 0.24"], at: [0, "= (hauteur - 0.24) / 2", 0], matiere: "= structure" },
    ...shade("= hauteur - 0.12"),
  ],
};

const lampe: Obj = {
  famille: "luminaire",
  pose: "dessus",
  tags: ["bureau", "chevet"],
  params: { hauteur: len(0.4, 0.25, 0.7, 0.05), ...lampParams },
  vars: { k: "= hauteur / 0.75" },
  parts: [
    { name: "socle", cylinder: ["= 0.12 * k", 0.02], at: [0, 0.01, 0], matiere: "= structure" },
    { name: "tige", cylinder: [0.01, "= hauteur * 0.62"], at: [0, "= hauteur * 0.31", 0], matiere: "= structure" },
    { name: "abatCone", if: "= abat == 'cone'", cylinder: ["= 0.2 * k", "= 0.24 * k", "= 0.1 * k"], at: [0, "= hauteur - 0.12 * k", 0], color: "= teinte", glow: GLOW },
    { name: "abatCylindre", if: "= abat == 'cylindre'", cylinder: ["= 0.16 * k", "= 0.24 * k", "= 0.16 * k"], at: [0, "= hauteur - 0.12 * k", 0], color: "= teinte", glow: GLOW },
    { name: "abatBoule", if: "= abat == 'boule'", sphere: "= 0.15 * k", at: [0, "= hauteur - 0.15 * k", 0], color: "= teinte", glow: GLOW },
  ],
};

const suspension: Obj = {
  famille: "luminaire",
  pose: "plafond",
  tags: ["salon", "chambre", "cuisine"],
  params: { longueur: len(0.6, 0.2, 1.6, 0.1), ...lampParams },
  parts: [
    { name: "rosace", cylinder: [0.05, 0.02], at: [0, -0.01, 0], matiere: "= structure" },
    { name: "fil", cylinder: [0.004, "= longueur"], at: [0, "= -longueur / 2", 0], matiere: "noir" },
    { name: "abatCone", if: "= abat == 'cone'", cylinder: [0.22, 0.2, 0.07], at: [0, "= -longueur - 0.1", 0], color: "= teinte", glow: GLOW },
    { name: "abatCylindre", if: "= abat == 'cylindre'", cylinder: [0.18, 0.22, 0.18], at: [0, "= -longueur - 0.11", 0], color: "= teinte", glow: GLOW },
    { name: "abatBoule", if: "= abat == 'boule'", sphere: 0.17, at: [0, "= -longueur - 0.17", 0], color: "= teinte", glow: GLOW },
  ],
};

const applique: Obj = {
  famille: "luminaire",
  pose: "mur",
  tags: ["chambre", "couloir"],
  params: { teinte: col("#fff1c9"), structure: mat("laiton"), allume: yes(true) },
  parts: [
    { name: "platine", box: [0.1, 0.14, 0.015], at: [0, 0.07, 0.0075], matiere: "= structure" },
    { name: "bras", cylinder: [0.008, 0.1], at: [0, 0.09, 0.06], rot: [90, 0, 0], matiere: "= structure" },
    { name: "globe", sphere: 0.07, at: [0, 0.1, 0.13], color: "= teinte", glow: GLOW },
  ],
};

const cadre: Obj = {
  famille: "decoration",
  pose: "mur",
  tags: ["chambre", "salon"],
  params: { largeur: len(0.5, 0.15, 2, 0.05), hauteur: len(0.4, 0.15, 2, 0.05), cadre: col("#2a2623"), image: col("#c9d6df"), miroir: yes(false) },
  parts: [
    { name: "cadre", box: ["= largeur", "= hauteur", 0.02], at: [0, "= hauteur / 2", 0.01], color: "= cadre" },
    { name: "image", box: ["= largeur - 0.06", "= hauteur - 0.06", 0.004], at: [0, "= hauteur / 2", 0.021], color: "= miroir ? '#dbe8ee' : image", glow: "= miroir ? 0.3 : 0", tex: "= miroir ? 'metal' : 'nuages'" },
  ],
};

/**
 * Poster au mur : une image du monde (`monde.images`, nommée par `image`) sur un carton, avec ou sans baguette.
 * Sans image (ou image inconnue) : carton uni de la couleur `fond`.
 */
const poster: Obj = {
  famille: "decoration",
  pose: "mur",
  tags: ["chambre", "salon"],
  params: { largeur: len(0.5, 0.15, 1.5, 0.05), hauteur: len(0.7, 0.15, 1.5, 0.05), image: { type: "texte", default: "" }, baguette: pick("aucune", "noire", "bois", "blanche"), fond: col("#f1eee8") },
  vars: { bc: "= baguette == 'noire' ? '#1f1f22' : baguette == 'bois' ? '#b98a56' : '#f4f1ea'" },
  parts: [
    { name: "baguette", if: "= baguette != 'aucune'", box: ["= largeur + 0.03", "= hauteur + 0.03", 0.016], at: [0, "= hauteur / 2", 0.008], color: "= bc" },
    { name: "affiche", box: ["= largeur", "= hauteur", 0.004], at: [0, "= hauteur / 2", "= baguette != 'aucune' ? 0.018 : 0.002"], color: "= fond", image: "= image" },
  ],
};

const plante: Obj = {
  famille: "plante",
  souple: true,
  pose: "sol",
  tags: ["salon", "chambre", "terrasse"],
  params: { forme: pick("buisson", "palmier", "cactus"), taille: len(0.8, 0.2, 2.2, 0.1), pot: col("#b5651d"), feuillage: col("#2e7d32") },
  vars: { p: "= min(0.45, taille * 0.3)" },
  parts: [
    { name: "pot", cylinder: ["= p * 0.42", "= p", "= p * 0.55"], at: [0, "= p / 2", 0], color: "= pot" },
    { name: "terre", cylinder: ["= p * 0.5", 0.01], at: [0, "= p - 0.01", 0], color: "#4a3324" },
    { name: "touffe", if: "= forme == 'buisson'", sphere: ["= taille * 0.3", "= (taille - p) * 0.55", "= taille * 0.3"], at: [0, "= p + (taille - p) * 0.5", 0], color: "= feuillage", tex: "camouflage" },
    { name: "touffe2", if: "= forme == 'buisson'", sphere: "= taille * 0.2", at: ["= taille * 0.14", "= p + (taille - p) * 0.32", "= taille * 0.08"], color: "= feuillage" },
    { name: "tronc", if: "= forme == 'palmier'", cylinder: ["= taille * 0.035", "= (taille - p) * 0.7", "= taille * 0.025"], at: [0, "= p + (taille - p) * 0.35", 0], color: "#7a5a3a" },
    { name: "palme", if: "= forme == 'palmier'", sphere: ["= taille * 0.06", "= taille * 0.015", "= taille * 0.3"], at: [0, "= p + (taille - p) * 0.72", 0], off: [0, 0, "= taille * 0.26"], rot: [-28, 0, 0], repeat: { n: 6, rot: [0, 60, 0] }, color: "= feuillage" },
    { name: "fut", if: "= forme == 'cactus'", capsule: ["= taille * 0.1", "= (taille - p) * 0.75"], at: [0, "= p + (taille - p) * 0.48", 0], color: "= feuillage", tex: "rayures" },
    { name: "bras", if: "= forme == 'cactus'", capsule: ["= taille * 0.06", "= (taille - p) * 0.3"], at: ["= taille * 0.17", "= p + (taille - p) * 0.55", 0], color: "= feuillage", tex: "rayures" },
  ],
};

const bac: Obj = {
  famille: "jardin",
  pose: "sol",
  tags: ["jardin", "terrasse", "potager"],
  params: { largeur: len(1.2, 0.4, 3, 0.1), profondeur: len(0.4, 0.3, 1.5, 0.1), hauteur: len(0.4, 0.2, 0.9, 0.1), structure: mat("pin") },
  parts: [
    { name: "long", box: ["= largeur", "= hauteur", 0.03], at: [0, "= hauteur / 2", "= profondeur / 2 - 0.015"], matiere: "= structure" },
    { name: "longAr", box: ["= largeur", "= hauteur", 0.03], at: [0, "= hauteur / 2", "= 0.015 - profondeur / 2"], matiere: "= structure" },
    { name: "cote", box: [0.03, "= hauteur", "= profondeur - 0.06"], at: ["= largeur / 2 - 0.015", "= hauteur / 2", 0], mirror: "x", matiere: "= structure" },
    { name: "terre", box: ["= largeur - 0.06", 0.04, "= profondeur - 0.06"], at: [0, "= hauteur - 0.06", 0], color: "#4a3324", tex: "bruit", surface: "top" },
  ],
};

const potager: Obj = {
  famille: "jardin",
  pose: "sol",
  tags: ["jardin", "potager"],
  params: { largeur: len(1.2, 0.6, 3, 0.1), longueur: len(1.2, 0.6, 4, 0.1), rangs: pick(4, 2, 3, 5, 6), structure: mat("pin"), pousse: col("#4c9a2a") },
  parts: [
    { name: "long", box: ["= largeur", 0.2, 0.03], at: [0, 0.1, "= longueur / 2 - 0.015"], matiere: "= structure" },
    { name: "longAr", box: ["= largeur", 0.2, 0.03], at: [0, 0.1, "= 0.015 - longueur / 2"], matiere: "= structure" },
    { name: "cote", box: [0.03, 0.2, "= longueur - 0.06"], at: ["= largeur / 2 - 0.015", 0.1, 0], mirror: "x", matiere: "= structure" },
    { name: "terre", box: ["= largeur - 0.06", 0.04, "= longueur - 0.06"], at: [0, 0.16, 0], color: "#4a3324", tex: "bruit" },
    { name: "rang", sphere: ["= largeur / 2 - 0.12", 0.09, 0.06], at: [0, 0.22, "= (longueur - 0.2) / rangs / 2 + 0.1 - longueur / 2"], repeat: { n: "= rangs", at: [0, 0, "= (longueur - 0.2) / rangs"] }, color: "= pousse", tex: "camouflage" },
  ],
};

const cabane: Obj = {
  famille: "jardin",
  pose: "sol",
  tags: ["jardin", "abri"],
  params: { largeur: len(2.4, 1.5, 5, 0.1), profondeur: len(2, 1.5, 4, 0.1), hauteur: len(2, 1.8, 2.6, 0.1), structure: mat("pin"), toit: col("#4b5563"), porte: col("#3f6b52") },
  parts: [
    { name: "murs", box: ["= largeur", "= hauteur", "= profondeur"], at: [0, "= hauteur / 2", "= profondeur / 2"], matiere: "= structure", tex: { kind: "rayures", scale: 5, angle: 90, contrast: 0.25 } },
    { name: "toit", extrude: { pts: [["= -largeur / 2 - 0.15", 0], ["= largeur / 2 + 0.15", 0], [0, 0.65]], depth: "= profondeur + 0.3" }, at: [0, "= hauteur", "= profondeur / 2"], color: "= toit" },
    { name: "porte", box: [0.8, 1.85, 0.03], at: [0, 0.93, "= profondeur + 0.01"], color: "= porte" },
    { name: "poignee", sphere: 0.03, at: [0.3, 0.95, "= profondeur + 0.04"], matiere: "laiton" },
  ],
};

const barbecue: Obj = {
  famille: "jardin",
  pose: "sol",
  tags: ["jardin", "terrasse"],
  params: { teinte: col("#1f2937") },
  parts: [
    { name: "cuve", sphere: [0.28, 0.16, 0.28], at: [0, 0.72, 0], color: "= teinte" },
    { name: "grille", cylinder: [0.27, 0.012], at: [0, 0.8, 0], matiere: "acier", tex: "hachures" },
    { name: "pied", cylinder: [0.012, 0.7], at: [0.2, 0.36, 0.12], rot: [8, 0, -8], mirror: "x", matiere: "acier" },
    { name: "piedAr", cylinder: [0.012, 0.7], at: [0, 0.36, -0.22], rot: [-10, 0, 0], matiere: "acier" },
  ],
};

const borne: Obj = {
  famille: "luminaire",
  pose: "sol",
  tags: ["jardin", "allee"],
  params: { hauteur: len(0.6, 0.3, 1.2, 0.1), teinte: col("#fff1c9"), structure: mat("metal-noir"), allume: yes(true) },
  parts: [
    { name: "fut", cylinder: [0.035, "= hauteur - 0.1"], at: [0, "= (hauteur - 0.1) / 2", 0], matiere: "= structure" },
    { name: "lanterne", cylinder: [0.05, 0.1], at: [0, "= hauteur - 0.05", 0], color: "= teinte", glow: GLOW },
    { name: "chapeau", cylinder: [0.065, 0.012], at: [0, "= hauteur + 0.006", 0], matiere: "= structure" },
  ],
};

/** Catalogue : nom du modèle → prefab. */
export const CATALOGUE: Record<string, Obj> = Object.fromEntries(
  Object.entries({ lit, bureau, table, etagere, armoire, commode, tapis, coussin, rideau, lampadaire, lampe, suspension, applique, cadre, poster, plante, bac, potager, cabane, barbecue, borne }).map(([k, v]) => [k, { unite: "m", ...v }]),
);
