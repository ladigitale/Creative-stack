/**
 * Format « monde » : description textuelle d'un monde complet (modèles articulés en primitives, palette,
 * animations, placement), lue telle quelle par `sonic-3d` et `sonic-2d` depuis un DataProvider (clé `monde`).
 *
 * Ce fichier ne fait que lire et normaliser (aucune géométrie, aucun rendu) : il transforme le JSON écrit par
 * un agent en structures plates et sûres (bornes, valeurs par défaut, problèmes signalés sans jamais lever).
 */
import { DEG, Rand, hash32 } from "./math";
import { PRESETS, type PresetOut } from "./presets";
import { readTex, type TexSpec } from "./textures";
import { GEN_IDS, GEN_ROLES, genPreset, isGenId, type GenRig } from "./gen";

/* ------------------------------------------------------------------ JSON d'entrée */

export type ShapeKind = "box" | "sphere" | "capsule" | "cylinder" | "cone" | "torus" | "lathe" | "extrude" | "tube" | "plane";
export const SHAPES: ShapeKind[] = ["box", "sphere", "capsule", "cylinder", "cone", "torus", "lathe", "extrude", "tube", "plane"];

export type PartIn = {
  name?: string;
  parent?: string;
  /** Articulation (pivot) dans le repère du parent, en mètres. */
  at?: number[];
  /** Rotation de repos (degrés, ordre XYZ). */
  rot?: number[];
  /** Centre de la forme par rapport à l'articulation (repère de la pièce). */
  off?: number[];
  scale?: number | number[];
  role?: string;
  /** Couleur fixe (prioritaire sur le rôle). */
  color?: string;
  /** `x` : pièce dédoublée en `<nom>L` (telle quelle) et `<nom>R` (symétrique en x). */
  mirror?: "x";
  /** Répétition : `n` copies `<nom>0…`, chacune décalée de `at` et tournée de `rot` (degrés) depuis la précédente. */
  repeat?: { n?: number; at?: number[]; rot?: number[] };
  hidden?: boolean;
  /** Pièce lumineuse (0 à 1) : reflet, lampe, écran. */
  glow?: number;
  /** Texture : `"rayures"` ou `{kind, color2, scale, angle, contrast}` (voir textures.ts). */
  tex?: unknown;
} & Partial<Record<ShapeKind, unknown>>;

export type TrackIn = Partial<Record<"rx" | "ry" | "rz" | "x" | "y" | "z" | "s", number[]>> & { sync?: boolean; phase?: number };

export type ClipIn = {
  ms?: number;
  loop?: boolean;
  /** Clip enchaîné à la fin d'un clip non bouclé (sinon il reste sur sa dernière clé). */
  then?: string;
  /** `smooth` (défaut, courbe douce) ou `linear`. */
  ease?: "smooth" | "linear";
  tracks?: Record<string, TrackIn>;
};

export type ModelIn = {
  preset?: string;
  /** Générateur procgen (`character`, `animal.dog`, `tree`, `building`…) : forme, squelette et style procgen (3D). */
  gen?: string;
  seed?: string | number;
  params?: Record<string, unknown>;
  parts?: PartIn[];
  clips?: Record<string, ClipIn>;
  /** Clip joué par défaut par les instances nommées. */
  clip?: string;
};

export type PlaceIn = {
  model?: string;
  /** Nom de l'instance : nœud pilotable (`nodes.<nom>`), pièces `<nom>_<pièce>`. Sans nom : décor statique, fusionné. */
  name?: string;
  at?: number[];
  rot?: number[];
  scale?: number | number[];
  roles?: Record<string, string>;
  clip?: string;
  hidden?: boolean;
  /** Grille `[nx, nz]` (ou `[nx, ny, nz]`) espacée de `step`. */
  grid?: number[];
  step?: number[];
  /** Semis de `scatter` copies dans `area` `[x0, z0, x1, z1]`. */
  scatter?: number;
  area?: number[];
  /** Désordre (part du pas) en position, rotation y aléatoire (degrés), échelle `[min, max]`. */
  jitter?: number;
  turn?: number;
  size?: number[];
  seed?: string | number;
};

