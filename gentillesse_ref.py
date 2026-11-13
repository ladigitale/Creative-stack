"""Image de référence « la gentillesse » : une main tend une tasse fumante à deux mains qui la recueillent,
dans la lumière chaude d'une fenêtre, fond d'intérieur flou. Rendu procédural (champs de hauteur déformés par du
bruit, occlusion ambiante, peau à variations de teinte, vapeur advectée, flou de profondeur), à peindre par
`sonic-painterly` (entrée `image` de l'outil Abysse). Sortie PNG."""
import sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

W, H = 1000, 800
Y0, X0 = np.mgrid[0:H, 0:W].astype(np.float32)
rng = np.random.default_rng(13)


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


# Déformation du domaine : aucune forme n'est un cercle ou un cylindre parfait.
WARP_X = noise(90, 3, 1) * 2 + noise(20, 2, 2) * 0.4
WARP_Y = noise(90, 3, 3) * 2 + noise(20, 2, 4) * 0.4
X, Y = X0, Y0


def warp(amp):
    global X, Y
    X = X0 + WARP_X * amp
    Y = Y0 + WARP_Y * amp


def ellipse(cx, cy, rx, ry, rot=0.0):
    c, s = np.cos(rot), np.sin(rot)
    dx, dy = X - cx, Y - cy
    u, v = c * dx + s * dy, -s * dx + c * dy
    return np.sqrt((u / rx) ** 2 + (v / ry) ** 2), u, v


def capsule(p0, p1, r0, r1=None):
    r1 = r0 if r1 is None else r1
    a = np.array(p0, np.float32)
    b = np.array(p1, np.float32)
    ba = b - a
    t = np.clip(((X - a[0]) * ba[0] + (Y - a[1]) * ba[1]) / (ba @ ba), 0, 1)
    px, py = X - (a[0] + t * ba[0]), Y - (a[1] + t * ba[1])
    d = np.sqrt(px * px + py * py)
    r = r0 + (r1 - r0) * t
    # côté signé (pour les plis transverses) et abscisse le long du segment
    side = (px * -ba[1] + py * ba[0]) / np.linalg.norm(ba)
    return d / r, t, side


def gauss(cx, cy, sx, sy, amp=1.0, rot=0.0):
    c, s = np.cos(rot), np.sin(rot)
    dx, dy = X - cx, Y - cy
    u, v = c * dx + s * dy, -s * dx + c * dy
    return amp * np.exp(-(u * u) / (2 * sx * sx) - (v * v) / (2 * sy * sy))


def dome(d, height, soft=0.04):
    m = 1 - smoothstep(1 - soft, 1 + soft, d)
    return np.sqrt(np.clip(1 - d * d, 0, 1)) * height, m


# ------------------------------------------------------------------------------------ scène (z-buffer unique)
Z = np.full((H, W), -1e9, np.float32)
HGT = np.zeros((H, W), np.float32)
M = np.zeros((H, W), np.float32)
ALB = np.zeros((H, W, 3), np.float32)
SPEC = np.zeros((H, W), np.float32)
ROUGH = np.full((H, W), 30.0, np.float32)
SSS = np.zeros((H, W), np.float32)
OID = np.zeros((H, W), np.int8)
CUR = [0]


def put(mask, height, alb, zbase, spec=0.0, rough=30.0, sss=0.0):
    z = zbase + height
    take = (mask > 0.5) & (z >= Z)
    Z[take] = z[take]
    HGT[take] = z[take]
    M[:] = np.maximum(M, mask)
    a = np.broadcast_to(np.asarray(alb, np.float32), (H, W, 3))
    ALB[take] = a[take]
    SPEC[take] = spec if np.isscalar(spec) else spec[take]
    ROUGH[take] = rough
    SSS[take] = sss
    OID[take] = CUR[0]


SKIN = np.array([0.80, 0.57, 0.45], np.float32)
skin_var = (1 + 0.08 * noise(25, 3, 30) + 0.05 * noise(6, 2, 31))[..., None] * np.array([1.0, 0.97, 0.95])
skin_alb = np.clip(SKIN * skin_var, 0, 1)

