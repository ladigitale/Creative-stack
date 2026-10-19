/**
 * Réglages d'une piste vidéo (zoom, torche, focus, exposition, balance des blancs…).
 *
 * Deux contrats, publiés par `sonic-camera` dans deux DataProviders :
 *  - `CameraCapabilities` (lecture seule) : ce que cette caméra sait faire, dans une forme
 *    qui sert aussi de schéma de contrôles (type, bornes, pas, valeurs, libellé en français) ;
 *  - `CameraAdjustState` (lecture) + DP d'entrée `adjust` (écriture) : valeurs demandées
 *    (`desired`) et valeurs réellement appliquées (`applied`, relues sur la piste).
 *
 * Le navigateur arrondit, ajuste ou refuse : on lit toujours `applied`, jamais `desired`.
 * Aucune évaluation de code : toutes les clés acceptées sont dans `CONTROLS`.
 */

export type ControlKind = "range" | "enum" | "boolean";

type ControlDef = { kind: ControlKind; label: string; unit?: string; ptz?: boolean };

/**
 * Réglages connus. L'ordre compte : les modes passent avant les valeurs
 * (`focusDistance` n'a d'effet qu'en `focusMode: "manual"`, etc.).
 */
export const CONTROLS = {
  focusMode: { kind: "enum", label: "Mode de mise au point" },
  exposureMode: { kind: "enum", label: "Mode d'exposition" },
  whiteBalanceMode: { kind: "enum", label: "Mode de balance des blancs" },
  zoom: { kind: "range", label: "Zoom", unit: "×" },
  pan: { kind: "range", label: "Panoramique", ptz: true },
  tilt: { kind: "range", label: "Inclinaison", ptz: true },
  focusDistance: { kind: "range", label: "Distance de mise au point", unit: "m" },
  exposureCompensation: { kind: "range", label: "Compensation d'exposition", unit: "EV" },
  // Unité du navigateur (Chrome : 100 µs), donc pas d'unité affichée.
  exposureTime: { kind: "range", label: "Temps d'exposition" },
  iso: { kind: "range", label: "ISO" },
  colorTemperature: { kind: "range", label: "Température de couleur", unit: "K" },
  brightness: { kind: "range", label: "Luminosité" },
  contrast: { kind: "range", label: "Contraste" },
  saturation: { kind: "range", label: "Saturation" },
  sharpness: { kind: "range", label: "Netteté" },
  torch: { kind: "boolean", label: "Torche" },
} as const satisfies Record<string, ControlDef>;

export type ControlKey = keyof typeof CONTROLS;
export type ControlValue = number | string | boolean;

export const CONTROL_KEYS = Object.keys(CONTROLS) as ControlKey[];

export type ControlDescriptor = {
  key: ControlKey;
  kind: ControlKind;
  label: string;
  unit?: string;
  /** `range` : bornes et pas fournis par la caméra. */
  min?: number;
  max?: number;
  step?: number;
  /** `enum` : valeurs acceptées (`continuous`, `manual`, `single-shot`, `none`…). */
  values?: string[];
  /** Valeur actuelle de la piste (relue, pas demandée). */
  value?: ControlValue;
};

export type CameraCapabilities = {
  /** `unavailable` tant que la caméra n'est pas ouverte (les capacités n'existent qu'après getUserMedia). */
  status: "unavailable" | "ready";
  deviceId: string | null;
  /** Panoramique / inclinaison / zoom demandés à l'ouverture (attribut `ptz`) et permission accordée. */
  ptz: boolean;
  /** Réglages pris en charge, par clé. */
  controls: Partial<Record<ControlKey, ControlDescriptor>>;
  /** Les mêmes, en tableau : pratique pour une liste SDUI ou un agent. */
  list: ControlDescriptor[];
  /** Réglages connus mais absents sur cet appareil / ce navigateur. */
  unsupported: ControlKey[];
};

export type CameraAdjustState = {
  desired: Partial<Record<ControlKey, ControlValue>>;
  applied: Partial<Record<ControlKey, ControlValue>>;
  /** Clés en cours d'application. */
  pending: ControlKey[];
  /** Message lisible par clé : refus, non pris en charge, valeur invalide. */
  errors: Partial<Record<ControlKey, string>>;
};