export type MondeIn = {
  palette?: Record<string, string>;
  models?: Record<string, ModelIn>;
  place?: PlaceIn[];
  /** `doux` (matière mate, défaut), `toon` (aplats), `brillant`. */
  look?: string;
  /** Finesse des maillages : `low`, `mid` (défaut), `high`. */
  detail?: string;
  /** Vue 2D : `top`, `side`, `front`, `iso` ; `unit` px par mètre ; `origin` position écran de l'origine du monde. */
  view2d?: { view?: string; unit?: number; origin?: number[] };
  /** Ombres portées au sol (3D) et sous les pièces (2D). */
  shadows?: boolean;
  /** Contour sombre des silhouettes (2D). */
  outline?: number;
  /** Textures par rôle (`{"maillot": "rayures", "sol": {"kind": "herbe", "scale": 3}}`). */
  textures?: Record<string, unknown>;
  /** Texture de toutes les pièces sans texture propre (`grain` : rendu gouache). */
  texture?: unknown;
  /** Couleur du ciel (fond 3D ; en 2D, l'attribut `background` reste maître). */
  ciel?: string;
  /** Brume 3D (0 à 1) vers la couleur du ciel. */
  brume?: number;
  /** Style des modèles `gen` : préréglage procgen (`gouache`, `doux`, `bd`, `encre`, `aquarelle`…) ou jetons. */
  style?: unknown;
};

/* ------------------------------------------------------------------ structures normalisées */

export type Shape = {
  kind: ShapeKind;
  /** Nombres de la forme (voir doc) ; `pts` pour lathe / extrude / tube. */
  a: number[];
  pts: number[][];
};

export type Part = {
  name: string;
  parent: number;
  at: [number, number, number];
  rot: [number, number, number];
  off: [number, number, number];
  scale: [number, number, number];
  role: string;
  color: string;
  shape: Shape | null;
  hidden: boolean;
  glow: number;
  tex: TexSpec | null;
};

export type Track = { part: number; ch: number; keys: number[]; phase: number };

export type Clip = { name: string; ms: number; loop: boolean; then: string; smooth: boolean; tracks: Track[] };

export type Model = {
  name: string;
  /** Signature (JSON d'entrée normalisé) : un modèle inchangé n'est pas reconstruit. */
  sig: string;
  parts: Part[];
  clips: Map<string, Clip>;
  clip: string;
  /** Rôles utilisés par le modèle, couleur par défaut. */
  roles: Record<string, string>;
  /** Modèle procgen : générateur, paramètres, graine ; les pièces sont alors ses os (sans forme). */
  gen: GenSpec | null;
  /** Problèmes de lecture du modèle (redonnés quand il est réutilisé tel quel). */
  issues: Issue[];
};

export type GenSpec = { id: string; params: Record<string, unknown>; seed: string; rig: GenRig };

export type Placement = {
  model: string;
  /** Vide : décor statique. */
  name: string;
  at: [number, number, number];
  rot: [number, number, number];
  scale: [number, number, number];
  roles: Record<string, string>;
  clip: string;
  hidden: boolean;
};

export type View2d = { view: "top" | "side" | "front" | "iso"; unit: number; origin: [number, number] };

export type Issue = { path: string; message: string };

export type Monde = {
  palette: Record<string, string>;
  models: Map<string, Model>;
  place: Placement[];
  look: "doux" | "toon" | "brillant";
  detail: number;
  view2d: View2d;
  shadows: boolean;
  outline: number;
  textures: Record<string, TexSpec>;
  texture: TexSpec | null;
  ciel: string;
  brume: number;
  /** Style procgen des modèles `gen` (préréglage ou jetons, lu par le rendu). */
  style: unknown;
  issues: Issue[];
};

/** Canaux d'une piste : rotations (radians), translations (m), échelle. */
export const CHANNELS = ["rx", "ry", "rz", "x", "y", "z", "s"] as const;

export const LIMITS = {
  models: 64,
  partsPerModel: 160,
  placements: 4000,
  named: 400,
  /** Pièces dessinées au total (copies × pièces) et pièces des instances nommées (animées). */
  parts: 40000,
  namedParts: 6000,
  clipsPerModel: 32,
  keys: 32,
  points: 64,
} as const;

