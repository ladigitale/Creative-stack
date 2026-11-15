/**
 * Pilotage des instances nommées d'un `monde` par la clé `nodes` (format partagé) :
 *
 * - `nodes.<instance>` : `x y z` (mètres), `rx ry rz` (radians), `scale`, `visible`, `opacity`, `ease`, `lift`
 *   (position et orientation de l'instance), `clip`, `clipSpeed`, `clipT` (animation), `roles` (couleurs) ;
 * - `nodes.<instance>_<pièce>` : surcharge d'une pièce (`visible`, `color`, `opacity`, …) laissée au rendu ;
 * - `nodes.<instance>.on` : `"<appui>"` ou `"<appui>@<surface>"` pose l'instance sur une autre (avec `at: [x, z]`
 *   depuis le centre de la surface, `ease`, `lift`), `null` la détache sur place. Une instance posée suit son appui
 *   (position, cap, échelle uniforme) ; lui donner `x`, `y` ou `z` la détache ;
 * - `nodes.<instance>.move` : `[x, z]` range l'instance au point visé (voir arrange.ts) : appui choisi selon sa nature,
 *   aimantation aux murs, aux voisins et à la grille, place libre la plus proche si elle gêne. `ease` anime le trajet.
 *   Le résultat (`placed`) dit où elle est et si la pose est valide.
 *
 * Commun aux deux rendus : la même suite de patchs donne la même pose et le même clip en 2D et en 3D.
 */
import { easeCurve, isNum, patchOf, type NodeCurve, type NodePatch } from "../nodes";
import { isColor, type Conflict, type Model, type Monde, type Placement } from "./format";
import { findAll, type Obb } from "./collide";
import { clipState, samplePose, setClip, STRIDE, type ClipState } from "./pose";
import { boundsOf, DEFAULT_BOUNDS, localOn, surfaceOf, turnY } from "./supports";
import { arrange, type Arranged, type ArrangeOptions, type Body } from "./arrange";

/** Canaux de transformation d'une instance. */
const CH = ["x", "y", "z", "rx", "ry", "rz", "sx", "sy", "sz", "opacity"] as const;
type Ch = (typeof CH)[number];

export type InstanceState = {
  name: string;
  model: Model;
  placement: Placement;
  clip: ClipState;
  /** Couleurs par rôle (placement puis patchs). */
  roles: Record<string, string>;
  /** Incrémenté à chaque changement de couleur. */
  rolesRev: number;
  /** Décalages de pose courants (parts × STRIDE). */
  offs: Float32Array;
  /** Pose à recalculer (patch, nouveau monde). */
  poseDirty: boolean;
  /** Le clip bouge encore (bouclé, en cours, fondu). */
  active: boolean;
  /** Pose recalculée depuis le dernier rendu : à reporter sur les pièces. */
  poseChanged: boolean;
  /** Transformation de l'instance (repère monde). */
  t: Record<Ch, number>;
  visible: boolean;
  transformDirty: boolean;
  tween: { start: number; ms: number; curve: NodeCurve; keys: Ch[]; from: Partial<Record<Ch, number>>; to: Partial<Record<Ch, number>>; lift: number } | null;
  /** Hauteur ajoutée par `lift` à l'instant courant. */
  liftY: number;
  /** Posée sur une autre instance : position dans le repère de l'appui, cap propre, glissement en cours. */
  carry: Carry | null;
  /** Dernier rangement demandé par `move` ou par un glisser (voir arrange.ts). */
  placed: Arranged | null;
  /** Position tenue par le pilote depuis un rangement (le rendu la recopie, même s'il gère d'habitude les positions). */
  driven: boolean;
};

export type Carry = {
  support: string;
  surface: string;
  local: [number, number, number];
  yaw: number;
  /** Rang dans la chaîne d'appuis (un livre sur une boîte sur une table : 2). */
  depth: number;
  move: { start: number; ms: number; curve: NodeCurve; from: [number, number, number]; to: [number, number, number]; lift: number } | null;
};

export type PatchResult = { pose: boolean; roles: boolean; transform: boolean };

export class MondeDriver {
  monde: Monde | null = null;
  readonly instances = new Map<string, InstanceState>();

