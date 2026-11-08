# procgen v3 — cahier des charges

Statut : **v3.0 livrée** dans ce dossier (état détaillé §13). Remplace le moteur v2 (bundle compilé `engine/procgen-engine.js`, supprimé). Pas de compatibilité ascendante : migration décrite §10.

---

## 0. Audit de l'existant (v2)

| Constat | Conséquence |
|---|---|
| Le moteur est un **bundle minifié de 734 Ko** ; ses sources ne sont pas dans le dépôt (`ENGINE.md` renvoie à des sources externes) | Impossible à relire, corriger, tester ou faire évoluer. Aucune revue de code possible. |
| Recettes écrites en arbres d'opérateurs (`{mul:["$height",.11,{add:[1.5,{mul:["$age",-.5]}]}]}`), répétés des dizaines de fois par pièce | Illisibles pour un humain comme pour un agent ; une proportion se modifie à 30 endroits. |
| Rendu **2D seulement** (SDF WebGL2) avec vues `side` / `front` codées en dur ; « isométrique » et « oblique » sont des scènes dessinées à part | Un même objet ne peut pas être vu sous deux angles ; pas de 3D possible ; la profondeur est simulée scène par scène. |
| Personnage (`rig`) = **segments indépendants** (cuisse, tibia, bras, avant-bras) dessinés chacun en forme pleine, angles en `sin/cos` locaux | **Jointures visibles** : coudes et genoux cassés, épaules et hanches qui se détachent dès que l'angle dépasse ~30°, vêtements qui ne suivent pas les membres (sacoche, cape en polygones fixes). |
| Ancrages (`headTop`, `handL`…) calculés en dur, pas de notion d'os ni d'échelle de pièce | Un chapeau sur une tête plus grosse ou un objet tenu en pose « courir » se décalent. |
| Animations = expressions `sin(phase)` par angle, une table de poses (`walk`, `run`, `sit`…) | Pas de pieds plantés (glissement), pas d'IK, pas de mélange de poses, pas de pilotage par un jeu. |
| Couleurs par **rôles de palette** (bonne idée) mais la peau dérive du thème | Peau bleutée en thème froid ; impossible de choisir une carnation. |
| Côté Creative-stack, le reste a progressé seul : `sonic-skeleton` (os 2D), `skin.ts` (maillage skinné 2D), `sonic-ragdoll`, `sonic-puppet`, `sonic-3d` (three.js) | Le procgen n'en profite pas : deux systèmes d'os, deux conventions d'angles. |