# ---- tasse : grès crème moucheté, légèrement irrégulière
warp(2.5)
CX, TOP, BOT, R, RY = 520, 300, 575, 110, 22
u = (X - CX) / R
inside = np.abs(u) < 1
cap = np.sqrt(np.clip(1 - u * u, 0, 1))
top_edge = TOP + RY * cap
bot_edge = BOT + RY * cap
body = inside & (Y > top_edge) & (Y < bot_edge)
mug_h = cap * R
speck = (noise(2, 1, 50) > 0.42).astype(np.float32) * 0.25
glaze = np.dstack([0.86 - speck, 0.80 - speck, 0.70 - speck]) * (1 + 0.05 * noise(30, 2, 51))[..., None]
# coulure d'émail plus sombre vers le pied
foot = smoothstep(BOT - 70, BOT, Y)
glaze = glaze * (1 - 0.35 * foot[..., None]) + np.array([0.45, 0.30, 0.22]) * 0.35 * foot[..., None]
put(body.astype(np.float32), mug_h, glaze, 100, 1.4, 60)
# lèvre et intérieur : ellipse du haut
d, _, v = ellipse(CX, TOP, R, RY)
rim = (d < 1.0).astype(np.float32)
put(rim, np.full((H, W), R * 0.98, np.float32), (0.88, 0.83, 0.74), 100, 1.0, 60)
d2, _, _ = ellipse(CX, TOP + 3, R - 9, RY - 5)
coffee = (d2 < 1).astype(np.float32)
put(coffee, np.full((H, W), R * 0.99, np.float32), (0.20, 0.10, 0.05), 100, 2.5, 120)
# ---- manche de laine (receveur, à gauche) : torsades
warp(4)
d, t, side = capsule((-60, 560), (215, 505), 120, 96)
hh, m = dome(d, 70, 0.06)
knit = 0.5 + 0.5 * np.sin(side * 0.28 + 2.0 * np.sin(t * 40)) * np.sin(t * 160)
rib = 6 * np.abs(np.sin(side * 0.11))
wool = np.array([0.74, 0.62, 0.42]) * (0.82 + 0.25 * knit[..., None]) * (1 + 0.08 * noise(4, 2, 60))[..., None]
put(m, hh + 5 * knit + rib, wool, 60, 0.05, 8)
# poignet du receveur
warp(2)
d, t, side = capsule((215, 505), (300, 495), 64, 60)
hh, m = dome(d, 46)
put(m, hh, skin_alb, 70, 0.25, 18, 1.0)

# ---- mains : chaque main est UN champ de hauteur (union lissée de ses parties), pas un assemblage de boudins


def soft_dome(d, height):
    """Profil arrondi à bord adouci (pas de pente verticale au contour)."""
    m = 1 - smoothstep(0.96, 1.04, d)
    return height * np.clip(1 - d * d, 0, 1) ** 0.6, m


class Hand:
    def __init__(self):
        self.parts = []

    def add(self, d, height, lift=0.0):
        hh, m = soft_dome(d, height)
        self.parts.append((np.where(m > 0.02, hh + lift, -1e4), m))

    def field(self, k=4.0):
        hs = np.stack([p[0] for p in self.parts])
        mx = hs.max(axis=0)
        h = mx + k * np.log(np.sum(np.exp((hs - mx) / k), axis=0))
        m = np.max(np.stack([p[1] for p in self.parts]), axis=0)
        return np.where(m > 0.02, h, 0), m


def finger(hand, pts, w, lift=0.0, taper=0.18):
    n = len(pts) - 1
    for k, (a, b) in enumerate(zip(pts, pts[1:])):
        w0 = w * (1 - taper * k / n)
        w1 = w * (1 - taper * (k + 1) / n)
        d, t, side = capsule(a, b, w0, w1)
        hand.add(d, w0 * 0.55, lift)
        # articulation : léger gonflement et plis fins transverses
        if k < n:
            ang = np.arctan2(b[1] - a[1], b[0] - a[0])
            hand.add(ellipse(b[0], b[1], w1 * 1.02, w1 * 1.0, ang)[0], w1 * 0.6, lift + 0.8)


