import * as THREE from "three";
import { customElement, property } from "lit/decorators.js";
import { DeviceElement, policyAllows, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { dispatch } from "../interactive";
import type { Sonic3dXrHost } from "./3d";
import { MagicWindow, requestOrientationPermission } from "./magic-window";

const tagName = "sonic-xr";

export type XrMode = "vr" | "ar";
type XrModeAttr = XrMode | "auto";
type Vec3 = [number, number, number];

export type XrInputInfo = {
  /** `left`, `right` ou `none`. */
  handedness: string;
  /** `tracked-pointer` (manette, main), `gaze`, `screen` (toucher en AR sur téléphone), `transient-pointer`. */
  mode: string;
  /** Main suivie (hand-tracking) plutôt qu'une manette. */
  hand: boolean;
};

export type XrState = DeviceBaseState & {
  /** Mode de la session en cours (ou demandée), `null` hors session. */
  mode: XrMode | null;
  /** Modes que l'appareil accepte (`isSessionSupported`), relus au montage ; `magic` : fenêtre magique (toujours possible). */
  modes: { vr: boolean; ar: boolean; magic: boolean };
  /** La fenêtre magique est ouverte (vue qui suit le téléphone, ou le glisser). */
  magic: boolean;
  /** Fenêtre magique : les capteurs d'orientation répondent (sinon : glisser pour tourner). */
  sensors: boolean;
  /** Une session immersive est affichée. */
  presenting: boolean;
  /** Espace de référence obtenu (`local-floor` ou `local`). */
  reference: string | null;
  /** AR avec hit-test : point du réel visé (coordonnées de l'espace de référence, mètres), `null` sinon. */
  hit: { x: number; y: number; z: number } | null;
  /** Sources d'entrée (manettes, mains, toucher). */
  inputs: XrInputInfo[];
};

/* Types WebXR minimaux (lib.dom ne les fournit pas tous). */
type XRPoseLike = { transform: { position: DOMPointReadOnly; orientation: DOMPointReadOnly; matrix: Float32Array } };
type XRFrameLike = {
  getPose(space: unknown, base: unknown): XRPoseLike | null | undefined;
  getHitTestResults?(source: unknown): { getPose(base: unknown): XRPoseLike | null | undefined }[];
};
type XRInputSourceLike = { handedness?: string; targetRayMode?: string; targetRaySpace?: unknown; hand?: unknown };
type XRSessionLike = EventTarget & {
  end(): Promise<void>;
  inputSources?: Iterable<XRInputSourceLike>;
  requestReferenceSpace(type: string): Promise<unknown>;
  requestHitTestSource?(opts: { space: unknown }): Promise<{ cancel(): void } | undefined>;
};
type XRSystemLike = {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: Record<string, unknown>): Promise<XRSessionLike>;
};

const FEATURES = new Set(["hand-tracking", "hit-test", "dom-overlay"]);
/** Hauteur des yeux supposée au-dessus du sol (`local-floor`), en mètres. */
const EYE_HEIGHT = 1.4;

function xrSystem(): XRSystemLike | null {
  const x = (typeof navigator !== "undefined" ? (navigator as Navigator & { xr?: XRSystemLike }).xr : undefined) ?? null;
  return x && typeof x.requestSession === "function" ? x : null;
}

/** `"0 1 -2"`, `"0,1,-2"` ou `"[0,1,-2]"` → `[0, 1, -2]` ; invalide : `null`. */
export function parseVec3(v: unknown): Vec3 | null {
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.replace(/[[\]]/g, " ").trim().split(/[\s,;]+/) : null;
  if (!parts || parts.length !== 3) return null;
  const n = parts.map((p) => Number(p));
  return n.every((x) => Number.isFinite(x)) ? (n as Vec3) : null;
}

/** Fonctionnalités demandées : liste blanche, les autres sont ignorées. */
export function parseFeatures(v: string): string[] {
  return [...new Set(v.split(/[\s,]+/).filter((f) => FEATURES.has(f)))];
}

/**
 * Position de la scène pour que le centre de sa boîte englobante soit devant l'utilisateur
 * à hauteur des yeux (`local-floor` : 1,4 m ; `local` : origine = la tête), puis `offset` ajouté.
 */
export function framePosition(bounds: { center: Vec3; min: Vec3; max: Vec3 } | null, scale: number, reference: string, offset: Vec3): Vec3 {
  const c = bounds?.center ?? [0, 0, 0];
  const size = bounds ? Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) : 1;
  const dist = 1 + (size * scale) / 2;
  const eye = reference === "local-floor" ? EYE_HEIGHT : 0;
  return [offset[0] - c[0] * scale, eye + offset[1] - c[1] * scale, -dist + offset[2] - c[2] * scale];
}

