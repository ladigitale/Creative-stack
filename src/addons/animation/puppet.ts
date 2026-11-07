import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { PuppetRig, assignOwners, type BoneFrameOut, extractParts, measureArmature, measureBones, type ArmatureBone, type Joints, type Part } from "../../shared/puppet";

const tagName = "sonic-puppet";
const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const r4 = (n: number) => Math.round(n * 10000) / 10000 + 0;

type FrameSource = HTMLElement & { getFrameCanvas?: () => HTMLCanvasElement | null; frameSeq?: number };

export type PuppetPhase = "idle" | "waiting" | "ready" | "error";

/**
 * Pantin : découpe la personne d'une photo en pièces rigides montées sur ses articulations MESURÉES par un
 * `sonic-pose-tracker` (têtes, tronc, bras, avant-bras, mains, cuisses, mollets, pieds : seules les parties vues
 * existent), puis les fait suivre une animation. Il ne dessine rien : il publie
 * - `<nodes-out>.sprites` : la liste de sprites (image de chaque pièce, `pivot` sur l'articulation) que lit `sonic-2d sprites="…"` ;
 * - `<nodes-out>.nodes` : format `nodes` partagé (un nœud par pièce : `x`, `y` de l'articulation, `rz` par rapport au repos) ;
 * - `<nodes-out>.status` : `{ phase, error, parts, missing, body }`.
 *
 * À la prise de vue (`capture` passe à vrai) il attend que la pose corresponde à l'image figée, mesure, découpe puis
 * publie ; quand `capture` repasse à faux il efface tout. L'animation arrive par `drive` : un DataProvider de nœuds
 * (par exemple la sortie `nodes-out` d'une `sonic-timeline`) dont la clé `<drive-prefix><os>` porte `rz` (radians,
 * ajouté à la pose de la personne ; les enfants suivent) ; la clé du bassin peut aussi porter `x`, `y` (unités de scène).
 */