const DEFAULT_PALETTE: Record<string, string> = {
  peau: "#f2c29b",
  maillot: "#2563eb",
  short: "#1e293b",
  chaussure: "#111827",
  cheveux: "#3b2416",
  oeil: "#ffffff",
  pupille: "#111827",
  accent: "#facc15",
  bois: "#8b5a2b",
  feuillage: "#3f9d4a",
  pierre: "#9ca3af",
  metal: "#cbd5e1",
  sol: "#6b8f4e",
  eau: "#38bdf8",
  blanc: "#f8fafc",
  noir: "#0f172a",
};

/* ------------------------------------------------------------------ lecture */

/** Lecture d'une clé propre (jamais un membre hérité comme `constructor`). */
export function own<T>(o: Record<string, T> | undefined | null, k: string): T | undefined {
  return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clampN = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** Dimension de forme : positive, jamais nulle (normales finies), bornée. */
const dim = (v: number) => clampN(Math.abs(v), 1e-4, 1000);

function vec3(v: unknown, d: [number, number, number]): [number, number, number] {
  if (!Array.isArray(v)) return [...d];
  return [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])];
}

function scale3(v: unknown): [number, number, number] {
  if (typeof v === "number" && Number.isFinite(v)) return [v, v, v];
  return vec3(v, [1, 1, 1]);
}

export function isColor(s: unknown): s is string {
  return typeof s === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());
}

const safeColor = (s: unknown): string | undefined => (isColor(s) ? s : undefined);

function readShape(p: PartIn, path: string, issues: Issue[]): Shape | null {
  const kinds = SHAPES.filter((k) => p[k] !== undefined);
  if (!kinds.length) return null;
  if (kinds.length > 1) issues.push({ path, message: `une seule forme par pièce (${kinds.join(", ")}) : ${kinds[0]} retenue` });
  const kind = kinds[0];
  const raw = p[kind];
  const arr = (v: unknown) => (Array.isArray(v) ? v : typeof v === "number" ? [v] : []);
  const nums = (v: unknown) => arr(v).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const ptsOf = (v: unknown, dim: number) =>
    (Array.isArray(v) ? v : [])
      .filter((q): q is number[] => Array.isArray(q) && q.length >= dim && q.slice(0, dim).every((x) => typeof x === "number" && Number.isFinite(x)))
      .slice(0, LIMITS.points)
      .map((q) => q.slice(0, dim));
  switch (kind) {
    case "box": {
      const a = nums(raw);
      return { kind, a: [dim(num(a[0], 1)), dim(num(a[1], a[0] ?? 1)), dim(num(a[2], a[0] ?? 1)), Math.max(0, num(a[3], 0))], pts: [] };
    }
    case "sphere": {
      const a = nums(raw);
      const r = dim(num(a[0], 0.5));
      return { kind, a: [r, dim(num(a[1], r)), dim(num(a[2], a[0] ?? r))], pts: [] };
    }
    case "capsule": {
      const a = nums(raw);
      return { kind, a: [dim(num(a[0], 0.2)), Math.max(0, num(a[1], 0.5))], pts: [] };
    }
    case "cylinder": {
      const a = nums(raw);
      const r = dim(num(a[0], 0.3));
      return { kind, a: [r, dim(num(a[1], 1)), dim(num(a[2], r))], pts: [] };
    }
    case "cone": {
      const a = nums(raw);
      return { kind: "cylinder", a: [dim(num(a[0], 0.3)), dim(num(a[1], 1)), 0], pts: [] };
    }
    case "torus": {
      const a = nums(raw);
      return { kind, a: [dim(num(a[0], 0.5)), dim(num(a[1], 0.1)), clampN(num(a[2], 360), 1, 360)], pts: [] };
    }
    case "plane": {
      const a = nums(raw);
      return { kind, a: [dim(num(a[0], 1)), dim(num(a[1], a[0] ?? 1))], pts: [] };
    }
    case "lathe": {
      const pts = ptsOf(raw, 2);
      if (pts.length < 2) {
        issues.push({ path, message: "lathe : au moins 2 points [rayon, y]" });
        return null;
      }
      return { kind, a: [], pts: pts.map(([r, y]) => [Math.abs(r), y]) };
    }
    case "extrude": {
      const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { pts: raw }) as { pts?: unknown; depth?: unknown };
      const pts = ptsOf(o.pts, 2);
      if (pts.length < 3) {
        issues.push({ path, message: "extrude : au moins 3 points [x, y] dans pts" });
        return null;
      }
      return { kind, a: [dim(num(o.depth, 0.1))], pts };
    }
    case "tube": {
      const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { pts: raw }) as { pts?: unknown; r?: unknown; r2?: unknown };
      const pts = ptsOf(o.pts, 3);
      if (pts.length < 2) {
        issues.push({ path, message: "tube : au moins 2 points [x, y, z] dans pts" });
        return null;
      }
      const r = dim(num(o.r, 0.05));
      return { kind, a: [r, dim(num(o.r2, r))], pts };
    }
  }
  return null;
}

