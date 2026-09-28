#!/usr/bin/env python3
"""Build the Boss Statue placeables (art + catalog rows).

A Boss Statue is a REIMPLEMENTATION ADDITION, not a ZF2 item: an invasion milestone
prize (see src/raid/bossStatues.ts for when it pays) showing that invasion's boss
carved in stone on the Memorial Statue's plinth. Each boss also gets a GOLDEN
variation (the 50-win prize): the finished stone statue, plinth and all, re-mapped
from its grey luminance onto a gold ramp.

It is the Memorial Statue's look, baked. A memorial's occupant changes, so its stone
zombie is built at runtime (src/zombie/statueRig.ts). A boss statue never changes,
so the same recipe runs once here and the result is an ordinary decoration sprite —
it places, stores, sells, mirrors and shows on a friend's farm through the paths every
other reward already uses, with no runtime rig at all.

  * The plinth is the memorial's own sprite (tools/memorial_statue.py), so the two
    kinds of statue read as one family.
  * The figure is the boss's flat raid composite (public/assets/raids/enemies/), run
    through the SAME luminance-compressing colour matrix statueRig.ts uses — the
    constants below are that file's, and must stay equal to them.
  * Its feet go on the plinth's authored mount point, the spot a memorial zombie's
    feet go.

Imported by prep_placeables.py (which owns public/assets/objects and would delete any
PNG the catalog does not reference). Run directly to rebuild just these items:

    python zombiefarm/tools/boss_statues.py
"""
import json
import math
import os

from PIL import Image

import memorial_statue

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
OUT = os.path.join(PROJ, "public", "assets")
OBJDIR = os.path.join(OUT, "objects")
ENEMIES = os.path.join(OUT, "raids", "enemies")

# (placeable key, display name, raid composite). The display name is also the
# drops.json name the prize is granted under, so it is what Received shows. Each
# row also yields its golden variation: key + "Golden", "Golden " + name.
# KEEP IN SYNC with BOSS_STATUES in src/raid/bossStatues.ts.
STATUES = [
    ("bossStatueOldMcDonnell", "Old McDonnell Statue", "FarmStageActorBoss"),
    ("bossStatueCorporateVille", "CorporateVille Statue", "CityStageActorBoss"),
    ("bossStatueArrrnold", "Arrrnold Statue", "PirateStageActorBoss"),
    ("bossStatueMrWhiskers", "Mr. Whiskers Statue", "NinjaStageActorBoss"),
    ("bossStatueBroBot", "Bro-Bot Statue", "RobotStageActorBroBot"),
    ("bossStatueAlien", "Alien Overlord Statue", "AlienStageActorBoss"),
    ("bossStatueSquiDude", "SquiDude Statue", "BeachStageActorBoss"),
    ("bossStatueRingmaster", "Ringmaster Statue", "CircusStageActorBoss"),
    ("bossStatueZedzox", "Zedzox Statue", "VideoGameStageBossActor"),
    ("bossStatueGoffy", "Goffy Statue", "TreeWorldStageBossActor"),
    ("bossStatueFelixWonky", "Felix Wonky Statue", "ValentinesDayStageActorBoss"),
]
# Pixel art is scaled without smoothing, or Zedzox turns to mush.
PIXEL_ART = {"VideoGameStageBossActor"}

# Per-boss sculpting, set by eye with the owner (2026-09-28). A figure is centred on
# the plinth's mount point by its bounding box unless told otherwise:
#   center "feet" — the middle of its bottom rows (what it actually stands on), for a
#                   figure whose outstretched arm or weapon drags the box sideways;
#   center "head" — the middle of its top rows, for one with a long trailing prop;
#   scale         — a multiplier on the fitted size;
#   nudge         — a final shift right (+) / left (-), in plinth pixels;
#   pose          — build from the enemy's part RIG (raids/enemies/models.json)
#                   instead of the flat composite, with these parts re-rotated
#                   (part index -> radians). The composite is an action pose.
FIGURE_TWEAKS = {
    # Old McDonnell's composite has his arm raised; the rig at rest, with the far arm
    # swung down beside his overalls, stands like a statue.
    "FarmStageActorBoss": {"pose": {0: -1.25}},
    "PirateStageActorBoss": {"center": "feet"},
    "TreeWorldStageBossActor": {"center": "feet"},
    "ValentinesDayStageActorBoss": {"center": "feet"},
    "CircusStageActorBoss": {"center": "head", "nudge": 10},
    "VideoGameStageBossActor": {"scale": 0.8},
}
# Share of the figure's height counted as its feet / head band for centring.
FEET_BAND = 0.10
HEAD_BAND = 0.20

