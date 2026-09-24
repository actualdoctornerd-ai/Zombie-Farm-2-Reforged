"""The Obsidian tier: six gravestone zombies above the Silvers (levels 40-45).

A reimplementation addition with no source art. Each zombie is its body type's
ordinary rig (models.json) worn with a charcoal or gunmetal skin, plus a few of the
mainline atlas's own attachments re-hued purple. Designed from mock-up sheets with
the owner on 2026-09-23/24; the look, the names and the stats were all picked there.

What this writes, per zombie, into public/assets/zombie/<stem>/:
  * <file>.png     the recoloured attachments (cut from ZombieSheet.png)
  * manifest.json  a special-zombie manifest whose `base` is the ordinary rig it
                   wears. src/assets.ts mergeSpecialZombieModel keeps every base part
                   the manifest does not replace (tinted `color`) and lays these
                   untinted parts over it, replacing by slot name: `barbarianHair.png`
                   replaces the Zombarian's `barbarianHair`, `EyeL.png` its `defaultEyeL`.
and bakes the menu portrait public/assets/zombie/portrait/<key>.png.

The parts are packed into the special atlas by tools/prep_assets.py
pack_special_zombies (LAST, so no existing frame moves). Regenerate with:

    cd tools && python -c "import obsidian_zombies as o, prep_assets as p; o.derive(); p.pack_special_zombies()"

The catalog rows live in tools/prep_market.py AUTHORED_ZOMBIES (and, by hand, in
public/assets/zombies.json); the Obsidian Grave that unlocks planting them is
authored in tools/prep_placeables.py.
"""
import colorsys
import json
import math
import os
import random
import shutil

from PIL import Image, ImageDraw, ImageFilter

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZOMBIE = os.path.join(PROJ, "public", "assets", "zombie")

# Skin tints. Deliberately dark: every lower tier is a bright body colour (green,
# blue, red, silver), and the purple lives in the attachments instead.
CHARCOAL = (95, 92, 110)
GUNMETAL = (125, 125, 140)

PURPLE = 0.78  # hue (0..1) every recoloured attachment is turned to

# (hue, saturation multiplier, value multiplier, saturation floor). The floor pulls
# grey and white paint into the hue too; the value multiplier darkens (a plum mane)
# or brightens (a visor). Each pixel keeps its own brightness, so the authored
# shading and ink outline survive the recolour.
BLOOM = (PURPLE, 1.1, 0.95, 0.5)
PLUM = (PURPLE, 0.9, 0.55, 0.6)
WINGS = (PURPLE, 1.0, 0.6, 0.6)
DRESS = (PURPLE, 1.0, 1.0, 0.5)
VISOR = (PURPLE, 1.2, 1.0, 0.5)
# Lilac eyes. The default eye is authored light yellow and a sprite TINT can only
# darken it (lilac x yellow = orange), so the Zomchantress carries her own eye art.
GLOW_EYES = (0.80, 0.55, 1.15, 0.0)

# key, stem, base rig, skin, parts. A part is (file, donor model, recolour): the
# attachment is cut from the atlas frame `file`, placed where the donor model places
# it, and saved as <file>.png — or as the name after "=" when it must take over a
# default slot under another name (the lilac eyes replace defaultEyeL/R).
TIER = [
    # L40 Garden: the Flower Zombie's bloom turned nightshade purple.
    {"key": "ZombieActorGardenTier6", "stem": "nightshade_zombie",
     "base": "ZombieActorGardenTier3", "color": GUNMETAL,
     "parts": [("sunflowerFeature", "ZombieActorGardenTier3", BLOOM)]},
    # L41 Large: the Zombarian with a deep plum mane.
    {"key": "ZombieActorLargeTier6", "stem": "zomtitan",
     "base": "ZombieActorLargeTier4", "color": CHARCOAL,
     "parts": [("barbarianHair", "ZombieActorLargeTier4", PLUM)]},
    # L42 Small: the Imp with the Cupid Zombie's wings, darkened into bat wings.
    {"key": "ZombieActorSmallTier6", "stem": "zemon",
     "base": "ZombieActorSmallTier4", "color": CHARCOAL,
     "parts": [("cupidWings", "ZombieActorGardenCupid", WINGS)]},
    # L43 Girl: the Zombelly Dancer's tiara and dress in purple, lilac eyes, and a
    # looping sparkle (src/zombie/specialHeadFx.ts).
    {"key": "ZombieActorGirlTier6", "stem": "zomchantress",
     "base": "ZombieActorGirlTier5", "color": CHARCOAL, "fx": "sparkle",
     "parts": [("bellydancerFeature", "ZombieActorGirlTier5", DRESS),
               ("bellydancerBody", "ZombieActorGirlTier5", DRESS),
               ("defaultEyeL=EyeL", "ZombieActorGirlTier5", GLOW_EYES),
               ("defaultEyeR=EyeR", "ZombieActorGirlTier5", GLOW_EYES)]},
    # L44 Headless: the plain headless body; its head is a plasma orb drawn at
    # runtime (specialHeadFx "plasma"), so it has no attachments of its own.
    {"key": "ZombieActorHeadlessTier6", "stem": "plasmahead",
     "base": "ZombieActorHeadlessTier1", "color": CHARCOAL, "fx": "plasma",
     "parts": []},
    # L45 Regular: the Robo Zombie helmet with the Zyborg's headset as a purple visor.
    {"key": "ZombieActorRegularTier6", "stem": "zombinator",
     "base": "ZombieActorRegularTier4", "color": GUNMETAL,
     "parts": [("cyborgFeature", "ZombieActorRegularTier2", VISOR)]},
]

