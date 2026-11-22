import { apply, squareToQuad, type Pt } from "./homography";

export type Rectified = { url: string; width: number; height: number; mime: string; pad: number };

/**
 * Zone `zone` (4 coins en 0..1 de `photo` : haut-gauche, haut-droit, bas-droit, bas-gauche) vue de face, plus
 * `pad` fois sa taille de chaque côté (0..2), au plus `side` px de côté, en JPEG data:. Ce qui sort de la photo
 * (ou passe derrière l'horizon du plan) est gris neutre.
 */
export function rectify(photo: HTMLCanvasElement, zone: Pt[], pad = 0, side = 960, quality = 0.8): Rectified | null {
  if (!photo.width || !photo.height || zone.length !== 4) return null;
  try {
    const p = Math.max(0, Math.min(2, Number(pad) || 0));
    const q = zone.map((z) => ({ x: z.x * photo.width, y: z.y * photo.height }));
    const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
    const aspect = Math.max(0.2, Math.min(5, (d(q[0], q[1]) + d(q[3], q[2])) / Math.max(1, d(q[0], q[3]) + d(q[1], q[2]))));
    const W = Math.round(aspect >= 1 ? side : side * aspect), H = Math.round(aspect >= 1 ? side / aspect : side);
    const H2 = squareToQuad(q);
    if (!H2) return null;
    const src = photo.getContext("2d")!.getImageData(0, 0, photo.width, photo.height).data;
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    const span = 1 + 2 * p;
    const wc = H2[6] * 0.5 + H2[7] * 0.5 + H2[8];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const u = ((x + 0.5) / W) * span - p, v = ((y + 0.5) / H) * span - p;
        const m = (H2[6] * u + H2[7] * v + H2[8]) * wc > 0 ? apply(H2, u, v) : null;
        if (!m || m.x < 0 || m.y < 0 || m.x >= photo.width || m.y >= photo.height) {
          img.data[o] = img.data[o + 1] = img.data[o + 2] = 40; img.data[o + 3] = 255;
          continue;
        }
        const i = ((m.y | 0) * photo.width + (m.x | 0)) * 4;
        img.data[o] = src[i]; img.data[o + 1] = src[i + 1]; img.data[o + 2] = src[i + 2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { url: out.toDataURL("image/jpeg", quality), width: W, height: H, mime: "image/jpeg", pad: p };
  } catch {
    return null;
  }
}
