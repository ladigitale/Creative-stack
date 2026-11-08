import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { Smoother } from "../../shared/ml/one-euro";
import { MAX_BONES, Rig, aimAngle, wrap180, type BoneDrive, type BoneSpec, type BoneState } from "../../shared/skeleton";
import { HUMAN_PRESET, boneSpecFromAttrs, type BoneAttrs } from "../../shared/skeleton-presets";

export { HUMAN_PRESET, type BoneAttrs };

const tagName = "sonic-skeleton";
// `+ 0` : -0 devient 0
const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const r4 = (n: number) => Math.round(n * 10000) / 10000 + 0;

/**
 * Os déclaré en enfant de `sonic-skeleton` (aucun rendu : le squelette lit ses attributs, comme `sonic-2d` lit
 * `sonic-sprite`).
 */
@customElement("sonic-bone")
export class SonicBone extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;
}

/* ------------------------------------------------------------------ déclaration des os */


type BoneConfig = {
  spec: BoneSpec;
  /** Alternatives `A>B`, chacune un couple de groupes d'articulations (moyenne des membres d'un groupe `a+b`). */
  aim: Array<[string[], string[]]>;
  angleFrom: string;
  /** Chemin d'une valeur (degrés × `angle-scale`) AJOUTÉE à l'angle de l'os (mesuré ou de repos), sans casser la chaîne. */
  angleAddFrom: string;
  angleScale: number;
  angleOffset: number;
  /** Noms de nœuds du format `nodes` alimentés par cet os (le nom de l'os en premier). */
  nodes: string[];
};

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** `"leftShoulder>leftElbow | leftHip+rightHip>leftKnee"` → alternatives de couples de groupes ; syntaxe invalide : ignorée. */
export function parseAim(value: string | undefined): Array<[string[], string[]]> {
  const out: Array<[string[], string[]]> = [];
  for (const alt of (value ?? "").split("|")) {
    const parts = alt.split(">").map((p) => p.trim());
    if (parts.length !== 2) continue;
    const group = (g: string) => g.split("+").map((n) => n.trim()).filter(Boolean);
    const a = group(parts[0]);
    const b = group(parts[1]);
    if (a.length && b.length) out.push([a, b]);
  }
  return out;
}

export function parseBone(attrs: BoneAttrs): { config: BoneConfig | null; error?: string } {
  const name = (attrs.name ?? "").trim();
  if (!name) return { config: null, error: "un os sans nom est ignoré" };
  const parent = (attrs.parent ?? "").trim();
  const extra = (attrs.attach ?? "").split(/[\s,]+/).filter(Boolean);
  return {
    config: {
      spec: boneSpecFromAttrs(attrs) as BoneSpec,
      aim: parseAim(attrs.aim),
      angleFrom: (attrs["angle-from"] ?? "").trim(),
      angleAddFrom: (attrs["angle-add-from"] ?? "").trim(),
      angleScale: num(attrs["angle-scale"], 1),
      angleOffset: num(attrs["angle-offset"], 0),
      nodes: [name, ...extra.filter((n) => n !== name)],
    },
  };
}

export const PRESETS: Record<string, BoneAttrs[]> = { humain: HUMAN_PRESET };

/** Articulation de la sortie d'un tracker de pose (`{ x, y, v }`), ou `null` si absente. */
type Joint = { x: number; y: number; v: number };

export type SkeletonState = {
  /** `idle` : aucun os ; `ready` : squelette valide ; `error` : au moins une erreur de déclaration (les os valides restent actifs). */
  status: "idle" | "ready" | "error";
  /** Première erreur de déclaration, ou null. */
  error: string | null;
  /** Os et erreurs de déclaration. */
  bones: string[];
  errors: string[];
  /** 1 si au moins un os est piloté (mesure ou valeur) ; 0 : repos. */
  present: 0 | 1;
};

