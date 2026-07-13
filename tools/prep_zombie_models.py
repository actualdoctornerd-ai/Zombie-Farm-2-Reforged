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

# Crop-mutation body parts, keyed by mutation BITMASK (see src/zombie/mutations.ts).
# These are STRIPPED from the runtime base body model and re-added at runtime from
# a unit's `mutation` mask, so a combined zombie shows exactly the mutations it
# carries — independent of which parent species it inherited. (Portraits keep the
# full art.)
BIT_PART = {
    1: "tomatoHead", 2: "onionHead", 4: "carrotHat", 8: "turnipArm",
    16: "potatoHead", 32: "coffeeHead", 64: "celeryArm", 128: "broccoliHat",
    256: "garlicHead", 512: "cauliflowerHat", 1024: "limaBeanBody",
    2048: "flytrapCollar", 4096: "dragonArm",
}
# Tier-4 variants SHARE a stat bit with a lower-tier mutation (Eyebiscus=Carrot bit 4,
# Heartichoke=Cauliflower bit 512) but have their OWN hair art. We emit a per-model
# `mutationOverrides` remap so the field render swaps the shared bit's part for the
# variant's true sprite; the stat bit itself is unchanged. Keyed by unitKey ->
# (bit, part-name). Their portraits already use the true art via the FEATURE map.
VARIANT_OVERRIDE = {
    "ZombieActorRegularTier4Eyebiscus": (4, "eyebiscusHat"),
    "ZombieActorRegularTier4Heartichoke": (512, "heartichokeBody"),
}
# Every mutation part name (incl. the Tier-4 variants + the generic mutationArm),
# stripped from runtime base models.
MUT_PARTS = set(BIT_PART.values()) | {"eyebiscusHat", "heartichokeBody", "mutationArm"}

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
TINTABLE = {"defaultArmB", "defaultBody", "defaultHead", "defaultEyeL", "defaultEyeR",
            "defaultJaw", "defaultUpperTeeth", "defaultLowerTeeth", "defaultScar",
            "defaultFootF", "defaultFootB", "defaultArmF", "amazonBody",
            "browFeature", "bruteJaw", "barbarianJaw"}

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


def group_of(key):
    body = re.sub(r"^ZombieActor", "", key)
    for fam in ("Regular", "Girl", "Small", "Large", "Headless", "Garden"):
        if body.startswith(fam):
            return fam
    return "Regular"


def scale_of(key):
    # Exact whole-actor scale from -[ZombieActor<Group> initSprite] setScale: in the
    # ZF2R binary (absolute; the runtime applies these directly, MODEL_BASE = 1.0).
    # Per-tier overrides the game sets on top of the group value:
    if key.startswith("ZombieActorGirlTier3"):      # Amazon body — scaled up
        return 1.10
    if key.startswith("ZombieActorHeadlessTier5"):  # Skull head — scaled down
        return 0.80
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
    # A facial feature covers the eyes.
    if any(p in FACE_FEATURES for p in add):
        slots.pop("EyeL", None)
        slots.pop("EyeR", None)
    parts = list(slots.values())
    for p in add:
        if SLOT.get(p) is None and p not in parts:  # additive overlays
            parts.append(p)
    return parts


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
            mp.append({
                "file": p, "group": grp,
                "px": ox, "py": -oy,
                "ax": L["pivotX"], "ay": 1 - L["pivotY"], "z": L.get("z", 0),
                "tint": p in TINTABLE,
            })
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
            bit, part = VARIANT_OVERRIDE[key]
            models[key]["mutationOverrides"] = {str(bit): part}

    # mutations.json: rig for each mutation BIT, so the runtime can attach the part
    # onto any base body. Head-relative parts (hats) add the model's neck offset at
    # runtime; head-slot parts (onionHead) and root parts (arms/body/collar) use
    # their own offset. Bumped z keeps overlays above the base parts they cover.
    mutations = {}
    # Bit-keyed entries, plus the Tier-4 variant parts keyed by NAME (looked up via a
    # model's mutationOverrides) so they can attach onto any base body at runtime.
    mut_targets = [(str(bit), part) for bit, part in BIT_PART.items()]
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

    # frames.json for only the used parts (name -> pixel rect).
    used_frames = {}
    for p in sorted(used):
        L = lay(p)
        used_frames[p] = {"x": int(L["x"]), "y": int(L["y"]),
                          "w": int(round(L["width"])), "h": int(round(L["height"]))}
    json.dump(used_frames, open(os.path.join(OUT, "frames.json"), "w"), indent=1)
    json.dump(models, open(os.path.join(OUT, "models.json"), "w"), indent=1)
    json.dump(mutations, open(os.path.join(OUT, "mutations.json"), "w"), indent=1)

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
            if mp["tint"]:
                part = tint(part, m["color"])
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