/** Échelle en AR : nombre imposé, ou `auto` = emprise au sol ramenée à 60 cm (jamais agrandie). */
export function arScaleFor(bounds: { min: Vec3; max: Vec3 } | null, attr: string, fallback = 1): number {
  const n = Number(attr);
  if (attr !== "auto" && attr !== "" && Number.isFinite(n) && n > 0) return n;
  if (attr !== "auto") return Math.max(1e-3, fallback);
  if (!bounds) return 1;
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 1e-3);
  return Math.min(1, 0.6 / span);
}

/** Position de la scène pour que le bas du centre de sa boîte soit posé sur `p`. */
export function placePosition(bounds: { center: Vec3; min: Vec3 } | null, scale: number, p: Vec3): Vec3 {
  const c = bounds?.center ?? [0, 0, 0];
  const minY = bounds?.min[1] ?? 0;
  return [p[0] - c[0] * scale, p[1] - minY * scale, p[2] - c[2] * scale];
}

/**
 * Réalité virtuelle et augmentée (WebXR) pour une scène `sonic-3d`, par `renderer.xr` de three.js.
 *
 * - `target` : id du `sonic-3d` (même arbre / shadow root, puis la page) ; `mode` : `vr` | `ar` | `auto`
 *   (AR si l'appareil l'accepte, sinon VR) ; `reference` : `local-floor` (défaut, repli `local`) ou `local`.
 * - `features` : `hand-tracking`, `hit-test` (AR), `dom-overlay` (avec `overlay` = id de l'élément affiché par-dessus).
 * - `for="bouton"` : le clic lance la session dans le geste ; `data-xr-mode="vr|ar|magic"` sur le bouton choisit le mode
 *   (plusieurs boutons pour un seul sonic-xr) ; `control` : `{enter, exit, toggle, place, magic}`.
 * - Fenêtre magique (`magic`, et repli du clic quand il n'y a ni casque ni AR, sauf `fallback="none"`) : la caméra se
 *   place au centre de la scène à hauteur des yeux (`eye`) et suit les capteurs du téléphone (iPhone compris) ;
 *   sans capteurs, glisser tourne la vue ; Échap ou un nouveau clic la referme.
 * - Placement : la scène est décalée (centre de sa boîte devant l'utilisateur à hauteur des yeux), `offset`
 *   `[x,y,z]` ajouté, `scale` ; en AR avec hit-test, `reticle` montre le point visé, `place` y pose la scène.
 * - Sélection des manettes : le même tap que `sonic-3d` (`pick` + action vers son `target`), et action
 *   `xr:select` vers `store` `{objectId, instance?, src?, point, hand, mode, hit}`.
 * - État `<id>State` : `{status, error, supported, allowed, active, mode, modes:{vr,ar}, presenting, reference, hit, inputs}`.
 *
 * Non testé sur casque ni téléphone (simulé dans les tests).
 */
@customElement(tagName)
export class SonicXr extends DeviceElement<XrState> {
  /** Id du `sonic-3d`. */
  @property({ type: String }) target = "";
  @property({ type: String }) mode: XrModeAttr = "auto";
  @property({ type: String }) reference = "local-floor";
  @property({ type: String }) features = "";
  /** Id de l'élément montré par-dessus la vue AR (`dom-overlay`). */
  @property({ type: String }) overlay = "";
  /** Décalage `[x, y, z]` en mètres ajouté au placement automatique. */
  @property({ type: String }) offset = "";
  @property({ type: Number }) scale = 1;
  /** AR + hit-test : anneau sur le point visé. */
  @property({ type: Boolean }) reticle = false;
  /** Id du `sonic-store` qui reçoit `xr:select`. */
  @property({ type: String }) store = "";
  /** Sans casque ni AR, le clic ouvre la fenêtre magique (`magic`, défaut) ou rien (`none`). */
  @property({ type: String }) fallback = "magic";
  /**
   * Taille en AR : `auto` (défaut) = maquette dont l'emprise au sol tient dans 60 cm, posée devant soi à hauteur
   * de table (une pièce à taille réelle boucherait toute la vue de la caméra) ; un nombre = échelle imposée.
   */
  @property({ type: String, attribute: "ar-scale" }) arScale = "auto";
  /** Noms d'objets masqués en AR (vue de dessus d'une maquette), séparés par des espaces (défaut `plafond`). */
  @property({ type: String, attribute: "ar-hide" }) arHide = "plafond";
  private arHidden: THREE.Object3D[] = [];
  /** Hauteur des yeux de la fenêtre magique (mètres, défaut 1,6 ; bornée par la hauteur de la scène). */
  @property({ type: Number }) eye = 1.6;

