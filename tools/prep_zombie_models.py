#!/usr/bin/env python3
"""Build per-type zombie MODELS for the 56 growable group x tier zombies.

The base group x tier zombies (Zombie/Zyborg/Girl Zombie/Mini/ZomBumpkin/...) are
composed IN THE GAME ENGINE, so unlike the 40 named specials there is no plist that
lists each one's parts. But every part lives in `ZombieSheet.png` with full rig
geometry (offset/pivot/z) in `ZombieSheet.json`, and each part's NAME identifies the
zombie it belongs to (amazon->Amazombie, cyborg->Zyborg, skull->Skull Head,
carrot->Carrot Zombie, ...). This tool reverse-engineers the composition per unit
from those name conventions + the authentic per-unit tint (Market `color`), and emits:

  public/assets/zombie/ZombieSheet.png   (atlas copy — one image, sub-sliced at runtime)
  public/assets/zombie/frames.json       ({part: {x,y,w,h}} for every used part)
  public/assets/zombie/models.json       ({unitKey: manifest}) — parts/scale/color/neck
  public/assets/zombie/portrait/<key>.png (flat tinted composite for menus)

The runtime (assets.ts + ZombieUnit.ts) loads the atlas once, slices sub-textures,
and assembles/animates each unit from its manifest (head tilt + leg step), tinting
the grey skeleton by the unit colour while themed parts keep their own colours.

Run from the repo root:  python zombiefarm/tools/prep_zombie_models.py
"""
import json
import os
import re
import shutil

from atlas_stamp import stamp_frames

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APP = os.path.join(ROOT, "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app")
SHEET_JSON = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "sprites", "ZombieSheet.json")
MARKET = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "gameplay", "Market.json")
OUT = os.path.join(ROOT, "zombiefarm", "public", "assets", "zombie")

# ---------------------------------------------------------------------------
# Part slots. Adding a part to a slot REPLACES the default in that slot; parts
# with slot None are additive overlays (features/hats/wings/props).
# ---------------------------------------------------------------------------
SLOT = {}
for p in ["Body"]:
    for b in ["girl", "amazon", "limaBean", "heartichoke", "cupid", "bellydancer",
              "pumpkin", "scarecrow", "santa", "reindeer", "diver", "valentines",
              "zombotron"]:
        SLOT[b + p] = "Body"
for h in ["skull", "coffee", "garlic", "onion", "potato", "tomato", "pumpkin", "diver"]:
    SLOT[h + "Head"] = "Head"
for j in ["brute", "robocop", "barbarian", "leprachaun", "viking"]:
    SLOT[j + "Jaw"] = "Jaw"
for a in ["celery", "turnip", "dragon", "mutation", "diver"]:
    SLOT[a + "Arm"] = "ArmF"
SLOT["diverArmF"] = "ArmF"
SLOT["diverArmB"] = "ArmB"
for f in ["pumpkin", "santa", "diver"]:
    SLOT[f + "FootF"] = "FootF"
    SLOT[f + "FootB"] = "FootB"
SLOT["crazyEyeL"] = "EyeL"
SLOT["crazyEyeR"] = "EyeR"

# The default skeleton, one part per slot.
DEFAULT = {
    "ArmB": "defaultArmB", "Body": "defaultBody", "Head": "defaultHead",
    "EyeL": "defaultEyeL", "EyeR": "defaultEyeR", "Jaw": "defaultJaw",
    "UpperTeeth": "defaultUpperTeeth", "LowerTeeth": "defaultLowerTeeth",
    "Scar": "defaultScar", "FootF": "defaultFootF", "FootB": "defaultFootB",
    "ArmF": "defaultArmF",
}
HEAD_SLOTS = {"Head", "EyeL", "EyeR", "Jaw", "UpperTeeth", "LowerTeeth", "Scar"}

