"""Image de référence « la paix contre l'armement » : une colombe s'élève dans l'aube au-dessus d'un fusil
brisé d'où repousse un rameau d'olivier, au milieu des coquelicots. Rendu procédural (champs de hauteur,
éclairage à contre-jour), à peindre par `sonic-painterly` (entrée `image` de l'outil Abysse). Sortie PNG."""
import sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

W, H = 800, 1000
Y, X = np.mgrid[0:H, 0:W].astype(np.float32)
SUN = np.array([400.0, 300.0])


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


def ellipse(cx, cy, rx, ry, rot=0.0):
    """Distance normalisée (1 au bord) et coordonnées locales."""
    c, s = np.cos(rot), np.sin(rot)
    dx, dy = X - cx, Y - cy
    u, v = c * dx + s * dy, -s * dx + c * dy
    return np.sqrt((u / rx) ** 2 + (v / ry) ** 2), u, v


def dome(d, height, soft=0.03):
    m = 1 - smoothstep(1 - soft, 1 + soft, d)
    return np.sqrt(np.clip(1 - d * d, 0, 1)) * height, m


def capsule(p0, p1, r0, r1=None):
    r1 = r0 if r1 is None else r1
    a = np.array(p0, np.float32)
    b = np.array(p1, np.float32)
    ba = b - a
    t = np.clip(((X - a[0]) * ba[0] + (Y - a[1]) * ba[1]) / (ba @ ba), 0, 1)
    px, py = X - (a[0] + t * ba[0]), Y - (a[1] + t * ba[1])
    d = np.sqrt(px * px + py * py)
    r = r0 + (r1 - r0) * t
    return d / r, t


class Layer:
    def __init__(self):
        self.z = np.full((H, W), -1e9, np.float32)
        self.h = np.zeros((H, W), np.float32)
        self.m = np.zeros((H, W), np.float32)
        self.alb = np.zeros((H, W, 3), np.float32)
        self.spec = np.zeros((H, W), np.float32)

    def put(self, mask, height, color, zbase=0.0, spec=0.0, alb=None):
        z = zbase + height
        take = (mask > 0.02) & (z >= self.z)
        self.z[take] = z[take]
        self.h[take] = height[take] + zbase
        self.m = np.maximum(self.m, mask)
        a = np.broadcast_to(np.array(color, np.float32), (H, W, 3)) if alb is None else alb
        self.alb[take] = a[take]
        self.spec[take] = spec if np.isscalar(spec) else spec[take]


