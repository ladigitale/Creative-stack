# WebGPU

`sonic-webgpu` — **GPU compute / effects** (companion to [`sonic-shader`](#core/components/functional/shader/shader.md/shader), not a clone).

| | `sonic-shader` | `sonic-webgpu` |
|--|--|--|
| Role | ShaderToy GLSL, multipass image | **Compute** + useful kernels |
| Demo | multipass / extract | **particles** (`kernel="particles"`) |
| Glue | DP + MediaRef | **same glue** |

Opt-in import:

<sonic-code language="javascript">
  <template>
import "@supersoniks/creative-stack/webgpu";
  </template>
</sonic-code>

Harris → patches → WebGPU mosaic: [Visual stack](#docs/_misc/visual-stack.md/visual-stack).

## Demo — particles (compute)

Simulation: `param0` = speed, `param1` = mouse attraction. WebGPU compute when available, otherwise CPU.

<docs-lit-demo for="docs-webgpu-demo"></docs-lit-demo>

## Kernels

| `kernel` | Role |
|----------|------|
| `particles` | particle compute (storage buffer) — **useful demo case** |
| `image` / empty | fullscreen WGSL pass + `channel0…3` (shader-like; WebGL2 fallback) |

## Attributes

| Attribute | Role |
|-----------|------|
| `kernel` | `particles` \| `image` |
| `shader` | WGSL `mainImage` (image kernel, WebGPU) |
| `backend` | `auto` \| `webgpu` \| `webgl2` |
| `active-backend` | reflect |
| `param0`…`param3` | floats (particles: speed / attraction) |
| `targetX` / `targetY` | attractor 0–1 (DP, top-left origin) |
| `channel0`…`channel3` | textures (image kernel) : URL, `#id` live (`SonicFrameSource`), ou MediaRef `{ element }` |
| `dataProvider` | params / channels / `targetX`·`Y` |
| `frame-out` | `frameUrl` + `snapshot` |
| `play` / `mouse` | loop / pointer |
| `dpr-max` | plafond du devicePixelRatio (défaut 2) |
| `params` | DP de réglages en direct (voir ci-dessous) |
| `out-data-provider` | DP de sortie (défaut : `dataProvider`) |

## État et pilotage par DataProvider

**État publié** dans le DP de sortie (`out-data-provider`, sinon `dataProvider`), à chaque changement, fusionné avec le reste du DP, et recopié dans les publications par frame (`time`, `frame`…, `frameUrl`) ; aussi en event `webgpu-state` :

| Clé | Rôle |
|-----|------|
| `status` | `idle` · `compiling` (démarrage du backend, compilation WGSL) · `ready` · `error` |
| `error` | Message lisible : `WGSL : ligne 3:10 : unresolved identifier 'foo'`, ou l'échec du démarrage (`webgl2:… → webgpu:… → canvas2d:…`) ; `null` sinon |
| `errors[]` | `{ line, column, message }` : un message par erreur du compilateur WGSL ; `line` est la ligne **du corps `shader` fourni** (prélude décompté), `null` si inconnue |
| `activeBackend` | `webgpu` \| `webgl2` \| `canvas2d`, `null` tant qu'aucun n'a démarré |
| `backendLog` | Essais de démarrage (`webgl2:ok`, `webgpu:no-navigator.gpu`…) |
| `notice` | Bandeau affiché (« WebGL2 — WGSL ignoré »…), sinon `null` |
| `playing` | La boucle d'animation tourne |

Clés nommées pour ne pas recouper les entrées : `activeBackend` (pas `backend`), si bien qu'un même DP peut servir d'entrée `params` et de sortie sans boucle.

**Réglages en direct** : `params="<DP>"`, prioritaires sur les attributs (clé absente ou invalide : l'attribut reprend la main ; l'attribut n'est pas réécrit) :

| Clé | Valeurs | Effet |
|-----|---------|-------|
| `play`, `mouse` | booléen (`true/false`, `1/0`, `"true"/"false"`) | immédiat |
| `dprMax` | 0.25..4 | redimensionne |
| `backend` | `auto` \| `webgpu` \| `webgl2` | **redémarre** le rendu (comme l'attribut) ; demandé pendant un démarrage, il est appliqué à la fin |
| `shader` | corps WGSL (200 000 caractères au plus) ; vide = l'attribut reste en vigueur | **recompile** ; une rafale est regroupée sur ~150 ms. En `auto`, le choix WebGPU / WebGL2 se fait au démarrage : un WGSL reçu après un démarrage en WebGL2 reste ignoré (changer `backend` pour redémarrer) |

`kernel` n'est pas pilotable par DP (il change la nature du composant). Le `dataProvider` historique (`param0…3`, `channel0…3`, `targetX/Y`) fonctionne comme avant.

```json
{ "tagName": "sonic-webgpu", "attributes": {
    "kernel": "image", "params": "gpuReglages", "out-data-provider": "gpuEtat",
    "shader": "fn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f { _ = fragCoord; return vec4f(uv, 0.5, 1.0); }",
    "style": "height:240px" } }
{ "tagName": "div", "attributes": { "formDataProvider": "gpuReglages" }, "nodes": [
  { "tagName": "sonic-select", "attributes": { "name": "play", "options": [ { "value": "true", "wording": "Animer" }, { "value": "false", "wording": "Pause" } ] } },
  { "tagName": "sonic-select", "attributes": { "name": "backend", "options": [ { "value": "auto", "wording": "auto" }, { "value": "webgpu", "wording": "WebGPU" }, { "value": "webgl2", "wording": "WebGL2" } ] } }
] }
{ "tagName": "p", "nodes": [ { "tagName": "sonic-value", "attributes": { "dataProvider": "gpuEtat", "key": "status" } }, " · ", { "tagName": "sonic-value", "attributes": { "dataProvider": "gpuEtat", "key": "activeBackend" } } ] }
{ "tagName": "pre", "nodes": [ { "tagName": "sonic-value", "attributes": { "dataProvider": "gpuEtat", "key": "error" } } ] }
```

Events : `error` (`detail.message`, `detail.infoLog`, `detail.errors`, ou `detail.log` au démarrage), `backend` (`detail.backend`, `prefer`, `kernel`, `log`), `webgpu-state`, `out`.

## Live bridge (`#id`)

Comme `sonic-shader` : `channel0="#plateau"` copie le canvas source chaque `frameSeq` (`copyExternalImageToTexture`). La texture GPU est **réutilisée** tant que la taille ne change pas (pas de `createTexture` / rebuild bind group chaque frame).

```html
<sonic-3d id="plateau" play …></sonic-3d>
<sonic-webgpu channel0="#plateau" kernel="image" play shader="…"></sonic-webgpu>
```

Demo: [Visual stack — 3D → WebGPU live](#docs/_misc/visual-stack.md/visual-stack).

## Markup particles

<sonic-code language="html">
  <template>
&lt;sonic-webgpu
  play
  mouse
  kernel="particles"
  dataProvider="fx"
&gt;&lt;/sonic-webgpu&gt;
  </template>
</sonic-code>

## Chaining

Same MediaRef / DP bridge as the rest of the stack. Live textures entre composants : pont `#id` / `{ element }` (copie canvas), pas de contexte WebGPU partagé avec `sonic-shader`.

## CDN

[`creative-stack-webgpu.bundle.js`](#docs/_getting-started/cdn-addons.md/cdn-addons) after the core.

## Notes

- Off viewport: **pause RAF** (no systematic destroy — that caused black frames + frozen particles on scroll).
- Device destroy = disconnect / `kernel`|`backend` change.
- Console: `[sonic-webgpu] backend: … kernel: …`
- `backend="auto"` + WGSL `shader`: tries **WebGPU first** (otherwise the WebGL2 fallback ignores WGSL). Without `shader`, WebGL2 stays preferred.