# Crop-mutation body parts, keyed by mutation KEY (the catalog in
# src/zombie/mutations.ts). Keys, not bits: the catalog is append-only and a
# mutation's bit is just its position in it, so art addressed by bit silently
# re-points if the list ever moves. These parts are STRIPPED from the runtime base
# body model and re-added at runtime from a unit's `mutation` mask, so a combined
# zombie shows exactly the mutations it carries — independent of which parent
# species it inherited. (Portraits keep the full art.)
MUTATION_PART = {
    "tomato": "tomatoHead", "onion": "onionHead", "carrot": "carrotHat",
    "turnip": "turnipArm", "potato": "potatoHead", "coffee": "coffeeHead",
    "celery": "celeryArm", "broccoli": "broccoliHat", "garlic": "garlicHead",
    "cauli": "cauliflowerHat", "limabean": "limaBeanBody",
    "flytrap": "flytrapCollar", "dragon": "dragonArm",
    # Pumpking. `pumpkinHead` is the authored carved jack-o'-lantern: a HEAD-slot part
    # with the same offsets as every other vegetable head (offsetX 6 / offsetY 36 / z 4,
    # exactly onionHead's), so it needs no rig override of its own.
    #
    # NOT `pumpkinHatFeature`, which is the wide brimmed pumpkin JackoZombie wears ON
    # TOP of its ordinary head — a hat, not a head. Pointing the bit at it rendered the
    # mutation as a faceless gourd hovering over the shoulders, and needed a hand-tuned
    # offset to sit anywhere near right.
    "pumpking": "pumpkinHead",
    # The two Tier-4 crops. They used to have no bit of their own — each rode a lower
    # tier's, reaching the rig through VARIANT_OVERRIDE below — so their art was keyed
    # by PART name only. They are catalogued mutations now (mutations.ts), so they need
    # the ordinary key-addressed entry every other mutation has; the part-keyed one is
    # still emitted for units that have yet to shed the shared bit.
    "eyebiscus": "eyebiscusHat", "heartichoke": "heartichokeBody",
}
# Tier-4 variants SHARE a mutation with a lower tier (Eyebiscus=Carrot,
# Heartichoke=Cauliflower) but have their OWN hair art. We emit a per-model
# `mutationOverrides` remap so the field render swaps the shared mutation's part for
# the variant's true sprite; the mutation itself is unchanged. Keyed by unitKey ->
# (mutation key, part-name). MIRRORED by MUTATION_VARIANTS in
# src/zombie/mutationDisplay.ts, which supplies the matching NAME and icon — the two
# must name the same part. Their portraits already use the true art via FEATURE.
VARIANT_OVERRIDE = {
    "ZombieActorRegularTier4Eyebiscus": ("carrot", "eyebiscusHat"),
    "ZombieActorRegularTier4Heartichoke": ("cauli", "heartichokeBody"),
}
# Every mutation part name (incl. the Tier-4 variants + the generic mutationArm),
# stripped from runtime base models. No exemption is needed: JackoZombie's own
# pumpkin is `pumpkinHatFeature`, which is not a mutation part at all, and no base
# model draws the carved `pumpkinHead`.
MUT_PARTS = set(MUTATION_PART.values()) | {
    "eyebiscusHat", "heartichokeBody", "mutationArm",
}

# Additive parts that sit ON the head (tilt with it, positioned head-relative).
HEAD_ADD = {
    "beautyFeature", "amazonFeature", "femaleFeature", "cyborgFeature", "robotFeature",
    "robocopFeature", "impFeature", "gnomeFeature", "goblinEarFeature", "nerdFeature",
    "cupidFeature", "beeFeature", "reindeerFeature", "sunflowerFeature", "locksFeature",
    "bellydancerFeature", "browFeature", "eyeBrowFeature", "leprachaunBrowFeature",
    "leprachaunEarFeature", "leprachaunHatFeature", "carrotHat", "broccoliHat",
    "cauliflowerHat", "eyebiscusHat", "pumpkinHatFeature", "santaHatFeature",
    "scarecrowHatFeature", "valentinesHatFeature", "barbarianHair", "beard", "mustache",
    "vikingHatFeature", "vikingMustacheFeature", "zombotronFeature",
}
# Facial FEATURES (Features slot) are ADDITIVE in the engine — they never remove the
# separate default eye attachments (EyeL/EyeR). The default head has empty eye SOCKETS;
# the eyes are the defaultEyeL/R parts, and every feature draws over/around them:
#   - additive overlays (lashes, hat, horns, hair, antlers) leave the eyeballs visible;
#   - masks/visors/glasses with holes or transparent lenses show the eyes THROUGH them
#     (amazon, cyborg, robot, robocop, nerd, sunflower — all verified against the sheet);
#   - a feature with its OWN opaque eyes (bee) simply paints over the default ones.
# So NO facial feature drops the eyes. (A themed HEAD swap still does — see below.)
# Empirically dropping them left girl/garden/small/etc. with hollow black sockets.
FACE_FEATURES: set = set()
# The grey skeleton is tinted by the unit colour; themed parts keep their designed
# colours. In the engine a part inherits colour BY DEFAULT (verified: base ZombieActor
# adds body/head/jaw with no setInheritColor call, yet zombies are coloured); only
# themed parts explicitly setInheritColor:0. The Large brow + brute/barbarian jaws are
# grey skeleton parts with NO opt-out, so they tint too (they were rendering grey on a
# coloured body). vikingJaw is the one Large jaw that explicitly setInheritColor:0, so
# it stays as designed and is NOT tinted.
# The goblin/imp EAR and the leprechaun's EAR are skeleton parts too, confirmed against
# the binary: -[ZombieActorSmallTier3 initSprite] makes no setInheritColor call at all,
# and -[ZombieActorSmallTier5 initSprite] opts out only tag 0x13 (leprachaunHatFeature)
# and tag 0xf (leprachaunJaw) — the ear it adds at tag 0x12 keeps inheriting. Untinted
# they rendered SILVER beside a coloured head.
TINTABLE = {"defaultArmB", "defaultBody", "defaultHead", "defaultEyeL", "defaultEyeR",
            "defaultJaw", "defaultUpperTeeth", "defaultLowerTeeth", "defaultScar",
            "defaultFootF", "defaultFootB", "defaultArmF", "amazonBody",
            "browFeature", "bruteJaw", "barbarianJaw",
            "goblinEarFeature", "leprachaunEarFeature"}

