#!/usr/bin/env python3
"""PROTOTYPE: metal/gem variants of the basic crops, their zombie mutation parts and
flask icons. NOT wired into the game.

Writes only to tmp/variants/ (per-variant PNGs + comparison sheets). Nothing in
public/ or src/ is touched.

For each (crop, variant) the PRODUCE is recoloured through the variant's luminance ramp
and the FOLIAGE through its leaf ramp (or kept as authored when the variant has none).
Soil, the plot-edge rim, and (tomato) the wooden stakes are never touched, so a variant
crop still sits in an ordinary plot.

    python zombiefarm/tools/prize_crops.py            # prototype sheets only (tmp/variants)
    python zombiefarm/tools/prize_crops.py --install  # write the real game assets

--install builds the six PRIZE crops (reforge_economy.PRIZE_CROPS) into public/assets:
  crops/<key>_stage{1,2}.png         planted-crop art
  crop-icons/<key>_icon.png          Market card / harvest pickup sprite
  zombie/mutations/<mutkey>.png      the zombie mutation rig part (loose art, no atlas repack)
  ui/mutation/icon_mutation_<mutkey>.png   the flask icon
  zombie/prize_mutations.json        the rig offsets, copied from each base mutation
It is deterministic, so re-running it is a no-op against the committed assets.
"""
import colorsys
import json
import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
ASSETS = os.path.join(PROJ, "public", "assets")
CROP_DIR = os.path.join(ASSETS, "crops")
ICON_DIR = os.path.join(ASSETS, "ui", "mutation")
OUT = os.path.join(PROJ, "tmp", "variants")

def lima_foliage(r, g, b):
    """Lima pods are yellow-green and bright; the leaves are a deeper, bluer green."""
    h, sv, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    h *= 360
    pod = min(1.0, max(0.0, (104 - h) / 6)) * min(1.0, max(0.0, (v - 0.52) / 0.16))
    return 1.0 - pod


# crop key -> (mutation atlas frame, mutation icon name, protect wooden stakes,
# foliage weight fn or True = default green test). Lima beans are green PODS, so they use
# lima_foliage, which separates the pods from the darker leaves.
CROPS = {
    "tomato":        ("tomatoHead",     "tomato",      True, True),
    "carrot":        ("carrotHat",      "carrot",      False, True),
    "onion":         ("onionHead",      "onion",       False, True),
    "turnip":        ("turnipArm",      "turnip",      False, True),
    "potato":        ("potatoHead",     "potato",      False, True),
    "lima_beans":    ("limaBeanBody",   "limabean",    False, lima_foliage),
    "cauliflower":   ("cauliflowerHat", "cauliflower", False, True),
}

