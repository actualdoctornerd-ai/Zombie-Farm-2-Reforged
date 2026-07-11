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
OUT_PARTS = os.path.join(OUT_DIR, "parts")  # per-enemy packed part strips (for the rig)

# Accumulates the runtime rig for every enemy we can build: models[key] = {parts, neck}.
# The scene's EnemyActor slices <key>.png by each part's rect and animates it (idle
# bob / leg-step walk / limb + tentacle sway), mirroring the zombie RaidActor. We
# ALSO still emit the flat composite <key>.png as a fallback for anything without a
# model. Kept as a module global so both build paths can append to one file.
MODELS = {}

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
MISCDIR = os.path.join(EXTRACT, "data", "json", "misc")

# Sheets that ship a TexturePacker atlas (as .plist OR a plist-shaped .json) but NO
# JSON rig. Their parts are TRIMMED layers of one composition sharing a
# spriteSourceSize, so pasting each part at its spriteColorRect origin reconstructs
# the assembled actor (same technique the zombie-grow tiles use). The AUTHENTIC draw
# order + per-part anchor lives in the matching <Stage>Skeleton.json (data/json/misc)
# — we read each part's `z` from there instead of guessing from the part name. Each
# entry maps a UnitStats key -> its part-name prefix in the atlas.
TRIM_SHEETS = [
    {
        "png": os.path.join(SHEETDIR, "BeachStage.png"),
        "frames": os.path.join(SHEETDIR, "BeachStage.plist"),
        "skeleton": os.path.join(MISCDIR, "BeachStageSkeleton.json"),
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
        "skeleton": os.path.join(MISCDIR, "CircusStageSkeleton.json"),
        "actors": {  # Minion1/2 verified against the binary's initSprite (were swapped)
            "CircusStageActorBoss": "ringmaster",
            "CircusStageActorMinion1": "bear",
            "CircusStageActorMinion2": "midget_clown",
        },
    },
    {
        "png": os.path.join(SHEETDIR, "ValentinesStage2012.png"),
        "frames": os.path.join(SHEETDIR, "ValentinesStage2012.plist"),
        "skeleton": os.path.join(MISCDIR, "Valentines2012StageSkeleton.json"),
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
        "skeleton": os.path.join(MISCDIR, "TreeWorldSkeleton.json"),
        "actors": {
            "TreeWorldStageBossActor": "boss_goffy",
            "TreeWorldStageMantisActor": "mantis",
            "TreeWorldStageRaccoonActor": "raccoon",
            "TreeWorldStageZobraActor": "zobra",
        },
    },
]

# Anatomical tiebreak for parts that share the same skeleton z (or have none).
# Lower = further back. Mirrors cocos2d's insertion order for a left-facing actor:
# back limbs, then body/torso, then head, then front limbs / held items. Matched
# against the lowercased part name; first hit wins, default mid-stack.
TIE_KEYWORDS = [
    ("arm_upper_b", 0), ("arm_lower_b", 0), ("arm.pngb", 0), ("_armb", 0),
    ("backarm", 0), ("arm_back", 0), ("_back", 1), ("leg_back", 1), ("leg_b", 1),
    ("wing", 1), ("surfboard", 1), ("wheel", 2), ("box_back", 0), ("box_bottom", 1),
    ("coat", 3), ("leg", 3),
    ("body", 4), ("torso", 4),
    ("leg_f", 5), ("head", 6), ("face", 7),
    ("frontarm", 8), ("arm_front", 8), ("arm_upper", 8), ("arm_middle", 8),
    ("arm_lower", 9), ("claw", 9), ("hand", 9), ("arm", 8),
]


def part_tie(name):
    n = name.lower()
    for kw, t in TIE_KEYWORDS:
        if kw in n:
            return t
    return 5


def parse_rect(s):
    return [float(x) for x in re.findall(r"-?[\d.]+", s or "")]