# Per-part display scale, applied about the part's own pivot (the runtime reads
# `scale` off each part; a missing entry means 1). This is the one place the rig
# deliberately departs from the sheet geometry: the Garden flower's petals read as a
# thin ring behind the head at native size, so both Flower zombies wear a bigger one.
PART_SCALE = {
    "sunflowerFeature": 1.2,
}

# ---------------------------------------------------------------------------
# Per-unit part additions/removals, keyed by catalog unitKey. `add` = extra parts;
# `headless` strips the head group (Headless family). Body/head/jaw/arm/foot
# overrides in `add` auto-replace their default via SLOT. Scale is per group.
# ---------------------------------------------------------------------------
FEATURE = {
    # Regular tiers
    "ZombieActorRegularTier1": [],
    "ZombieActorRegularTier2": ["cyborgFeature"],
    "ZombieActorRegularTier3": ["robotFeature"],
    "ZombieActorRegularTier4": ["robocopFeature", "robocopJaw"],
    "ZombieActorRegularTier5": ["zombotronFeature", "zombotronBody"],  # was wrongly robotFeature
    "ZombieActorRegularCrazy": ["cupidBody", "crazyEyeL", "crazyEyeR", "mustache", "beard"],
    # Regular crop mutants
    "ZombieActorRegularTier1Carrots": ["carrotHat"],
    "ZombieActorRegularTier1Tomatoes": ["tomatoHead"],
    "ZombieActorRegularTier1Onions": ["onionHead"],
    "ZombieActorRegularTier1Turnips": ["turnipArm"],
    "ZombieActorRegularTier1Potatoes": ["potatoHead"],
    "ZombieActorRegularTier1Coffee": ["coffeeHead"],
    "ZombieActorRegularTier2Celery": ["celeryArm"],
    "ZombieActorRegularTier2Broccoli": ["broccoliHat"],
    "ZombieActorRegularTier2Garlic": ["garlicHead"],
    "ZombieActorRegularTier2Cauliflower": ["cauliflowerHat"],
    "ZombieActorRegularTier2LimaBeans": ["limaBeanBody"],
    "ZombieActorRegularTier3VenusFlytrap": ["flytrapCollar"],
    "ZombieActorRegularTier3DragonFruit": ["dragonArm"],
    "ZombieActorRegularTier4Eyebiscus": ["eyebiscusHat"],
    "ZombieActorRegularTier4Heartichoke": ["heartichokeBody"],
    # Regular seasonal Tier5 (ground truth from initSprite: Jacko keeps the default
    # head — the jack-o'-lantern is a hat feature, not a head swap.)
    "ZombieActorRegular2Tier5": ["pumpkinBody", "pumpkinFootF", "pumpkinFootB", "pumpkinHatFeature"],
    "ZombieActorRegular3Tier5": ["reindeerBody", "reindeerFeature"],
    "ZombieActorRegular4Tier5": ["valentinesBody", "valentinesHatFeature"],
    # Female (girl body + a face feature)
    "ZombieActorGirlTier1": ["girlBody", "femaleFeature"],
    "ZombieActorGirlTier2": ["girlBody", "beautyFeature"],
    "ZombieActorGirlTier3": ["amazonBody", "amazonFeature"],
    "ZombieActorGirlTier4": ["girlBody", "locksFeature"],
    "ZombieActorGirlTier5": ["bellydancerBody", "bellydancerFeature"],
    # Small (scaled down). Ground truth: base ZombieActorSmall adds eyeBrowFeature to
    # every Small tier; Tier5 (leprechaun) replaces it with leprachaunBrowFeature.
    "ZombieActorSmallTier1": ["eyeBrowFeature"],
    "ZombieActorSmallTier2": ["eyeBrowFeature"],  # was wrongly gnomeFeature (that's Garden)
    "ZombieActorSmallTier3": ["eyeBrowFeature", "goblinEarFeature"],
    "ZombieActorSmallTier4": ["eyeBrowFeature", "goblinEarFeature", "impFeature"],
    "ZombieActorSmallTier5": ["leprachaunHatFeature", "leprachaunEarFeature", "leprachaunBrowFeature", "leprachaunJaw"],
    # Large (scaled up). Ground truth from -[ZombieActorLarge* initSprite] in the ZF2
    # binary: the base ZombieActorLarge adds browFeature to EVERY Large tier, then each
    # tier swaps its jaw and (T4/T5) adds a hat/hair. Earlier guesses (mustache/eyeBrow/
    # beard) were wrong — see tools/re extraction.
    "ZombieActorLargeTier1": ["browFeature", "bruteJaw"],
    "ZombieActorLargeTier2": ["browFeature", "bruteJaw"],
    "ZombieActorLargeTier3": ["browFeature", "barbarianJaw"],
    "ZombieActorLargeTier4": ["browFeature", "barbarianJaw", "barbarianHair"],
    "ZombieActorLargeTier5": ["browFeature", "vikingJaw", "vikingMustacheFeature", "vikingHatFeature"],
    "ZombieActorLarge2Tier5": ["scarecrowBody", "scarecrowHatFeature"],
    "ZombieActorLarge3Tier5": ["santaBody", "santaFootF", "santaFootB", "santaHatFeature"],
    # Headless (head group stripped; add themed head/collar where present)
    "ZombieActorHeadlessTier1": [],
    "ZombieActorHeadlessTier2": [],
    "ZombieActorHeadlessTier3": [],
    "ZombieActorHeadlessTier4": ["partyCollar"],
    "ZombieActorHeadlessTier5": ["skullHead"],
    "ZombieActorHeadless2Tier5": ["diverBody", "diverHead", "diverArmF", "diverArmB", "diverFootF", "diverFootB"],
    # Garden (ground truth from initSprite: Tier1 gnome; Tier4 bee w/o wings; Tier5
    # adds beeFeature under the wings.)
    "ZombieActorGardenTier1": ["gnomeFeature"],
    "ZombieActorGardenTier2": ["nerdFeature"],
    "ZombieActorGardenTier3": ["sunflowerFeature"],
    "ZombieActorGardenTier3GreenFlower": ["sunflowerFeature"],
    "ZombieActorGardenTier4": ["beeFeature", "beeButt"],
    "ZombieActorGardenTier5": ["beeFeature", "butterflyWings"],
    "ZombieActorGardenCupid": ["cupidBody", "cupidFeature", "cupidWings"],
    "ZombieActorGardenCupidPink": ["cupidBody", "cupidFeature", "cupidWings"],
}
# Headless family keeps a body but no default head. (Skull/Diver add their own head.)
HEADLESS = {"ZombieActorHeadlessTier1", "ZombieActorHeadlessTier2",
            "ZombieActorHeadlessTier3", "ZombieActorHeadlessTier4",
            "ZombieActorHeadlessTier5"}