# name -> dict(title, theme, produce=(dark, mid, light), leaf=(dark, mid, light) | None,
# spark colour, glow colour | None). `leaf` None keeps the authored greens.
VARIANTS = {
    "midas": dict(
        title="Midas Touch", theme="gold",
        produce=((92, 48, 0), (226, 164, 24), (255, 248, 190)), leaf=None,
        spark=(255, 255, 235), glow=None),
    "moonsilver": dict(
        title="Moonsilver", theme="silver",
        produce=((34, 42, 60), (168, 182, 204), (248, 252, 255)),
        leaf=((16, 44, 42), (92, 150, 132), (196, 232, 214)),
        spark=(235, 245, 255), glow=None),
    "nightglass": dict(
        title="Nightglass", theme="obsidian",
        produce=((6, 4, 14), (52, 36, 88), (176, 146, 236)),
        leaf=((8, 14, 20), (34, 62, 56), (96, 156, 128)),
        spark=(210, 190, 255), glow=None),
    "bloodstone": dict(
        title="Bloodstone", theme="ruby",
        produce=((44, 0, 8), (186, 22, 52), (255, 176, 186)),
        leaf=((24, 6, 10), (90, 36, 34), (170, 110, 90)),
        spark=(255, 220, 225), glow=None),
    "frostbite": dict(
        title="Frostbite", theme="ice",
        produce=((24, 68, 118), (116, 198, 240), (242, 252, 255)),
        leaf=((20, 56, 84), (110, 176, 200), (214, 244, 250)),
        spark=(255, 255, 255), glow=None),
    "gravebone": dict(
        title="Gravebone", theme="bone",
        produce=((64, 54, 40), (204, 194, 164), (250, 246, 230)),
        leaf=((34, 34, 26), (112, 118, 84), (188, 194, 148)),
        spark=(255, 250, 235), glow=None),
    "tarnished": dict(
        title="Tarnished Penny", theme="copper + verdigris",
        produce=((66, 28, 8), (200, 112, 62), (255, 204, 156)),
        leaf=((8, 54, 50), (56, 164, 144), (176, 240, 218)),
        spark=(255, 235, 210), glow=None),
    "voidbloom": dict(
        title="Voidbloom", theme="amethyst",
        produce=((34, 8, 62), (150, 70, 214), (242, 204, 255)),
        leaf=((28, 10, 44), (104, 50, 140), (196, 140, 226)),
        spark=(250, 225, 255), glow=None),
    # ---- requested crop-specific variants -------------------------------------
    "cauliglower": dict(
        title="Cauliglower", theme="black + purple, glowing", crop="cauliflower",
        produce=((3, 1, 8), (32, 14, 60), (150, 80, 230)),
        leaf=((3, 2, 8), (20, 12, 38), (62, 34, 100)),
        spark=(226, 186, 255), glow=(150, 70, 255)),
    "obsidibeans": dict(
        title="Obsidibeans", theme="purple-black beans, green leaves", crop="lima_beans",
        produce=((1, 0, 5), (16, 6, 30), (68, 38, 108)), leaf=None,
        spark=(214, 184, 255), glow=None),
    "cosmic": dict(
        title="Cosmic Potato", theme="starry purple", crop="potato",
        produce=((8, 4, 36), (72, 38, 150), (188, 148, 255)), leaf=None,
        spark=(255, 255, 255), glow=None, stars=0.07),
    "goldcarrot": dict(
        title="Golden Carrot", theme="gold (Minecraft), a touch deeper", crop="carrot",
        produce=((104, 52, 0), (206, 138, 18), (246, 212, 108)), leaf=None,
        spark=(255, 240, 190), glow=None),
    "goldturnip": dict(
        title="Golden Turnip", theme="gold (Rune Factory 4)", crop="turnip",
        produce=((120, 70, 0), (236, 178, 38), (255, 238, 148)), leaf=None,
        spark=(255, 250, 210), glow=None),
    # ---- earlier tomato proposals ----------------------------------------------------
    "tombato": dict(
        title="Tombato", theme="grave-stone", crop="tomato",
        produce=((36, 36, 40), (148, 150, 138), (228, 230, 216)), leaf=None,
        spark=(245, 245, 235), glow=None),
    "rotten": dict(
        title="Rotten Tomato", theme="rotted, bruised", crop="tomato",
        produce=((14, 6, 18), (78, 34, 66), (190, 170, 70)),
        leaf=((10, 20, 8), (54, 70, 30), (120, 130, 60)),
        spark=(220, 230, 140), glow=None),
    "tomatoxic": dict(
        title="Tomatoxic", theme="toxic green, purple leaves", crop="tomato",
        produce=((10, 30, 0), (70, 200, 20), (220, 255, 100)),
        leaf=((20, 6, 34), (70, 40, 110), (130, 90, 180)),
        spark=(230, 255, 160), glow=(140, 255, 40)),
    "plasmato": dict(
        title="Plasmato", theme="electric plasma", crop="tomato",
        produce=((6, 14, 60), (40, 110, 255), (210, 240, 255)), leaf=None,
        spark=(230, 245, 255), glow=(80, 170, 255)),
    # ---- brain-tomato proposals (Brainato = the one you liked, as the reference) ----
    "brainato": dict(
        title="Brainato", theme="pink brain-flesh", crop="tomato",
        produce=((90, 20, 50), (240, 140, 170), (255, 225, 235)), leaf=None,
        spark=(255, 235, 242), glow=None),
    "smoothbrain": dict(
        title="Smoothbrainato", theme="glossy, zero wrinkles", crop="tomato",
        produce=((200, 110, 140), (255, 176, 200), (255, 240, 246)), leaf=None,
        spark=(255, 255, 255), glow=None, contrast=0.3),
    "lobotomato": dict(
        title="Lobotomato", theme="drained, grey-green, smooth", crop="tomato",
        produce=((70, 66, 64), (176, 168, 150), (236, 232, 214)),
        leaf=((20, 28, 18), (80, 96, 64), (150, 170, 120)),
        spark=(240, 240, 225), glow=None, contrast=0.35),
    "bigbrain": dict(
        title="Big Brainato", theme="folded, veiny, glowing", crop="tomato",
        produce=((80, 10, 50), (236, 110, 160), (255, 214, 232)), leaf=None,
        spark=(255, 220, 238), glow=(255, 110, 190), wrinkle=0.2),
    "galaxybrain": dict(
        title="Galaxy Brainato", theme="cosmic expanding brain", crop="tomato",
        produce=((16, 6, 56), (150, 70, 220), (255, 190, 240)),
        leaf=((10, 8, 40), (50, 40, 120), (120, 110, 220)),
        spark=(255, 255, 255), glow=(180, 100, 255), stars=0.08, wrinkle=0.12),
}
GENERAL = ["midas", "moonsilver", "nightglass", "bloodstone", "frostbite",
           "gravebone", "tarnished", "voidbloom"]

