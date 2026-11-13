"""Image de référence réaliste d'un clown émotif : rendu par champ de hauteur + éclairage. Sortie PNG."""
import sys
import numpy as np
from PIL import Image, ImageFilter

W, H = 800, 1000
rng = np.random.default_rng(3)
Y, X = np.mgrid[0:H, 0:W].astype(np.float32)


def gauss(cx, cy, sx, sy, amp=1.0, rot=0.0):
    c, s = np.cos(rot), np.sin(rot)
    dx, dy = X - cx, Y - cy
    u, v = c * dx + s * dy, -s * dx + c * dy
    return amp * np.exp(-(u * u) / (2 * sx * sx) - (v * v) / (2 * sy * sy))


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def ellipse_mask(cx, cy, rx, ry, soft=2.0, rot=0.0):
    c, s = np.cos(rot), np.sin(rot)
    dx, dy = X - cx, Y - cy
    u, v = c * dx + s * dy, -s * dx + c * dy
    d = np.sqrt((u / rx) ** 2 + (v / ry) ** 2)
    return 1 - smoothstep(1 - soft / max(rx, ry), 1 + soft / max(rx, ry), d)


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


def blur(a, r):
    from scipy.ndimage import gaussian_filter
    return gaussian_filter(a.astype(np.float32), r)


# ---------------------------------------------------------------- géométrie de la tête
HX, HY = 400, 470
# ovale du visage : mâchoire plus étroite
rx = 200 * (1 + 0.07 * np.exp(-((Y - 500) / 80) ** 2)) * (1 - 0.28 * np.clip((Y - 560) / 230, 0, 1) ** 1.4) * (1 - 0.06 * np.clip((380 - Y) / 200, 0, 1))
face_d = np.sqrt(((X - HX) / rx) ** 2 + ((Y - HY) / 290) ** 2)
face = 1 - smoothstep(0.985, 1.01, face_d)
z = np.sqrt(np.clip(1 - face_d ** 2, 0, 1)) * 150 * face

# modelé anatomique
z += gauss(HX, 355, 120, 22, 14)                       # arcade sourcilière
for s in (-1, 1):
    z += gauss(HX + s * 88, 418, 42, 26, -26)          # orbites
    z += gauss(HX + s * 88, 420, 26, 15, 16)           # globes oculaires
    z += gauss(HX + s * 88, 446, 30, 9, 4)             # paupière inférieure gonflée (fatigue)
    z += gauss(HX + s * 128, 500, 40, 30, 12)          # pommettes
    z += gauss(HX + s * 112, 565, 30, 45, -10)         # creux des joues
    z += gauss(HX + s * 58, 560, 6, 46, -7, s * 0.35)  # sillons nez-bouche
    z += gauss(HX + s * 190, 430, 22, 60, -12)         # tempes
z += gauss(HX, 470, 16, 60, 30)                        # arête du nez
z += gauss(HX, 540, 40, 36, 46)                        # nez rouge (sphère)
z += gauss(HX, 604, 52, 10, 8)                         # lèvre supérieure
z += gauss(HX, 628, 46, 12, 10)                        # lèvre inférieure (gonflée, tremble)
z += gauss(HX, 616, 46, 3, -10)                        # fente des lèvres
for s in (-1, 1):
    z += gauss(HX + s * 50, 626, 9, 9, -6)             # coins de bouche tombants
z += gauss(HX, 715, 55, 30, 14)                        # menton
z += gauss(HX, 682, 40, 8, -6)                         # creux sous la lèvre
z *= face
z += 2.5 * noise(40, 2, 11) * face                     # irrégularités légères
z_skin_micro = 0.12 * noise(3, 1, 12)                  # grain du fard

# cou et épaules (à part)
nw = 78 + 0.12 * np.clip(Y - 700, 0, 300)
neck = (1 - smoothstep(nw - 4, nw + 4, np.abs(X - HX))) * smoothstep(640, 660, Y) * (Y < 960)
shoulders_d = ((X - HX) / 380) ** 2 + ((Y - 1120) / 260) ** 2
shoulders = 1 - smoothstep(0.98, 1.02, shoulders_d)
zb = np.sqrt(np.clip(1 - ((X - HX) / nw) ** 2, 0, 1)) * 60 * neck
zb = np.maximum(zb, np.sqrt(np.clip(1 - shoulders_d, 0, 1)) * 120 * shoulders)