function readModel(name: string, src: ModelIn, palette: Record<string, string>, ownPal: Record<string, string>, issues: Issue[]): Model {
  const path = `models.${name}`;
  let preset: PresetOut | null = null;
  let gen: GenSpec | null = null;
  if (src.gen !== undefined) {
    if (!isGenId(src.gen)) issues.push({ path: `${path}.gen`, message: `générateur inconnu « ${String(src.gen)} » (${GEN_IDS.join(", ")})` });
    else {
      const params = src.params && typeof src.params === "object" && !Array.isArray(src.params) ? { ...src.params } : {};
      const gp = genPreset(src.gen, params);
      preset = gp;
      gen = { id: src.gen, params, seed: `${src.seed ?? name}`, rig: gp.rig };
      if (src.preset !== undefined) issues.push({ path: `${path}.preset`, message: "ignoré : le modèle a déjà un générateur (gen)" });
      if (Array.isArray(src.parts) && src.parts.length) issues.push({ path: `${path}.parts`, message: "ignorées : un modèle gen n'a que ses os (pièces sans forme)" });
    }
  }
  if (!gen && typeof src.preset === "string") {
    const gen = own(PRESETS, src.preset);
    if (!gen) issues.push({ path: `${path}.preset`, message: `préréglage inconnu « ${src.preset} » (${Object.keys(PRESETS).join(", ")})` });
    else preset = gen.build(new Rand(`${src.seed ?? name}`), src.params ?? {});
  }
  // Pièces du préréglage puis pièces écrites (même nom = remplace, sinon ajoute)
  const inParts: PartIn[] = [...(preset?.parts ?? [])];
  for (const p of !gen && Array.isArray(src.parts) ? src.parts : []) {
    if (!p || typeof p !== "object") continue;
    const i = typeof p.name === "string" ? inParts.findIndex((q) => q.name === p.name) : -1;
    if (i >= 0) {
      // remplacement partiel : la forme écrite remplace toute forme du préréglage
      const base = { ...inParts[i] };
      if (SHAPES.some((k) => (p as PartIn)[k] !== undefined)) for (const k of SHAPES) delete base[k];
      inParts[i] = { ...base, ...p };
    } else inParts.push(p);
  }

  const parts: Part[] = [];
  const index = new Map<string, number>();
  const mirrors = new Map<string, [string, string]>();
  const repeats = new Map<string, string[]>();
  const pending: { part: Part; parentName: string }[] = [];

  const add = (p: Part, parentName: string, path2: string) => {
    if (parts.length >= LIMITS.partsPerModel) {
      issues.push({ path: path2, message: `plus de ${LIMITS.partsPerModel} pièces : ignorée` });
      return;
    }
    if (index.has(p.name)) {
      issues.push({ path: path2, message: `nom de pièce en double « ${p.name} »` });
      return;
    }
    index.set(p.name, parts.length);
    parts.push(p);
    pending.push({ part: p, parentName });
  };

  inParts.forEach((p, i) => {
    const path2 = `${path}.parts.${i}`;
    const base = typeof p.name === "string" && p.name ? p.name.replace(/[^\w-]/g, "") : `piece${i}`;
    const role = typeof p.role === "string" ? p.role : "";
    const color = isColor(p.color) ? p.color : "";
    const make = (nm: string, at: [number, number, number], rot: [number, number, number], off: [number, number, number]): Part => ({
      name: nm,
      parent: -1,
      at,
      rot,
      off,
      scale: scale3(p.scale),
      role,
      color,
      shape: readShape(p, path2, issues),
      hidden: p.hidden === true,
      glow: clampN(num(p.glow, 0), 0, 1),
      tex: readTex(p.tex, (message) => issues.push({ path: `${path2}.tex`, message })),
    });
    const at = vec3(p.at, [0, 0, 0]);
    const rot = vec3(p.rot, [0, 0, 0]).map((v) => v * DEG) as [number, number, number];
    const off = vec3(p.off, [0, 0, 0]);
    const parentName = typeof p.parent === "string" ? p.parent : "";
    // l'enfant d'une pièce dédoublée est dédoublé aussi (main d'un bras, pupille d'un œil)
    if (p.mirror === "x" || (parentName && mirrors.has(parentName) && !index.has(parentName))) {
      add(make(`${base}L`, at, rot, off), parentName, path2);
      add(make(`${base}R`, [-at[0], at[1], at[2]], [rot[0], -rot[1], -rot[2]], [-off[0], off[1], off[2]]), parentName, path2);
      mirrors.set(base, [`${base}L`, `${base}R`]);
    } else if (p.repeat && typeof p.repeat === "object") {
      const n = clampN(Math.round(num(p.repeat.n, 2)), 1, 64);
      const dAt = vec3(p.repeat.at, [0, 0, 0]);
      const dRot = vec3(p.repeat.rot, [0, 0, 0]).map((v) => v * DEG);
      const names: string[] = [];
      for (let k = 0; k < n; k++) {
        const nm = `${base}${k}`;
        names.push(nm);
        add(
          make(nm, [at[0] + dAt[0] * k, at[1] + dAt[1] * k, at[2] + dAt[2] * k], [rot[0] + dRot[0] * k, rot[1] + dRot[1] * k, rot[2] + dRot[2] * k], off),
          parentName,
          path2,
        );
      }
      repeats.set(base, names);
    } else add(make(base, at, rot, off), parentName, path2);
  });

  // Parents (un parent dédoublé se résout du même côté : brasL → épauleL)
  for (const { part, parentName } of pending) {
    if (!parentName) continue;
    let pi = index.get(parentName);
    if (pi === undefined && mirrors.has(parentName)) {
      const side = part.name.endsWith("R") ? 1 : 0;
      pi = index.get(mirrors.get(parentName)![side]);
    }
    if (pi === undefined || pi === index.get(part.name)) {
      issues.push({ path: `${path}.parts.${part.name}`, message: `parent inconnu « ${parentName} »` });
      continue;
    }
    part.parent = pi;
  }
  // Les parents doivent précéder leurs enfants (ordre topologique, cycles cassés)
  const order: number[] = [];
  const state = new Uint8Array(parts.length);
  const visit = (i: number) => {
    if (state[i] === 2) return;
    if (state[i] === 1) {
      parts[i].parent = -1;
      issues.push({ path: `${path}.parts.${parts[i].name}`, message: "cycle de parents : pièce détachée" });
      return;
    }
    state[i] = 1;
    if (parts[i].parent >= 0) visit(parts[i].parent);
    state[i] = 2;
    order.push(i);
  };
  parts.forEach((_, i) => visit(i));
  const remap = new Map<number, number>();
  order.forEach((old, i) => remap.set(old, i));
  const sorted = order.map((old) => {
    const p = parts[old];
    return { ...p, parent: p.parent >= 0 ? remap.get(p.parent)! : -1 };
  });
  const idx = new Map(sorted.map((p, i) => [p.name, i]));

  // Clips
  const clips = new Map<string, Clip>();
  const ownClips = src.clips && typeof src.clips === "object" ? src.clips : {};
  const clipSrc: Record<string, ClipIn> = { ...(preset?.clips ?? {}), ...ownClips };
  let nClips = 0;
  for (const [cname, c] of Object.entries(clipSrc)) {
    if (!c || typeof c !== "object") continue;
    if (++nClips > LIMITS.clipsPerModel) {
      issues.push({ path: `${path}.clips`, message: `plus de ${LIMITS.clipsPerModel} clips` });
      break;
    }
    const tracks: Track[] = [];
    for (const [pname, t] of Object.entries(c.tracks ?? {})) {
      if (!t || typeof t !== "object") continue;
      const targets: { i: number; phase: number }[] = [];
      const ph = num(t.phase, 0);
      if (idx.has(pname)) targets.push({ i: idx.get(pname)!, phase: ph });
      else if (mirrors.has(pname)) {
        const [l, r] = mirrors.get(pname)!;
        targets.push({ i: idx.get(l)!, phase: ph }, { i: idx.get(r)!, phase: ph + (t.sync ? 0 : 0.5) });
      } else if (repeats.has(pname)) {
        const names = repeats.get(pname)!;
        names.forEach((nm, k) => targets.push({ i: idx.get(nm)!, phase: ph + (t.sync ? 0 : k / names.length) }));
      } else {
        // les clips d'un préréglage visent des pièces facultatives (queue, oreilles) : pas de bruit
        if (Object.prototype.hasOwnProperty.call(ownClips, cname)) issues.push({ path: `${path}.clips.${cname}.tracks.${pname}`, message: "pièce inconnue" });
        continue;
      }
      CHANNELS.forEach((ch, ci) => {
        const raw = t[ch];
        if (!Array.isArray(raw)) return;
        const keys = raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(0, LIMITS.keys);
        if (!keys.length) return;
        const k = ci < 3 ? keys.map((v) => v * DEG) : keys;
        for (const tg of targets) {
          // Côté droit d'un miroir : rotations y / z et translation x inversées
          const flip = sorted[tg.i].name.endsWith("R") && mirrors.has(pname) && (ch === "ry" || ch === "rz" || ch === "x");
          tracks.push({ part: tg.i, ch: ci, keys: flip ? k.map((v) => -v) : k, phase: tg.phase });
        }
      });
    }
    clips.set(cname, {
      name: cname,
      ms: clampN(num(c.ms, 800), 30, 60000),
      loop: c.loop !== false,
      then: typeof c.then === "string" ? c.then : "",
      smooth: c.ease !== "linear",
      tracks,
    });
  }

  const roles: Record<string, string> = {};
  if (gen) for (const [k, v] of Object.entries(GEN_ROLES)) roles[k] = roles[v] = own(ownPal, k) ?? "";
  for (const p of sorted) if (p.role && !Object.prototype.hasOwnProperty.call(roles, p.role)) roles[p.role] = own(ownPal, p.role) ?? safeColor(own(preset?.roles, p.role)) ?? own(palette, p.role) ?? "#94a3b8";
  const clip = typeof src.clip === "string" ? src.clip : preset?.clip ?? (clips.has("idle") ? "idle" : "");
  return { name, sig: "", parts: sorted, clips, clip, roles, gen, issues: [] };
}