# Themed heads whose art already contains a mouth (see compose). Note the Diver,
# ZombieActorHeadless2Tier5, is NOT in HEADLESS above — it is a second headless LINE
# whose helmet is the head — so this is what keeps the default mouth off its faceplate.
COMPLETE_HEADS = {"diverHead", "skullHead"}


def group_of(key):
    body = re.sub(r"^ZombieActor", "", key)
    for fam in ("Regular", "Girl", "Small", "Large", "Headless", "Garden"):
        if body.startswith(fam):
            return fam
    return "Regular"


def scale_of(key):
    # Exact whole-actor scale from -[ZombieActor<Group> initSprite] setScale: in the
    # ZF2R binary, with only the models that omit a head reduced by 15% for display.
    # Per-tier overrides the game sets on top of the group value:
    if key.startswith("ZombieActorGirlTier3"):      # Amazon body — scaled up
        return 1.10
    if key.startswith("ZombieActorHeadlessTier5"):  # Skull head — scaled down
        return 0.80
    if key in HEADLESS:                             # Tier 1-4 omit the head sprite
        return 0.765
    # Zcarecrow (Large2*) and Zanta (Large3*) are their OWN seasonal subclasses,
    # NOT the barbarian ZombieActorLarge family — they don't inherit its 1.15
    # scale-up. Like every other seasonal reskin (Jacko/Reindeer/Teddy), they're
    # regular-sized. group_of() lumps any "Large*" key into Large, so special-case
    # them back to the base scale here.
    if re.match(r"^ZombieActorLarge[2-9]", key):
        return 0.90
    g = group_of(key)
    return {
        "Regular": 0.90,
        "Small": 0.60,
        "Girl": 0.80,
        "Garden": 0.70,
        "Large": 1.15,     # barbarian/brute family; base 0.90 x the ~1.28 "large" ratio
        "Headless": 0.90,
    }.get(g, 0.90)


