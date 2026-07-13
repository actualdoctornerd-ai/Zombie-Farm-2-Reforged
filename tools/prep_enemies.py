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
SPRITEDIR = os.path.join(EXTRACT, "data", "json", "sprites")

# --- GROUND-TRUTH bare-sheet rigs (Ninja / Pirate / City) --------------------
# NinjaStage/PirateStage/CityStage ship a 256x256 paper-doll sheet with NO plist.
# Their rig (per-part textureRect / anchor / offset / z-order) is hardcoded in the
# binary's -[<Actor> initSpriteDictionary]. tools/re/extract_stage_rigs.py decodes
# those calls into data/json/sprites/BareStageRigs.json (regenerate with:
#   cd ../ZF2R_extracted/tools/re && python extract_stage_rigs.py --class ...).
# We assemble each actor through the SAME pivot/offset compositor as Farm/Alien/
# Robot — no eyeballing (this replaces the old prep_bare_stages.py). The rig's
# conventions match FarmStage.json: offset is cocos2d y-UP, anchor.y is from the
# BOTTOM, z is draw order.
BARE_RIGS_JSON = os.path.join(SPRITEDIR, "BareStageRigs.json")
BARE_SHEETS = {  # actor-key prefix -> its 256x256 part sheet
    "NinjaStageActor": os.path.join(SHEETDIR, "NinjaStage.png"),
    "PirateStageActor": os.path.join(SHEETDIR, "PirateStage.png"),
    "CityStageActor": os.path.join(SHEETDIR, "CityStage.png"),
}
# The "default*" parts sit in ACTOR space; every other part is a child BONE whose
# (0,0)-ish offset is relative to its parent bone's ref point (the binary wires
# these as parentAttachment/childAttachments — see ActorAttachment). We fold the
# parent's offset in so held/worn parts land on the hand/head instead of at the
# feet. Parent is inferred from the part name (weapon->front arm, worn->head/body).
DEFAULT_PARTS = {"defaultArmF", "defaultArmB", "defaultHead",
                 "defaultBody", "defaultFootF", "defaultFootB"}
PARENT_ARM = ("sickle", "carrot", "sword", "bat", "dagger", "pencil", "gavel",
              "hammer", "knife", "blade", "staff", "club", "cutlass", "hook",
              "wrench", "katana", "talon", "fist", "gun", "axe", "mace")
PARENT_HEAD = ("glasses", "headset", "hat", "mask", "hair", "horn", "helmet",
               "ear", "eye", "beard", "band", "bandana")
PARENT_BODY = ("cape", "coat", "tail", "belt", "apron", "tie", "vest", "cloak")

# --- VideoGame raid actors ---------------------------------------------------
# Video Games' 5 enemies are NOT paper dolls: each -[VideoGameStage*Actor
# initSpriteDictionary] loads a TexturePacker atlas (<Name>.plist) of pre-rendered
# frames (idle_fr##, attack_fr##). We extract the standing IDLE frame as the flat
# actor sprite (the scene renders a flat enemy texture when no part-rig exists).
# Key -> the plist/png basename its initSpriteDictionary references (binary-verified).
VIDEOGAME_ATLASES = {
    "VideoGameStageBossActor": os.path.join(EXTRACT, "assets", "spritesheets", "misc", "VideoGameBoss"),
    "VideoGameStageKnightActor": os.path.join(EXTRACT, "assets", "spritesheets", "misc", "VideoGameKnight"),
    "VideoGameStageMonsterActor": os.path.join(EXTRACT, "assets", "spritesheets", "misc", "VideoGameMonster"),
    "VideoGameStageGhostActor": os.path.join(EXTRACT, "assets", "spritesheets", "pets", "VideoGameGhost"),
    "VideoGameStageZombieActor": os.path.join(EXTRACT, "assets", "spritesheets", "zombies", "VideoGameZombie"),
}

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

# Bare-fisted PUNCHERS: the business-suited City lawyers + office boss rest their arms at
# their sides and only extend to jab (EnemyActor idle droop). Everyone else holds a weapon
# (baked into the arm sprite for many, e.g. the lumberjack's axe) or is non-humanoid, so an
# arm-droop would look wrong — hence an explicit allowlist, not a heuristic.
PUNCHER_KEYS = {"CityStageActorLawyer", "CityStageActorBoss"}


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


def eff_z(zmap, name):
    """Effective draw z for a trimmed-actor part: its explicit skeleton z if it has
    one, else its anatomical part_tie (so a z-less body/head sits mid-stack, not at 0
    behind the explicitly-z'd back limbs)."""
    z = zmap.get(name)
    return z if isinstance(z, (int, float)) else part_tie(name)


def parse_rect(s):
    return [float(x) for x in re.findall(r"-?[\d.]+", s or "")]


