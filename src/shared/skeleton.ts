/**
 * Squelette 2D (calcul pur, sans DOM) : une hiérarchie d'os rigides, résolue en positions et rotations.
 *
 * Conventions (repère écran, y vers le bas) :
 * - un angle `θ` est en degrés, `0` = l'os pointe **vers le bas**, positif = sens horaire à l'écran
 *   (bas → gauche → haut → droite). Même sens que `rz` du format `nodes` (voir ./nodes.ts) ;
 * - `angle` d'un os est son angle de **repos**, relatif à celui de son parent (absolu pour la racine) ;
 * - la résolution produit pour chaque os l'origine de l'articulation (`x`, `y`), son extrémité (`x2`, `y2`) et `rz` :
 *   la rotation (radians) par rapport au **repos**. Au repos, `rz` vaut 0 pour tous les os : un élément graphique
 *   est donc dessiné dans la pose de repos, avec son pivot sur l'articulation, et suit l'os sans autre calcul.
 */

export const MAX_BONES = 64;

export type BoneSpec = {
  name: string;
  /** Nom de l'os parent ; `null` : racine. */
  parent: string | null;
  /** Longueur (unités de la scène, avant `scale`). 0 : articulation sans segment (bassin). */
  length: number;
  /** Angle de repos (°), relatif au parent. */
  angle: number;
  /** Où l'os s'attache sur son parent : 0 = à l'origine, 1 = à l'extrémité (défaut). */
  at: number;
  /** Décalage latéral (unités) perpendiculaire au parent : épaule, hanche. Positif = à droite d'un parent qui pointe vers le bas. */
  offset: number;
  /** Limites de rotation (°) par rapport au repos, locales. */
  min: number;
  max: number;
};

/** Pilote d'un os : `world` = direction absolue voulue (°) ; `delta` = rotation (°) ajoutée au repos. `world` l'emporte. */
export type BoneDrive = { world?: number; delta?: number };

export type BoneState = {
  name: string;
  /** Origine de l'os (articulation), unités de la scène. */
  x: number;
  y: number;
  /** Extrémité. */
  x2: number;
  y2: number;
  /** Direction absolue (°, de -180 à 180). */
  angle: number;
  /** Rotation par rapport au repos (radians, de -π à π). */
  rz: number;
  /** Longueur effective (après `scale`). */
  length: number;
};

const RAD = Math.PI / 180;

/** Ramène un angle en degrés dans ]-180, 180]. */
export function wrap180(a: number): number {
  let v = a % 360;
  if (v > 180) v -= 360;
  else if (v <= -180) v += 360;
  return v;
}

/** Direction (vecteur unitaire écran) d'un angle `θ` : 0 = vers le bas, positif = sens horaire. */
export function dir(theta: number): { x: number; y: number } {
  return { x: -Math.sin(theta * RAD), y: Math.cos(theta * RAD) };
}

/** Perpendiculaire de `dir(θ)` : vers la droite quand l'os pointe vers le bas. */
export function perp(theta: number): { x: number; y: number } {
  return { x: Math.cos(theta * RAD), y: Math.sin(theta * RAD) };
}

/** Angle `θ` (°) du vecteur `dx, dy` (écran). `null` si le vecteur est nul. `aspect` : largeur / hauteur de l'image des mesures. */
export function aimAngle(dx: number, dy: number, aspect = 1): number | null {
  const px = dx * aspect;
  if (Math.hypot(px, dy) < 1e-9) return null;
  return wrap180(Math.atan2(-px, dy) / RAD);
}

export type RigOptions = { scale: number };

export class Rig {
  readonly specs: BoneSpec[];
  /** Os dans l'ordre de résolution (parents d'abord). */
  readonly order: string[];
  readonly errors: string[] = [];
  private byName = new Map<string, BoneSpec>();
  private bindWorld = new Map<string, number>();
  private scale: number;

  constructor(specs: BoneSpec[], opts: Partial<RigOptions> = {}) {
    this.scale = Number.isFinite(opts.scale) && (opts.scale as number) > 0 ? (opts.scale as number) : 1;
    const seen = new Set<string>();
    const kept: BoneSpec[] = [];
    for (const s of specs.slice(0, MAX_BONES)) {
      if (!s.name) {
        this.errors.push("un os sans nom est ignoré");
        continue;
      }
      if (seen.has(s.name)) {
        this.errors.push(`os "${s.name}" déclaré deux fois`);
        continue;
      }
      seen.add(s.name);
      kept.push(s);
    }
    if (specs.length > MAX_BONES) this.errors.push(`${specs.length} os : ${MAX_BONES} au plus`);
    // Ordre topologique ; un parent inconnu ou un cycle écarte l'os (et ses descendants).
    const done = new Set<string>();
    const order: BoneSpec[] = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const s of kept) {
        if (done.has(s.name)) continue;
        if (s.parent === null || done.has(s.parent)) {
          done.add(s.name);
          order.push(s);
          progressed = true;
        }
      }
    }
    for (const s of kept) {
      if (done.has(s.name)) continue;
      this.errors.push(seen.has(s.parent as string) ? `os "${s.name}" : cycle de parents` : `os "${s.name}" : parent "${s.parent}" inconnu`);
    }
    this.specs = order;
    this.order = order.map((s) => s.name);
    for (const s of order) {
      this.byName.set(s.name, s);
      const parentWorld = s.parent === null ? 0 : (this.bindWorld.get(s.parent) as number);
      this.bindWorld.set(s.name, parentWorld + s.angle);
    }
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Résout la pose : `root` = origine de la racine ; `drives` = pilotes par os (absents : repos) ;
   * `scale` remplace l'échelle du squelette pour cet appel (ajustement à une personne mesurée).
   */
  solve(root: { x: number; y: number }, drives: Record<string, BoneDrive | undefined> = {}, scale?: number): BoneState[] {
    const k = Number.isFinite(scale) && (scale as number) > 0 ? (scale as number) : this.scale;
    const out = new Map<string, BoneState>();
    const result: BoneState[] = [];
    for (const s of this.specs) {
      const parent = s.parent === null ? null : (out.get(s.parent) as BoneState);
      const parentWorld = parent ? parent.angle : 0;
      const d = drives[s.name];
      let rel = 0;
      if (d && Number.isFinite(d.world)) rel = wrap180((d.world as number) - parentWorld - s.angle);
      else if (d && Number.isFinite(d.delta)) rel = d.delta as number;
      rel = Math.max(s.min, Math.min(s.max, rel));
      const angle = parentWorld + s.angle + rel;
      let x = root.x;
      let y = root.y;
      if (parent) {
        const along = parent.length * s.at;
        const pd = dir(parentWorld);
        const pp = perp(parentWorld);
        const off = s.offset * k;
        x = parent.x + pd.x * along + pp.x * off;
        y = parent.y + pd.y * along + pp.y * off;
      }
      const length = s.length * k;
      const dd = dir(angle);
      const state: BoneState = {
        name: s.name,
        x,
        y,
        x2: x + dd.x * length,
        y2: y + dd.y * length,
        angle: wrap180(angle),
        rz: wrap180(angle - (this.bindWorld.get(s.name) as number)) * RAD,
        length,
      };
      out.set(s.name, state);
      result.push(state);
    }
    return result;
  }
}