# ---------------------------------------------------------------- normales et lumière
def normals(zz, micro=None):
    zz = zz + (micro if micro is not None else 0)
    gy, gx = np.gradient(blur(zz, 1.2))
    n = np.dstack([-gx, -gy, np.ones_like(zz)])
    return n / np.linalg.norm(n, axis=2, keepdims=True)


def norm3(v):
    v = np.array(v, np.float32)
    return v / np.linalg.norm(v)


KEY = norm3([-0.55, -0.6, 0.6])      # poursuite chaude en haut à gauche
RIM = norm3([0.95, -0.15, -0.1])     # contre-jour froid à droite
FILL = norm3([0.4, 0.3, 0.85])
VIEW = np.array([0, 0, 1], np.float32)
KEYC = np.array([1.0, 0.86, 0.66], np.float32) * 1.25
RIMC = np.array([0.45, 0.55, 1.0], np.float32) * 0.9
FILLC = np.array([0.35, 0.3, 0.45], np.float32) * 0.45
AMB = np.array([0.12, 0.1, 0.16], np.float32)


def shade(albedo, n, spec=0.0, shin=40.0, rim=1.0, sss=0.0):
    ndl = np.clip(np.einsum("ijk,k->ij", n, KEY), 0, 1)
    # diffusion sous la surface : le terminateur rougit
    wrap = np.clip((np.einsum("ijk,k->ij", n, KEY) + 0.3) / 1.3, 0, 1)
    nfl = np.clip(np.einsum("ijk,k->ij", n, FILL), 0, 1)
    nrim = np.clip(np.einsum("ijk,k->ij", n, RIM), 0, 1) ** 2.2 * (1 - np.clip(n[..., 2], 0, 1)) ** 0.6
    hv = norm3(KEY + VIEW)
    sp = np.clip(np.einsum("ijk,k->ij", n, hv), 0, 1) ** shin
    col = albedo * (AMB + KEYC * ndl[..., None] + FILLC * nfl[..., None])
    if sss:
        col += albedo * np.array([0.5, 0.12, 0.08]) * sss * (wrap - ndl)[..., None]
    col += RIMC * nrim[..., None] * rim * 0.9
    col += KEYC * sp[..., None] * spec
    return col


# ---------------------------------------------------------------- fond : chapiteau de nuit
bg = np.zeros((H, W, 3), np.float32)
t = Y / H
bg[...] = (np.array([0.07, 0.05, 0.11]) * (1 - t)[..., None] + np.array([0.14, 0.06, 0.09]) * t[..., None])
stripes = (np.sin((X + 0.15 * Y) / 38) > 0.3).astype(np.float32)
bg *= (1 - 0.25 * blur(stripes, 6))[..., None]
spot = np.exp(-(((X - 230) / 260) ** 2 + ((Y - 300) / 320) ** 2))
bg += np.array([0.55, 0.3, 0.14]) * (spot ** 1.5)[..., None] * 0.6
beam = np.clip(1 - np.abs((X - 0.55 * Y) - 60) / 140, 0, 1) * np.clip(1 - Y / 700, 0, 1)
bg += np.array([0.35, 0.25, 0.15]) * (beam ** 2)[..., None] * 0.25
dust = (rng.random((H, W)) > 0.9993).astype(np.float32) * spot
bg += blur(dust, 1.2)[..., None] * np.array([2.5, 2.2, 1.6])
vig = np.clip(1 - 0.75 * (((X - 400) / 520) ** 2 + ((Y - 480) / 640) ** 2), 0, 1)
bg *= vig[..., None]
img = bg.copy()

# ---------------------------------------------------------------- costume et collerette
nb = normals(zb, 0.6 * noise(10, 2, 5))
neck_alb = np.array([0.82, 0.66, 0.58])
neck_col = shade(np.broadcast_to(neck_alb, (H, W, 3)), nb, sss=0.6)
neck_col *= (1 - 0.8 * np.clip(1 - (Y - 700) / 110, 0, 1))[..., None]  # ombre portée du menton
img = img * (1 - neck[..., None]) + neck_col * neck[..., None]
cost_alb = np.dstack([np.full((H, W), 0.17), np.full((H, W), 0.12), np.full((H, W), 0.32)])
dots = np.zeros((H, W), np.float32)
for _ in range(14):
    cx, cy = rng.uniform(120, 680), rng.uniform(980, 1000 + 60)
    dots = np.maximum(dots, ellipse_mask(cx, cy + rng.uniform(0, 60), 18, 16, 2))
