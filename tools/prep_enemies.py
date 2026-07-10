#!/usr/bin/env python3
"""Composite static raid-enemy sprites from the FarmStage spritesheet.

The enemies are skeletal (body/head/arm/foot parts) with rig layout baked into
FarmStage.json — the SAME rig format the farm zombies use (ZombieSheet.json):

  offsetX/offsetY  the part's anchor position in rig space (x right, y UP, feet at 0)
  pivotX/pivotY    the anchor as a fraction of the part (pivotY measured from the TOP)
  rotation         DISPLAY rotation of the part, in degrees (NOT atlas packing)
  z                draw order

We assemble each enemy into ONE upright PNG (no animation yet) under
public/assets/raids/enemies/. Placement mirrors the proven zombie compositor in
prep_zombie_models.py (straight crop, anchor at pivotX*w / (1-pivotY)*h), plus we
apply each part's DISPLAY rotation about its anchor — the pitchfork and the
lumberjack's arms/fist carry rotation:-90 and are otherwise mis-placed.

The composites face LEFT (toward the zombies), so the scene draws them un-mirrored.

Run from zombiefarm/:  python tools/prep_enemies.py
"""
import json
import os
import plistlib
import re
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXTRACT = os.path.join(ROOT, "..", "ZF2R_extracted")
SHEETDIR = os.path.join(EXTRACT, "assets", "spritesheets", "stages")
RIGDIR = os.path.join(EXTRACT, "data", "json", "sprites")
OUT_DIR = os.path.join(ROOT, "public", "assets", "raids", "enemies")

# Per-stage-sheet actor part lists. A part spec is either an explicit ordered list
# of frame names (McDonnell shares generic feet, so it needs the list) OR a string
# PREFIX — every frame whose name starts with it is collected and z-sorted (the
# Alien/Robot rigs name their parts <actor><part>, so a prefix captures one actor).
#
# Only stage sheets shipped with BOTH a png atlas and a json rig can be composited:
# Farm, Alien, Robot. Pirate/Ninja/VideoGame/City/TreeWorld ship no stage art in
# this bundle, so their raids fall back to the flat enemy icon / boss portrait in
# the live scene. Beach/Circus/Valentines ship a png but only a .plist rig (no json)
# — left for a follow-up that parses the plist.
SHEETS = {
    "FarmStage": {
        "FarmStageActorFarmhand": ["footB.png", "footF.png", "farmHandBody.png",
                                   "farmHandArmF.png", "farmHandHead.png", "pitchfork.png"],
        "FarmStageActorLumberjack": ["lumberjackArmB.png", "lumberjackFootB.png", "lumberjackFootF.png",
                                     "lumberjackBody.png", "lumberjackHead.png",
                                     "lumberjackArmF.png", "lumberjackFistF.png"],
        "FarmStageActorBoss": ["oldMcDonnellArmB.png", "footB.png", "footF.png", "oldMcDonnellBody.png",
                               "oldMcDonnellArmF.png", "oldMcDonnellHead.png"],
    },
    "AlienStage": {
        "AlienStageActorBoss": "boss",     # bossArmB/ArmF/Body/Face/FootB/FootF
        "AlienStageActorMinion": "minion",  # minion* (incl BodyDetail/Head)
    },
    "RobotStage": {
        "RobotStageActorBrainBot": "brainBot",
        "RobotStageActorBroBot": "broBot",
        "RobotStageActorJunkBot": "junkBot",
    },
}

# Working canvas + rig origin (feet). Large enough to hold any part; autocropped.
CW, CH = 600, 500
CX, CY = 300, 420

CROPDIR = os.path.join(EXTRACT, "assets", "spritesheets", "crops")

# Sheets that ship a TexturePacker atlas (as .plist OR a plist-shaped .json) but NO
# skeletal rig. Their parts are TRIMMED layers of one composition sharing a
# spriteSourceSize, so pasting each part at its spriteColorRect origin reconstructs
# the assembled actor (same technique the zombie-grow tiles use). Each entry maps a
# UnitStats key -> its part-name prefix in the atlas.
TRIM_SHEETS = [
    {
        "png": os.path.join(SHEETDIR, "BeachStage.png"),
        "frames": os.path.join(SHEETDIR, "BeachStage.plist"),
        "actors": {
            "BeachStageActorBoss": "beach_boss",
            "BeachStageActorCrab": "beach_crab",
            "BeachStageActorMinion1": "beach_minion01",
            "BeachStageActorMinion2": "beach_minion02",
        },
    },
    {
        "png": os.path.join(SHEETDIR, "CircusStage.png"),
        "frames": os.path.join(SHEETDIR, "CircusStage.plist"),
        "actors": {
            "CircusStageActorBoss": "ringmaster",
            "CircusStageActorMinion1": "midget_clown",
            "CircusStageActorMinion2": "bear",
        },
    },
    {
        "png": os.path.join(SHEETDIR, "ValentinesStage2012.png"),
        "frames": os.path.join(SHEETDIR, "ValentinesStage2012.plist"),
        "actors": {
            "ValentinesDayStageActorBoss": "icecream_boss",
            "ValentinesDayStageActorMinion1": "chocolate",
            "ValentinesDayStageActorMinion2": "teddybear",
            "ValentinesDayStageActorMinion3": "box",
        },
    },
    {   # TreeWorld's atlas lives under crops/, its frames in a plist-shaped .json.
        "png": os.path.join(CROPDIR, "TreeWorld.png"),
        "frames": os.path.join(RIGDIR, "TreeWorld.json"),
        "actors": {
            "TreeWorldStageBossActor": "boss_goffy",
            "TreeWorldStageMantisActor": "mantis",
            "TreeWorldStageRaccoonActor": "raccoon",
            "TreeWorldStageZobraActor": "zobra",
        },
    },
]