/**
 * Squelette 2D à os rigides. Il ne dessine rien : il calcule la pose et l'écrit au **format `nodes`** partagé
 * (`<nodes-out>.nodes`, un nœud par os : `x`, `y` de l'articulation, `rz` par rapport au repos) ainsi que l'état des os
 * (`<nodes-out>.bones` : origine, extrémité, angle, longueur). Tout rendu qui lit `nodes` suit : un `sonic-sprite`
 * de `sonic-2d` (avec `pivot`), un nœud glTF de `sonic-3d`, un élément de `sonic-stage`, de même nom que l'os
 * (ou listé dans `attach`).
 *
 * Les os sont pilotés par des mesures de pose (`source` = sortie d'un `sonic-pose-tracker`, `aim` par os) ou par
 * n'importe quelle valeur (`angle-from`). `preset="humain"` déclare le corps entier ; des enfants `sonic-bone` de même
 * nom en modifient les attributs. Angles en degrés : 0 = vers le bas, positif = sens horaire.
 * État standard dans `<nodes-out>.status`, `.error` et `.errors` (erreurs de déclaration : os sans nom, en double,
 * parent inconnu, preset inconnu…).
 */
@customElement(tagName)
export class SonicSkeleton extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** DataProvider de la sortie d'un `sonic-pose-tracker` (clé `joints`). Sans lui, seuls `angle-from` pilotent. */
  @property({ type: String })
  source = "";

  /** `humain` : corps entier, branché sur les articulations de la pose. */
  @property({ type: String })
  preset = "";

  /** DataProvider qui reçoit `nodes`, `bones` et `present` (celui que lit `sonic-2d dataProvider`). */
  @property({ type: String, attribute: "nodes-out" })
  nodesOut = "";

  /** Taille de la scène (unités) : l'image de la pose est étirée dessus pour placer la racine. */
  @property({ type: Number })
  width = 800;
  @property({ type: Number })
  height = 450;

  /** Largeur / hauteur de l'image analysée (angles justes sur une image non carrée). */
  @property({ type: Number })
  aspect = 4 / 3;

  /** Échelle du squelette entier (longueurs et décalages). */
  @property({ type: Number })
  scale = 1;

  /** Articulations dont la moyenne place la racine (`leftHip+rightHip`) ; vide : position fixe `x`, `y` (le preset humain avec `source` suit les hanches). */
  @property({ type: String })
  root = "";

  /** Position fixe de la racine (unités) quand `root` est vide ou la pose perdue. Défaut : bas-centre de la scène. */
  @property({ type: Number })
  x = Number.NaN;
  @property({ type: Number })
  y = Number.NaN;

  /**
   * `pose` : la pose de repos publiée (`<nodes-out>.rest`) est la pose MESURÉE (sans les ajouts `angle-add-from`).
   * Un maillage dessiné sur la photo de la personne prend alors sa pose comme repos : seuls les ajouts le déforment.
   */
  @property({ type: String })
  rest = "";

  /**
   * Nom d'un os (`true` = `torse`) dont la longueur mesurée règle l'échelle du squelette : les os prennent la taille de
   * la personne. Sans mesure, on garde la dernière échelle trouvée, puis `scale`.
   */
  @property({ type: String })
  fit = "";

  /** Visibilité minimale d'une articulation (0..1) pour être utilisée. */
  @property({ type: Number, attribute: "min-visibility" })
  minVisibility = 0.5;

  /** Lissage One Euro des articulations, 0 (aucun) à 1. */
  @property({ type: Number })
  smooth = 0.4;

  /** Une mesure perdue garde la dernière direction pendant cette durée (ms), puis l'os retourne au repos. */
  @property({ type: Number, attribute: "hold-ms" })
  holdMs = 600;

  /** Durée (ms) de l'interpolation du retour au repos, demandée au rendu (`ease` des nodes). */
  @property({ type: Number, attribute: "ease-ms" })
  easeMs = 300;

  private rig: Rig | null = null;
  private configs: BoneConfig[] = [];
  private errors: string[] = [];
  private pose: Record<string, unknown> | null = null;
  private values = new Map<string, number>();
  private unsubs: Array<() => void> = [];
  private observer: MutationObserver | null = null;
  private smoother = new Smoother(0.4);
  private lastWorld = new Map<string, { angle: number; t: number }>();
  private lastRoot: { x: number; y: number; t: number } | null = null;
  private driven = new Set<string>();
  private lastSig = "";
  private lastRestSig = "";
  private lastFit: number | null = null;
  private measuredRest: BoneState[] | null = null;
  private queued = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private states: BoneState[] = [];
  private present: 0 | 1 = 0;
  private lastStatusSig = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.observer = new MutationObserver(() => this.rebuild());
    this.observer.observe(this, { childList: true, subtree: true, attributes: true });
    this.rebuild();
  }

  disconnectedCallback(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.unlisten();
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("nodesOut")) this.lastSig = this.lastRestSig = "";
    if (changed.has("source") || changed.has("preset") || changed.has("scale") || changed.has("fit")) this.rebuild();
    else if (changed.size) this.schedule();
  }

  /** État courant (os, erreurs de déclaration, présence). */
  getState(): SkeletonState {
    const status: SkeletonState["status"] = this.errors.length ? "error" : this.configs.length ? "ready" : "idle";
    return { status, error: this.errors[0] ?? null, bones: this.configs.map((c) => c.spec.name), errors: [...this.errors], present: this.present };
  }

  /** `<nodes-out>.status`, `.error`, `.errors` : publiés quand ils changent (et à chaque changement de `nodes-out`). */
  private publishStatus(out: string): void {
    const { status, error, errors } = this.getState();
    const sig = JSON.stringify([out, status, errors]);
    if (sig === this.lastStatusSig) return;
    this.lastStatusSig = sig;
    set(`${out}.status`, status);
    set(`${out}.error`, error);
    set(`${out}.errors`, errors);
  }

  /** Pose résolue à la dernière mise à jour (pour les tests et l'atelier). */
  getBones(): BoneState[] {
    return this.states;
  }

  /* ------------------------------------------------------------ déclaration */

  private rebuild(): void {
    const errors: string[] = [];
    const byName = new Map<string, BoneAttrs>();
    const order: string[] = [];
    const take = (attrs: BoneAttrs, merge: boolean) => {
      const name = (attrs.name ?? "").trim();
      if (!name) {
        errors.push("un os sans nom est ignoré");
        return;
      }
      const prev = byName.get(name);
      if (prev && !merge) {
        errors.push(`os "${name}" déclaré deux fois`);
        return;
      }
      if (!prev) order.push(name);
      byName.set(name, { ...(prev ?? {}), ...attrs });
    };
    const presetName = (this.preset ?? "").trim().toLowerCase();
    if (presetName) {
      const preset = PRESETS[presetName];
      if (preset) for (const b of preset) take(b, false);
      else errors.push(`preset "${presetName}" inconnu (${Object.keys(PRESETS).join(", ")})`);
    }
    const declared = new Set<string>();
    for (const el of this.querySelectorAll("sonic-bone")) {
      const attrs = Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
      const name = (attrs.name ?? "").trim();
      if (name && declared.has(name)) {
        errors.push(`os "${name}" déclaré deux fois`);
        continue;
      }
      if (name) declared.add(name);
      take(attrs, true); // même nom que le preset : modifie ses attributs
    }
    const configs: BoneConfig[] = [];
    for (const name of order) {
      const { config, error } = parseBone(byName.get(name) as BoneAttrs);
      if (error) errors.push(error);
      else if (config) configs.push(config);
    }
    if (configs.length > MAX_BONES) errors.push(`${configs.length} os : ${MAX_BONES} au plus`);
    const rig = new Rig(configs.map((c) => c.spec), { scale: this.scale });
    errors.push(...rig.errors);
    this.configs = configs.filter((c) => rig.has(c.spec.name));
    this.rig = rig;
    this.errors = errors;
    this.lastWorld.clear();
    this.driven.clear();
    this.lastSig = "";
    this.lastRestSig = "";
    this.lastFit = null;
    this.measuredRest = null;
    this.listen();
    this.schedule();
  }

  /* ------------------------------------------------------------ sources */

  private unlisten(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private listen(): void {
    this.unlisten();
    this.values.clear();
    this.pose = null;
    const src = (this.source ?? "").trim();
    if (src) {
      this.unsubs.push(
        listenDp(src, (v) => {
          this.pose = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
          this.schedule();
        }),
      );
    }
    for (const path of new Set(this.configs.flatMap((c) => [c.angleFrom, c.angleAddFrom]).filter(Boolean))) {
      this.unsubs.push(
        listenDp(path, (v) => {
          const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
          if (Number.isFinite(n)) this.values.set(path, n);
          else this.values.delete(path);
          this.schedule();
        }),
      );
    }
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.isConnected) this.solveAt(performance.now());
    });
  }

  /* ------------------------------------------------------------ calcul */

  private joint(name: string, now: number): Joint | null {
    const pose = this.pose;
    if (!pose || pose.present === 0) return null;
    const j = (pose.joints as Record<string, Partial<Joint>> | undefined)?.[name];
    if (!j || !Number.isFinite(j.x) || !Number.isFinite(j.y)) return null;
    const v = Number.isFinite(j.v) ? (j.v as number) : 1;
    if (v < (Number(this.minVisibility) || 0)) return null;
    if (this.smoother.smooth !== this.smooth) this.smoother = new Smoother(Number(this.smooth) || 0);
    return { x: this.smoother.apply(`${name}.x`, j.x as number, now), y: this.smoother.apply(`${name}.y`, j.y as number, now), v };
  }

  /** Moyenne d'un groupe d'articulations ; `null` si l'une manque. */
  private group(names: string[], now: number): { x: number; y: number } | null {
    let x = 0;
    let y = 0;
    for (const n of names) {
      const j = this.joint(n, now);
      if (!j) return null;
      x += j.x;
      y += j.y;
    }
    return { x: x / names.length, y: y / names.length };
  }

  /** Échelle donnée par la longueur mesurée de l'os `fit` ; `null` sans mesure exploitable. */
  private fitScale(now: number): number | null {
    const name = (this.fit ?? "").trim() === "true" ? "torse" : (this.fit ?? "").trim();
    if (!name) return null;
    const c = this.configs.find((b) => b.spec.name === name);
    if (!c || c.spec.length <= 0) return null;
    const width = Number(this.width) || 800;
    const height = Number(this.height) || 450;
    for (const [a, b] of c.aim) {
      const p = this.group(a, now);
      const q = p ? this.group(b, now) : null;
      if (p && q) {
        const d = Math.hypot((q.x - p.x) * width, (q.y - p.y) * height);
        if (d > 1) return Math.max(0.05, Math.min(20, d / c.spec.length));
      }
    }
    return null;
  }

  /**
   * Recalcule la pose et publie si elle a changé. `now` en ms. Public pour les tests.
   * Retourne `true` si une écriture a eu lieu.
   */
  solveAt(now: number): boolean {
    const rig = this.rig;
    if (!rig) return false;
    const hold = Math.max(0, Number(this.holdMs) || 0);
    const aspect = Number(this.aspect) > 0 ? Number(this.aspect) : 4 / 3;
    const drives: Record<string, BoneDrive> = {};
    const nowDriven = new Set<string>();
    const measuredNames = new Set<string>();
    let held = false;
    for (const c of this.configs) {
      const name = c.spec.name;
      let angle: number | null = null;
      for (const [a, b] of c.aim) {
        const p = this.group(a, now);
        const q = p ? this.group(b, now) : null;
        if (p && q) {
          angle = aimAngle(q.x - p.x, q.y - p.y, aspect);
          if (angle !== null) break;
        }
      }
      if (angle !== null) {
        this.lastWorld.set(name, { angle, t: now });
        drives[name] = { world: angle };
        nowDriven.add(name);
        measuredNames.add(name);
        continue;
      }
      const last = this.lastWorld.get(name);
      if (last && now - last.t <= hold) {
        drives[name] = { world: last.angle };
        nowDriven.add(name);
        measuredNames.add(name);
        held = true;
        continue;
      }
      this.lastWorld.delete(name);
      const v = c.angleFrom ? this.values.get(c.angleFrom) : undefined;
      if (v !== undefined) {
        drives[name] = { delta: v * c.angleScale + c.angleOffset };
        nowDriven.add(name);
      }
    }
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (held) this.holdTimer = setTimeout(() => this.isConnected && this.solveAt(performance.now()), hold + 20);

    const width = Number(this.width) || 800;
    const height = Number(this.height) || 450;
    let root = { x: Number.isFinite(this.x) ? this.x : width / 2, y: Number.isFinite(this.y) ? this.y : height * 0.55 };
    // Avec le preset humain branché sur une pose, la racine suit le milieu des hanches
    const rootExpr = (this.root ?? "").trim() || ((this.preset ?? "").trim().toLowerCase() === "humain" && (this.source ?? "").trim() ? "leftHip+rightHip" : "");
    const rootNames = rootExpr.split("+").map((n) => n.trim()).filter(Boolean);
    if (rootNames.length) {
      const p = this.group(rootNames, now);
      if (p) {
        root = { x: p.x * width, y: p.y * height };
        this.lastRoot = { ...root, t: now };
      } else if (this.lastRoot && now - this.lastRoot.t <= hold) root = { x: this.lastRoot.x, y: this.lastRoot.y };
    }

    let scale: number | undefined;
    if ((this.fit ?? "").trim()) {
      const f = this.fitScale(now);
      if (f !== null) this.lastFit = f;
      if (this.lastFit !== null) scale = this.lastFit;
    }
    let states = rig.solve(root, drives, scale);
    // Ajouts `angle-add-from` : rotations locales par-dessus la pose (mesurée ou de repos) ; un os qui tourne entraîne ses enfants.
    const adds = new Map<string, number>();
    for (const c of this.configs) {
      const v = c.angleAddFrom ? this.values.get(c.angleAddFrom) : undefined;
      if (v !== undefined) adds.set(c.spec.name, v * c.angleScale);
    }
    if (measuredNames.size > 0) this.measuredRest = states;
    if (adds.size > 0) {
      const base = new Map(states.map((st) => [st.name, st]));
      const drives2: Record<string, BoneDrive> = {};
      for (const spec of rig.specs) {
        const m = base.get(spec.name);
        if (!m) continue;
        const parent = spec.parent ? base.get(spec.parent) : null;
        const rel = wrap180(m.angle - (parent ? parent.angle : 0) - spec.angle);
        drives2[spec.name] = { delta: rel + (adds.get(spec.name) ?? 0) };
      }
      states = rig.solve(root, drives2, scale);
    }
    this.states = states;
    this.present = nowDriven.size > 0 ? 1 : 0;
    // Retour au repos d'un os qui n'est plus piloté : le rendu interpole
    const eased = [...this.driven].some((n) => !nowDriven.has(n));
    this.driven = nowDriven;
    return this.publish(states, eased, scale);
  }

  /**
   * Pose de repos (`<nodes-out>.rest`) : les os sans pilotage, racine à sa position fixe `x`,`y`. C'est la pose pour
   * laquelle l'image d'un maillage déformable est dessinée. Publiée seulement quand elle change.
   */
  private publishRest(out: string, scale?: number): void {
    const rig = this.rig;
    if (!rig) return;
    const width = Number(this.width) || 800;
    const height = Number(this.height) || 450;
    const root = { x: Number.isFinite(this.x) ? this.x : width / 2, y: Number.isFinite(this.y) ? this.y : height * 0.55 };
    const rest: Record<string, Record<string, number>> = {};
    const fromPose = (this.rest ?? "").trim() === "pose" && this.measuredRest ? this.measuredRest : null;
    for (const s of fromPose ?? rig.solve(root, {}, scale)) {
      rest[s.name] = { x: r2(s.x), y: r2(s.y), x2: r2(s.x2), y2: r2(s.y2), angle: r2(s.angle), length: r2(s.length) };
    }
    const sig = JSON.stringify(rest);
    if (sig === this.lastRestSig) return;
    this.lastRestSig = sig;
    set(`${out}.rest`, rest);
  }

  private publish(states: BoneState[], eased: boolean, scale?: number): boolean {
    const out = (this.nodesOut ?? "").trim();
    if (!out) return false;
    this.publishStatus(out);
    const nodes: Record<string, Record<string, unknown>> = {};
    const bones: Record<string, Record<string, number>> = {};
    const names = new Map(this.configs.map((c) => [c.spec.name, c.nodes]));
    for (const s of states) {
      const patch = { x: r2(s.x), y: r2(s.y), rz: r4(s.rz) };
      for (const n of names.get(s.name) ?? [s.name]) nodes[n] = { ...patch };
      bones[s.name] = { x: r2(s.x), y: r2(s.y), x2: r2(s.x2), y2: r2(s.y2), angle: r2(s.angle), rz: r4(s.rz), length: r2(s.length) };
    }
    this.publishRest(out, scale);
    const sig = JSON.stringify([nodes, this.present]);
    if (sig === this.lastSig) return false;
    this.lastSig = sig;
    if (eased) {
      const ms = Math.max(0, Number(this.easeMs) || 0);
      if (ms > 0) for (const n of Object.values(nodes)) n.ease = { ms, curve: "inOut" };
    }
    set(`${out}.nodes`, nodes);
    set(`${out}.bones`, bones);
    set(`${out}.present`, this.present);
    return true;
  }
}

export default SonicSkeleton;
