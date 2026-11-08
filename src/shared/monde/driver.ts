/**
 * Pilotage des instances nommées d'un `monde` par la clé `nodes` (format partagé) :
 *
 * - `nodes.<instance>` : `x y z` (mètres), `rx ry rz` (radians), `scale`, `visible`, `opacity`, `ease`, `lift`
 *   (position et orientation de l'instance), `clip`, `clipSpeed`, `clipT` (animation), `roles` (couleurs) ;
 * - `nodes.<instance>_<pièce>` : surcharge d'une pièce (`visible`, `color`, `opacity`, …) laissée au rendu.
 *
 * Commun aux deux rendus : la même suite de patchs donne la même pose et le même clip en 2D et en 3D.
 */
import { easeCurve, isNum, patchOf, type NodeCurve, type NodePatch } from "../nodes";
import type { Model, Monde, Placement } from "./format";
import { clipState, samplePose, setClip, STRIDE, type ClipState } from "./pose";

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
  tween: { start: number; ms: number; curve: NodeCurve; from: Partial<Record<Ch, number>>; to: Partial<Record<Ch, number>>; lift: number } | null;
  /** Hauteur ajoutée par `lift` à l'instant courant. */
  liftY: number;
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
      });
    }
    this.instances.clear();
    for (const [k, v] of next) this.instances.set(k, v);
    this.monde = m;
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
        if (typeof v === "string" && inst.roles[k] !== v) {
          inst.roles[k] = v;
          changed = true;
        }
      }
      if (changed) {
        inst.rolesRev++;
        res.roles = true;
      }
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
    const keys = Object.keys(to) as Ch[];
    if (keys.length) {
      const ms = isNum(p.ease?.ms) ? Math.max(0, p.ease!.ms!) : 0;
      if (animate && ms > 0) {
        const from: Partial<Record<Ch, number>> = {};
        for (const k of keys) from[k] = inst.t[k];
        // un tween en cours est figé à sa valeur courante avant d'en lancer un autre
        inst.tween = { start: now, ms, curve: p.ease?.curve ?? "linear", from, to, lift: isNum(p.lift) ? p.lift : 0 };
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
        for (const k of Object.keys(tw.to) as Ch[]) inst.t[k] = tw.from[k]! + (tw.to[k]! - tw.from[k]!) * e;
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
    return busy;
  }
}