warp(2)
# main gauche du receveur : dos de main à plat contre le flanc, doigts qui enveloppent la tasse
left = Hand()
d, t, side = capsule((250, 505), (330, 478), 62, 58)                   # poignet
left.add(d, 34)
left.add(ellipse(372, 470, 84, 64, -0.18)[0], 30)                      # dos de la main, plat
fingers = [
    ([(420, 430), (474, 418), (522, 412), (556, 416)], 20),   # index
    ([(430, 466), (490, 459), (546, 457), (588, 464)], 21),   # majeur, le plus long
    ([(428, 500), (484, 498), (536, 500), (574, 508)], 20),   # annulaire
    ([(418, 532), (464, 535), (504, 541), (530, 550)], 17),   # auriculaire
]
for pts, w in fingers:
    finger(left, pts, w, 6)
finger(left, [(352, 412), (392, 376), (436, 350), (470, 338)], 23, 10, 0.25)   # pouce sur la lèvre
lh, lm = left.field(2.0)
# plis fins aux articulations et rides du dos de la main
wr = 0.6 * np.sin((X - 0.25 * Y) * 0.9) * smoothstep(0.1, 0.4, noise(30, 2, 120))
put(lm, lh + wr, skin_alb, 200, 0.12, 10, 1.0)
nail_m = np.zeros((H, W), np.float32)
for pts, w in fingers:
    tip, prev = pts[-1], pts[-2]
    ang = np.arctan2(tip[1] - prev[1], tip[0] - prev[0])
    cx, cy = tip[0] - np.cos(ang) * w * 0.35, tip[1] - np.sin(ang) * w * 0.35
    d, _, _ = ellipse(cx, cy, w * 0.5, w * 0.38, ang)
    hh, m = soft_dome(d, 2.5)
    base = lh + 200
    put(m, hh + (base - 200), (0.88, 0.70, 0.64), 201, 1.6, 60, 0.4)
    nail_m = np.maximum(nail_m, m)

# main qui donne (à droite) : dos de la main, doigts repliés derrière l'anse, pouce dessus
warp(2)
right = Hand()
d, t, side = capsule((900, 420), (820, 440), 60, 56)
right.add(d, 34)
right.add(ellipse(760, 452, 80, 60, 0.15)[0], 30)
gfingers = [
    ([(712, 424), (676, 418), (652, 428)], 18),
    ([(706, 456), (668, 458), (648, 472)], 19),
    ([(708, 488), (672, 496), (656, 510)], 18),
    ([(714, 516), (686, 528), (672, 540)], 15),
]
for pts, w in gfingers:
    finger(right, pts, w, 6, 0.12)
finger(right, [(744, 404), (712, 374), (680, 360)], 21, 12, 0.2)        # pouce
CUR[0] = 2
rh, rm = right.field(2.0)
warp(4)
d, t, side = capsule((1080, 380), (850, 440), 106, 80)
hh, m = dome(d, 66, 0.06)
weave = 0.5 + 0.5 * np.sin(side * 0.9) * np.sin(t * 300)
jersey = np.array([0.56, 0.24, 0.14]) * (0.85 + 0.2 * weave[..., None]) * (1 + 0.1 * noise(5, 2, 70))[..., None]
put(m, hh + 2 * weave, jersey, 190, 0.05, 8)
warp(2)
put(rm, rh, skin_alb * np.array([1.0, 0.98, 0.96]), 150, 0.12, 10, 1.0)

# anse : un vrai « C » lisse, devant les doigts de la main qui donne
warp(1.5)
ang = np.arctan2(Y - 445, X - 640)
rad = np.hypot((X - 640) / 1.0, (Y - 445) / 1.15)
ring = np.abs(rad - 62) / 13
arc = (np.cos(ang) > -0.2).astype(np.float32)
hh, m = dome(ring, 14)
put(m * arc, hh, glaze, 175, 1.4, 60)
CUR[0] = 0
warp(0)

