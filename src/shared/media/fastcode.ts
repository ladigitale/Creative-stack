/**
 * Code rapide pour la lumière : texte → suite d'intervalles allumé / éteint de 1, 2 ou 3 unités.
 *
 * Le morse ne code que dans les éclats : les silences ne servent qu'à séparer. Ici chaque intervalle,
 * allumé ou éteint, porte une information, et un seul arbre de code (préfixe, durées 1/2/3) couvre les
 * caractères, une fin de message et une table de phrases : « OUI » est un seul symbole.
 *
 * Message : éclat de début (`startUnits` + 2 : le récepteur reconnaît ainsi le code, voir `FAST_START_EXTRA`),
 * silence de 3 unités (étalonnage), identifiant de l'émetteur (2 ou 3 intervalles, seulement si une liste
 * de pseudos `roster` est configurée ; 0 = anonyme), symboles, fin de message,
 * 3 chiffres de contrôle (base 3). Si le dernier intervalle est un silence, un éclat d'une unité le
 * referme. Le récepteur sait où le message finit : pas de silence à attendre.
 *
 * Les deux appareils doivent avoir la même table (phrases) : son empreinte entre dans le contrôle, un
 * message venu d'une autre table est rejeté au lieu d'être mal lu.
 */
import { MORSE, morseNormalize, type MorseStep } from "./morse";

/** À incrémenter quand les poids, l'alphabet ou la construction de l'arbre changent. */
export const FAST_VERSION = 1;

/** Part de chaque durée (1, 2, 3 unités) dans un code optimal : racine de x⁻¹ + x⁻² + x⁻³ = 1. */
const SHARE = [0, 0.5437, 0.2956, 0.1607];

/**
 * Unités ajoutées à l'éclat de début du morse pour celui du code rapide. Le premier silence qui suit vaut
 * 3 unités dans les deux codes : éclat de début / silence = S/3 en morse, (S+2)/3 en rapide, soit 1,67 et
 * 2,33 pour S = 5. Le rapport ne dépend pas de l'unité, le récepteur reconnaît le code d'un message sans
 * rien connaître de l'émetteur.
 */
export const FAST_START_EXTRA = 2;

/** Nombre de chiffres de contrôle (base 3) en fin de message. */
const CHECK_TRITS = 3;

/** Fréquences du français (pour 10 000 symboles), espace comprise. */
const WEIGHTS: Record<string, number> = {
  " ": 1700, E: 1220, S: 656, A: 631, I: 622, T: 598, N: 589, R: 548, U: 523, L: 457, O: 440, D: 307, C: 274,
  M: 249, P: 249, V: 133, Q: 116, G: 91, F: 91, B: 75, H: 58, J: 50, X: 33, Y: 25, Z: 8, K: 4, W: 4,
  "0": 20, "1": 20, "2": 15, "3": 15, "4": 12, "5": 12, "6": 12, "7": 12, "8": 12, "9": 12,
  ".": 40, ",": 40, "?": 20, "'": 40, "!": 15, "-": 15, ":": 5, "/": 5, "(": 3, ")": 3, "@": 3, "+": 3, "=": 3,
};

/** Poids de la fin de message : un message sur une douzaine de symboles. */
const EOT_WEIGHT = 450;

/** Table de phrases par défaut : texte et poids (fréquence d'emploi relative). */
export const FAST_PHRASES: [string, number][] = [
  ["OUI", 320], ["NON", 280], ["OK", 260], ["MERCI", 230], ["SALUT", 230], ["BONJOUR", 150], ["BONSOIR", 90],
  ["CA VA ?", 190], ["CA VA", 150], ["TOUT VA BIEN", 90], ["J'ARRIVE", 170], ["JE SUIS LA", 110], ["OU ES TU ?", 150],
  ["ATTENDS", 110], ["ATTENDEZ", 70], ["REPETE", 100], ["COMPRIS", 110], ["PAS COMPRIS", 90], ["D'ACCORD", 130],
  ["AIDE", 110], ["URGENT", 80], ["DANGER", 60], ["STOP", 70], ["GO", 70], ["VIENS", 90], ["JE VIENS", 80],
  ["MAINTENANT", 70], ["PLUS TARD", 80], ["DEMAIN", 60], ["A BIENTOT", 100], ["A TOI", 70], ["S'IL TE PLAIT", 60],
  ["PAS DE SOUCI", 60], ["BIEN RECU", 90], ["JE NE SAIS PAS", 60], ["BRAVO", 40], ["BONNE NUIT", 50], ["FIN", 50],
];

type Node = { sym?: number; kids: (Node | undefined)[] };