Ce qui est **gardé** comme idées : pilotage intégral par DataProvider (aucun JS dans l'artefact), sélection publiée vers un store, jetons de style, rôles de couleur, slots, notes de compatibilité adressées à l'agent, rendu à la demande et gouverneur de cadence.

---

## 1. Principes

1. **3D d'abord, la 2D est une manière de regarder.** Chaque générateur produit un objet 3D sémantique (pièces, matériaux par rôle, ancres, squelette éventuel). Profil de plateforme, isométrique, oblique, vue de dessus, perspective libre : ce sont des caméras et des styles de rendu sur le **même** modèle. Un panneau, un blason, un motif sont des reliefs plats : de face en orthographique ils sont parfaitement 2D, et ils peuvent aussi être posés sur un mur 3D.
2. **Sources lisibles, rien de compilé.** Tout est en TypeScript dans `src/addons/procgen/`, testé sans DOM. Le seul code GPU est le shader de style, en clair.
3. **Recettes en données, expressions courtes.** Une recette est du JSON ; un nombre peut être une expression texte (`"= height * 0.11"`) évaluée par un analyseur maison (pas d'`eval`, pas de `new Function`) : arithmétique, paramètres, `rand(a,b)`, `pick(...)`, `mix`, `clamp`, `noise`.
4. **Déterminisme stable.** Graine hiérarchique : chaque sous-élément tire son aléa d'une clé (`seed/batiment.3/fenetre.12`). Changer un paramètre ne rebat pas les cartes du reste de la scène.
5. **Paramètres typés et bornés.** Chaque générateur publie un schéma (type, défaut, bornes, unité, description). Toute valeur hors bornes est ramenée et signalée dans `status.issues` : l'agent apprend sans casser le rendu.
6. **Un seul squelette pour tout le dépôt.** Les os procgen sont 3D, exportés au format `nodes` partagé (`x`, `y`, `z`, `rx`, `ry`, `rz`) : `sonic-ragdoll`, `sonic-timeline`, un store de jeu ou un pair p2p peuvent les piloter.
7. **Granularité.** Tout est éditable au niveau voulu : la scène (graine, style), un objet (sélection → `params`), une pièce (`parts.<nom>`), une couleur (rôle), un os (`pose`). L'agent ne réécrit jamais une scène entière pour changer une manche.
8. **Budget de fluidité non négociable** (§8) ; mesuré dans les tests.

---

## 2. Architecture

```
procgen/
  core/      rng (graine hiérarchique), expr (expressions sûres), schema (paramètres typés), issues
  geom/      Mesh (positions, normales, couleurs par rôle, AO), primitives, balayages, tour (lathe),
             extrusion de profil, surface implicite (SDF + surface nets), fusion, bruit
  rig/       Skeleton 3D, poids automatiques lissés, poses, cycles de marche/course, IK deux os, regard
  gen/       générateurs : character, tree, bush, rock, building, terrain, road, prop.*, emblem
  scene/     composition : sol, routes, placements (grille, Poisson, le long d'une courbe, grappe),
             acteurs, ancrage au sol, bibliothèque de scènes
  style/     jetons de style, palettes et rôles, préréglages
  render/    three.js : matériaux de style (toon / encre / plat / doux / pixel), contours, caméras,
             instanciation, skinning par quaternions duaux, sélection, gouverneur
  procgen.ts élément `sonic-procgen` (DataProvider)
```

Flux : `recette + graine + params + style` → **compose** (CPU, pur, testable) → `SceneModel` (maillages fusionnés par matériau, instances, squelettes, ancres, métadonnées de sélection) → **render** (three.js) → image. Les animations n'appellent jamais la composition : elles ne touchent que les os, les transformations d'instances et les uniformes.

---

## 3. Géométrie

- `Mesh` indexé, attributs : position, normale, **rôle de couleur** (entier, résolu par le style au rendu : changer de palette ne recompose rien), **occlusion ambiante** par sommet (calculée à la génération : le relief se lit même en rendu plat), indices d'os et poids (4 influences).
- Primitives : boîte arrondie, capsule, ellipsoïde, cylindre, cône, tore, plan, icosphère.
- Constructeurs : **tour** (profil tourné : tonneau, lampadaire, vase, tronc), **extrusion** (profil 2D + biseau : panneaux, blasons, lettres), **tube balayé** le long d'une courbe à rayon variable avec repères de transport parallèle (branches, câbles, queues, cornes).
- **Surface implicite** : champ signé (capsules, ellipsoïdes, boîtes) combiné par union douce, polygonisé par *surface nets* sur grille adaptée à la taille. Sert aux corps organiques (personnages, animaux), aux canopées et aux rochers.
- Déplacement par bruit (fBm, crêtes), facettage optionnel (style low-poly), fusion de maillages par matériau.

## 4. Personnages et créatures — la fin des jointures

**Une seule peau continue par personnage.** Le corps n'est plus un assemblage de pièces : c'est une surface implicite construite **sur le squelette** (une capsule à rayons d'extrémité par os, union douce aux articulations), polygonisée une fois en pose de repos, puis **skinnée**.

| Problème v2 | Réponse v3 |
|---|---|
| Coude / genou cassé, trou à l'épaule | La peau est d'un seul tenant ; l'union douce donne un vrai volume d'articulation (deltoïde, rotule). |
| Bras qui « s'aplatit » quand il se plie (skinning linéaire) | **Skinning par quaternions duaux** dans le shader : le volume est conservé, pas d'effet « papier de bonbon » au poignet. |
| Poids raides ou qui tirent le flanc | Poids calculés par distance à la **surface** de chaque os (comme `skin.ts`), limités aux os voisins dans la hiérarchie, puis **lissés sur le maillage** (diffusion de Laplace, quelques passes) et normalisés à 4 influences. |
| Vêtements qui ne suivent pas | Un vêtement est une **coque décalée** de la peau (champ − épaisseur) restreinte à une région (torse, bras, jambes, jupe) : il hérite des poids du corps au point le plus proche, donc il plie exactement avec lui, sans interpénétration. |
| Chapeau / objet décalé | Les accessoires rigides se fixent à des **ancres d'os** (`head.top`, `hand.l.grip`, `back`, `hip.l`…) dont la position et l'échelle dérivent des rayons réels de l'os. |
| Animation qui glisse | Cycles de marche/course paramétriques (foulée, cadence, rebond, balancier, humeur) + **IK deux os** pour poser les pieds au sol et les mains sur une cible. |

Paramètres du générateur `character` (extraits) : `height` (m), `age` (enfant → âgé : proportions tête/membres), `build` (fin → massif), `shape` (répartition épaules/hanches), `headSize`, `skin` (carnation indépendante du thème : 10 teintes + libre), `hair` (style, couleur), `face` (yeux, sourcils, bouche, humeur), `outfit` (haut, bas, robe/manteau, chaussures : coupe + rôle de couleur), `accessories` (chapeau, sac, cape, objet tenu), `species` (`human`, puis `quadruped`, `bird` en phase 2 sur le même système).

Tests de jonction automatiques : pour chaque articulation, plier de 0 à l'amplitude max et vérifier (a) aucune discontinuité (la peau est un seul maillage : vérifié par construction), (b) volume local conservé à ± 15 %, (c) aucun sommet du vêtement à l'intérieur de la peau.

## 5. Autres générateurs v3.0

| Générateur | Méthode | Paramètres clés |
|---|---|---|
| `tree` | Ramification récursive (tropisme, gravité, phyllotaxie), branches en tubes balayés soudés au départ ; feuillage en grappes implicites (lisible en toon) ou en cartes | espèce (feuillu, conifère, palmier, mort, saule), hauteur, densité, saison |
| `bush`, `grass` | Grappes implicites / touffes instanciées | taille, densité, floraison |
| `rock` | Icosphère déplacée (fBm + crêtes), aplatissement, facettage | taille, rugosité, strates |
| `building` | **Grammaire de découpe** : volume → étages → travées → fenêtres / portes / balcons ; toits (deux pans, croupe, plat, mansarde) | étages, travées, style (bourg, vapeur, néon, moderne), délabrement |
| `terrain` | Champ de hauteur fBm, plateaux, berges ; eau | taille, relief, niveau d'eau |
| `road` | Courbe (points) → chaussée aplanie dans le terrain, trottoirs, bordures, marquage | largeur, trottoirs, revêtement |
| `prop.*` | lampadaire, banc, caisse, tonneau, clôture (le long d'une courbe), panneau (texte), lanterne, rocher-borne, feu de camp | selon l'objet |
| `emblem` | Extrusion de profils (écu, rond, bannière) + charges géométriques ; texte en texture | forme, partitions, charges |

## 6. Composition de scène

Recette de scène = liste de **couches** : `ground` (terrain), `paths` (routes), puis `place` (générateur + paramètres + règle de placement : `grid`, `poisson`, `along` une route, `cluster`, `at` points explicites) avec ancrage au sol, écartement par emprise, orientation (vers la route, aléatoire, vers un point). Les `actors` sont des personnages pilotables (§7). Chaque objet placé reçoit un identifiant stable (`maisons.3`) : c'est lui qu'on sélectionne et qu'on édite.

Une recette de scène peut définir ses propres **paramètres** (exposés à l'agent) et les transmettre aux couches par expressions.

## 7. Pilotage, animation, jeu

- `anim` `{play, speed, time}` : horloge de la scène (vent dans les arbres, eau, foule).
- `actors.<id>` (écrit par un store de jeu) : `{x, z, facing, action, speed, look, target}` → le personnage marche jusque-là avec foulée adaptée, pieds plantés ; `action` : `idle`, `walk`, `run`, `wave`, `point`, `sit`, `carry`, `jump`, `cheer`, `talk`.
- `pose.<id>.<os>` : surcharge d'os (rotations en degrés) pour une pose sur mesure.
- Publication : `selection`, `status`, `anchors` (positions écran des ancres demandées : bulle de dialogue au-dessus d'une tête, en HTML par `sonic-stage`), `bones.<id>` au format `nodes` à la demande.

## 8. Rendu et styles

**Caméras** (`view.camera`) : `side` (profil orthographique), `front`, `iso` (orthographique 30°/45°), `oblique` (cavalière), `top`, `perspective` (orbite), `follow` (suit un acteur). Pan, zoom, rotation selon le mode ; `interactive="false"` les coupe.

**Styles** = jetons, combinables :

| Jeton | Effet |
|---|---|
| `palette` | `hue`, `saturation`, `contrast`, `harmony`, `mode` (clair/sombre) → rôles `ground`, `stone`, `wood`, `plant`, `leaf`, `water`, `metal`, `cloth1..3`, `accent`, `ink`, `light`, `sky` ; surcharge libre par rôle (`roles.wood = "#8a5a3b"`) |
| `shading` | `flat`, `toon` (`bands` 2–5), `soft`, `lit` (éclairage physique simple) |
| `outline` | épaisseur (px, constante à l'écran), couleur (rôle `ink` ou assombrissement du matériau) |
| `light` | direction (azimut, hauteur), couleur, ambiance, ombres portées (oui/non) |
| `atmosphere` | brouillard de profondeur teinté (perspective aérienne : c'est ce qui rend une scène 2D crédible), ciel en dégradé |
| `night`, `lamps` | nuit, émissifs des lampes et fenêtres |
| `grain`, `paper` | grain de film, texture papier en post-traitement |
| `pixel` | rendu basse définition + agrandissement net + quantification de palette |
| `ao` | intensité de l'occlusion ambiante des sommets |

Préréglages : `gouache`, `encre`, `bande-dessinée`, `pixel-art`, `nuit-vapeur`, `néon`, `brume`, `papier`, `low-poly`, `doux`.

**Fluidité** (budgets vérifiés) : composition d'une scène de 40 bâtiments, 300 objets, 30 personnages < 400 ms sur un portable courant ; < 120 appels de dessin (maillages statiques fusionnés par matériau, objets répétés en `InstancedMesh`) ; rendu à la demande (aucune image quand rien ne bouge) ; densité de pixels adaptative ; arrêt hors écran ; `prefers-reduced-motion` respecté. Deux scènes WebGL au plus par document.

## 9. Interface `sonic-procgen`

Attributs : `dataProvider`, `scene`, `seed`, `scene-style`, `camera`, `interactive`, `target`, `select-action-type`.

Clés **lues** : `scene` (nom de la bibliothèque) ou `recipe` (recette complète), `seed`, `params`, `style` (nom ou jetons), `view` `{camera, yaw, pitch, zoom, cx, cy, cz}`, `anim`, `actors`, `pose`, `select` (id d'objet), `edit` `{id, params}` (édition d'un objet sans réécrire la scène).
Clés **écrites** : `selection` `{id, generator, params, schema}`, `status` `{phase, items, triangles, drawCalls, ms, fps, issues, error}`, `view`.
Sélection envoyée au store `target` : `{type: "select", payload: {objectId, generator, params}}`.

Hors composant : `generators` (export TS) donne les schémas de paramètres pour l'outillage agent (catalogue, validateur).

## 10. Migration depuis v2

| v2 | v3 |
|---|---|
| `engine/procgen-engine.js` + `ENGINE.md` | supprimés |
| `ProcgenScene` (export) | `ProcgenView` (classe de rendu) et `composeScene` (pur) |
| `patch {root, canvas, defs, seed}` | `recipe` (nouveau format, §6) |
| `select` (pointeur JSON) | `select` (id d'objet) |
| `selection.params.*` / `selection.place.*` | `edit {id, params}` |
| scènes v2 (28) | bibliothèque v3 : `village`, `rue`, `port`, `forêt`, `bivouac`, `personnages`, `marché`, `montagne`, `ville-vapeur`, `ville-néon`, `blasons`, `signalétique` ; les autres sont à recréer au besoin |
| `view {zoom, cx, cy}` | `view {camera, yaw, pitch, zoom, cx, cy, cz}` |

Côté plateforme : règle `PROCGEN_RULE` du validateur Tadaaa et catalogue à régénérer ; artefacts existants qui utilisent `sonic-procgen` (dont `gardien-du-phare`) à migrer.

## 11. Décisions issues des revues (DA/rendu, TD personnages, game design)

Ces décisions **priment** sur les sections précédentes quand elles divergent.

**Rendu (DA + ingénierie rendu)**
- Un seul matériau maison (`ShaderMaterial` en clair) pour tout : couleur, profondeur d'ombre et passe normales/id partagent le même code de sommet (instances, vent, skinning DQ). Pas de matériau three.js à rapiécer, donc pas de variante oubliée.
- Rampe toon **2 ou 3 bandes**, seuil perturbé par du bruit (coup de pinceau) ; **ombre teintée vers le ciel**, lumière chaude (≈ 70°), ambiance froide (≈ 250°). Jamais `couleur × 0,6`.
- **Texture procédurale en shader** (bruit triplanaire monde, deux échelles, selon le rôle : veinage bois, taches pierre, macro-variation sol), ±5–10 % de valeur. Le style `flat` garde texture, AO et brouillard.
- **Ombres portées réelles** : une lumière directionnelle, caméra d'ombre ajustée à l'emprise, 1024 (mobile) / 2048, recalculée seulement quand la scène ou un acteur bouge.
- **AO par sommet** intra-maillage **et** entre objets (sol assombri au pied des murs, sous les bancs, autour des rochers, d'après les emprises) ; attribut de **courbure** (arêtes éclaircies, creux assombris).
- **Contours en post-traitement** (normales + profondeur + id d'objet, Sobel) : trait plus épais en silhouette qu'en plis internes, couleur = matériau assombri (pas de noir pur), MSAA ×4 sur la cible.
- Brouillard **profondeur + hauteur** teinté de l'horizon ; ciel en dégradé. Variation par instance (teinte, valeur, échelle ±3–6 %). Eau : profondeur cuite par sommet, écume de berge, Fresnel.
- Écartés pour la v3 : SSAO, profondeur de champ, réflexions, bloom hors `néon` / `nuit`, feuillage en cartes alpha.
- **Palettes en OKLCH** : structure de valeurs d'abord (ciel > façades > sol > `ink`, écart de luminosité ≥ 0,08), chroma basse sur les grandes surfaces, accent < 5 % de l'image, plages de teinte par rôle (feuille olive 95–140°, bois 30–60°) ; 10 palettes clés réglées à la main puis perturbées. La nuit est un décalage vers le bleu avec des lampes chaudes, pas un assombrissement.
- Budgets : ≈ 80 appels de dessin mobile / 150 ordinateur **passe d'ombre comprise** ; 300–500 k triangles mobile. Fusion par matériau **et par tuile spatiale** (le culling reste utile) ; uniformes plutôt que `defines` (pas de recompilation), compilation au chargement.
- Arbres : 3–4 niveaux de ramification, canopée en 3–7 masses implicites à **normales transférées d'un ellipsoïde englobant** ; 6–10 variantes par espèce, instanciées. Bâtiments : **retraits** (fenêtres en creux de 5–10 cm), soubassement, corniche, encadrements, toit débordant, cheminées, léger faux aplomb en `bourg`. Rochers : **découpe par plans** + biseau, groupes gros/petits **enfouis de 20–30 %**. Terrain : fBm à domaine déformé ; routes **creusées dans le champ de hauteur** ; mélange herbe / terre / usure selon pente et distance aux routes et murs ; touffes et débris aux raccords.

**Personnages (TD)**
- Voxels de corps 1,5–2 cm ; **mains (moufle + pouce, 4 poses : repos, poing, prise, pointer), yeux, sourcils, bouche** en gabarits paramétriques rattachés aux os ; **cache par archétype** (même empreinte de paramètres = même maillage).
- **A-pose** de repos (bras à 45°, coudes 15°, jambes écartées 8–10°, genoux 5°). Union douce **seulement entre os parent-enfant** ; os non voisins en `min` dur, écart garanti en pose de repos.
- **Segmentation gratuite** : l'os dominant de chaque sommet vient de la polygonisation ; les poids ne diffusent (sur la topologie du maillage, pas en distance euclidienne) qu'aux frontières : les jambes ne fuient plus l'une dans l'autre.
- Maillage relaxé par **lissage de Taubin** (pas Laplace, qui rétrécit), normales du gradient du champ.
- **DQS** dans le matériau unique ; correctifs d'articulation (échelle d'os d'aide) au coude et au genou ; os de torsion avant-bras en v3.1.
- Vêtements fusionnés au corps en **un seul maillage** ; triangles de peau couverts supprimés ; épaisseur ≥ 1,5 voxel ; jupe/manteau : poids bassin + cuisses lissés.
- Ancres = **repères complets** (position + orientation + échelle).
- Proportions par archétype comptées **en têtes** : `chibi` (2,5), `cartoon` (4,5), `stylized` (6), `heroic` (7) ; pas d'interpolation libre entre eux ; micro-variations par graine (asymétrie, posture, tics d'idle) ; carnations et cheveux en palettes contraintes ; **clignement** des yeux.
- Contraintes articulaires en **swing-twist** (table de la revue). IK : vecteur de pôle, **soft IK**, roulé du pied, abaissement du bassin si cible hors d'atteinte.
- Locomotion : vitesse = foulée × cadence normalisées par la longueur de jambe ; cycle sur **poses clés** (contact, bas, passage, haut) avec événements de contact et **pieds verrouillés** ; avance par **distance parcourue** (aucun glissement en profil) ; rebond, lacet et bascule du bassin, contre-rotation des épaules, coude plus fléchi avec la vitesse, inclinaison avec la vitesse, tête stabilisée ; humeur = décalages des poses clés.

**Jeu et agent (game design)**
- Le composant **lit** `dataProvider` et **écrit** dans `state-out` (défaut `<dataProvider>State`) : un store ne peut plus effacer `selection` / `status`.
- Événements vers `target` : `pick {objectId, layer, x, y, z, actor}` (position au sol comprise : point-and-click), `select`, `arrive {actor, x, z, target}`, `blocked {actor, reason}`, `enter` / `leave {zone, actor}`, `actionEnd {actor, action}` ; préfixe optionnel `action-prefix`.
- Acteurs : mode `goto` (destination ou id d'objet, chemin calculé sur une **grille de navigation** issue des emprises) et mode `drive` (`{vx, vz}` lissés, cadence d'une manette à 30 Hz). Le store écrit des **intentions**, jamais 60 Hz.
- `view.follow {actor, deadzone, lead, smooth}`, transitions `view.ease` (ms). `anchors: ["hero@head.top"]` → positions écran publiées dans `anchors-out` au format `nodes` de `sonic-stage`. `hidden: [ids]`.
- Recette : couches nommées à ids prévisibles (`maisons.3`), `zones`, `actors`, `nav`. Noms de scènes et de générateurs en **slugs ASCII** (`port`, `foret`), libellé à part.
- `issues` structurées : `{path, code, got, used, hint, didYouMean}` ; rendu partiel plutôt qu'écran noir ; `status.ids` liste les objets placés ; `edit {id | layer, params, rev}`.
- **Unités : mètres** côté procgen ; conversion explicite vers les pixels de `sonic-physics` (`world.scale`) pour l'export de collisions (v3.1).

## 12. Feuille de route

- **v3.0 (ce lot)** : noyau, géométrie, personnage humain skinné (quaternions duaux, IK, cycles), arbres, buissons, rochers, bâtiments, terrain, routes, objets, blasons, composition, styles et caméras, composant DP, tests et planches.
- **v3.1** : génération en worker ; cuisson en **planche de sprites** (`bake`) pour `sonic-2d` et en **GLB** pour `sonic-3d` ; expressions du visage animées ; os de ressort (cheveux, cape, queue).
- **v3.2** : quadrupèdes et oiseaux sur le même système ; pont `sonic-ragdoll` (chute physique d'un personnage) ; intérieurs (donjon, pièces) par grammaire de plans ; LOD.
- **v3.3** : éditeur de recettes guidé côté atelier Artefacts (sélection → schéma → contrôles).

## 13. État de la v3.0 (mesuré)

**Livré** : noyau (graine hiérarchique, expressions sûres, paramètres typés, problèmes structurés avec suggestion) ; géométrie (primitives, tour, tube balayé, extrusion biseautée, surface implicite par surface nets avec union douce par paires, cône tronqué, polyèdre taillé par plans, Taubin, AO de champ) ; squelette 3D 23 os en A-pose avec contraintes swing-twist ; poids segmentés + diffusion topologique à deux niveaux filtrée par côté ; **skinning par quaternions duaux** dans le shader ; locomotion (poses, foulée par distance, pieds verrouillés, IK deux os avec pôle et IK douce, rebond / lacet / bascule du bassin, contre-rotation, balancier, inclinaison, tête stabilisée, humeurs) ; 12 actions ; clignement par morph ; générateurs `character`, `tree` (8 espèces), `bush`, `grass`, `flowers`, `rock`, `building` (7 styles, 4 toits), `prop` (18 objets), `emblem` ; terrain (fBm déformé, montagnes, côte, eau, routes creusées, trottoirs, usure, socle de diorama) ; composition (8 placements, ids stables, éditions, zones, acteurs, lumières, grille de navigation A*) par tranches ; rendu (matériau unique, toon 2–4 bandes à seuil bruité, ombre teintée ciel, texture procédurale par rôle, ombres portées, AO intra et entre objets, contours post-traités silhouette/plis, brouillard profondeur + hauteur, eau à profondeur cuite, lumières ponctuelles, variation par objet, pixel, papier, grain) ; 7 caméras ; 17 préréglages, 11 palettes OKLCH ; composant `sonic-procgen` (lecture / `state-out` séparés, événements de jeu, intentions d'acteurs, ancres au format `nodes`) ; 12 scènes ; 38 tests dont jointures (aucune arête de plus de 10 cm et 99,9 % étirées de moins de ×3 avec coudes à 120°, genoux à 110°, bras levés ; volume du coude conservé à plus de 70 %), glissement des pieds (< 1,2 cm) et sécurité des expressions.

**Mesures** (portable, Chrome, rendu logiciel pour les captures) : village 233 objets / 6 personnages → 49 appels de dessin, 212 k triangles ; rue 18–23 appels ; composition 1,2 à 4 s selon la scène (par tranches : la page reste fluide).

**Écarts avec les décisions de revue, reportés en v3.1** :
- composition : budget de 400 ms non tenu (personnages ≈ 0,25 s chacun en « foule ») → génération en worker, **décimation quadrique** des personnages, cache persistant par archétype ;
- triangles : forêt et montagne dépassent le budget mobile (≈ 360–450 k) → LOD des arbres (masses simplifiées au loin), fusion par tuile des instances lointaines ;
- personnages : mains en moufle sans poses de main (repos/poing/prise/pointer), pas d'os de torsion d'avant-bras, pas d'os de ressort (cheveux, cape, jupe), attribut de courbure non calculé, bords de couleur en escalier sur les vêtements (rôle par triangle) ;
- jeu : caméra `follow` sans `deadzone` / `lead` / `ease`, pas d'export `colliders` vers `sonic-physics`, pas de `spawn` dynamique (seulement `hidden`) ;
- signalétique avec texte (texture de texte) et intérieurs (donjon) non recréés.

**Banc visuel** : `demo/procgen-shot.html?scene=…&style=…&camera=…&actors=…` (sans Concorde) ; captures sans écran par Chrome (`--use-angle=swiftshader`).

**Plateforme (PR séparées)** : régénérer le catalogue et la règle `PROCGEN_RULE` du validateur Tadaaa (nouvelles clés, `state-out`, événements) ; migrer les artefacts qui utilisent l'ancien `sonic-procgen` (dont `gardien-du-phare`).

## 14. Lot v3.1 « précision et variations » (livré)

Demande : plus de précision, plus de variations, et un vrai mode 2D vectoriel. Quatre chantiers menés en parallèle puis intégrés.

- **Vrai 2D vectoriel** (`vector/`) : composition sans maillage (`assetBuilder`), dessinateurs par générateur lisant les paramètres, personnages et animaux en traits continus à épaisseur variable sur le même squelette animé, `VectorView` (Canvas 2D, même interface que la vue 3D, mêmes événements), 5 styles (`ligne-claire`, `flat`, `gravure`, `affiche`, `papier-decoupe`), export SVG sûr. Bascule par `render: "vector"` ou style vectoriel.
- **Personnages** : un rôle de couleur par triangle (découpe à la frontière : bords nets), mains à 4 doigts et pouce avec prise, tête et visage en maillage fin (formes de tête, yeux, iris, sourcils, nez, lèvres, oreilles, barbes, moustaches, lunettes, taches de rousseur, rides), silhouettes variées (`figure`, `body`), garde-robe étendue (cols, ceintures, boutons, poches, tabliers, salopettes, robes, plastrons, gants, motifs), 16 coiffures, 16 couvre-chefs, `role` qui biaise des tirages cohérents ; génération plus rapide à tenue égale.
- **Environnement** : bâtiments réécrits (17 styles dont ferme, chalet, méditerranéen, japonais, château, tour, moulin, chapelle, phare, boutique ; volumes, ouvertures et matériaux variés), 15 espèces d'arbres, `plant` (11), `wall` (le long de points), `vehicle` (7), 26 objets de plus, pavés et dalles, 4 scènes de plus.
- **Animaux** : `animal` (13 espèces), squelettes quadrupède et oiseau, pas / trot / galop par distance parcourue, adaptateur `rig/motion.ts` commun aux vues 3D et vectorielle.
- **Rendu 3D** : relief de détail procédural par matériau, usure des arêtes, ombres Poisson 12 échantillons, carte d'ombre 4096 sur ordinateur.

**Écarts restants** : triangles en hausse (personnage foule ≈ 16 k, héros ≈ 38 k ; village ≈ 74 appels de dessin) → décimation et LOD toujours à faire ; doigts non animés (pas d'os de doigt) ; ardoise et zinc sans rangs dans le shader ; pas de rôle rose (cerisier) ; transitions d'allure des animaux avec un léger glissement.

## 15. Lot v3.2 « objets du quotidien » (livré)

Demande : il manque toutes sortes d'objets (ballons de toutes tailles, outils, sièges, bancs, carrioles…), pour des humains ou non. Réponse : une **grammaire** plutôt qu'un catalogue figé.

- **Grammaire de pièces** (`gen/parts.ts`) : planche `box` (rotation), barre `rod` (fuselée), tube courbe `tube`, tour `lathe`, coussin `blob`. Une liste de pièces donne **à la fois** le maillage 3D et le dessin vectoriel (`vector/draw/parts.ts`, peintre par pièce) : un nouvel objet n'a qu'un seul code.
- **`assembly`** : l'agent décrit un objet inédit en données (80 pièces au plus, nombres bornés, rôles connus, aucune évaluation), avec ses ancres et ses affordances.
- **`ball`** : 22 ballons, balles, boules et billes à taille réelle (diamètre surchargeable, écrasement au sol), motifs en **espace motif** sur la sphère unité (`gen/sphere-pattern.ts` : polygones sphériques convexes, fuseaux, calottes, bandes, coutures). 3D : icosphère découpée aux frontières (`splitByLabel`, bords nets), coutures en tubes en relief. Vectoriel : régions découpées par l'hémisphère visible — l'ellipsoïde étant une image affine de la sphère, l'hémisphère visible reste un demi-espace en espace motif et le bord suit exactement la silhouette —, ombre propre par la même découpe côté lumière. Physique publiée (masse, rebond, frottement).
- **`seat`** : 22 assises (tabouret, chaise, fauteuil, canapé, bancs, rondin, transat, trône, balançoire, panier de chien, perchoir…) par gabarit d'utilisateur (`adult`, `child`, `toddler`, `giant`, `pet`, `gnome`), matière, dossier, accoudoirs, places. Ancres `sit.N` / `approach.N`.
- **S'asseoir** : `actors.<id> = {target: "<objet>.sit.N", action: "sit"}` → marche jusqu'à `approach.N`, se pose sur `sit.N` face à l'avant ; `MotionState.seatY` pose le bassin à hauteur d'assise (pieds au sol devant). En vectoriel, un acteur assis est ordonné par ses genoux (devant ou derrière le dossier).
- **Couleurs franches** : rôles `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `white`, `black` (40 rôles ; tableau du shader dimensionné par `ROLES.length`).
- **Affordances** : `affords` et `physics` publiés dans `selection` et `ids`.
- Corrections au passage : un `yaw` explicite dans `place.at` est respecté (il était remplacé par un cap aléatoire hors bâtiments) ; en cavalière vectorielle, les objets loin à gauche ne sont plus coupés par la bande de sol de devant (clé d'ordre `Projector.key`, abscisse neutralisée).
- Scène `aire-de-jeux`.

**Suite** : outils à main (manche + tête + prise), contenants, mobilier urbain et objets pour animaux sur la même grammaire ; ballon dynamique (coup de pied, rebond) par `sonic-physics` ; numéros des boules de billard ; pieds sur le repose-pieds des tabourets hauts.

## 16. Lot v3.3 « outils à main » (livré)

- **`tool`** : 24 outils à taille réelle (marteau, maillet, masse, hache, pioche, pelle, bêche, râteau, balai à feuilles, binette, fourche, balai, balai de brindilles, serpillière, faux, scie, truelle, clé, tournevis, pinceau, rouleau, pied-de-biche, canne à pêche, machette) sur la grammaire de pièces ; poses `lying`, `leaning`, `upright` ; ancre `grip` ; `extra.use` donne l'action d'usage.
- **Tenus** : `character.item: "tool.<kind>"` — mêmes pièces, prise à l'origine, mise à l'échelle du personnage, en 3D (maillage lié à la main) comme en vectoriel (`drawPartsOn` dans le repère de la prise).
- **Actions** `hammer` (frapper), `sweep` (balayer, ratisser, peindre), `dig` (bêcher, piocher).
- Porté bras ballant, un grand outil est tenu à 58 cm au plus du bas du manche (tête au-dessus du sol, vérifié par skinning) ; repère de main partagé 3D / vectoriel (`heldToolBasis` : manche dans l’axe de la prise, tête vers l’avant ou en travers selon l’outil), le manche suit le geste.
- Grammaire : planches orientées par quaternion (`q`), `transformParts` (rotation, échelle, translation d'une liste de pièces), dessin sur une surface abstraite (`PartSurface`) réutilisable hors de la boîte à outils d'objet.
- Outils posés : instanciés, ne bloquent pas la navigation.

## 17. Lot v3.4 « contenants » (livré)

- **`container`** : 17 contenants (caisse, coffre, carton, panier, seau, sac de jute, jarre, amphore, marmite, jerrican, caisse à outils, valise, sac de courses, palette, poubelle à roulettes, bidon à lait, glacière) sur la grammaire de pièces ; couvercles ouverts sur leur charnière (`open`).
- **Contenu** (`fill`) posé dans l'ouverture ronde ou rectangulaire : fruits (placement déterministe), sable, terre, grain, foin, eau, lait, bûches, fleurs, pièces d'or, outils couchés à plat (mêmes pièces que `tool`).
- Ancres sur le corps fermé (ni couvercle levé ni contenu) : `top`, `grip` sur l'anse réelle, `inside` ; `sit.0`/`approach.0` sur caisse, coffre, glacière et sac fermés vides, palette vide.
- Couvercles articulés sur leur charnière (coffre, caisse à outils, poubelle, glacière), dessinés derrière le corps quand ils sont levés ; contenus permis par contenant (issue sinon), fruits et pièces sur une grille centrée, bûches à la corde, contenu en détail réduit ; petits contenants hors navigation.