STAR_COLOURS = [(255, 255, 255), (255, 244, 190), (190, 230, 255), (230, 190, 255)]
LUMA = (0.299, 0.587, 0.114)
LO, HI = 0.12, 0.88


def hsv(r, g, b):
    return colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)


def is_produce(r, g, b):
    h, s, v = hsv(r, g, b)
    return 8 <= h * 360 <= 42 and s >= 0.62 and v >= 0.72


def is_soil(r, g, b):
    """Port of isSoil() in src/cropTop.ts."""
    h, s, v = hsv(r, g, b)
    h *= 360
    if 18 <= h <= 48:
        if v <= 0.72 and 0.18 <= s <= 0.85:
            return True
        if 0.6 < v <= 0.9 and 0.14 <= s <= 0.55 and r > g > b:
            return True
    return v <= 0.28 and r >= g >= b and r - b >= 8


def is_wood(r, g, b):
    """Tomato stakes: dark-to-mid saturated brown."""
    h, s, v = hsv(r, g, b)
    return 12 <= h * 360 <= 48 and s >= 0.3 and 0.05 <= v <= 0.82


def soil_mask(img, dirt):
    """True where a pixel is baked soil: inside the soil diamond, close to the soil
    tile's own colour or soil-coloured, and not bright produce. Plus the diamond's
    EDGE BAND: the rim outline sits on/just outside the soil alpha and is a darker,
    more orange brown than the soil body, which the body test misses."""
    w, h = img.size
    dx, dy = (w - dirt.width) // 2, h - dirt.height
    px, dp = img.load(), dirt.load()
    mask = set()
    alpha = Image.new("L", img.size, 0)
    alpha.paste(dirt.split()[3].point(lambda a: 255 if a >= 128 else 0), (dx, dy))
    outer = alpha.filter(ImageFilter.MaxFilter(7))   # dilate 3px
    inner = alpha.filter(ImageFilter.MinFilter(7))   # erode 3px
    band = ImageChops.subtract(outer, inner).load()
    al = alpha.load()
    for Y in range(h):
        for X in range(w):
            r, g, b, a = px[X, Y]
            if not a:
                continue
            if al[X, Y]:
                x, y = X - dx, Y - dy
                d = abs(r - dp[x, y][0]) + abs(g - dp[x, y][1]) + abs(b - dp[x, y][2])
                if (d < 24 or is_soil(r, g, b)) and not is_produce(r, g, b):
                    mask.add((X, Y))
                    continue
            if band[X, Y] and not is_produce(r, g, b):
                hh, ss, vv = hsv(r, g, b)
                if 4 <= hh * 360 <= 55 and vv < 0.85 and ss > 0.2:
                    mask.add((X, Y))
    return mask


