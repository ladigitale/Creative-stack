import { DESC_WORDS, PATTERN_VERSION, extractFeatures, type FeatureOptions, type Features } from "./features";
import type { Gray } from "./image";
import { matchDescriptors } from "./match";
import { apply, convexQuad, quadArea, ransacHomography, type Mat3, type Pt } from "./homography";

/**
 * Référence d'ancrage sérialisable (JSON) : points et descripteurs d'une photo, zone délimitée
 * (4 coins, ordre horaire depuis le haut-gauche, coordonnées 0..1), direction « haut » de la gravité
 * dans l'image au moment de la prise, position GPS facultative.
 */
export type AnchorReference = {
  v: 1;
  pattern: number;
  id?: string;
  width: number;
  height: number;
  zone: Pt[];
  /** Vecteur unitaire « haut » (repère image, y vers le bas) ; absent si le téléphone était à plat. */
  up?: Pt;
  geo?: { lat: number; lon: number; accuracy?: number; heading?: number };
  /** Empreinte globale de la photo (`sonic-image-embedder`), pour classer les lieux candidats. */
  embedding?: number[];
  n: number;
  /** Coordonnées ×4 en Uint16 (x, y), base64. */
  pts: string;
  /** Descripteurs (32 octets par point), base64. */
  desc: string;
  createdAt?: string;
};

export type DecodedReference = {
  embedding: Float32Array | null;
  geo: AnchorReference["geo"] | null;
  features: Features;
  zone: Pt[];
  up: Pt | null;
  width: number;
  height: number;
};

/** Points de la zone élargie d'une marge (fraction de sa taille) : contexte autour de la surface. */
export function zoneMask(zone: Pt[], width: number, height: number, margin: number): (x: number, y: number) => boolean {
  const cx = zone.reduce((s, p) => s + p.x, 0) / zone.length;
  const cy = zone.reduce((s, p) => s + p.y, 0) / zone.length;
  const poly = zone.map((p) => ({ x: (cx + (p.x - cx) * (1 + margin)) * width, y: (cy + (p.y - cy) * (1 + margin)) * height }));
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
}

/** Coins dans l'ordre haut-gauche, haut-droit, bas-droit, bas-gauche (repère image). */
export function orderQuad(pts: Pt[]): Pt[] {
  if (pts.length !== 4) return pts;
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // Angle croissant en repère y-bas = sens horaire à l'écran ; on démarre au plus proche du haut-gauche.
  let start = 0, best = Infinity;
  sorted.forEach((p, i) => { const s = p.x + p.y; if (s < best) { best = s; start = i; } });
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

export type ReferenceOptions = { margin?: number; up?: Pt | null; id?: string };

export function buildReference(img: Gray, zone: Pt[], opts: FeatureOptions & ReferenceOptions = {}): AnchorReference {
  const z = orderQuad(zone.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })));
  const mask = zoneMask(z, img.width, img.height, opts.margin ?? 0.2);
  const f = extractFeatures(img, { maxPoints: 900, ...opts, mask });
  return referenceFromFeatures(f, z, opts);
}

/**
 * Référence à partir de points déjà extraits sur toute l'image : seuls ceux de la zone élargie
 * sont gardés (ajuster la zone au doigt ne relance pas l'extraction).
 */
export function referenceFromFeatures(all: Features, zone: Pt[], opts: ReferenceOptions = {}): AnchorReference {
  const z = orderQuad(zone.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })));
  const mask = zoneMask(z, all.width, all.height, opts.margin ?? 0.2);
  const keep: number[] = [];
  for (let i = 0; i < all.n; i++) if (mask(all.x[i], all.y[i])) keep.push(i);
  const n = keep.length;
  const pts = new Uint16Array(n * 2);
  const desc = new Uint32Array(n * DESC_WORDS);
  keep.forEach((i, k) => {
    pts[k * 2] = Math.round(Math.min(16383, all.x[i] * 4));
    pts[k * 2 + 1] = Math.round(Math.min(16383, all.y[i] * 4));
    desc.set(all.desc.subarray(i * DESC_WORDS, (i + 1) * DESC_WORDS), k * DESC_WORDS);
  });
  const ref: AnchorReference = {
    v: 1, pattern: PATTERN_VERSION, width: all.width, height: all.height, zone: z, n,
    pts: toB64(new Uint8Array(pts.buffer)), desc: toB64(new Uint8Array(desc.buffer)),
  };
  if (opts.id) ref.id = opts.id;
  if (opts.up) ref.up = unit(opts.up) ?? undefined;
  if (!ref.up) delete ref.up;
  return ref;
}

export function decodeReference(ref: unknown): DecodedReference | null {
  const r = ref as AnchorReference | null;
  if (!r || r.v !== 1 || r.pattern !== PATTERN_VERSION || typeof r.pts !== "string" || typeof r.desc !== "string") return null;
  if (!Array.isArray(r.zone) || r.zone.length !== 4 || !(r.width > 0) || !(r.height > 0)) return null;
  try {
    const pb = fromB64(r.pts), db = fromB64(r.desc);
    const n = Math.min(r.n | 0, pb.length >> 2, db.length / (DESC_WORDS * 4) | 0);
    const p16 = new Uint16Array(pb.buffer, pb.byteOffset, n * 2);
    const x = new Float32Array(n), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { x[i] = p16[i * 2] / 4; y[i] = p16[i * 2 + 1] / 4; }
    const desc = new Uint32Array(db.buffer, db.byteOffset, n * DESC_WORDS);
    const emb = Array.isArray(r.embedding) && r.embedding.length ? Float32Array.from(r.embedding.map(Number)) : null;
    return {
      embedding: emb && emb.every(Number.isFinite) ? emb : null,
      geo: r.geo && Number.isFinite(+r.geo.lat) && Number.isFinite(+r.geo.lon) ? { ...r.geo } : null,
      features: { n, x, y, level: new Uint8Array(n), desc, width: r.width, height: r.height },
      zone: r.zone.map((p) => ({ x: +p.x, y: +p.y })),
      up: r.up ? unit(r.up) : null,
      width: r.width,
      height: r.height,
    };
  } catch {
    return null;
  }
}