  /** Nouveau monde : les instances de même nom et même modèle gardent leur état (position, clip, couleurs). */
  setMonde(m: Monde, now: number): void {
    const old = this.instances;
    const next = new Map<string, InstanceState>();
    for (const pl of m.place) {
      if (!pl.name) continue;
      const model = m.models.get(pl.model);
      if (!model) continue;
      const prev = old.get(pl.name);
      if (prev && prev.model.name === model.name && prev.model.parts.length === model.parts.length) {
        // ce que le JSON change pour cette instance est appliqué ; le reste (pilotage par nodes) est gardé
        const pp = prev.placement;
        if (JSON.stringify(pp.on ?? null) !== JSON.stringify(pl.on ?? null)) prev.carry = pl.on ? { ...pl.on, local: [...pl.on.local], depth: 0, move: null } : null;
        if (JSON.stringify([pp.at, pp.rot, pp.scale]) !== JSON.stringify([pl.at, pl.rot, pl.scale])) {
          Object.assign(prev.t, { x: pl.at[0], y: pl.at[1], z: pl.at[2], rx: pl.rot[0], ry: pl.rot[1], rz: pl.rot[2], sx: pl.scale[0], sy: pl.scale[1], sz: pl.scale[2] });
          prev.tween = null;
          prev.liftY = 0;
          prev.transformDirty = true;
        }
        if (JSON.stringify(pp.roles) !== JSON.stringify(pl.roles)) {
          prev.roles = { ...pl.roles };
          prev.rolesRev++;
        }
        if (pp.hidden !== pl.hidden) prev.visible = !pl.hidden;
        if (pp.clip !== pl.clip) setClip(prev.clip, now, pl.clip || model.clip);
        prev.model = model;
        prev.placement = pl;
        prev.poseDirty = true;
        if (prev.offs.length !== model.parts.length * STRIDE) prev.offs = new Float32Array(model.parts.length * STRIDE);
        next.set(pl.name, prev);
        continue;
      }
      const s = pl.scale;
      next.set(pl.name, {
        name: pl.name,
        model,
        placement: pl,
        clip: clipState(pl.clip || model.clip, now),
        roles: { ...pl.roles },
        rolesRev: 0,
        offs: new Float32Array(model.parts.length * STRIDE),
        poseDirty: true,
        active: true,
        poseChanged: false,
        t: { x: pl.at[0], y: pl.at[1], z: pl.at[2], rx: pl.rot[0], ry: pl.rot[1], rz: pl.rot[2], sx: s[0], sy: s[1], sz: s[2], opacity: 1 },
        visible: !pl.hidden,
        transformDirty: true,
        tween: null,
        liftY: 0,
        carry: pl.on ? { ...pl.on, local: [...pl.on.local], depth: 0, move: null } : null,
        placed: null,
        driven: false,
      });
    }
    this.instances.clear();
    for (const [k, v] of next) this.instances.set(k, v);
    this.monde = m;
    this.chain();
  }

  /** Instances posées, de l'appui vers l'objet posé (un appui est toujours traité avant ce qu'il porte). */
  private carried: InstanceState[] = [];
  get carriedInstances(): readonly InstanceState[] {
    return this.carried;
  }

  private chain(): void {
    const depthOf = (inst: InstanceState, guard: number): number => {
      const c = inst.carry;
      if (!c) return 0;
      const sup = this.instances.get(c.support);
      // appui disparu ou boucle : l'instance reste où elle est
      if (!sup || sup === inst || guard > 16) {
        inst.carry = null;
        return 0;
      }
      return (c.depth = depthOf(sup, guard + 1) + 1);
    };
    this.carried = [];
    for (const inst of this.instances.values()) if (depthOf(inst, 0) > 0) this.carried.push(inst);
    this.carried.sort((a, b) => a.carry!.depth - b.carry!.depth);
  }

