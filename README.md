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
| `sound` | `sonic-sound`, `sonic-sfx` | — |
| `audio` | `sonic-patch` + modules (`sonic-osc`, `sonic-filter`, `sonic-ladder`, `sonic-karplus`, `sonic-grain`, `sonic-env`…), `sonic-sequencer`, `sonic-sampler`, `sonic-audio-analyser`, `sonic-mic`, `sonic-midi`, `sonic-audio-recorder`, `sonic-audio-unlock`, `sonic-audio-master` | — |
| `media` | `sonic-camera`, `sonic-screen`, `sonic-video`, `sonic-media-start`, `sonic-media-recorder`, `sonic-media-download` | — |

`3d`, `shader`, `webgpu`, `hugging-face-infer` et `interactive` sont portés depuis `@supersoniks/concorde@4.9.98-visual-stack.4`. `sound` est nouveau : musiques, jingles, bruitages et sons d'interface synthétisés en WebAudio depuis une banque JSON de quelques Ko, pilotés par DataProvider (voir [`src/addons/sound/sound.md`](src/addons/sound/sound.md)).

## Utilisation

En module (Vite, etc.) :

```ts
import "@supersoniks/creative-stack/interactive";
import "@supersoniks/creative-stack/shader";
```

Deux bundles par addon dans `dist/` :

- `creative-stack-<id>.es.js` : Concorde, Lit, three… restent des imports. À utiliser derrière un bundler (une seule instance de Concorde).
- `creative-stack-<id>.bundle.js` : autonome, à charger après le bundle Concorde core.

```html
<script src="concorde-core.bundle.js"></script>
<script src="creative-stack-interactive.bundle.js"></script>
<script src="creative-stack-sound.bundle.js"></script>
```

Un bundle autonome embarque sa propre copie de Concorde ; une passerelle (`src/shared/iife-bridge.ts`) le branche au chargement sur les DataProviders de Concorde core (`window.SonicPublisherManager`) et ignore la redéfinition des composants déjà présents. `demo/cdn.html` vérifie ce mode.

## Structure

```
src/addons/<id>/
  index.ts        point d'entrée (enregistre les custom elements, exporte l'API)
  manifest.json   ce que l'agent voit : composants, props, dépendances, statut
  *.md            doc de l'addon
  *.spec.ts       tests
src/shared/       utilitaires communs (mediaRef, similarity) et socle audio (AudioEngine, contrats)
schemas/          JSON Schema du manifeste et de la banque son
demo/             pages de démo (yarn dev → Sound lab en SDUI)
scripts/          build-addons, build-catalog, hf-vendor
```

## Ajouter un addon

1. Créer `src/addons/<id>/` avec `index.ts` et `manifest.json` (voir `schemas/addon-manifest.schema.json`).
2. N'importer de Concorde que son API publique (`@supersoniks/concorde/...`). Si un addon a besoin d'un interne, c'est qu'il manque un point d'extension côté Concorde.
3. `yarn catalog` vérifie le manifeste (id = dossier, composants réellement définis, noms uniques).
4. `enabledByDefault: false` pour garder un addon expérimental hors du catalogue de l'agent.

## Scripts

- `yarn dev` : serveur Vite sur les démos (`demo/audio.html` « Premier son », `demo/vie-sonore.html`, `demo/miroir.html`, `demo/clip-reactif.html`, `demo/sampler-de-poche.html`, `demo/jam-midi.html`, `demo/nuage.html`, `demo/sound.html` « Sound lab »)
- `yarn build` : catalogue + un bundle ES et IIFE par addon dans `dist/`
- `yarn catalog` : génère `dist/catalog.json`. `CREATIVE_STACK_ADDONS=3d,interactive yarn catalog` force une sélection.
- `yarn test` / `yarn test:ci`
- `yarn typecheck`

L'installation ignore les scripts postinstall (`.yarnrc`) : `onnxruntime-node`, tiré par `@huggingface/transformers`, n'est pas utile côté navigateur.

Feuille de route complète : [`PLAN.md`](PLAN.md).

## À faire

- Côté Concorde : exposer l'API core en global (et relire `window.SonicPublisherManager` dans `getInstance`), pour que les bundles autonomes n'aient plus à embarquer Concorde ni la passerelle.
- Brancher l'app Artefacts sur `dist/catalog.json`.
- Addon `physics` (moteur 2D, événements discrets vers le store).
