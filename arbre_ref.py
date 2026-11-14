"""Image de référence « un arbre » : un grand chêne seul dans un pré, fin d'après-midi d'été, lumière chaude
venue de la gauche. Ciel en dégradé avec quelques nuages, collines lointaines voilées, pré texturé. Le tronc et
les branches sont générés récursivement (cylindres ombrés) ; le houppier est fait de touffes sphériques
(tampon de profondeur, normales, lumière, bord de feuillage découpé par du bruit, trous de ciel), avec son
ombre portée sur l'herbe. Sortie PNG."""
import sys
import math
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, zoom as nzoom

W, H = 1000, 750
SS = 2                       # suréchantillonnage
w, h = W * SS, H * SS
rng = np.random.default_rng(2611)
L = np.array([-0.62, -0.55, 0.56]); L /= np.linalg.norm(L)   # lumière (x droite, y bas, z vers nous)
HORIZON = 0.60 * h


def noise(n_h, n_w, scale, seed, octaves=4):
    r = np.random.default_rng(seed)
    out = np.zeros((n_h, n_w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        s = scale / (2 ** o)
        gh, gw = max(2, int(n_h / s) + 2), max(2, int(n_w / s) + 2)
        g = r.random((gh, gw)).astype(np.float32)
        up = nzoom(g, (n_h / (gh - 1), n_w / (gw - 1)), order=3)[:n_h, :n_w]
        out += amp * up
        tot += amp
        amp *= 0.5
    return out / tot


def mix(a, b, t):
    t = np.asarray(t)[..., None] if np.ndim(t) else t
    return a * (1 - t) + b * t


yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
img = np.zeros((h, w, 3), np.float32)

# --- ciel
ty = np.clip(yy / HORIZON, 0, 1)
sky_top, sky_mid, sky_low = np.array([0.36, 0.55, 0.80]), np.array([0.62, 0.74, 0.88]), np.array([0.97, 0.88, 0.70])
sky = mix(mix(sky_top, sky_mid, np.clip(ty * 1.6, 0, 1)), sky_low, np.clip((ty - 0.55) / 0.45, 0, 1) ** 1.4)
cl = noise(h, w, 260, 5, 5)
cl = np.clip((cl - 0.52) * 4.0, 0, 1) * np.clip(1 - ty * 1.1, 0, 1)
cloud = np.array([1.0, 0.96, 0.90]) * (0.92 + 0.08 * noise(h, w, 60, 6)[..., None])
sky = mix(sky, cloud, cl * 0.75)
img[:] = sky

# --- collines lointaines (voilées) et proches
for k, (base, amp, col, haze, seed) in enumerate([
    (HORIZON - 70 * SS, 40 * SS, np.array([0.55, 0.62, 0.70]), 0.55, 11),
    (HORIZON - 25 * SS, 30 * SS, np.array([0.42, 0.52, 0.42]), 0.35, 12),
]):
    prof = noise(1, w, 300, seed, 3)[0] * amp * 2 - amp
    top = base + prof
    m = yy >= top[None, :]
    c = mix(col, sky_low, haze)
    img[m] = (c * (0.94 + 0.06 * noise(h, w, 40, seed + 1)[..., None]))[m]

# --- pré
g = np.clip((yy - HORIZON) / (h - HORIZON), 0, 1)
grass_far, grass_near = np.array([0.62, 0.66, 0.36]), np.array([0.36, 0.48, 0.18])
gn = noise(h, w, 90, 21, 5)
blades = noise(h, w, 6, 22, 2)
grass = mix(grass_far, grass_near, g ** 0.8)
grass = grass * (0.82 + 0.3 * gn[..., None]) * (0.9 + 0.2 * blades[..., None] * g[..., None])
warm = np.array([1.06, 1.0, 0.86])
grass = grass * mix(np.ones(3), warm, np.clip(1 - g * 1.4, 0, 1))
gm = yy >= HORIZON
img[gm] = grass[gm]
# fleurs claires éparses au premier plan
fl = (noise(h, w, 3, 23, 1) > 0.93) & (yy > HORIZON + 0.25 * (h - HORIZON)) & (noise(h, w, 140, 24, 2) > 0.5)
img[fl] = mix(img[fl], np.array([0.98, 0.95, 0.80]), 0.7)

# --- arbre : branches récursives
TX, TY = 0.47 * w, 0.86 * h
segs = []     # (x0, y0, x1, y1, r0, r1)
tips = []     # (x, y, taille)


def grow(x, y, ang, length, rad, depth):
    x1, y1 = x + math.cos(ang) * length, y + math.sin(ang) * length
    r1 = rad * (0.68 if depth else 0.5)
    segs.append((x, y, x1, y1, rad, r1))
    if depth == 0 or length < 14 * SS:
        tips.append((x1, y1, length))
        return
    if depth <= 3:
        tips.append((x1, y1, length * 1.1))
    n = 2 if depth > 5 else rng.choice([2, 3], p=[0.5, 0.5])
    spread = 0.62 + 0.15 * rng.random()
    for i in range(n):
        t = (i / (n - 1) - 0.5) if n > 1 else 0
        a = ang + t * 2 * spread + rng.normal(0, 0.18)
        a = a * 0.9 + (-math.pi / 2) * 0.1          # tendance à monter
        if depth >= 6:
            a = ang + t * 1.5 * spread + rng.normal(0, 0.1)
        a = min(-0.3, max(-math.pi + 0.3, a))        # jamais vers le bas
        grow(x1, y1, a, length * (0.72 + 0.12 * rng.random()), r1, depth - 1)


grow(TX, TY, -math.pi / 2 + 0.04, 0.15 * h, 0.036 * w, 7)
# racines (empattement)
for a, l in [(math.pi - 0.25, 0.05), (0.25, 0.055), (math.pi - 0.08, 0.035), (0.1, 0.04)]:
    segs.append((TX, TY - 0.02 * h, TX + math.cos(a) * l * w, TY + math.sin(a) * l * w * 0.25 - 0.005 * h, 0.022 * w, 0.004 * w))

# --- ombre portée (à droite, aplatie)
sh = np.zeros((h, w), np.float32)
cx_sh, cy_sh = TX + 0.13 * w, TY + 0.015 * h
sh += np.exp(-(((xx - cx_sh) / (0.26 * w)) ** 2 + ((yy - cy_sh) / (0.045 * h)) ** 2) * 1.6)
sh *= (0.75 + 0.5 * noise(h, w, 25, 31, 3))
sh = np.clip(sh, 0, 1) * (yy > HORIZON)
img *= (1 - 0.55 * sh[..., None])
img = mix(img, img * np.array([0.85, 0.92, 1.05]), sh * 0.5)

ground = img.copy()
zbuf = np.full((h, w), -1e9, np.float32)

# --- bois
bark_n = noise(h, w, 8, 41, 3)
bark_lit, bark_dark = np.array([0.52, 0.42, 0.31]), np.array([0.13, 0.10, 0.08])
for (x0, y0, x1, y1, r0, r1) in segs:
    pad = max(r0, r1) + 2
    bx0, bx1 = int(max(0, min(x0, x1) - pad)), int(min(w, max(x0, x1) + pad))
    by0, by1 = int(max(0, min(y0, y1) - pad)), int(min(h, max(y0, y1) + pad))
    if bx1 <= bx0 or by1 <= by0:
        continue
    X, Y = xx[by0:by1, bx0:bx1], yy[by0:by1, bx0:bx1]
    dx, dy = x1 - x0, y1 - y0
    ll = dx * dx + dy * dy + 1e-6
    t = np.clip(((X - x0) * dx + (Y - y0) * dy) / ll, 0, 1)
    px, py = x0 + t * dx, y0 + t * dy
    r = r0 + (r1 - r0) * t
    d = np.hypot(X - px, Y - py)
    inside = d <= r
    side = ((X - px) * (-dy) + (Y - py) * dx) / math.sqrt(ll)       # écart latéral signé
    u = np.clip(side / np.maximum(r, 1e-3), -1, 1)
    nz = np.sqrt(np.clip(1 - u * u, 0, 1))
    nx, ny = u * (-dy) / math.sqrt(ll), u * dx / math.sqrt(ll)
    lam = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1)
    z = 50 + nz * r
    put = inside & (z > zbuf[by0:by1, bx0:bx1])
    ridges = bark_n[by0:by1, bx0:bx1]
    c = mix(bark_dark, bark_lit, np.clip(lam * 1.1 * (0.7 + 0.5 * ridges), 0, 1))
    sub = img[by0:by1, bx0:bx1]
    sub[put] = c[put]
    zbuf[by0:by1, bx0:bx1][put] = z[put]

# --- houppier : enveloppe en dôme large (chêne), remplie de petites touffes
CX, CY, AX, BY = TX + 0.01 * w, 0.37 * h, 0.37 * w, 0.24 * h
env_n = noise(h // 8 + 1, w // 8 + 1, 12, 71, 3)


def in_crown(x, y):
    ux, uy = (x - CX) / AX, (y - CY) / BY
    uy = uy * (1.25 if uy > 0 else 0.95)           # dessous plus plat, haut en dôme
    wob = 0.18 * (env_n[int(min(h - 1, max(0, y)) // 8), int(min(w - 1, max(0, x)) // 8)] - 0.5) * 2
    return ux * ux + uy * uy < (1 + wob) ** 2 and y < CY + 0.62 * BY


clumps = []
while len(clumps) < 420:
    x, y = CX + (rng.random() * 2 - 1) * AX * 1.2, CY + (rng.random() * 2 - 1) * BY * 1.2
    if not in_crown(x, y):
        continue
    r = (0.016 + 0.018 * rng.random()) * w
    # profondeur : plus on va vers le bord, plus la touffe est en arrière ; le centre avance
    ux, uy = (x - CX) / AX, (y - CY) / BY
    zc = 40 + 140 * max(0.0, 1 - math.hypot(ux, uy)) + rng.random() * 30
    clumps.append((x, y, r, zc))

leaf_n = noise(h, w, 4, 51, 2)
leaf_m = noise(h, w, 18, 52, 3)
leaf_dark, leaf_mid, leaf_lit = np.array([0.07, 0.13, 0.06]), np.array([0.22, 0.36, 0.12]), np.array([0.72, 0.74, 0.32])
fol = np.zeros((h, w), bool)
loc = np.zeros((h, w), np.float32)
occ = np.zeros((h, w), np.float32)
for (cx, cy, r, zc) in sorted(clumps, key=lambda c: c[3]):
    pad = r * 1.25
    bx0, bx1 = int(max(0, cx - pad)), int(min(w, cx + pad))
    by0, by1 = int(max(0, cy - pad)), int(min(h, cy + pad))
    if bx1 <= bx0 or by1 <= by0:
        continue
    X, Y = xx[by0:by1, bx0:bx1], yy[by0:by1, bx0:bx1]
    ux, uy = (X - cx) / r, (Y - cy) / r
    d2 = ux * ux + uy * uy
    # bord feuillu : rayon modulé par le bruit fin
    edge = 1.0 + 0.22 * (leaf_n[by0:by1, bx0:bx1] - 0.5) * 2 + 0.12 * (leaf_m[by0:by1, bx0:bx1] - 0.5)
    inside = d2 <= edge * edge
    nz = np.sqrt(np.clip(1 - d2, 0.02, 1))
    lam = np.clip(0.5 + 0.6 * (ux * L[0] + uy * L[1]) + 0.25 * (nz - 0.6), 0, 1)
    z = zc + nz * r
    put = inside & (z > zbuf[by0:by1, bx0:bx1])
    loc[by0:by1, bx0:bx1][put] = lam[put]
    occ[by0:by1, bx0:bx1][put] = 0.7 + 0.3 * np.clip((zc - 40) / 140, 0, 1)
    fol[by0:by1, bx0:bx1][put] = True
    zbuf[by0:by1, bx0:bx1][put] = z[put]

# volume d'ensemble : normale de l'enveloppe du houppier (masque adouci)
env = gaussian_filter(fol.astype(np.float32), 40 * SS)
gy_, gx_ = np.gradient(env)
k = 70 * SS
nx, ny, nz = -gx_ * k, -gy_ * k, np.ones_like(env) * 0.9
nn = np.sqrt(nx * nx + ny * ny + nz * nz)
glob = np.clip((nx * L[0] + ny * L[1] + nz * L[2]) / nn, 0, 1)
# le dessous et l'intérieur du houppier sont dans l'ombre
inner = np.clip((env - 0.5) * 2, 0, 1)
g2 = np.clip((glob - 0.45) / 0.45, 0, 1)
side = np.clip(0.5 - (xx - CX) / (2.2 * AX) - (yy - CY) / (3.0 * BY), 0, 1)     # côté soleil (haut gauche)
under = np.clip((yy - (CY + 0.1 * BY)) / (0.5 * BY), 0, 1)                         # dessous du houppier
v = (0.45 * g2 + 0.35 * side + 0.35 * loc) * occ * (1 - 0.5 * under) * (1 - 0.25 * inner)
v = v * (0.8 + 0.4 * leaf_n) * (0.9 + 0.2 * leaf_m)
v = np.clip(gaussian_filter(v, 0.8 * SS), 0, 1)
c = np.where(v[..., None] < 0.45, mix(leaf_dark, leaf_mid, v / 0.45), mix(leaf_mid, leaf_lit, np.clip((v - 0.45) / 0.5, 0, 1)))
img[fol] = c[fol]

# trous de ciel dans le feuillage (près du bord, là où il est fin)
hole = (noise(h, w, 16, 61, 2) > 0.8) & fol & (env < 0.5) & (yy < CY)
img[hole] = sky[hole]

# --- herbe devant le pied du tronc
tuft = (yy > TY - 0.012 * h + 0.03 * h * (noise(h, w, 3, 81, 1) - 0.5)) & (np.abs(xx - TX) < 0.08 * w)
img[tuft] = ground[tuft]

# --- finition : légère lueur chaude, vignette, grain
glow = np.exp(-(((xx - 0.1 * w) / (0.6 * w)) ** 2 + ((yy - 0.45 * h) / (0.5 * h)) ** 2))
img = img + glow[..., None] * np.array([0.06, 0.04, 0.0])
vig = 1 - 0.18 * (((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
img *= vig[..., None]
img += (rng.random((h, w, 1)) - 0.5) * 0.015
img = np.clip(img, 0, 1)

out = Image.fromarray((img * 255).astype(np.uint8)).resize((W, H), Image.LANCZOS)
out.save(sys.argv[1] if len(sys.argv) > 1 else "arbre-ref.png")