  /** Objets de la scène à leur position courante (instances pilotées et décor), pour le rangement. */
  /**
   * Conflits de la scène telle qu'elle est maintenant (instances déplacées comprises) ; `null` si le monde ne cherche
   * pas les collisions. Les objets non rangés gardent les conflits d'appui relevés à la lecture (`hors-appui`).
   */
  collisions(): { conflicts: Conflict[]; marks: Obb[] } | null {
    const m = this.monde;
    if (!m || m.collide === "non") return null;
    const place: Placement[] = m.place.map((pl) => {
      const inst = pl.name ? this.instances.get(pl.name) : undefined;
      if (!inst) return pl;
      const t = inst.t;
      return { ...pl, hidden: !inst.visible, at: [t.x, t.y, t.z], rot: [t.rx, t.ry, t.rz], scale: [t.sx, t.sy, t.sz] };
    });
    const own = (base: string) => (Object.prototype.hasOwnProperty.call(m.prefabs, base) ? m.prefabs[base] : null);
    const found = findAll(place, m.models, { contour: m.contour, familleOf: (base) => own(base)?.famille ?? "", softOf: (base) => own(base)?.souple === true });
    const kept = m.conflicts.filter((c) => c.type === "hors-appui" && !this.instances.get(c.a)?.placed);
    return { conflicts: [...kept, ...found.conflicts], marks: m.collide === "montrer" ? found.marks : [] };
  }

  /** Vrai si l'instance peut être rangée ailleurs : ni élément de l'espace (murs, sols, plafond), ni ouverture. */
  movable(name: string): boolean {
    const inst = this.instances.get(name);
    if (!inst || !this.monde) return false;
    const model = inst.placement.model;
    if (model.startsWith("espace:")) return false;
    const base = model.split("~")[0];
    const p = Object.prototype.hasOwnProperty.call(this.monde.prefabs, base) ? this.monde.prefabs[base] : null;
    return p?.famille !== "ouverture";
  }

  bodies(): Body[] {
    const m = this.monde;
    if (!m) return [];
    const info = (model: string) => {
      const base = model.split("~")[0];
      const p = Object.prototype.hasOwnProperty.call(m.prefabs, base) ? m.prefabs[base] : null;
      return { base, famille: p?.famille ?? "", soft: p?.souple === true, pose: p?.pose ?? "" };
    };
    const out: Body[] = [];
    for (const inst of this.instances.values()) {
      if (!inst.visible) continue;
      const t = inst.t;
      out.push({ name: inst.name, model: inst.model, at: [t.x, t.y, t.z], rot: [t.rx, t.ry, t.rz], scale: [t.sx, t.sy, t.sz], support: inst.carry?.support ?? "", ...info(inst.placement.model) });
    }
    for (const pl of m.place) {
      if (pl.name || pl.hidden) continue;
      const model = m.models.get(pl.model);
      if (model) out.push({ name: "", model, at: pl.at, rot: pl.rot, scale: pl.scale, support: pl.on?.support ?? "", ...info(pl.model) });
    }
    return out;
  }

  /**
   * Range `name` au point visé (x, z) et applique la pose trouvée. `ms` > 0 : trajet animé. Rend le résultat
   * (aussi gardé dans `placed`), ou `null` si l'instance est inconnue.
   */
  arrangeTo(name: string, x: number, z: number, now: number, ms = 0, curve: NodeCurve = "inOut", opt: ArrangeOptions = {}): Arranged | null {
    const inst = this.instances.get(name);
    if (!inst || !this.monde || !this.movable(name)) return null;
    const res = arrange(this.bodies(), name, x, z, { contour: this.monde.contour, ...opt });
    if (!res) return null;
    inst.placed = res;
    inst.driven = true;
    const sup = res.carry ? this.instances.get(res.carry.support) : undefined;
    if (res.carry && sup) {
      const k = sup.t.sx || 1;
      const [fx, fz] = turnY(inst.t.x - sup.t.x, inst.t.z - sup.t.z, -sup.t.ry);
      const from: [number, number, number] = [fx / k, (inst.t.y - sup.t.y) / k, fz / k];
      inst.carry = { ...res.carry, local: ms > 0 ? from : [...res.carry.local], depth: 0, move: ms > 0 ? { start: now, ms, curve, from, to: [...res.carry.local], lift: 0 } : null };
      inst.tween = null;
    } else {
      inst.carry = null;
      const to = { x: res.at[0], y: res.at[1], z: res.at[2], ry: res.ry };
      if (ms > 0) inst.tween = { start: now, ms, curve, keys: ["x", "y", "z", "ry"], from: { x: inst.t.x, y: inst.t.y, z: inst.t.z, ry: inst.t.ry }, to, lift: 0 };
      else {
        Object.assign(inst.t, to);
        inst.tween = null;
      }
    }
    inst.liftY = 0;
    inst.transformDirty = true;
    this.chain();
    return res;
  }