# Held-weapon part names (a superset of the farm pitchfork + bare-sheet weapons). A
# weapon is a CHILD of the arm bone — it must NOT be mistaken for the shoulder pivot
# (a raised sword's tip would otherwise become the pivot; see emit_rig `shoulder`).
WEAPON_TOOLS = ("pitchfork", "fork", "axe", "sword", "spear", "staff", "club",
                "hammer", "mace", "scythe", "lance", "trident", "sickle", "carrot",
                "bat", "dagger", "pencil", "gavel", "cutlass", "hook", "knife",
                "blade", "katana")


def is_weapon(name):
    return any(t in name.lower() for t in WEAPON_TOOLS)


# Bosses whose melee is a two-handed OVERHEAD SLAM (both arms raise above the head,
# then slam down at the hit) instead of the default forward jab — EnemyActor `slam`.
SLAM_KEYS = {"PirateStageActorBoss"}

# A weapon-holder CHOPS the tool up then down about the shoulder (EnemyActor `chop`).
# The default raise lifts the tool UP for a tool-arm on the near/left side of the
# shoulder. Rigs whose tool-arm sits on the FAR/right side (a cross-body swing — the
# lumberjack's axe, McDonnell's throw arm) need the sign flipped so the raise still
# lifts UP rather than dropping the blade. Keep in sync with models.json `chopSign`.
CHOP_SIGN_OVERRIDES = {
    "FarmStageActorLumberjack": -1,
    "FarmStageActorBoss": -1,
}

# Explicit shoulder-pivot overrides (strip space) for rigs whose auto-picked pivot
# reads wrong (see emit_rig). Keep in sync with the value baked into models.json.
SHOULDER_OVERRIDES = {
    "FarmStageActorLumberjack": {"x": 72.0, "y": 50.0},
}

# Per-part tweaks (strip space) applied after layout. Match by packed size (rw,rh) and
# optionally `back`; then `dpx/dpy` nudge position, `z` overrides draw order, `drot`
# tilts, and `ax/ay` re-seat the anchor/pivot (position is compensated so the REST pose
# is unchanged — only the rotation pivot moves). Keep in sync with models.json.
PART_POS_OVERRIDES = {
    # Farmhand grips the pitchfork by the HANDLE, not the tines: the fork sprite
    # (rw39×rh148, held horizontal) defaults with the hand at the tine/head end and the
    # whole shaft jutting out behind. Slide it forward (dpx) so the hand lands on the
    # wooden handle and the tines project ahead as the business end (verified via harness).
    "FarmStageActorFarmhand": [
        {"rw": 39, "rh": 148, "dpx": -72.0},
    ],
    # Lumberjack's near arm is TWO nearly-duplicate sprites: lumberjackArmF (plaid upper
    # arm + flesh forearm + empty hand) and lumberjackFistF (flesh forearm + hand + axe).
    # By default FistF sits offset from ArmF, so the axe arm reads as a misplaced/doubled
    # second limb. Slide FistF over so its forearm/hand LANDS ON ArmF's (they share the
    # shoulder pivot, so aligned-at-rest stays aligned through the swing) and draw it in
    # FRONT — now it reads as one arm holding an axe. Separately, drop the rear arm
    # (lumberjackArmB) to a lower, more natural hang.
    "FarmStageActorLumberjack": [
        {"rw": 44, "rh": 88, "dpx": 56.0, "dpy": -18.0, "z": 9},   # FistF onto ArmF's hand, in front
        {"rw": 62, "rh": 41, "back": True, "drot": -0.45},          # ArmB — lower angle
    ],
    # McDonnell's plaid arms: drop them a touch (drot) so they don't leave a shoulder/
    # torso gap, and move each anchor to the SHOULDER end (the body-side end) so the arm
    # pivots from the shoulder instead of spinning about its middle. Back arm's shoulder
    # is its right end (ax=1), the front arm's is its left end (ax=0).
    "FarmStageActorBoss": [
        {"rw": 64, "rh": 30, "back": True, "drot": 0.2, "ax": 1.0, "ay": 0.5},
        {"rw": 64, "rh": 30, "back": False, "drot": 0.2, "ax": 0.0, "ay": 0.5},
    ],
}