def shade(layer, light, key_col, fill_col, amb, rim_col, rim_amt, spec_col, sm=1.2):
    h = blur(layer.h, sm)
    gy, gx = np.gradient(h)
    n = np.dstack([-gx, -gy, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    L = np.array(light, np.float32)
    L /= np.linalg.norm(L)
    ndl = np.clip(n @ L, 0, 1)
    fill = np.clip(n @ np.array([0.2, 0.5, 0.85], np.float32), 0, 1)
    rim = (1 - n[..., 2]) ** 2.2
    # le contre-jour vient du soleil : plus fort du côté tourné vers lui
    toward = np.clip(-(n[..., 0] * (X - SUN[0]) + n[..., 1] * (Y - SUN[1])) / (np.hypot(X - SUN[0], Y - SUN[1]) + 1), 0, 1)
    Hh = L + np.array([0, 0, 1], np.float32)
    Hh /= np.linalg.norm(Hh)
    sp = np.clip(n @ Hh, 0, 1) ** 40
    col = layer.alb * (amb + ndl[..., None] * np.array(key_col) + fill[..., None] * np.array(fill_col))
    col += (rim * toward * rim_amt)[..., None] * np.array(rim_col)
    col += (sp * layer.spec)[..., None] * np.array(spec_col)
    return col


# ------------------------------------------------------------------------------------ ciel d'aube
t = Y / H
sky = np.dstack([
    np.interp(t, [0, 0.35, 0.62, 0.75], [0.10, 0.36, 0.95, 1.00]),
    np.interp(t, [0, 0.35, 0.62, 0.75], [0.14, 0.33, 0.62, 0.80]),
    np.interp(t, [0, 0.35, 0.62, 0.75], [0.30, 0.52, 0.42, 0.52]),
]).astype(np.float32)
dsun = np.hypot(X - SUN[0], Y - SUN[1])
glow = np.exp(-dsun / 170) * 0.9 + np.exp(-dsun / 60) * 0.6
sky += glow[..., None] * np.array([1.0, 0.82, 0.55])
# rayons
ang = np.arctan2(Y - SUN[1], X - SUN[0])
rays = (0.5 + 0.5 * np.cos(ang * 14 + 0.7 * np.sin(ang * 5))) ** 6 * np.exp(-dsun / 420) * smoothstep(40, 160, dsun)
sky += (rays * 0.22)[..., None] * np.array([1.0, 0.85, 0.6])
# nuages en bandes, éclairés par en dessous
cl = noise(140, 5, 4) + 0.6 * noise(40, 3, 5)
band = np.exp(-((Y - 600) / 70) ** 2) + 0.7 * np.exp(-((Y - 170) / 60) ** 2)
cloud = smoothstep(0.02, 0.28, cl * band)
cloud_col = np.dstack([np.interp(t, [0, 0.3, 0.65], [0.32, 0.62, 1.0]), np.interp(t, [0, 0.3, 0.65], [0.28, 0.45, 0.74]),
                       np.interp(t, [0, 0.3, 0.65], [0.45, 0.5, 0.55])]).astype(np.float32)
lit = smoothstep(-0.1, 0.15, blur(cl * band, 4) - blur(cl * band, 4)[np.clip(Y.astype(int) - 8, 0, H - 1), X.astype(int)])
cloud_col *= (0.85 + 0.35 * lit)[..., None]
img = sky * (1 - cloud[..., None] * 0.8) + cloud_col * cloud[..., None] * 0.8

# lointain : collines bleutées dans la brume
hill = 700 + 24 * np.sin(X / 110 + 1.3) + 14 * np.sin(X / 47) + 30 * noise(160, 2, 9)
hm = smoothstep(-2, 2, Y - hill)
img = img * (1 - hm[..., None]) + np.array([0.55, 0.42, 0.45]) * hm[..., None]

# ------------------------------------------------------------------------------------ sol, herbes
GY = 780 + 18 * np.sin(X / 140) + 20 * noise(120, 2, 21)
gm = smoothstep(-2, 2, Y - GY)
gt = np.clip((Y - GY) / 220, 0, 1)
ground = np.dstack([0.20 - 0.12 * gt, 0.17 - 0.1 * gt, 0.10 - 0.06 * gt]) * (1 + 0.5 * noise(30, 4, 22)[..., None])
# lisière éclairée par l'aube
ground += (np.exp(-(Y - GY) / 18) * gm)[..., None] * np.array([0.55, 0.36, 0.16])
# brins d'herbe : traits verticaux fins
blade = np.zeros((H, W), np.float32)
rng = np.random.default_rng(31)
for _ in range(900):
    x0 = rng.uniform(0, W)
    y0 = rng.uniform(760, H)
    hgt = rng.uniform(25, 70) * (0.6 + (y0 - 760) / 400)
    lean = rng.uniform(-0.35, 0.35)
    d, tt = capsule((x0, y0), (x0 + lean * hgt, y0 - hgt), 2.2, 0.4)
    blade = np.maximum(blade, (1 - smoothstep(0.7, 1.0, d)) * (0.4 + 0.6 * tt))
ground = ground * (1 - blade[..., None] * 0.9) + (blade[..., None]) * np.array([0.30, 0.34, 0.10]) * (0.6 + 0.8 * np.clip((780 - Y + 40) / 80, 0, 1))[..., None]
img = img * (1 - gm[..., None]) + ground * gm[..., None]

# ------------------------------------------------------------------------------------ fusil brisé (au sol)
gun = Layer()
METAL = (0.13, 0.13, 0.15)
WOOD = (0.36, 0.18, 0.08)
rot = -0.12
S = 1.35


def G(x, y):
    return (400 + (x - 400) * S, 870 + (y - 850) * S)


# moitié gauche : crosse, carcasse, chargeur
d, _ = capsule(G(70, 860), G(300, 830), 30 * S, 20 * S)
hh, m = dome(d, 22 * S)
wood_grain = (0.85 + 0.3 * noise(6, 2, 41))[..., None] * np.array(WOOD, np.float32)
gun.put(m, hh, WOOD, 10, 0.25, alb=wood_grain)
d, _ = capsule(G(60, 885), G(100, 845), 20 * S, 20 * S)        # talon de crosse
hh, m = dome(d, 18 * S)
gun.put(m, hh, (0.08, 0.06, 0.05), 12, 0.2)
d, _ = capsule(G(290, 828), G(410, 812), 19 * S, 17 * S)       # carcasse
hh, m = dome(d, 18 * S)
gun.put(m, hh, METAL, 16, 1.0)
d, _ = capsule(G(345, 836), G(330, 900), 13 * S, 12 * S)       # chargeur courbe
d2, _ = capsule(G(330, 900), G(300, 945), 12 * S, 11 * S)
d = np.minimum(d, d2)
hh, m = dome(d, 14)
gun.put(m, hh, METAL, 10, 0.8)
d, _ = capsule(G(300, 832), G(295, 870), 9 * S, 8 * S)         # poignée
hh, m = dome(d, 10)
gun.put(m, hh, (0.10, 0.09, 0.09), 14, 0.5)
# cassure : bord déchiqueté de la carcasse
jx, jy0 = G(410, 790)
_, jy1 = G(410, 845)
bx, _ = G(445, 0)
jag = jx + 10 * np.sin(Y * 0.9) + 6 * np.sin(Y * 2.3)
cut = (X > jag) & (Y < jy1) & (Y > jy0) & (X < bx)
gun.m[cut] = 0
gun.z[cut] = -1e9
# moitié droite : canon tordu, éjecté plus loin
d, tt = capsule(G(470, 850), G(600, 870), 11 * S, 10 * S)
d2, _ = capsule(G(600, 870), G(735, 838), 10 * S, 9 * S)
d = np.minimum(d, d2)
hh, m = dome(d, 12)
gun.put(m, hh, METAL, 8, 1.2)
d, _ = capsule(G(470, 852), G(560, 864), 15 * S, 14 * S)       # garde-main
hh, m = dome(d, 15)
gun.put(m, hh, (0.18, 0.15, 0.13), 10, 0.4)
gm_col = shade(gun, (-0.35, -0.75, 0.55), (1.35, 1.0, 0.7), (0.22, 0.26, 0.38), 0.18, (1.0, 0.7, 0.35), 0.9, (1.2, 1.0, 0.75))
# ombre portée sur le sol
shadow = blur(gun.m, 7)
shadow = np.roll(shadow, 9, axis=0)
img *= (1 - 0.55 * shadow * gm)[..., None]
gmask = blur(gun.m, 0.7)[..., None]
img = img * (1 - gmask) + gm_col * gmask

# ------------------------------------------------------------------------------------ rameau d'olivier qui repousse de la cassure
leaf_layer = Layer()
stem_pts = [G(418, 812), (432, 760), (445, 700), (462, 650), (470, 610)]
for a, b in zip(stem_pts, stem_pts[1:]):
    d, _ = capsule(a, b, 5.5, 4.0)
    hh, m = dome(d, 6)
    leaf_layer.put(m, hh, (0.30, 0.22, 0.12), 30, 0.1)
rng = np.random.default_rng(77)
for i in range(16):
    k = i / 15
    seg = min(int(k * (len(stem_pts) - 1)), len(stem_pts) - 2)
    f = k * (len(stem_pts) - 1) - seg
    px = stem_pts[seg][0] * (1 - f) + stem_pts[seg + 1][0] * f
    py = stem_pts[seg][1] * (1 - f) + stem_pts[seg + 1][1] * f
    side = 1 if i % 2 else -1
    angle = -np.pi / 2 + side * rng.uniform(0.7, 1.1)
    ln = rng.uniform(26, 38) * (1.1 - 0.4 * k)
    cx, cy = px + np.cos(angle) * ln * 0.55, py + np.sin(angle) * ln * 0.55
    d, u, v = ellipse(cx, cy, ln * 0.55, ln * 0.14, angle)
    hh, m = dome(d, 5)
    shade_var = rng.uniform(0.8, 1.15)
    leaf_layer.put(m, hh + 1.5 * (v / (ln * 0.14)), (0.30 * shade_var, 0.42 * shade_var, 0.18 * shade_var), 32, 0.6)
leaf_col = shade(leaf_layer, (-0.2, -0.8, 0.55), (1.3, 1.05, 0.7), (0.15, 0.22, 0.25), 0.2, (1.0, 0.85, 0.4), 1.2, (0.9, 0.95, 0.8), 0.8)
lm = blur(leaf_layer.m, 0.6)[..., None]
img = img * (1 - lm) + leaf_col * lm

# ------------------------------------------------------------------------------------ coquelicots
pop = Layer()
rng = np.random.default_rng(55)
for _ in range(34):
    cx = rng.uniform(20, 780)
    cy = rng.uniform(800, 990)
    if 0 < cx < 760 and 800 < cy < 920:
        cy = 925 + (cy - 800) * 0.6
    s = rng.uniform(13, 24) * (0.7 + (cy - 800) / 400)
    # tige
    d, _ = capsule((cx, cy), (cx + rng.uniform(-8, 8), cy + 70), 1.8)
    hh, m = dome(d, 2)
    pop.put(m, hh, (0.22, 0.30, 0.10), 2, 0.0)
    for p in range(4):
        a = p * np.pi / 2 + rng.uniform(-0.3, 0.3)
        d, u, v = ellipse(cx + np.cos(a) * s * 0.45, cy + np.sin(a) * s * 0.35, s * 0.6, s * 0.5, a)
        hh, m = dome(d, 6 + 2 * p)
        pop.put(m, hh, (0.78, 0.06 + 0.03 * p, 0.04), 4, 0.3)
    d, *_ = ellipse(cx, cy, s * 0.2, s * 0.17)
    hh, m = dome(d, 4)
    pop.put(m, hh, (0.05, 0.04, 0.06), 14, 0.2)
pop_col = shade(pop, (-0.3, -0.7, 0.6), (1.3, 1.0, 0.75), (0.2, 0.18, 0.28), 0.22, (1.0, 0.55, 0.3), 1.0, (1, 0.9, 0.8))
pm = blur(pop.m, 0.6)[..., None]
img = img * (1 - pm) + pop_col * pm

# ------------------------------------------------------------------------------------ colombe
dove = Layer()
WHITE = (0.93, 0.92, 0.90)
feather_n = noise(4, 2, 61)


def wing(sign):
    sx, sy = 400 + sign * 28, 362
    tipx, tipy = 400 + sign * 300, 150
    nf = 22
    for i in range(nf):
        k = i / (nf - 1)
        # point d'attache le long du bord d'attaque (léger arc)
        ax = sx + (tipx - sx) * k
        ay = sy + (tipy - sy) * k - 40 * np.sin(np.pi * k)
        ln = 55 + 120 * k ** 1.3
        # les plumes partent vers l'arrière (bas) et s'ouvrent en éventail vers le bout
        ang = np.pi / 2 - sign * (0.25 + 1.05 * k ** 1.6)
        cx, cy = ax + np.cos(ang) * ln * 0.5, ay + np.sin(ang) * ln * 0.5
        wdt = 15 - 4 * k
        d, u, v = ellipse(cx, cy, ln * 0.52, wdt, ang)
        hh, m = dome(d, 10)
        tone = 0.96 - 0.06 * (i % 2) - 0.1 * k
        dove.put(m, hh + 2 * smoothstep(-1, 1, -v / wdt), (tone, tone * 0.985, tone * 0.96), 40 + 30 * (1 - k) + i * 0.4, 0.3)
    # couvertures : rangées plus courtes près du bord d'attaque
    for row in range(3):
        nf2 = 16
        for i in range(nf2):
            k = i / (nf2 - 1) * (0.85 - 0.15 * row)
            ax = sx + (tipx - sx) * k
            ay = sy + (tipy - sy) * k - 40 * np.sin(np.pi * k)
            ln = (28 + 30 * k) * (1 - 0.2 * row)
            ang = np.pi / 2 - sign * (0.35 + 0.9 * k)
            cx, cy = ax + np.cos(ang) * ln * (0.25 + 0.2 * row), ay + np.sin(ang) * ln * (0.25 + 0.2 * row) - 4
            d, u, v = ellipse(cx, cy, ln * 0.5, 11 - 2 * row, ang)
            hh, m = dome(d, 8)
            dove.put(m, hh, WHITE, 90 + 10 * (3 - row) + i * 0.2, 0.3)


wing(-1)
wing(1)
# queue en éventail
for i in range(9):
    a = np.pi / 2 + (i - 4) * 0.12
    ln = 95 - abs(i - 4) * 4
    d, u, v = ellipse(400 + np.cos(a) * ln * 0.55, 470 + np.sin(a) * ln * 0.55, ln * 0.55, 13, a)
    hh, m = dome(d, 8)
    dove.put(m, hh, (0.9, 0.89, 0.87), 60 + abs(i - 4) * -1, 0.3)
# corps
d, u, v = ellipse(400, 400, 46, 78, 0.0)
hh, m = dome(d, 60, 0.02)
dove.put(m, hh, WHITE, 120, 0.25)
# tête et cou
d, u, v = ellipse(398, 318, 36, 40)
hh, m = dome(d, 45, 0.02)
dove.put(m, hh, WHITE, 150, 0.25)
d, _ = capsule((399, 335), (400, 370), 34, 42)
hh, m = dome(d, 40)
dove.put(m, hh, WHITE, 140, 0.25)
# bec (tourné vers la gauche, légèrement levé) et cire
d, _ = capsule((372, 312), (346, 302), 8, 3)
hh, m = dome(d, 8)
dove.put(m, hh, (0.86, 0.55, 0.40), 200, 0.8)
d, *_ = ellipse(375, 306, 7, 5)
hh, m = dome(d, 4)
dove.put(m, hh, (0.92, 0.88, 0.84), 205, 0.2)
# œil
d, *_ = ellipse(383, 307, 6.5, 6.5)
hh, m = dome(d, 5)
dove.put(m, hh, (0.05, 0.04, 0.05), 210, 2.0)
dove.alb *= (0.97 + 0.06 * feather_n)[..., None]
dove_col = shade(dove, (0.15, 0.45, 0.88), (0.55, 0.58, 0.7), (0.25, 0.27, 0.36), 0.42, (1.0, 0.82, 0.5), 2.2, (1.0, 1.0, 1.0), 2.4)
# auréole lumineuse sur le pourtour (le soleil est derrière)
edge = np.clip(blur(dove.m, 3) - blur(dove.m, 10), 0, 1)
dm = blur(dove.m, 0.7)[..., None]
img = img * (1 - dm) + dove_col * dm
img += (edge * (1 - dove.m * 0.5))[..., None] * np.array([1.0, 0.8, 0.45]) * 0.9
# reflet de l'œil
d, *_ = ellipse(381, 305, 1.8, 1.8)
img += (1 - smoothstep(0.6, 1.2, d))[..., None] * 0.8

# brin d'olivier dans le bec, pendant vers la gauche
twig = Layer()
pts = [(350, 304), (330, 318), (310, 338), (296, 362)]
for a, b in zip(pts, pts[1:]):
    d, _ = capsule(a, b, 2.4, 2.0)
    hh, m = dome(d, 3)
    twig.put(m, hh, (0.35, 0.27, 0.15), 0, 0.1)
rng = np.random.default_rng(91)
for i in range(7):
    k = (i + 0.5) / 7
    seg = min(int(k * 3), 2)
    f = k * 3 - seg
    px = pts[seg][0] * (1 - f) + pts[seg + 1][0] * f
    py = pts[seg][1] * (1 - f) + pts[seg + 1][1] * f
    a = (np.pi * 0.75 if i % 2 else -np.pi * 0.1) + rng.uniform(-0.3, 0.3)
    ln = rng.uniform(20, 27)
    d, u, v = ellipse(px + np.cos(a) * ln * 0.5, py + np.sin(a) * ln * 0.5, ln * 0.5, ln * 0.14, a)
    hh, m = dome(d, 4)
    twig.put(m, hh, (0.36, 0.46, 0.22), 2, 0.5)
d, *_ = ellipse(300, 352, 6, 8, 0.4)   # une olive
hh, m = dome(d, 6)
twig.put(m, hh, (0.26, 0.30, 0.12), 4, 1.2)
twig_col = shade(twig, (0.1, 0.4, 0.9), (0.8, 0.8, 0.75), (0.2, 0.22, 0.25), 0.35, (1.0, 0.85, 0.4), 1.6, (1, 1, 0.9), 0.6)
tm = blur(twig.m, 0.5)[..., None]
img = img * (1 - tm) + twig_col * tm

# ------------------------------------------------------------------------------------ finition : brume chaude, vignette, grain
haze = np.exp(-((Y - 690) / 90) ** 2) * 0.12
img = img * (1 - haze[..., None]) + np.array([1.0, 0.75, 0.5]) * haze[..., None]
vig = 1 - 0.45 * smoothstep(0.45, 1.1, np.hypot((X - 400) / 520, (Y - 500) / 620) * 1.3)
img *= vig[..., None]
img += noise(2, 1, 99)[..., None] * 0.02
img = np.clip(img, 0, 1) ** (1 / 1.05)

out = sys.argv[1] if len(sys.argv) > 1 else "paix-ref.png"
Image.fromarray((img * 255).astype(np.uint8)).save(out, optimize=True)
print(out)
