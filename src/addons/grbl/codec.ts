/**
 * Protocole GRBL 1.1 (graveurs laser, traceurs, petites fraiseuses) : fonctions pures, sans DOM ni port série.
 * Référence : https://github.com/gnea/grbl/wiki (Interface, Laser Mode), licence GPL pour le micrologiciel ;
 * rien n'en est copié ici, seul le protocole texte est suivi.
 */

/** Commandes temps réel : un octet, hors file, sans réponse `ok`. */
export const RT = { STATUS: 0x3f, HOLD: 0x21, RESUME: 0x7e, RESET: 0x18, JOG_CANCEL: 0x85 } as const;

/** Tampon de réception de GRBL (127 octets), avec une marge. */
export const RX_BUFFER = 120;
/** Longueur maximale d'une ligne acceptée par GRBL (fin de ligne exclue). */
export const MAX_LINE = 79;

export type Vec3 = [number, number, number];

export type GrblReport = {
  /** `Idle`, `Run`, `Hold`, `Jog`, `Alarm`, `Door`, `Check`, `Home`, `Sleep`. */
  state: string;
  sub: number | null;
  mpos?: Vec3;
  wpos?: Vec3;
  wco?: Vec3;
  feed?: number;
  power?: number;
  buffer?: { planner: number; rx: number };
  pins?: string;
};

export type GrblMessage =
  | { type: "ok" }
  | { type: "error"; code: number; message: string }
  | { type: "alarm"; code: number; message: string }
  | { type: "status"; report: GrblReport }
  | { type: "welcome"; version: string }
  | { type: "setting"; id: number; value: number }
  | { type: "info"; tag: string; text: string }
  | { type: "other"; text: string };

const ERRORS: Record<number, string> = {
  1: "lettre de commande manquante", 2: "valeur numérique invalide", 3: "commande $ inconnue", 4: "valeur négative refusée",
  5: "prise d'origine (homing) désactivée", 6: "impulsion de pas trop courte", 7: "lecture des réglages impossible",
  8: "commande $ refusée pendant un mouvement", 9: "machine verrouillée (alarme ou déplacement manuel en cours)",
  10: "limites logicielles impossibles sans prise d'origine", 11: "ligne trop longue", 12: "réglage hors de la plage admise",
  13: "porte de sécurité ouverte", 15: "déplacement manuel hors de la zone de travail", 16: "commande de déplacement manuel invalide",
  17: "mode laser impossible sans sortie PWM", 20: "commande G-code inconnue", 21: "commandes incompatibles sur la même ligne",
  22: "vitesse d'avance non définie", 23: "valeur entière attendue", 24: "plusieurs commandes à axes sur la même ligne",
  25: "mot répété sur la ligne", 26: "axes manquants", 27: "numéro de ligne invalide", 28: "valeur manquante",
  29: "système de coordonnées non pris en charge", 30: "G53 hors G0 / G1", 31: "axes inutiles sur la ligne", 32: "arc sans axe",
  33: "cible du mouvement invalide", 34: "rayon d'arc invalide", 35: "arc sans centre", 36: "mots inutilisés sur la ligne",
  37: "compensation de longueur d'outil invalide", 38: "numéro d'outil trop grand",
};

const ALARMS: Record<number, string> = {
  1: "fin de course atteinte : position perdue", 2: "mouvement hors de la zone de travail", 3: "arrêt pendant un mouvement : position peut-être perdue",
  4: "palpeur dans un état inattendu", 5: "palpeur sans contact", 6: "prise d'origine interrompue", 7: "prise d'origine : porte ouverte",
  8: "prise d'origine : fin de course non dégagée", 9: "prise d'origine : fin de course introuvable",
};

export const grblErrorMessage = (code: number): string => ERRORS[code] ?? `erreur GRBL ${code}`;
export const grblAlarmMessage = (code: number): string => ALARMS[code] ?? `alarme GRBL ${code}`;

const vec = (s: string): Vec3 | undefined => {
  const n = s.split(",").map(Number);
  return n.length >= 2 && n.every(Number.isFinite) ? [n[0], n[1], n[2] ?? 0] : undefined;
};