def green_weight(r, g, b):
    """0..1: how much a pixel is foliage (green hue) rather than produce."""
    h, s, v = hsv(r, g, b)
    h *= 360
    if s < 0.22:
        return 0.0
    hue = min(1.0, max(0.0, (h - 62) / 22)) * min(1.0, max(0.0, (178 - h) / 22))
    return hue * min(1.0, (s - 0.22) / 0.2)


def no_foliage(r, g, b):
    return 0.0


def ramp(c, t):
    lo, mid, hi = c
    a, b, u = (lo, mid, t * 2) if t < 0.5 else (mid, hi, t * 2 - 1)
    return tuple(x + (y - x) * u for x, y in zip(a, b))


def recolour(img, keep, v, wood=False, foliage=True, gwmap=None):
    fol = green_weight if foliage is True else foliage
    img = img.copy()
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if not a or (x, y) in keep or (wood and is_wood(r, g, b)):
                continue
            lum = (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / 255.0
            lum = min(1.0, lum + 0.10 * hsv(r, g, b)[1])
            t = max(0.0, min(1.0, (lum - LO) / (HI - LO)))
            t = t * t * (3 - 2 * t) * 0.6 + t * 0.4          # glossier
            t = 0.14 + 0.76 * (t ** 0.8)                      # lift darks, cap whites
            if v.get("contrast") is not None:
                t = 0.66 + (t - 0.66) * v["contrast"]         # flatten: smooth, blank
            if v.get("wrinkle"):
                fold = math.sin((x + 3.2 * math.sin(y / 2.6)) * 1.1) * math.sin((y - 2.4 * math.sin(x / 3.1)) * 0.9)
                t = max(0.0, min(1.0, t + v["wrinkle"] * fold))
            produce = ramp(v["produce"], t)
            gw = gwmap[x, y] / 255.0 if gwmap else fol(r, g, b)
            if v["leaf"] is None:
                out = tuple(c * (1 - gw) + o * gw for c, o in zip(produce, (r, g, b)))
            else:
                leaf = ramp(v["leaf"], max(0.0, min(1.0, lum * 1.15)))
                out = tuple(c * (1 - gw) + o * gw for c, o in zip(produce, leaf))
            px[x, y] = tuple(round(c) for c in out) + (a,)
            if v.get("stars") and gw < 0.3:
                n = ((x * 73856093) ^ (y * 19349663)) % 1000
                if n < v["stars"] * 1000:
                    sc = v.get("star_colours", STAR_COLOURS)
                    px[x, y] = sc[n % len(sc)] + (a,)
    return img


def glow_under(img, orig, keep, colour, fol, wood=False):
    """Soft halo from the bright (emissive) produce pixels, composited UNDER the sprite."""
    px, op = img.load(), orig.load()
    m = Image.new("L", img.size, 0)
    mp = m.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if a and (x, y) not in keep and max(r, g, b) > 150 and fol(*op[x, y][:3]) < 0.3 and not (wood and is_wood(*op[x, y][:3])):
                mp[x, y] = 255
    halo = m.filter(ImageFilter.GaussianBlur(4)).point(lambda a: min(255, int(a * 1.1)))
    layer = Image.new("RGBA", img.size, tuple(colour) + (0,))
    layer.putalpha(halo.point(lambda a: int(a * 0.7)))
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.alpha_composite(layer)
    out.alpha_composite(img)
    return out


def sparkle(img, keep, spots, colour):
    """4-point stars at fixed fractions of the opaque non-soil bounds."""
    px = img.load()
    pts = [(x, y) for y in range(img.height - 40) for x in range(img.width)
           if px[x, y][3] and (x, y) not in keep]
    if not pts:
        return img
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    d = ImageDraw.Draw(img)
    for fx, fy, r in spots:
        cx, cy = round(x0 + (x1 - x0) * fx), round(y0 + (y1 - y0) * fy)
        d.polygon([(cx, cy - r), (cx + 1, cy - 1), (cx + r, cy), (cx + 1, cy + 1),
                   (cx, cy + r), (cx - 1, cy + 1), (cx - r, cy), (cx - 1, cy - 1)],
                  fill=tuple(colour) + (255,))
    return img


SPARKS = [(0.22, 0.20, 6), (0.78, 0.38, 5), (0.45, 0.62, 4)]


def empty_flask(icons, agree=8):
    """The authored flask with no vegetable in it. Per-pixel mode across every icon is
    the flask wherever fewer than half the icons put a vegetable there; the flask is
    left/right symmetric, so any pixel too often covered is mirrored from the other
    half. Returns {(x, y): rgba}."""
    from collections import Counter
    w, h = icons[0].size
    px = [i.load() for i in icons]
    mode = {}
    for y in range(h):
        for x in range(w):
            c, n = Counter(p[x, y] for p in px).most_common(1)[0]
            mode[(x, y)] = (c, n)
    ref = {}
    for (x, y), (c, n) in mode.items():
        if n >= agree:
            ref[(x, y)] = c
        else:
            mc, mn = mode[(w - 1 - x, y)]
            ref[(x, y)] = mc if mn >= agree else c
    # Vegetable outlines leave a few black specks in the mode; heal them from a
    # neighbour (the flask interior is never near-black).
    for _ in range(3):
        for (x, y), c in list(ref.items()):
            if sum(c[:3]) < 60 and c[3]:
                alts = [ref.get(k) for k in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))]
                alts = [a for a in alts if a and a[3] and sum(a[:3]) >= 60]
                if len(alts) >= 2:
                    ref[(x, y)] = alts[0]
    return ref


