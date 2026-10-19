/**
 * Validation des descripteurs d'animation, pensée pour les agents : chaque problème porte
 * un chemin, le champ fautif, un message et une correction proposée (`fix`).
 * Pur (aucun accès au DOM) : utilisable côté serveur, dans le validateur d'artefacts de Tadaaa.
 */
import { LIMITS, compileTimeline, isAnimatableProp } from "./timeline-core";
import type { AnimationIssue, TimelineDescriptor, TimelineNode } from "./types";

const EASES = ["linear", "easeIn", "easeOut", "easeInOut"];
const TYPES = ["tween", "text", "seq", "par", "stagger", "set", "label"];
const OUT_OF_RANGE = ["clamp", "wrap"];

type Ctx = { issues: AnimationIssue[]; ids: Set<string> | null; timeSource: string; targetsSeen: string[] };

const issue = (ctx: Ctx, path: string, field: string, message: string, fix: string) =>
  ctx.issues.push({ path, field, message, fix });

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Id du DataProvider d'un chemin pointé (`clock-main.t` → `clock-main`). */
export function dpIdOf(path: string): string {
  return String(path ?? "").split(".")[0];
}

function checkEase(ctx: Ctx, path: string, ease: unknown) {
  if (ease === undefined) return;
  if (typeof ease === "string" && EASES.includes(ease)) return;
  if (Array.isArray(ease) && ease.length === 4 && ease.every(isNum)) return;
  issue(ctx, path, "ease", `ease « ${JSON.stringify(ease)} » inconnu.`, `Utilise ${EASES.join(", ")} ou un tableau [x1, y1, x2, y2].`);
}

function checkTargets(ctx: Ctx, path: string, targets: unknown) {
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === "string" && t)) {
    issue(ctx, path, "targets", "targets doit être un tableau non vide de chaînes.", 'Écris par exemple "targets": ["title"].');
    return;
  }
  if (targets.length > LIMITS.maxTargets) {
    issue(ctx, path, "targets", `Plus de ${LIMITS.maxTargets} cibles.`, `Utilise "children:<nodeId>" ou "group:<nom>" au lieu d'énumérer les cibles.`);
  }
  for (const t of targets as string[]) {
    ctx.targetsSeen.push(t);
    if (!ctx.ids) continue;
    const m = /^(children|group):(.+)$/.exec(t);
    if (m && m[1] === "group") continue; // les groupes ne se vérifient pas statiquement
    const id = m ? m[2] : t;
    if (id === "@self") continue;
    if (!ctx.ids.has(id)) {
      issue(ctx, path, "targets", `La cible « ${id} » n'existe pas dans le descripteur.`, `Ajoute "nodeId": "${id}" (et "attributes": {"id": "${id}"}) au nœud à animer, ou corrige l'orthographe.`);
    }
  }
}

