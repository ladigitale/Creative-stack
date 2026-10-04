# @supersoniks/creative-stack

Addons créatifs et interactifs pour [Concorde](https://concorde.supersoniks.org) 5+, et catalogue SDUI consommé par l'app Artefacts (`artifacts.tadaaa.space`).

Concorde reste le design system (composants UI, DataProviders, `sonic-sdui`, `sonic-jsonata`, `sonic-mix`…). Tout ce qui est rendu lourd, interactif ou expérimental vit ici.

## Addons

| id | composants | dépendances |
|---|---|---|
| `3d` | `sonic-3d` | `three` |
| `shader` | `sonic-shader` | — |
| `webgpu` | `sonic-webgpu` | — |
| `hugging-face-infer` | `sonic-hugging-face-infer` | `@huggingface/transformers` |
| `interactive` | `sonic-store`, `sonic-keyboard`, `sonic-gamepad`, `sonic-gesture`, `sonic-action`, `sonic-ticker`, `sonic-matrix` | — |

Code porté depuis `@supersoniks/concorde@4.9.98-visual-stack.4`.

## Utilisation

En module (Vite, etc.) :

```ts
import "@supersoniks/creative-stack/interactive";
import "@supersoniks/creative-stack/shader";
```

En CDN, après le bundle Concorde core :

```html
<script src="concorde-core.bundle.js"></script>
<script src="creative-stack-interactive.bundle.js"></script>
```

## Structure

```
src/addons/<id>/
  index.ts        point d'entrée (enregistre les custom elements, exporte l'API)
  manifest.json   ce que l'agent voit : composants, props, dépendances, statut
  *.md            doc de l'addon
  *.spec.ts       tests
src/shared/       utilitaires communs (mediaRef, similarity)
schemas/          JSON Schema du manifeste
scripts/          build-addons, build-catalog, hf-vendor
```

## Ajouter un addon

1. Créer `src/addons/<id>/` avec `index.ts` et `manifest.json` (voir `schemas/addon-manifest.schema.json`).
2. N'importer de Concorde que son API publique (`@supersoniks/concorde/...`). Si un addon a besoin d'un interne, c'est qu'il manque un point d'extension côté Concorde.
3. `yarn catalog` vérifie le manifeste (id = dossier, composants réellement définis, noms uniques).
4. `enabledByDefault: false` pour garder un addon expérimental hors du catalogue de l'agent.

## Scripts

- `yarn build` : catalogue + un bundle ES et IIFE par addon dans `dist/`
- `yarn catalog` : génère `dist/catalog.json`. `CREATIVE_STACK_ADDONS=3d,interactive yarn catalog` force une sélection.
- `yarn test` / `yarn test:ci`
- `yarn typecheck`

L'installation ignore les scripts postinstall (`.yarnrc`) : `onnxruntime-node`, tiré par `@huggingface/transformers`, n'est pas utile côté navigateur.

## À faire

- Externaliser Concorde et Lit dans les bundles IIFE (aujourd'hui chaque bundle embarque sa copie ; les DataProviders restent partagés via le singleton `window`).
- Brancher l'app Artefacts sur `dist/catalog.json`.
- Addon `physics` (pilote : moteur 2D, événements discrets vers le store).
