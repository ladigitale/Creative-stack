import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { extractFeatures, type FeatureSource, type HandPick } from "../../shared/ml/features";
import { KnnClassifier } from "../../shared/ml/knn";
import { labelKey } from "./detector-state";
import { ParamOverlay, readParams, realChanges, snapshot, type ParamSpecs } from "./live-params";

const tagName = "sonic-example-classifier";

/** Clés de réglage lues dans `control` et `params` (nom de propriété → validation). */
export const CLASSIFIER_PARAMS: ParamSpecs = {
  k: { kind: "number", min: 1, max: 50, int: true },
  minConfidence: { kind: "number", min: 0, max: 1 },
  maxDistance: { kind: "number", min: 0, max: 1e6 },
  window: { kind: "number", min: 1, max: 100, int: true },
  samples: { kind: "number", min: 1, max: 1000, int: true },
  sampleMs: { kind: "number", min: 0, max: 10000, int: true },
  features: { kind: "enum", values: ["auto", "hand", "pose", "face", "embed"] },
  hand: { kind: "enum", values: ["any", "left", "right"] },
};

export type ClassifierOutput = {
  /** `idle` (rien reçu de la source), `ready`, `error` (voir `error`). */
  status: "idle" | "ready" | "error";
  /** Message d'erreur, `null` sans erreur (enregistrement arrêté : exemples d'une autre dimension). */
  error: string | null;
  /** `1` si la source montre quelque chose de classable (une main, un corps, un visage). */
  present: 0 | 1;
  /** Étiquette stable (vote des dernières prédictions) ; vide sans exemples, sans confiance ou trop loin des exemples. */
  label: string;
  /** Étiquette de la dernière image, sans lissage ni seuils. */
  raw: string;
  confidence: number;
  /** `scores.<étiquette>` : vote de chaque étiquette (somme 1) ; `match.<étiquette>` : 1 pour l'étiquette stable. */
  scores: Record<string, number>;
  match: Record<string, 0 | 1>;
  counts: Record<string, number>;
  total: number;
  /** Enregistrement en cours : étiquette et nombre d'exemples restants. */
  recording: 0 | 1;
  recordingLabel: string;
  samplesLeft: number;
  /** Réglages effectifs (attributs recouverts par `control` puis `params`). */
  settings: Record<string, unknown>;
};

const EMPTY: ClassifierOutput = {
  status: "idle", error: null, settings: {}, present: 0, label: "", raw: "", confidence: 0, scores: {}, match: {}, counts: {}, total: 0,
  recording: 0, recordingLabel: "", samplesLeft: 0,
};

/**
 * Apprend à reconnaître des poses de main, de corps ou des expressions de visage **à partir d'exemples** que
 * l'utilisateur enregistre (k plus proches voisins), sans modèle ni réseau. Branché sur la sortie d'un tracker
 * (`source="hand"`) ; les exemples sont invariants à la position et à l'échelle. Pilotage par un DataProvider
 * (`control`) : `label` (étiquette courante), `record` (compteur : une hausse enregistre `samples` exemples sous
 * `label`), `clear` (compteur : efface `label`, ou tout si `label` est vide), `clearAll` (compteur : efface tout).
 * Les exemples peuvent être gardés dans le navigateur (`storage`).
 */
@customElement(tagName)
export class SonicExampleClassifier extends LitElement {
  /** DataProvider de la sortie d'un tracker (son `outputProvider`, ou son id). */
  @property({ type: String })
  source = "";

  /** `auto` (d'après les clés : `hands`, `poses`, `blend`), `hand`, `pose`, `face`. */
  @property({ type: String })
  features: FeatureSource = "auto";

  /** Main utilisée : `any` (la première vue), `left` ou `right` (côté écran). */
  @property({ type: String })
  hand: HandPick = "any";

  /** DataProvider de pilotage : `{label, record, clear, clearAll}` et réglages (`k`, `minConfidence`… sous `params`). */
  @property({ type: String })
  control = "";

  /** DataProvider de réglages en direct, prioritaires : `k`, `minConfidence`, `maxDistance`, `window`, `samples`, `sampleMs`, `features`, `hand`. */
  @property({ type: String })
  params = "";

  /** DataProvider de sortie (défaut : l'id de l'élément). */
  @property({ type: String })
  outputProvider = "";

  /** Nombre de voisins du vote. */
  @property({ type: Number })
  k = 3;

  /** Nombre d'exemples pris à chaque enregistrement. */
  @property({ type: Number })
  samples = 20;