function readPlacements(list: unknown, models: Map<string, Model>, issues: Issue[]): Placement[] {
  const out: Placement[] = [];
  const names = new Set<string>();
  let named = 0;
  const arr = (Array.isArray(list) ? list : []).slice(0, 2000);
  if (Array.isArray(list) && list.length > 2000) issues.push({ path: "place", message: "plus de 2000 entrées : la suite est ignorée" });
  let budget: number = LIMITS.parts;
  let namedParts = 0;
  arr.forEach((raw, i) => {
    const p = (raw && typeof raw === "object" ? raw : {}) as PlaceIn;
    const path = `place.${i}`;
    const model = typeof p.model === "string" ? p.model : "";
    if (!models.has(model)) {
      issues.push({ path, message: `modèle inconnu « ${model} »` });
      return;
    }
    const roles: Record<string, string> = {};
    if (p.roles && typeof p.roles === "object") for (const [k, v] of Object.entries(p.roles)) if (isColor(v)) roles[k] = v;
    const base: Placement = {
      model,
      name: "",
      at: vec3(p.at, [0, 0, 0]),
      rot: vec3(p.rot, [0, 0, 0]).map((v) => v * DEG) as [number, number, number],
      scale: scale3(p.scale),
      roles,
      clip: typeof p.clip === "string" ? p.clip : "",
      hidden: p.hidden === true,
    };
    const shaped = models.get(model)!.parts.filter((q) => q.shape).length || 1;
    const full = () => out.length >= LIMITS.placements || budget < shaped;
    const push = (pl: Placement) => {
      if (full()) return;
      if (pl.name) {
        if (namedParts + shaped > LIMITS.namedParts) {
          issues.push({ path, message: `plus de ${LIMITS.namedParts} pièces animées : instance ignorée` });
          return;
        }
        namedParts += shaped;
      }
      budget -= shaped;
      out.push(pl);
    };
    const rnd = new Rand(`${p.seed ?? i}/${model}`);
    const jitter = Math.max(0, num(p.jitter, 0));
    const turn = dim(num(p.turn, 0)) * DEG;
    const size = Array.isArray(p.size) ? [num(p.size[0], 1), num(p.size[1], num(p.size[0], 1))] : null;
    const vary = (pl: Placement, step: number): Placement => {
      const s = size ? rnd.range(size[0], size[1]) : 1;
      return {
        ...pl,
        at: [pl.at[0] + rnd.range(-1, 1) * jitter * step, pl.at[1], pl.at[2] + rnd.range(-1, 1) * jitter * step],
        rot: [pl.rot[0], pl.rot[1] + rnd.range(-1, 1) * turn, pl.rot[2]],
        scale: [pl.scale[0] * s, pl.scale[1] * s, pl.scale[2] * s],
      };
    };
    if (Array.isArray(p.grid)) {
      const g = p.grid.map((v) => clampN(Math.round(num(v, 1)), 1, 200));
      const [nx, ny, nz] = g.length >= 3 ? g : [g[0] ?? 1, 1, g[1] ?? 1];
      const st = vec3(p.step, [1, 1, 1]);
      if (nx * ny * nz > LIMITS.placements) issues.push({ path, message: `grille de ${nx * ny * nz} copies : limitée à ${LIMITS.placements}` });
      for (let a = 0; a < nx && !full(); a++)
        for (let b = 0; b < ny && !full(); b++)
          for (let c = 0; c < nz && !full(); c++)
            push(vary({ ...base, at: [base.at[0] + a * st[0], base.at[1] + b * st[1], base.at[2] + c * st[2]] }, Math.min(Math.abs(st[0]) || 1, Math.abs(st[2]) || 1)));
      return;
    }
    if (typeof p.scatter === "number") {
      const n = clampN(Math.round(p.scatter), 0, LIMITS.placements);
      const ar = Array.isArray(p.area) ? p.area.map((v) => num(v, 0)) : [-5, -5, 5, 5];
      for (let k = 0; k < n && !full(); k++) {
        const pl = vary({ ...base, at: [rnd.range(ar[0], ar[2]), base.at[1], rnd.range(ar[1], ar[3])] }, 0);
        if (!turn) pl.rot = [pl.rot[0], rnd.range(0, Math.PI * 2), pl.rot[2]];
        push(pl);
      }
      return;
    }
    const name = typeof p.name === "string" ? p.name.replace(/[^\w-]/g, "") : "";
    if (name) {
      if (names.has(name)) {
        issues.push({ path, message: `nom d'instance en double « ${name} »` });
        return;
      }
      if (++named > LIMITS.named) {
        issues.push({ path, message: `plus de ${LIMITS.named} instances nommées` });
        return;
      }
      names.add(name);
    }
    push(vary({ ...base, name }, 0));
  });
  if (budget <= 0 || out.length >= LIMITS.placements) issues.push({ path: "place", message: `budget atteint (${LIMITS.placements} copies, ${LIMITS.parts} pièces) : placements suivants ignorés` });
  return out;
}