  /** Pose `inst` sur une surface d'une autre instance (`at` : [x, z] depuis le centre, ramené dans le contour). */
  private attach(inst: InstanceState, on: string, at: unknown, now: number, ms: number, curve: NodeCurve, lift: number): boolean {
    const [supName, surface = "top"] = on.split("@");
    const sup = this.instances.get(supName);
    if (!sup || sup === inst) return false;
    const s = surfaceOf(sup.model, surface || "top");
    if (!s) return false;
    const b = boundsOf(inst.model) ?? DEFAULT_BOUNDS;
    const k = sup.t.sx || 1;
    const a = Array.isArray(at) ? at : [];
    const to = localOn(s, b, [inst.t.sx, inst.t.sy, inst.t.sz], k, [isNum(a[0]) ? a[0] : 0, isNum(a[a.length > 2 ? 2 : 1]) ? (a[a.length > 2 ? 2 : 1] as number) : 0], 0, inst.t.ry - sup.t.ry).local;
    // position actuelle exprimée dans le repère du nouvel appui : le déplacement part d'où est l'objet
    const [fx, fz] = turnY(inst.t.x - sup.t.x, inst.t.z - sup.t.z, -sup.t.ry);
    const from: [number, number, number] = [fx / k, (inst.t.y - sup.t.y) / k, fz / k];
    inst.carry = { support: supName, surface: surface || "top", local: ms > 0 ? from : to, yaw: inst.t.ry - sup.t.ry, depth: 0, move: ms > 0 ? { start: now, ms, curve, from, to, lift } : null };
    inst.tween = null;
    inst.liftY = 0;
    inst.transformDirty = true;
    this.chain();
    return true;
  }

  /**
   * Applique un patch à une instance. `transforms` : le rendu laisse le pilote gérer position / orientation
   * (sinon il les applique lui-même, comme `sonic-3d` sur ses nœuds glTF).
   */
  apply(name: string, raw: unknown, now: number, animate: boolean, transforms: boolean): PatchResult | null {
    const inst = this.instances.get(name);
    if (!inst) return null;
    const p = patchOf(raw) as NodePatch | null;
    const res: PatchResult = { pose: false, roles: false, transform: false };
    if (!p) return res;
    const fixed = p.clipT === null ? null : isNum(p.clipT) ? Math.max(0, Math.min(1, p.clipT)) : undefined;
    if (setClip(inst.clip, now, typeof p.clip === "string" ? p.clip : undefined, isNum(p.clipSpeed) ? p.clipSpeed : undefined, fixed)) {
      inst.poseDirty = true;
      res.pose = true;
    }
    if (p.roles && typeof p.roles === "object") {
      let changed = false;
      for (const [k, v] of Object.entries(p.roles)) {
        if (isColor(v) && Object.prototype.hasOwnProperty.call(inst.model.roles, k) && inst.roles[k] !== v) {
          inst.roles[k] = v;
          changed = true;
        }
      }
      if (changed) {
        inst.rolesRev++;
        res.roles = true;
      }
    }
    // Rangement : « mets-la ici », appui, aimantation et collisions décidés par arrange.ts
    const move = (raw as { move?: unknown } | null)?.move;
    if (Array.isArray(move) && isNum(move[0]) && isNum(move[move.length > 2 ? 2 : 1])) {
      const ms = animate && isNum(p.ease?.ms) ? Math.max(0, p.ease!.ms!) : 0;
      if (this.arrangeTo(name, move[0], move[move.length > 2 ? 2 : 1] as number, now, ms, p.ease?.curve ?? "inOut")) res.transform = true;
      return res;
    }
    // Appui : poser sur une autre instance, détacher, tourner sur place (vaut aussi quand le rendu gère les positions)
    const on = (raw as { on?: unknown } | null)?.on;
    if (typeof on === "string" && on) {
      const ms = animate && isNum(p.ease?.ms) ? Math.max(0, p.ease!.ms!) : 0;
      if (this.attach(inst, on, (raw as { at?: unknown }).at, now, ms, p.ease?.curve ?? "inOut", isNum(p.lift) ? p.lift : 0)) res.transform = true;
    } else if (isNum(p.x) || isNum(p.y) || isNum(p.z)) inst.driven = false;
    if (typeof on !== "string" && inst.carry && (on === null || isNum(p.x) || isNum(p.y) || isNum(p.z))) {
      // détachée sur place, ou parce qu'on lui donne une position
      inst.carry = null;
      this.chain();
    }
    if (inst.carry && isNum(p.ry)) {
      const sup = this.instances.get(inst.carry.support);
      inst.carry.yaw = p.ry - (sup ? sup.t.ry : 0);
      inst.transformDirty = true;
      res.transform = true;
    }
    if (!transforms) return res;
    const to: Partial<Record<Ch, number>> = {};
    for (const k of ["x", "y", "z", "rx", "ry", "rz", "opacity"] as const) if (isNum(p[k])) to[k] = p[k] as number;
    if (isNum(p.scale)) to.sx = to.sy = to.sz = p.scale;
    else if (Array.isArray(p.scale) && p.scale.every(isNum)) [to.sx, to.sy, to.sz] = p.scale as [number, number, number];
    if (typeof p.visible === "boolean" && p.visible !== inst.visible) {
      inst.visible = p.visible;
      res.transform = true;
    }
    if (inst.carry) {
      // posée : position et cap viennent de l'appui
      delete to.x;
      delete to.y;
      delete to.z;
      delete to.ry;
    }
    const keys = Object.keys(to) as Ch[];
    if (keys.length) {
      const ms = isNum(p.ease?.ms) ? Math.max(0, p.ease!.ms!) : 0;
      if (animate && ms > 0) {
        const from: Partial<Record<Ch, number>> = {};
        for (const k of keys) from[k] = inst.t[k];
        // un tween en cours est figé à sa valeur courante avant d'en lancer un autre
        inst.tween = { start: now, ms, curve: p.ease?.curve ?? "linear", keys, from, to, lift: isNum(p.lift) ? p.lift : 0 };
      } else {
        for (const k of keys) inst.t[k] = to[k]!;
        inst.tween = null;
        inst.liftY = 0;
      }
      inst.transformDirty = true;
      res.transform = true;
    }
    return res;
  }

