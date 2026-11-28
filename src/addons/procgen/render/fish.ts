/**
 * Poissons : bancs qui nagent sous la surface des mares, des lacs, des rivières et de la mer (clé `fish` de la
 * recette). Chaque banc suit un point qui erre dans l'eau assez profonde ; chaque poisson suit son banc avec un écart
 * propre, ondule et fait demi-tour au bord. Coût linéaire (pas de voisinage entre poissons), un appel de dessin par
 * couleur (maillages instanciés), dessinés dans la passe de la scène : vus à travers l'eau (réfraction).
 */
import * as THREE from "three";
import { Mesh } from "../geom/mesh";
import { ellipsoid, box } from "../geom/prims";
import { ROLE } from "../style/roles";
import { m4Compose, qAxis, qMul } from "../core/math";
import { type MaterialPair, toGeometry } from "./materials";

export type FishSpec = { density: number; colors: number[] };

/** Identifiant d'objet des poissons dans le shader (aucun objet de la scène ne le porte). */
export const FISH_OBJ = 999_983;

/** Lecture tolérante : `true`, densité (0,1 à 3), ou `{density, colors: ["orange", "white"…]}`. */
export function readFish(v: unknown): FishSpec | null {
  if (v === undefined || v === null || v === false) return null;
  if (v === true) return { density: 1, colors: [] };
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? { density: Math.min(3, Math.max(0.1, v)), colors: [] } : null;
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const d = typeof o.density === "number" && Number.isFinite(o.density) ? Math.min(3, Math.max(0.1, o.density)) : 1;
    const colors = Array.isArray(o.colors) ? o.colors.map((c) => ROLE[String(c) as keyof typeof ROLE]).filter((x): x is number => typeof x === "number").slice(0, 4) : [];
    return { density: d, colors };
  }
  return null;
}

type Fish = { x: number; y: number; z: number; vx: number; vz: number; ox: number; oz: number; dy: number; ph: number; s: number; school: number; slot: number; mesh: number };
type School = { x: number; z: number; tx: number; tz: number; t: number; seed: number; pond: boolean };

/** Maillage d'un poisson (repère : avance selon +z), longueur ≈ 0,3 m. */
function fishMesh(role: number): Mesh {
  const m = new Mesh();
  m.append(ellipsoid(0.045, 0.06, 0.15, role, 10, 6));
  // queue en éventail et nageoire dorsale
  m.append(box(0.006, 0.05, 0.035, role), m4Compose([0, 0, -0.17], [0, 0, 0, 1], 1));
  m.append(box(0.004, 0.025, 0.05, role), m4Compose([0, 0.06, -0.01], [0, 0, 0, 1], 1));
  return m;
}