# Draw order for reconstructed parts (plists carry no z). Lower = further back.
# Matched against the lowercased part name; first hit wins, default in the middle.
Z_KEYWORDS = [
    ("_armb", 0), ("arm_back", 0), ("_arm_back", 0), ("_back", 0), ("_b.png", 0),
    ("leg_b", 1), ("_leg_b", 1), ("wheel", 1), ("surfboard", 1), ("box_back", 0),
    ("arm_lower", 2), ("leg", 3), ("box_bottom", 2),
    ("body", 4), ("coat", 5), ("torso", 4),
    ("head", 7), ("face", 8), ("_head", 7),
    ("arm_upper", 6), ("arm_front", 8), ("_arm_front", 8), ("hand", 8), ("arm", 6),
]


def part_z(name):
    n = name.lower()
    for kw, z in Z_KEYWORDS:
        if kw in n:
            return z
    return 5


def parse_rect(s):
    return [float(x) for x in re.findall(r"-?[\d.]+", s or "")]


def reconstruct(prefix, atlas, frames):
    """Rebuild a trimmed-layer actor: paste each part at its spriteColorRect origin
    onto a spriteSourceSize canvas, ordered by part_z()."""
    parts = [(n, m) for n, m in frames.items()
             if n.startswith(prefix) and (n[len(prefix):len(prefix) + 1] in ("_", "."))]
    if not parts:
        return None
    # Canvas = the shared source size (fall back to the largest if they differ).
    sizes = [parse_rect(m.get("spriteSourceSize", "")) for _, m in parts]
    sw = int(max(s[0] for s in sizes if s))
    sh = int(max(s[1] for s in sizes if s))
    canvas = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    for name, m in sorted(parts, key=lambda t: part_z(t[0])):
        tx, ty, tw, th = parse_rect(m["textureRect"])
        rotated = m.get("textureRotated", False)
        if rotated:  # atlas stores it rotated 90° CW — crop the swapped box, rotate back
            crop = atlas.crop((int(tx), int(ty), int(tx + th), int(ty + tw)))
            crop = crop.rotate(-90, expand=True)
        else:
            crop = atlas.crop((int(tx), int(ty), int(tx + tw), int(ty + th)))
        cx, cy, _cw, _ch = parse_rect(m["spriteColorRect"])
        canvas.alpha_composite(crop, (int(cx), int(cy)))
    box = canvas.getbbox()
    return canvas.crop(box) if box else None


def load_frames(path):
    """Load a TexturePacker frame table from a .plist or a plist-shaped .json."""
    if path.endswith(".plist"):
        with open(path, "rb") as f:
            return plistlib.load(f)["frames"]
    d = json.load(open(path, encoding="utf-8"))
    return d.get("frames", d)


def build_trim_actors():
    for sheet in TRIM_SHEETS:
        png, framespath = sheet["png"], sheet["frames"]
        if not (os.path.exists(png) and os.path.exists(framespath)):
            print(f"skip {os.path.basename(png)}: missing png or frames")
            continue
        atlas = Image.open(png).convert("RGBA")
        frames = load_frames(framespath)
        for key, prefix in sheet["actors"].items():
            out = reconstruct(prefix, atlas, frames)
            if out is None:
                print(f"  {key}: NO parts for prefix '{prefix}'")
                continue
            out.save(os.path.join(OUT_DIR, f"{key}.png"))
            print(f"  {key}: '{prefix}' -> {out.width}x{out.height}")


def resolve_parts(spec, frames):
    """A spec is an explicit frame list, or a prefix that collects matching frames."""
    if isinstance(spec, str):
        return [name for name in frames if name.startswith(spec)]
    return spec


def composite(key, parts, atlas, frames):
    layers = []
    for name in parts:
        f = frames.get(name)
        if not f:
            continue
        x, y = int(f["x"]), int(f["y"])
        w, h = int(round(f["width"])), int(round(f["height"]))
        src = atlas.crop((x, y, x + w, y + h))
        # Anchor within the part (pivotY flipped: rig Y is up, image Y is down).
        ax = f.get("pivotX", 0.5) * w
        ay = (1 - f.get("pivotY", 0.5)) * h
        # Where the anchor lands in the working canvas.
        axc = CX + f.get("offsetX", 0)
        ayc = CY - f.get("offsetY", 0)
        layer = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        layer.paste(src, (int(round(axc - ax)), int(round(ayc - ay))))
        rot = f.get("rotation", 0) or 0
        if rot:  # display rotation, about the anchor
            layer = layer.rotate(rot, center=(axc, ayc), resample=Image.BICUBIC, expand=False)
        layers.append((f.get("z", 0), layer))
    if not layers:
        return None
    out = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    for _z, layer in sorted(layers, key=lambda t: t[0]):
        out = Image.alpha_composite(out, layer)
    box = out.getbbox()
    return out.crop(box) if box else None


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for sheet, actors in SHEETS.items():
        png = os.path.join(SHEETDIR, f"{sheet}.png")
        rig = os.path.join(RIGDIR, f"{sheet}.json")
        if not (os.path.exists(png) and os.path.exists(rig)):
            print(f"skip {sheet}: missing png or rig")
            continue
        atlas = Image.open(png).convert("RGBA")
        frames = json.load(open(rig, encoding="utf-8"))
        frames = frames.get("frames", frames)
        for key, spec in actors.items():
            parts = resolve_parts(spec, frames)
            out = composite(key, parts, atlas, frames)
            if out is None:
                print(f"  {key}: NO parts resolved")
                continue
            out.save(os.path.join(OUT_DIR, f"{key}.png"))
            print(f"  {key}: {len(parts)} parts -> {out.width}x{out.height}")
    build_trim_actors()


if __name__ == "__main__":
    main()