/** `<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:…>` → rapport ; `null` si la ligne n'en est pas un. */
export function parseStatus(line: string): GrblReport | null {
  const m = /^<([A-Za-z]+)(?::(\d+))?((?:\|[^|>]*)*)>$/.exec(line.trim());
  if (!m) return null;
  const report: GrblReport = { state: m[1], sub: m[2] !== undefined ? Number(m[2]) : null };
  for (const field of m[3].split("|")) {
    const at = field.indexOf(":");
    if (at < 0) continue;
    const key = field.slice(0, at);
    const value = field.slice(at + 1);
    if (key === "MPos") report.mpos = vec(value);
    else if (key === "WPos") report.wpos = vec(value);
    else if (key === "WCO") report.wco = vec(value);
    else if (key === "FS" || key === "F") {
      const n = value.split(",").map(Number);
      if (Number.isFinite(n[0])) report.feed = n[0];
      if (Number.isFinite(n[1])) report.power = n[1];
    } else if (key === "Bf") {
      const n = value.split(",").map(Number);
      if (n.length === 2 && n.every(Number.isFinite)) report.buffer = { planner: n[0], rx: n[1] };
    } else if (key === "Pn") report.pins = value;
  }
  return report;
}

export function parseGrblLine(raw: string): GrblMessage {
  const line = raw.trim();
  if (line === "ok") return { type: "ok" };
  let m = /^error:(\d+)$/i.exec(line);
  if (m) return { type: "error", code: Number(m[1]), message: grblErrorMessage(Number(m[1])) };
  m = /^ALARM:(\d+)$/i.exec(line);
  if (m) return { type: "alarm", code: Number(m[1]), message: grblAlarmMessage(Number(m[1])) };
  if (line.startsWith("<")) {
    const report = parseStatus(line);
    if (report) return { type: "status", report };
  }
  m = /^Grbl\s*([0-9][0-9A-Za-z.]*)/i.exec(line);
  if (m) return { type: "welcome", version: m[1] };
  m = /^\$(\d+)=(-?\d+(?:\.\d+)?)/.exec(line);
  if (m) return { type: "setting", id: Number(m[1]), value: Number(m[2]) };
  m = /^\[([A-Za-z0-9.]+):(.*)\]$/.exec(line);
  if (m) return { type: "info", tag: m[1], text: m[2] };
  return { type: "other", text: line.slice(0, 200) };
}

/** Retire commentaires et espaces, passe en majuscules. Chaîne vide pour une ligne sans commande. */
export function cleanLine(raw: string): string {
  return raw.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").replace(/\s+/g, "").toUpperCase();
}

const SAFE_DOLLAR = new Set(["$", "$$", "$#", "$G", "$I", "$N", "$C", "$X", "$H"]);

/**
 * Une ligne (déjà nettoyée) peut-elle partir vers la machine ? `null` si oui, sinon la raison.
 * Refusés : écriture de réglages (`$n=`, sauf `settings`), remise à zéro d'usine (`$RST`), lignes de
 * démarrage (`$N0=`), mise en veille, et tout caractère hors G-code.
 */
export function checkLine(line: string, opts: { settings?: boolean; dollar?: boolean } = {}): string | null {
  if (!line) return "ligne vide";
  if (line.length > MAX_LINE) return `ligne trop longue (${line.length} caractères, ${MAX_LINE} au plus)`;
  if (line.startsWith("$")) {
    if (opts.dollar === false) return "commande $ refusée dans une tâche";
    if (SAFE_DOLLAR.has(line)) return null;
    if (/^\$J=[A-Z0-9.+-]+$/.test(line)) return null;
    if (/^\$\d+=-?\d+(\.\d+)?$/.test(line)) return opts.settings ? null : "écriture de réglage refusée (allow-settings absent)";
    return "commande $ refusée";
  }
  if (!/^[A-Z0-9.+-]+$/.test(line)) return "caractère hors G-code";
  if (!/^[A-Z]/.test(line)) return "ligne G-code invalide";
  return null;
}