  /** Avance tweens et clips ; renvoie true si quelque chose bouge encore (le rendu doit redessiner). */
  step(now: number): boolean {
    let busy = false;
    for (const inst of this.instances.values()) {
      const tw = inst.tween;
      if (tw) {
        const u = Math.min(1, (now - tw.start) / tw.ms);
        const e = easeCurve(tw.curve, u);
        for (const k of tw.keys) inst.t[k] = tw.from[k]! + (tw.to[k]! - tw.from[k]!) * e;
        inst.liftY = tw.lift ? tw.lift * 4 * u * (1 - u) : 0;
        inst.transformDirty = true;
        if (u >= 1) {
          inst.tween = null;
          inst.liftY = 0;
        } else busy = true;
      }
      if (inst.poseDirty || inst.active) {
        inst.active = samplePose(inst.model, inst.clip, now, inst.offs);
        inst.poseDirty = false;
        inst.poseChanged = true;
        if (inst.active) busy = true;
      }
    }
    // Les instances posées suivent leur appui (position, cap, échelle uniforme), de proche en proche
    for (const inst of this.carried) {
      const c = inst.carry;
      const sup = c ? this.instances.get(c.support) : undefined;
      if (!c || !sup) continue;
      let lift = 0;
      if (c.move) {
        const u = Math.min(1, (now - c.move.start) / c.move.ms);
        const e = easeCurve(c.move.curve, u);
        for (let a = 0; a < 3; a++) c.local[a] = c.move.from[a] + (c.move.to[a] - c.move.from[a]) * e;
        lift = c.move.lift ? c.move.lift * 4 * u * (1 - u) : 0;
        if (u >= 1) c.move = null;
        else busy = true;
        inst.transformDirty = true;
      }
      if (!sup.transformDirty && !inst.transformDirty) continue;
      const k = sup.t.sx || 1;
      const [dx, dz] = turnY(c.local[0] * k, c.local[2] * k, sup.t.ry);
      inst.t.x = sup.t.x + dx;
      inst.t.y = sup.t.y + sup.liftY + c.local[1] * k;
      inst.t.z = sup.t.z + dz;
      inst.t.ry = sup.t.ry + c.yaw;
      inst.liftY = lift;
      inst.transformDirty = true;
    }
    return busy;
  }
}