def head_group(part):
    """Animation group for a part: head (tilts), footF, footB, or root."""
    slot = SLOT.get(part)
    if slot in ("FootF",) or part == "defaultFootF":
        return "footF"
    if slot in ("FootB",) or part == "defaultFootB":
        return "footB"
    if part in HEAD_ADD or slot in HEAD_SLOTS or part in DEFAULT.values() and part.replace("default", "") in HEAD_SLOTS:
        return "head"
    return "root"


def compose(key, strip_mut=False):
    """Ordered set of part names for a unit (after slot replacement + drops).
    strip_mut drops crop-mutation parts BEFORE composition, so the base body keeps
    its default head/eyes (the mutation is re-added at runtime from the mask)."""
    slots = dict(DEFAULT)
    add = FEATURE.get(key, [])
    if strip_mut:
        add = [p for p in add if p not in MUT_PARTS]
    # Headless family: drop the DEFAULT head group first (so a themed head added
    # below — e.g. Skull Head's skullHead — survives).
    if key in HEADLESS:
        for s in ("Head", "EyeL", "EyeR", "Jaw", "UpperTeeth", "LowerTeeth", "Scar"):
            slots.pop(s, None)
    # Slot replacements from `add` (themed body/head/jaw/arm/foot).
    for p in add:
        s = SLOT.get(p)
        if s:
            slots[s] = p
    # A themed head (skull/diver/tomato/...) replaces the default face — drop eyes/scar.
    if any(SLOT.get(p) == "Head" for p in add):
        for s in ("EyeL", "EyeR", "Scar"):
            slots.pop(s, None)
    # ...and a head that is a COMPLETE face takes the mouth with it. The vegetable
    # heads deliberately do not: an Onionhead wears the onion AROUND its own jaw and
    # teeth, which is the whole reason head parts are re-layered rather than hidden.
    # The diving helmet is not one of those — its faceplate had a mouth and a set of
    # teeth floating on the glass. (Skull Head reaches the same result through the
    # HEADLESS branch above, which drops the whole default head group.)
    if any(p in COMPLETE_HEADS for p in add):
        for s in ("Jaw", "UpperTeeth", "LowerTeeth"):
            slots.pop(s, None)
    # A facial feature covers the eyes.
    if any(p in FACE_FEATURES for p in add):
        slots.pop("EyeL", None)
        slots.pop("EyeR", None)
    parts = list(slots.values())
    for p in add:
        if SLOT.get(p) is None and p not in parts:  # additive overlays
            parts.append(p)
    return parts


# Brightness above which a jaw pixel counts as one of the TEETH painted into its art.
# The skeleton jaw sits near 127 grey and its teeth are near-white, so the split is
# wide; a themed jaw with no teeth of its own simply yields no cluster and keeps the
# authored overlay position.
TEETH_LUMA = 200