export function emptyCapabilities(deviceId: string | null = null): CameraCapabilities {
  return { status: "unavailable", deviceId, ptz: false, controls: {}, list: [], unsupported: [] };
}

export function emptyAdjustState(): CameraAdjustState {
  return { desired: {}, applied: {}, pending: [], errors: {} };
}

/* ------------------------------------------------------------------ */
/* Lecture des capacités                                               */
/* ------------------------------------------------------------------ */

type RawRange = { min?: number; max?: number; step?: number };

function isRange(v: unknown): v is RawRange {
  return !!v && typeof v === "object" && !Array.isArray(v) && (typeof (v as RawRange).min === "number" || typeof (v as RawRange).max === "number");
}

/** Valeur lisible d'un réglage dans `getSettings()` (nombre, texte ou booléen), sinon undefined. */
function readSetting(settings: Record<string, unknown>, key: string): ControlValue | undefined {
  const v = settings[key];
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
}

/**
 * Transforme `track.getCapabilities()` + `track.getSettings()` en `CameraCapabilities`.
 * Pur : testable sans navigateur. `ptz` indique si la permission pan/tilt/zoom a été demandée ;
 * sans elle, pan et tilt sont retirés (Chrome peut les annoncer sans les accorder).
 */
export function describeCapabilities(
  rawCaps: Record<string, unknown>,
  rawSettings: Record<string, unknown>,
  opts: { deviceId?: string | null; ptz?: boolean } = {},
): CameraCapabilities {
  const controls: Partial<Record<ControlKey, ControlDescriptor>> = {};
  const unsupported: ControlKey[] = [];
  const ptz = !!opts.ptz;

  for (const key of CONTROL_KEYS) {
    const def: ControlDef = CONTROLS[key];
    const raw = rawCaps[key];
    let desc: ControlDescriptor | null = null;
    if (def.ptz && !ptz) {
      // pan / tilt ne sont exploitables qu'avec la permission PTZ.
    } else if (def.kind === "range" && isRange(raw)) {
      const min = typeof raw.min === "number" ? raw.min : undefined;
      const max = typeof raw.max === "number" ? raw.max : undefined;
      // Une plage dégénérée (min = max) n'offre aucun réglage.
      if (min === undefined || max === undefined || max > min) {
        desc = { key, kind: "range", label: def.label, min, max };
        if (typeof raw.step === "number" && raw.step > 0) desc.step = raw.step;
      }
    } else if (def.kind === "enum" && Array.isArray(raw)) {
      const values = raw.filter((v): v is string => typeof v === "string");
      if (values.length > 1) desc = { key, kind: "enum", label: def.label, values };
    } else if (def.kind === "boolean" && (raw === true || (Array.isArray(raw) && raw.includes(true)))) {
      desc = { key, kind: "boolean", label: def.label };
    }
    if (!desc) {
      unsupported.push(key);
      continue;
    }
    if (def.unit) desc.unit = def.unit;
    const current = readSetting(rawSettings, key);
    if (current !== undefined) desc.value = current;
    controls[key] = desc;
  }

  return {
    status: "ready",
    deviceId: opts.deviceId ?? (typeof rawSettings.deviceId === "string" ? rawSettings.deviceId : null),
    ptz,
    controls,
    list: CONTROL_KEYS.map((k) => controls[k]).filter((d): d is ControlDescriptor => !!d),
    unsupported,
  };
}

/* ------------------------------------------------------------------ */
/* Validation d'une demande                                            */
/* ------------------------------------------------------------------ */

function snap(value: number, d: ControlDescriptor): number {
  let v = value;
  if (d.min !== undefined) v = Math.max(d.min, v);
  if (d.max !== undefined) v = Math.min(d.max, v);
  if (d.step && d.min !== undefined) {
    const n = Math.round((v - d.min) / d.step);
    v = d.min + n * d.step;
    // Évite 0.30000000000000004 ; le pas peut être décimal.
    v = Number(v.toFixed(6));
    if (d.max !== undefined) v = Math.min(d.max, v);
  }
  return v;
}

export type NormalizedAdjust = {
  /** Réglages à appliquer, dans l'ordre sûr (modes d'abord). */
  apply: [ControlKey, ControlValue][];
  /** Clés à retirer de `desired` (valeur `null` reçue). */
  release: ControlKey[];
  errors: Partial<Record<ControlKey, string>>;
};

