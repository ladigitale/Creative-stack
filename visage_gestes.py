"""Gestes « visage souriant » : une base de visage au trait, proportions classiques, peu de traits.
Tête de face : largeur ≈ 0,7 × hauteur ; yeux à mi-hauteur, écartés d'une largeur d'œil (5 largeurs d'œil dans
la tête) ; tiers égaux racine des cheveux / sourcils / base du nez / menton ; bouche au tiers entre nez et menton,
large comme l'écart des pupilles ; oreilles entre sourcils et base du nez. Courbes Catmull-Rom, pression effilée."""
import json, math, sys

W, H = 800, 1000
INK, SOFT = "#3b2a24", "#8a6a5c"


def cr(ctrl, n=14):
    """Catmull-Rom (uniforme) passant par les points de contrôle."""
    p = [ctrl[0]] + ctrl + [ctrl[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in (0, 1)))
    out.append(tuple(ctrl[-1]))
    return out


def stroke(ctrl, taper=0.25, lo=0.35):
    pts = cr(ctrl)
    flat = []
    n = len(pts)
    for i, (x, y) in enumerate(pts):
        t = i / max(1, n - 1)
        e = min(t, 1 - t) / taper if taper else 1
        pr = lo + (1 - lo) * (math.sin(min(1, e) * math.pi / 2) if taper else 1)
        flat += [round(x, 1), round(y, 1), round(pr, 2)]
    return flat


def mirror(ctrl):
    return [(W - x, y) for x, y in ctrl]


S = []
def add(ctrl, size=None, color=None, taper=0.25, lo=0.35, sym=False):
    for c in ([ctrl, mirror(ctrl)] if sym else [ctrl]):
        g = {"pts": stroke(c, taper, lo)}
        if size is not None: g["size"] = size
        if color is not None: g["color"] = color
        S.append(g)

# Contour du visage (moitié gauche, symétrique) : de la tempe, sous les cheveux, au menton.
add([(206, 392), (203, 450), (214, 545), (246, 628), (300, 694), (352, 726), (400, 734)], size=6, sym=True, taper=0.12, lo=0.55)
# Oreilles.
add([(203, 438), (182, 430), (170, 462), (176, 512), (190, 552), (210, 570)], size=4.5, sym=True)
# Sourcils.
add([(268, 418), (300, 404), (338, 404), (366, 414)], size=5, sym=True, taper=0.35)
# Yeux : paupière supérieure en amande, paupière inférieure légère (yeux rieurs), iris.
add([(282, 458), (302, 444), (328, 440), (352, 446), (364, 456)], size=4, sym=True, taper=0.2, lo=0.5)
add([(290, 462), (322, 470), (356, 460)], size=2.5, color=SOFT, sym=True, taper=0.4)
add([(312, 446), (310, 456), (318, 465), (330, 464), (336, 455), (333, 445)], size=3, color=INK, sym=True, taper=0.3, lo=0.6)
add([(321, 453), (323, 456)], size=7, color=INK, sym=True, taper=0, lo=1)
# Nez : arête légère et base.
add([(392, 470), (388, 520), (382, 556)], size=3, color=SOFT, taper=0.4)
add([(374, 566), (384, 580), (400, 584), (416, 580), (426, 566)], size=4, color=INK, taper=0.3)
# Sourire : ligne de la bouche, lèvre inférieure, fossettes.
add([(330, 616), (360, 636), (400, 644), (440, 636), (470, 616)], size=5, color=INK, taper=0.22, lo=0.4)
add([(372, 664), (400, 670), (428, 664)], size=3, color=SOFT, taper=0.4)
add([(322, 606), (328, 614), (330, 624)], size=2.5, color=SOFT, sym=True, taper=0.5)
# Cheveux : masse au-dessus du crâne, racine des cheveux, raie.
add([(206, 430), (188, 330), (214, 236), (290, 168), (400, 142), (510, 168), (586, 236), (612, 330), (594, 430)], size=6, color=INK, taper=0.1, lo=0.5)
add([(214, 400), (238, 316), (300, 270), (360, 262), (392, 266)], size=4.5, color=INK, taper=0.25)
add([(392, 266), (450, 282), (520, 300), (568, 352), (588, 402)], size=4.5, color=INK, taper=0.25)
add([(392, 266), (380, 210), (360, 160)], size=3, color=SOFT, taper=0.4)
# Cou et épaules.
add([(312, 700), (316, 770), (322, 830)], size=5, color=INK, sym=True, taper=0.2)
add([(322, 830), (260, 856), (190, 880), (150, 900)], size=5, sym=True, taper=0.3)

S[0] = {"tool": "paint", "reset": True, "pressure": True, "angle": 0, "angleFollow": False, "tremble": 0, "color": INK,
        "hardness": 0.85, "opacity": 1, "blend": "normal", "spacing": 0.08, "tip": "", "roundness": 1,
        "angleJitter": 0, "sizeJitter": 0, "scatter": 0, **S[0]}
json.dump({"width": W, "height": H, "strokes": S}, open(sys.argv[1], "w"))
print(len(S), "traits")
