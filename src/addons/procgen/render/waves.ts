/**
 * Houle de Gerstner recalculée côté processeur, avec les mêmes trains d'ondes que le shader de l'eau
 * (`render/shaders.ts`, passe d'eau). Les bateaux et les objets flottants s'y posent : hauteur et pente en quatre
 * points de la coque, d'où pilonnement, tangage et roulis. C'est la méthode classique des jeux (même fonction de vagues
 * sur la carte graphique et le processeur), sans lecture de la carte graphique.
 */
export type WaveParams = { amp: number; len: number; time: number };

/** Hauteur de la houle au point (x, z) (m, relative au niveau de l'eau) ; `scale` : amortissement local (hauts-fonds, agitation). */
export function waveHeight(x: number, z: number, w: WaveParams, scale = 1): number {
  if (w.amp <= 0 || scale <= 0) return 0;
  let y = 0;
  for (let i = 0; i < 5; i++) {
    const ang = 0.45 + i * 1.37 + Math.sin(i * 2.1) * 0.4;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const L = w.len * (1 - i * 0.15) * (i > 2.5 ? 0.45 : 1);
    const k = (2 * Math.PI) / L;
    const A = w.amp * scale * (1 - i * 0.16) * (i > 2.5 ? 0.35 : 1);
    const c = Math.sqrt(9.81 / k);
    const f = k * (dx * x + dz * z - c * w.time) + i * 1.7;
    y += A * Math.sin(f);
  }
  return y;
}

/** Pose d'une coque sur la houle : hauteur moyenne, tangage et roulis (rad) d'après quatre points (avant, arrière, bords). */
export function hullOnWaves(x: number, z: number, yaw: number, halfLen: number, halfBeam: number, w: WaveParams, scale = 1): { dy: number; pitch: number; roll: number } {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), lx = Math.cos(yaw), lz = -Math.sin(yaw);
  const a = halfLen * 0.8, b = halfBeam * 0.8;
  const hf = waveHeight(x + fx * a, z + fz * a, w, scale), hb = waveHeight(x - fx * a, z - fz * a, w, scale);
  const hl = waveHeight(x + lx * b, z + lz * b, w, scale), hr = waveHeight(x - lx * b, z - lz * b, w, scale);
  // une coque ne suit pas les vagues plus courtes qu'elle : moyenne sur sa longueur (hauteur), pentes bornées
  return { dy: (hf + hb + hl + hr) / 4, pitch: Math.max(-0.35, Math.min(0.35, -Math.atan2(hf - hb, 2 * a))), roll: Math.max(-0.35, Math.min(0.35, Math.atan2(hl - hr, 2 * b))) };
}