# --- runtime rig (animation) --------------------------------------------------
# Classify a part into an animation group by its name. `back` marks the rear of a
# limb pair (rear leg/arm) so the walk cycle can swing them in anti-phase.
def classify(name):
    n = name.lower()
    back = any(t in n for t in ("_b.png", "_back", "_armb", "backarm", "arm_back",
                                "leg_back", "leg_b", ".pngb", "_right", "arm_upper_b",
                                "arm_lower_b",
                                # camelCase suffixes with no underscore (McDonnell/lumberjack
                                # "…ArmB", "…FistB", "…HandB") — the rear arm must NOT thrust.
                                "armb", "handb", "fistb", "clawb"))
    if "wheel" in n:
        return "wheel", back  # spins when the actor rolls (bear unicycle)
    if "wing" in n:
        return "wing", back
    if "leg" in n or "foot" in n:
        return "leg", back
    if "head" in n or "face" in n:
        return "head", back
    # Torso FIRST — before the arm keywords — because actor-name PREFIXES leak into
    # every part name and can false-match a limb keyword: e.g. "farmHandBody" contains
    # "hand", which would otherwise tag the pelvis as an arm (and swing the torso).
    if any(t in n for t in ("body", "torso", "chest", "pelvis", "surf", "board")):
        return "body", back  # torso + carried boards/shields — static
    # Held tools swing WITH the arm (shared-shoulder rotation in EnemyActor), so tag
    # them "arm". Only real enemy weapons here (pitchfork); boards handled above.
    if any(t in n for t in ("pitchfork", "fork", "axe", "sword", "spear", "staff",
                            "club", "hammer", "mace", "scythe", "lance", "trident")):
        return "arm", back
    # tentacles/tails/claws/hands read as swinging "arms"; the squid's arm_front/back
    # ARE its tentacles. coat_tail sways too.
    if any(t in n for t in ("arm", "fist", "claw", "hand", "tail", "tentacle")):
        return "arm", back
    return "body", back  # torso, wheel, box, etc. — static


def emit_rig(key, placed):
    """Pack an actor's parts into one strip PNG and record its runtime rig in MODELS.
    `placed` items: dict(crop, tlx, tly, w, h, z, rot(deg CCW), group, back, and for
    display-rotated parts pivotX/pivotY/axc/ayc). Positions are in an arbitrary pixel
    canvas; the scene normalizes via getLocalBounds, so only relative layout matters."""
    if not placed:
        return
    import math
    minx = min(p["tlx"] for p in placed)
    miny = min(p["tly"] for p in placed)
    for p in placed:
        p["tlx"] -= minx
        p["tly"] -= miny
    # Neck (head-nod pivot) = bottom-center of the combined head parts, if any.
    heads = [p for p in placed if p["group"] == "head"]
    neck = None
    if heads:
        hx0 = min(p["tlx"] for p in heads)
        hx1 = max(p["tlx"] + p["w"] for p in heads)
        hy1 = max(p["tly"] + p["h"] for p in heads)
        neck = {"x": round((hx0 + hx1) / 2, 1), "y": round(hy1, 1)}
    pad = 2
    sw = sum(p["w"] + pad for p in placed) + pad
    sh = max(p["h"] for p in placed) + 2 * pad
    strip = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    x = pad
    parts_json = []
    for p in sorted(placed, key=lambda q: q["z"]):
        strip.paste(p["crop"], (x, pad), p["crop"])
        rx, ry, rw, rh = x, pad, p["w"], p["h"]
        x += p["w"] + pad
        rot = p.get("rot", 0) or 0
        if rot:
            # Display-rotated parts (pitchfork, held fist/axe) keep their AUTHENTIC pivot,
            # position and intrinsic rotation. Both cocos2d and pixi are CW-positive and
            # the texture displays top-up in both, so the rotation is NOT negated (only
            # positions get the y-flip); negating it pointed the tines BACKWARD.
            # A held TOOL (classify -> "arm") still animates: EnemyActor swings it around
            # the shared shoulder (not its own pivot), so the weapon thrusts WITH the arm.
            # Everything else display-rotated stays static "body".
            ax, ay = p["pivotX"], 1 - p["pivotY"]
            px, py = p["axc"] - minx, p["ayc"] - miny
            grp = "arm" if p["group"] == "arm" else "body"
            rrad = round(math.radians(rot), 4)
        elif p["group"] == "wheel":
            # Anchor a wheel at its CENTER so it spins in place while rolling.
            ax, ay = 0.5, 0.5
            px, py = p["tlx"] + p["w"] * 0.5, p["tly"] + p["h"] * 0.5
            grp = "wheel"
            rrad = 0.0
        elif p["group"] in ("leg", "arm", "wing"):
            # Anchor a limb at its top-center (hip/shoulder) so it swings from the joint.
            ax, ay = 0.5, 0.0
            px, py = p["tlx"] + p["w"] * 0.5, p["tly"]
            grp = p["group"]
            rrad = 0.0
        else:
            ax, ay = 0.0, 0.0
            px, py = p["tlx"], p["tly"]
            grp = p["group"]
            rrad = 0.0
        parts_json.append({
            "rx": rx, "ry": ry, "rw": rw, "rh": rh,
            "px": round(px, 1), "py": round(py, 1), "ax": ax, "ay": ay,
            "z": p["z"], "rot": rrad, "group": grp, "back": bool(p["back"]),
        })
    os.makedirs(OUT_PARTS, exist_ok=True)
    strip.save(os.path.join(OUT_PARTS, f"{key}.png"))
    MODELS[key] = {"parts": parts_json, "neck": neck}


