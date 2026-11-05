import type { FingerName, Point, RawHand } from "../../shared/ml/hands";

/** Main synthétique : poignet en (cx, cy+0,25), bases des doigts à cy, bouts à cy - reach. Pour les tests uniquement. */
export function fakeHand(cx: number, cy: number, reach = 0.3, extra: Partial<RawHand> = {}): RawHand {
  const lm: Point[] = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  lm[0] = { x: cx, y: cy + 0.25, z: 0 };
  [5, 9, 13, 17].forEach((b, i) => {
    const x = cx + (i - 1) * 0.04;
    lm[b] = { x, y: cy, z: 0 };
    lm[[8, 12, 16, 20][i]] = { x, y: cy - reach, z: 0 };
  });
  lm[4] = { x: cx - 0.18, y: cy, z: 0 };
  return { landmarks: lm, score: 0.9, ...extra };
}

/**
 * Main synthétique articulée : poignet en (0,5 ; 0,75), doigts vers le haut, chaque doigt plié dans le plan de la
 * paume d'un taux `curl` (0 droit, 1 poing : flexion 70° / 100° / 70° aux articulations).
 */
export function jointedHand(curl: Partial<Record<FingerName, number>>, spreadGap = 0.04): Point[] {
  const lm: Point[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.75, z: 0 }));
  const lens = [0.08, 0.05, 0.04];
  const chain = (start: Point, base: number, c: number, bends: number[], dir0: number, lensIn: number[]) => {
    let p = start;
    let a = dir0; // angle depuis la verticale (rad), positif = vers le pouce (gauche de l'image)
    const out: Point[] = [p];
    lensIn.forEach((len, i) => {
      a += (bends[i] * c * Math.PI) / 180;
      p = { x: p.x - Math.sin(a) * len, y: p.y - Math.cos(a) * len, z: 0 };
      out.push(p);
    });
    lm[base] = out[0];
    lm[base + 1] = out[1];
    lm[base + 2] = out[2];
    lm[base + 3] = out[3];
  };
  const bases: Array<[FingerName, number, number]> = [
    ["index", 5, -1.5],
    ["middle", 9, -0.5],
    ["ring", 13, 0.5],
    ["pinky", 17, 1.5],
  ];
  for (const [name, idx, k] of bases) {
    const mcp = { x: 0.5 + k * spreadGap, y: 0.6, z: 0 };
    chain(mcp, idx, curl[name] ?? 0, [70, 100, 70], k * (spreadGap > 0.04 ? 0.15 : 0), lens);
  }
  lm[0] = { x: 0.5, y: 0.75, z: 0 };
  // pouce : CMC (1) près du poignet, puis MCP, IP, bout, penché vers l'extérieur
  const thumb = curl.thumb ?? 0;
  const t0 = { x: 0.44, y: 0.72, z: 0 };
  let a = 0.6;
  let p = t0;
  const th: Point[] = [t0];
  [0.05, 0.04, 0.035].forEach((len, i) => {
    a += ((i === 0 ? 0 : i === 1 ? 45 : 60) * thumb * Math.PI) / 180;
    p = { x: p.x - Math.sin(a) * len, y: p.y - Math.cos(a) * len, z: 0 };
    th.push(p);
  });
  lm[1] = th[0];
  lm[2] = th[1];
  lm[3] = th[2];
  lm[4] = th[3];
  return lm;
}

/** Main articulée (voir `jointedHand`) au format du modèle, pour les tests du cœur. */
export function fakeJointedHand(curl: Partial<Record<FingerName, number>>, extra: Partial<RawHand> = {}): RawHand {
  return { landmarks: jointedHand(curl), score: 0.9, ...extra };
}