cost_alb = cost_alb * (1 - dots[..., None]) + np.array([0.75, 0.58, 0.18]) * dots[..., None]
cost = shade(cost_alb, nb, spec=0.05, shin=12)
cm = shoulders * (1 - neck * (Y < 880))
img = img * (1 - cm[..., None]) + cost * cm[..., None]


# collerette : bande plissée vue de face
y0 = 878 + 55 * ((X - HX) / 300) ** 2
ruff = (np.abs(Y - y0) < 30).astype(np.float32) * (np.abs(X - HX) < 310)
ruff = blur(ruff, 1.2)
pleat = np.sin((X - HX) / 8.5 + 1.5 * np.sin((X - HX) / 37))
zr = ruff * (18 + 12 * pleat) + ruff * 14 * np.cos((Y - y0) / 30 * 1.5)
nr = normals(blur(zr, 1.2))
ruff_col = shade(np.broadcast_to(np.array([0.93, 0.92, 0.97]), (H, W, 3)), nr, spec=0.06, shin=10, rim=0.6)
ruff_col *= (0.7 + 0.3 * (pleat * 0.5 + 0.5))[..., None]
img = img * (1 - ruff[..., None]) + ruff_col * ruff[..., None]

# ---------------------------------------------------------------- cheveux : touffes orange
hair = np.zeros((H, W), np.float32)
for s in (-1, 1):
    for k in range(10):
        cx = HX + s * rng.uniform(215, 300)
        cy = rng.uniform(330, 600)
        hair = np.maximum(hair, ellipse_mask(cx, cy, rng.uniform(45, 75), rng.uniform(45, 70), 12))
hair *= 1 - face
bumps = np.zeros((H, W), np.float32)
for _ in range(1400):
    cx, cy = rng.uniform(60, 740), rng.uniform(260, 680)
    r_ = rng.uniform(5, 10)
    bumps = np.maximum(bumps, gauss(cx, cy, r_, r_, r_))
strand = blur(noise(10, 2, 21), 1.5)
zh = blur(hair, 14) * 90 + bumps * 1.4 * hair
nh = normals(zh)
hair_alb = np.dstack([0.8 + 0.3 * strand, 0.3 + 0.15 * strand, 0.07 + 0.05 * strand])
hair_col = shade(np.clip(hair_alb, 0, 1), nh, spec=0.18, shin=14, rim=0.8, sss=0.4)
img = img * (1 - hair[..., None]) + hair_col * hair[..., None]

# ---------------------------------------------------------------- visage : albédo (fard, maquillage)
n = normals(z, z_skin_micro)
skin = np.array([0.86, 0.7, 0.62])
paint_white = np.array([0.93, 0.91, 0.88])
patch = 0.03 * noise(16, 3, 31)
greasepaint = face * (0.93 + 0.07 * smoothstep(-0.2, 0.2, noise(40, 2, 32)))
alb = skin * (1 - greasepaint[..., None]) + (paint_white + patch[..., None]) * greasepaint[..., None]
spec_map = 0.12 * face  # fard légèrement satiné

# craquelures du fard sec
cr = np.abs(noise(7, 3, 41))
cracks = (cr < 0.004).astype(np.float32) * face * (1 - ellipse_mask(HX, 540, 60, 60, 4))
alb *= (1 - 0.35 * blur(cracks, 0.6))[..., None]

# joues un peu rosées sous le fard
for s in (-1, 1):
    alb = alb * (1 - 0.12 * gauss(HX + s * 128, 530, 45, 32)[..., None]) + np.array([0.95, 0.6, 0.62]) * 0.12 * gauss(HX + s * 128, 530, 45, 32)[..., None]

# losanges bleus au-dessus et au-dessous des yeux
def diamond(cx, cy, w, h_):
    return 1 - smoothstep(0.95, 1.05, np.abs(X - cx) / w + np.abs(Y - cy) / h_)

blue = np.zeros((H, W), np.float32)
for s in (-1, 1):
    blue = np.maximum(blue, diamond(HX + s * 88, 420, 50, 92) * 0.85)
blue *= (1 - 0.15 * noise(6, 2, 51))
alb = alb * (1 - blue[..., None]) + np.array([0.12, 0.27, 0.72]) * blue[..., None]

# sourcils peints très hauts et tristes
brow = np.zeros((H, W), np.float32)
for s in (-1, 1):
    for k in np.linspace(0, 1, 40):
        bx = HX + s * (35 + 120 * k)
        by = 300 + 40 * (k - 0.35) ** 2 * 4 - 28 * np.sin(np.pi * k)
        brow = np.maximum(brow, gauss(bx, by, 4.5, 3.2 + 3 * np.sin(np.pi * k)) )