TEETH = {"defaultUpperTeeth", "defaultLowerTeeth"}
EYES = {"defaultEyeL", "defaultEyeR"}


def _hue(im, hue, sat_mul, val_mul, sat_floor):
    im = im.copy()
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if s < 0.18 and sat_floor == 0:
                continue
            s = min(1.0, max(s, sat_floor) * sat_mul)
            v = min(1.0, v * val_mul)
            rr, gg, bb = colorsys.hsv_to_rgb(hue, s, v)
            px[x, y] = (int(rr * 255), int(gg * 255), int(bb * 255), a)
    return im


def _multiply(im, rgb):
    im = im.copy()
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (r * rgb[0] // 255, g * rgb[1] // 255, b * rgb[2] // 255, a)
    return im


def _load():
    models = json.load(open(os.path.join(ZOMBIE, "models.json")))
    frames = json.load(open(os.path.join(ZOMBIE, "frames.json")))
    sheet = Image.open(os.path.join(ZOMBIE, "ZombieSheet.png")).convert("RGBA")
    return models, frames, sheet


def _frame(sheet, frames, name):
    f = frames[name]
    return sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))


def _donor_part(models, donor, file):
    for p in models[donor]["parts"]:
        if p["file"] == file:
            return p
    raise KeyError(f"{donor} has no part {file}")


def derive():
    """Write every Obsidian zombie's parts + manifest and bake its portrait."""
    models, frames, sheet = _load()
    for spec in TIER:
        folder = os.path.join(ZOMBIE, spec["stem"])
        if os.path.isdir(folder):
            shutil.rmtree(folder)
        os.makedirs(folder)
        parts = []
        for entry, donor, recolour in spec["parts"]:
            frame, _, saved = entry.partition("=")
            out = (saved or frame) + ".png"
            _hue(_frame(sheet, frames, frame), *recolour).save(os.path.join(folder, out))
            p = _donor_part(models, donor, frame)
            part = {"file": out, "group": p["group"], "px": p["px"], "py": p["py"],
                    "ax": p["ax"], "ay": p["ay"], "z": p["z"], "scale": p.get("scale", 1)}
            parts.append(part)
        manifest = {"name": spec["stem"], "base": spec["base"], "neck": models[spec["base"]]["neck"],
                    "color": list(spec["color"]), "floatingHead": False, "parts": parts}
        json.dump(manifest, open(os.path.join(folder, "manifest.json"), "w"), indent=1)
        _portrait(spec, manifest, models, frames, sheet)
        print(f"zombie: obsidian {spec['key']} on {spec['base']} ({len(parts)} parts)")


