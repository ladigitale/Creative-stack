"""Image de référence « lac de montagne à l'aube » : un vrai relief (carte d'altitude fractale, crêtes, vallée
glaciaire noyée par un lac) vu en perspective depuis la rive. Rendu par colonnes (« voxel space ») : ombrage
par les normales, occlusion des creux, neige sur les replats d'altitude, forêt en bas des pentes, brume de
distance, lac qui reflète la scène avec des rides. Lumière d'aube rasante venue de la gauche. Sortie PNG."""
import sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

W, H = 1000, 700
HZ = 390.0            # ligne d'horizon (écran)
F = 620.0             # focale (px)
N = 1024              # carte d'altitude N × N (unités du monde)
CAM_U, CAM_V = 512.0, 0.0
WATER = 30.0          # niveau du lac
CAM_H = WATER + 22.0  # caméra juste au-dessus de l'eau
S = 2.4               # une unité de la carte = S unités du monde (reliefs plus grands, plus lointains)
rng = np.random.default_rng(1404)


def blur(a, r):
    return gaussian_filter(a.astype(np.float32), r)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def value_noise(n, scale, seed):
    r = np.random.default_rng(seed)
    s = max(2, int(scale))
    small = r.random((n // s + 3, n // s + 3)).astype(np.float32)
    big = np.asarray(Image.fromarray(small).resize((n + 3 * s, n + 3 * s), Image.BICUBIC), np.float32)
    return big[s:s + n, s:s + n]


def fbm(n, scale, octaves, seed, ridged=False, gain=0.5):
    out = np.zeros((n, n), np.float32)
    amp, tot, prev = 1.0, 0.0, np.ones((n, n), np.float32)
    for o in range(octaves):
        v = value_noise(n, scale / 2 ** o, seed + o)
        if ridged:
            v = np.clip(1 - np.abs(v * 2 - 1), 0, 1) ** 1.3
            v = v * prev        # multifractal : le détail se pose sur les crêtes
            prev = np.clip(v * 1.6, 0, 1)
        out += amp * v
        tot += amp
        amp *= gain
    return out / tot


# ------------------------------------------------------------------------------------ carte d'altitude
vv, uu = np.mgrid[0:N, 0:N].astype(np.float32)
# déformation du domaine : vallées sinueuses
wu = (fbm(N, 300, 3, 7) - 0.5) * 120
wv = (fbm(N, 300, 3, 8) - 0.5) * 120
ridged = map_coordinates(fbm(N, 340, 7, 11, ridged=True), [np.clip(vv + wv, 0, N - 1), np.clip(uu + wu, 0, N - 1)], order=1)
hills = fbm(N, 180, 6, 21)
# massif au fond, pentes latérales, vallée (lac) au premier plan au centre
back = smoothstep(300, 760, vv)
side = smoothstep(90, 330, np.abs(uu - CAM_U - 40 * np.sin(vv / 150)))
valley = np.maximum(back, side * smoothstep(60, 300, vv) * 0.4 + side * 0.12)
detail = fbm(N, 26, 5, 23)
height = (0.7 * ridged + 0.3 * fbm(N, 260, 5, 22)) * 760 * valley ** 1.3 + hills * 80 * (0.3 + valley) + 8
# ravines et éperons : détail fin qui grandit avec l'altitude
height += (detail - 0.5) * 70 * smoothstep(60, 400, height)
# lit glaciaire en U : fond plat sous le lac
height = height * (0.25 + 0.75 * smoothstep(0.05, 0.5, valley)) + (1 - valley) * 6
height = blur(height, 1.0)
gy, gx = np.gradient(height)
normal = np.dstack([-gx, -gy, np.ones_like(height)])
normal /= np.linalg.norm(normal, axis=2, keepdims=True)
curv = blur(height, 6) - height                      # > 0 dans les creux
snow_noise = fbm(N, 40, 4, 31)
rock_noise = fbm(N, 20, 4, 32)

# ------------------------------------------------------------------------------------ rendu par colonnes
xs = np.arange(W, dtype=np.float32)
zs = np.geomspace(3, N * S, 1600).astype(np.float32)
du = (xs - W / 2) / F
ytop = np.empty((len(zs), W), np.float32)
for k, z in enumerate(zs):
    u = CAM_U + du * z / S
    v = (CAM_V + z) / S
    h = map_coordinates(height, [np.full(W, min(v, N - 1)), u], order=1, mode="mirror")
    h = np.maximum(h, WATER)
    ytop[k] = HZ - (h - CAM_H) * F / z
cum = np.minimum.accumulate(ytop, axis=0)            # plus haut point vu jusqu'à cette distance
Y, X = np.mgrid[0:H, 0:W].astype(np.float32)
kidx = np.full((H, W), len(zs), np.int32)
rows = np.arange(H, dtype=np.float32)
for x in range(W):
    rev = cum[::-1, x]                               # croissant
    cnt = np.searchsorted(rev, rows, side="right")
    kidx[:, x] = len(zs) - cnt
ground = kidx < len(zs)
Z = zs[np.minimum(kidx, len(zs) - 1)]
U = CAM_U + (X - W / 2) / F * Z / S
V = (CAM_V + Z) / S
coords = [np.clip(V, 0, N - 1), U]
hh = map_coordinates(height, coords, order=1, mode="mirror")
water = ground & (hh <= WATER + 0.3)
nrm = np.dstack([map_coordinates(normal[..., c], coords, order=1, mode="mirror") for c in range(3)])
cv = map_coordinates(curv, coords, order=1, mode="mirror")
sn = map_coordinates(snow_noise, coords, order=1, mode="mirror")
rn = map_coordinates(rock_noise, coords, order=1, mode="mirror")

# ------------------------------------------------------------------------------------ ciel
t = np.clip(Y / HZ, 0, 1.2)
sky = np.dstack([
    np.interp(t, [0, 0.5, 0.85, 1.0, 1.2], [0.17, 0.40, 0.88, 0.99, 0.99]),
    np.interp(t, [0, 0.5, 0.85, 1.0, 1.2], [0.24, 0.43, 0.66, 0.80, 0.80]),
    np.interp(t, [0, 0.5, 0.85, 1.0, 1.2], [0.45, 0.63, 0.70, 0.66, 0.66]),
]).astype(np.float32)
sunx, suny = 120.0, HZ - 10
glow = np.exp(-np.hypot((X - sunx) / 480, (Y - suny) / 240) * 2.0)
sky += glow[..., None] * np.array([0.55, 0.32, 0.12])
cl = np.asarray(Image.fromarray(fbm(512, 120, 5, 41)).resize((W, H), Image.BICUBIC))
cl = np.clip((cl - 0.53) * 3.5, 0, 1) * smoothstep(20, 90, Y) * (1 - smoothstep(HZ - 120, HZ - 60, Y))
cl = blur(cl, [2, 10])
under = np.clip((cl - np.roll(cl, -5, axis=0)) * 5, 0, 1)
cloud = np.array([0.97, 0.72, 0.70]) * (0.72 + 0.45 * under)[..., None] + glow[..., None] * np.array([0.25, 0.12, 0.05])
skyimg = sky * (1 - 0.8 * cl[..., None]) + cloud * 0.8 * cl[..., None]

# ------------------------------------------------------------------------------------ terrain
L = np.array([-0.78, -0.2, 0.42], np.float32)    # soleil bas à gauche
L /= np.linalg.norm(L)
lit = np.clip(nrm @ L, 0, 1)
up = nrm[..., 2]
alt = hh
snow = smoothstep(0.32, 0.62, up + 0.35 * (sn - 0.5)) * smoothstep(230, 330, alt + 120 * (sn - 0.5))
forest = (1 - smoothstep(90, 150, alt + 50 * (rn - 0.5))) * smoothstep(0.55, 0.75, up)
rock = np.array([0.42, 0.37, 0.36]) * (0.7 + 0.6 * rn)[..., None]
grass = np.array([0.30, 0.33, 0.20]) * (0.8 + 0.4 * rn)[..., None]
forest_col = np.array([0.11, 0.16, 0.13]) * (0.8 + 0.5 * rn)[..., None]
alb = rock * (1 - forest[..., None]) + forest_col * forest[..., None]
alb = alb * (1 - (smoothstep(0.85, 0.95, up) * (1 - forest) * (alt < 90))[..., None] * 0.5) + grass * (smoothstep(0.85, 0.95, up) * (1 - forest) * (alt < 90))[..., None] * 0.5
alb = alb * (1 - snow[..., None]) + np.array([0.94, 0.93, 0.98]) * snow[..., None]
# alpenglow : lumière rose sur les hauteurs, plus faible en bas (le soleil vient de se lever)
warm = np.array([1.75, 1.12, 0.86]) * (0.5 + 0.7 * smoothstep(80, 500, alt))[..., None]
skylight = np.array([0.22, 0.28, 0.48]) * (0.4 + 0.6 * up)[..., None]
ao = np.clip(1 - np.clip(cv, 0, 30) / 40, 0.45, 1)[..., None]
col = alb * (lit[..., None] * warm + skylight) * ao
# brume de distance vers le ciel de l'horizon
fog = (1 - np.exp(-Z / 3400))[..., None]
haze = np.array([0.86, 0.72, 0.74]) + glow[..., None] * np.array([0.2, 0.1, 0.0])
col = col * (1 - fog * 0.7) + haze * fog * 0.7
# brume basse des vallées lointaines
valley_mist = (1 - smoothstep(40, 110, alt)) * smoothstep(600, 2000, Z)
col = col * (1 - valley_mist[..., None] * 0.6) + haze * valley_mist[..., None] * 0.6

img = np.where(ground[..., None], col, skyimg)

# ------------------------------------------------------------------------------------ lac : reflet
ry = 2 * HZ - Y
ripple = np.asarray(Image.fromarray(fbm(512, 30, 4, 51)).resize((W, H), Image.BICUBIC)) - 0.5
depthk = np.clip((Y - HZ) / (H - HZ), 0, 1)
ry = ry + ripple * 10 * depthk
rx = X + ripple * 6 * depthk
refl = np.dstack([map_coordinates(img[..., c], [np.clip(ry, 0, H - 1), np.clip(rx, 0, W - 1)], order=1) for c in range(3)])
refl = np.dstack([blur(refl[..., c], [1.5 + 2 * 0, 0.6]) for c in range(3)])
fres = 0.55 + 0.35 * (1 - depthk)           # plus de reflet au loin
water_col = np.array([0.10, 0.14, 0.18])
lake = refl * fres[..., None] * np.array([0.92, 0.95, 1.0]) + water_col * (1 - fres[..., None])
sparkle = np.clip((ripple * 2 - 0.55) * 6, 0, 1) * glow * (1 - depthk) * 1.2
lake += blur(sparkle, [0.5, 4])[..., None] * np.array([1.0, 0.75, 0.55])
img = np.where(water[..., None], lake, img)
# brume posée sur l'eau, près de la rive lointaine
mist = np.exp(-((Y - HZ - 6) / 16) ** 2) * (0.4 + 0.5 * np.asarray(Image.fromarray(fbm(256, 60, 3, 61)).resize((W, H), Image.BICUBIC)))
img = img * (1 - mist[..., None] * 0.55) + np.array([0.96, 0.84, 0.82]) * mist[..., None] * 0.55

# ------------------------------------------------------------------------------------ finition photographique
lum = img.mean(axis=2)
img += blur(np.clip(lum - 0.8, 0, 1), 16)[..., None] * np.array([1.0, 0.8, 0.6]) * 0.6
img *= (1 - 0.32 * smoothstep(0.45, 1.1, np.hypot((X - 500) / 600, (Y - 350) / 450)))[..., None]
img = np.dstack([blur(img[..., c], 0.5) for c in range(3)])
img += rng.normal(0, 0.008, img.shape).astype(np.float32)
img = np.clip(img, 0, 1) ** (1 / 1.05)
out = sys.argv[1] if len(sys.argv) > 1 else "lac-ref.png"
Image.fromarray((img * 255).astype(np.uint8)).save(out, optimize=True)
print(out)