alb = alb * (1 - np.clip(brow * 1.4, 0, 1)[..., None]) + np.array([0.06, 0.04, 0.07]) * np.clip(brow * 1.4, 0, 1)[..., None]

# grand sourire peint (le masque), usé
smile = np.zeros((H, W), np.float32)
for k in np.linspace(-1, 1, 80):
    sx_ = HX + 150 * k
    sy_ = 640 - 70 * (k ** 2) + 20
    smile = np.maximum(smile, gauss(sx_, sy_ - 8, 9, 13 * (1 - 0.6 * k * k)))
smile = np.clip(smile * 1.3, 0, 1) * (0.75 + 0.25 * smoothstep(-0.2, 0.3, noise(5, 2, 61)))
# vraie bouche : lèvres naturelles, rougies
lips = ellipse_mask(HX, 616, 52, 22, 6)
alb = alb * (1 - smile[..., None]) + np.array([0.68, 0.06, 0.13]) * smile[..., None]
alb = alb * (1 - lips[..., None] * 0.8) + np.array([0.62, 0.1, 0.16]) * lips[..., None] * 0.8
mouth_line = gauss(HX, 616, 44, 2.2) * 0.9
for s in (-1, 1):
    mouth_line = np.maximum(mouth_line, gauss(HX + s * 46, 623, 8, 2.5, 0.8, s * 0.5))
alb *= (1 - mouth_line[..., None] * 0.85)
# rouge étalé sur la joue droite (essuyé)
smear = gauss(HX + 170, 590, 30, 14, 0.5, -0.7) * (0.6 + 0.4 * noise(4, 2, 62))
alb = alb * (1 - smear[..., None]) + np.array([0.7, 0.12, 0.18]) * smear[..., None]

# nez rouge verni
nose = ellipse_mask(HX, 540, 47, 44, 2)
alb = alb * (1 - nose[..., None]) + np.array([0.78, 0.04, 0.08]) * nose[..., None]
spec_map = np.maximum(spec_map, nose * 1.6)
spec_map = np.maximum(spec_map, lips * 0.5)

# coulure de fard bleu le long de la larme (joue gauche)
lx = HX - 98
run = np.zeros((H, W), np.float32)
for k in np.linspace(0, 1, 60):
    run = np.maximum(run, gauss(lx + 6 * np.sin(k * 7), 455 + 230 * k, 4 + 2 * k, 6, 0.75 * (1 - 0.5 * k)))
alb = alb * (1 - run[..., None]) + np.array([0.15, 0.22, 0.55]) * run[..., None]

face_col = shade(alb, n, spec=0.0, sss=0.8)
# spéculaire variable (nez verni, lèvres humides, fard satiné)
hv = norm3(KEY + VIEW)
sp = np.clip(np.einsum("ijk,k->ij", n, hv), 0, 1)
face_col += KEYC * (sp ** 60 * spec_map)[..., None] * 1.6
face_col += KEYC * (sp ** 8 * spec_map * 0.15)[..., None]

# occlusion ambiante : creux plus sombres
cav = np.clip(blur(z, 14) - z, 0, 40) / 40
face_col *= (1 - 0.55 * cav)[..., None]
# ombre portée du chapeau sur le front
hat_shadow = gauss(HX + 70, 250, 140, 40) * face
face_col *= (1 - 0.5 * hat_shadow)[..., None]