  /** Écart minimal entre deux exemples d'un même enregistrement (ms). */
  @property({ type: Number, attribute: "sample-ms" })
  sampleMs = 50;

  /** Nombre de dernières prédictions votant pour l'étiquette stable. */
  @property({ type: Number })
  window = 5;

  /** Confiance minimale (0..1) pour afficher une étiquette. */
  @property({ type: Number, attribute: "min-confidence" })
  minConfidence = 0.6;

  /** Distance maximale au plus proche exemple (0 : sans limite) : au-delà, aucune étiquette. */
  @property({ type: Number, attribute: "max-distance" })
  maxDistance = 0;

  /** Clé de mémoire locale (localStorage) des exemples. Vide : pas de sauvegarde. */
  @property({ type: String })
  storage = "";

  private knn = new KnnClassifier(3);
  private recent: Array<{ label: string; confidence: number }> = [];
  private recLabel = "";
  private left = 0;
  private lastSample = -Infinity;
  private lastOutput: ClassifierOutput = { ...EMPTY };
  private unlistenSource: (() => void) | null = null;
  private unlistenControl: (() => void) | null = null;
  private unlistenParams: (() => void) | null = null;
  private overlay = new ParamOverlay(this);
  private fromControl: Record<string, unknown> = {};
  private fromParams: Record<string, unknown> = {};
  private received = false;
  private error: string | null = null;
  private seen: { record?: number; clear?: number; clearAll?: number } = {};
  private ctlLabel = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    this.loadStored();
    this.listenSource();
    this.listenControl();
    this.listenParams();
    this.publish();
  }

  disconnectedCallback(): void {
    this.unlistenSource?.();
    this.unlistenControl?.();
    this.unlistenParams?.();
    this.unlistenSource = this.unlistenControl = this.unlistenParams = null;
    super.disconnectedCallback();
  }

  protected willUpdate(changed: Map<PropertyKey, unknown>): void {
    super.willUpdate(changed);
    this.overlay.guard(changed);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (!this.isConnected) return;
    if (changed.has("source")) this.listenSource();
    if (changed.has("control")) this.listenControl();
    if (changed.has("params")) this.listenParams();
    if (changed.has("storage")) this.loadStored();
    if (realChanges(this, changed).some((k) => k in CLASSIFIER_PARAMS)) this.publish();
  }

  /* ---------------- API ---------------- */

  getOutput(): ClassifierOutput {
    return this.lastOutput;
  }

  /** Lance un enregistrement sous `label` (comme une hausse de `control.record`). */
  record(label: string): void {
    if (!label.trim()) return;
    this.error = null;
    this.recLabel = label.trim();
    this.left = Math.max(1, Math.round(this.samples) || 20);
    this.lastSample = -Infinity;
    this.publish();
  }

  /** Efface les exemples d'une étiquette, ou tous. */
  clear(label?: string): void {
    this.knn.clear(label || undefined);
    this.recent = [];
    this.error = null;
    this.save();
    this.publish();
  }

  /** Traite une sortie de tracker (public pour les tests) ; `now` en ms. */
  ingest(data: unknown, now: number): ClassifierOutput {
    this.knn.k = Math.max(1, Math.round(this.k) || 3);
    this.received = true;
    const vec = extractFeatures(data, this.features, this.hand);
    if (!vec) {
      const counts = this.knn.counts();
      this.recent = [];
      this.lastOutput = { ...EMPTY, ...this.meta(), counts, total: this.knn.size, recording: this.left > 0 ? 1 : 0, recordingLabel: this.left > 0 ? this.recLabel : "", samplesLeft: this.left };
      this.emit();
      return this.lastOutput;
    }

    if (this.left > 0 && now - this.lastSample >= Math.max(0, this.sampleMs)) {
      if (this.knn.add(this.recLabel, vec)) {
        this.left--;
        this.lastSample = now;
        if (this.left === 0) this.save();
      } else {
        // Dimension incompatible avec les exemples existants (autre type de source) : arrêt de l'enregistrement.
        this.left = 0;
        this.error = "exemples d'une autre dimension (autre type de source) : enregistrement arrêté";
      }
    }

    const counts = this.knn.counts(); // après l'éventuel nouvel exemple
    const pred = this.knn.classify(vec);
    let raw = "";
    let confidence = 0;
    let scores: Record<string, number> = {};
    if (pred) {
      raw = pred.label;
      confidence = pred.confidence;
      scores = Object.fromEntries(Object.entries(pred.scores).map(([l, v]) => [labelKey(l), v]));
      const tooFar = this.maxDistance > 0 && pred.nearest > this.maxDistance;
      this.recent.push({ label: tooFar || pred.confidence < this.minConfidence ? "" : pred.label, confidence: pred.confidence });
    } else {
      this.recent.push({ label: "", confidence: 0 });
    }
    const win = Math.max(1, Math.round(this.window) || 5);
    if (this.recent.length > win) this.recent.splice(0, this.recent.length - win);

    // Étiquette stable : vote majoritaire de la fenêtre (vide comprise).
    const votes = new Map<string, number>();
    for (const r of this.recent) votes.set(r.label, (votes.get(r.label) ?? 0) + 1);
    const stable = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const match: Record<string, 0 | 1> = {};
    for (const l of Object.keys(counts)) match[labelKey(l)] = l === stable && stable !== "" ? 1 : 0;
    this.lastOutput = {
      ...this.meta(),
      present: 1,
      label: stable,
      raw,
      confidence,
      scores,
      match,
      counts,
      total: this.knn.size,
      recording: this.left > 0 ? 1 : 0,
      recordingLabel: this.left > 0 ? this.recLabel : "",
      samplesLeft: this.left,
    };
    this.emit();
    return this.lastOutput;
  }

  /* ---------------- interne ---------------- */

  private listenSource(): void {
    this.unlistenSource?.();
    this.unlistenSource = null;
    const path = this.source.trim();
    if (!path) return;
    this.unlistenSource = listenDp(path, (v) => void this.ingest(v, performance.now()));
  }

  private listenControl(): void {
    this.unlistenControl?.();
    this.unlistenControl = null;
    this.seen = {};
    this.fromControl = {};
    const path = this.control.trim();
    if (!path) {
      this.applySettings();
      return;
    }
    this.unlistenControl = listenDp(path, (v) => this.onControl(v));
    try {
      this.onControl(dp(path).get()); // valeur de départ : sert de référence aux compteurs
    } catch {
      /* ignoré */
    }
  }

  private listenParams(): void {
    this.unlistenParams?.();
    this.unlistenParams = null;
    this.fromParams = {};
    const path = this.params.trim();
    if (path) this.unlistenParams = listenDp(path, (v) => {
      this.fromParams = readParams(CLASSIFIER_PARAMS, v);
      this.applySettings();
    });
    else this.applySettings();
  }

  private applySettings(): void {
    this.overlay.set({ ...this.fromControl, ...this.fromParams });
  }

  /** Statut, erreur et réglages effectifs. */
  private meta(): Pick<ClassifierOutput, "status" | "error" | "settings"> {
    return { status: this.error ? "error" : this.received ? "ready" : "idle", error: this.error, settings: snapshot(this, CLASSIFIER_PARAMS) };
  }

  private onControl(v: unknown): void {
    if (!v || typeof v !== "object") return;
    this.fromControl = readParams(CLASSIFIER_PARAMS, v);
    this.applySettings();
    const c = v as { label?: unknown; record?: unknown; clear?: unknown; clearAll?: unknown };
    if (typeof c.label === "string") this.ctlLabel = c.label;
    const rose = (key: "record" | "clear" | "clearAll") => {
      const n = typeof c[key] === "number" ? (c[key] as number) : undefined;
      if (n === undefined) return false;
      const prev = this.seen[key];
      this.seen[key] = n;
      return prev !== undefined && n > prev; // la première valeur vue sert de référence
    };
    if (rose("clearAll")) this.clear();
    if (rose("clear")) this.clear(this.ctlLabel.trim() || undefined);
    if (rose("record")) this.record(this.ctlLabel);
  }

  private emit(): void {
    const out = (this.outputProvider || this.id).trim();
    if (out) set(out, this.lastOutput);
  }

  private publish(): void {
    this.lastOutput = { ...this.lastOutput, ...this.meta(), counts: this.knn.counts(), total: this.knn.size, recording: this.left > 0 ? 1 : 0, recordingLabel: this.left > 0 ? this.recLabel : "", samplesLeft: this.left };
    this.emit();
  }

  private storageKey(): string | null {
    const k = this.storage.trim();
    return k ? `concorde-ml-examples:${k}` : null;
  }

  private loadStored(): void {
    const key = this.storageKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (raw) this.knn.load(JSON.parse(raw));
    } catch {
      /* mémoire locale indisponible ou corrompue : on repart de zéro */
    }
  }

  private save(): void {
    const key = this.storageKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(this.knn.serialize()));
    } catch {
      /* quota / mode privé : les exemples restent valables pour la session */
    }
  }

  render() {
    return null;
  }
}

export default SonicExampleClassifier;