def flask_keep(icon, ref, tol=36):
    """Pixels of `icon` that are just flask (match the empty flask): left untouched."""
    px = icon.load()
    keep = set()
    for (x, y), c in ref.items():
        q = px[x, y]
        if q[3] == c[3] and sum(abs(q[i] - c[i]) for i in range(3)) <= tol:
            keep.add((x, y))
        elif q[3] == 0:
            keep.add((x, y))
    return keep


class Source:
    def __init__(self):
        self.plants = {p["key"]: p for p in json.load(open(os.path.join(ASSETS, "plants.json")))}
        self.dirt = Image.open(os.path.join(ASSETS, "soil", "plowed_dirt.png")).convert("RGBA")
        self.atlas = Image.open(os.path.join(ASSETS, "zombie", "ZombieSheet.png")).convert("RGBA")
        self.frames = json.load(open(os.path.join(ASSETS, "zombie", "frames.json")))
        files = sorted(f for f in os.listdir(ICON_DIR) if f.startswith("icon_mutation_"))
        self.flask_ref = empty_flask([Image.open(os.path.join(ICON_DIR, f)).convert("RGBA") for f in files])

    def stage(self, key, stage):
        src = Image.open(os.path.join(CROP_DIR, self.plants[key][stage])).convert("RGBA")
        return src, soil_mask(src, self.dirt)

    def part(self, frame):
        f = self.frames[frame]
        return self.atlas.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))

    def icon(self, name):
        return Image.open(os.path.join(ICON_DIR, f"icon_mutation_{name}.png")).convert("RGBA")