def _portrait(spec, manifest, models, frames, sheet):
    """The menu portrait, drawn by the same rules as the live rig (src/zombie/
    appearance.ts): teeth stay white, a Large zombie's eyes are black disks with a
    fifth-size eyeball in the middle, every other skeleton part takes the skin tint.
    Same 160x180 canvas, feet at (80,150), as the ordinary portraits beside it."""
    base = models[spec["base"]]
    folder = os.path.join(ZOMBIE, spec["stem"])
    replaced = {p["file"].removesuffix(".png") for p in manifest["parts"]}
    large = "Large" in spec["key"]
    items = []
    for p in base["parts"]:
        if p["file"].removeprefix("default") in replaced or p["file"] in replaced:
            continue
        im = _frame(sheet, frames, p["file"])
        eyeball = None
        if p.get("tint"):
            if p["file"] in TEETH:
                pass
            elif p["file"] in EYES and large:
                eyeball = im
                im = _multiply(im, (17, 17, 17))
            elif p["file"] not in EYES:
                im = _multiply(im, spec["color"])
        items.append((p["z"], im, p, eyeball))
    for p in manifest["parts"]:
        items.append((p["z"], Image.open(os.path.join(folder, p["file"])).convert("RGBA"), p, None))
    items.sort(key=lambda t: t[0])
    W, H, cx, cy = 160, 180, 80, 150
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for _, im, p, eyeball in items:
        s = p.get("scale", 1)
        if s != 1:
            im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
        x = round(cx + p["px"] - p["ax"] * im.width)
        y = round(cy + p["py"] - p["ay"] * im.height)
        canvas.alpha_composite(im, (x, y))
        if eyeball is not None:
            e = eyeball.resize((max(1, round(im.width * 0.2)), max(1, round(im.height * 0.2))), Image.LANCZOS)
            canvas.alpha_composite(e, (x + (im.width - e.width) // 2, y + (im.height - e.height) // 2))
    fx = spec.get("fx")
    if fx == "plasma":
        _paint_plasma(canvas, cx + 7, cy - 42)
    elif fx == "sparkle":
        canvas = _paint_sparkles(canvas)
    stem_png = os.path.join(ZOMBIE, spec["stem"] + ".png")
    canvas.save(stem_png)
    json.dump({"anchorX": cx / W, "anchorY": cy / H, "w": W, "h": H}, open(stem_png + ".json", "w"))
    shutil.copy2(stem_png, os.path.join(ZOMBIE, "portrait", spec["key"] + ".png"))


# The two runtime effects, painted still for the portrait. Colours match
# src/zombie/specialHeadFx.ts.
PLASMA_CORE = (190, 80, 255)
PLASMA_ARC = (255, 200, 255)


def _paint_plasma(canvas, cx, cy):
    glow = Image.new("RGBA", canvas.size)
    d = ImageDraw.Draw(glow)
    for r, a in ((17, 50), (13, 90), (10, 150)):
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=PLASMA_CORE + (a,))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(3)))
    d = ImageDraw.Draw(canvas)
    d.ellipse((cx - 8, cy - 8, cx + 8, cy + 8), fill=PLASMA_CORE + (235,))
    rnd = random.Random(3)
    for i in range(8):
        ang = i / 8 * 2 * math.pi + rnd.random() * 0.5
        pts = [(cx, cy)]
        for step in range(1, 5):
            j = ang + rnd.uniform(-0.6, 0.6)
            pts.append((cx + math.cos(j) * step * 3.3, cy + math.sin(j) * step * 3.3))
        d.line(pts, fill=PLASMA_ARC + (235,), width=1)
    d.ellipse((cx - 4.5, cy - 4.5, cx + 4.5, cy + 4.5), fill=(255, 240, 255, 255))


SPARKLES = [(-26, -78, 5), (22, -86, 4), (30, -56, 6), (-30, -44, 4), (-12, -96, 3), (18, -28, 3)]


def _paint_sparkles(canvas):
    cx, cy = 80, 150
    glow = Image.new("RGBA", canvas.size)
    d = ImageDraw.Draw(glow)
    for dx, dy, r in SPARKLES:
        x, y = cx + dx, cy + dy
        d.ellipse((x - r * 1.4, y - r * 1.4, x + r * 1.4, y + r * 1.4), fill=(240, 200, 255, 110))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(2)))
    d = ImageDraw.Draw(canvas)
    for dx, dy, r in SPARKLES:
        x, y = cx + dx, cy + dy
        w = r * 0.25
        d.polygon([(x, y - r), (x + w, y - w), (x + r, y), (x + w, y + w),
                   (x, y + r), (x - w, y + w), (x - r, y), (x - w, y - w)], fill=(255, 245, 255, 255))
    return canvas


if __name__ == "__main__":
    derive()
