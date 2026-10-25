# engine/procgen-engine.js

Build ESM minifié (≈ 720 Ko, worker de composition inclus en chaîne, lancé via `Blob` + `worker-src blob:`) du moteur
procgen v2 : graphe de nœuds (32 types), rendu GPU 2D SDF WebGL2, animation GPU, bibliothèque de 115 defs et 28 scènes.
Fichier généré : ne pas l'éditer à la main. Les sources du moteur ne sont pas dans ce dépôt ;
régénération : `node gl/build-esm.mjs <sortie>` depuis les sources procgen.