const VIEWS = ["top", "side", "front", "iso"] as const;
const LOOKS = ["doux", "toon", "brillant"] as const;

/** Lecture tolérante : jamais d'exception, les problèmes vont dans `issues`. */
export function readMonde(input: unknown, previous?: Monde | null): Monde {
  try {
    return readMondeUnsafe(input, previous);
  } catch (err) {
    const m = readMondeUnsafe({}, null);
    m.issues.push({ path: "", message: `monde illisible : ${err instanceof Error ? err.message : String(err)}` });
    return m;
  }
}

function readMondeUnsafe(input: unknown, previous?: Monde | null): Monde {
  const src = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as MondeIn;
  const issues: Issue[] = [];
  const palette: Record<string, string> = { ...DEFAULT_PALETTE };
  const ownPal: Record<string, string> = {};
  if (src.palette && typeof src.palette === "object") {
    for (const [k, v] of Object.entries(src.palette)) {
      if (isColor(v)) palette[k] = ownPal[k] = v;
      else issues.push({ path: `palette.${k}`, message: "couleur #rrggbb attendue" });
    }
  }
  const models = new Map<string, Model>();
  const entries = Object.entries(src.models && typeof src.models === "object" ? src.models : {});
  if (entries.length > LIMITS.models) issues.push({ path: "models", message: `plus de ${LIMITS.models} modèles` });
  for (const [name, m] of entries.slice(0, LIMITS.models)) {
    if (!m || typeof m !== "object") continue;
    const sig = `${hash32(JSON.stringify(m))}/${hash32(JSON.stringify(src.palette ?? {}))}`;
    const prev = previous?.models.get(name);
    if (prev && prev.sig === sig) {
      models.set(name, prev);
      issues.push(...prev.issues);
      continue;
    }
    const own0 = issues.length;
    const model = readModel(name, m, palette, ownPal, issues);
    model.sig = sig;
    model.issues = issues.slice(own0);
    models.set(name, model);
  }
  const v = src.view2d ?? {};
  const view = (VIEWS as readonly string[]).includes(String(v.view)) ? (v.view as View2d["view"]) : "top";
  const look = (LOOKS as readonly string[]).includes(String(src.look)) ? (src.look as Monde["look"]) : "doux";
  const detail = src.detail === "low" ? 0 : src.detail === "high" ? 2 : 1;
  const textures: Record<string, TexSpec> = {};
  if (src.textures && typeof src.textures === "object")
    for (const [k, t] of Object.entries(src.textures)) {
      const r = readTex(t, (message) => issues.push({ path: `textures.${k}`, message }));
      if (r) textures[k] = r;
    }
  return {
    palette,
    models,
    textures,
    texture: readTex(src.texture, (message) => issues.push({ path: "texture", message })),
    ciel: isColor(src.ciel) ? src.ciel : "",
    brume: clampN(num(src.brume, 0), 0, 1),
    style: src.style ?? null,
    place: readPlacements(src.place, models, issues),
    look,
    detail,
    view2d: { view, unit: clampN(num(v.unit, 48), 1, 2000), origin: [num(v.origin?.[0], 0), num(v.origin?.[1], 0)] },
    shadows: src.shadows !== false,
    outline: clampN(num(src.outline, 1), 0, 6),
    issues,
  };
}