/** Nombre G-code : 3 décimales au plus, sans zéros de fin. */
export function num(v: number): string {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

export type GcodeStats = {
  lines: number;
  /** Emprise des mouvements, en mm ; `null` sans mouvement. */
  bbox: { x: number; y: number; w: number; h: number } | null;
  maxS: number;
  burnMm: number;
  travelMm: number;
  /** Durée estimée en secondes (sans les accélérations). */
  estimateS: number;
  hasM3: boolean;
  relative: boolean;
  inches: boolean;
};

/** Lecture modale minimale d'un programme (lignes nettoyées) : emprise, puissance maximale, distances, durée. */
export function analyzeGcode(lines: string[], travelFeed = 3000): GcodeStats {
  let x = 0, y = 0, abs = true, motion = 0, feed = 0, s = 0, laserOn = false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const stats: GcodeStats = { lines: lines.length, bbox: null, maxS: 0, burnMm: 0, travelMm: 0, estimateS: 0, hasM3: false, relative: false, inches: false };
  const re = /([A-Z])([+-]?(?:\d+\.?\d*|\.\d+))/g;
  for (const line of lines) {
    if (line.startsWith("$")) continue;
    let nx: number | null = null, ny: number | null = null;
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const v = Number(m[2]);
      switch (m[1]) {
        case "G":
          if (v === 0 || v === 1 || v === 2 || v === 3) motion = v;
          else if (v === 90) abs = true;
          else if (v === 91) { abs = false; stats.relative = true; }
          else if (v === 20) stats.inches = true;
          break;
        case "M":
          if (v === 3) { stats.hasM3 = true; laserOn = true; }
          else if (v === 4) laserOn = true;
          else if (v === 5) laserOn = false;
          break;
        case "X": nx = v; break;
        case "Y": ny = v; break;
        case "F": feed = v; break;
        case "S": s = v; if (v > stats.maxS) stats.maxS = v; break;
      }
    }
    if (nx === null && ny === null) continue;
    const tx = nx === null ? x : abs ? nx : x + nx;
    const ty = ny === null ? y : abs ? ny : y + ny;
    const d = Math.hypot(tx - x, ty - y);
    const burning = motion !== 0 && laserOn && s > 0;
    if (burning) stats.burnMm += d;
    else stats.travelMm += d;
    const f = motion === 0 ? travelFeed : feed > 0 ? feed : travelFeed;
    stats.estimateS += (d / f) * 60;
    x = tx;
    y = ty;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (Number.isFinite(minX)) stats.bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  stats.burnMm = Math.round(stats.burnMm * 10) / 10;
  stats.travelMm = Math.round(stats.travelMm * 10) / 10;
  stats.estimateS = Math.round(stats.estimateS);
  return stats;
}

export type PrepareOptions = {
  /** `laser` : M3 (puissance constante, faisceau allumé à l'arrêt) remplacé par M4 (puissance dynamique). */
  tool: "laser" | "pen";
  /** Valeur S maximale admise (plafond de puissance) ; `0` : pas de plafond. */
  maxS: number;
  maxLines?: number;
};

export type PreparedJob = { lines: string[]; issues: string[]; error: string | null };

/** Texte ou lignes d'un programme → lignes prêtes à l'envoi, vérifiées une à une. */
export function prepareJob(source: string | string[], opts: PrepareOptions): PreparedJob {
  const raw = typeof source === "string" ? source.split(/\r?\n/) : source;
  const max = opts.maxLines ?? 500_000;
  const lines: string[] = [];
  const issues: string[] = [];
  let m3 = 0, capped = 0;
  for (let i = 0; i < raw.length; i++) {
    let line = cleanLine(String(raw[i]));
    if (!line || line === "%") continue;
    const refusal = checkLine(line, { dollar: false });
    if (refusal) return { lines: [], issues, error: `ligne ${i + 1} : ${refusal}` };
    if (opts.tool === "laser" && /M0*3(?!\d)/.test(line)) {
      line = line.replace(/M0*3(?!\d)/g, "M4");
      m3++;
    }
    if (opts.maxS > 0) {
      line = line.replace(/S([+-]?(?:\d+\.?\d*|\.\d+))/g, (all, v: string) => {
        if (Number(v) <= opts.maxS) return all;
        capped++;
        return `S${num(opts.maxS)}`;
      });
    }
    lines.push(line);
    if (lines.length > max) return { lines: [], issues, error: `programme trop long (${max} lignes au plus)` };
  }
  if (m3) issues.push(`M3 remplacé par M4 sur ${m3} ligne(s) : le faisceau se coupe quand le mouvement s'arrête`);
  if (capped) issues.push(`puissance ramenée au plafond sur ${capped} ligne(s)`);
  if (!lines.length) return { lines: [], issues, error: "programme vide" };
  return { lines, issues, error: null };
}