/**
 * Valide une demande (objet issu d'un DataProvider) contre les capacités.
 * Les nombres sont bornés et alignés sur le pas, les énumérés vérifiés, les booléens
 * acceptés sous forme `true`/`false`. Une clé inconnue ou non prise en charge produit
 * un message, jamais une exception.
 */
export function normalizeAdjust(input: unknown, caps: CameraCapabilities): NormalizedAdjust {
  const out: NormalizedAdjust = { apply: [], release: [], errors: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const raw = input as Record<string, unknown>;

  // Les autres clés du DP (ex. `active`) ne sont pas des réglages : ignorées.
  for (const key of CONTROL_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null) {
      out.release.push(key);
      continue;
    }
    const d = caps.controls[key];
    if (!d) {
      out.errors[key] = caps.status === "ready" ? "non pris en charge par cette caméra" : "caméra non démarrée";
      continue;
    }
    if (d.kind === "range") {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (!Number.isFinite(n)) {
        out.errors[key] = "nombre attendu";
        continue;
      }
      out.apply.push([key, snap(n, d)]);
    } else if (d.kind === "enum") {
      if (typeof value !== "string" || !d.values?.includes(value)) {
        out.errors[key] = `valeur attendue parmi : ${(d.values ?? []).join(", ")}`;
        continue;
      }
      out.apply.push([key, value]);
    } else {
      if (typeof value !== "boolean") {
        out.errors[key] = "vrai ou faux attendu";
        continue;
      }
      out.apply.push([key, value]);
    }
  }
  return out;
}

/** Vrai si la valeur relue correspond (à la tolérance près) à la valeur demandée. */
export function sameValue(requested: ControlValue, applied: ControlValue | undefined, d?: ControlDescriptor): boolean {
  if (applied === undefined) return false;
  if (typeof requested === "number" && typeof applied === "number") {
    const span = d && d.min !== undefined && d.max !== undefined ? d.max - d.min : 0;
    const tol = Math.max(d?.step ?? 0, span * 0.01, 1e-6);
    return Math.abs(requested - applied) <= tol;
  }
  return requested === applied;
}

/* ------------------------------------------------------------------ */
/* Application sur la piste                                            */
/* ------------------------------------------------------------------ */

/**
 * Pilote les réglages d'une piste : demandes fusionnées, une seule application à la fois
 * (les demandes arrivées pendant l'application sont regroupées), relecture après chaque
 * passe, erreurs par clé. N'ouvre ni ne ferme jamais la piste.
 */
export class TrackAdjuster {
  private track: MediaStreamTrack | null = null;
  private caps: CameraCapabilities = emptyCapabilities();
  private state: CameraAdjustState = emptyAdjustState();
  private running = false;
  private dirty = false;
  private generation = 0;
  private notify: (caps: CameraCapabilities, state: CameraAdjustState) => void;
  private ptz = false;
  /** Contraintes de base réappliquées avec chaque réglage (résolution, cadence) pour ne pas les perdre. */
  private base: () => MediaTrackConstraints;

  constructor(
    notify: (caps: CameraCapabilities, state: CameraAdjustState) => void,
    base: () => MediaTrackConstraints = () => ({}),
  ) {
    this.notify = notify;
    this.base = base;
  }

  getCapabilities(): CameraCapabilities {
    return this.caps;
  }

  getState(): CameraAdjustState {
    return this.state;
  }

  /** Branche une piste ouverte : publie ses capacités, revalide les réglages déjà demandés, les applique. */
  attach(track: MediaStreamTrack, opts: { ptz: boolean }): void {
    this.generation++;
    this.track = track;
    this.ptz = opts.ptz;
    this.refreshCapabilities();
    // Demandes faites avant l'ouverture (ou avant un redémarrage du flux) : bornées / vérifiées sur cette piste.
    // Une clé absente de cette caméra reste demandée (message d'erreur), au cas où une autre caméra la gère.
    const n = normalizeAdjust(this.state.desired, this.caps);
    const desired = { ...this.state.desired };
    for (const k of Object.keys(n.errors) as ControlKey[]) if (this.caps.controls[k]) delete desired[k];
    for (const [k, v] of n.apply) desired[k] = v;
    this.state = { desired, applied: this.readApplied(), pending: [], errors: n.errors };
    if (n.apply.length) this.schedule();
    else this.emit();
  }