def _bbox(atlas, layout, bright=False):
    """Pixel bounds of a frame's opaque (or, with `bright`, its near-white) pixels."""
    x, y = int(layout["x"]), int(layout["y"])
    w, h = int(round(layout["width"])), int(round(layout["height"]))
    px = atlas.crop((x, y, x + w, y + h)).load()
    xs, ys = [], []
    for iy in range(h):
        for ix in range(w):
            r, g, b, a = px[ix, iy]
            if a > 128 and (not bright or (r + g + b) / 3 > TEETH_LUMA):
                xs.append(ix)
                ys.append(iy)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def baked_teeth_box(atlas, layout):
    """Bounds of the teeth painted INTO a jaw sprite, in sprite pixels, or None.

    Every jaw in the sheet — default, brute, barbarian, leprachaun, robocop, viking —
    has teeth drawn into it, and `defaultLowerTeeth` is a white overlay meant to land on
    them: on the DEFAULT jaw the authored offsets put the two within a pixel of each
    other, which is what makes the pairing legible. The themed jaws are different sizes
    and shapes, so the shared overlay offset missed, leaving the jaw's own (body-tinted,
    therefore green) teeth showing beside the white ones. Measuring the art is how the
    overlay gets re-fitted per model without hand-tuning six offsets.
    """
    return _bbox(atlas, layout, bright=True)


def _fit_lower_teeth(parts, lay, atlas):
    """Fit this model's `defaultLowerTeeth` over its jaw's own painted teeth.

    The overlay is the one part drawn in true white (the runtime pins it — see
    zombiePartTint), while the jaw carries the body tint, so any baked tooth the overlay
    misses shows up as a second, GREEN set. Position alone is not enough: the themed
    jaws' teeth are up to 13% wider than the 24x7 overlay, so it is also grown to cover
    them. It is never SHRUNK — on the default and robocop jaws the overlay is already
    the larger of the two and shrinking it would change the face of every ordinary
    zombie to fix nothing.

    No-op for a model with no jaw or no lower teeth (the headless families, the named
    specials that bring their own face).
    """
    jaw = next((p for p in parts if p["file"].endswith("Jaw")), None)
    teeth = next((p for p in parts if p["file"] == "defaultLowerTeeth"), None)
    if not jaw or not teeth:
        return
    jaw_layout = lay(jaw["file"])
    baked = baked_teeth_box(atlas, jaw_layout)
    if not baked:
        return
    teeth_layout = lay(teeth["file"])
    ink = _bbox(atlas, teeth_layout)
    if not ink:
        return
    tw = int(round(teeth_layout["width"]))
    th = int(round(teeth_layout["height"]))

    scale = max(1.0, (baked[2] - baked[0]) / (ink[2] - ink[0]),
                (baked[3] - baked[1]) / (ink[3] - ink[1]))
    scale = round(scale + 0.005, 2)  # round UP to the pixel-hundredth, never under
    # Where the overlay's ink sits relative to the point it is anchored (and scaled)
    # about, so growing it keeps the ink centred on the jaw's teeth rather than drifting.
    ink_dx = (ink[0] + ink[2]) / 2 - teeth["ax"] * tw
    ink_dy = (ink[1] + ink[3]) / 2 - teeth["ay"] * th
    jaw_x = jaw["px"] - jaw["ax"] * int(round(jaw_layout["width"]))
    jaw_y = jaw["py"] - jaw["ay"] * int(round(jaw_layout["height"]))

    teeth["px"] = round(jaw_x + (baked[0] + baked[2]) / 2 - scale * ink_dx, 2)
    teeth["py"] = round(jaw_y + (baked[1] + baked[3]) / 2 - scale * ink_dy, 2)
    if scale != 1:
        teeth["scale"] = scale