# ---------------------------------------------------------------- yeux humides
for s in (-1, 1):
    ex, ey = HX + s * 88, 422
    eye = ellipse_mask(ex, ey, 34, 15, 1.5) * (Y > ey - 15 + 6 * ((X - ex) / 34) ** 2 - 2)
    sclera = np.array([0.86, 0.8, 0.8]) * (1 - 0.25 * smoothstep(0.4, 1, np.abs(X - ex) / 34))[..., None]
    ix, iy = ex - s * 5, ey + 2
    rr = np.hypot(X - ix, Y - iy)
    ang = np.arctan2(Y - iy, X - ix)
    iris_m = 1 - smoothstep(12, 13.5, rr)
    iris_col = np.dstack([0.22 + 0.1 * np.sin(ang * 23), 0.38 + 0.12 * np.sin(ang * 31), 0.55 + 0.1 * np.sin(ang * 17)])
    iris_col *= (0.6 + 0.4 * smoothstep(13, 4, rr))[..., None]
    pupil = 1 - smoothstep(4.5, 5.5, rr)
    ecol = sclera * (1 - iris_m[..., None]) + iris_col * iris_m[..., None]
    ecol = ecol * (1 - pupil[..., None]) + 0.02 * pupil[..., None]
    lid_shadow = smoothstep(ey + 4, ey - 15, Y)
    ecol *= (1 - 0.55 * lid_shadow)[..., None]
    # reflets humides
    ecol += gauss(ix - s * 4, iy - 5, 2.2, 2.2, 1.6)[..., None]
    ecol += gauss(ex, ey + 9, 22, 2.2, 0.35)[..., None] * np.array([0.8, 0.9, 1.0])  # larme au bord
    face_col = face_col * (1 - eye[..., None]) + ecol * eye[..., None]
    # paupière lourde et cils
    lid = np.clip(gauss(ex, ey - 13, 36, 4.5, 1.0) - gauss(ex, ey - 16, 30, 3, 0.4), 0, 1)
    face_col *= (1 - 0.85 * lid)[..., None]
    lash = np.zeros((H, W), np.float32)
    for k in np.linspace(-1, 1, 14):
        x0, y0 = ex + 32 * k, ey - 13 + 5 * k * k
        for tt in np.linspace(0, 1, 6):
            lash = np.maximum(lash, gauss(x0 + s * 0 + k * 6 * tt, y0 - 9 * tt, 0.9, 0.9, 1 - tt))
    face_col *= (1 - 0.9 * np.clip(lash, 0, 1))[..., None]
    # bord inférieur rougi
    face_col = face_col * (1 - gauss(ex, ey + 15, 30, 2.5, 0.5)[..., None]) + np.array([0.75, 0.25, 0.3]) * gauss(ex, ey + 15, 30, 2.5, 0.5)[..., None]

# larme : goutte brillante et sillon mouillé
trail = np.zeros((H, W), np.float32)
for k in np.linspace(0, 1, 50):
    trail = np.maximum(trail, gauss(lx + 6 * np.sin(k * 7) + 2, 455 + 215 * k, 1.6, 4, 0.8))
face_col += (trail * 0.45)[..., None] * np.array([0.85, 0.92, 1.0])
drop = ellipse_mask(lx + 4, 690, 8, 12, 1.5)
face_col = face_col * (1 - drop[..., None] * 0.6) + np.array([0.55, 0.7, 0.85]) * drop[..., None] * 0.6
face_col += gauss(lx + 1, 684, 2, 2.5, 1.4)[..., None]

img = img * (1 - face[..., None]) + face_col * face[..., None]

# ---------------------------------------------------------------- chapeau cabossé
crown = (np.abs((X - 470) / 82) ** 3 + np.abs((Y - 180) / 85) ** 3 < 1).astype(np.float32)
crown = blur(crown, 1.5)
brim = ellipse_mask(470, 265, 150, 22, 3, -0.12)
hatm = np.clip(np.maximum(crown, brim), 0, 1)
zhat = blur(hatm, 12) * 60 + 1.5 * blur(noise(30, 2, 71), 3) * hatm
nhat = normals(zhat)
hat_alb = np.broadcast_to(np.array([0.12, 0.09, 0.16]), (H, W, 3)).copy()
band = ((Y > 238) & (Y < 258)).astype(np.float32) * crown
hat_alb = hat_alb * (1 - band[..., None]) + np.array([0.5, 0.06, 0.16]) * band[..., None]
hat_col = shade(hat_alb, nhat, spec=0.4, shin=25, rim=1.5)
img = img * (1 - hatm[..., None]) + hat_col * hatm[..., None]
flower = ellipse_mask(530, 120, 14, 14, 2)
img = img * (1 - flower[..., None]) + np.array([0.85, 0.68, 0.25]) * flower[..., None] * (0.6 + 0.4 * np.clip(-np.einsum("ijk,k->ij", nhat, KEY), 0, 1))[..., None]

# ---------------------------------------------------------------- étalonnage photo
img = np.clip(img, 0, None)
img = img / (1 + img * 0.35)                 # compression des hautes lumières
img = np.clip(img, 0, 1) ** (1 / 1.15)
lum = img.mean(axis=2, keepdims=True)
img = np.clip(lum + (img - lum) * 1.12, 0, 1)  # saturation
img += (rng.normal(0, 0.012, (H, W, 1))).astype(np.float32)  # grain
out = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
out = out.filter(ImageFilter.GaussianBlur(0.6))
out.save(sys.argv[1] if len(sys.argv) > 1 else "/tmp/clown-ref.png")
print("ok")
