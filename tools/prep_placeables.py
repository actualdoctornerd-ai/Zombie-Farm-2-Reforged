#!/usr/bin/env python3
"""Build the placeable-object catalog (Phase 2/4) from source data.

Joins Market.json item entries to TileProperties.json (footprint tileWidth x
tileHeight, movable, rotations, pivot, atlas + frame) and writes:

  public/assets/placeables.json   [{key,name,category,cost,level,xp,brainsNeeded,
                                     tileW,tileH,movable,rotations,
                                     sprite,nativeW,nativeH,pivotX,pivotY}]
  public/assets/objects/<key>.png the in-world sprite

Three Market sub-categories become the Items sections in-game:
  - "tree"       -> Fruit Trees  (art from Trees1/Trees2/other atlases)
  - "decor"      -> Decors       (art from Decors*/tex* atlases; deduped by tile)
  - "special"    -> Functional   (no atlas art; uses the loose market icon PNG)

Entries are deduped by their `tile` (many market rows are color variants of one
sprite). Only entries whose art can be resolved are emitted.

Run from the repo root:  python zombiefarm/tools/prep_placeables.py
"""
import io
import json
import os
import plistlib
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
ROOT = os.path.dirname(PROJ)
APP = os.path.join(ROOT, "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app")
GAMEPLAY = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "gameplay")
OUT = os.path.join(PROJ, "public", "assets")
OBJDIR = os.path.join(OUT, "objects")

CTRL = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")
# Market subCategory -> our catalog category (also the Items section name mapping).
# Item -> catalog category (the Items section it lands in). The real Fruit Trees
# (Apple/Olive/Lemon/Orange) are `subCategory:"decor"` but `categoryID:16`; the
# `subCategory:"tree"` entries (Cypress/Oak/...) are DECORATIVE trees -> Decors.
FRUIT_TREE_CATID = 16
EPIC_REWARD_TILES = {
    "drgroundhogEvilDevice", "drgroundhogTricycle", "drgroundhogNutStash",
    "drgroundhogLabShelves", "drgroundhogLabTable", "drgroundhogEvilLab",
    "drgroundhogBurrow", "drgroundhogDistillery",
    "cactusTarget", "saddle", "rockingHorse", "boots", "banjo", "saloon", "hideout", "gunRack",
    "lilyJukebox", "mossyCouch", "toadStool", "muddyPool", "carnivorousPlants",
    "fireflies", "swamp_Cabin", "squirmyWorms",
    "snowFarmhand", "snowLumberjack", "snowOlMcDonnell", "snowZombie", "snowOwl",
    "antiHolidayIncinerator", "evilCarriage", "antiHolidayVault",
    "bedazzledGravestone", "fancyFountain", "crystalGazebo", "diamondCar",
    "evilMirror", "fashionableScarecrow", "jewelHome", "perfumeVat",
    "rockyRhinosBanner", "rockyRhinosCave", "rockyRhinosGong", "rockyRhinosSculpture",
    "generalLarvaelusBanner", "generalLarvaelusTeleporterA", "generalLarvaelusTeleporterB", "teleporter",
    "mysticalMambaBanner", "mysticalMambasWishMachineLeft", "mysticalMambasWishMachineRight",
}

# These quest objectives target separately named color variants that share one
# TileProperties key. Most same-tile Market rows are redundant recolors, but these
# must remain distinct catalog cards or the corresponding buy objectives cannot be
# completed. The first row keeps the source tile key; preserved variants receive a
# stable name-derived suffix below.
QUEST_VARIANT_KEYS = {
    "Violet Flower Bed": "flowerBedViolet",
    "Yellow Flower Bed": "flowerBedYellow",
}


def classify(e):
    if e.get("subCategory") == "special":
        return "functional"
    if e.get("categoryID") == FRUIT_TREE_CATID:
        return "tree"  # Fruit Trees
    if e.get("subCategory") in ("tree", "decor"):
        return "decor"
    return None


