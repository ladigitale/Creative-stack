/**
 * Fonctions pures de l'addon speech : découpe d'un texte en morceaux prononçables, choix d'une
 * voix, comparaison de mots-clés sans accents ni casse, traduction des erreurs du navigateur.
 */

/** Longueur au-delà de laquelle Chrome coupe parfois une phrase (~15 s de parole) : on redécoupe. */
export const MAX_CHUNK = 180;

export type SpeechChunk = { text: string; offset: number };

/**
 * Découpe un texte en phrases (puis aux virgules, puis aux espaces) de `max` caractères au plus.
 * Chaque morceau garde sa position dans le texte d'origine (`offset`) pour rapporter `charIndex`.
 */
export function splitSpeech(text: string, max = MAX_CHUNK): SpeechChunk[] {
  const out: SpeechChunk[] = [];
  const limit = Math.max(20, max);
  const push = (start: number, end: number) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ text: text.slice(s, e), offset: s });
  };
  // Phrases : jusqu'à . ! ? … ; ou fin de ligne, ponctuation finale comprise.
  const sentence = /[^.!?…;\n]+(?:[.!?…;]+|\n+|$)|[.!?…;\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = sentence.exec(text))) {
    if (!m[0]) {
      sentence.lastIndex++;
      continue;
    }
    let start = m.index;
    const end = m.index + m[0].length;
    while (end - start > limit) {
      const slice = text.slice(start, start + limit);
      let cut = Math.max(slice.lastIndexOf(","), slice.lastIndexOf(":"), slice.lastIndexOf("—"));
      if (cut < limit / 3) cut = slice.lastIndexOf(" ");
      if (cut < limit / 3) cut = limit - 1;
      push(start, start + cut + 1);
      start = start + cut + 1;
    }
    push(start, end);
  }
  return out;
}

/** Mot qui commence (ou contient) la position `index` d'un texte. */
export function wordAt(text: string, index: number, length?: number): string {
  if (index < 0 || index >= text.length) return "";
  if (length && length > 0) return text.slice(index, index + length).trim();
  let s = index;
  let e = index;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  while (e < text.length && !/\s/.test(text[e])) e++;
  return text.slice(s, e).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export type VoiceLike = { name: string; lang: string; localService?: boolean; default?: boolean; voiceURI?: string };

const langOf = (l: string) => l.toLowerCase().replace("_", "-");

/**
 * Voix à utiliser : `voice` = nom exact ou partie de nom (sans casse), restreint à la langue si
 * elle est donnée et qu'une voix correspond ; sans nom, la voix par défaut de la langue, puis une
 * voix locale de la langue, puis la première de la langue. `null` : laisser le navigateur choisir.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], voice: string, lang: string): V | null {
  if (!voices.length) return null;
  const want = voice.trim().toLowerCase();
  const l = langOf(lang.trim());
  const inLang = l ? voices.filter((v) => langOf(v.lang) === l || langOf(v.lang).startsWith(`${l.split("-")[0]}-`) || langOf(v.lang) === l.split("-")[0]) : [];
  const exactLang = l ? inLang.filter((v) => langOf(v.lang) === l) : [];
  if (want) {
    const pools = [exactLang, inLang, voices];
    for (const pool of pools) {
      const exact = pool.find((v) => v.name.toLowerCase() === want);
      if (exact) return exact;
    }
    for (const pool of pools) {
      const part = pool.find((v) => v.name.toLowerCase().includes(want));
      if (part) return part;
    }
  }
  if (!l) return null;
  for (const pool of [exactLang, inLang]) {
    const v = pool.find((x) => x.default) ?? pool.find((x) => x.localService) ?? pool[0];
    if (v) return v;
  }
  return null;
}

/** Minuscules, sans accents ni ponctuation, espaces simples. */
export function normalizeSpeech(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Liste de mots-clés : tableau, ou texte séparé par des virgules, points-virgules ou `|`. */
export function parsePhrases(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x ?? ""))) : typeof v === "string" ? v.split(/[,;|\n]/) : [];
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, 200);
}

/** Premier mot-clé (le plus long d'abord) présent en mots entiers dans le texte, sinon `null`. */
export function matchPhrase(text: string, phrases: readonly string[]): string | null {
  const hay = ` ${normalizeSpeech(text)} `;
  if (hay.trim() === "") return null;
  const sorted = [...phrases].sort((a, b) => normalizeSpeech(b).length - normalizeSpeech(a).length);
  for (const p of sorted) {
    const n = normalizeSpeech(p);
    if (n && hay.includes(` ${n} `)) return p;
  }
  return null;
}

export type SpeechErrorInfo = { status: "denied" | "error" | "unsupported"; error: string; fatal: boolean };

/** Erreur de `SpeechRecognition` (`event.error`) → statut, message lisible, arrêt définitif ou non. */
export function recognitionError(code: string): SpeechErrorInfo {
  switch (code) {
    case "not-allowed":
      return { status: "denied", error: "micro refusé : permission refusée, geste de l'utilisateur requis ou interdit par la page hôte (allow=\"microphone\")", fatal: true };
    case "service-not-allowed":
      return { status: "denied", error: "reconnaissance vocale refusée par le navigateur (service désactivé ou page non sécurisée)", fatal: true };
    case "no-speech":
      return { status: "error", error: "aucune parole entendue", fatal: false };
    case "audio-capture":
      return { status: "error", error: "aucun micro disponible (absent, débranché ou utilisé par une autre application)", fatal: true };
    case "network":
      return { status: "error", error: "service de reconnaissance injoignable : le navigateur envoie l'audio à ses serveurs, vérifier la connexion", fatal: false };
    case "language-not-supported":
      return { status: "unsupported", error: "langue non prise en charge par la reconnaissance vocale de ce navigateur", fatal: true };
    case "bad-grammar":
      return { status: "error", error: "liste de mots-clés refusée par le navigateur", fatal: false };
    default:
      return { status: "error", error: code ? `reconnaissance vocale : ${code}` : "reconnaissance vocale : erreur", fatal: false };
  }
}

/** Erreur de `SpeechSynthesisUtterance` (`event.error`) → statut et message ; `null` = interruption voulue. */
export function synthesisError(code: string): { status: "denied" | "error" | "unsupported"; error: string } | null {
  switch (code) {
    case "interrupted":
    case "canceled":
      return null;
    case "not-allowed":
      return { status: "denied", error: "synthèse vocale refusée : le navigateur exige un geste de l'utilisateur (bouton for=… ou clic juste avant)" };
    case "language-unavailable":
    case "voice-unavailable":
      return { status: "unsupported", error: "voix ou langue indisponible sur cet appareil" };
    case "text-too-long":
      return { status: "error", error: "texte trop long pour la synthèse vocale" };
    case "audio-busy":
    case "audio-hardware":
      return { status: "error", error: "sortie audio indisponible" };
    case "network":
    case "synthesis-unavailable":
    case "synthesis-failed":
      return { status: "error", error: "synthèse vocale indisponible (voix en ligne injoignable ?)" };
    default:
      return { status: "error", error: code ? `synthèse vocale : ${code}` : "synthèse vocale : erreur" };
  }
}

/** Délai avant de relancer une écoute coupée : 250 ms, doublé à chaque coupure rapide, 8 s au plus. */
export function restartDelay(quickFails: number): number {
  return Math.min(8000, 250 * 2 ** Math.max(0, quickFails));
}
