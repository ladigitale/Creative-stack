# Hugging Face infer

`sonic-hugging-face-infer`: **1 input → Hugging Face model → 1 output** (readonly), computed **in the browser** with [Transformers.js](https://huggingface.co/docs/transformers.js). Data never leaves the device.

The name names the engine: other inference paths (server, browser AI, …) will get their own `sonic-<engine>-infer`, with the same attributes, states, and typed outputs.

- **Lightweight**: the component does not ship the engine. Transformers.js loads on first need, **in a worker**, from a **pinned version**.
- **Allowlist**: the `model` attribute is an alias declared by the app. An SDUI descriptor cannot load an arbitrary model.
- **End-to-end typed**: inputs, options, and outputs are derived from Transformers.js types.

## Examples

Each demo stays idle until you click **Try**. The model downloads only after consent.

### Image — `background-removal`

<docs-lit-demo for="docs-hf-cutout-demo"></docs-lit-demo>

### Text — `zero-shot-classification`

<docs-lit-demo for="docs-hf-suggest-demo"></docs-lit-demo>

Image + depth / shader chains: [Visual stack](#docs/_misc/visual-stack.md/visual-stack).

### Other tasks (markup)

Same component, different allowlist alias. Common patterns:

<sonic-code language="html">
  <template>
&lt;!-- Semantic search (embeddings) --&gt;
&lt;sonic-hugging-face-infer
  model="multilingual-mini"
  inputProvider="events"
  outputProvider="search.vectors"
  options='{"text":"label + edito.sub_title"}'
  load="idle"
  persistResults
&gt;&lt;/sonic-hugging-face-infer&gt;

&lt;!-- Translation FR → EN --&gt;
&lt;sonic-hugging-face-infer
  model="fr-en"
  inputProvider="event.edito.description"
  outputProvider="event.edito.descriptionEn"
  load="consent"
  trigger="demand"
  triggerProvider="translateClick"
&gt;&lt;/sonic-hugging-face-infer&gt;

&lt;!-- Dictation (Whisper) --&gt;
&lt;sonic-hugging-face-infer
  model="whisper-tiny"
  inputProvider="voice.clipUrl"
  outputProvider="voice.transcript"
  load="consent"
&gt;&lt;/sonic-hugging-face-infer&gt;
  </template>
</sonic-code>

## Installation

### CDN (script + bootstrap)

Load `creative-stack-hugging-face-infer.bundle.js` after the core, then call `ConcordeHF.configureHuggingFace(…)` once. Details: [CDN addons](#docs/_getting-started/cdn-addons.md/cdn-addons).

### 1. Pin and host the runtime

```bash
npm i -D --save-exact @huggingface/transformers@4.3.0
node node_modules/@supersoniks/creative-stack/scripts/hf-vendor.mjs runtime --out ./cdn/vendor/hf-transformers
# → ./cdn/vendor/hf-transformers/4.3.0/ transformers.min.js + ONNX Runtime binaries + manifest.json
```

The script checks that ONNX Runtime binaries are **exactly** those expected by Transformers.js. Serve the folder with `Cache-Control: public, max-age=31536000, immutable`: the path includes the version and never changes. To upgrade: new folder, regression tests, then change `version` / `url` in config. The previous version can stay served.

### 2. Host models (pinned revision)

```bash
node node_modules/@supersoniks/creative-stack/scripts/hf-vendor.mjs model Xenova/paraphrase-multilingual-MiniLM-L12-v2 <sha> --dtype q8 --out ./cdn/models
```

The script prints size (`sizeBytes`) and license for you to verify.

### 3. Configure (once, at startup)

```ts
import {
  configureHuggingFace,
  defineHuggingFaceModels,
} from "@supersoniks/creative-stack/hugging-face-infer";

export const hf = configureHuggingFace({
  runtime: {
    source: "cdn",
    version: "4.3.0",
    url: "https://cdn.example.org/vendor/hf-transformers/4.3.0/transformers.min.js",
  },
  remoteHost: "https://cdn.example.org/models/",
  remotePathTemplate: "{model}/{revision}/",
  models: defineHuggingFaceModels({
    "multilingual-mini": {
      task: "feature-extraction",
      repo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      revision: "<sha>",
      options: { dtype: "q8" },
      sizeBytes: 118_000_000,
      license: "apache-2.0",
      label: "Smart search",
      defaults: { pooling: "mean", normalize: true },
    },
  }),
  defaults: { load: "first-use", consentAboveMB: 30, allowWasmUpToMB: 50 },
});
```

Three ways to supply the runtime (`runtime.source`):

| Source | When | Notes |
|---|---|---|
| `cdn` | Recommended | Blob worker that imports the pinned URL. Nothing in the app bundle. CSP: `worker-src blob:`, `script-src` + `connect-src` on the CDN, `'wasm-unsafe-eval'`. |
| `worker` | App prefers bundling the engine | `createWorker: () => new Worker(new URL("./hf.worker.ts", import.meta.url), { type: "module" })`, and in `hf.worker.ts`: `serveHuggingFaceWorker(await import("@huggingface/transformers"))`. The engine lives only in the worker chunk. |
| `engine` | Tests, custom transport | Object implementing `HfEngine`. |

## Markup

<sonic-code language="html">
  <template>
&lt;sonic-fetch dataProvider="events" endPoint="events?view=essential&ids_season=9"&gt;&lt;/sonic-fetch&gt;

&lt;!-- Catalog: runs when the browser is idle, cached in IndexedDB --&gt;
&lt;sonic-hugging-face-infer
  model="multilingual-mini"
  inputProvider="events"
  outputProvider="search.vectors"
  options='{"text":"label + edito.sub_title + categories.title"}'
  load="idle"
  persistResults
&gt;&lt;/sonic-hugging-face-infer&gt;

&lt;!-- Query: on each keystroke (300 ms debounce) --&gt;
&lt;sonic-hugging-face-infer
  model="multilingual-mini"
  inputProvider="searchForm.q"
  outputProvider="search.query"
  statusProvider="searchAiStatus"
  debounce="300"
&gt;&lt;/sonic-hugging-face-infer&gt;
  </template>
</sonic-code>

Ranking combines several inputs (events, vectors, query). With the TypeScript API:

```ts
derive({
  inputs: { e: events, v: vectors, q: queryVector },
  output: results,
  compute: ({ e, v, q }) => rankBySimilarity(e, v, q, 8),
});
```

On the JSONata side, `$cosine(a, b)` and `$rankBySimilarity(items, vectors, query, topN?, minScore?)` are available in `sonic-jsonata` (one input: group data under the same DataProvider).

## Attributes

| Attribute | Role |
|---|---|
| `model` | Allowlist alias (required, unless given by `params.model`) |
| `inputProvider` | Input: text, list of texts, list of objects (+ `options.text`), image (URL, data URL, Blob), audio (Float32Array, URL) |
| `outputProvider` | Output (readonly). List in → **aligned** list out (`null` for unusable items) |
| `options` | JSON `{"text": …, "call": {…}}`. `text`: paths to concatenate (`"label + edito.sub_title"`, arrays flattened). `call`: pipeline options, validated per task |
| `params` | DataProvider `{ model, options }` (live settings, see [Driving by DataProvider](#driving-by-dataprovider)) |
| `load` | `auto` · `idle` · `visible` · `first-use` (default) · `consent` · `manual` |
| `trigger` | `mutation` (default) · `demand` |
| `debounce` | Debounce (ms) for `mutation` |
| `triggerProvider` | `demand` mode: each change on this DataProvider runs inference |
| `statusProvider` | Where to publish detailed status (see [States](#states)) |
| `consentProvider` | Truthy or `"accepted"` = consent, `"declined"` = refuse |
| `emptyValue` | Output when input is empty (JSON, default `null`) |
| `onInvalid` | Invalid input: `keep` (default, keep last result) or `clear` |
| `maxItems` · `maxChars` · `timeoutMs` | Limits (defaults from config) |
| `persistResults` · `resultsTtl` | Cache results in IndexedDB (key = input + model + revision + runtime + options) |

Methods: `run()`, `loadModel()`, `accept()`, `decline()`.

## Model loading

| `load` | Download |
|---|---|
| `auto` | As soon as the element connects |
| `idle` | When the browser is idle |
| `visible` | When the element enters the viewport |
| `first-use` | On the first valid input |
| `consent` | After user consent (asked on first valid input) |
| `manual` | Only via `loadModel()` |

Guards, regardless of policy: switch to `consent` on data-saver, slow network (2G), or when the model exceeds `consentAboveMB`. A cached model loads without prompting. Choice is stored per alias and revision (`hf.revokeConsent(alias)` to clear). Nothing downloads while the input is empty.

Consent without JavaScript (SDUI):

<sonic-code language="html">
  <template>
&lt;sonic-states dataProvider="searchAiStatus" data-path="state"&gt;
  &lt;template data-value="awaiting-consent"&gt;
    &lt;div formDataProvider="aiConsent"&gt;
      Enable smart search? &lt;sonic-value dataProvider="searchAiStatus" key="size.totalMB"&gt;&lt;/sonic-value&gt; MB, once, nothing leaves your device.
      &lt;sonic-button radio name="accepted" value="accepted"&gt;Enable&lt;/sonic-button&gt;
    &lt;/div&gt;
  &lt;/template&gt;
&lt;/sonic-states&gt;
&lt;!-- + consentProvider="aiConsent.accepted" on sonic-hugging-face-infer --&gt;
  </template>
</sonic-code>

## Triggers

| Case | `load` | `trigger` |
|---|---|---|
| Live search | `first-use` | `mutation`, `debounce="300"` |
| Catalog indexing | `idle` | `mutation` + `persistResults` |
| Label suggestions (admin) | `first-use` | `demand` (“Suggest” button) |
| Translate a listing | `consent` | `demand` (“Translate” button) |

## States

`{outputProvider root}/_state_` → `{ status }` (`loading` | `ready` | `error` | `empty`), like `sonic-jsonata`, for `sonic-states`.

Detailed status on `statusProvider`:

| Field | Content |
|---|---|
| `state` | `idle` · `empty` · `awaiting-consent` · `declined` · `downloading` · `loading` · `ready` · `running` · `done` · `invalid-input` · `error` · `unsupported` |
| `status` | Same value as `state` (the `status` / `error` convention shared by the other components) |
| `size` | `{ totalBytes, totalMB, fromCache }` — known **before** download |
| `progress` | `{ loadedBytes, totalBytes, percent, file }` while downloading |
| `backend` | `webgpu` or `wasm` |
| `skipped` · `warnings` | Skipped items, truncated texts |
| `timings` | `{ loadMs, lastRunMs }` |
| `fromResultsCache` | Result served from cache |
| `error` | `{ code, message }` — `config`, `invalid-input`, `too-large`, `not-allowed`, `quota`, `timeout`, `network`, `runtime` |

### Configuration errors

When the component cannot start, `statusProvider` receives `{ state: "error", status: "error", model: { alias }, size: { totalBytes: null, totalMB: null, fromCache: false }, error: { code, message } }`:

| Cause | `error.code` |
|---|---|
| `configureHuggingFace()` not called | `config` |
| No model (attribute or `params.model`), no `inputProvider` or `outputProvider` | `config` |
| Output overlapping the input, unreadable `params` | `config` |
| Alias not in the allowlist | `not-allowed` |
| `options.call` rejected by the task schema | `invalid-input` (published as soon as the component starts) |

A later valid configuration (attributes, `params`, or `configureHuggingFace()`) restarts the component and replaces the error.

## Driving by DataProvider

`params` points to a DataProvider `{ model, options }`. Its keys override the `model` and `options` attributes (an absent key keeps the attribute; `options: null` removes the attribute's options). `options` may be an object or a JSON string. Each actual change (deep comparison) stops the controller and restarts it with the new model and options; republishing the same value does nothing. Limits and loading policy stay on the attributes and in the application config: `params` cannot raise them.

<sonic-code language="html">
  <template>
&lt;sonic-hugging-face-infer
  model="event-labels"
  params="aiSettings"
  inputProvider="listing.description"
  outputProvider="listing.labels"
  statusProvider="labelsAiStatus"
&gt;&lt;/sonic-hugging-face-infer&gt;
&lt;!-- aiSettings = { "model": "event-labels-multilingual", "options": { "call": { "candidate_labels": ["concert", "theatre"] } } } --&gt;
  </template>
</sonic-code>

## Empty or invalid inputs

- Empty (`null`, `""`, `[]`, missing DataProvider) → `empty`, output `emptyValue`, **no download**.
- Wrong type (number, object without `options.text`, unknown option) → `invalid-input` with a precise message. No silent coercion.
- Partially valid list → aligned output, `null` for skipped items, `skipped` count.
- Too large → `too-large` (`maxItems`); overlong text → truncated (`maxChars`) and warned.

## WebGPU and WASM

ONNX Runtime is a WASM binary in every case (≈ 27 MB, ≈ 6.6 MB compressed for 1.31), including WebGPU: it downloads with the first model from your CDN, then is cached. It is not part of the component.

What you control: CPU (WASM) execution when WebGPU is missing. Allowed per model (`devices`) and only under `allowWasmUpToMB`. Beyond that → `unsupported`; the page keeps working without the model.

## TypeScript

`configureHuggingFace` returns an API typed by the allowlist:

```ts
const events = new DataProviderKey<EventEssential[]>("events");
const vectors = new DataProviderKey<(number[] | null)[] | null>("eventVectors");

hf.infer({
  model: "multilingual-mini",                // union of declared aliases
  input: events,
  text: (e) => [e.label, e.edito?.sub_title].filter(Boolean).join(" — "), // typed on EventEssential
  output: vectors,                           // error if type does not match the task
  load: "idle",
  persistResults: true,
});

// One-shot run (adapter for derive)
const v = await hf.run("multilingual-mini", "a funny show"); // number[] | null
const t = await hf.run("multilingual-mini", "funny", { pooling: "none" }); // number[][] | null
```

- Input, option, and output types are **derived** from Transformers.js signatures (`import type` only): a version bump that changes a signature fails compilation, not production.
- An option from another task, an unknown alias, or a mistyped output are compile errors.
- For SDUI, `options.call` is validated at runtime with a per-task schema; `hfCallOptionsJsonSchema(task)` exposes it as JSON Schema (MCP catalog). An SDUI descriptor can only set **call** options within bounds; repo, revision, dtype, and device stay in config.

Cleanup: `hf.clearModel(alias)`, `hf.clearAll()` (models, WASM, and results).

## Tasks and light models

Supported tasks: `feature-extraction`, `text-classification`, `zero-shot-classification`, `translation`, `token-classification`, `fill-mask`, `question-answering`, `image-classification`, `zero-shot-image-classification`, `object-detection`, `zero-shot-object-detection`, `image-feature-extraction`, `image-segmentation`, `depth-estimation`, `background-removal`, `image-to-text`, `audio-classification`, `automatic-speech-recognition`. No free-form LLM (`text-generation`, etc.).

Indicative sizes (quantized); verify with `hf-vendor.mjs` before allowlisting, including license:

| Task | Model | Size | Example |
|---|---|---|---|
| `background-removal` (general) | `onnx-community/ISNet-ONNX` | ≈ 44 MB | [Image demo](#image--background-removal) |
| `zero-shot-classification` | `Xenova/mobilebert-uncased-mnli` | ≈ 25 MB | [Text demo](#text--zero-shot-classification) |
| `depth-estimation` | `Xenova/depth-anything-small-hf` | ≈ 27 MB | [Visual stack](#docs/_misc/visual-stack.md/visual-stack) |
| `object-detection` | `Xenova/yolos-tiny` | ≈ 8 MB | — |
| `image-to-text` | `Xenova/vit-gpt2-image-captioning` | ≈ 246 MB | — |
| `token-classification` | `Xenova/bert-base-NER` | ≈ 109 MB | — |
| `background-removal` (portraits) | `Xenova/modnet` | ≈ 7 MB | Human portraits only |
| `image-segmentation` | `Xenova/segformer-b0-finetuned-ade-512-512` | ≈ 4 MB | Regions (sky, water…) |
| `feature-extraction` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | ≈ 120 MB | Intent / semantic search |
| `translation` | `Xenova/opus-mt-fr-en` | ≈ 75 MB | FR → EN listings |
| `automatic-speech-recognition` | `onnx-community/whisper-tiny.en` | ≈ 41 MB | Dictation / voice search |
| `fill-mask` | `Xenova/albert-base-v2` | ≈ 12 MB | Complete `[MASK]` |

Produced images (cutout, depth, segmentation) come out as `{ width, height, channels, blob, url }` (PNG). `url` is an ObjectURL attached on the main thread at publish time — chainable into `sonic-shader` / `sonic-jsonata` (`$mediaUrl`) without app glue. Images are not stored in IndexedDB.

End-to-end (depth + shader / Harris) : [Visual stack](#docs/_misc/visual-stack.md/visual-stack).

## `sonic-segment-anything` — Segment Anything (SAM 2)

Segmente l'objet désigné dans une image : on clique sur l'objet (ou on trace une boîte), le masque suit. L'image est **encodée une fois** (l'étape lourde, environ une seconde selon l'appareil), puis chaque nouvelle invite ne coûte que le décodeur (quelques dizaines de millisecondes).

```ts
// configuration de l'application : un modèle `engine: "sam"`
configureHuggingFace({
  runtime: { source: "cdn", url: ".../transformers.min.js", version: "4.3.0" },
  models: defineHuggingFaceModels({
    "sam2-tiny": { task: "image-segmentation", engine: "sam", repo: "onnx-community/sam2.1-hiera-tiny-ONNX", revision: "<sha>", options: { dtype: { vision_encoder: "q4f16", prompt_encoder_mask_decoder: "fp16" } }, sizeBytes: 40_000_000 },
  }),
});
```

```json
{ "tagName": "sonic-still", "attributes": { "id": "photo", "src": "@asset:photo.jpg" } }
{ "tagName": "sonic-segment-anything", "attributes": { "id": "objet", "for": "photo", "click-on": "photo", "out-data-provider": "objet" } }
{ "tagName": "sonic-mask-replace", "attributes": { "for": "photo", "mask": "#objet", "effect": "blur" } }
```

| Attribut | Rôle |
|---|---|
| `for` | Id de l'image : `sonic-still`, `<img>`, `<canvas>`, `sonic-camera`, `sonic-video`, toute source `getFrameCanvas()` |
| `model` | Alias de la configuration Hugging Face (`engine: "sam"`) ; défaut `sam2-tiny` |
| `click-on` | Id de l'élément cliquable : clic = nouvelle sélection, Maj+clic = ajouter un point, Alt+clic ou clic droit = exclure une zone, glisser = boîte |
| `points-from`, `box-from` | Chemins DataProvider : `[{x, y, label}]` (label 1 sur l'objet, 0 hors de l'objet) et `{x0, y0, x1, y1}`, en 0..1 |
| `points` | Points fixes : `"0.5,0.4,1; 0.2,0.2,0"` |
| `refresh` | `manual` (défaut) : encode à la première invite, puis seulement si l'image a changé ; `frames` : suit une source qui change (caméra, vidéo), au plus `fps` fois par seconde (défaut 2) |
| `mode`, `invert` | Masque `alpha` (défaut) ou `gray`, inversé à la demande |
| `mirror` | `auto` (miroir pour une caméra native), `true`, `false` |
| `load`, `consent-provider` | Politique de chargement (`first-use` défaut, `auto`, `consent`, `manual`) et DataProvider de consentement |
| `max-side` | Côté maximal de l'image envoyée et du masque produit (défaut 1600 ; le modèle travaille en 1024, le bord est affiné à cette résolution) |
| `refine` | `edges` (défaut) : le bord du masque est recalé sur les contours de l'image (filtre guidé, environ 0,2 s par clic sur ordinateur) ; `none` : masque brut du modèle, prédit en 256 px puis agrandi |
| `out-data-provider` | `{ phase, progress, backend, encoded, busy, points, box, present, score, coverage, cx, cy, x0, y0, x1, y1, encodeMs, decodeMs, error }` |

Méthodes : `setPrompts({points, box})`, `clear()`, `encode()`, `accept()`, `decline()`, `getState()`.

Limites : 16 points ; un objet à la fois (le meilleur des trois masques proposés, selon le score du modèle) ; ce n'est pas un suivi vidéo (en `refresh="frames"`, chaque image est segmentée de nouveau aux mêmes coordonnées).
