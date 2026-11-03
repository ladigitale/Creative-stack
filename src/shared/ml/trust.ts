/**
 * Niveaux de confiance pour les modèles ML (composants `sonic-*-tracker`, …).
 *
 * Un modèle est une donnée lue par un runtime épinglé, pas du code. On distingue :
 *  - `trusted` : alias déclaré par l'app (`aliases`), chargé sans consentement ;
 *  - `origins` : URL dont l'origine est approuvée (config de l'app, `capabilities.ml` de l'artefact),
 *    consentement mémorisé par origine ;
 *  - `open`    : toute URL https, consentement explicite pour chaque modèle.
 *
 * Fonctions pures (testables) : la lecture/écriture du consentement passe par un `ConsentStore`.
 */

export type TrustLevel = "origins" | "open";

export type MlPolicy = {
  /** Niveau le plus ouvert accepté (`trusted` est toujours accepté). Défaut : `origins`. */
  level: TrustLevel;
  /** Alias → URL du modèle, toujours de confiance. */
  aliases: Record<string, string>;
  /** Préfixes d'URL approuvés (`https://host/chemin/`), pour le niveau `origins`. */
  origins: string[];
  /** Taille max acceptée sans que l'hôte l'autorise explicitement (octets). */
  maxBytes: number;
};

export const DEFAULT_MEDIAPIPE_MODELS = "https://storage.googleapis.com/mediapipe-models/";