/** Nombre maximal de pseudos de la liste d'identifiants. */
export const FAST_MAX_ROSTER = 26;

export type FastTable = {
  /** Pseudos des émetteurs (liste partagée) ; l'identifiant d'un message est leur rang + 1, 0 = anonyme. */
  roster: string[];
  /** Intervalles de l'identifiant en tête de message : 0 sans liste, 2 jusqu'à 8 pseudos, 3 au-delà. */
  idTrits: number;
  /** Texte de chaque symbole : caractère, ou phrase. */
  texts: string[];
  /** Symbole de fin de message. */
  eot: number;
  /** Code de chaque symbole : suite de durées 1..3. */
  codes: number[][];
  root: Node;
  /** Symbole des phrases par texte, et nombre maximal de mots d'une phrase. */
  phrases: Map<string, number>;
  maxWords: number;
  /** Symbole de l'espace. */
  space: number;
  /** Empreinte de la table, entre dans le contrôle. */
  hash: number;
  /** Coût moyen d'un caractère de texte courant, en unités (mesure de qualité). */
  avgUnits: number;
};

/** FNV-1a 32 bits. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type Item = { id: number; w: number };

/** Coupe une liste triée en trois groupes contigus dont les masses suivent `SHARE`. */
function split(items: Item[]): Item[][] {
  const n = items.length;
  if (n === 2) return [[items[0]], [items[1]]];
  const prefix = [0];
  for (const it of items) prefix.push(prefix[prefix.length - 1] + it.w);
  const total = prefix[n];
  let best = Infinity;
  let cut: [number, number] = [1, 2];
  for (let i = 1; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const m = [prefix[i], prefix[j] - prefix[i], total - prefix[j]];
      const score = Math.abs(m[0] / total - SHARE[1]) + Math.abs(m[1] / total - SHARE[2]) + Math.abs(m[2] / total - SHARE[3]);
      if (score < best - 1e-12) {
        best = score;
        cut = [i, j];
      }
    }
  }
  return [items.slice(0, cut[0]), items.slice(cut[0], cut[1]), items.slice(cut[1])];
}

function grow(items: Item[]): Node {
  if (items.length === 1) return { sym: items[0].id, kids: [] };
  const node: Node = { kids: [] };
  split(items).forEach((g, i) => {
    node.kids[i + 1] = grow(g);
  });
  return node;
}

function walk(node: Node, path: number[], codes: number[][]): void {
  if (node.sym !== undefined) {
    codes[node.sym] = path;
    return;
  }
  for (let k = 1; k <= 3; k++) {
    const kid = node.kids[k];
    if (kid) walk(kid, [...path, k], codes);
  }
}

const cache = new Map<string, FastTable>();

/** Table de code. `phrases` remplace la table par défaut (textes ramenés à l'alphabet du morse). */
export function buildFastTable(phrases?: readonly (string | [string, number])[], roster?: readonly string[]): FastTable {
  const list: [string, number][] = [];
  const seen = new Set<string>();
  for (const p of phrases ?? FAST_PHRASES) {
    const [raw, w] = typeof p === "string" ? [p, 100] : p;
    const text = morseNormalize(raw);
    if (!text || seen.has(text) || list.length >= 200) continue;
    if (text.length < 2 && !text.includes(" ")) continue; // un seul caractère : déjà un symbole
    seen.add(text);
    list.push([text, Number.isFinite(w) && w > 0 ? w : 100]);
  }
  const names: string[] = [];
  for (const r of roster ?? []) {
    const n = morseNormalize(String(r));
    if (n && !names.includes(n) && names.length < FAST_MAX_ROSTER) names.push(n);
  }
  const key = list.map(([t, w]) => `${t}=${w}`).join("|") + (names.length ? `@${names.join("|")}` : "");
  const hit = cache.get(key);
  if (hit) return hit;

  const texts: string[] = [];
  const items: Item[] = [];
  for (const ch of [" ", ...Object.keys(MORSE)]) {
    texts.push(ch);
    items.push({ id: texts.length - 1, w: WEIGHTS[ch] ?? 10 });
  }
  const space = 0;
  texts.push("");
  const eot = texts.length - 1;
  items.push({ id: eot, w: EOT_WEIGHT });
  const phrasesById = new Map<string, number>();
  for (const [text, w] of list) {
    texts.push(text);
    items.push({ id: texts.length - 1, w });
    phrasesById.set(text, texts.length - 1);
  }
  // Tri stable : poids décroissant, puis ordre de déclaration.
  const sorted = [...items].sort((a, b) => b.w - a.w || a.id - b.id);
  const root = grow(sorted);
  const codes: number[][] = [];
  walk(root, [], codes);

  // Coût moyen d'un caractère : pondéré par les fréquences des caractères seuls.
  const chars = items.filter((it) => it.id !== eot && texts[it.id].length === 1);
  const mass = chars.reduce((a, it) => a + it.w, 0);
  const avgUnits = chars.reduce((a, it) => a + it.w * codes[it.id].reduce((x, k) => x + k, 0), 0) / mass;

  const table: FastTable = {
    roster: names,
    idTrits: names.length === 0 ? 0 : names.length <= 8 ? 2 : 3,
    texts,
    eot,
    codes,
    root,
    phrases: phrasesById,
    maxWords: Math.max(1, ...list.map(([t]) => t.split(" ").length)),
    space,
    hash: fnv(`v${FAST_VERSION}|${key}`),
    avgUnits,
  };
  cache.set(key, table);
  return table;
}

