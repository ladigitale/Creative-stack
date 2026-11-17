/**
 * Prairies de `sonic-procgen` (rendu 3D) : un maillage instancié par champ (un appel de dessin), dessiné par les
 * shaders de procgen (`#define BLADE` : bandes, ombres reçues, brume, nuit, contours comme le reste de la scène), avec
 * le vent et le ploiement calculés dans le shader (code GLSL commun avec le format monde de `sonic-3d`). Côté CPU, à
 * chaque image : l'horloge (partagée) et 8 positions qui couchent les brins (acteurs, objet glissé, ballons).
 * Les brins ne projettent pas d'ombre (passe d'ombre sans eux) et ne se touchent pas (sélection à travers).
 */
import * as THREE from "three";
import { HERBE_KINDS, HERBE_MAX_PUSH, bladeShape, bladeTint } from "../../../shared/monde/herbes";
import type { Meadow } from "../scene/meadows";
import { ROLES } from "../style/roles";
import { type StyleTokens, grassShift, styleColor } from "../style/style";
import type { Shared } from "./materials";
import { FRAGMENT, MAX_BONES, MEADOW_FLOWERS, VERTEX } from "./shaders";

const LEAF = ROLES.indexOf("leaf");

function bladeGeometry(m: Meadow): THREE.BufferGeometry {
  const sh = bladeShape(m.field.kind, m.field.width);
  const n = sh.pos.length / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(sh.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(sh.nrm, 3));
  g.setAttribute("aBlade", new THREE.Float32BufferAttribute(sh.bh.flatMap((h, i) => [h, sh.head[i]]), 2));
  g.setAttribute("aRole", new THREE.Float32BufferAttribute(new Float32Array(n).fill(LEAF), 1));
  g.setAttribute("aAO", new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1));
  g.setAttribute("aObj", new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  g.setIndex(sh.idx);
  return g;
}

type Field = { im: THREE.InstancedMesh; mat: THREE.ShaderMaterial; m: Meadow };

export class MeadowLayer {
  readonly group = new THREE.Group();
  private fields: Field[] = [];
  private wind = { value: new THREE.Vector2(1.2, 0.5) };
  private push = { value: Array.from({ length: HERBE_MAX_PUSH }, () => new THREE.Vector4()) };
  private still = { value: Array.from({ length: HERBE_MAX_PUSH }, () => new THREE.Vector4()) };
  count = 0;

  constructor() {
    this.group.name = "procgen~meadows";
  }

  get active() {
    return this.fields.length > 0;
  }

  /** Champs du modèle ; `roles` = rôles du style (commun à la scène). */
  mount(meadows: Meadow[], shared: Shared, roles: { value: Float32Array }) {
    this.clear();
    const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const m of meadows) {
      const n = m.blades.length / 6;
      if (!n) continue;
      const geo = bladeGeometry(m);
      const tint = new Float32Array(n * 2), objs = new Float32Array(n);
      const im = new THREE.InstancedMesh(geo, undefined, n);
      let hMax = 0;
      for (let b = 0; b < n; b++) {
        const k = b * 6;
        p.set(m.blades[k], m.blades[k + 1], m.blades[k + 2]);
        q.setFromAxisAngle(up, m.blades[k + 3]);
        const h = m.blades[k + 4];
        hMax = Math.max(hMax, h);
        s.set(1, h, 1);
        im.setMatrixAt(b, mat4.compose(p, q, s));
        const t = bladeTint(m.field, m.blades[k + 5]);
        tint[b * 2] = t.flower + 1;
        tint[b * 2 + 1] = t.shade;
      }
      geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 2));
      geo.setAttribute("aInstObj", new THREE.InstancedBufferAttribute(objs, 1));
      const uniforms: Record<string, THREE.IUniform> = {
        ...shared,
        uRoles: roles,
        uSkinned: { value: 0 },
        uDQ: { value: Array.from({ length: MAX_BONES * 2 }, (_, i) => new THREE.Vector4(0, 0, 0, i % 2 ? 0 : 1)) },
        uBlink: { value: 0 },
        uBladeWind: this.wind,
        uSway: { value: m.field.sway },
        uPush: m.field.bend ? this.push : this.still,
        uBladeBase: { value: new THREE.Color() },
        uBladeTip: { value: new THREE.Color() },
        uFlowers: { value: Array.from({ length: MEADOW_FLOWERS }, () => new THREE.Color(1, 1, 1)) },
        uFlowerHeads: { value: m.field.flowers.length ? 1 : 0 },
      };
      const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms, side: THREE.DoubleSide, defines: { BLADE: "" } });
      im.material = mat;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      // le vent couche les brins jusqu'à leur hauteur : sphère élargie
      if (im.boundingSphere) im.boundingSphere.radius += hMax;
      im.userData.noShadow = true;
      im.name = `meadow~${m.field.kind}`;
      this.group.add(im);
      this.fields.push({ im, mat, m });
      this.count += n;
    }
  }

  /** Couleurs accordées au style : celles de la recette telles quelles, celles de la sorte suivent aussi l'herbe de la palette. */
  setStyle(s: StyleTokens) {
    const shift = grassShift(s);
    for (const f of this.fields) {
      const fl = f.m.field;
      const def = HERBE_KINDS[fl.kind];
      const k = f.m.custom ? [1, 1, 1] : fl.kind === "herbe" || fl.kind === "gazon" || fl.kind === "fleurs" ? shift : [0.5 + shift[0] * 0.5, 0.5 + shift[1] * 0.5, 0.5 + shift[2] * 0.5];
      const set = (c: THREE.Color, hex: string, mul = true) => {
        const v = styleColor(s, hex);
        c.setRGB(v[0] * (mul ? k[0] : 1), v[1] * (mul ? k[1] : 1), v[2] * (mul ? k[2] : 1));
      };
      set(f.mat.uniforms.uBladeBase.value, fl.base || def.base);
      set(f.mat.uniforms.uBladeTip.value, fl.tip || def.tip);
      const flowers = f.mat.uniforms.uFlowers.value as THREE.Color[];
      fl.flowers.slice(0, MEADOW_FLOWERS).forEach((h, i) => set(flowers[i], h, false));
    }
  }

  /** Vent (direction en radians, 0 = vers +z ; force = `wind` de la recette) et positions qui couchent les brins. */
  advance(wind: number, dir: number, pushers: { x: number; z: number; r: number }[]) {
    // même force que le vent par défaut du format monde (1,3 m/s) pour `wind: 1`
    this.wind.value.set(Math.sin(dir) * 1.3 * wind, Math.cos(dir) * 1.3 * wind);
    const arr = this.push.value;
    for (let i = 0; i < HERBE_MAX_PUSH; i++) {
      const p = pushers[i];
      if (p) arr[i].set(p.x, p.z, p.r, 1);
      else arr[i].set(0, 0, 0, 0);
    }
  }

  clear() {
    for (const f of this.fields) {
      f.im.geometry.dispose();
      f.mat.dispose();
      f.im.removeFromParent();
      f.im.dispose();
    }
    this.fields = [];
    this.count = 0;
  }
}