def main():
    frames = json.load(open(SHEET_JSON, encoding="utf-8"))
    market = json.load(open(MARKET, encoding="utf-8"))["Entries"]
    color_of = {e["unitKey"]: e.get("color", [159, 255, 95])
                for e in market if e.get("actor") and "unitKey" in e}
    name_of = {e["unitKey"]: e.get("name", e["unitKey"])
               for e in market if e.get("actor") and "unitKey" in e}

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, "portrait"), exist_ok=True)
    # One atlas image for the whole set; runtime slices it.
    shutil.copy(os.path.join(APP, "ZombieSheet.png"), os.path.join(OUT, "ZombieSheet.png"))
    from PIL import Image
    atlas = Image.open(os.path.join(APP, "ZombieSheet.png")).convert("RGBA")

    def lay(p):
        return frames.get(p) or frames.get(p + ".png")

    def build(key, parts):
        """A model manifest (parts + neck + scale + color) from a part-name list."""
        # Head offset = whatever occupies the Head slot (for head-relative parts).
        head = (0, 0)
        for p in parts:
            if SLOT.get(p) == "Head" or p == "defaultHead":
                L = lay(p)
                head = (L["offsetX"], L["offsetY"])
        mp = []
        for p in parts:
            L = lay(p)
            grp = head_group(p)
            ox, oy = L["offsetX"], L["offsetY"]
            # Head-relative parts (features/eyes/jaw/hats/hair) get the head offset,
            # EXCEPT the head part itself.
            if grp == "head" and SLOT.get(p) != "Head" and p != "defaultHead":
                ox += head[0]
                oy += head[1]
            part = {
                "file": p, "group": grp,
                "px": ox, "py": -oy,
                "ax": L["pivotX"], "ay": 1 - L["pivotY"], "z": L.get("z", 0),
                "tint": p in TINTABLE,
            }
            if p in PART_SCALE:
                part["scale"] = PART_SCALE[p]
            mp.append(part)
        _fit_lower_teeth(mp, lay, atlas)
        mp.sort(key=lambda m: m["z"])
        return {
            "name": name_of.get(key, key),
            "neck": {"x": head[0], "y": -head[1]},
            "scale": scale_of(key),
            "color": color_of.get(key, [159, 255, 95]),
            "parts": mp,
        }

    used = set()
    models = {}       # runtime body models (crop-mutations STRIPPED, keeps default head)
    full_models = {}  # same, but WITH mutation parts — for portraits only
    missing = {}
    for key in FEATURE:
        full_parts = [p for p in compose(key) if lay(p)]
        base_parts = [p for p in compose(key, strip_mut=True) if lay(p)]
        miss = [p for p in compose(key) if not lay(p)]
        if miss:
            missing[key] = miss
        used.update(full_parts)
        full_models[key] = build(key, full_parts)   # portrait: with mutation art
        models[key] = build(key, base_parts)         # runtime: plain body + default head
        # Tier-4 variant: remap its shared stat bit to its own hair sprite on the field.
        if key in VARIANT_OVERRIDE:
            mutation, part = VARIANT_OVERRIDE[key]
            models[key]["mutationOverrides"] = {mutation: part}

    # ---- Colour class consistency ------------------------------------------
    # A zombie's body tint IS its colour class made visible: every Green zombie
    # shares one tint, every Blue another, and the Market/planting menu files them
    # under that class. Nine mutants disagreed with their own class, because their
    # tint is the AUTHENTIC ZF2 per-unit colour while the class comes from the
    # rarity band the zombie sits in here:
    #   * Celery/Broccoli/Garlic/Cauliflower/Lima Bean/Flytrap/Dragon Fruit were
    #     re-banded by tools/reforge_economy.py MUTANT_CLASS_REBALANCE when their
    #     unlock levels moved (read that table's comment first — the CLASS is
    #     deliberate and load-bearing, and must not be reverted to match the key).
    #   * Eyebiscus/Heartichoke were never re-banded; ZF2 simply shipped them as a
    #     green and a blue body under a tier-4 key.
    # Tester report: "Celery zombies are labeled as red despite having blue skin".
    # The fix is the tint, since the class decides ability tiers and the Black
    # Market gravestone gate. Each mutant takes the tint of the plain Regular
    # zombie in its band, so it looks like the class it is filed under.
    CLASS_COLOUR_BAND = {
        "ZombieActorRegularTier2Celery": 3,
        "ZombieActorRegularTier2Broccoli": 3,
        "ZombieActorRegularTier2Garlic": 3,
        "ZombieActorRegularTier2Cauliflower": 3,
        "ZombieActorRegularTier2LimaBeans": 4,
        "ZombieActorRegularTier3VenusFlytrap": 4,
        "ZombieActorRegularTier3DragonFruit": 4,
        "ZombieActorRegularTier4Eyebiscus": 4,
        "ZombieActorRegularTier4Heartichoke": 4,
    }
    for key, band in CLASS_COLOUR_BAND.items():
        band_color = models[f"ZombieActorRegularTier{band}"]["color"]
        for catalog in (models, full_models):
            if key in catalog:
                catalog[key]["color"] = list(band_color)

    # mutations.json: rig for each mutation, so the runtime can attach the part onto
    # any base body. Head-relative parts (hats) add the model's neck offset at
    # runtime; head-slot parts (onionHead) and root parts (arms/body/collar) use
    # their own offset. Bumped z keeps overlays above the base parts they cover.
    mutations = {}
    # Key-addressed entries, plus the Tier-4 variant parts keyed by NAME (looked up
    # via a model's mutationOverrides) so they can attach onto any base body.
    mut_targets = list(MUTATION_PART.items())
    mut_targets += [(part, part) for _, part in VARIANT_OVERRIDE.values()]
    for target, part in mut_targets:
        L = lay(part)
        if not L:
            print(f"WARNING: mutation part {part} ({target}) not in ZombieSheet")
            continue
        used.add(part)
        grp = head_group(part)
        head_rel = grp == "head" and SLOT.get(part) != "Head"
        mutations[target] = {
            "file": part, "group": grp, "headRel": head_rel,
            "ox": L["offsetX"], "oy": L["offsetY"],
            "ax": L["pivotX"], "ay": 1 - L["pivotY"], "z": L.get("z", 0),
        }
        if part in {"turnipArm", "celeryArm", "dragonArm"}:
            mutations[target]["replaces"] = "armF"
        elif part in {"limaBeanBody", "heartichokeBody"}:
            mutations[target]["replaces"] = "body"

    # frames.json for only the used parts (name -> pixel rect).
    used_frames = {}
    for p in sorted(used):
        L = lay(p)
        used_frames[p] = {"x": int(L["x"]), "y": int(L["y"]),
                          "w": int(round(L["width"])), "h": int(round(L["height"]))}
    # Trailing newline on every emitted file: without it a re-run shows up as a diff
    # against the committed copy even when nothing about the rig changed.
    def dump(obj, name):
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=1)
            fh.write("\n")

    # Stamp the table with the digest of the sheet copied above, so the runtime can
    # version the sheet URL (see tools/atlas_stamp.py / src/atlasVersion.ts).
    stamp_frames(used_frames, os.path.join(OUT, "ZombieSheet.png"))
    dump(used_frames, "frames.json")
    dump(models, "models.json")
    dump(mutations, "mutations.json")

    # Flat tinted portraits for menus (stat panel / market cards) — WITH mutations.
    _portraits(frames, full_models)

    print(f"models: {len(models)} zombie types, {len(used)} unique parts")
    if missing:
        print("WARNING: parts not found in ZombieSheet (skipped):")
        for k, v in missing.items():
            print(f"  {name_of.get(k, k)} ({k}): {v}")
    print("done")


