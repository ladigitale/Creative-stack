# Assets d'exemple pour Abysse

- `clown-ref.png` : image de référence (clown émotif), rendue par `clown_ref.py` (champ de hauteur, éclairage, fard), à peindre par `sonic-painterly` (entrée `image` de l'outil Abysse).
- `paix-ref.png` : image de référence « la paix contre l'armement » (colombe à contre-jour, fusil brisé d'où repousse un olivier, coquelicots), rendue par `paix_ref.py`.
- `abysse-v84.ops.json` : patch JSON (RFC 6902) de la v83 à la v84 d'Abysse (entrée `image` peinte par `sonic-painterly`, entrée `gestesFichier`).
- `abysse-v85.ops.json` : patch v84 → v85 (si le dessin est trop riche pour l'export SVG, l'envoi se termine avec le PNG seul).
- `gentillesse-ref.png` : image de référence « la gentillesse » (une main tend une tasse fumante à une autre, lumière de fenêtre, intérieur flou), rendue par `gentillesse_ref.py`.
- `abysse-v86.ops.json` : patch v85 → v86 (entrées `style` — realiste, illustration, huile — et `traits`, nombre maximal de coups de pinceau).
- `mouton-ref.png` : image de référence « un mouton » (brebis laineuse dans un pré, lumière rasante du soir), rendue par `mouton_ref.py`.
- `mouton-gestes.json` : la même image peinte par `sonic-painterly` en style réaliste (5 000 touches), à rejouer par `gestesFichier`.