# ------------------------------------------------------------------------------------ éclairage
Hs = blur(HGT * (M > 0.5), 1.3)
gy, gx = np.gradient(Hs)
gx = np.clip(gx, -1.6, 1.6)
gy = np.clip(gy, -1.6, 1.6)
n = np.dstack([-gx, -gy, np.ones_like(Hs)])
n /= np.linalg.norm(n, axis=2, keepdims=True)
L = np.array([-0.62, -0.45, 0.64], np.float32)
L /= np.linalg.norm(L)
ndl = n @ L
diff = np.clip(ndl, 0, 1)
# terminateur adouci et teinté (diffusion sous la peau)
wrap = np.clip((ndl + 0.35) / 1.35, 0, 1) ** 1.5
key = np.array([1.35, 1.02, 0.72], np.float32)
fill_dir = np.array([0.55, 0.2, 0.8], np.float32)
fill_dir /= np.linalg.norm(fill_dir)
fill = np.clip(n @ fill_dir, 0, 1)
fill_col = np.array([0.22, 0.26, 0.34], np.float32)
# occlusion ambiante par le relief et par les objets posés au-dessus
zz = np.where(M > 0.5, Z, 0)
ao = 1 - 0.6 * np.clip((blur(zz, 9) - zz) / 30, 0, 1)
ao *= 1 - 0.45 * np.clip((blur(zz, 22) - zz) / 60, 0, 1)
sss = SSS[..., None]
diffuse = (diff[..., None] * (1 - sss) + wrap[..., None] * sss) * key
diffuse += sss * np.clip(wrap - diff, 0, 1)[..., None] * np.array([0.55, 0.12, 0.05])   # rougeur au terminateur
col = ALB * (diffuse + fill[..., None] * fill_col + 0.10) * ao[..., None]
# spéculaire (Blinn)
Hv = L + np.array([0, 0, 1], np.float32)
Hv /= np.linalg.norm(Hv)
sp = np.clip(n @ Hv, 0, 1) ** ROUGH
col += (sp * SPEC * ao)[..., None] * np.array([1.0, 0.92, 0.8]) * 0.55
# reflet de la fenêtre sur la tasse (bande verticale)
win_ref = np.exp(-((X0 - (CX - 55)) / 9) ** 2) * body * (1 - smoothstep(TOP + 40, BOT, Y0) * 0.6)
col += win_ref[..., None] * np.array([1.0, 0.95, 0.85]) * 0.5
# contre-jour : liseré chaud sur les bords tournés vers la fenêtre
rim = (1 - n[..., 2]) ** 2 * np.clip(-(n[..., 0] * 0.8 + n[..., 1] * 0.6), 0, 1)
col += (rim * 0.9)[..., None] * np.array([1.0, 0.72, 0.4]) * (0.6 + 0.4 * sss)
# veines discrètes et rougeur des articulations sur la peau
veins = smoothstep(0.18, 0.3, np.abs(noise(40, 3, 80))) < 0.5
col = col * (1 - (SSS * 0.06 * veins)[..., None] * np.array([0.0, 0.5, -0.2]))
knuckle = np.zeros((H, W), np.float32)
for pts, w in fingers + gfingers:
    knuckle += gauss(*pts[0], 12, 12, 1) + gauss(*pts[1], 9, 9, 0.7)
col *= (1 - (SSS * np.clip(knuckle, 0, 1) * 0.12)[..., None] * np.array([0.0, 0.6, 0.7]))
fg = np.clip(col, 0, 2)
far = blur((OID == 2).astype(np.float32), 3)
fgb = np.dstack([blur(fg[..., c], 3.2) for c in range(3)])
fg = fg * (1 - far[..., None]) + fgb * far[..., None]
fg = np.dstack([blur(fg[..., c], 0.7) for c in range(3)])

