/**
 * Pilotage des instances nommées d'un `monde2d` par `nodes` (format partagé) :
 * `nodes.<instance>` = `x y` (px), `rz` (rad), `scale`, `opacity`, `visible`, `z`, `flip`, `ease`, `lift` (saut en
 * arc), `clip`, `clipSpeed`, `clipT`, `roles` ; `nodes.<instance>_<pièce>` = `visible`, `color`, `opacity`.
 */
import { easeCurve, isNum, patchOf, type NodeCurve, type NodePatch } from "../nodes";
import { isColor } from "../monde/format";
import { clipState, sampleClips, setClip, type ClipState } from "../monde/pose";
import { MULT2, STRIDE2, type Model2, type Monde2d, type Placement2 } from "./format";

const CH = ["x", "y", "rz", "sx", "sy", "opacity"] as const;
type Ch = (typeof CH)[number];

export type Inst2 = {
  name: string;
  model: Model2;
  placement: Placement2;
  clip: ClipState;
  roles: Record<string, string>;
  rolesRev: number;
  offs: Float32Array;
  poseDirty: boolean;
  active: boolean;
  poseChanged: boolean;
  t: Record<Ch, number>;
  flip: boolean;
  z: number;
  visible: boolean;
  transformDirty: boolean;
  tween: { start: number; ms: number; curve: NodeCurve; keys: Ch[]; from: Partial<Record<Ch, number>>; to: Partial<Record<Ch, number>>; lift: number } | null;
  /** Hauteur (px, vers le haut) ajoutée par `lift`. */
  liftY: number;
  /** Surcharges de pièces (`<instance>_<pièce>`). */
  over: Map<number, { visible?: boolean; color?: string; opacity?: number }>;
  overRev: number;
};

export class Monde2dDriver {
  readonly instances = new Map<string, Inst2>();
  private parts = new Map<string, { inst: Inst2; i: number }>();

  setMonde(m: Monde2d, now: number): void {
    const old = new Map(this.instances);
    this.instances.clear();
    this.parts.clear();
    for (const pl of m.place) {
      if (!pl.name) continue;
      const model = m.models.get(pl.model);
      if (!model) continue;
      const prev = old.get(pl.name);
      let inst: Inst2;
      if (prev && prev.model.name === model.name && prev.model.parts.length === model.parts.length) {
        // ce que le JSON change pour cette instance est appliqué ; le reste (pilotage par nodes) est gardé
        const pp = prev.placement;
        if (pp.at[0] !== pl.at[0] || pp.at[1] !== pl.at[1] || pp.rot !== pl.rot || pp.scale[0] !== pl.scale[0] || pp.scale[1] !== pl.scale[1]) {
          Object.assign(prev.t, { x: pl.at[0], y: pl.at[1], rz: pl.rot, sx: pl.scale[0], sy: pl.scale[1] });
          prev.tween = null;
          prev.liftY = 0;
        }
        if (JSON.stringify(pp.roles) !== JSON.stringify(pl.roles)) {
          prev.roles = { ...pl.roles };
          prev.rolesRev++;
        }
        if (pp.flip !== pl.flip) prev.flip = pl.flip;
        if (pp.z !== pl.z) prev.z = pl.z;
        if (pp.hidden !== pl.hidden) prev.visible = !pl.hidden;
        if (pp.clip !== pl.clip) setClip(prev.clip, now, pl.clip || model.clip);
        if (prev.model.sig !== model.sig) prev.over.clear();
        prev.model = model;
        prev.placement = pl;
        prev.poseDirty = true;
        prev.transformDirty = true;
        prev.overRev++;
        inst = prev;
      } else {
        inst = {
          name: pl.name,
          model,
          placement: pl,
          clip: clipState(pl.clip || model.clip, now),
          roles: { ...pl.roles },
          rolesRev: 0,
          offs: new Float32Array(model.parts.length * STRIDE2),
          poseDirty: true,
          active: true,
          poseChanged: false,
          t: { x: pl.at[0], y: pl.at[1], rz: pl.rot, sx: pl.scale[0], sy: pl.scale[1], opacity: 1 },
          flip: pl.flip,
          z: pl.z,
          visible: !pl.hidden,
          transformDirty: true,
          tween: null,
          liftY: 0,
          over: new Map(),
          overRev: 0,
        };
      }
      this.instances.set(pl.name, inst);
      model.parts.forEach((p, i) => this.parts.set(`${pl.name}_${p.name}`, { inst, i }));
    }
  }