def build(src, key, vkey, save=False):
    """-> dict(stage1, stage2, part, icon) of (original, variant) pairs."""
    v = VARIANTS[vkey]
    frame, icon, wood, foliage = CROPS[key]
    res = {}
    for stage in ("stage1", "stage2"):
        o, keep = src.stage(key, stage)
        # Lima sprouts are all seedling leaf: nothing in them is a pod yet.
        fol = True if (key == "lima_beans" and stage == "stage1") else foliage
        gwmap = None
        if fol is lima_foliage:
            # Pods are blobs; a median pass drops the isolated bright leaf highlights.
            m = Image.new("L", o.size, 0)
            m.putdata([round(255 * lima_foliage(*q[:3])) if q[3] else 0 for q in o.getdata()])
            gwmap = m.filter(ImageFilter.MedianFilter(5)).load()
        g = recolour(o, keep, v, wood, fol, gwmap)
        if v["glow"]:
            g = glow_under(g, o, keep, v["glow"], green_weight if fol is True else fol, wood)
        g = sparkle(g, keep, SPARKS if stage == "stage2" else SPARKS[:1], v["spark"])
        res[stage] = (o, g)
    # A lima BEAN (part/icon) is all bean; only the crop sprites mix pods and leaves.
    pf = no_foliage if key == "lima_beans" else foliage
    p = src.part(frame)
    res["part"] = (p, recolour(p, set(), v, foliage=pf))
    i = src.icon(icon)
    res["icon"] = (i, recolour(i, flask_keep(i, src.flask_ref), v, foliage=pf))
    if save:
        d = os.path.join(OUT, vkey)
        for sub in ("crops", "mutations", "icons"):
            os.makedirs(os.path.join(d, sub), exist_ok=True)
        pl = src.plants[key]
        for stage in ("stage1", "stage2"):
            res[stage][1].save(os.path.join(d, "crops", os.path.splitext(pl[stage])[0] + f"_{vkey}.png"))
        res["part"][1].save(os.path.join(d, "mutations", f"{frame}_{vkey}.png"))
        res["icon"][1].save(os.path.join(d, "icons", f"icon_mutation_{icon}_{vkey}.png"))
    return res


def font(n=15):
    try:
        return ImageFont.truetype("arial.ttf", n)
    except OSError:
        return ImageFont.load_default()


BG = (58, 88, 48, 255)
WHITE = (255, 255, 255, 255)