# --- runtime rig (animation) --------------------------------------------------
# Classify a part into an animation group by its name. `back` marks the rear of a
# limb pair (rear leg/arm) so the walk cycle can swing them in anti-phase.
def classify(name):
    n = name.lower()
    back = any(t in n for t in ("_b.png", "_back", "_armb", "backarm", "arm_back",
                                "leg_back", "leg_b", ".pngb", "_right", "arm_upper_b",
                                "arm_lower_b",
                                # camelCase suffixes with no underscore (McDonnell/lumberjack
                                # "…ArmB", "…FistB", "…HandB"; bare-sheet "defaultFootB"/"…DaggerB")
                                # — the rear limb must swing in anti-phase and not thrust.
                                "armb", "handb", "fistb", "clawb", "footb", "daggerb"))
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
    # them "arm". Farm pitchfork plus the bare-sheet weapons (carrot sickle, sword,
    # bat, dagger, office pencil/gavel, boss's huge carrot, pirate hook).
    if is_weapon(name):
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
    # Shoulder pivot for the attack swing. EnemyActor otherwise guesses it as the
    # top-most front-arm part — which breaks when a held weapon (a raised sword) is the
    # top-most part, making the whole arm orbit the blade TIP. When the rig has a
    # distinct arm BONE plus a separate weapon, pin the shoulder to the arm bone's
    # authentic anchor (axc/ayc, shifted into strip space) so the weapon swings from
    # the shoulder as it should.
    shoulder = None
    front = [p for p in placed if p["group"] == "arm" and not p["back"]]
    arm_bones = [p for p in front if not is_weapon(p.get("name", "")) and "axc" in p]
    weapons = [p for p in front if is_weapon(p.get("name", ""))]
    if arm_bones and weapons:
        a = arm_bones[0]
        shoulder = {"x": round(a["axc"] - minx, 1), "y": round(a["ayc"] - miny, 1)}
    # Explicit strip-space override where the auto-pick reads wrong. The lumberjack's
    # axe hand isn't a recognised WEAPON name (so the arm-bone/weapon split above
    # doesn't fire) and its plaid bicep is camouflaged against the shirt — the fallback
    # then pivots the swing from the far-back shoulder anchor, so the axe winds up over
    # the face and the visible forearm reads as hinging at the pelvis. This pins the
    # pivot forward at the upper torso so the strike is a clean forward slice toward the
    # target (verified via tools/dev-enemy harness).
    if key in SHOULDER_OVERRIDES:
        shoulder = dict(SHOULDER_OVERRIDES[key])
    # Nudge specific parts (matched by packed size) to close art seams — see
    # PART_POS_OVERRIDES (e.g. the lumberjack forearm/upper-arm elbow gap).
    for ov in PART_POS_OVERRIDES.get(key, []):
        for pj in parts_json:
            if pj["rw"] != ov["rw"] or pj["rh"] != ov["rh"]:
                continue
            if "back" in ov and pj["back"] != ov["back"]:
                continue
            # ax/ay re-seat the anchor (pivot); compensate position so the rest pose is
            # unchanged (naive shift, matching the dev-enemy harness).
            if "ax" in ov:
                pj["px"] = round(pj["px"] + (ov["ax"] - pj["ax"]) * pj["rw"], 1)
                pj["ax"] = ov["ax"]
            if "ay" in ov:
                pj["py"] = round(pj["py"] + (ov["ay"] - pj["ay"]) * pj["rh"], 1)
                pj["ay"] = ov["ay"]
            if "dpx" in ov:
                pj["px"] = round(pj["px"] + ov["dpx"], 1)
            if "dpy" in ov:
                pj["py"] = round(pj["py"] + ov["dpy"], 1)
            if "z" in ov:
                pj["z"] = ov["z"]
            if "drot" in ov:
                pj["rot"] = round(pj["rot"] + ov["drot"], 4)
    os.makedirs(OUT_PARTS, exist_ok=True)
    strip.save(os.path.join(OUT_PARTS, f"{key}.png"))
    # A PUNCHER (allowlisted bare-fisted suit) rests its arms at its sides and only
    # extends them to jab; everyone else keeps a weapon/limb up in a ready pose.
    MODELS[key] = {"parts": parts_json, "neck": neck, "punch": key in PUNCHER_KEYS}
    if shoulder:
        MODELS[key]["shoulder"] = shoulder
    if key in SLAM_KEYS:
        MODELS[key]["slam"] = True
    if key in CHOP_SIGN_OVERRIDES:
        MODELS[key]["chopSign"] = CHOP_SIGN_OVERRIDES[key]


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
                           z=eff_z(zmap, name), rot=0, group=g, back=back))
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
    order = sorted(uniq, key=lambda t: (eff_z(zmap, t[0]), part_tie(t[0])))
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
        # authentic draw order: part-name -> z. Keep ONLY real numeric z values; a bone
        # with no z (or null) falls back to its anatomical part_tie in eff_z() below —
        # NOT 0, which wrongly slid z-less bodies/heads BEHIND explicitly-z'd back limbs
        # (e.g. the circus bear's back arm z=2 drew in front of its z-less body).
        zmap = {k: v["z"] for k, v in skel.items()
                if isinstance(v, dict) and isinstance(v.get("z"), (int, float))}
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