function walk(ctx: Ctx, node: unknown, path: string, depth: number) {
  if (!node || typeof node !== "object") {
    issue(ctx, path, "node", "Nœud absent ou invalide.", 'Un nœud est un objet avec un champ "type".');
    return;
  }
  if (depth > LIMITS.maxDepth) {
    issue(ctx, path, "depth", `Arbre plus profond que ${LIMITS.maxDepth} niveaux.`, "Aplatis la structure (par exemple avec un seul seq contenant des par).");
    return;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.type !== "string" || !TYPES.includes(n.type)) {
    issue(ctx, path, "type", `type « ${String(n.type)} » inconnu.`, `Utilise ${TYPES.join(", ")}.`);
    return;
  }
  switch (n.type) {
    case "tween": {
      checkTargets(ctx, `${path}.targets`, n.targets);
      const props = n.props as Record<string, unknown> | undefined;
      if (!props || typeof props !== "object" || Object.keys(props).length === 0) {
        issue(ctx, `${path}.props`, "props", "props est vide ou absent.", 'Écris par exemple "props": {"opacity": [0, 1]}.');
      } else {
        for (const [k, v] of Object.entries(props)) {
          const p = `${path}.props.${k}`;
          if (!isAnimatableProp(k)) {
            const unitHint = /^(width|height|top|left|right|bottom)$/.test(k) ? " (propriété de mise en page, trop coûteuse en v1)" : "";
            issue(ctx, p, k, `Propriété « ${k} » non animable${unitHint}.`, 'Utilise opacity, x, y, scale, rotate, blur, ou une variable CSS "--nom".');
          } else if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) {
            issue(ctx, p, k, `Valeurs de « ${k} » invalides : ${JSON.stringify(v)}.`, `Écris deux nombres [départ, arrivée] sans unité, par exemple "${k}": [0, 1].`);
          }
        }
      }
      for (const f of ["duration", "delay"] as const) {
        if (n[f] !== undefined && (!isNum(n[f]) || (n[f] as number) < 0)) {
          issue(ctx, `${path}.${f}`, f, `${f} doit être un nombre de secondes ≥ 0.`, `Écris "${f}": 0.5.`);
        }
      }
      checkEase(ctx, `${path}.ease`, n.ease);
      break;
    }
    case "text": {
      checkTargets(ctx, `${path}.targets`, n.targets);
      if (n.mode !== "count" && n.mode !== "type") {
        issue(ctx, `${path}.mode`, "mode", `mode « ${String(n.mode)} » inconnu.`, 'Utilise "count" ou "type".');
      }
      if (n.mode === "count" && (!isNum(n.from) || !isNum(n.to))) {
        issue(ctx, path, "from/to", 'Un texte "count" demande from et to numériques.', 'Écris "from": 0, "to": 1200.');
      }
      checkEase(ctx, `${path}.ease`, n.ease);
      break;
    }
    case "seq":
    case "par":
    case "stagger": {
      if (!Array.isArray(n.nodes) || n.nodes.length === 0) {
        issue(ctx, `${path}.nodes`, "nodes", `${n.type} sans enfants.`, 'Ajoute un tableau "nodes" avec au moins un nœud.');
        break;
      }
      if (n.type === "stagger" && n.each !== undefined && (!isNum(n.each) || (n.each as number) < 0)) {
        issue(ctx, `${path}.each`, "each", "each doit être un nombre de secondes ≥ 0.", 'Écris "each": 0.1.');
      }
      (n.nodes as unknown[]).forEach((c, i) => walk(ctx, c, `${path}.nodes[${i}]`, depth + 1));
      break;
    }
    case "set": {
      if (typeof n.path !== "string" || !n.path) {
        issue(ctx, `${path}.path`, "path", "set sans chemin DataProvider.", 'Écris "path": "mon-dp.valeur".');
      } else if (ctx.timeSource && dpIdOf(n.path) === dpIdOf(ctx.timeSource)) {
        issue(ctx, `${path}.path`, "path", `set écrit dans le DataProvider du temps (« ${dpIdOf(ctx.timeSource)} ») : boucle possible.`, "Écris dans un autre DataProvider que celui de timeSource.");
      }
      break;
    }
    case "label": {
      if (typeof n.name !== "string" || !n.name) {
        issue(ctx, `${path}.name`, "name", "label sans nom.", 'Écris "name": "intro".');
      }
      break;
    }
  }
}

/** Valide un descripteur de timeline. `knownIds` (optionnel) active la vérification des cibles. */
export function validateTimelineDescriptor(
  descriptor: unknown,
  options: { knownIds?: Iterable<string>; path?: string } = {},
): AnimationIssue[] {
  const base = options.path ?? "timeline";
  const ctx: Ctx = { issues: [], ids: options.knownIds ? new Set(options.knownIds) : null, timeSource: "", targetsSeen: [] };
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    issue(ctx, base, "descriptor", "Le descripteur doit être un objet JSON.", 'Écris {"timeSource": "clock-main.t", "root": {...}}.');
    return ctx.issues;
  }
  const d = descriptor as Partial<TimelineDescriptor>;
  if (d.timeSource !== undefined && (typeof d.timeSource !== "string" || !d.timeSource)) {
    issue(ctx, `${base}.timeSource`, "timeSource", "timeSource doit être un chemin DataProvider.", 'Écris "timeSource": "clock-main.t".');
  } else if (typeof d.timeSource === "string") ctx.timeSource = d.timeSource;
  if (d.outOfRange !== undefined && !OUT_OF_RANGE.includes(d.outOfRange as string)) {
    issue(ctx, `${base}.outOfRange`, "outOfRange", `outOfRange « ${String(d.outOfRange)} » inconnu.`, 'Utilise "clamp" ou "wrap".');
  }
  if (d.smooth !== undefined && (!isNum(d.smooth) || d.smooth < 0)) {
    issue(ctx, `${base}.smooth`, "smooth", "smooth doit être un nombre ≥ 0.", 'Écris "smooth": 0.08 (secondes) ou 0.');
  }
  if (d.duration !== undefined && (!isNum(d.duration) || d.duration <= 0 || d.duration > LIMITS.maxDuration)) {
    issue(ctx, `${base}.duration`, "duration", `duration doit être entre 0 et ${LIMITS.maxDuration} s.`, 'Écris "duration": 3.');
  }
  if (!d.root) {
    issue(ctx, `${base}.root`, "root", "root absent.", 'Ajoute "root": {"type": "seq", "nodes": [...]}.');
    return ctx.issues;
  }
  walk(ctx, d.root, `${base}.root`, 1);
  if (!ctx.issues.length) {
    const total = compileTimeline(d.root as TimelineNode).duration;
    if (total >= LIMITS.maxDuration) {
      issue(ctx, `${base}.root`, "duration", `Durée totale ≥ ${LIMITS.maxDuration} s.`, "Raccourcis les durées ou les délais.");
    }
  }
  return ctx.issues;
}