export type LocateOptions = {
  /** « Haut » courant (repère de l'image caméra) ; avec celui de la référence, filtre les rotations impossibles. */
  up?: Pt | null;
  /** Écart d'angle toléré (degrés) entre la rotation trouvée et celle attendue ; 0 = pas de filtre. */
  gravityTolerance?: number;
  minInliers?: number;
  /** Erreur de reprojection (pixels de l'image caméra). */
  threshold?: number;
  ratio?: number;
  maxDistance?: number;
  random?: () => number;
};

export type LocateResult = {
  found: boolean;
  /** Référence (pixels) → image caméra (pixels). */
  h: Mat3 | null;
  /** Coins de la zone dans l'image caméra (pixels). */
  corners: Pt[] | null;
  matches: number;
  inliers: number;
  /** Erreur moyenne de reprojection (pixels). */
  error: number;
  /** 0..1 : part des appariements cohérents, pondérée par leur nombre. */
  confidence: number;
  /** Rotation trouvée (degrés, sens horaire à l'écran) du « haut » de la référence. */
  rotation: number | null;
};

const NOT_FOUND = (matches = 0): LocateResult => ({ found: false, h: null, corners: null, matches, inliers: 0, error: 0, confidence: 0, rotation: null });

/** Retrouve la zone de la référence dans l'image caméra. */
export function locate(ref: DecodedReference, frame: Features, opts: LocateOptions = {}): LocateResult {
  const m = matchDescriptors(frame.desc, frame.n, ref.features.desc, ref.features.n, { ratio: opts.ratio ?? 0.8, maxDistance: opts.maxDistance ?? 70 });
  const minIn = Math.max(6, opts.minInliers ?? 14);
  if (m.n < minIn) return NOT_FOUND(m.n);
  const sx = new Float64Array(m.n), sy = new Float64Array(m.n), dx = new Float64Array(m.n), dy = new Float64Array(m.n);
  for (let k = 0; k < m.n; k++) {
    sx[k] = ref.features.x[m.r[k]]; sy[k] = ref.features.y[m.r[k]];
    dx[k] = frame.x[m.q[k]]; dy[k] = frame.y[m.q[k]];
  }
  const zonePx = ref.zone.map((p) => ({ x: p.x * ref.width, y: p.y * ref.height }));
  const sign = Math.sign(quadArea(zonePx)) || 1;
  const frameArea = frame.width * frame.height;
  const centre = { x: zonePx.reduce((s, p) => s + p.x, 0) / 4, y: zonePx.reduce((s, p) => s + p.y, 0) / 4 };
  const tol = opts.gravityTolerance ?? 45;
  const expected = tol > 0 && ref.up && opts.up ? signedAngle(ref.up, opts.up) : null;

  const rotationOf = (h: Mat3): number | null => {
    const up = ref.up ?? { x: 0, y: -1 };
    const s = Math.max(ref.width, ref.height) * 0.05;
    const a = apply(h, centre.x, centre.y), b = apply(h, centre.x + up.x * s, centre.y + up.y * s);
    if (!a || !b) return null;
    const v = unit({ x: b.x - a.x, y: b.y - a.y });
    return v ? signedAngle(up, v) : null;
  };

  const accept = (h: Mat3): boolean => {
    const q: Pt[] = [];
    for (const p of zonePx) { const t = apply(h, p.x, p.y); if (!t) return false; q.push(t); }
    if (!convexQuad(q, sign)) return false;
    const a = Math.abs(quadArea(q)) / frameArea;
    if (a < 0.002 || a > 6) return false;
    if (expected !== null) {
      const r = rotationOf(h);
      if (r === null || Math.abs(wrap180(r - expected)) > tol) return false;
    }
    return true;
  };

  const res = ransacHomography(sx, sy, dx, dy, m.n, {
    threshold: opts.threshold ?? Math.max(3, Math.max(frame.width, frame.height) / 160),
    accept, random: opts.random,
  });
  if (!res || res.count < minIn) return NOT_FOUND(m.n);
  const corners = zonePx.map((p) => apply(res.h, p.x, p.y)!);
  const ratio = res.count / m.n;
  const confidence = Math.min(1, ratio * Math.min(1, res.count / (minIn * 3)) * 1.5);
  return {
    found: ratio >= 0.2, h: res.h, corners, matches: m.n, inliers: res.count,
    error: res.error, confidence: Math.round(confidence * 1000) / 1000, rotation: rotationOf(res.h),
  };
}

/** Angle signé (degrés) pour passer de `a` à `b`, positif dans le sens horaire à l'écran (y vers le bas). */
/** Cosinus entre deux empreintes (0 si tailles différentes ou nulles). */
export function cosine(a: ArrayLike<number> | null, b: ArrayLike<number> | null): number {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

export function signedAngle(a: Pt, b: Pt): number {
  return (Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180) / Math.PI;
}

export function wrap180(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

export function unit(p: Pt | null | undefined): Pt | null {
  if (!p) return null;
  const l = Math.hypot(+p.x, +p.y);
  return l > 1e-6 ? { x: +p.x / l, y: +p.y / l } : null;
}

const clamp01 = (v: number) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 0);

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  // Copie alignée (Uint16 / Uint32 exigent un décalage multiple de 4).
  const buf = new ArrayBuffer((bin.length + 3) & ~3);
  const out = new Uint8Array(buf, 0, bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