  clear(): void {
    this.instances.clear();
    this.parts.clear();
  }

  has(name: string): boolean {
    return this.instances.has(name) || this.parts.has(name);
  }

  /** Patch d'instance ou de pièce ; false si le nom est inconnu. */
  apply(name: string, raw: unknown, now: number, animate: boolean): boolean {
    const p = patchOf(raw) as (NodePatch & { flip?: unknown }) | null;
    const inst = this.instances.get(name);
    if (!inst) {
      const hit = this.parts.get(name);
      if (!hit || !p) return !!hit;
      const o = hit.inst.over.get(hit.i) ?? {};
      if (typeof p.visible === "boolean") o.visible = p.visible;
      if (isColor(p.color)) o.color = p.color;
      if (isNum(p.opacity)) o.opacity = Math.max(0, Math.min(1, p.opacity));
      hit.inst.over.set(hit.i, o);
      hit.inst.overRev++;
      return true;
    }
    if (!p) return true;
    const fixed = p.clipT === null ? null : isNum(p.clipT) ? Math.max(0, Math.min(1, p.clipT)) : undefined;
    if (setClip(inst.clip, now, typeof p.clip === "string" ? p.clip : undefined, isNum(p.clipSpeed) ? p.clipSpeed : undefined, fixed)) inst.poseDirty = true;
    if (p.roles && typeof p.roles === "object") {
      let changed = false;
      for (const [k, v] of Object.entries(p.roles)) {
        if (isColor(v) && Object.prototype.hasOwnProperty.call(inst.model.roles, k) && inst.roles[k] !== v) {
          inst.roles[k] = v;
          changed = true;
        }
      }
      if (changed) inst.rolesRev++;
    }
    if (typeof p.flip === "boolean" && p.flip !== inst.flip) {
      inst.flip = p.flip;
      inst.transformDirty = true;
    }
    if (typeof p.visible === "boolean" && p.visible !== inst.visible) {
      inst.visible = p.visible;
      inst.transformDirty = true;
      inst.poseDirty = true;
    }
    if (isNum(p.z) && p.z !== inst.z) {
      inst.z = p.z;
      inst.transformDirty = true;
    }
    const to: Partial<Record<Ch, number>> = {};
    if (isNum(p.x)) to.x = p.x;
    if (isNum(p.y)) to.y = p.y;
    if (isNum(p.rz)) to.rz = p.rz;
    if (isNum(p.opacity)) to.opacity = Math.max(0, Math.min(1, p.opacity));
    if (isNum(p.scale)) to.sx = to.sy = p.scale;
    else if (Array.isArray(p.scale) && isNum(p.scale[0]) && isNum(p.scale[1])) [to.sx, to.sy] = [p.scale[0], p.scale[1]];
    const keys = Object.keys(to) as Ch[];
    if (keys.length) {
      const ms = isNum(p.ease?.ms) ? Math.max(0, p.ease!.ms!) : 0;
      if (animate && ms > 0) {
        const from: Partial<Record<Ch, number>> = {};
        for (const k of keys) from[k] = inst.t[k];
        inst.tween = { start: now, ms, curve: p.ease?.curve ?? "linear", keys, from, to, lift: isNum(p.lift) ? p.lift : 0 };
      } else {
        for (const k of keys) inst.t[k] = to[k]!;
        inst.tween = null;
        inst.liftY = 0;
      }
      inst.transformDirty = true;
    }
    return true;
  }

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
      // une instance cachée ne s'anime pas (la pose est recalculée quand elle réapparaît)
      if ((inst.poseDirty || inst.active) && inst.visible) {
        inst.active = sampleClips(inst.model.clips, inst.clip, now, inst.offs, STRIDE2, MULT2);
        inst.poseDirty = false;
        inst.poseChanged = true;
        if (inst.active) busy = true;
      }
    }
    return busy;
  }
}