def sheet_detail(rows, path):
    """rows = [(label, sublabel, built)]: sprout/ripe original vs variant + part + icon."""
    CW, CH, X0 = 215, 235, 150
    mx = X0 + CW * 4 + 10
    sh = Image.new("RGBA", (mx + 460, CH * len(rows) + 40), BG)
    d, f = ImageDraw.Draw(sh), font()
    for i, t in enumerate(["sprout", "VARIANT sprout", "ripe", "VARIANT ripe"]):
        d.text((X0 + i * CW + 8, 12), t, fill=WHITE, font=f)
    for x, t in ((mx, "mutation part"), (mx + 120, "VARIANT part"), (mx + 260, "icon  /  VARIANT icon")):
        d.text((x, 12), t, fill=WHITE, font=f)
    for r, (label, sub, b) in enumerate(rows):
        y0 = 40 + r * CH
        d.text((8, y0 + CH // 2 - 20), label, fill=WHITE, font=f)
        d.text((8, y0 + CH // 2), sub, fill=(205, 225, 195, 255), font=f)
        for c, im in enumerate([b["stage1"][0], b["stage1"][1], b["stage2"][0], b["stage2"][1]]):
            sh.alpha_composite(im, (X0 + c * CW + (CW - im.width) // 2, y0 + CH - im.height - 6))
        for j, im in enumerate(b["part"]):
            im2 = im.resize((round(im.width * 1.5), round(im.height * 1.5)), Image.NEAREST)
            sh.alpha_composite(im2, (mx + j * 120, y0 + 50))
        for j, im in enumerate(b["icon"]):
            sh.alpha_composite(im.resize((80, 80), Image.NEAREST), (mx + 260 + j * 90, y0 + 50))
    sh.save(path)


def sheet_overview(built, path):
    """Rows = variants, columns = crops (ripe stage), scaled down."""
    keys, S = list(CROPS), 0.62
    CW, CH, X0 = 128, 135, 190
    sh = Image.new("RGBA", (X0 + CW * len(keys), 40 + CH * (len(GENERAL) + 1)), BG)
    d, f = ImageDraw.Draw(sh), font()
    for c, k in enumerate(keys):
        d.text((X0 + c * CW + 8, 12), k, fill=WHITE, font=f)

    def put(img, row, col):
        im = img.resize((round(img.width * S), round(img.height * S)), Image.LANCZOS)
        sh.alpha_composite(im, (X0 + col * CW + (CW - im.width) // 2, 40 + row * CH + CH - im.height - 6))

    d.text((8, 40 + CH // 2), "original", fill=WHITE, font=f)
    for c, k in enumerate(keys):
        put(built[(k, "midas")]["stage2"][0], 0, c)
    for r, vk in enumerate(GENERAL, 1):
        v = VARIANTS[vk]
        d.text((8, 40 + r * CH + CH // 2 - 18), v["title"], fill=WHITE, font=font(17))
        d.text((8, 40 + r * CH + CH // 2 + 4), v["theme"], fill=(205, 225, 195, 255), font=f)
        for c, k in enumerate(keys):
            put(built[(k, vk)]["stage2"][1], r, c)
    sh.save(path)


# prize crop key -> (variant, mutation key, the base mutation's key in mutations.json).
# The economy (name, cost, sell, grow time) lives in reforge_economy.PRIZE_CROPS; the
# mutation's stats live in src/zombie/mutations.ts PRIZE_MUTATIONS. KEEP the mutation keys
# in sync with that list (src/zombie/prizeMutations.test.ts checks it).
PRIZE_ART = {
    "golden_carrot": ("goldcarrot",  "goldencarrot", "carrot"),
    "golden_turnip": ("goldturnip",  "goldenturnip", "turnip"),
    "obsidibeans":   ("obsidibeans", "obsidibeans",  "limabean"),
    "cauliglower":   ("cauliglower", "cauliglower",  "cauli"),
    "cosmic_potato": ("cosmic",      "cosmicpotato", "potato"),
    "brainato":      ("brainato",    "brainato",     "tomato"),
}

REQUESTED = ["goldcarrot", "goldturnip", "cosmic", "obsidibeans", "cauliglower"]
BRAIN = ["brainato", "smoothbrain", "lobotomato", "bigbrain", "galaxybrain"]
TOMATO_MORE = ["tombato", "rotten", "tomatoxic", "plasmato"]


def sheet_compact(rows, path):
    """rows = [(title, theme, built)]: ripe orig/variant, variant sprout, part, icon."""
    CH, X0, CW = 175, 200, 205
    cols = X0 + CW * 3 + 150 + 170
    sh = Image.new("RGBA", (cols, CH * len(rows) + 36), BG)
    d, f = ImageDraw.Draw(sh), font()
    for i, t in enumerate(["ripe (original)", "VARIANT ripe", "VARIANT sprout"]):
        d.text((X0 + i * CW + 8, 10), t, fill=WHITE, font=f)
    mx = X0 + CW * 3
    d.text((mx, 10), "mutation part", fill=WHITE, font=f)
    d.text((mx + 150, 10), "flask icon", fill=WHITE, font=f)
    for r, (title, theme, b) in enumerate(rows):
        y0 = 36 + r * CH
        d.text((8, y0 + CH // 2 - 22), title, fill=WHITE, font=font(17))
        d.text((8, y0 + CH // 2), theme, fill=(205, 225, 195, 255), font=font(12))
        for c, im in enumerate([b["stage2"][0], b["stage2"][1], b["stage1"][1]]):
            sh.alpha_composite(im, (X0 + c * CW + (CW - im.width) // 2, y0 + CH - im.height - 4))
        for j, im in enumerate(b["part"]):
            im2 = im.resize((round(im.width * 1.3), round(im.height * 1.3)), Image.NEAREST)
            sh.alpha_composite(im2, (mx + j * 70, y0 + 50))
        sh.alpha_composite(b["icon"][0].resize((72, 72), Image.NEAREST), (mx + 150, y0 + 40))
        sh.alpha_composite(b["icon"][1].resize((72, 72), Image.NEAREST), (mx + 230, y0 + 40))
    sh.save(path)


def install():
    """Write the real game assets for the six prize crops. See the module docstring."""
    sys.path.insert(0, HERE)
    import reforge_economy as econ

    src = Source()
    crops_out = os.path.join(ASSETS, "crops")
    icons_out = os.path.join(ASSETS, "crop-icons")
    mut_out = os.path.join(ASSETS, "zombie", "mutations")
    ui_out = os.path.join(ASSETS, "ui", "mutation")
    for d in (crops_out, icons_out, mut_out, ui_out):
        os.makedirs(d, exist_ok=True)
    mutations = json.load(open(os.path.join(ASSETS, "zombie", "mutations.json"), encoding="utf-8"))
    prize_mutations = {}
    for key, (name, base, *_rest) in econ.PRIZE_CROPS.items():
        vkey, mkey, base_mutation = PRIZE_ART[key]
        _frame, _icon, _wood, foliage = CROPS[base]
        built = build(src, base, vkey)
        for stage in ("stage1", "stage2"):
            built[stage][1].save(os.path.join(crops_out, f"{key}_{stage}.png"))
        # The standalone produce sprite the Market card and harvest pickup use.
        base_icon = Image.open(os.path.join(icons_out, src.plants[base]["icon"])).convert("RGBA")
        icon_fol = no_foliage if base == "lima_beans" else foliage
        recolour(base_icon, set(), VARIANTS[vkey], foliage=icon_fol).save(
            os.path.join(icons_out, f"{key}_icon.png"))
        built["part"][1].save(os.path.join(mut_out, f"{mkey}.png"))
        built["icon"][1].save(os.path.join(ui_out, f"icon_mutation_{mkey}.png"))
        entry = dict(mutations[base_mutation])
        entry["file"] = mkey
        prize_mutations[mkey] = entry
        print("installed", key)
    with open(os.path.join(ASSETS, "zombie", "prize_mutations.json"), "w", encoding="utf-8") as f:
        json.dump(prize_mutations, f, indent=1)
        f.write("\n")

    # plants.json: add/refresh the prize rows (same merge prep_market.py performs).
    path = os.path.join(ASSETS, "plants.json")
    plants = json.load(open(path, encoding="utf-8"))
    merged = econ.merge_prize_crops(plants)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=1)
        f.write("\n")
    print("plants.json:", len(merged), "rows")


def main():
    if "--install" in sys.argv:
        install()
        return
    os.makedirs(OUT, exist_ok=True)
    src = Source()

    def rows_for(keys):
        out = []
        for vk in keys:
            v = VARIANTS[vk]
            out.append((v["title"], f"{v['crop']}: {v['theme']}", build(src, v["crop"], vk, save=True)))
        return out

    sheet_compact(rows_for(REQUESTED), os.path.join(OUT, "final_1_crops.png"))
    sheet_compact(rows_for(BRAIN + TOMATO_MORE), os.path.join(OUT, "final_2_tomatoes.png"))
    built = {(k, vk): build(src, k, vk, save=True) for vk in GENERAL for k in CROPS}
    sheet_overview(built, os.path.join(OUT, "final_3_metals.png"))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