  private magicWin: MagicWindow | null = null;

  protected feature = "xr-spatial-tracking";
  protected state: XrState = {
    status: "idle",
    error: null,
    supported: false,
    allowed: "unknown",
    active: false,
    mode: null,
    modes: { vr: false, ar: false, magic: true },
    magic: false,
    sensors: false,
    presenting: false,
    reference: null,
    hit: null,
    inputs: [],
  };

  private session: XRSessionLike | null = null;
  private host: Sonic3dXrHost | null = null;
  private saved: { position: THREE.Vector3; scale: THREE.Vector3; background: THREE.Scene["background"]; clearAlpha: number } | null = null;
  private hitSource: { cancel(): void } | null = null;
  private reticleMesh: THREE.Mesh | null = null;
  private lastHit: Vec3 | null = null;
  private overlayEl: Element | null = null;
  private lastFrame: XRFrameLike | null = null;
  private refSpace: unknown = null;

  protected commands(): CommandMap {
    return {
      enter: (a) => (a.mode === "magic" ? this.startMagic() : this.enter(a)),
      exit: () => this.exit(),
      toggle: (a) => {
        if (this.session || this.magicWin) return this.exit();
        const immersive = this.state.modes.vr || this.state.modes.ar;
        if (a.mode === "magic" || (!immersive && a.mode === undefined && this.fallback !== "none")) return this.startMagic();
        return this.enter(a);
      },
      magic: () => (this.magicWin ? this.stopMagic() : this.startMagic()),
      place: () => this.place(),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.probe();
  }

  /** `data-xr-mode="vr|ar|magic"` sur le bouton cliqué choisit le mode (plusieurs boutons pour un seul sonic-xr). */
  protected clickArg(el: Element): CommandArg {
    const m = el.getAttribute("data-xr-mode");
    return m === "vr" || m === "ar" || m === "magic" ? { mode: m } : {};
  }

  /** Fenêtre magique : regarder autour de soi sans casque (capteurs du téléphone, ou glisser). */
  startMagic(): boolean {
    if (this.magicWin) return true;
    if (this.session) {
      this.patch({ status: "error", error: "une session immersive est déjà ouverte" });
      return false;
    }
    const host = this.targetHost();
    if (!host) {
      this.patch({ status: "error", error: "scène sonic-3d introuvable ou pas encore prête (target)" });
      return false;
    }
    // permission des capteurs (iOS) demandée dans le geste ; refusée : le glisser reste possible
    const perm = requestOrientationPermission();
    const win = new MagicWindow(host, host.renderer.domElement, Number(this.eye) || 1.6);
    this.magicWin = win;
    win.start();
    document.addEventListener("keydown", this.onKey);
    this.patch({ status: "ready", error: null, active: true, magic: true, sensors: false, mode: null });
    void perm.then(() => {
      // les capteurs répondent en quelques dizaines de ms quand ils existent
      setTimeout(() => {
        if (this.magicWin === win) this.patch({ sensors: win.sensors });
      }, 600);
    });
    this.emit("sonic-xr-change", this.getState());
    return true;
  }

  stopMagic(): boolean {
    const win = this.magicWin;
    if (!win) return true;
    this.magicWin = null;
    win.stop();
    document.removeEventListener("keydown", this.onKey);
    this.patch({ status: "idle", active: false, magic: false, sensors: false });
    this.emit("sonic-xr-change", this.getState());
    return true;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.stopMagic();
  };

  disconnectedCallback(): void {
    this.stopMagic();
    void this.exit();
    super.disconnectedCallback();
  }

  /** Relit `navigator.xr` et les modes acceptés. */
  async probe(): Promise<void> {
    const xr = xrSystem();
    const allowed = policyAllows(this.feature);
    if (!xr) {
      // sans WebXR, la fenêtre magique reste possible (sauf fallback="none")
      this.patch({ supported: false, allowed, ...(this.fallback === "none" ? { status: "unsupported" as const, error: "WebXR non disponible dans ce navigateur (HTTPS requis)" } : {}) });
      return;
    }
    const ask = async (m: string) => {
      try {
        return !!(await xr.isSessionSupported(m));
      } catch {
        return false;
      }
    };
    const [vr, ar] = await Promise.all([ask("immersive-vr"), ask("immersive-ar")]);
    const none = !vr && !ar;
    this.patch({
      supported: true,
      allowed,
      modes: { vr, ar, magic: true },
      ...(this.session || this.magicWin
        ? {}
        : none
          ? this.fallback === "none"
            ? { status: "unsupported" as const, error: "aucun casque ni mode AR disponible sur cet appareil" }
            : { status: "idle" as const, error: null }
          : { status: "idle" as const, error: null }),
    });
  }

  private wantedMode(arg: CommandArg): XrMode {
    const m = (arg.mode ?? this.mode) as string;
    if (m === "vr" || m === "ar") return m;
    return this.state.modes.ar ? "ar" : "vr";
  }

  private root(): Document | ShadowRoot {
    const r = this.isConnected ? this.getRootNode() : document;
    return r instanceof ShadowRoot || r instanceof Document ? r : document;
  }

  private byId(id: string): Element | null {
    const clean = id.trim().replace(/^#/, "");
    if (!/^[\w-]+$/.test(clean)) return null;
    const scopes = this.root() === document ? [document] : [this.root(), document];
    for (const s of scopes) {
      const el = s.getElementById(clean);
      if (el) return el;
    }
    return null;
  }

  private targetHost(): Sonic3dXrHost | null {
    const el = this.byId(this.target) as (Element & { getXrHost?: () => Sonic3dXrHost | null }) | null;
    return typeof el?.getXrHost === "function" ? el.getXrHost() : null;
  }

  /** Ouvre la session (dans le geste : `requestSession` est appelé avant toute attente). */
  enter(arg: CommandArg = {}): Promise<boolean> | boolean {
    if (this.session) return true;
    const xr = xrSystem();
    if (!xr) {
      this.patch({ status: "unsupported", error: "WebXR non disponible dans ce navigateur (HTTPS requis)", supported: false });
      return false;
    }
    const host = this.targetHost();
    if (!host) {
      this.patch({ status: "error", error: "scène sonic-3d introuvable ou pas encore prête (target)" });
      return false;
    }
    const mode = this.wantedMode(arg);
    const features = parseFeatures(this.features);
    const optional = ["local-floor", ...features.filter((f) => f !== "dom-overlay" && f !== "hit-test")];
    // en AR, viser une surface (table, sol) sert toujours : le toucher y pose la maquette
    if (mode === "ar") optional.push("hit-test");
    const init: Record<string, unknown> = { optionalFeatures: optional };
    if (mode === "ar" && features.includes("dom-overlay")) {
      const el = this.byId(this.overlay);
      if (el) {
        optional.push("dom-overlay");
        init.domOverlay = { root: el };
        this.overlayEl = el;
        // un toucher sur l'interface posée par-dessus n'est pas une sélection dans la scène
        el.addEventListener("beforexrselect", this.onBeforeSelect);
      }
    }
    this.patch({ status: "requesting", error: null, mode });
    let pending: Promise<XRSessionLike>;
    try {
      pending = xr.requestSession(mode === "ar" ? "immersive-ar" : "immersive-vr", init);
    } catch (e) {
      this.cleanupOverlay();
      this.fail(e, "réalité " + (mode === "ar" ? "augmentée" : "virtuelle"));
      return false;
    }
    return pending.then(
      (s) => this.start(s, host, mode, features),
      (e) => {
        this.cleanupOverlay();
        this.fail(e, "réalité " + (mode === "ar" ? "augmentée" : "virtuelle"));
        this.patch({ mode: null });
        return false;
      },
    );
  }

  private async start(session: XRSessionLike, host: Sonic3dXrHost, mode: XrMode, features: string[]): Promise<boolean> {
    this.session = session;
    this.host = host;
    try {
      let reference = this.reference === "local" ? "local" : "local-floor";
      try {
        await session.requestReferenceSpace(reference);
      } catch {
        reference = "local";
      }
      const { renderer, scene } = host;
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType(reference as XRReferenceSpaceType);
      this.saved = { position: scene.position.clone(), scale: scene.scale.clone(), background: scene.background, clearAlpha: renderer.getClearAlpha() };
      host.pause();
      await renderer.xr.setSession(session as unknown as XRSession);
      this.refSpace = renderer.xr.getReferenceSpace();
      if (mode === "ar") {
        scene.background = null;
        renderer.setClearAlpha(0);
      }
      const bounds = host.bounds();
      if (mode === "ar") {
        const s = arScaleFor(bounds, this.arScale, Number(this.scale) || 1);
        scene.scale.setScalar(s);
        // maquette posée 90 cm devant soi, à hauteur de table (local-floor : 75 cm du sol ; local : 60 cm sous les yeux)
        const off = parseVec3(this.offset) ?? [0, 0, 0];
        const base: Vec3 = [off[0], (reference === "local-floor" ? 0.75 : -0.6) + off[1], -0.9 + off[2]];
        scene.position.set(...placePosition(bounds, s, base));
        this.hideForAr(scene);
      } else {
        const s = Math.max(1e-3, Number(this.scale) || 1);
        scene.scale.setScalar(s);
        scene.position.set(...framePosition(bounds, s, reference, parseVec3(this.offset) ?? [0, 0, 0]));
      }
      scene.updateMatrixWorld(true);
      session.addEventListener("end", this.onEnd);
      session.addEventListener("select", this.onSelect as EventListener);
      session.addEventListener("inputsourceschange", this.onInputs);
      if (mode === "ar" && session.requestHitTestSource) {
        try {
          const viewer = await session.requestReferenceSpace("viewer");
          this.hitSource = (await session.requestHitTestSource({ space: viewer })) ?? null;
        } catch {
          this.hitSource = null;
        }
        // en AR, l'anneau montre où le toucher posera la maquette (reticle forcé)
        if (this.hitSource) this.addReticle();
      }
      renderer.setAnimationLoop(this.onXrFrame);
      this.patch({ status: "ready", error: null, active: true, presenting: true, mode, reference, inputs: this.readInputs() });
      this.emit("sonic-xr-change", this.getState());
      return true;
    } catch (e) {
      this.fail(e, "session XR");
      await this.teardown(true);
      return false;
    }
  }

  async exit(): Promise<boolean> {
    if (this.magicWin) return this.stopMagic();
    const s = this.session;
    if (!s) return true;
    try {
      await s.end();
    } catch {
      /* déjà terminée */
    }
    // `end` arrive par l'événement ; si le navigateur ne l'envoie pas, on range quand même
    if (this.session === s) await this.teardown(false);
    return true;
  }

  /** AR + hit-test : pose la scène au point visé (bas du centre de sa boîte). */
  place(): boolean {
    const host = this.host;
    if (!host || !this.lastHit) {
      this.patch({ error: "aucun point visé : viser une surface en réalité augmentée (features=\"hit-test\")" });
      return false;
    }
    const s = host.scene.scale.x;
    host.scene.position.set(...placePosition(host.bounds(), s, this.lastHit));
    host.scene.updateMatrixWorld(true);
    this.patch({ error: null });
    this.emit("sonic-xr-place", { x: this.lastHit[0], y: this.lastHit[1], z: this.lastHit[2] });
    return true;
  }

  private onEnd = () => void this.teardown(false);

  /** AR : masque les objets nommés dans `ar-hide` (plafond d'une maquette vue de dessus) ; rendus à la sortie. */
  private hideForAr(scene: THREE.Scene): void {
    const names = new Set(this.arHide.split(/[\s,]+/).filter(Boolean));
    if (!names.size) return;
    scene.traverse((o) => {
      if (names.has(o.name) && o.visible) {
        o.visible = false;
        this.arHidden.push(o);
      }
    });
  }

  private showHidden(): void {
    for (const o of this.arHidden) o.visible = true;
    this.arHidden = [];
  }

  private async teardown(failed: boolean): Promise<void> {
    const session = this.session;
    const host = this.host;
    this.session = null;
    this.host = null;
    this.showHidden();
    session?.removeEventListener("end", this.onEnd);
    session?.removeEventListener("select", this.onSelect as EventListener);
    session?.removeEventListener("inputsourceschange", this.onInputs);
    try {
      this.hitSource?.cancel();
    } catch {
      /* déjà annulée */
    }
    this.hitSource = null;
    this.lastHit = null;
    this.lastFrame = null;
    this.refSpace = null;
    this.cleanupOverlay();
    if (host) {
      const { renderer, scene } = host;
      renderer.setAnimationLoop(null);
      if (this.reticleMesh) {
        scene.remove(this.reticleMesh);
        this.reticleMesh.geometry.dispose();
        (this.reticleMesh.material as THREE.Material).dispose();
        this.reticleMesh = null;
      }
      if (this.saved) {
        scene.position.copy(this.saved.position);
        scene.scale.copy(this.saved.scale);
        scene.background = this.saved.background;
        renderer.setClearAlpha(this.saved.clearAlpha);
        scene.updateMatrixWorld(true);
      }
      renderer.xr.enabled = false;
      host.resume();
    }
    this.saved = null;
    this.patch(failed ? { active: false, presenting: false, hit: null, inputs: [], mode: null } : { status: "idle", error: null, active: false, presenting: false, hit: null, inputs: [], mode: null, reference: null });
    if (!failed) this.emit("sonic-xr-change", this.getState());
  }

  private cleanupOverlay() {
    this.overlayEl?.removeEventListener("beforexrselect", this.onBeforeSelect);
    this.overlayEl = null;
  }

  private onBeforeSelect = (e: Event) => e.preventDefault();

  private onXrFrame = (_t: number, frame?: XRFrameLike) => {
    this.lastFrame = frame ?? null;
    if (frame && this.hitSource && frame.getHitTestResults) this.trackHit(frame);
    this.host?.render();
  };

  private trackHit(frame: XRFrameLike) {
    const results = frame.getHitTestResults!(this.hitSource);
    const pose = results[0]?.getPose(this.refSpace);
    const host = this.host;
    if (!pose) {
      if (this.reticleMesh) this.reticleMesh.visible = false;
      if (this.lastHit) {
        this.lastHit = null;
        this.patch({ hit: null }, false);
      }
      return;
    }
    const p = pose.transform.position;
    this.lastHit = [p.x, p.y, p.z];
    if (this.reticleMesh && host) {
      // le réticule vit dans la scène décalée : point ramené dans ses coordonnées
      const local = host.scene.worldToLocal(new THREE.Vector3(p.x, p.y, p.z));
      this.reticleMesh.position.copy(local);
      this.reticleMesh.scale.setScalar(1 / host.scene.scale.x);
      this.reticleMesh.visible = true;
    }
    this.patch({ hit: { x: round(p.x), y: round(p.y), z: round(p.z) } }, false);
  }

  private addReticle() {
    const host = this.host;
    if (!host) return;
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
    );
    mesh.name = "sonic-xr-reticle";
    mesh.visible = false;
    mesh.renderOrder = 999;
    host.scene.add(mesh);
    this.reticleMesh = mesh;
  }

  private onInputs = () => this.patch({ inputs: this.readInputs() });

  private readInputs(): XrInputInfo[] {
    const list = this.session?.inputSources ? [...this.session.inputSources] : [];
    return list.map((s) => ({ handedness: s.handedness ?? "none", mode: s.targetRayMode ?? "tracked-pointer", hand: !!s.hand }));
  }

  /** `select` d'une manette, d'une main ou d'un toucher : rayon lancé dans la scène. */
  private onSelect = (e: Event & { inputSource?: XRInputSourceLike; frame?: XRFrameLike }) => {
    const host = this.host;
    if (!host) return;
    // AR sur téléphone : toucher l'écran pose la maquette sur la surface visée (anneau)
    if (this.state.mode === "ar" && this.lastHit && e.inputSource?.targetRayMode === "screen") {
      this.place();
      return;
    }
    const src = e.inputSource;
    const frame = e.frame ?? this.lastFrame;
    const space = src?.targetRaySpace;
    const pose = frame && space ? frame.getPose(space, this.refSpace) : null;
    let res: ReturnType<Sonic3dXrHost["pickRay"]> = null;
    if (pose) {
      const { position: o, orientation: q } = pose.transform;
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      host.scene.updateMatrixWorld(true);
      res = host.pickRay([o.x, o.y, o.z], [dir.x, dir.y, dir.z]);
    }
    // coordonnées de la scène (comme un tap à l'écran), pas celles de la pièce
    const local = res ? host.scene.worldToLocal(new THREE.Vector3(res.x, res.y, res.z)) : null;
    const hit = res && local ? { ...res, x: round(local.x), y: round(local.y), z: round(local.z) } : null;
    host.tap(hit);
    const payload = {
      objectId: hit?.objectId ?? null,
      ...(hit?.instance ? { instance: hit.instance, src: hit.src } : {}),
      point: hit ? [hit.x, hit.y, hit.z] : null,
      hand: src?.handedness ?? "none",
      mode: this.state.mode,
      hit: this.state.hit,
    };
    if (this.store) dispatch(this.store, { type: "xr:select", payload });
    this.emit("sonic-xr-select", payload);
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

declare global {
  interface HTMLElementTagNameMap {
    "sonic-xr": SonicXr;
  }
}