def skeletal_placed(parts, atlas, frames):
    """Placed-part list for a json-rig actor (Farm/Alien/Robot): pivot+offset layout,
    matching composite() but kept as separate sprites for the rig."""
    placed = []
    for name in parts:
        f = frames.get(name)
        if not f:
            continue
        w, h = int(round(f["width"])), int(round(f["height"]))
        crop = atlas.crop((int(f["x"]), int(f["y"]), int(f["x"]) + w, int(f["y"]) + h))
        pivotX = f.get("pivotX", 0.5)
        pivotY = f.get("pivotY", 0.5)
        axc = CX + f.get("offsetX", 0)
        ayc = CY - f.get("offsetY", 0)
        tlx = axc - pivotX * w
        tly = ayc - (1 - pivotY) * h
        g, back = classify(name)
        placed.append(dict(name=name, crop=crop, tlx=tlx, tly=tly, w=w, h=h,
                           z=f.get("z", 0), rot=f.get("rotation", 0) or 0,
                           group=g, back=back, pivotX=pivotX, pivotY=pivotY,
                           axc=axc, ayc=ayc))
    return placed


def trim_placed(prefix, atlas, frames, zmap, offmap):
    """Placed-part list for a trimmed-layer actor (Beach/Circus/Valentines/TreeWorld):
    each part sits at its spriteColorRect + skeleton bone offset on the source canvas."""
    placed = []
    for name, m in _uniq_parts(prefix, frames, offmap):
        tx, ty, tw, th = parse_rect(m["textureRect"])
        if m.get("textureRotated", False):
            crop = atlas.crop((int(tx), int(ty), int(tx + th), int(ty + tw))).rotate(-90, expand=True)
        else:
            crop = atlas.crop((int(tx), int(ty), int(tx + tw), int(ty + th)))
        cx, cy, cw, ch = parse_rect(m["spriteColorRect"])
        ox, oy = offset_of(offmap, name)
        g, back = classify(name)
        placed.append(dict(name=name, crop=crop, tlx=cx + ox, tly=cy + oy, w=int(cw), h=int(ch),
                           z=zmap.get(name, 0), rot=0, group=g, back=back))
    return placed


def offset_of(offmap, name):
    """Skeleton bone offset (cocos2d, y-up) for a part -> (ox, oy_down) in canvas px."""
    o = offmap.get(name)
    if not o:
        return 0.0, 0.0
    return o[0], -o[1]  # y-up -> y-down


