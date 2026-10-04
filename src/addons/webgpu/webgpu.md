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
