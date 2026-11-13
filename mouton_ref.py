"""Image de référence « un mouton » : une brebis laineuse dans un pré, lumière rasante du soir à contre-jour,
fond flou. Rendu procédural (laine en touffes et boucles, déformation du domaine, diffusion dans la laine,
liseré de contre-jour, herbe au premier plan, flou de profondeur), à peindre par `sonic-painterly` (entrée
`image` de l'outil Abysse). Sortie PNG."""
import sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

W, H = 1000, 800
Y0, X0 = np.mgrid[0:H, 0:W].astype(np.float32)
rng = np.random.default_rng(612)


def blur(a, r):
    return gaussian_filter(a.astype(np.float32), r)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def noise(scale, octaves=4, seed=0):
    r = np.random.default_rng(seed)
    out = np.zeros((H, W), np.float32)
    amp = 1.0
    for o in range(octaves):
        s = max(2, int(scale / (2 ** o)))
        small = r.random((H // s + 2, W // s + 2)).astype(np.float32)
        img = Image.fromarray((small * 255).astype(np.uint8)).resize((W + 2 * s, H + 2 * s), Image.BICUBIC)
        out += amp * (np.asarray(img, np.float32)[s:s + H, s:s + W] / 255 - 0.5)
        amp *= 0.5
    return out


WX = noise(70, 3, 1) * 2 + noise(14, 2, 2) * 0.5
WY = noise(70, 3, 3) * 2 + noise(14, 2, 4) * 0.5
X, Y = X0, Y0


def warp(amp):
    global X, Y
    X = X0 + WX * amp
    Y = Y0 + WY * amp


def ellipse(cx, cy, rx, ry, rot=0.0):
    c, s = np.cos(rot), np.sin(rot)
    dx, dy = X - cx, Y - cy
    u, v = c * dx + s * dy, -s * dx + c * dy
    return np.sqrt((u / rx) ** 2 + (v / ry) ** 2)


def capsule(p0, p1, r0, r1=None):
    r1 = r0 if r1 is None else r1
    a = np.array(p0, np.float32)
    b = np.array(p1, np.float32)
    ba = b - a
    t = np.clip(((X - a[0]) * ba[0] + (Y - a[1]) * ba[1]) / (ba @ ba), 0, 1)
    d = np.hypot(X - (a[0] + t * ba[0]), Y - (a[1] + t * ba[1]))
    return d / (r0 + (r1 - r0) * t), t


def dome(d, height, p=0.6):
    m = 1 - smoothstep(0.96, 1.04, d)
    return height * np.clip(1 - d * d, 0, 1) ** p, m


Z = np.full((H, W), -1e9, np.float32)
M = np.zeros((H, W), np.float32)
ALB = np.zeros((H, W, 3), np.float32)
WOOL = np.zeros((H, W), np.float32)
SPEC = np.zeros((H, W), np.float32)


def put(mask, height, alb, zbase, wool=0.0, spec=0.0):
    z = zbase + height
    take = (mask > 0.5) & (z >= Z)
    Z[take] = z[take]
    M[:] = np.maximum(M, mask)
    a = np.broadcast_to(np.asarray(alb, np.float32), (H, W, 3))
    ALB[take] = a[take]
    WOOL[take] = wool
    SPEC[take] = spec


WOOL_COL = np.array([0.88, 0.84, 0.74], np.float32)
wool_alb = WOOL_COL * (1 + 0.07 * noise(30, 3, 10))[..., None] * np.array([1.0, 0.99, 0.97])
# laine plus grise et terreuse vers le ventre
wool_alb = wool_alb * (1 - 0.22 * smoothstep(470, 600, Y0))[..., None]

# ------------------------------------------------------------------------------------ pattes (derrière le corps)
warp(1.5)
LEG = np.array([0.30, 0.26, 0.22], np.float32)
for (top, knee, foot, w, z) in [
    ((450, 540), (446, 605), (452, 668), 15, 10),   # avant gauche (côté lointain)
    ((690, 540), (700, 600), (694, 662), 15, 10),   # arrière lointaine
    ((400, 545), (392, 615), (398, 690), 17, 60),   # avant proche
    ((640, 548), (650, 615), (640, 686), 17, 60),   # arrière proche
]:
    for a, b in [(top, knee), (knee, foot)]:
        d, t = capsule(a, b, w, w * 0.85)
        hh, m = dome(d, w)
        put(m, hh, LEG * (0.9 + 0.1 * np.sin(t * 3))[..., None], z)
    d = ellipse(foot[0] - 3, foot[1] + 6, w * 1.05, w * 0.6)
    hh, m = dome(d, 6)
    put(m, hh, (0.12, 0.10, 0.09), z + 2, 0, 0.6)

# ------------------------------------------------------------------------------------ corps : toison en touffes
warp(10)
d = ellipse(560, 445, 235, 135, -0.04)
hh, body_m = dome(d, 120, 0.5)
# touffes : petites bosses réparties, plus serrées en bord de silhouette (contour en festons)
tufts = np.zeros((H, W), np.float32)
for _ in range(900):
    a = rng.uniform(0, 2 * np.pi)
    rr = np.sqrt(rng.uniform(0, 1.05))
    cx = 560 + np.cos(a) * rr * 235
    cy = 445 + np.sin(a) * rr * 135
    s = rng.uniform(10, 22)
    x0, x1 = int(max(0, cx - 2 * s)), int(min(W, cx + 2 * s))
    y0, y1 = int(max(0, cy - 2 * s)), int(min(H, cy + 2 * s))
    if x0 >= x1 or y0 >= y1:
        continue
    dd = np.hypot(X0[y0:y1, x0:x1] - cx, Y0[y0:y1, x0:x1] - cy) / s
    bump = np.clip(1 - dd * dd, 0, 1) ** 0.7 * s * 0.7
    tufts[y0:y1, x0:x1] = np.maximum(tufts[y0:y1, x0:x1], bump)
edge_tufts = smoothstep(0.0, 6.0, tufts)
mask = np.maximum(body_m, (d < 1.12) * edge_tufts)
curl = np.abs(noise(5, 2, 20)) * 6 + np.abs(noise(2.5, 1, 21)) * 3
put(mask, hh * body_m + tufts + curl, wool_alb, 100, 1.0)

# ------------------------------------------------------------------------------------ tête, tournée vers nous
warp(2)
FACE = np.array([0.80, 0.72, 0.62], np.float32) * (1 + 0.05 * noise(10, 2, 30))[..., None]
d = ellipse(300, 400, 62, 82, 0.35)
hh, m = dome(d, 70)
d2 = ellipse(270, 465, 40, 36, 0.2)          # museau
h2, m2 = dome(d2, 64)
hh = np.maximum(hh, h2 + 10)
m = np.maximum(m, m2)
# poil ras du chanfrein : grain fin, pas de peau lisse
fur = noise(3, 2, 31) * 0.7 + noise(7, 2, 32) * 0.6
put(m, blur(hh, 3) + fur, FACE, 200)
# oreilles horizontales, intérieur rosé
for (cx, cy, rot, z) in [(222, 360, -0.25, 190), (376, 352, 0.3, 230)]:
    d = ellipse(cx, cy, 44, 17, rot)
    hh, m = dome(d, 14)
    put(m, hh, FACE * np.array([1.0, 0.92, 0.9]), z)
    d = ellipse(cx + (6 if cx > 300 else -6), cy + 2, 30, 8, rot)
    hh, m = dome(d, 4)
    put(m, hh + 10, (0.78, 0.55, 0.52), z + 1)
# toupet de laine sur le front
warp(5)
tt = np.zeros((H, W), np.float32)
for _ in range(70):
    cx, cy = rng.normal(318, 22), rng.normal(330, 14)
    s = rng.uniform(8, 14)
    dd = np.hypot(X0 - cx, Y0 - cy) / s
    tt = np.maximum(tt, np.clip(1 - dd * dd, 0, 1) ** 0.7 * s)
put((tt > 0.5).astype(np.float32), tt + curl * 0.6, wool_alb, 262, 1.0)
warp(1)
# yeux (un peu sur le côté, pupille horizontale), narines, bouche
for (cx, cy) in [(262, 400), (334, 392)]:
    d = ellipse(cx, cy, 11, 9)
    hh, m = dome(d, 5)
    put(m, hh, (0.36, 0.25, 0.10), 272, 0, 2.0)
    d = ellipse(cx, cy, 7, 3)
    hh, m = dome(d, 2)
    put(m, hh, (0.03, 0.02, 0.02), 278, 0, 2.0)
for (cx, cy) in [(254, 474), (286, 476)]:
    d = ellipse(cx, cy, 7, 4, 0.5 if cx < 270 else -0.5)
    hh, m = dome(d, 2)
    put(m, hh, (0.25, 0.16, 0.14), 276)
d, _ = capsule((258, 497), (284, 499), 2.2)
hh, m = dome(d, 1)
put(m, hh, (0.30, 0.20, 0.17), 276)
warp(0)

# ------------------------------------------------------------------------------------ éclairage : soleil bas derrière à droite
Hs = blur(np.where(M > 0.5, Z, 0), 1.2)
gy, gx = np.gradient(Hs)
gx, gy = np.clip(gx, -1.8, 1.8), np.clip(gy, -1.8, 1.8)
n = np.dstack([-gx, -gy, np.ones_like(Hs)])
n /= np.linalg.norm(n, axis=2, keepdims=True)
L = np.array([0.62, -0.55, 0.45], np.float32)
L /= np.linalg.norm(L)
ndl = n @ L
wool = WOOL[..., None]
wrap = np.clip((ndl + 0.5) / 1.5, 0, 1)[..., None]
diff = np.clip(ndl, 0, 1)[..., None]
key = np.array([1.25, 0.98, 0.70], np.float32)
sky = np.clip(n @ np.array([-0.2, -0.6, 0.75], np.float32), 0, 1)[..., None] * np.array([0.30, 0.36, 0.48])
zz = np.where(M > 0.5, Z, 0)
ao = (1 - 0.55 * np.clip((blur(zz, 6) - zz) / 18, 0, 1)) * (1 - 0.35 * np.clip((blur(zz, 25) - zz) / 60, 0, 1))
col = ALB * ((diff * (1 - wool) + wrap * wool) * key + sky + 0.08) * ao[..., None]
# la laine diffuse : halo doré dans les zones fines du contour, éclairées par derrière
thin = np.clip(1 - blur((M > 0.5).astype(np.float32), 9) * 1.15, 0, 1) * (M > 0.5)
col += (thin * 1.4)[..., None] * wool * np.array([1.0, 0.78, 0.45])
rim = (1 - n[..., 2]) ** 1.6 * np.clip(n[..., 0] * 0.75 - n[..., 1] * 0.65, 0, 1)
col += (rim * 0.9)[..., None] * np.array([1.0, 0.8, 0.5])
Hv = L + np.array([0, 0, 1], np.float32)
Hv /= np.linalg.norm(Hv)
col += ((np.clip(n @ Hv, 0, 1) ** 60) * SPEC)[..., None] * 0.6
fg = np.clip(col, 0, 2)

# ------------------------------------------------------------------------------------ fond : pré du soir, flou
t = Y0 / H
sky_c = np.dstack([0.98 - 0.25 * t, 0.86 - 0.3 * t, 0.62 - 0.32 * t])
sun = np.exp(-np.hypot(X0 - 930, Y0 - 120) / 160)
sky_c += sun[..., None] * np.array([1.0, 0.8, 0.45]) * 0.9
hills = 300 + 30 * np.sin(X0 / 160 + 0.5) + 25 * noise(220, 2, 40)
trees = 255 + 45 * np.clip(noise(40, 3, 41) * 3, -1, 1) * smoothstep(0, 1, np.sin(X0 / 90) * 0.5 + 0.5)
far = smoothstep(-3, 3, Y0 - np.minimum(hills, trees))
far_c = np.array([0.42, 0.45, 0.28]) * (0.9 + 0.2 * noise(30, 3, 42))[..., None]
meadow = smoothstep(330, 420, Y0)
mead_c = np.dstack([0.52 - 0.18 * t, 0.56 - 0.15 * t, 0.22 - 0.08 * t]) * (1 + 0.15 * noise(25, 3, 43))[..., None]
bg = sky_c * (1 - far[..., None]) + far_c * far[..., None]
bg = bg * (1 - meadow[..., None]) + mead_c * meadow[..., None]
# lumière dorée rasante sur le pré
bg += (np.exp(-np.hypot((X0 - 930) / 600, (Y0 - 120) / 500)) * 0.35)[..., None] * np.array([1.0, 0.75, 0.4])
for c in range(3):
    bg[..., c] = blur(bg[..., c], 7)
# ombre portée de la brebis vers l'avant-gauche
sh = np.roll(np.roll(blur(M, 14), -70, axis=1), 150, axis=0) * smoothstep(560, 640, Y0)
sh = np.clip(sh * 1.3, 0, 1) * (1 - smoothstep(700, 780, Y0) * 0.3)
bg *= (1 - 0.5 * sh)[..., None]

mask = blur((M > 0.5).astype(np.float32), 0.8)[..., None]
img = bg * (1 - mask) + fg * mask

# ------------------------------------------------------------------------------------ herbes du premier plan (cachent les sabots)
blades = np.zeros((H, W), np.float32)
bcol = np.zeros((H, W, 3), np.float32)
for _ in range(1400):
    x0 = rng.uniform(-20, W + 20)
    y0 = rng.uniform(640, H + 40)
    hgt = rng.uniform(30, 85) * (0.7 + (y0 - 640) / 220)
    lean = rng.uniform(-0.45, 0.35)
    xs0, xs1 = int(max(0, min(x0, x0 + lean * hgt) - 4)), int(min(W, max(x0, x0 + lean * hgt) + 4))
    ys0, ys1 = int(max(0, y0 - hgt - 2)), int(min(H, y0 + 2))
    if xs0 >= xs1 or ys0 >= ys1:
        continue
    yy, xx = Y0[ys0:ys1, xs0:xs1], X0[ys0:ys1, xs0:xs1]
    tt2 = np.clip((y0 - yy) / hgt, 0, 1)
    cxl = x0 + lean * hgt * tt2 ** 1.6
    wdt = 2.6 * (1 - tt2) + 0.4
    bm = (1 - smoothstep(wdt * 0.6, wdt, np.abs(xx - cxl))) * (yy <= y0) * (yy >= y0 - hgt)
    g = rng.uniform(0.75, 1.15)
    c = np.array([0.42, 0.48, 0.16]) * g
    tip = (tt2 ** 2)[..., None] * np.array([0.55, 0.38, 0.12])      # pointes dorées au soleil
    sub = bcol[ys0:ys1, xs0:xs1]
    upd = bm > blades[ys0:ys1, xs0:xs1]
    sub[upd] = (c * (0.6 + 0.6 * tt2[..., None]) + tip)[upd]
    blades[ys0:ys1, xs0:xs1] = np.maximum(blades[ys0:ys1, xs0:xs1], bm)
img = img * (1 - blades[..., None]) + bcol * blades[..., None]

# ------------------------------------------------------------------------------------ finition
glow = blur(np.clip(img.mean(axis=2) - 0.72, 0, 1), 22)
img += glow[..., None] * np.array([1.0, 0.8, 0.5]) * 0.5
vig = 1 - 0.4 * smoothstep(0.4, 1.05, np.hypot((X0 - 520) / 620, (Y0 - 430) / 520))
img *= vig[..., None]
img += rng.normal(0, 0.01, img.shape).astype(np.float32)
img = np.clip(img, 0, 1) ** (1 / 1.06)
out = sys.argv[1] if len(sys.argv) > 1 else "mouton-ref.png"
Image.fromarray((img * 255).astype(np.uint8)).save(out, optimize=True)
print(out)