@customElement(tagName)
export class SonicPuppet extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** `#id` de la source d'images de la personne découpée (`sonic-mask-replace effect="cutout"`) à la taille de l'image analysée. */
  @property({ type: String })
  source = "";

  /** DataProvider de la sortie d'un `sonic-pose-tracker` (clés `joints`, `present`, `frameSeq`) analysant la même image. */
  @property({ type: String })
  pose = "";

  /** `#id` de la source figée que lisent le tracker et le découpage (`sonic-frame-sync`) : sa `frameSeq` doit égaler celle de la pose. */
  @property({ type: String })
  frame = "";

  /** Chemin DataProvider d'un booléen : vrai = prendre la photo (mesurer et découper), faux = effacer. */
  @property({ type: String })
  capture = "";

  /** DataProvider qui reçoit `sprites`, `nodes` et `status`. */
  @property({ type: String, attribute: "nodes-out" })
  nodesOut = "";

  /** Chemin DataProvider des nœuds d'animation : `<drive>.<prefix><os>.rz` (radians). */
  @property({ type: String })
  drive = "";

  /** Préfixe des clés de `drive` ; les `-` du nom d'os y deviennent `_` (`bras-gauche` → `d_bras_gauche`). */
  @property({ type: String, attribute: "drive-prefix" })
  drivePrefix = "";

  /** Taille de la scène (unités) ; l'image de la personne y est placée centrée, proportions gardées. */
  @property({ type: Number })
  width = 800;
  @property({ type: Number })
  height = 600;

  /** Calque des sprites publiés (`sonic-2d layers`). */
  @property({ type: String })
  layer = "";

  /**
   * Armature libre (JSON : liste d'os `{name, parent, from, to, extend, radius, z, cap, sprite}`) à la place du préréglage
   * personne. `from` / `to` nomment des points de `pose.joints` ; `radius` s'exprime en `unit`. Voir animation.md.
   */
  @property({ type: String })
  armature = "";

  /** Longueur de référence de l'armature libre : « pointA,pointB » (leur distance) ou un nombre de pixels. */
  @property({ type: String })
  unit = "";

  /**
   * `skin` (défaut) : publie la pose de repos MESURÉE (`<nodes-out>.rest`) et la pose courante (`.bones`, `.present`) au format
   * de `sonic-skeleton` ; une image `sonic-sprite shape="mesh"` (de la personne découpée) se déforme alors par poids entre
   * les os : aucune coupure, aucun trou aux articulations. `pieces` : découpe en pièces rigides (`.sprites`).
   */
  @property({ type: String })
  mode = "skin";

  /** Visibilité minimale d'une articulation (0..1). */
  @property({ type: Number, attribute: "min-visibility" })
  minVisibility = 0.5;

  /** Attente minimale après la prise (ms) : laisse le découpage et le tracker rattraper l'image figée. */
  @property({ type: Number, attribute: "settle-ms" })
  settleMs = 350;

  /** Attente maximale (ms) d'une pose alignée sur l'image ; ensuite on utilise la dernière. */
  @property({ type: Number, attribute: "timeout-ms" })
  timeoutMs = 2500;

  private radii = new Map<string, number>();
  private poseValue: Record<string, unknown> | null = null;
  private driveValue: Record<string, Record<string, unknown>> | null = null;
  private on = false;
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: Array<() => void> = [];
  private rig: PuppetRig | null = null;
  private fitScale = 1;
  private offset = { x: 0, y: 0 };
  private queued = false;
  private phase: PuppetPhase = "idle";
  private partNames: string[] = [];

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
  }

  disconnectedCallback(): void {
    this.unlisten();
    this.stopTimer();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("pose") || changed.has("capture") || changed.has("drive")) this.listen();
    else if (changed.size) this.scheduleNodes();
  }

  /** Phase courante (pour les tests et l'atelier). */
  getPhase(): PuppetPhase {
    return this.phase;
  }

  /* ------------------------------------------------------------ sources */

  private unlisten(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private listen(): void {
    this.unlisten();
    const pose = (this.pose ?? "").trim();
    if (pose) {
      this.unsubs.push(
        listenDp(pose, (v) => {
          this.poseValue = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
        }),
      );
    }
    const drive = (this.drive ?? "").trim();
    if (drive) {
      this.unsubs.push(
        listenDp(drive, (v) => {
          this.driveValue = v && typeof v === "object" ? (v as Record<string, Record<string, unknown>>) : null;
          this.scheduleNodes();
        }),
      );
    }
    const capture = (this.capture ?? "").trim();
    if (capture) {
      this.unsubs.push(
        listenDp(capture, (v) => {
          const next = v === true || v === "true" || v === 1 || v === "1";
          if (next === this.on) return;
          this.on = next;
          if (next) this.begin();
          else this.clear();
        }),
      );
    }
  }

  private lookup(ref: string): FrameSource | null {
    const id = ref.trim().replace(/^#/, "");
    if (!id) return null;
    const root = this.getRootNode() as Document | ShadowRoot;
    return ((root.getElementById?.(id) ?? document.getElementById(id)) as FrameSource | null) ?? null;
  }

  /* ------------------------------------------------------------ prise de vue */

  private begin(): void {
    this.stopTimer();
    this.startedAt = performance.now();
    this.setPhase("waiting");
    this.timer = setInterval(() => this.poll(), 60);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private aligned(): boolean {
    const frame = (this.frame ?? "").trim() ? this.lookup(this.frame) : null;
    if (!frame || typeof frame.frameSeq !== "number") return true;
    return this.poseValue?.frameSeq === frame.frameSeq;
  }

  /** Public pour les tests : un tour d'attente de la prise de vue. */
  poll(now = performance.now()): void {
    if (!this.on || this.phase !== "waiting") return;
    const elapsed = now - this.startedAt;
    const ready = elapsed >= Math.max(0, Number(this.settleMs) || 0) && !!this.poseValue && this.poseValue.present !== 0 && this.aligned();
    if (!ready && elapsed < Math.max(0, Number(this.timeoutMs) || 0)) return;
    this.stopTimer();
    this.measure();
  }

  /** Pixels RGBA de la source de la personne. Surchargeable (tests). */
  protected readPixels(): { data: ArrayLike<number>; width: number; height: number } | null {
    const src = (this.source ?? "").trim() ? this.lookup(this.source) : null;
    const canvas = src?.getFrameCanvas?.();
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: img.width, height: img.height };
  }

  /** Image PNG (data URL) d'une pièce. Surchargeable (tests). */
  protected encode(part: Part): string {
    const c = document.createElement("canvas");
    c.width = part.w;
    c.height = part.h;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.putImageData(new ImageData(part.data as Uint8ClampedArray<ArrayBuffer>, part.w, part.h), 0, 0);
    return c.toDataURL("image/png");
  }

  private fail(error: string): void {
    this.rig = null;
    this.partNames = [];
    const out = (this.nodesOut ?? "").trim();
    if (out) {
      set(`${out}.sprites`, []);
      set(`${out}.nodes`, {});
    }
    this.setPhase("error", { error });
  }

  private parseArmature(): ArmatureBone[] | null {
    try {
      const v = JSON.parse(this.armature);
      if (!Array.isArray(v) || v.length > 64) return null;
      const ok = v.every((b) => b && typeof b === "object" && typeof b.name === "string" && b.name && typeof b.from === "string");
      return ok ? (v as ArmatureBone[]) : null;
    } catch {
      return null;
    }
  }

  private parseUnit(): [string, string] | number | null {
    const t = (this.unit ?? "").trim();
    if (!t) return null;
    if (Number.isFinite(Number(t))) return Number(t);
    const [a, b] = t.split(",").map((x) => x.trim());
    return a && b ? [a, b] : null;
  }

  /** Mesure la pose, découpe la personne en pièces, publie sprites et nœuds de repos. Public pour les tests. */
  measure(): boolean {
    const px = this.readPixels();
    if (!px) {
      this.fail("source");
      return false;
    }
    const joints = (this.poseValue?.joints ?? null) as Joints | null;
    if (!joints || this.poseValue?.present === 0) {
      this.fail("pose");
      return false;
    }
    const minVisibility = Number(this.minVisibility) || 0.5;
    let m;
    if ((this.armature ?? "").trim()) {
      const spec = this.parseArmature();
      if (!spec) {
        this.fail("armature");
        return false;
      }
      m = measureArmature(spec, joints, px.width, px.height, { minVisibility, unit: this.parseUnit() ?? ["", ""] });
    } else m = measureBones(joints, px.width, px.height, { minVisibility });
    if (!m) {
      this.fail("corps");
      return false;
    }
    const W = Number(this.width) || 800;
    const H = Number(this.height) || 600;
    const s = Math.min(W / px.width, H / px.height);
    this.fitScale = s;
    this.offset = { x: (W - px.width * s) / 2, y: (H - px.height * s) / 2 };
    this.rig = new PuppetRig(m.bones);
    this.radii = new Map(m.bones.map((b) => [b.name, b.radius * s]));
    if (this.skinMode()) {
      this.partNames = m.bones.filter((b) => b.sprite).map((b) => b.name);
      const outSkin = (this.nodesOut ?? "").trim();
      if (outSkin) {
        set(`${outSkin}.sprites`, []);
        set(`${outSkin}.rest`, this.sceneFrames(this.rig.frames(), true));
      }
      this.publishNodes();
      this.setPhase("ready", { parts: this.partNames, missing: m.missing, body: r2(m.body) });
      return true;
    }
    const owners = assignOwners(px.data, px.width, px.height, m.bones);
    const parts = extractParts(px.data, px.width, px.height, m.bones, owners);
    if (!parts.length) {
      this.rig = null;
      this.fail("silhouette");
      return false;
    }
    this.partNames = parts.map((p) => p.name);
    const layer = (this.layer ?? "").trim();
    const sprites = parts.map((p) => ({
      name: p.name,
      shape: "image",
      src: this.encode(p),
      w: r2(p.w * s),
      h: r2(p.h * s),
      pivot: `${r4(p.pivot.x / p.w)},${r4(p.pivot.y / p.h)}`,
      z: p.z,
      ...(layer ? { layer } : {}),
    }));
    const out = (this.nodesOut ?? "").trim();
    if (out) set(`${out}.sprites`, sprites);
    this.publishNodes();
    this.setPhase("ready", { parts: this.partNames, missing: m.missing, body: r2(m.body) });
    return true;
  }

  private skinMode(): boolean {
    return (this.mode ?? "skin").trim() !== "pieces";
  }

  /** Os en unités de la scène (image contenue dans `width × height`) ; `radius` : demi-largeur d'appartenance, pour le repos. */
  private sceneFrames(frames: Record<string, BoneFrameOut>, withRadius: boolean): Record<string, Record<string, number>> {
    const k = this.fitScale;
    const out: Record<string, Record<string, number>> = {};
    for (const name of this.partNames) {
      const f = frames[name];
      if (!f || !(f.length > 0)) continue;
      out[name] = {
        x: r2(this.offset.x + f.x * k),
        y: r2(this.offset.y + f.y * k),
        x2: r2(this.offset.x + f.x2 * k),
        y2: r2(this.offset.y + f.y2 * k),
        angle: r2(f.angle),
        length: r2(f.length * k),
        ...(withRadius ? { radius: r2(this.radii.get(name) ?? 0) } : { rz: r4(f.rz) }),
      };
    }
    return out;
  }

  private clear(): void {
    this.stopTimer();
    this.rig = null;
    this.partNames = [];
    const out = (this.nodesOut ?? "").trim();
    if (out) {
      set(`${out}.sprites`, []);
      set(`${out}.nodes`, {});
      set(`${out}.rest`, {});
      set(`${out}.bones`, {});
      set(`${out}.present`, 0);
    }
    this.setPhase("idle");
  }

  private setPhase(phase: PuppetPhase, extra: Record<string, unknown> = {}): void {
    this.phase = phase;
    const out = (this.nodesOut ?? "").trim();
    if (out) set(`${out}.status`, { phase, error: "", parts: [], missing: [], body: 0, ...extra });
  }

  /* ------------------------------------------------------------ animation */

  private scheduleNodes(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.isConnected) this.publishNodes();
    });
  }

  private key(bone: string): string {
    return `${(this.drivePrefix ?? "").trim()}${bone.replace(/-/g, "_")}`;
  }

  /** Recalcule et publie les nœuds ; public pour les tests. */
  publishNodes(): void {
    const out = (this.nodesOut ?? "").trim();
    if (!out || !this.rig) return;
    const add: Record<string, number> = {};
    const drive = this.driveValue;
    for (const name of ["bassin", ...this.partNames]) {
      const v = drive?.[this.key(name)]?.rz;
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
      if (Number.isFinite(n)) add[name] = n;
    }
    const base = drive?.[this.key("bassin")];
    const shift = {
      x: (Number(base?.x) || 0) / this.fitScale,
      y: (Number(base?.y) || 0) / this.fitScale,
    };
    const frames = this.rig.frames(add, shift);
    const nodes: Record<string, { x: number; y: number; rz: number }> = {};
    for (const name of this.partNames) {
      const n = frames[name];
      if (n) nodes[name] = { x: r2(this.offset.x + n.x * this.fitScale), y: r2(this.offset.y + n.y * this.fitScale), rz: r4(n.rz) };
    }
    set(`${out}.nodes`, nodes);
    if (this.skinMode()) {
      set(`${out}.bones`, this.sceneFrames(frames, false));
      set(`${out}.present`, 1);
    }
  }
}

export default SonicPuppet;