# Figure size in plinth pixels. A boss out-sizes the zombies a memorial holds (a
# farmer is ~95 px), and a wide one is capped so it does not hang far past its 2x2
# footprint.
FIGURE_H = 104
FIGURE_MAX_W = 124
# Feet sink this far into the top face, so the figure stands ON it rather than
# hovering at the diamond's exact centre line.
FEET_SINK = 3

# --- statueRig.ts's stone matrix: KEEP EQUAL to STONE / LUM_SCALE / LUM_OFFSET / LUMA.
STONE = (0.82, 0.83, 0.79)
LUM_SCALE = 0.7
LUM_OFFSET = 0.44
LUMA = (0.299, 0.587, 0.114)


def _stone(img):
    """Desaturate + compress luminance into the granite band, alpha untouched."""
    img = img.copy()
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            lum = (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / 255.0
            v = LUM_OFFSET + LUM_SCALE * lum
            px[x, y] = tuple(max(0, min(255, round(v * c * 255))) for c in STONE) + (a,)
    return img


# Golden variation: stone luminance -> a dark-bronze .. pale-gold ramp. The stone
# band sits roughly in 0.35..0.95, so it is stretched over the whole ramp to keep
# the sculpt's shading legible as polished metal.
GOLD_DARK = (78, 42, 0)
GOLD_MID = (222, 162, 28)
GOLD_LIGHT = (255, 246, 176)
GOLD_LO, GOLD_HI = 0.30, 0.92


def golden_key(key):
    return f"{key}Golden"


def golden_name(name):
    return f"Golden {name}"


def _gild(img):
    img = img.copy()
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            lum = (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / 255.0
            t = max(0.0, min(1.0, (lum - GOLD_LO) / (GOLD_HI - GOLD_LO)))
            lo, hi, u = (GOLD_DARK, GOLD_MID, t * 2) if t < 0.5 else (GOLD_MID, GOLD_LIGHT, t * 2 - 1)
            px[x, y] = tuple(round(d + (l - d) * u) for d, l in zip(lo, hi)) + (a,)
    return img


def _posed_rig(source, rotations):
    """Assemble the enemy's part rig (as src/raid/EnemyActor.ts does: each part's
    anchor at its model position, rotated by `rot`), with `rotations` overriding
    individual parts' angles."""
    model = json.load(open(os.path.join(ENEMIES, "models.json"), encoding="utf-8"))[source]
    strip = Image.open(os.path.join(ENEMIES, "parts", f"{source}.png")).convert("RGBA")
    pad = 200
    size = (600, 600)
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    for i, p in sorted(enumerate(model["parts"]), key=lambda t: t[1]["z"]):
        part = strip.crop((p["rx"], p["ry"], p["rx"] + p["rw"], p["ry"] + p["rh"]))
        th = rotations.get(i, p["rot"])
        c, s = math.cos(th), math.sin(th)
        ax, ay = p["ax"] * p["rw"], p["ay"] * p["rh"]
        px, py = p["px"] + pad, p["py"] + pad
        # Output -> part space: the inverse of "rotate about the anchor, then place".
        coeffs = (c, s, ax - c * px - s * py, -s, c, ay + s * px - c * py)
        out.alpha_composite(part.transform(size, Image.AFFINE, coeffs, resample=Image.BICUBIC))
    return out


def _band_center(img, y0, y1):
    """Horizontal middle of the opaque pixels in rows y0..y1."""
    alpha = img.getchannel("A").crop((0, y0, img.width, y1))
    box = alpha.point(lambda a: 255 if a > 40 else 0).getbbox()
    return (box[0] + box[2]) / 2 if box else img.width / 2


def _figure(source):
    """The stone figure, and the x (in its own pixels) to stand on the mount point."""
    tweak = FIGURE_TWEAKS.get(source, {})
    if "pose" in tweak:
        im = _posed_rig(source, tweak["pose"])
    else:
        im = Image.open(os.path.join(ENEMIES, f"{source}.png")).convert("RGBA")
    im = im.crop(im.getbbox())
    s = min(FIGURE_H / im.height, FIGURE_MAX_W / im.width)
    if source in PIXEL_ART and "scale" not in tweak:
        # Whole pixels only: a fractional nearest-neighbour scale doubles some
        # rows and not others.
        s = max(1, int(s))
    s *= tweak.get("scale", 1)
    size = (max(1, round(im.width * s)), max(1, round(im.height * s)))
    resample = Image.NEAREST if source in PIXEL_ART else Image.LANCZOS
    fig = _stone(im.resize(size, resample))
    center = tweak.get("center")
    if center == "feet":
        anchor = _band_center(fig, round(fig.height * (1 - FEET_BAND)), fig.height)
    elif center == "head":
        anchor = _band_center(fig, 0, round(fig.height * HEAD_BAND))
    else:
        anchor = fig.width / 2
    return fig, anchor - tweak.get("nudge", 0)


def _compose(plinth, mount_x, mount_y, figure, anchor_x):
    """Plinth bottom-centred (as the renderer anchors every object), figure's feet on
    the mount point, `anchor_x` of the figure over it. The canvas grows symmetrically
    about the plinth's centre so the bottom-centre anchor still lands under the plinth."""
    pw, ph = plinth.size
    mx = mount_x * pw
    my = ph * (1 - mount_y) + FEET_SINK
    fx0 = round(mx - anchor_x)
    fy0 = round(my - figure.height)
    half = max(pw / 2, pw / 2 - fx0, fx0 + figure.width - pw / 2)
    w = int(2 * -(-half // 1))
    top = min(0, fy0)
    h = ph - top
    ox = (w - pw) // 2
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(plinth, (ox, -top))
    canvas.alpha_composite(figure, (ox + fx0, fy0 - top))
    return canvas


def build(objdir=OBJDIR, memorial=None):
    """Emit one PNG per boss into `objdir`; return their catalog rows. `memorial` is
    the Memorial Statue's catalog row (its sprite must already be in `objdir`)."""
    memorial = memorial or memorial_statue.build(objdir)
    plinth = Image.open(os.path.join(objdir, memorial["sprite"])).convert("RGBA")
    rows = []
    variants = []
    for key, name, source in STATUES:
        art = _compose(plinth, memorial["mountX"], memorial["mountY"], *_figure(source))
        variants.append((key, name, art))
        variants.append((golden_key(key), golden_name(name), _gild(art)))
    for key, name, art in variants:
        sprite = f"{key}.png"
        art.save(os.path.join(objdir, sprite))
        rows.append({
            "key": key,
            "name": name,
            "category": "reward",
            "cost": 0,
            "level": -1,
            "xp": 0,
            "brainsNeeded": False,
            "tileW": 2,
            "tileH": 2,
            "movable": True,
            "rotations": 1,
            "sprite": sprite,
            "nativeW": art.width,
            "nativeH": art.height,
            "pivotX": 0.0,
            "pivotY": 0.0,
            "armyMax": 0,
            "storageSlots": 0,
            "zombieSlots": 0,
            "growMs": 0,
            "harvestValue": 0,
            "growingSprite": "",
        })
    return rows


def main():
    rows = build()
    keys = {r["key"] for r in rows}
    path = os.path.join(OUT, "placeables.json")
    with open(path, encoding="utf-8") as f:
        catalog = json.load(f)
    catalog = [c for c in catalog if c["key"] not in keys] + rows
    catalog.sort(key=lambda c: (c["category"], c["level"], c["cost"]))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=1)
    for r in rows:
        print(f"boss statue: {r['sprite']} {r['nativeW']}x{r['nativeH']}")


if __name__ == "__main__":
    main()