export const DEFAULT_POLICY: MlPolicy = {
  level: "origins",
  aliases: {
    "hand-landmarker": `${DEFAULT_MEDIAPIPE_MODELS}hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
    "gesture-recognizer": `${DEFAULT_MEDIAPIPE_MODELS}gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`,
    "face-landmarker": `${DEFAULT_MEDIAPIPE_MODELS}face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    "pose-landmarker": `${DEFAULT_MEDIAPIPE_MODELS}pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    "pose-landmarker-full": `${DEFAULT_MEDIAPIPE_MODELS}pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    "object-detector": `${DEFAULT_MEDIAPIPE_MODELS}object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`,
    "selfie-segmenter": `${DEFAULT_MEDIAPIPE_MODELS}image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`,
    "pose-landmarker-heavy": `${DEFAULT_MEDIAPIPE_MODELS}pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
  },
  origins: [DEFAULT_MEDIAPIPE_MODELS, "https://huggingface.co/", "https://cdn.jsdelivr.net/"],
  maxBytes: 64 * 1024 * 1024,
};

export type ModelRef =
  | { kind: "alias"; alias: string; url: string }
  | { kind: "url"; url: string; origin: string };

export type TrustDecision =
  | { allowed: true; ref: ModelRef; needsConsent: boolean; consentKey: string }
  | { allowed: false; code: "invalid-model" | "insecure-url" | "origin-not-allowed"; message: string };

/** Parse `model` : alias connu ou URL https. Rien d'autre (pas de chemin local, pas de `data:`). */
export function parseModelRef(
  model: string,
  aliases: Record<string, string>,
): ModelRef | { error: "invalid-model" | "insecure-url"; message: string } {
  const value = (model ?? "").trim();
  if (!value) return { error: "invalid-model", message: "Modèle manquant." };
  if (Object.prototype.hasOwnProperty.call(aliases, value)) {
    return { kind: "alias", alias: value, url: aliases[value] };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "invalid-model", message: `Modèle inconnu : « ${value} » (ni alias ni URL).` };
  }
  if (url.protocol !== "https:") {
    return { error: "insecure-url", message: "Seules les URL https sont acceptées pour un modèle." };
  }
  if (url.username || url.password) {
    return { error: "invalid-model", message: "Une URL de modèle ne doit pas contenir d'identifiants." };
  }
  return { kind: "url", url: url.toString(), origin: url.origin };
}

/** Le préfixe approuvé couvre-t-il l'URL ? Comparaison sur l'URL normalisée (pas de `..`, pas de sous-domaine déguisé). */
export function matchesOrigin(url: string, prefix: string): boolean {
  let u: URL;
  let p: URL;
  try {
    u = new URL(url);
    p = new URL(prefix);
  } catch {
    return false;
  }
  if (u.origin !== p.origin) return false;
  const base = p.pathname.endsWith("/") ? p.pathname : `${p.pathname}/`;
  return u.pathname === p.pathname || u.pathname.startsWith(base);
}

/** Décide si un modèle peut être chargé et s'il faut un consentement. */
export function decideTrust(model: string, policy: MlPolicy): TrustDecision {
  const ref = parseModelRef(model, policy.aliases);
  if ("error" in ref) return { allowed: false, code: ref.error, message: ref.message };
  if (ref.kind === "alias") {
    return { allowed: true, ref, needsConsent: false, consentKey: `alias:${ref.alias}` };
  }
  const approved = policy.origins.some((p) => matchesOrigin(ref.url, p));
  if (approved) {
    return { allowed: true, ref, needsConsent: true, consentKey: `origin:${ref.origin}` };
  }
  if (policy.level === "open") {
    return { allowed: true, ref, needsConsent: true, consentKey: `url:${ref.url}` };
  }
  return {
    allowed: false,
    code: "origin-not-allowed",
    message: `Origine non approuvée : ${ref.origin}. L'artefact doit la déclarer (capabilities.ml) ou l'app passer en niveau « open ».`,
  };
}

/** Normalise `capabilities.ml` : liste de préfixes https, le reste est ignoré. */
export function normalizeOrigins(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    try {
      const u = new URL(v);
      if (u.protocol === "https:" && !u.username && !u.password) out.push(u.origin + u.pathname);
    } catch {
      /* ignoré */
    }
  }
  return out;
}

/* ---------------- consentement ---------------- */

export type ConsentStore = {
  get(key: string): "accepted" | "declined" | null;
  set(key: string, value: "accepted" | "declined"): void;
  clear(key: string): void;
};

const PREFIX = "concorde-ml-consent:";

export function localStorageConsent(): ConsentStore {
  const storage = (): Storage | null => {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      const v = storage()?.getItem(PREFIX + key);
      return v === "accepted" || v === "declined" ? v : null;
    },
    set(key, value) {
      try {
        storage()?.setItem(PREFIX + key, value);
      } catch {
        /* quota / mode privé : le consentement vaut pour la session seulement */
      }
    },
    clear(key) {
      try {
        storage()?.removeItem(PREFIX + key);
      } catch {
        /* ignoré */
      }
    },
  };
}

/** Valeur de `consentProvider` → décision (`true` / `"accepted"` = oui, `"declined"` / `false` = non). */
export function readConsentValue(value: unknown): "accepted" | "declined" | null {
  if (value === true || value === "accepted" || value === "true" || value === 1) return "accepted";
  if (value === "declined" || value === "false" || value === false || value === 0) return "declined";
  return null;
}

/* ---------------- configuration globale (côté app hôte) ---------------- */

let policy: MlPolicy = { ...DEFAULT_POLICY, aliases: { ...DEFAULT_POLICY.aliases }, origins: [...DEFAULT_POLICY.origins] };
let consent: ConsentStore = localStorageConsent();

export function getMlPolicy(): MlPolicy {
  return policy;
}

export function getConsentStore(): ConsentStore {
  return consent;
}

/** Configuration par l'app hôte : niveau, alias, origines (fusionnées avec celles par défaut), plafond de taille. */
export function configureMl(next: Partial<Omit<MlPolicy, "aliases" | "origins">> & {
  aliases?: Record<string, string>;
  origins?: string[];
  /** Remplace la liste d'origines par défaut au lieu de la compléter. */
  replaceOrigins?: boolean;
  consent?: ConsentStore;
}): MlPolicy {
  policy = {
    level: next.level ?? policy.level,
    maxBytes: next.maxBytes ?? policy.maxBytes,
    aliases: { ...policy.aliases, ...(next.aliases ?? {}) },
    origins: next.replaceOrigins
      ? normalizeOrigins(next.origins)
      : [...new Set([...policy.origins, ...normalizeOrigins(next.origins)])],
  };
  if (next.consent) consent = next.consent;
  return policy;
}

/** Remise à zéro (tests). */
export function resetMlConfig(): void {
  policy = { ...DEFAULT_POLICY, aliases: { ...DEFAULT_POLICY.aliases }, origins: [...DEFAULT_POLICY.origins] };
  consent = localStorageConsent();
}