def _uniq_parts(prefix, frames, offmap):
    """Parts of one actor, de-duplicated on (textureRect, offset). Bones that reuse
    the SAME atlas region AND sit at the same offset are true animation aliases and
    are dropped; ones at DIFFERENT offsets (a clown's 3 stacked bodies) are kept."""
    parts = [(n, m) for n, m in frames.items()
             if n.startswith(prefix) and (n[len(prefix):len(prefix) + 1] in ("_", "."))]
    seen, uniq = set(), []
    for name, m in parts:
        key = (tuple(parse_rect(m["textureRect"])), tuple(offmap.get(name, ())))
        if key in seen:
            continue
        seen.add(key)
        uniq.append((name, m))
    return uniq


def reconstruct(prefix, atlas, frames, zmap, offmap):
    """Rebuild a trimmed-layer actor: paste each part at its spriteColorRect origin
    (plus its skeleton bone offset) onto the shared spriteSourceSize canvas, in the
    AUTHENTIC draw order (z), with an anatomical tiebreak for parts that share a z."""
    uniq = _uniq_parts(prefix, frames, offmap)
    if not uniq:
        return None
    # Canvas holds the source frame plus room for offset-stacked bones (e.g. the
    # clown's 3-high tower rises well above one source frame). Pad generously.
    sizes = [parse_rect(m.get("spriteSourceSize", "")) for _, m in uniq]
    base_w = int(max(s[0] for s in sizes if s))
    base_h = int(max(s[1] for s in sizes if s))
    pad = 160
    canvas = Image.new("RGBA", (base_w + 2 * pad, base_h + 2 * pad), (0, 0, 0, 0))
    order = sorted(uniq, key=lambda t: (zmap.get(t[0], 0), part_tie(t[0])))
    for name, m in order:
        tx, ty, tw, th = parse_rect(m["textureRect"])
        rotated = m.get("textureRotated", False)
        if rotated:  # atlas stores it rotated 90° CW — crop the swapped box, rotate back
            crop = atlas.crop((int(tx), int(ty), int(tx + th), int(ty + tw)))
            crop = crop.rotate(-90, expand=True)
        else:
            crop = atlas.crop((int(tx), int(ty), int(tx + tw), int(ty + th)))
        cx, cy, _cw, _ch = parse_rect(m["spriteColorRect"])
        ox, oy = offset_of(offmap, name)
        canvas.alpha_composite(crop, (int(cx + ox) + pad, int(cy + oy) + pad))
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
        skelpath = sheet.get("skeleton")
        skel = json.load(open(skelpath, encoding="utf-8")) if skelpath and os.path.exists(skelpath) else {}
        # authentic draw order: part-name -> z (bones without a z default to 0),
        # and per-bone position offset (stacks the clown's 3 bodies, shifts back limbs).
        zmap = {k: v.get("z", 0) for k, v in skel.items() if isinstance(v, dict)}
        offmap = {k: parse_rect(v.get("offset", "")) for k, v in skel.items()
                  if isinstance(v, dict) and v.get("offset")}
        for key, prefix in sheet["actors"].items():
            out = reconstruct(prefix, atlas, frames, zmap, offmap)
            if out is None:
                print(f"  {key}: NO parts for prefix '{prefix}'")
                continue
            out.save(os.path.join(OUT_DIR, f"{key}.png"))
            emit_rig(key, trim_placed(prefix, atlas, frames, zmap, offmap))  # animated rig
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
        if rot:  # display rotation about the anchor; PIL is CCW+, pixi/display is CW+
            # by `rot` degrees, so rotate -rot (matches emit_rig's un-negated radians).
            layer = layer.rotate(-rot, center=(axc, ayc), resample=Image.BICUBIC, expand=False)
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
            emit_rig(key, skeletal_placed(parts, atlas, frames))  # animated rig
            print(f"  {key}: {len(parts)} parts -> {out.width}x{out.height}")
    build_trim_actors()
    with open(os.path.join(OUT_DIR, "models.json"), "w", encoding="utf-8") as f:
        json.dump(MODELS, f, separators=(",", ":"))
    print(f"models.json: {len(MODELS)} enemy rigs")


if __name__ == "__main__":
    main()