# ------------------------------------------------------------------------------------ fond : intérieur flou
t = Y0 / H
bg = np.dstack([0.20 + 0.10 * (1 - t), 0.13 + 0.06 * (1 - t), 0.09 + 0.03 * (1 - t)])
# fenêtre floue en haut à gauche
win = ((X0 > 40) & (X0 < 330) & (Y0 > -40) & (Y0 < 300)).astype(np.float32)
win *= 1 - ((np.abs(X0 - 185) < 9) | (np.abs(Y0 - 130) < 8)).astype(np.float32) * 0.85
win = blur(win, 22)
bg += win[..., None] * np.array([1.25, 1.0, 0.72])
bg += (blur(win, 120) * 0.9)[..., None] * np.array([0.9, 0.6, 0.35])
# bokeh : guirlande et lampes
bok = np.zeros((H, W, 3), np.float32)
for i in range(26):
    bx = rng.uniform(380, 1000)
    by = rng.uniform(20, 300) + 40 * np.sin(bx / 120)
    r = rng.uniform(14, 34)
    d = np.hypot(X0 - bx, Y0 - by) / r
    disc = (1 - smoothstep(0.85, 1.0, d)) * (0.7 + 0.3 * smoothstep(0.5, 1.0, d))
    c = np.array([1.0, rng.uniform(0.6, 0.8), rng.uniform(0.3, 0.45)]) * rng.uniform(0.25, 0.6)
    bok += disc[..., None] * c
bg += blur(bok, 1.5)
# table de bois floue en bas
tab = smoothstep(690, 720, Y0)
wood = np.array([0.36, 0.21, 0.12]) * (0.8 + 0.3 * blur(noise(60, 3, 90) + 0.4 * np.sin(X0 / 9 + 6 * noise(200, 2, 91)), 3))[..., None]
bg = bg * (1 - tab[..., None]) + wood * tab[..., None]
bg += (np.exp(-(Y0 - 715) ** 2 / 60) * 0.25)[..., None] * np.array([1.0, 0.7, 0.4])
bg = blur(bg.transpose(2, 0, 1), 0).transpose(1, 2, 0)
for c in range(3):
    bg[..., c] = blur(bg[..., c], 6)
# ombre portée des mains et de la tasse sur la table (lumière venue de la gauche)
sh = np.roll(np.roll(blur(M, 18), 60, axis=1), 120, axis=0) * tab
bg *= (1 - 0.5 * sh)[..., None]

mask = blur((M > 0.5).astype(np.float32), 0.8)[..., None]
img = bg * (1 - mask) + fg * mask

# ------------------------------------------------------------------------------------ vapeur
sx = X0 + 18 * noise(70, 3, 100) + 8 * np.sin(Y0 / 40)
sy = Y0
steam = np.zeros((H, W), np.float32)
for k in range(4):
    cxk = CX - 40 + k * 28 + 22 * np.sin(Y0 / (55 + 9 * k) + k * 1.7) * (1 + (TOP - Y0) / 160)
    width = 9 + (TOP - Y0) * 0.08
    plume = np.exp(-((sx - cxk) / np.maximum(width, 4)) ** 2)
    steam += plume * (0.6 + 0.6 * noise(25, 3, 110 + k))
fade = smoothstep(TOP + 5, TOP - 25, Y0) * smoothstep(-20, 180, Y0)
steam = np.clip(blur(steam * fade, 2.5), 0, 1)
# éclairée à contre-jour : plus lumineuse côté fenêtre
steam_col = np.array([1.0, 0.92, 0.82]) * (0.7 + 0.5 * smoothstep(700, 300, X0))[..., None]
img = img * (1 - steam[..., None] * 0.45) + steam_col * steam[..., None] * 0.45

# ------------------------------------------------------------------------------------ finition photographique
glow = blur(np.clip(img.mean(axis=2) - 0.75, 0, 1), 25)
img += glow[..., None] * np.array([1.0, 0.75, 0.45]) * 0.6
vig = 1 - 0.5 * smoothstep(0.35, 1.0, np.hypot((X0 - 520) / 620, (Y0 - 430) / 520))
img *= vig[..., None]
# légère aberration et grain
img[..., 0] = map_coordinates(img[..., 0], [Y0, X0 + (X0 - 500) * 0.0015], order=1, mode="nearest")
img += rng.normal(0, 0.012, img.shape).astype(np.float32)
img = np.clip(img, 0, 1) ** (1 / 1.08)

out = sys.argv[1] if len(sys.argv) > 1 else "gentillesse-ref.png"
Image.fromarray((img * 255).astype(np.uint8)).save(out, optimize=True)
print(out)