/** Table par défaut. */
export function defaultFastTable(): FastTable {
  return buildFastTable();
}

/** Texte → symboles (sans fin de message) : phrases les plus longues d'abord, sinon caractère par caractère. */
export function fastSymbols(text: string, table: FastTable = defaultFastTable()): number[] {
  const words = morseNormalize(text).split(" ").filter(Boolean);
  const out: number[] = [];
  const cost = (id: number) => table.codes[id].reduce((a, k) => a + k, 0);
  let i = 0;
  while (i < words.length) {
    if (out.length) out.push(table.space);
    let used = 0;
    for (let n = Math.min(table.maxWords, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(" ");
      const id = table.phrases.get(phrase);
      if (id === undefined) continue;
      const letters = [...phrase].reduce((a, c) => a + cost(table.texts.indexOf(c)), 0);
      if (cost(id) > letters) continue;
      out.push(id);
      used = n;
      break;
    }
    if (used) {
      i += used;
      continue;
    }
    for (const c of words[i]) out.push(table.texts.indexOf(c));
    i++;
  }
  return out;
}

/** Chiffres de contrôle (0..2) d'une suite de symboles. */
function checkTrits(ids: number[], table: FastTable, speaker = 0): number[] {
  const c = fnv(`${table.hash}:${speaker}:${ids.join(",")}`) % 3 ** CHECK_TRITS;
  const out: number[] = [];
  for (let i = CHECK_TRITS - 1; i >= 0; i--) out.push(Math.floor(c / 3 ** i) % 3);
  return out;
}

export type FastPlan = {
  /** Durées, en unités, des intervalles après l'étalonnage ; le premier est allumé. */
  intervals: number[];
  /** Caractères émis à la fin de chaque intervalle. */
  chars: number[];
  /** Texte normalisé émis. */
  text: string;
};

/** Message → intervalles (symboles, fin de message, contrôle, éclat de fermeture éventuel). */
export function fastPlan(text: string, table: FastTable = defaultFastTable(), speaker = ""): FastPlan {
  const clean = morseNormalize(text);
  const ids = clean ? fastSymbols(clean, table) : [];
  const intervals: number[] = [];
  const chars: number[] = [];
  let done = 0;
  const who = table.idTrits ? table.roster.indexOf(morseNormalize(speaker)) + 1 : 0;
  if (ids.length) {
    for (let i = table.idTrits - 1; i >= 0; i--) {
      intervals.push((Math.floor(who / 3 ** i) % 3) + 1);
      chars.push(0);
    }
  }
  for (const id of ids) {
    const code = table.codes[id];
    done += table.texts[id].length;
    code.forEach((k, i) => {
      intervals.push(k);
      chars.push(i === code.length - 1 ? done : Math.max(0, done - table.texts[id].length));
    });
  }
  if (!ids.length) return { intervals: [], chars: [], text: "" };
  for (const k of table.codes[table.eot]) {
    intervals.push(k);
    chars.push(done);
  }
  for (const t of checkTrits(ids, table, who)) {
    intervals.push(t + 1);
    chars.push(done);
  }
  // Le dernier intervalle doit finir sur un front : un silence est refermé par un éclat d'une unité.
  if (intervals.length % 2 === 0) {
    intervals.push(1);
    chars.push(done);
  }
  return { intervals, chars, text: clean };
}

/** Durées des intervalles, en chiffres (« 1321 »), pour l'affichage. */
export function fastSigns(text: string, table: FastTable = defaultFastTable(), speaker = ""): string {
  return fastPlan(text, table, speaker).intervals.join("");
}

/** Chronologie d'émission ; mêmes réglages que `morseTimeline`. */
export function fastTimeline(text: string, unit: number, trim = 0, startUnits = 5, table: FastTable = defaultFastTable(), speaker = ""): MorseStep[] {
  const plan = fastPlan(text, table, speaker);
  if (!plan.intervals.length) return [];
  const u = Math.max(1, unit);
  const cut = Math.min(Math.max(0, trim), u * 0.8);
  const start = Math.max(4, startUnits || 5) + FAST_START_EXTRA;
  const steps: MorseStep[] = [
    { on: true, ms: start * u - cut, chars: 0 },
    { on: false, ms: 3 * u + cut, chars: 0 },
  ];
  plan.intervals.forEach((k, i) => {
    const on = i % 2 === 0;
    steps.push({ on, ms: k * u + (on ? -cut : cut), chars: plan.chars[i] });
  });
  return steps;
}

export type FastResult = "more" | "done" | "error";

/**
 * Décode des intervalles mesurés. `start(ms, units)` : l'éclat de début vient de finir ;
 * `feed(lit, ms)` : un intervalle vient de finir (`startUnits` : durée réelle de l'éclat de début, soit
 * celle du morse + `FAST_START_EXTRA`). L'étalonnage vient de l'éclat de début et du silence
 * qui le suit : un émetteur d'une autre unité est suivi, les durées sont relatives.
 */
export class FastDecoder {
  /** Texte décodé jusqu'ici (sans garantie tant que le contrôle n'est pas passé). */
  text = "";
  /** Unité estimée sur l'éclat de début, en ms. */
  unit = 0;
  /** Pseudo de l'émetteur, dès que son identifiant est lu (vide : anonyme ou pas encore lu). */
  speaker = "";
  /** Raison du dernier rejet. */
  error = "";
  /** Message complet et contrôle bon. */
  ok = false;
  private state: "idle" | "gap" | "id" | "data" | "check" | "end" = "idle";
  private who = 0;
  private idRead = 0;
  private node: Node;
  private ids: number[] = [];
  private trits: number[] = [];
  private unitLit = 0;
  private unitDark = 0;
  private expectLit = true;

  constructor(private table: FastTable = defaultFastTable()) {
    this.node = table.root;
  }

  setTable(table: FastTable): void {
    this.table = table;
    this.reset();
  }

  reset(): void {
    this.text = "";
    this.speaker = "";
    this.who = 0;
    this.idRead = 0;
    this.error = "";
    this.ok = false;
    this.state = "idle";
    this.node = this.table.root;
    this.ids = [];
    this.trits = [];
    this.expectLit = true;
  }

  /** Le message est commencé (éclat de début vu). */
  get started(): boolean {
    return this.state !== "idle" && this.state !== "end";
  }

  start(litMs: number, startUnits: number): void {
    this.reset();
    this.unitLit = litMs / Math.max(1, startUnits);
    this.unit = this.unitLit;
    this.state = "gap";
  }

  private fail(why: string): FastResult {
    this.error = why;
    this.state = "end";
    return "error";
  }

  feed(lit: boolean, ms: number): FastResult {
    if (this.state === "idle" || this.state === "end") return "more";
    if (this.state === "gap") {
      if (lit) return this.fail("étalonnage");
      const ratio = ms / this.unitLit;
      if (ratio < 2 || ratio > 4.5) return this.fail("étalonnage");
      this.unitDark = ms / 3;
      this.state = this.table.idTrits ? "id" : "data";
      this.expectLit = true;
      return "more";
    }
    if (lit !== this.expectLit) return this.fail("alternance");
    this.expectLit = !this.expectLit;
    const r = ms / (lit ? this.unitLit : this.unitDark);
    if (r < 0.5 || r > 4.5) return this.fail("durée");
    const k = r < 1.5 ? 1 : r < 2.5 ? 2 : 3;

    if (this.state === "id") {
      this.who = this.who * 3 + (k - 1);
      if (++this.idRead < this.table.idTrits) return "more";
      if (this.who > this.table.roster.length) return this.fail("identité");
      this.speaker = this.who ? this.table.roster[this.who - 1] : "";
      this.state = "data";
      return "more";
    }

    if (this.state === "check") {
      this.trits.push(k - 1);
      if (this.trits.length < CHECK_TRITS) return "more";
      const want = checkTrits(this.ids, this.table, this.who);
      if (want.some((t, i) => t !== this.trits[i])) return this.fail("contrôle");
      this.ok = true;
      this.state = "end";
      return "done";
    }

    const next = this.node.kids[k];
    if (!next) return this.fail("code");
    if (next.sym === undefined) {
      this.node = next;
      return "more";
    }
    this.node = this.table.root;
    if (next.sym === this.table.eot) {
      this.state = "check";
      return "more";
    }
    this.ids.push(next.sym);
    this.text += this.table.texts[next.sym];
    return "more";
  }
}