_plist_cache = {}


def load_plist(path):
    return plistlib.load(io.BytesIO(CTRL.sub(b"", open(path, "rb").read())))


def frames(fl):
    if fl not in _plist_cache:
        p = os.path.join(APP, fl)
        _plist_cache[fl] = load_plist(p)["frames"] if os.path.exists(p) else None
    return _plist_cache[fl]


_img_cache = {}


def image(png):
    from PIL import Image

    if png not in _img_cache:
        p = os.path.join(APP, png)
        _img_cache[png] = Image.open(p).convert("RGBA") if os.path.exists(p) else None
    return _img_cache[png]


def rect(s):
    n = list(map(int, re.findall(r"-?\d+", s)))
    return n[0], n[1], n[2], n[3]


def extract_from_atlas(fl, fn):
    """Cut frame `fn` out of atlas `fl`; returns a PIL image or None."""
    fr = frames(fl)
    if not fr or fn not in fr:
        return None
    atlas = image(fl.replace(".plist", ".png"))
    if atlas is None:
        return None
    f = fr[fn]
    x, y, w, h = rect(f["textureRect"])
    rotated = f.get("textureRotated", False)
    cw, ch = (h, w) if rotated else (w, h)
    im = atlas.crop((x, y, x + cw, y + ch))
    return im.rotate(-90, expand=True) if rotated else im


def extract_multiplepieces(tp):
    """Composite a `multiplePieces` object into one static sprite.

    These are paper-doll / rigged objects (Skeleton Couple, fireflies jar, ...)
    whose `frameName` is only one small piece (e.g. the couple's held hands), so
    the single-frame extract yields a tiny fragment. The whole sprite is the base
    frame plus every animationDictionary layer, each a trimmed frame placed by its
    spriteColorRect origin within a source canvas shared by all pieces. Layers that
    are a frame-sequence (animationFrames) contribute only their first frame.
    """
    fl = tp.get("frameList")
    fr = frames(fl)
    if not fr:
        return None
    atlas = image(fl.replace(".plist", ".png"))
    if atlas is None:
        return None

    # Ordered, deduped draw list: base first (bottom), then each layer on top.
    names = []
    base = tp.get("frameName")
    if base:
        names.append(base)
    for ad in tp.get("animationDictionaries", []):
        fn = ad.get("animationFrameName")
        if not fn:
            seq = ad.get("animationFrames")
            fn = seq[0] if seq else None
        if fn:
            names.append(fn)
    seen_fn = set()
    names = [n for n in names if n in fr and not (n in seen_fn or seen_fn.add(n))]
    if not names:
        return None

    from PIL import Image

    # Every piece is trimmed from a common untrimmed canvas (spriteSourceSize);
    # spriteColorRect origins are in that canvas's coordinate space.
    srcsizes = [list(map(int, re.findall(r"-?\d+", fr[n]["spriteSourceSize"]))) for n in names]
    sw = max(s[0] for s in srcsizes)
    sh = max(s[1] for s in srcsizes)
    canvas = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    for n in names:
        f = fr[n]
        x, y, w, h = rect(f["textureRect"])
        rotated = f.get("textureRotated", False)
        cw, ch = (h, w) if rotated else (w, h)
        im = atlas.crop((x, y, x + cw, y + ch))
        if rotated:
            im = im.rotate(-90, expand=True)
        cx, cy, _, _ = rect(f["spriteColorRect"])
        canvas.alpha_composite(im, (cx, cy))
    return canvas