def _portraits(frames, models):
    from PIL import Image
    atlas = Image.open(os.path.join(APP, "ZombieSheet.png")).convert("RGBA")

    def lay(p):
        return frames.get(p) or frames.get(p + ".png")

    def tint(im, rgb):
        r, g, b = rgb
        px = im.load()
        for y in range(im.height):
            for x in range(im.width):
                pr, pg, pb, pa = px[x, y]
                if pa:
                    px[x, y] = (pr * r // 255, pg * g // 255, pb * b // 255, pa)
        return im

    W, H, cx, cy = 160, 180, 80, 150
    for key, m in models.items():
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        head = (m["neck"]["x"], -m["neck"]["y"])
        for mp in m["parts"]:  # already z-sorted
            L = lay(mp["file"])
            if not L:
                continue
            x, y = int(L["x"]), int(L["y"])
            w, h = int(round(L["width"])), int(round(L["height"]))
            part = atlas.crop((x, y, x + w, y + h))
            # Same per-part scale the rig applies, so a menu portrait and the zombie
            # standing on the farm wear the same size flower. Grows about the pivot,
            # which the placement below already measures from.
            s = mp.get("scale", 1)
            if s != 1:
                w, h = max(1, int(round(w * s))), max(1, int(round(h * s)))
                part = part.resize((w, h), Image.LANCZOS)
            if mp["tint"]:
                # Default eyeballs are a soft light yellow in every species; the
                # rest of the grey skeleton inherits the zombie's body color.
                part = tint(part, (255, 255, 255) if mp["file"] in {"defaultEyeL", "defaultEyeR"}
                            else m["color"])
            ox, oy = L["offsetX"], L["offsetY"]
            if mp["group"] == "head" and mp["file"] != "defaultHead" and SLOT.get(mp["file"]) != "Head":
                ox += head[0]
                oy += head[1]
            px = round(cx + ox - L["pivotX"] * w)
            py = round(cy - oy - (1 - L["pivotY"]) * h)
            canvas.alpha_composite(part, (px, py))
        canvas.save(os.path.join(OUT, "portrait", key + ".png"))


if __name__ == "__main__":
    main()
