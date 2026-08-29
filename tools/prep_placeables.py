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

Market rows that share a `tile` but differ in name+tint become recolor VARIANTS of
one base row (same art, own `color`); identical repeats collapse. Only entries whose
art can be resolved are emitted.

Run from the repo root:  python zombiefarm/tools/prep_placeables.py
"""
import hashlib
import io
import json
import os
import plistlib
import re

from reforge_economy import brain_price
import contributed_art
import memorial_statue

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

# ---- Decor themes (hand-authored, NOT derivable from source) ----------------
# Nothing in Market.json says which holiday a decor belongs to: only 4 rows carry an
# enableDate, and flagNeeded/pflag are progression flags for sheds and graves. ZF2
# gated events by server content push, so the labels have to be authored here.
#
# Each tile gets at most ONE label. Anything absent is `evergreen` and always on
# sale; a labelled tile is sold only while its label is on the market allow-list
# (src/decorThemes.ts). Six themed-but-not-calendar sets deliberately have NO label —
# Roman/Greek, dinosaur, space, underwater, fancy/tea and the ponds are ordinary
# catalog that happens to share a look, and they are level-gated like everything else.
#
# See docs/DECOR_RESTORATION_PLAN.md for the full table and its rationale.
DECOR_THEMES = {
    "christmas": """
        xmasCandle xmasTree sleigh giftBasket xmasFence xmasArch snowMan xmasGifts
        xmasGingerbreadHouse xmasWreath giantCandyCane greenGift redGift yellowGift
        teddyBear""",
    "winter": """
        snowFort snowBalls igloo iceSculpture snowCannon winterSnowWoman snowHedge_01
        logCabin""",
    "newYear": "newYearBallLeft newYearBallRight newYearBannerLeft newYearBannerRight",
    "lunarNewYear": """
        stoneLion urn redLantern pagoda riceDumpling lotusLantern bigDragonBoat
        riceDumplingPile luckPlant yellowSatchet blueSatchet redSatchet smallDragonBoat
        dragonStatue newYearTree""",
    "valentines": """
        cupidTopiary holidayBalloonRed holidayBalloonWhite holidayBalloonYellow
        holidayHeartTopiary holidayRoseBushWhite holidayRoseBushYellow holidayRoseBushRed
        cupidStatueA cupidStatueB heartGravestone heartHedge heartCandle heartFountain
        holidayChocolateFountain teddyValentine loveShack""",
    "easter": """
        chocolateBunnyA chocolateBunnyB eggTree monolithEgg giantPeep easterEggBlue
        easterEggGreen easterEggPink easterEggPurple easterEggWhite easterGrass peepPink
        peepYellow goldEgg bigEasterEggBlue bigEasterEggGreen bigEasterEggPink
        easterBasket eggBush eggLamp rockBunny""",
    "stPatricks": """
        stPatricksClover stPatricksPotOfGold stPatricksShamrock stPatricksIrishFlag
        stPatricksFountain""",
    "halloween": """
        hauntedHouse candelabra organ spookyStrawmanRight candleAltarDay festiveFence
        sugarSkull skeletonCouple boxoLantern""",
    "harvest": """
        patioBench appleBobbing patioTable treeAutumn1 treeAutumn2 treeAutumn3 mayflower
        pumpkin enormoPumpkin cornucopia""",
    "independence": """
        drinksCooler starTopiary bbqGrill libertySnareDrum libertyMonument
        barrelOfFireworks sculptureOfLiberty libertyBell""",
    "anniversary": """
        birthdayTimStatue birthdayBalloonsRight zombieGift birthdayCakeThirdYearRight""",
    "summer": """
        umbrellaYellow umbrellaOrange tikiHeadSmall tikiHeadLarge sandCastle
        lifeguardChair surfboardRed surfboardBlue beachBall pailAndShovel""",
    "pirate": """
        powderKeg cannon pirateCratePlain shipWheel rumBarrel rope pirateCrate gibbetCage
        pirateBarrel cannonBalls cursedChest islandRelic pirateSack pirateBag""",
}
THEME_OF_TILE = {
    tile: theme for theme, tiles in DECOR_THEMES.items() for tile in tiles.split()
}

# Unlock levels for the evergreen decor restored alongside the themed sets. 106 of
# the 110 restored rows carry no source level (the generator would default them to
# 1, dumping them all into the level-1 store), and holiday rows do not need one
# because their label is the gate. These 31 are the evergreen remainder.
#
# Seeded from the shipped catalog's own price curve — level ~= 9.72*log10(gold) - 12,
# fitted on the 90 gold decor/tree rows, r2 = 0.38 — then nudged toward the levels
# carrying the fewest unlocks, holding price order and level order in agreement.
# The 9 evergreen tiles that DO carry a source level keep it (the six Roman/Greek
# pieces at 5, pond 16, boulder 22, blueBox 25).
EVERGREEN_LEVELS = {
    "pond7": 13, "pond5": 14, "pond3": 16, "pond1": 17, "pond4": 17, "pond6": 18,
    "pond2": 19, "soilDivider": 19, "stoneDivider": 19, "dinosaurSkull": 19,
    "underwaterCoral": 21, "spaceCrater": 21,
    "spaceLunarLander": 22, "fancyCoatOfArms": 22, "fancyTeacup": 22,
    "dinosaurFootprint": 25, "monolithBusted": 25, "underwaterMermaid": 25,
    "dinosaurRaptor": 25, "spaceRocketShip": 25,
    "fancyUmbrellaTree": 26, "underwaterTreasure": 27, "dinosaurJeep": 27,
    "dinosaurFern": 28, "fancyTeakettle": 28,
    "underwaterShip": 29, "dinosaurTriceratops": 29,
    "fancyMustache": 30, "spaceMoon": 31, "fancyChair": 31,
    "redTractor": 34,
}

# Hand-set premium brain prices. These deliberately skip the brainflation retune —
# they are meant to read as expensive showpieces rather than land in the typical
# 1-5 brain band.
PREMIUM_BRAIN_PRICES = {
    "heartGravestone": 15,
    "cupidStatueA": 50,
    "cupidStatueB": 50,
}

# Market decors that Reforged awards through quests/events instead of selling.
# They keep their art but are never purchasable: cost 0, no level gate, no XP.
REWARD_ONLY_DECOR = {
    "rockBunny", "greenGift", "redGift", "yellowGift", "teddyBear", "loveShack",
}


def is_reward_only(tile):
    """True for a placeable Reforged only ever AWARDS — never sells.

    The source let you buy an Epic Boss prize with brains to skip the fight;
    Reforged does not (category "reward" is absent from the Market's tabs), so
    carrying the source's brain price gave those rows a sell-back value they were
    never paid for — selling a free prize minted 1,000-4,000 gold. Priced like every
    other earned decoration instead: cost 0, which also makes them unpurchasable
    server-side (planObjectBuy refuses cost <= 0).

    What they SELL for is decided separately, by the authored table in
    src/awardSellValue.ts (a quarter of the brain price for an Epic Boss prize), so
    do not give these rows a real `cost` to raise their sale value — that would put
    them back on the market. KEEP IN SYNC with server/src/objectCatalog.ts.
    """
    return tile in REWARD_ONLY_DECOR or tile in EPIC_REWARD_TILES

# Source `subCategory:"decor"` rows that Reforged treats as BUILDINGS, not scenery.
# A functional object is one-per-farm (client and server both derive the purchase
# limit from this category) and sits in the Market's Functional Items tab. The Pet
# Pen is the only one: it is a single roaming-pet enclosure, and owning several has
# no meaning — the pen's five slots are shared, not per-building.
FUNCTIONAL_OVERRIDE_TILES = {"pettingZoo"}

# ---- Objects the Rotate tool must not turn (design override, NOT source data) ----
# In isometric art a horizontal mirror IS a quarter turn, which is why Rotate is a flip.
# It stops being a turn the moment the art has WRITING baked into it: mirroring the Ice
# Cream Stand gives its sign as "MAERC ECI", which is what a player reported. There is no
# mechanical repair — un-mirroring the letters afterwards would need them re-skewed onto a
# plank now leaning the other way — so these simply do not rotate, and the tool says so.
#
# Reviewed the whole object set for baked lettering; this is all of it. Judge by TEXT, not
# by asymmetry: every raid banner is asymmetric and mirrors perfectly well, because its
# crest is a picture. See canMirrorObject in src/assets.ts.
NO_MIRROR_TILES = {
    "iceCreamStand",      # "ICE CREAM 5c" across the sign board
    "iceCreamTruck",      # "ICE CREAM" down the side panel
    "newYearBannerLeft",  # "HAPPY 2012" on the bunting
    "newYearBannerRight",
}

# ---- Mausoleum upgrade ladder (design override, NOT source data) ------------
# The source ships one buyable Mausoleum (mausoleum3) plus two key-fragment tiers
# that Reforged does not use. Reforged instead makes the placed Mausoleum
# upgradeable in place, exactly like the storage sheds: each tier costs brains and
# adds five zombie storage slots. Every tier reuses the base row (same art, same
# 4x4 footprint) and differs only in key/name/cost/zombieSlots.
#
# Prices are per STEP (see object.upgrade in server/src/v3/engine.ts). Every rung
# costs the SAME 4 brains — the ladder used to ramp 4/6/8/10 and stop, which both
# priced the late rungs out and left nothing above Mausoleum V. Only the base
# building is bought (8 brains, from the source row); the rest is a flat climb.
# KEEP IN SYNC with server/src/objectCatalog.ts (OBJECTS).
MAUSOLEUM_BASE_SLOTS = 15
MAUSOLEUM_STEP_COST = 4  # flat brain price of every upgrade rung
MAUSOLEUM_TIERS = [
    # key, market name, zombie storage slots (every rung costs MAUSOLEUM_STEP_COST)
    ("mausoleum4", "Mausoleum II", MAUSOLEUM_BASE_SLOTS + 5),
    ("mausoleum5", "Mausoleum III", MAUSOLEUM_BASE_SLOTS + 10),
    ("mausoleum6", "Mausoleum IV", MAUSOLEUM_BASE_SLOTS + 15),
    ("mausoleum7", "Mausoleum V", MAUSOLEUM_BASE_SLOTS + 20),
    ("mausoleum8", "Mausoleum VI", MAUSOLEUM_BASE_SLOTS + 25),
    ("mausoleum9", "Mausoleum VII", MAUSOLEUM_BASE_SLOTS + 30),
    ("mausoleum10", "Mausoleum VIII", MAUSOLEUM_BASE_SLOTS + 35),
    ("mausoleum11", "Mausoleum IX", MAUSOLEUM_BASE_SLOTS + 40),
    ("mausoleum12", "Mausoleum X", MAUSOLEUM_BASE_SLOTS + 45),
]

# ---- Extra storage-shed rungs (design override, NOT source data) -------------
# The source's shed ladder stops at storage08 (McDonnell's Barn, 64 slots), which a
# long-running farm outgrows with nothing left to spend gold on. These rungs continue
# the same ladder: +8 slots each, keeping the source's roughly x1.5 price step. Each
# clones the top source shed's row, so it reuses that art until it gets its own —
# only key/name/cost/xp/storageSlots differ. KEEP IN SYNC with
# server/src/objectCatalog.ts (OBJECTS + SHED_SLOTS).
EXTRA_SHED_BASE = "storage08"
EXTRA_SHED_TIERS = [
    # key, market name, gold cost, item storage slots
    ("storage09", "Zombie Warehouse", 525_000, 72),
]

# ---- Recolor variants --------------------------------------------------------
# 17 TileProperties keys carry several Market rows that differ ONLY by display name
# and tint: one Hedge sprite is sold as six colors, one crate as seven. The catalog
# used to keep just the first row of each, which threw away 43 buyable items.
#
# A variant is a full catalog row that reuses the base row's art and footprint and
# overrides name/color, so it costs no extra pixels — see emit_sprite and D1 in
# docs/DECOR_RESTORATION_PLAN.md.
COLOR_WORDS = {
    "pink", "blue", "red", "black", "white", "yellow", "violet",
    "green", "silver", "gold", "orange", "purple",
}

# Two variants shipped before this scheme existed, under hand-picked keys. Those
# keys are in live saves and in server/src/objectCatalog.ts, so they are pinned
# rather than regenerated.
LEGACY_VARIANT_KEYS = {
    "Violet Flower Bed": "flowerBedViolet",
    "Yellow Flower Bed": "flowerBedYellow",
}


def variant_key(tile, name, taken):
    """Stable catalog key for one recolor of `tile`.

    Source names lead with the color ("Pink Hedge", "White Flower Bed"), so that
    word is the suffix. A sibling whose name carries no color at all — the plain
    "Tent" next to the "Red Tent" that holds the base key — becomes `_plain`.
    """
    if name in LEGACY_VARIANT_KEYS:
        return LEGACY_VARIANT_KEYS[name]
    first = name.strip().split()[0].lower() if name.strip() else ""
    suffix = first if first in COLOR_WORDS else "plain"
    key = f"{tile}_{suffix}"
    # Nothing in the current data collides, but two same-colored siblings must not
    # silently overwrite each other if the source ever grows one.
    n = 2
    while key in taken:
        key = f"{tile}_{suffix}{n}"
        n += 1
    return key


def unlock_level(e, tile, reward_only):
    """Player level this row unlocks at.

    Most restored decor carries no source level. A themed row does not need one —
    its label decides whether it is on sale at all — so it stays at the source
    default. Evergreen rows without a source level take an authored one, or the
    whole set would land at level 1 at once (see EVERGREEN_LEVELS).
    """
    if reward_only:
        return -1
    source = e.get("level")
    if source is not None and source > 1:
        return source
    return EVERGREEN_LEVELS.get(tile, source if source is not None else 1)


def market_economics(e, key, tile, reward_only, brains_priced, category):
    """Price, level gate, currency and purchase XP for one Market row."""
    brains = brains_priced and not reward_only
    if reward_only:
        cost = 0
    elif brains:
        # Brain prices take the brainflation retune, except the few premium
        # showpieces priced by hand. See tools/reforge_economy.py.
        cost = PREMIUM_BRAIN_PRICES.get(key) or brain_price(
            e.get("cost", 0), key, strict=False)
    else:
        cost = e.get("cost", 0)
    return {
        "cost": cost,
        "level": unlock_level(e, tile, reward_only),
        # Fruit-tree rows omit `xp`, and some ordinary gold decor rows carry zero.
        # The binary's +[MarketDataManager xpFromItem:] awards those normal gold
        # purchases floor(cost / 100) XP. Preserve positive authored XP and the
        # informational source XP on brain purchases.
        "xp": (0 if reward_only
               else cost // 100 if category == "tree"
               else cost // 100 if not brains and e.get("xp", 0) <= 0
               else e.get("xp", 0)),
        "brainsNeeded": brains,
    }


def market_tint(e):
    """This row's sprite tint, or None when it is absent or the identity.

    The original game passes the Market RGB through
    `placeNewObjectTileWithKey:andFilename:andColor:` and applies it as a
    multiplicative cocos2d sprite tint. Much of the decor art is authored
    GREYSCALE and takes ALL of its colour from this value — hedge_01, crate,
    baloon, pen_01 and cemeteryFence_01 all have mean saturation 0 — so a row
    that loses its tint renders grey. White is the identity multiply, so those
    rows are omitted to keep the generated catalog compact.
    """
    color = e.get("color")
    if not isinstance(color, list) or len(color) != 3:
        return None
    return None if all(channel == 255 for channel in color) else color


_sprite_by_digest = {}


def emit_sprite(key, img):
    """Save `img` as <key>.png and return the filename it can be referenced by.

    Several tiles share one piece of art and are told apart ONLY by their Market
    tint: the five monoliths all draw tex1009.png. Writing a copy per key
    duplicates the bytes and buries the fact that colour, not art, distinguishes
    them — so a byte-identical sprite reuses the first file written instead.
    """
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = buf.getvalue()
    digest = hashlib.sha1(data).hexdigest()
    shared = _sprite_by_digest.get(digest)
    if shared:
        return shared
    out_name = f"{key}.png"
    with open(os.path.join(OBJDIR, out_name), "wb") as fh:
        fh.write(data)
    _sprite_by_digest[digest] = out_name
    return out_name


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


def pair(s):
    n = [float(v) for v in re.findall(r"-?\d+\.?\d*", s)]
    return n[0], n[1]


# ---- Flat tiles whose art is authored CENTRED on its own footprint -------------
# The seven pond pieces are one interchangeable set: six rims plus a fill, all 3x3,
# all drawn on the same 150x75 canvas, made to be laid edge to edge into a single
# body of water. Each one's water diamond IS that canvas, i.e. the footprint diamond
# (144x72) with 3px of bleed on every side so neighbours overlap instead of leaving a
# gap. That means the anchor is not a free parameter — it is fixed by the geometry,
# and every piece must use the SAME one or the rim steps where two pieces meet.
#
# The source pivots are hand-rounded to 2dp and disagree: pond5 0.36, pond2/pond7
# 0.35, the rest 0.34, and pond7 alone is 0.02 vertically where the rest are 0.03. In
# the original that slop was survivable because ponds are never turned there; here
# Rotate mirrors about the front tile's centre line (`1 - pivotx - 48/width`), which
# turns a 0.02 error into a 6px jump — the Pond 5 misalignment. So these pieces take
# the computed centred anchor instead of the authored one; see
# centered_flat_tile_fields. Roads are NOT in this set: a road bend's art is
# deliberately off-centre on its footprint (up to 5px vertically), so the same
# reasoning does not apply and their authored pivots stand.
CENTERED_FLAT_TILES = {"pond1", "pond2", "pond3", "pond4", "pond5", "pond6", "pond7"}
# The anchor may only be nudged by rounding-scale slop. A bigger correction means the
# tile does not belong in the set above and the art would teleport, so fail loudly.
CENTERED_ANCHOR_TOLERANCE_PX = 4.0


def centered_flat_tile_fields(tp, sprite_img):
    """Flat-tile anchor fields for art centred on its footprint diamond.

    The anchor is the point of the art that lands on the FRONT tile's own position —
    the bottom-left corner of that tile's 48x24 box (see flat_tile_fields). For a
    tileW x tileH block the footprint diamond is (tileW+tileH)*24 wide by
    (tileW+tileH)*12 tall, and that corner sits (tileW-1)*24 right of the diamond's
    west corner and exactly on its south corner. Centring art of size w x h on the
    diamond therefore puts the anchor at

        x = (tileW-1)*24 + (w - diamondW)/2      measured from the art's left edge
        y = (h - diamondH)/2                     measured UP from the art's bottom

    which for a pond piece is (51/150, 1.5/75) = (0.34, 0.02). 0.34 is also the fixed
    point of the mirror `1 - anchorX - 48/w`, so a turned piece lands exactly where an
    unturned one does — which is the whole point.
    """
    w, h = sprite_img.width, sprite_img.height
    tw = max(1, int(tp.get("tileWidth", 1)))
    th = max(1, int(tp.get("tileHeight", 1)))
    diamond_w, diamond_h = (tw + th) * 24, (tw + th) * 12
    ax = ((tw - 1) * 24 + (w - diamond_w) / 2) / w
    ay = (h - diamond_h) / (2 * h)
    authored = flat_tile_fields(None, tp, sprite_img)
    dx = abs(ax - authored["anchorX"]) * w
    dy = abs(ay - authored["anchorY"]) * h
    if max(dx, dy) > CENTERED_ANCHOR_TOLERANCE_PX:
        raise SystemExit(
            f"{tp.get('spriteSheet')}: centred anchor moves the art "
            f"{dx:.1f}x{dy:.1f}px, past the {CENTERED_ANCHOR_TOLERANCE_PX}px "
            "tolerance — its art is not centred on its footprint")
    return {"flatTile": True, "anchorX": round(ax, 6), "anchorY": round(ay, 6)}


def flat_tile_fields(tile, tp, sprite_img):
    """`{}`, or the flat-tile anchor fields — the cocos anchor of a flatTile's art,
    EXPRESSED AGAINST THE PNG WE SHIP.

    GROUND TRUTH `-[Tile anchorPoint]` / `-[Tile loadBaseSprite]`: a tile positions
    its node at the ground tile's own position and hangs the art off
    `(pivotx, pivoty)` — cocos anchor, y-up, defaulting to (0.38, 0). Ordinary
    objects survive being bottom-centered instead; flat road/pond art does not,
    because its pieces only meet at the seams if every piece uses its own pivot.

    An atlas frame is TRIMMED, and cocos applies the anchor to the UNtrimmed size
    then shifts the quad by `offset + (untrimmed - trimmed)/2`. We ship the trimmed
    crop, so fold both terms into one anchor against that crop.
    """
    if not tp.get("flatTile"):
        return {}
    # A hand-measured anchor outranks everything: it is someone saying they laid the
    # piece next to the one it has to meet and read the number off (see
    # ANCHOR_OVERRIDES). The centred rule below is a DERIVATION, and a derivation loses
    # to a measurement.
    if tile in CENTERED_FLAT_TILES and tile not in ANCHOR_OVERRIDES:
        return centered_flat_tile_fields(tp, sprite_img)
    return {"flatTile": True, **flat_tile_anchor(tp, sprite_img, tile=tile)}


def flat_tile_anchor(tp, sprite_img, flip_y=False, tile=None):
    """The anchor pair alone (see flat_tile_fields for the rule).

    `flip_y` is for a tile whose TileProperties row carries `flipY` — cocos mirrors
    the quad about the anchor's own horizontal line and negates the trim offset with
    it (`-[CCSprite setTextureRect:]` flips `_unflippedOffsetPositionFromCenter`). We
    bake the mirror into the PNG we ship, so only that negated offset has to be
    folded in here.
    """
    ax = float(tp.get("pivotx", 0.38))
    ay = float(tp.get("pivoty", 0.0))
    w, h = sprite_img.width, sprite_img.height
    w0, h0, offx, offy = w, h, 0.0, 0.0
    fr = frames(tp["frameList"]) if tp.get("frameList") else None
    f = fr.get(tp.get("frameName")) if fr else None
    if f and "spriteSourceSize" in f:
        w0, h0 = pair(f["spriteSourceSize"])
        offx, offy = pair(f.get("spriteOffset", "{0,0}"))
        offx += (w0 - w) / 2
        offy = (-offy if flip_y else offy) + (h0 - h) / 2
    over = ANCHOR_OVERRIDES.get(tile, {})
    return {"anchorX": round(over.get("anchorX", (ax * w0 - offx) / w), 6),
            "anchorY": round(over.get("anchorY", (ay * h0 - offy) / h), 6)}


# ---- Road bends: the four corners are four SPRITES, not one mirrored one --------
# GROUND TRUTH: `rotations: 3` appears on exactly six TileProperties entries, the two
# road-bend families, and each state is its own entry with its own frame and pivot:
#
#   roadBend_01 roadbend2.png            pivot .30/.17   corner E+S (apex north)
#   roadBend_03 roadbend2.png + flipY    pivot .31/.06   corner W+N (apex south)
#   roadBend_04 roadbend1.png            pivot .22/.12   corner E+N (apex west)
#
# and the same shape for cobblestoneRoadBend_01/_03/_04 (__stonebend1/2/3.png).
#
# That is the whole bug this table exists to fix. Turning a placed object here is a
# horizontal MIRROR, and in iso a mirror swaps the two grid axes — so it maps a bend's
# arms E<->S and W<->N, i.e. every corner onto ITSELF. Shipping one bend art and
# "rotating" it therefore never produced the other three corners: it redrew the same
# corner from a mirrored pivot, a few px out of line, which is what a road that will
# not meet its neighbour looks like.
#
# The fourth corner (W+S, apex east) is the one the source never authored — `rotations`
# is 3, not 4. It comes free by mirroring _04, whose arms E+N mirror to S+W, and it
# lands exactly (verified against the straights, see Field.roadTurns.test.ts). That
# extra state is a deliberate divergence: with three corners a road cannot close a
# loop, and the mirror is exact here because the piece is re-anchored by the binary's
# own `1 - pivotx - 48/w` rule rather than assumed symmetric.
#
# This table is STRUCTURE only — which art, in which order, and which state is a
# mirror. Where a state's art has to hang is a measurement, and every measurement in
# this file lives in ANCHOR_OVERRIDES below.
ROAD_TURNS = {
    "roadBend_01": [
        {"tile": "roadBend_01"},
        {"tile": "roadBend_03"},
        {"tile": "roadBend_04"},
        {"tile": "roadBend_04", "flip": True},
    ],
    "cobblestoneRoadBend_01": [
        {"tile": "cobblestoneRoadBend_01"},
        {"tile": "cobblestoneRoadBend_03"},
        {"tile": "cobblestoneRoadBend_04"},
        {"tile": "cobblestoneRoadBend_04", "flip": True},
    ],
}

# ---- Anchors that had to be measured rather than read -------------------------
# Authored in tools/tile_lab.html: lay the piece next to the one it has to meet, drag
# its art until the kerbs line up, and paste the block the tool prints. Keyed by TILE
# key, so an entry reaches both a def's own art and any rotation state that draws that
# tile. `anchorX`/`anchorY` replace the authored cocos pivot (already rebased onto the
# trimmed PNG we ship, see flat_tile_fields); `dc`/`dr` shift only where the ART hangs,
# in whole tiles, leaving the footprint the player places and blocks alone.
#
# Prefer the authored pivot. An entry here is a claim that the source's own number does
# not lay the piece where its neighbours are, so say what was measured and against what.
ANCHOR_OVERRIDES = {
    # The apex-south road bend of both families draws one whole tile north of its
    # footprint's front tile — 24px right, 10px up, exactly (HW, -HH). Measured against
    # a straight run on each arm, both families independently; no reading of the
    # authored pivot produces it (the stone one's pivotx is a bare 0.5).
    "roadBend_03": {"dr": -1},
    "cobblestoneRoadBend_03": {"dr": -1},

    # Pond rims, measured in the lab against their neighbours 2026-08-18. These four
    # OUTRANK the centred anchor CENTERED_FLAT_TILES derives for the pond set (0.34,
    # 0.02) — pond1, pond4 and pond7 still take it, so the seven no longer share one
    # anchor. Being tuned; expect these numbers to move.
    #
    # Know what that costs before trusting it: 0.34 is the fixed point of the mirror
    # `1 - pivotx - 48/w`, which is why the set was centred in the first place — it is
    # the only anchor at which a TURNED piece occupies the same pixels as an unturned
    # one, and the SE/NW rims are the SW/NE ones turned. Off it, a turned piece lands
    # 2*(0.34 - anchorX)*150 px away: pond6 6.3px, pond3 4.0px, pond2 3.3px, pond5
    # 1.2px. So these lay a better UNTURNED pond and a worse turned one.
    "pond2": {"anchorX": 0.329, "anchorY": -0.024},
    "pond3": {"anchorX": 0.326667, "anchorY": 0.04},
    "pond5": {"anchorX": 0.336, "anchorY": -0.036},
    "pond6": {"anchorX": 0.319, "anchorY": -0.024},
}


def turn_fields(tile, tileprops):
    """`{}`, or `turns`: the art each rotation state of this object draws.

    One catalog key keeps its identity through a turn — the shop sells one Road Bend
    and the server counts one — so the states live on the def and a placed object
    stores only its index. See ROAD_TURNS for what the states are and why.
    """
    states = ROAD_TURNS.get(tile)
    if not states:
        return {}
    out = []
    for st in states:
        tp = tileprops[st["tile"]]
        img = extract_from_atlas(tp["frameList"], tp["frameName"])
        if is_blank(img):
            raise SystemExit(f"{st['tile']}: rotation-state art is missing")
        flip_y = bool(tp.get("flipY"))
        if flip_y:
            from PIL import Image

            img = img.transpose(Image.FLIP_TOP_BOTTOM)
        img = unpremultiply(img)  # flat art butts against its neighbour; see unpremultiply
        hang = ANCHOR_OVERRIDES.get(st["tile"], {})
        out.append({
            "sprite": emit_sprite(st["tile"], img),
            "nativeW": img.width,
            "nativeH": img.height,
            **flat_tile_anchor(tp, img, flip_y, st["tile"]),
            **({"flip": True} if st.get("flip") else {}),
            **({"dc": hang["dc"]} if hang.get("dc") else {}),
            **({"dr": hang["dr"]} if hang.get("dr") else {}),
        })
    return {"turns": out}


# ---- Variants that need their own de-coloured sprite (authored, NOT source art) --
# A recolor family multiplies ONE sprite by each variant's tint, which assumes the
# base art is neutral — every other family (hedge, crate, fence, balloon) is authored
# greyscale. flowerbed.png is not: its petals are magenta and its TileProperties row
# is literally named "Red Flower Bed".
#
# Multiply can only darken, so no tint can turn those petals white and the White
# Flower Bed rendered pink. The source has exactly one flowerbed frame, so there is
# no white art to recover. Rather than neutralise the shared base — which would also
# repaint the Red, Violet and Yellow beds that look right today — the white variant
# alone gets its own sprite with the petals greyed out. Leaves are untouched; they
# are green in every variant of the original too.
NEUTRALIZED_VARIANT_SPRITES = {"flowerBed_white"}


def neutralize_petals(img):
    """Grey out the coloured (non-green) pixels so a tint can recolour them.

    A petal pixel is one whose red beats its green; leaves and their shading are
    the other way round. Value (max channel) is kept so highlights and shadows
    survive and only the hue is dropped.
    """
    out = img.copy()
    pixels = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pixels[x, y]
            if a and r > g:
                value = max(r, g, b)
                pixels[x, y] = (value, value, value, a)
    return out


def unpremultiply(img):
    """Divide out the alpha the source atlases baked into their colour channels.

    The ZF2R atlases are stored PREMULTIPLIED: a half-covered edge pixel of the pond
    water is (4,109,163,a=180), which is the opaque water (6,155,231) already scaled
    by 180/255. PixiJS defaults its image textures to `premultiply-alpha-on-upload`
    (TextureSource.defaultOptions), so it multiplies by alpha a SECOND time and every
    antialiased edge composites `rgb*a^2 + dst*(1-a)` where the renderer meant
    `rgb*a + dst*(1-a)`.

    On art that stands alone that only costs a faint dark halo. On flat art it is
    visible damage: pond pieces overlap by design, so each piece lays its darkened
    fringe over the neighbour's opaque water and the pond comes out with a dark grid
    of seams tracing the pieces. Undoing the bake makes the PNG straight-alpha, which
    is what Pixi already assumes, and abutting pieces blend water into water.
    """
    out = img.copy()
    pixels = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pixels[x, y]
            if 0 < a < 255:
                pixels[x, y] = (min(255, round(r * 255 / a)),
                                min(255, round(g * 255 / a)),
                                min(255, round(b * 255 / a)), a)
    return out


def is_blank(img):
    """True when every pixel is transparent — nothing would be drawn."""
    return img is None or img.getbbox() is None


def loose_sprite(tp, sheet=None):
    """Full-size in-world art for a tile that ships as a standalone tex*.png.

    Some tiles are ONE frame of a SHARED sheet — the coloured graves (Blue/Red/
    Silver) all live in tex2004.png as a 2x2 grid — so crop to this tile's own
    rect when it sits at a nonzero offset in the sheet.
    """
    ss = sheet or (tp or {}).get("spriteSheet")
    if not tp or not ss:
        return None
    img = image(ss)
    if img is None:
        return None
    img = img.copy()
    fw, fh = tp.get("width"), tp.get("height")
    fx, fy = int(tp.get("x") or 0), int(tp.get("y") or 0)
    if fw and fh and (fx > 0 or fy > 0):
        img = img.crop((fx, fy, fx + int(fw), fy + int(fh)))
    return img


# Functional objects whose working state changes what they look like on the farm.
# The source ships each state as its OWN TileProperties tile with the same
# footprint and ground point, differing only in art: the Zombie Pot is bare while
# idle, wears a clamped-down lid while a combine cooks, and sprouts the finished
# zombie's arm once it is done. They ride along on the one catalog row as
# alternate sprites (see `busySprite` / `readySprite` in assets.ts).
STATE_SPRITE_TILES = (("cooking", "busySprite"), ("done", "readySprite"))


def state_sprites(tileprops, tile):
    """{"busySprite": file, ...} for `tile`'s working-state art (may be empty)."""
    out = {}
    for suffix, field in STATE_SPRITE_TILES:
        img = loose_sprite(tileprops.get(f"{tile}_{suffix}"))
        if not is_blank(img):
            out[field] = emit_sprite(f"{tile}_{suffix}", img)
    return out


def extract_first_animated_frame(tp):
    """First frame with actual pixels from an animated tile's animation.

    Some animated decor rests on an EMPTY frame: both Worm Holes declare
    `frameName` wormhole*_00, which is a fully transparent 111x142 placeholder, and
    the visible art lives in the _01.._04 animation frames. Extracting the declared
    frame yields an invisible object — the two Worm Holes shipped as blank cards and
    blank farm tiles because of exactly this.
    """
    for anim in tp.get("animationDictionaries", []) or []:
        fl = anim.get("animationFrameList") or tp.get("frameList")
        names = anim.get("animationFrames") or []
        single = anim.get("animationFrameName")
        if single:
            names = [single, *names]
        for fn in names:
            frame = extract_from_atlas(fl, fn)
            if not is_blank(frame):
                return frame
    return None


# Tiles whose ANIMATION carries the object and whose declared `frameName` is only
# the part that stands still.
#
# The Worm Holes (handled by extract_first_animated_frame above) rest on a fully BLANK
# frame, which is easy to spot. The Solar System is the harder shape: frame
# solarsystem_00 is a real drawing — the little grey plinth — and every planet and the
# sun live in the 12 animation frames orbiting above it. So the extract succeeded, the
# object shipped, and it shipped as a bare pedestal ("Solar System decor is not showing
# the planets"). Measured against the source: its animation covers 11.7x the area of
# its base frame, where the next-widest animated tile is 3.0x and every other one has
# its subject in the base frame already — this is the only tile of its kind.
#
# The Pixel Campfire is the same shape at raid-reward scale: pixel_campfire_base.png is
# the crossed logs alone and all three flame frames live in the animation, so it shipped
# as an unlit fire pit ("Pixel campfire only shows the base"). Its area ratio is a mild
# 1.5x — the subject-in-the-base test above does not catch it — but the missing piece is
# the entire point of the object, and lighting.ts already carves a warm light out of the
# night for it, which only made the unlit logs read as a bug.
#
# The reimplementation draws placeables as single static sprites, so the fix is to bake
# the orbit's FIRST frame over the plinth, exactly as extract_multiplepieces bakes a
# rigged object's layers. Frame 01 is also the widest spread of the twelve and the only
# one the source itself starts on; the campfire's flame frames likewise start at fr00.
# The Mechanical Egg and the Mechanical Bull are the MOTION-PATH members of the same
# family, and were the same bug: the Egg's `frameName` is its bottom half, with the
# lid that lifts off it living in the animation, and the Bull's is the little plinth
# under a bull whose body, head and tail are all animated parts. So the Egg shipped
# as a half egg and the Bull as an empty stand. Baking each part's home position over
# the base fixes the market card and the placed still alike; the parts are then taken
# back out of the art the object DRAWS (see `residual` in build_animation) so nothing
# is left behind when they move.
ANIMATION_OVER_BASE = {"spaceSolarSystem", "pixelCampfire", "goldEgg", "mechanicalBull"}


def extract_animated_over_base(tp):
    """Base frame + the first frame of each animation, cropped around the base.

    The crop is the fiddly half. A placed object is BOTTOM-CENTERED on its footprint
    (Field.fitObjectSprite anchors at 0.5, 1), so whatever this returns has its bottom
    centre pinned to the tile. Returning the composite's own bounds would pin the
    ORBIT's centre there and hang the plinth off to one side and up in the air. Instead
    the result keeps the BASE frame's bottom edge as its own bottom edge and is padded
    symmetrically about the base frame's centre line, so the plinth lands exactly where
    it lands today and the planets simply extend above and around it.
    """
    fl = tp.get("frameList")
    fr = frames(fl)
    base_name = tp.get("frameName")
    if not fr or base_name not in fr:
        return None
    atlas = image(fl.replace(".plist", ".png"))
    if atlas is None:
        return None

    from PIL import Image

    names = [base_name]
    for ad in tp.get("animationDictionaries", []) or []:
        seq = ad.get("animationFrames") or []
        first = ad.get("animationFrameName") or (seq[0] if seq else None)
        if first and first in fr and first not in names:
            names.append(first)
    if len(names) < 2:
        return None

    # Every frame is trimmed out of one shared untrimmed canvas; spriteColorRect is
    # its origin in that canvas, which is what makes the pieces line up.
    sizes = [list(map(int, re.findall(r"-?\d+", fr[n]["spriteSourceSize"]))) for n in names]
    canvas = Image.new("RGBA", (max(s[0] for s in sizes), max(s[1] for s in sizes)), (0, 0, 0, 0))
    for n in names:
        f = fr[n]
        x, y, w, h = rect(f["textureRect"])
        rotated = f.get("textureRotated", False)
        cw, ch = (h, w) if rotated else (w, h)
        piece = atlas.crop((x, y, x + cw, y + ch))
        if rotated:
            piece = piece.rotate(-90, expand=True)
        cx, cy, _, _ = rect(f["spriteColorRect"])
        canvas.alpha_composite(piece, (cx, cy))

    content = canvas.getbbox()
    if not content:
        return None
    bx, by, bw, bh = rect(fr[base_name]["spriteColorRect"])
    centre = bx + bw / 2
    bottom = by + bh
    half = max(centre - content[0], content[2] - centre)
    left = int(round(centre - half))
    right = int(round(centre + half))
    # Anything dipping below the base's ground line would be cut off by this crop.
    # Frame 01 of the only tile that uses this does not; refuse rather than silently
    # clip half a planet off a tile added here later.
    if content[3] > bottom:
        raise ValueError(
            f"{tp.get('name')}: animation frame draws {content[3] - bottom}px below the "
            f"base frame's ground line, which this crop would clip"
        )
    return canvas.crop((left, content[1], right, bottom))


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


def extract_child_layer(tp):
    """A tile's authored BACK layer: its `childNodes` composited on their own.

    A childNode is a second sprite the source draws at a DEEPER depth than the tile's
    base art — the Pet Pen is the only tile that has one: `pettingzoo_back.png` at
    depth 15 behind `pettingzoo_front.png` at depth 0. The two must stay separate
    images, never flattened together, because pets and characters stand BETWEEN the
    far and near walls; see Field.fitObjectSprite. Both layers are authored on the
    same canvas, so the exported back layer aligns with the base sprite pixel for
    pixel. Returns None when the tile has no child nodes (or their art is missing).
    """
    children = tp.get("childNodes", [])
    if not tp.get("spriteSheet") or not children:
        return None
    layers = []
    for child in children:
        child_name = child.get("spriteSheet")
        child_image = image(child_name) if child_name else None
        if child_image is None:
            return None
        layers.append(child_image)

    from PIL import Image

    width = max(layer.width for layer in layers)
    height = max(layer.height for layer in layers)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for layer in layers:
        canvas.alpha_composite(layer, (0, 0))
    return canvas


# ---- Animated decor (flipbook) ----------------------------------------------
# 44 TileProperties tiles carry `animationDictionaries`, the source's per-tile
# animation. Two shapes share that one field: a FLIPBOOK (`animationFrames`, a
# frame list cycled in place) and a MOTION PATH (one named part walked along a
# `moveOffsets` script). Only the flipbook is built here; the six motion-path
# tiles (fireflies, Mechanical Egg, Ice Cream Truck, Mechanical Bull, Satellite
# Dish, Skeleton Couple) still ship as stills.
#
# GROUND TRUTH: `animationSpeed` is the WHOLE LOOP's duration in seconds, not a
# per-frame delay. The Water Mill settles it — 29 frames at 2.416 is 83.3 ms a
# frame, a 0.4 s blink held open for 2 s, where the per-frame reading gives a
# 70-second blink. Six more tiles land on exactly frames/12 (Brainata 21/1.75,
# Wind Sculpture 13/1.083, Box o' Lantern 12/1.0, Water Otter 8/0.67): the art
# was drawn at 12 fps and the loop's length written down.
#
# A layer's frames and the tile's own base frame are trimmed out of ONE shared
# untrimmed canvas (`spriteSourceSize`), which is what lines them up: for 25 of
# the 26 tiles built here that canvas is identical for base and animation. The
# Tiki Torch is the exception that pins the general rule (torch 25x87, flame
# 25x112) — cocos anchors both sprites on the tile's one ground point, so
# canvases align on their BOTTOM edge and horizontal centre, which is what puts
# the flame above the torch head instead of through the middle of it.
ANIM_SHEET_MAX_W = 2048  # cells wrap into rows rather than exceed this


def anim_layers(tp):
    """The tile's FLIPBOOK layers as [(dict, [frame names])] — motion-path layers
    (`animationFrameName` + `moveOffsets`, no frame list) are left out."""
    return [(ad, [n for n in ad["animationFrames"] if n != "playSound"])
            for ad in tp.get("animationDictionaries", []) or []
            if ad.get("animationFrames")]


_frame_index = {}


def _find_frame_list(fn):
    """Which atlas actually holds frame `fn`.

    The Satellite Dish needs this: its twinkle layer names `tex1082.plist`, and
    `seti_twinkle.png` is in tex1083. The tile has therefore been declaring a frame
    that does not exist for as long as the game has shipped. Rather than hard-code
    the one fix, fall back to an index over every atlas in the bundle — a mis-named
    frame list is a source typo, not a missing asset.
    """
    if not _frame_index:
        for name in sorted(os.listdir(APP)):
            if not name.endswith(".plist"):
                continue
            try:
                fr = frames(name)
            except Exception:
                continue
            for key in fr or ():
                _frame_index.setdefault(key, name)
    return _frame_index.get(fn)


def _placed(fl, fn):
    """(image, colorRect, untrimmed canvas size) for one atlas frame, or None."""
    fr = frames(fl)
    if not fr or fn not in fr:
        fl = _find_frame_list(fn)
        fr = frames(fl) if fl else None
    if not fr or fn not in fr:
        return None
    im = extract_from_atlas(fl, fn)
    if im is None:
        return None
    f = fr[fn]
    src = tuple(int(v) for v in re.findall(r"-?\d+", f["spriteSourceSize"])[:2])
    return im, rect(f["spriteColorRect"]), src


# ---- Motion-path decor -------------------------------------------------------
# The other shape an `animationDictionaries` layer takes: ONE named part walked
# along a script instead of a frame list cycled in place. Six tiles use it — the
# Mechanical Egg's lid, the Ice Cream Truck's drip, the Mechanical Bull's buck, the
# Satellite Dish's twinkle, the three fireflies in Bully Frog's jar, and the
# Skeleton Couple, which is a 21-part paper doll built entirely this way.
#
# The scripts are `_`-separated steps of `head:seconds`:
#   {x,y}      move (see the axis note below)      d      hold this long
#   playSound  fire soundID here (zero length)     1.2    scale to this (scaleSequence)
#
# GROUND TRUTH on the y axis, which the two move keys do NOT share:
#   `moveOffsets` is a cocos MoveBy, so its y points UP. The Mechanical Egg settles
#   it — its lid runs `{0,32}` slowly, holds, then `{0,-32}` in 50ms with a thunk,
#   which is a lid lifting and slamming shut. Read the other way the lid sinks INTO
#   the egg it is drawn over.
#   `moveToOffsets` is authored in IMAGE coordinates, y DOWN. The Ice Cream Truck
#   settles that one: its drip runs 112 -> 115 -> 129 -> 179 in 0.7s, 0.15s, 0.15s,
#   which read downward is a drip accelerating off the truck under gravity, and read
#   upward is a drip accelerating into the sky.
#
# Both are converted here into the same thing — keyframed OFFSETS from the part's
# home position, in screen pixels — so the runtime only ever interpolates and adds.


def _script(spec):
    """[(head, seconds)] for one `_`-separated move/scale script."""
    out = []
    for token in (spec or "").split("_"):
        if not token:
            continue
        head, _, tail = token.rpartition(":")
        out.append((head, float(tail or 0)))
    return out


def _move_track(spec, absolute, home, sound):
    """(total ms, [[t, dx, dy]], cue ms) for a move script, as offsets from `home`.

    The first key repeats the script's LAST value rather than starting at zero: the
    source repeats the whole sequence for ever, so the move back to the start is a
    step of the animation (the truck's drip springs back up to the nozzle in 10ms),
    not a jump between loops.
    """
    def walk(start):
        x, y, t, keys, cue = start[0], start[1], 0.0, [], None
        for head, secs in _script(spec):
            if head == "playSound":
                cue = round(t * 1000)
                continue
            if head != "d":
                a, b = (float(v) for v in re.findall(r"-?\d+\.?\d*", head))
                # A relative step is a cocos delta (y up); an absolute one is an
                # image-space point, so it becomes an offset from home directly.
                x, y = (a - home[0], b - home[1]) if absolute else (x + a, y - b)
            t += secs
            keys.append([round(t * 1000), round(x, 2), round(y, 2)])
        return x, y, t, keys, cue

    end = walk((0.0, 0.0))
    x, y, t, keys, cue = walk((end[0], end[1]))
    keys.insert(0, [0, round(end[0], 2), round(end[1], 2)])
    return round(t * 1000), keys, (cue if sound else None)


def _scale_track(spec):
    """(total ms, [[t, scale]]) for a scaleSequence, seeded the same way."""
    def walk(start):
        s, t, keys = start, 0.0, []
        for head, secs in _script(spec):
            if head != "d":
                s = float(head)
            t += secs
            keys.append([round(t * 1000), s])
        return s, t, keys

    end = walk(1.0)[0]
    s, t, keys = walk(end)
    keys.insert(0, [0, end])
    return round(t * 1000), keys


def motion_layers(tp):
    """The tile's MOTION-PATH layers: every dictionary that names one part rather
    than a frame list. A layer with neither a script nor a scale is still one — the
    Skeleton Couple's two feet stand still inside a doll that does not."""
    return [ad for ad in tp.get("animationDictionaries", []) or []
            if not ad.get("animationFrames") and ad.get("animationFrameName")]


def build_animation(tile, tp, sprite_img):
    """({anim fields}, [(filename, sheet image)]) for an animated tile, else (None, []).

    Every cell is the whole object as it looks at that step, drawn on ONE canvas
    shared by the layers. That canvas keeps the still sprite's ground line and
    centre line and only grows upward and sideways, so swapping a cell in for the
    still leaves a placed object standing exactly where it stands today — no
    per-frame offset to mirror, no pivot to re-derive, and cell 0 is simply what
    the object looks like at rest. Layer 0 carries the base art with it (the fire
    ON the fireplace); any further layer is drawn over the object as its own
    sprite, because two layers can run at different speeds (Skunkarella's
    Fountain: chocolate 0.35 s, sparkle 0.5 s) and folding those into one strip
    would take a 3.5-second, 280-cell timeline.
    """
    layers = anim_layers(tp)
    moving = motion_layers(tp)
    if not layers and not moving:
        return None, []

    from PIL import Image

    base_fl, base_fn = tp.get("frameList"), tp.get("frameName")
    base = _placed(base_fl, base_fn) if base_fl and base_fn else None
    if base and is_blank(base[0]):
        base = None  # both Worm Holes rest on a transparent placeholder frame

    seqs = []  # per flipbook layer, [(image, colorRect, canvas)] in frame order
    for ad, names in layers:
        got = [_placed(ad.get("animationFrameList") or base_fl, n) for n in names]
        if any(g is None for g in got):
            return None, []
        seqs.append(got)
    # A motion layer is ONE part. Skip a layer whose art is missing rather than
    # dropping the whole tile: only the Satellite Dish's twinkle is at risk, and a
    # dish that does not sparkle still beats a dish that does not ship.
    moving = [(ad, _placed(ad.get("animationFrameList") or base_fl,
                           ad["animationFrameName"])) for ad in moving]
    moving = [(ad, p) for ad, p in moving if p and not is_blank(p[0])]
    # A part placed by moveToOffsets carries its own tiny canvas and is positioned
    # by the script, so it must stay out of the still/cell geometry below.
    anchored = [p for ad, p in moving if not ad.get("moveToOffsets")]

    every = ([base] if base else []) + [f for s in seqs for f in s] + anchored
    cw = max(p[2][0] for p in every)
    ch = max(p[2][1] for p in every)

    def put(p):  # bottom + centre alignment, see the Tiki Torch note above
        return p[1][0] + (cw - p[2][0]) // 2, p[1][1] + (ch - p[2][1])

    def box(p):
        px, py = put(p)
        return px, py, px + p[1][2], py + p[1][3]

    def bounds(ps):
        bs = [box(p) for p in ps]
        return (min(b[0] for b in bs), min(b[1] for b in bs),
                max(b[2] for b in bs), max(b[3] for b in bs))

    u = bounds(every)

    # Where today's still sits on that canvas. Four extraction paths in main()
    # produce it, so four rules find it again; the assert is what keeps the two
    # sets in step if either side is ever edited.
    if tp.get("multiplePieces"):
        still = (0, 0, cw, ch)  # extract_multiplepieces returns the whole canvas
    elif tile in ANIMATION_OVER_BASE:
        # main() bakes frame 0 of each layer over the base, then crops that
        # symmetrically about the base's centre line, keeping its ground line.
        content = bounds([base] + [s[0] for s in seqs] + anchored)
        bx0, _, bx1, by1 = box(base)
        mid = (bx0 + bx1) / 2
        half = max(mid - content[0], content[2] - mid)
        lo, hi = int(round(mid - half)), int(round(mid + half))
        still = (lo, content[1], hi - lo, by1 - content[1])
    elif base:
        b = box(base)
        still = (b[0], b[1], b[2] - b[0], b[3] - b[1])
    else:
        b = box(next(f for s in seqs for f in s if not is_blank(f[0])))
        still = (b[0], b[1], b[2] - b[0], b[3] - b[1])
    if not layers:  # motion only: there are no cells, so the still IS the canvas
        u = (still[0], still[1], still[0] + still[2], still[1] + still[3])
    assert (still[2], still[3]) == sprite_img.size, (
        f"{tile}: the animation canvas puts the still at {still[2]}x{still[3]}, "
        f"but {sprite_img.width}x{sprite_img.height} shipped")

    # The cell: the still's centre line, grown to hold every frame. Symmetric about
    # that centre on purpose — a mirrored object reflects about it, so a cell that
    # is symmetric needs no horizontal offset and none to mirror. A frame that dips
    # BELOW the still's ground line (a Worm Hole's swirl, by 4px) drops the cell's
    # floor and is paid for with `dy` rather than clipped off.
    mid = still[0] + still[2] / 2
    ground = still[1] + still[3]
    bottom = max(u[3], ground)
    top = min(u[1], still[1])
    half = max(mid - min(u[0], still[0]), max(u[2], still[0] + still[2]) - mid)
    left, right = int(round(mid - half)), int(round(mid + half))

    def cell(pieces):
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        for p in pieces:
            canvas.alpha_composite(p[0], put(p))
        return canvas.crop((left, top, right, bottom))

    out, sheets = [], []
    for i, ((ad, _), seq) in enumerate(zip(layers, seqs)):
        # Layer 0 draws over the base art; `frameBehind` puts it under instead
        # (the Parrot's wings), and `animateBaseSprite` frames REPLACE the still,
        # so the base drops out of the stack entirely.
        with_base = i == 0 and base is not None and not ad.get("animateBaseSprite")
        cells = [cell([f, base] if with_base and ad.get("frameBehind") else
                      [base, f] if with_base else [f]) for f in seq]
        cols = max(1, min(len(cells), ANIM_SHEET_MAX_W // max(1, cells[0].width)))
        rows = -(-len(cells) // cols)
        sheet = Image.new("RGBA", (cols * cells[0].width, rows * cells[0].height),
                          (0, 0, 0, 0))
        for n, c in enumerate(cells):
            sheet.alpha_composite(c, ((n % cols) * c.width, (n // cols) * c.height))
        name = f"{tile}_anim{i}.png"
        sheets.append((name, sheet))
        raw = ad["animationFrames"]
        marker = raw.index("playSound") if "playSound" in raw else -1
        out.append({
            "sheet": name,
            "n": len(cells),
            "cols": cols,
            # animationSpeed is the whole loop; per-frame is what the runtime wants.
            "ms": int(round((ad.get("animationSpeed") or 0) * 1000)),
            # A pause held on the LAST cell before the loop restarts — the Geyser
            # erupts for a second and then sits still for five. Meaningless for a
            # tap-played layer, which stops when it reaches the end.
            **({"restMs": int(round(ad["animationDelayAfter"] * 1000))}
               if ad.get("animationDelayAfter") and not ad.get("onClick") else {}),
            # Tap to play once (Parrot, Taiko Drum, Monument, Box o' Lantern,
            # Anniversary Gift) rather than loop for ever.
            **({"onClick": True} if ad.get("onClick") else {}),
            # This layer IS the object's own sprite rather than a part drawn over
            # it, so cocos' restoreOriginalFrame puts the still back when a
            # tap-played run ends. Overlay layers have no still to fall back to and
            # rest on their own first cell instead — which is what keeps the
            # Liberty Monument's raised arm on the statue between waves.
            **({"base": True} if ad.get("animateBaseSprite") else {}),
            # A literal "playSound" entry in the frame list is a cue, not a frame:
            # it fires soundID as the animation reaches that point.
            **({"sound": ad["soundID"],
                "soundFrame": min(len([n for n in raw[:marker] if n != "playSound"]),
                                  len(cells) - 1)}
               if marker >= 0 and ad.get("soundID") else {}),
        })
    # ---- Motion-path parts ---------------------------------------------------
    # Each one ships as its own little PNG and its own sprite, positioned against
    # the object's GROUND POINT (the bottom-centre of the still, which is where
    # Field anchors it). Nothing is baked, so a part is free to travel outside the
    # object's own art — the Mechanical Egg's lid lifts 32px clear of it.
    anchor = (still[0] + still[2] / 2, still[1] + still[3])
    parts, arts = [], []
    for i, (ad, p) in enumerate(moving):
        if ad.get("frameBehind"):
            raise ValueError(f"{tile}: a motion part asks to draw behind the base, "
                             f"which the runtime draws parts over")
        absolute = bool(ad.get("moveToOffsets"))
        # cocos anchorPoint is y-UP; ours is y-down. Only the two moveToOffsets
        # tiles declare one, and a script's point is that anchor's destination.
        ax, ay = pair(ad["anchorPoint"]) if ad.get("anchorPoint") else (0.0, 0.0)
        ay = 1 - ay if ad.get("anchorPoint") else 0.0
        if absolute:
            first = [float(v) for v in re.findall(
                r"-?\d+\.?\d*", _script(ad["moveToOffsets"])[0][0])]
            home = (first[0], first[1])
        else:
            px, py = put(p)
            home = (px + p[1][2] * ax, py + p[1][3] * ay)
        name = f"{tile}_part{i}.png"
        arts.append((name, p[0]))
        ms, keys, cue = _move_track(ad.get("moveOffsets") or ad.get("moveToOffsets"),
                                    absolute, home, ad.get("soundID"))
        scale_ms, scale_keys = _scale_track(ad.get("scaleSequence"))
        parts.append({
            "art": name,
            # Home position of the part's anchor, relative to the ground point.
            "x": round(home[0] - anchor[0], 2), "y": round(home[1] - anchor[1], 2),
            **({"ax": ax, "ay": ay} if (ax or ay) else {}),
            **({"ms": ms, "keys": keys} if ms else {}),
            **({"scaleMs": scale_ms, "scaleKeys": scale_keys} if scale_ms else {}),
            **({"onClick": True} if ad.get("onClick") else {}),
            **({"sound": ad["soundID"], "soundAt": cue} if cue is not None else {}),
        })

    # The still bakes every part in at its home position (that is what puts the
    # bull on its plinth and the lid on the egg), so the art the object actually
    # DRAWS has to be the still with those parts taken back out — otherwise each
    # one leaves a copy of itself behind the moment it moves.
    residual = None
    if parts:
        claimed = {ad["animationFrameName"] for ad, _ in moving}
        keep = ([] if not base or base_fn in claimed else [base]) + [
            s[0] for (ad, _), s in zip(layers, seqs) if not is_blank(s[0][0])]
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        for q in keep:
            canvas.alpha_composite(q[0], put(q))
        cropped = canvas.crop((still[0], still[1], still[0] + still[2], still[1] + still[3]))
        if cropped.tobytes() != sprite_img.convert("RGBA").tobytes():
            residual = (f"{tile}_still.png", cropped)
            arts.append(residual)

    return {"w": right - left, "h": bottom - top,
            # Cells hang `dy` px below the still's ground line; the runtime pushes
            # the sprite down by that much so the object keeps standing where it did.
            **({"dy": bottom - ground} if bottom != ground else {}),
            **({"base": residual[0]} if residual else {}),
            "layers": out,
            **({"parts": parts} if parts else {})}, sheets + arts


def emit_animation(tile, tp, sprite_img):
    """Build a tile's flipbook and write its sheets; {} when it has none."""
    anim, sheets = build_animation(tile, tp, sprite_img)
    if not anim:
        return {}
    for name, sheet in sheets:
        sheet.save(os.path.join(OBJDIR, name))
    return {"anim": anim}


def main():
    from PIL import Image

    os.makedirs(OBJDIR, exist_ok=True)
    market = json.load(open(os.path.join(GAMEPLAY, "Market.json"), encoding="utf-8"))["Entries"]
    tileprops = json.load(open(os.path.join(GAMEPLAY, "TileProperties.json"), encoding="utf-8"))["Entries"]

    catalog = []
    seen = set()  # tile keys with at least one emitted market/reward object
    counts = {"tree": 0, "decor": 0, "functional": 0, "reward": 0}
    skipped = 0
    skipped_keys = []
    base_row = {}  # tile -> the catalog row holding that tile's art
    base_img = {}  # tile -> that row's extracted sprite
    signatures = {}  # tile -> {(name, tint)} already emitted
    keys_taken = set()
    variant_count = 0

    # Sort so the cheapest/earliest variant of a shared tile wins the base key.
    items = [e for e in market if ((e.get("category") == "item" and classify(e)) or e.get("tile") in EPIC_REWARD_TILES)
             and (not e.get("dontShowInMarket") or e.get("tile") in EPIC_REWARD_TILES)]
    items.sort(key=lambda e: (e.get("level", 1), e.get("cost", 0)))

    for e in items:
        tile = e.get("tile")
        if not tile:
            continue
        category = ("reward" if tile in EPIC_REWARD_TILES or tile in REWARD_ONLY_DECOR
                    else "functional" if tile in FUNCTIONAL_OVERRIDE_TILES
                    else classify(e))

        # A later Market row for art already emitted is either a genuine recolor
        # (its own card) or a straight duplicate of a row already written — the
        # Gazebo, the Pond and the Zombie Pot are each listed twice, identically.
        if tile in base_row:
            signature = (e["name"], tuple(market_tint(e) or ()))
            if signature in signatures[tile]:
                continue
            signatures[tile].add(signature)
            key = variant_key(tile, e["name"], keys_taken)
            keys_taken.add(key)
            row = dict(base_row[tile])  # same art, footprint, pivot, sounds
            row.update({
                "key": key,
                "name": e["name"],
                # Grouping for the quest matcher: buying any recolor also answers to
                # its siblings' names, so "buy a Fence" takes a Blue Fence.
                "variantOf": tile,
                **market_economics(e, key, tile, is_reward_only(tile),
                                   bool(e.get("brainsNeeded", False)), category),
            })
            tint = market_tint(e)
            if tint:
                row["color"] = tint
            else:
                row.pop("color", None)
            # A variant whose colour no tint can reach gets art of its own rather
            # than the family's shared sprite (see NEUTRALIZED_VARIANT_SPRITES).
            if key in NEUTRALIZED_VARIANT_SPRITES and base_img.get(tile) is not None:
                neutral = neutralize_petals(base_img[tile].convert("RGBA"))
                row["sprite"] = emit_sprite(key, neutral)
                row["nativeW"], row["nativeH"] = neutral.width, neutral.height
            catalog.append(row)
            counts[category] += 1
            variant_count += 1
            continue

        key = tile
        keys_taken.add(key)
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
            elif tile in ANIMATION_OVER_BASE:
                # frameName is only the part that stands still; bake the orbit on.
                sprite_img = extract_animated_over_base(tp)
            else:
                fl, fn = tp.get("frameList"), tp.get("frameName")
                if fl and fn:
                    sprite_img = extract_from_atlas(fl, fn)
            # Some ordinary decor and Epic rewards use loose sprites (occasionally
            # one rectangle within a shared sheet) rather than an atlas frame.
            # Without this fallback named quest items such as Gravestone, Heart
            # Gravestone, and the Cupid Statues silently disappear from the market.
            # An animated tile can REST on an empty frame; use its first drawn
            # animation frame rather than shipping an invisible object.
            if is_blank(sprite_img) and tp.get("animationDictionaries"):
                sprite_img = extract_first_animated_frame(tp) or sprite_img
            if is_blank(sprite_img) and tp.get("spriteSheet"):
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
            sprite_img = loose_sprite(tp, tp.get("spriteSheet") or e.get("spriteSheet"))

        if is_blank(sprite_img):
            skipped += 1
            skipped_keys.append(key)
            continue
        # Flat art is laid edge to edge and its pieces overlap, so a doubled
        # premultiply paints a dark seam along every join. See unpremultiply.
        if tp.get("flatTile"):
            sprite_img = unpremultiply(sprite_img)
        out_name = emit_sprite(key, sprite_img)
        # A tile's childNodes ship as a SECOND image drawn behind it (Pet Pen far wall).
        back_img = extract_child_layer(tp)
        back_name = "" if is_blank(back_img) else emit_sprite(f"{key}_back", back_img)
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
        # Reward-only decor is never sold: no price, no level gate, no purchase XP.
        reward_only = is_reward_only(tile)
        row = {
            "key": key,
            "name": e["name"],
            "category": category,
            # Theme label; absent means evergreen. `seasonal` is DERIVED from it and
            # kept for the existing market sort until that reads `theme` directly.
            **({"theme": THEME_OF_TILE[tile], "seasonal": True}
               if tile in THEME_OF_TILE else {}),
            **market_economics(e, key, tile, reward_only,
                               bool(e.get("brainsNeeded", False)), category),
            # Authentic sprite tint (see market_tint): for greyscale art this is the
            # item's ONLY source of colour, and it is what tells the five monoliths —
            # one shared tex1009.png — apart.
            **({"color": market_tint(e)} if market_tint(e) else {}),
            # Whole tiles only: the game reads these via integerValue (truncates),
            # so coerce any fractional footprint (e.g. coolerLarge 1.5) to an int.
            "tileW": max(1, int(tp.get("tileWidth", 1))),
            "tileH": max(1, int(tp.get("tileHeight", 1))),
            "movable": bool(tp.get("movable", True)),
            "rotations": tp.get("rotations", 1),
            # Art with writing on it: Rotate is a mirror, so it would read backwards.
            **({"noMirror": True} if tile in NO_MIRROR_TILES else {}),
            "sprite": out_name,
            # Flipbook animation played on the farm (see build_animation).
            **emit_animation(tile, tp, sprite_img),
            # Far-side art drawn BEHIND anything standing inside this object.
            **({"backSprite": back_name} if back_name else {}),
            # Working-state art (Zombie Pot: lid on while cooking, arm out when done).
            **state_sprites(tileprops, tile),
            "nativeW": sprite_img.width,
            "nativeH": sprite_img.height,
            "pivotX": tp.get("pivotx", 0.5),
            "pivotY": tp.get("pivoty", 0.0),
            # Ground-hugging art (roads, ponds, the zombie patch) that has to line
            # up seam-to-seam with its neighbours, so it is anchored by its authored
            # pivot rather than bottom-centered. See flat_tile_fields.
            **flat_tile_fields(tile, tp, sprite_img),
            # A road bend's four corners are four separate pieces of art; Rotate
            # picks between them instead of mirroring one. See ROAD_TURNS.
            **turn_fields(tile, tileprops),
            # simple functional effects the game can apply on placement
            "armyMax": e.get("increaseArmyMaxBy", 0),
            "storageSlots": slots,  # >0 for storage sheds (item capacity)
            # >0 for the Mausoleum (zombie storage slots). The base tier's value is
            # a design number, not a source one; see MAUSOLEUM_TIERS below.
            "zombieSlots": MAUSOLEUM_BASE_SLOTS if tile == "mausoleum3" else 0,
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
        }
        catalog.append(row)
        # Recolors of this tile clone the row above and override name/color.
        base_row[tile] = row
        base_img[tile] = sprite_img
        signatures[tile] = {(e["name"], tuple(market_tint(e) or ()))}

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
        elif tile in ANIMATION_OVER_BASE:
            # frameName is only the part that stands still (the Pixel Campfire's logs
            # without its fire); bake the animation's first frame on.
            sprite_img = extract_animated_over_base(tp)
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

        if is_blank(sprite_img):
            reward_skipped.append(name)
            continue

        # Flat art is laid edge to edge and its pieces overlap, so a doubled
        # premultiply paints a dark seam along every join. See unpremultiply.
        if tp.get("flatTile"):
            sprite_img = unpremultiply(sprite_img)
        out_name = emit_sprite(tile, sprite_img)
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
            # Art with writing on it: Rotate is a mirror, so it would read backwards.
            **({"noMirror": True} if tile in NO_MIRROR_TILES else {}),
            "sprite": out_name,
            # Flipbook animation played on the farm (see build_animation).
            **emit_animation(tile, tp, sprite_img),
            "nativeW": sprite_img.width,
            "nativeH": sprite_img.height,
            "pivotX": tp.get("pivotx", 0.5),
            "pivotY": tp.get("pivoty", 0.0),
            # Ground-hugging art (roads, ponds, the zombie patch) that has to line
            # up seam-to-seam with its neighbours, so it is anchored by its authored
            # pivot rather than bottom-centered. See flat_tile_fields.
            **flat_tile_fields(tile, tp, sprite_img),
            "armyMax": 0,
            "storageSlots": 0,
            "zombieSlots": 0,
            "growMs": 0,
            "harvestValue": 0,
            "growingSprite": "",
            **({"tapSound": tp.get("tapSoundEffect") or tp.get("soundID")}
               if tp.get("tapSoundEffect") or tp.get("soundID") else {}),
        })

    # Design override (not in the source data): the Zombie Pot's first purchase is
    # 500 gold (the shown price). Additional pots cost 30 brains — that dual pricing
    # is applied at placement (see main.ts tryPlaceObject).
    tree_balance = {
        "oliveTreeOlive": {"level": 5},
        "fruitTreeLemon": {"harvestValue": 35},
        "fruitTreeOrange": {"harvestValue": 18},
    }
    for c in catalog:
        c.update(tree_balance.get(c["key"], {}))
        if c["key"] == "zombieCombiner":
            c["cost"] = 500
            c["brainsNeeded"] = False
            # The override replaces the price AFTER the loop above computed xp from
            # the source row, so re-apply the game's own floor(cost / 100) rule to
            # the price actually charged (500 gold -> 5 xp, not the source's 500).
            c["xp"] = c["cost"] // 100

    # Mausoleum upgrade tiers: clones of the base row (same sprite/footprint) that
    # the Market offers one at a time above the placed building's capacity.
    base_mausoleum = next((c for c in catalog if c["key"] == "mausoleum3"), None)
    if base_mausoleum:
        for key, name, slots in MAUSOLEUM_TIERS:
            tier = dict(base_mausoleum)
            tier.update({"key": key, "name": name,
                         "cost": MAUSOLEUM_STEP_COST, "zombieSlots": slots})
            catalog.append(tier)

    # Storage sheds above the source's top rung: clones of the biggest source shed
    # (same sprite/footprint) that the Market offers one at a time above the placed
    # shed's capacity, exactly like the Mausoleum ladder above.
    base_shed = next((c for c in catalog if c["key"] == EXTRA_SHED_BASE), None)
    if base_shed:
        for key, name, cost, slots in EXTRA_SHED_TIERS:
            tier = dict(base_shed)
            tier.update({"key": key, "name": name, "cost": cost,
                         "xp": cost // 100, "storageSlots": slots})
            catalog.append(tier)

    # Memorial Statue: a reimplementation addition with no source row, whose art is
    # cut from the Tim Statue's plinth. Built AFTER the loop above so its source
    # sprite is already in OBJDIR, and BEFORE the orphan sweep so its own PNG counts
    # as referenced. See tools/memorial_statue.py.
    catalog.append(memorial_statue.build(OBJDIR))

    # Art drawn for this project rather than extracted from the source atlases, so
    # it has neither a Market row nor an atlas frame — both halves are authored in
    # tools/contributed_art.py. Appended here for the same reason as the Memorial
    # Statue: before the orphan sweep, so its PNGs count as referenced.
    catalog.extend(contributed_art.build(OBJDIR))

    catalog.sort(key=lambda c: (c["category"], c["level"], c["cost"]))

    # public/assets/objects/ is entirely generated, so anything the catalog no
    # longer references is stale — a rename, a dropped item, or (since emit_sprite)
    # a duplicate that now shares another key's file. Leaving them behind makes the
    # directory look like it still holds art the game can reach.
    referenced = {c["sprite"] for c in catalog} | {
        c["growingSprite"] for c in catalog if c["growingSprite"]} | {
        c["backSprite"] for c in catalog if c.get("backSprite")} | {
        c[field] for c in catalog for _, field in STATE_SPRITE_TILES if c.get(field)} | {
        t["sprite"] for c in catalog for t in c.get("turns", [])} | {
        L["sheet"] for c in catalog for L in c.get("anim", {}).get("layers", [])} | {
        P["art"] for c in catalog for P in c.get("anim", {}).get("parts", [])} | {
        c["anim"]["base"] for c in catalog if c.get("anim", {}).get("base")}
    orphans = sorted(f for f in os.listdir(OBJDIR)
                     if f.endswith(".png") and f not in referenced)
    for f in orphans:
        os.remove(os.path.join(OBJDIR, f))

    with open(os.path.join(OUT, "placeables.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=1)
    print(f"placeables: {len(catalog)} objects -> {counts} "
          f"+ {reward_count} reward decor (skipped {skipped} market, "
          f"{len(reward_skipped)} reward w/o art)")
    if skipped_keys:
        print(f"  no art (dropped): {', '.join(skipped_keys)}")
    if reward_skipped:
        print(f"  reward w/o art: {', '.join(reward_skipped)}")
    tinted = sum(1 for c in catalog if c.get("color"))
    shared = len(catalog) - len({c["sprite"] for c in catalog})
    print(f"  {tinted} tinted rows, {shared} rows sharing another key's sprite, "
          f"{variant_count} recolor variants")
    if orphans:
        print(f"  removed {len(orphans)} stale png: {', '.join(orphans)}")


if __name__ == "__main__":
    main()