def extract_layered_loose_sprites(tp):
    """Composite a loose base sprite with its authored child-node layers.

    Most decor lives in a TexturePacker atlas, but a few large objects use full
    standalone canvases. The Pet Pen is the important case: its back wall is a
    child node and its foreground fence is the base sprite. Both images share an
    authored canvas, so drawing children first and the base last preserves the
    source front/back composition.
    """
    base_name = tp.get("spriteSheet")
    children = tp.get("childNodes", [])
    if not base_name or not children:
        return None

    layers = []
    for child in children:
        child_name = child.get("spriteSheet")
        child_image = image(child_name) if child_name else None
        if child_image is None:
            return None
        layers.append(child_image)
    base = image(base_name)
    if base is None:
        return None
    layers.append(base)

    from PIL import Image

    width = max(layer.width for layer in layers)
    height = max(layer.height for layer in layers)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for layer in layers:
        canvas.alpha_composite(layer, (0, 0))
    return canvas


def main():
    from PIL import Image

    os.makedirs(OBJDIR, exist_ok=True)
    market = json.load(open(os.path.join(GAMEPLAY, "Market.json"), encoding="utf-8"))["Entries"]
    tileprops = json.load(open(os.path.join(GAMEPLAY, "TileProperties.json"), encoding="utf-8"))["Entries"]

    catalog = []
    seen = set()  # tile keys with at least one emitted market/reward object
    counts = {"tree": 0, "decor": 0, "functional": 0, "reward": 0}
    skipped = 0

    # Sort so the cheapest/earliest variant of a shared tile wins.
    items = [e for e in market if ((e.get("category") == "item" and classify(e)) or e.get("tile") in EPIC_REWARD_TILES)
             and (not e.get("dontShowInMarket") or e.get("tile") in EPIC_REWARD_TILES)]
    items.sort(key=lambda e: (e.get("level", 1), e.get("cost", 0)))

    for e in items:
        tile = e.get("tile")
        if not tile or (tile in seen and e.get("name") not in QUEST_VARIANT_KEYS):
            continue
        key = tile if tile not in seen else QUEST_VARIANT_KEYS[e["name"]]
        category = "reward" if tile in EPIC_REWARD_TILES else classify(e)
        tp = tileprops.get(tile, {})

        sprite_img = None
        growing_img = None  # fruit trees only: the pre-harvest (no fruit) frame
        if category == "tree":
            # Fruit tree: two states. The growing (no-fruit) frame is this tile's
            # frameName; the ripe (fruit-bearing) frame is the readyKey tile's.
            fl = tp.get("frameList")
            ready_tp = tileprops.get(tp.get("readyKey"), {})
            ready_fn = ready_tp.get("frameName") or tp.get("frameName")
            growing_fn = tp.get("frameName")
            if fl and ready_fn:
                sprite_img = extract_from_atlas(fl, ready_fn)  # main sprite = ripe
            if fl and growing_fn and growing_fn != ready_fn:
                growing_img = extract_from_atlas(fl, growing_fn)
        elif category in ("decor", "reward"):
            if tp.get("multiplePieces"):
                # frameName is only one fragment; assemble every piece.
                sprite_img = extract_multiplepieces(tp)
            elif tp.get("childNodes") and tp.get("spriteSheet"):
                # Large loose art can be split into back/front layers. The Pet
                # Pen uses this path (pettingzoo_back + pettingzoo_front).
                sprite_img = extract_layered_loose_sprites(tp)
            else:
                fl, fn = tp.get("frameList"), tp.get("frameName")
                if fl and fn:
                    sprite_img = extract_from_atlas(fl, fn)
            # Some ordinary decor and Epic rewards use loose sprites (occasionally
            # one rectangle within a shared sheet) rather than an atlas frame.
            # Without this fallback named quest items such as Gravestone, Heart
            # Gravestone, and the Cupid Statues silently disappear from the market.
            if sprite_img is None and tp.get("spriteSheet"):
                loose = image(tp["spriteSheet"])
                if loose is not None:
                    sprite_img = loose.copy()
                    fw, fh = tp.get("width"), tp.get("height")
                    fx, fy = int(tp.get("x") or 0), int(tp.get("y") or 0)
                    if fw and fh and (fx > 0 or fy > 0 or
                                      int(fw) < sprite_img.width or int(fh) < sprite_img.height):
                        sprite_img = sprite_img.crop((fx, fy, fx + int(fw), fy + int(fh)))
        else:  # functional: prefer the full-size in-world sprite from
            # TileProperties (a standalone tex10xx.png); the market icon is tiny
            # and would look pixelated placed on the farm.
            ss = tp.get("spriteSheet") or e.get("spriteSheet")
            if ss:
                sprite_img = image(ss)
                if sprite_img is not None:
                    sprite_img = sprite_img.copy()
                    # Some tiles are ONE frame of a SHARED sheet: the colored graves
                    # (Blue/Red/Silver) all live in tex2004.png as a 2x2 grid, so
                    # using the whole sheet renders all four. Crop to this tile's
                    # frame when it sits at a nonzero offset in the sheet.
                    fw, fh = tp.get("width"), tp.get("height")
                    fx, fy = int(tp.get("x") or 0), int(tp.get("y") or 0)
                    if fw and fh and (fx > 0 or fy > 0):
                        sprite_img = sprite_img.crop((fx, fy, fx + int(fw), fy + int(fh)))

        if sprite_img is None:
            skipped += 1
            continue

        out_name = f"{key}.png"
        sprite_img.save(os.path.join(OBJDIR, out_name))
        seen.add(tile)
        counts[category] += 1
        # Fruit-tree growing-state sprite (saved as <tile>_growing.png).
        growing_name = ""
        if growing_img is not None:
            growing_name = f"{tile}_growing.png"
            growing_img.save(os.path.join(OBJDIR, growing_name))
        # Storage sheds encode their capacity in the TileProperties toolTip.
        slots = 0
        m = re.search(r"(\d+)\s*slots", tp.get("toolTip", ""))
        if m:
            slots = int(m.group(1))
        catalog.append({
            "key": key,
            "name": e["name"],
            "category": category,
            "cost": e.get("cost", 0),
            "level": e.get("level", 1),
            "xp": e.get("xp", 0),
            "brainsNeeded": bool(e.get("brainsNeeded", False)),
            # Whole tiles only: the game reads these via integerValue (truncates),
            # so coerce any fractional footprint (e.g. coolerLarge 1.5) to an int.
            "tileW": max(1, int(tp.get("tileWidth", 1))),
            "tileH": max(1, int(tp.get("tileHeight", 1))),
            "movable": bool(tp.get("movable", True)),
            "rotations": tp.get("rotations", 1),
            "sprite": out_name,
            "nativeW": sprite_img.width,
            "nativeH": sprite_img.height,
            "pivotX": tp.get("pivotx", 0.5),
            "pivotY": tp.get("pivoty", 0.0),
            # simple functional effects the game can apply on placement
            "armyMax": e.get("increaseArmyMaxBy", 0),
            "storageSlots": slots,  # >0 for storage sheds (item capacity)
            # Pet Pen: tapping it opens the authoritative cosmetic collection.
            **({"petPen": True} if tile == "pettingZoo" else {}),
            # fruit trees: repeatable harvest (regrows fruit for gold)
            "growMs": (e.get("growTime", 0) or 0) * 1000 if category == "tree" else 0,
            "harvestValue": e.get("price", 0) if category == "tree" else 0,
            "growingSprite": growing_name,
            # Signature audio played when this decor is tapped on the farm. Omit
            # empty values so the generated catalog stays compact.
            **({"tapSound": tp.get("tapSoundEffect") or tp.get("soundID")}
               if tp.get("tapSoundEffect") or tp.get("soundID") else {}),
        })

    # ---- Raid-reward decorations (Phase 6) ----------------------------------
    # Loot drops that are NOT sold in the market but ARE placeable farm decor.
    # Each drop's `tile` points at a TileProperties entry that supplies the same
    # footprint + sprite market decor/functional items use, so we reuse the exact
    # extraction paths here. Emitted as category "reward": excluded from the buy
    # menu (ITEM_CAT has no "reward"), placed for free from the Received tab.
    drops = json.load(open(os.path.join(GAMEPLAY, "Drops.json"), encoding="utf-8"))
    reward_count = 0
    reward_skipped = []
    for name, info in drops.items():
        if info.get("dontAddToStorage"):
            continue  # currency (10 Brains / Bonus Gold) — never placeable
        tile = info.get("tile")
        if not tile or tile in seen:
            continue  # boosts have no tile; `seen` = tiles already emitted (market)
        tp = tileprops.get(tile)
        if not tp:
            continue

        sprite_img = None
        if tp.get("multiplePieces"):
            sprite_img = extract_multiplepieces(tp)
        elif tp.get("frameList") and tp.get("frameName"):
            sprite_img = extract_from_atlas(tp["frameList"], tp["frameName"])
        else:
            ss = tp.get("spriteSheet")
            if ss:
                sprite_img = image(ss)
                if sprite_img is not None:
                    sprite_img = sprite_img.copy()
                    # Some tiles are one sub-rect of a shared sheet (e.g. every
                    # faction banner lives in tex1046.png) — crop to this tile.
                    fw, fh = tp.get("width"), tp.get("height")
                    fx, fy = int(tp.get("x") or 0), int(tp.get("y") or 0)
                    if fw and fh and (fx > 0 or fy > 0):
                        sprite_img = sprite_img.crop((fx, fy, fx + int(fw), fy + int(fh)))

        if sprite_img is None:
            reward_skipped.append(name)
            continue

        out_name = f"{tile}.png"
        sprite_img.save(os.path.join(OBJDIR, out_name))
        seen.add(tile)
        reward_count += 1
        catalog.append({
            "key": tile,
            "name": name,  # drops are keyed by display name; Received matches on it
            "category": "reward",
            "cost": 0,
            "level": -1,  # always unlocked — it's an earned reward, not a purchase
            "xp": 0,
            "brainsNeeded": False,
            # Whole tiles only: the game reads these via integerValue (truncates),
            # so coerce any fractional footprint (e.g. coolerLarge 1.5) to an int.
            "tileW": max(1, int(tp.get("tileWidth", 1))),
            "tileH": max(1, int(tp.get("tileHeight", 1))),
            "movable": bool(tp.get("movable", True)),
            "rotations": tp.get("rotations", 1),
            "sprite": out_name,
            "nativeW": sprite_img.width,
            "nativeH": sprite_img.height,
            "pivotX": tp.get("pivotx", 0.5),
            "pivotY": tp.get("pivoty", 0.0),
            "armyMax": 0,
            "storageSlots": 0,
            "growMs": 0,
            "harvestValue": 0,
            "growingSprite": "",
            **({"tapSound": tp.get("tapSoundEffect") or tp.get("soundID")}
               if tp.get("tapSoundEffect") or tp.get("soundID") else {}),
        })

    # Design override (not in the source data): the Zombie Pot's FIRST purchase is
    # 500 gold (the shown price). Additional pots cost 30 brains — that dual pricing
    # is applied at placement (see main.ts tryPlaceObject).
    for c in catalog:
        if c["key"] == "zombieCombiner":
            c["cost"] = 500
            c["brainsNeeded"] = False

    catalog.sort(key=lambda c: (c["category"], c["level"], c["cost"]))
    with open(os.path.join(OUT, "placeables.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=1)
    print(f"placeables: {len(catalog)} objects -> {counts} "
          f"+ {reward_count} reward decor (skipped {skipped} market, "
          f"{len(reward_skipped)} reward w/o art)")
    if reward_skipped:
        print(f"  reward w/o art: {', '.join(reward_skipped)}")


if __name__ == "__main__":
    main()