def bare_sheet_for(key):
    for pfx, png in BARE_SHEETS.items():
        if key.startswith(pfx):
            return png
    return None


def parent_bone(name, present):
    """The bone a held/worn part hangs off (its (0,0) offset is relative to that
    bone's ref point). None for the actor-root default parts."""
    if name in DEFAULT_PARTS:
        return None
    n = name.lower()
    if any(t in n for t in PARENT_ARM) and "defaultArmF" in present:
        return "defaultArmF"
    if any(t in n for t in PARENT_HEAD) and "defaultHead" in present:
        return "defaultHead"
    if any(t in n for t in PARENT_BODY) and "defaultBody" in present:
        return "defaultBody"
    return None


def bare_frames(entries):
    """Turn extracted rig entries (rect/anchor/offset/z) into a FarmStage.json-style
    `frames` dict + ordered part names, folding each child bone's parent offset into
    its own so held/worn parts render on the hand/head, not at the actor root."""
    off = {e["name"]: e["offset"] for e in entries}
    present = set(off)
    frames, order = {}, []
    for e in entries:
        rx, ry, rw, rh = e["rect"]
        if rw <= 0 or rh <= 0:
            continue
        ox, oy = e["offset"]
        par = parent_bone(e["name"], present)
        if par:
            ox += off[par][0]
            oy += off[par][1]
        frames[e["name"]] = {
            "x": rx, "y": ry, "width": rw, "height": rh,
            "pivotX": e["anchor"][0], "pivotY": e["anchor"][1],
            "offsetX": ox, "offsetY": oy, "z": e["z"], "rotation": 0,
        }
        order.append(e["name"])
    return order, frames


def build_bare_actors():
    """Ninja / Pirate / City actors from the binary-decoded rig (BareStageRigs.json)."""
    if not os.path.exists(BARE_RIGS_JSON):
        print("skip bare-sheet actors: run tools/re/extract_stage_rigs.py first "
              "(BareStageRigs.json missing)")
        return
    rigs = json.load(open(BARE_RIGS_JSON, encoding="utf-8"))
    atlases = {}
    for key, entries in rigs.items():
        png = bare_sheet_for(key)
        if not (png and os.path.exists(png)):
            print(f"  {key}: no sheet")
            continue
        atlas = atlases.get(png) or Image.open(png).convert("RGBA")
        atlases[png] = atlas
        order, frames = bare_frames(entries)
        out = composite(key, order, atlas, frames)
        if out is None:
            print(f"  {key}: NO parts")
            continue
        out.save(os.path.join(OUT_DIR, f"{key}.png"))
        emit_rig(key, skeletal_placed(order, atlas, frames))
        print(f"  {key}: {len(order)} parts -> {out.width}x{out.height}")


def build_videogame_actors():
    """VideoGame enemies: extract the standing IDLE frame from each TexturePacker
    atlas as the flat actor sprite (the scene shows a flat texture when no rig)."""
    for key, base in VIDEOGAME_ATLASES.items():
        png, plist = base + ".png", base + ".plist"
        if not (os.path.exists(png) and os.path.exists(plist)):
            print(f"  {key}: missing atlas")
            continue
        atlas = Image.open(png).convert("RGBA")
        frames = plistlib.load(open(plist, "rb"))["frames"]
        idle = sorted(k for k in frames if "idle" in k.lower()) or sorted(frames)
        f = frames[idle[0]]
        tx, ty, tw, th = parse_rect(f["textureRect"])
        if f.get("textureRotated", False):
            crop = atlas.crop((int(tx), int(ty), int(tx + th), int(ty + tw))).rotate(-90, expand=True)
        else:
            crop = atlas.crop((int(tx), int(ty), int(tx + tw), int(ty + th)))
        cx, cy, _cw, _ch = parse_rect(f["spriteColorRect"])
        ssz = parse_rect(f["spriteSourceSize"])
        canvas = Image.new("RGBA", (int(ssz[0]), int(ssz[1])), (0, 0, 0, 0))
        canvas.alpha_composite(crop, (int(cx), int(cy)))
        box = canvas.getbbox()
        out = canvas.crop(box) if box else canvas
        out.save(os.path.join(OUT_DIR, f"{key}.png"))
        print(f"  {key}: idle '{idle[0]}' -> {out.width}x{out.height}")


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
    print("bare-sheet actors (Ninja/Pirate/City, binary rig):")
    build_bare_actors()
    print("videogame actors (idle frame):")
    build_videogame_actors()
    with open(os.path.join(OUT_DIR, "models.json"), "w", encoding="utf-8") as f:
        json.dump(MODELS, f, separators=(",", ":"))
    print(f"models.json: {len(MODELS)} enemy rigs")


if __name__ == "__main__":
    main()