/** Couleur effective d'une pièce pour une instance (couleur fixe > rôle de l'instance > palette du modèle). */
export function partColor(model: Model, part: Part, roles: Record<string, string> | undefined, palette: Record<string, string>): string {
  if (part.color) return part.color;
  if (part.role) return safeColor(own(roles, part.role)) ?? own(model.roles, part.role) ?? own(palette, part.role) ?? "#94a3b8";
  return "#94a3b8";
}

/** Texture effective d'une pièce (propre > rôle > défaut du monde). */
export function partTex(m: Monde, part: Part): TexSpec | null {
  if (part.glow > 0) return part.tex;
  return part.tex ?? (part.role ? own(m.textures, part.role) : undefined) ?? m.texture;
}

/** Résumé publié par les rendus (sortie `monde`) : ce qui existe et peut être piloté. */
export function mondeSummary(m: Monde) {
  const models: Record<string, { parts: string[]; clips: string[]; roles: Record<string, string>; clip: string }> = {};
  for (const [k, md] of m.models) models[k] = { parts: md.parts.map((p) => p.name), clips: [...md.clips.keys()], roles: md.roles, clip: md.clip };
  return {
    models,
    instances: m.place.filter((p) => p.name).map((p) => ({ name: p.name, model: p.model })),
    decor: m.place.filter((p) => !p.name).length,
    issues: m.issues.slice(0, 50),
  };
}