export class FishLayer {
  readonly group = new THREE.Group();
  private fishes: Fish[] = [];
  private schools: School[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private tmp = new THREE.Matrix4();

  constructor(
    private water: (x: number, z: number) => number | null,
    private bed: (x: number, z: number) => number,
    private isPond: (x: number, z: number) => boolean,
  ) {
    this.group.name = "procgen~fish";
  }

  /** Bancs semés dans l'eau assez profonde de la scène (rectangle `[x0, z0, x1, z1]`). */
  build(spec: FishSpec, bounds: [number, number, number, number], mats: MaterialPair, seed = 1) {
    this.dispose();
    const cells: [number, number, boolean][] = [];
    for (let x = bounds[0] + 0.5; x < bounds[2]; x += 1)
      for (let z = bounds[1] + 0.5; z < bounds[3]; z += 1) if (this.depth(x, z) > 0.3) cells.push([x, z, this.isPond(x, z)]);
    if (!cells.length) return;
    let rnd = seed * 9301 + 49297;
    const r = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
    const nSchools = Math.min(8, Math.max(1, Math.round((cells.length / 40) * spec.density)));
    const total = Math.min(90, Math.max(4, Math.round(cells.length * 0.12 * spec.density)));
    const perSchool = Math.max(3, Math.round(total / nSchools));
    // couleurs : carpes (orange, blanc, rouge) dans les mares, poissons argentés ou bleus ailleurs
    const pondRoles = spec.colors.length ? spec.colors : [ROLE.orange, ROLE.white, ROLE.red];
    const wildRoles = spec.colors.length ? spec.colors : [ROLE.metal, ROLE.blue, ROLE.green];
    const roles = [...new Set([...pondRoles, ...wildRoles])];
    const counts = new Array(roles.length).fill(0);
    const plan: Fish[] = [];
    for (let s = 0; s < nSchools; s++) {
      const c = cells[Math.floor(r() * cells.length)];
      this.schools.push({ x: c[0], z: c[1], tx: c[0], tz: c[1], t: 0, seed: r() * 100, pond: c[2] });
      const pal = c[2] ? pondRoles : wildRoles;
      for (let k = 0; k < perSchool; k++) {
        const role = pal[Math.floor(r() * pal.length)];
        const mi = roles.indexOf(role);
        const a = r() * Math.PI * 2, d = 0.3 + r() * 1.2;
        plan.push({ x: c[0] + Math.cos(a) * d, y: 0, z: c[1] + Math.sin(a) * d, vx: 0, vz: 0, ox: Math.cos(a) * d, oz: Math.sin(a) * d, dy: r(), ph: r() * 10, s: (c[2] ? 1.4 : 1) * (0.75 + r() * 0.6), school: s, slot: counts[mi]++, mesh: mi });
      }
    }
    this.fishes = plan;
    roles.forEach((role, i) => {
      if (!counts[i]) return;
      const geo = toGeometry(fishMesh(role));
      // identifiant propre (jamais 0 : le sol découpé au-dessus des mares effacerait les poissons ; hors des objets
      // sélectionnables)
      geo.setAttribute("aInstObj", new THREE.InstancedBufferAttribute(new Float32Array(counts[i]).fill(FISH_OBJ), 1));
      const im = new THREE.InstancedMesh(geo, mats.color, counts[i]);
      im.userData.depth = mats.depth;
      im.frustumCulled = false;
      this.meshes[i] = im;
      this.group.add(im);
    });
    this.step(0, 0);
  }

  get count() {
    return this.fishes.length;
  }

  private depth(x: number, z: number): number {
    const wl = this.water(x, z);
    return wl === null ? 0 : wl - this.bed(x, z);
  }

  /** Un pas : errance des bancs, poursuite des poissons, demi-tour au bord, ondulation. */
  step(dt: number, time: number) {
    for (const s of this.schools) {
      s.t -= dt;
      const dx = s.tx - s.x, dz = s.tz - s.z, d = Math.hypot(dx, dz);
      if (s.t <= 0 || d < 0.4) {
        // nouvelle destination dans l'eau profonde, à quelques mètres
        for (let k = 0; k < 10; k++) {
          const a = Math.sin(time * 1.3 + s.seed + k * 2.1) * Math.PI, r = 2 + 4 * Math.abs(Math.sin(time * 0.7 + s.seed * 3 + k));
          const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
          if (this.depth(x, z) > 0.45) {
            s.tx = x;
            s.tz = z;
            break;
          }
        }
        s.t = 5 + 4 * Math.abs(Math.sin(s.seed + time));
      } else if (dt > 0) {
        const v = Math.min(d, 0.5 * dt);
        const nx = s.x + (dx / d) * v, nz = s.z + (dz / d) * v;
        if (this.depth(nx, nz) > 0.35) ((s.x = nx), (s.z = nz));
        else s.t = 0;
      }
    }
    for (const f of this.fishes) {
      const s = this.schools[f.school];
      if (dt > 0) {
        // vers sa place dans le banc (écart propre qui tourne lentement), vitesse bornée, lissée
        const a = time * 0.3 + f.ph;
        const gx = s.x + f.ox * Math.cos(a * 0.2) - f.oz * Math.sin(a * 0.2), gz = s.z + f.ox * Math.sin(a * 0.2) + f.oz * Math.cos(a * 0.2);
        let wx = gx - f.x + Math.sin(time * 0.9 + f.ph) * 0.3, wz = gz - f.z + Math.cos(time * 0.8 + f.ph * 1.3) * 0.3;
        const wl = Math.hypot(wx, wz) || 1;
        const sp = Math.min(0.9, 0.25 + wl * 0.5);
        wx = (wx / wl) * sp;
        wz = (wz / wl) * sp;
        const k = 1 - Math.exp(-dt * 1.5);
        f.vx += (wx - f.vx) * k;
        f.vz += (wz - f.vz) * k;
        const nx = f.x + f.vx * dt, nz = f.z + f.vz * dt;
        // jamais hors de l'eau ni dans les hauts-fonds : demi-tour
        if (this.depth(nx, nz) > 0.3) ((f.x = nx), (f.z = nz));
        else ((f.vx = -f.vx), (f.vz = -f.vz));
      }
      const wl = this.water(f.x, f.z);
      const dep = this.depth(f.x, f.z);
      // près de la surface dans une mare (eau trouble), plus bas en mer ; jamais sous le fond
      if (wl !== null) f.y = wl - Math.min(Math.max(0.1, dep - 0.08), (s.pond ? 0.05 : 0.2) + f.dy * Math.min(s.pond ? 0.08 : 1.5, dep * 0.5));
      const yaw = Math.atan2(f.vx, f.vz) + Math.sin(time * 9 * (0.8 + f.dy * 0.4) + f.ph) * 0.12;
      const q = qMul(qAxis([0, 1, 0], yaw), qAxis([0, 0, 1], Math.sin(time * 2 + f.ph) * 0.05));
      const im = this.meshes[f.mesh];
      if (!im) continue;
      im.setMatrixAt(f.slot, this.tmp.fromArray(m4Compose([f.x, f.y, f.z], q, f.s) as unknown as number[]));
    }
    for (const im of this.meshes) if (im) im.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const im of this.meshes) if (im) {
      this.group.remove(im);
      im.geometry.dispose();
    }
    this.meshes = [];
    this.fishes = [];
    this.schools = [];
  }
}