/* ------------------------------------------------- niveau document SDUI */

type SduiNodeLike = {
  tagName?: string;
  nodeId?: string;
  attributes?: Record<string, string>;
  nodes?: SduiNodeLike[];
  childNodeIds?: string[];
};
type SduiLike = { nodes?: SduiNodeLike[]; nodeById?: Record<string, SduiNodeLike>; library?: Record<string, SduiNodeLike> };

/** Identifiants adressables par une cible : `nodeId`, `attributes.id`, `attributes["data-node-id"]`. */
export function collectSduiIds(sdui: SduiLike): Set<string> {
  const ids = new Set<string>();
  const visit = (n: SduiNodeLike | undefined) => {
    if (!n || typeof n !== "object") return;
    if (n.nodeId) ids.add(n.nodeId);
    if (n.attributes?.id) ids.add(n.attributes.id);
    if (n.attributes?.["data-node-id"]) ids.add(n.attributes["data-node-id"]);
    (n.nodes ?? []).forEach(visit);
  };
  (sdui.nodes ?? []).forEach(visit);
  Object.values(sdui.nodeById ?? {}).forEach(visit);
  return ids;
}

function parseJsonAttr(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/**
 * Valide toute l'animation d'un descripteur SDUI : `sonic-timeline` (descripteur + cibles),
 * `sonic-animate` (recette, options), `sonic-clock` (un seul écrivain par DataProvider de temps).
 */
export function validateSduiAnimation(sdui: unknown): AnimationIssue[] {
  const issues: AnimationIssue[] = [];
  if (!sdui || typeof sdui !== "object") return issues;
  const doc = sdui as SduiLike;
  const ids = collectSduiIds(doc);
  const writers = new Map<string, string[]>();
  const recipes = ["reveal", "fade", "slide-up", "count-up", "typewriter"];

  const visit = (n: SduiNodeLike | undefined, path: string) => {
    if (!n || typeof n !== "object") return;
    const a = n.attributes ?? {};
    if (n.tagName === "sonic-timeline") {
      const raw = a.descriptor;
      const parsed = parseJsonAttr(raw);
      if (raw === undefined && !a["descriptor-dp"]) {
        issues.push({ path: `${path}.attributes`, field: "descriptor", message: "sonic-timeline sans descripteur.", fix: 'Ajoute l\'attribut "descriptor" (JSON en chaîne) ou "descriptor-dp".' });
      } else if (raw !== undefined && parsed === undefined) {
        issues.push({ path: `${path}.attributes.descriptor`, field: "descriptor", message: "descriptor n'est pas un JSON valide.", fix: "Fournis une chaîne JSON valide (guillemets doubles échappés)." });
      } else if (parsed !== undefined) {
        const d = parsed as TimelineDescriptor;
        if (!d.timeSource && !a["time-source"]) {
          issues.push({ path: `${path}.attributes`, field: "timeSource", message: "Aucun timeSource : la timeline ne bougera jamais.", fix: 'Ajoute "timeSource": "clock-main.t" au descripteur (ou l\'attribut "time-source").' });
        }
        issues.push(...validateTimelineDescriptor(parsed, { knownIds: ids, path: `${path}.attributes.descriptor` }));
      }
    } else if (n.tagName === "sonic-animate") {
      if (!recipes.includes(String(a.recipe))) {
        issues.push({ path: `${path}.attributes.recipe`, field: "recipe", message: `recipe « ${String(a.recipe)} » inconnue.`, fix: `Utilise ${recipes.join(", ")}.` });
      }
    } else if (n.tagName === "sonic-clock") {
      const dpId = a.dataProvider ?? a.dataprovider ?? a["data-provider"];
      if (!dpId) {
        issues.push({ path: `${path}.attributes`, field: "dataProvider", message: "sonic-clock sans dataProvider.", fix: 'Ajoute "dataProvider": "clock-main".' });
      } else writers.set(dpId, [...(writers.get(dpId) ?? []), path]);
    }
    (n.nodes ?? []).forEach((c, i) => visit(c, `${path}.nodes[${i}]`));
  };
  (doc.nodes ?? []).forEach((n, i) => visit(n, `nodes[${i}]`));
  for (const [dpId, paths] of writers) {
    if (paths.length > 1) {
      issues.push({ path: paths[1], field: "dataProvider", message: `Deux horloges écrivent dans « ${dpId} » (${paths.join(", ")}).`, fix: "Donne un dataProvider différent à chaque sonic-clock." });
    }
  }
  return issues;
}