  /** Piste fermée : les capacités disparaissent, les réglages demandés sont conservés. */
  detach(): void {
    this.generation++;
    this.track = null;
    this.caps = emptyCapabilities();
    this.state = { ...this.state, applied: {}, pending: [], errors: {} };
    this.emit();
  }

  /** Fusionne une demande (`null` = oublier ce réglage) et lance l'application. */
  request(input: unknown): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const raw = input as Record<string, unknown>;
    const desired = { ...this.state.desired };
    const errors = { ...this.state.errors };
    let toApply = false;
    if (this.caps.status !== "ready") {
      // Caméra pas encore ouverte : on garde les valeurs de bon type, validées à l'ouverture.
      for (const k of CONTROL_KEYS) {
        if (!(k in raw)) continue;
        const v = raw[k];
        if (v === null) {
          delete desired[k];
          delete errors[k];
        } else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
          desired[k] = v;
          delete errors[k];
        }
      }
    } else {
      const n = normalizeAdjust(raw, this.caps);
      for (const k of n.release) {
        delete desired[k];
        delete errors[k];
      }
      for (const [k, v] of n.apply) {
        desired[k] = v;
        delete errors[k];
      }
      Object.assign(errors, n.errors);
      toApply = n.apply.length > 0;
    }
    this.state = { ...this.state, desired, errors };
    if (this.track && toApply) this.schedule();
    else this.emit();
  }

  /* ---------------------------------------------------------------- */

  private refreshCapabilities(): void {
    const t = this.track;
    if (!t) return;
    const caps = typeof t.getCapabilities === "function" ? (t.getCapabilities() as Record<string, unknown>) : {};
    const settings = typeof t.getSettings === "function" ? (t.getSettings() as Record<string, unknown>) : {};
    this.caps = describeCapabilities(caps, settings, { ptz: this.ptz });
  }

  private readApplied(): CameraAdjustState["applied"] {
    const t = this.track;
    if (!t || typeof t.getSettings !== "function") return {};
    const s = t.getSettings() as Record<string, unknown>;
    const applied: CameraAdjustState["applied"] = {};
    for (const k of Object.keys(this.caps.controls) as ControlKey[]) {
      const v = readSetting(s, k);
      if (v !== undefined) applied[k] = v;
    }
    return applied;
  }

  private emit(): void {
    this.notify(this.caps, this.state);
  }

  private schedule(): void {
    this.dirty = true;
    if (this.running) return;
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        const gen = this.generation;
        const track = this.track;
        if (!track) break;
        // Ce qui reste à faire : demandé et différent de ce que la piste affiche déjà.
        const todo = CONTROL_KEYS.filter((k) => {
          const want = this.state.desired[k];
          const d = this.caps.controls[k];
          return want !== undefined && d && !sameValue(want, this.state.applied[k], d);
        });
        this.state = { ...this.state, pending: todo };
        this.emit();
        for (const k of todo) {
          if (gen !== this.generation) break; // piste remplacée ou fermée pendant l'application
          try {
            const value = this.state.desired[k]!;
            // Un réglage à la fois : si l'un est refusé, les autres passent quand même
            // (un jeu `advanced` insatisfaisable est ignoré en bloc par le navigateur).
            await track.applyConstraints({ ...this.base(), advanced: [{ [k]: value } as MediaTrackConstraintSet] });
            if (gen !== this.generation) break;
            const e = { ...this.state.errors };
            delete e[k];
            this.state = { ...this.state, errors: e };
          } catch (err) {
            if (gen !== this.generation) break;
            const name = (err as { name?: string })?.name;
            const message =
              name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError"
                ? "valeur refusée par la caméra"
                : name === "NotAllowedError"
                  ? "permission refusée"
                  : err instanceof Error && err.message
                    ? err.message
                    : "réglage impossible";
            this.state = { ...this.state, errors: { ...this.state.errors, [k]: message } };
          }
          this.state = { ...this.state, applied: this.readApplied(), pending: this.state.pending.filter((p) => p !== k) };
          this.emit();
        }
        if (gen === this.generation) {
          this.refreshCapabilities(); // les bornes d'un réglage peuvent changer avec un autre (ex. mode manuel)
          this.state = { ...this.state, applied: this.readApplied(), pending: [] };
          this.emit();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
