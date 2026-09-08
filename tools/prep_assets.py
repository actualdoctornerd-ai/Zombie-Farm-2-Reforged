"""
Asset-prep for the ZF2R field milestone.

Reads the extracted ZF2R 1.0 app bundle and produces clean PNGs + JSON under
zombiefarm/public/assets/ :

  ground/<terrain>_<variant>.png   sliced from tex0000.png (48x24 iso diamonds);
                                   the lunar row is regraded and "autumn" is a
                                   recolour of grass (see DERIVED_GROUND_ROWS)
  player/<part>.png                sliced from playerSpriteSheet.png (cocos2d fmt 3)
  rig_player.json                  FarmerSprites.plist layout (offset/pivot/z per part)
  ground_index.json                terrain -> [variant filenames]
  field_default.json               a starter 30x30 terrain grid

Run:  python tools/prep_assets.py
"""
import colorsys, os, re, io, json, plistlib, random, shutil
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
APP = os.path.normpath(os.path.join(
    PROJ, "..", "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app"))
OUT = os.path.join(PROJ, "public", "assets")

CTRL = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")  # invalid XML control bytes


def load_plist(path):
    raw = CTRL.sub(b"", open(path, "rb").read())
    return plistlib.load(io.BytesIO(raw))


def rect(s):
    """Parse cocos2d rect string '{{x, y}, {w, h}}' -> (x, y, w, h)."""
    nums = list(map(int, re.findall(r"-?\d+", s)))
    return nums[0], nums[1], nums[2], nums[3]


# ---------------------------------------------------------------- ground tiles
# tex0000.png is a 5-col x 6-row grid of 48x24 diamonds. Each row = one terrain,
# the 5 columns are color variants.
GROUND_ROWS = ["grass", "dirt", "snow", "stone", "sand", "water"]
TILE_W, TILE_H = 48, 24

# Terrains Reforged ADDS on top of the six source rows, each derived from an
# existing row by an HSV rotation: hue is replaced outright, saturation and value
# are scaled. Rotating in HSV (rather than remapping through a luminance ramp, as
# the backdrops do) preserves the source tile's texture EXACTLY — every
# grass-blade stroke keeps its relative shading, so the result still reads as the
# same hand-painted art rather than a flat wash.
#
# "autumn": the default grass turned to a warm orange-tan. Deliberately pushed
# past a plain brown — the palette already has a pale sand ("dirt", the Sandy
# skin) and a mustard dead grass ("sand", the Dead skin), and a new ground has to
# be distinguishable from both at a glance.
#
# KEEP IN SYNC with: EXTRA_CLIMATES in reforge_economy.py (the market entry),
# CLIMATE_COST in server/src/shopCatalog.ts (the price the server charges), and
# the theme in src/surroundings.ts (what the land around the farm looks like).
#
# "sakura": grass under blossom, drifted over with fallen petals. Pink is the one
# family the palette has no entry in at all, so it clears the distinguishable-at-a-
# glance bar outright; saturation is pulled DOWN (unlike autumn's boost) because a
# fully saturated pink lawn fights the crops standing on it, and value is pushed up
# hard so the tile reads as pale blossom rather than raw magenta.
DERIVED_GROUND_ROWS = {
    "autumn": {"source": "grass", "hue": 28 / 360, "sat": 1.05, "val": 1.32},
    "sakura": {"source": "grass", "hue": 337 / 360, "sat": 0.52, "val": 1.38,
               "rocky": True, "fill": True},
}

# ---- Rocky ground (the Sakura skin) --------------------------------------
# A recolour alone leaves the terrain reading as lawn, just a different colour of
# lawn. `rocky` strews stone THROUGH the tile itself — pebbles bedded in the ground
# rather than more `rocks.png` objects standing on it — so the blossom valley has a
# stony floor at every zoom, including the one where placed decor is too small to
# make out.
#
# Same discipline as LUNAR_PITS: the tile repeats across the entire farm, so this is
# a handful of SMALL stones per variant, hand-placed well inside the diamond and
# different in all five, plus a fine grit. Anything larger, or repeated in the same
# spot, stops reading as ground and starts reading as wallpaper.
#
# Pebbles are (centre x, centre y, x radius, y radius) in the 48x24 tile.
#
# The COUNT deliberately varies (2/1/2/0/1) rather than being even across the five,
# and one variant carries no stone at all. With the same number in every variant the
# ground gains a faint regular beat at native scale — the eye finds the cadence even
# when it cannot resolve the individual stones. Uneven counts, and an empty variant
# to open real gaps, give the strew clumps and bare ground instead.
#
# These are 2.2 stones per tile on average, and they are the FARM's ground only —
# the land outside it is deliberately left smooth (see WILD_*), so the stones are
# what tells the two apart. An early pass ran at 3.6 and read as a gravel path
# rather than as ground with stones in it: at farm scale a tile is only 48x24, so
# even two stones per tile is thousands of them across a 30x30 field.
ROCKY_PEBBLES = [
    [(14, 13, 3, 2), (30, 9, 2, 1), (36, 15, 2, 1)],
    [(31, 14, 3, 2), (18, 8, 2, 1)],
    [(20, 8, 2, 1), (31, 16, 3, 2), (13, 13, 2, 1)],
    [(27, 15, 3, 2)],
    [(19, 15, 3, 2), (33, 9, 2, 1)],
]
# Stone tones. Pink-leaning greys, not neutral ones: a neutral stone on blossom
# ground reads as a hole punched in it rather than as part of the same landscape.
# Light comes from the upper right, as it does everywhere else in the art.
#
# All three sit well BELOW the ground's luminance (~212). The first pass matched the
# lit face to it exactly, and a stone whose top is the same brightness as what it
# lies on has no top — the whole strew read as faint smudges.
#
# Softened deliberately. An earlier pass ran these much darker (rim 96,82,92) and the
# stones read as hard chips of slate dropped on the blossom — the farm looked like a
# different material from the hills behind it. They now sit close enough to the ground
# to be felt rather than counted, which is the half of "ground and hills should match"
# that belongs to the ground; the other half is TERRAIN_GRAIN in prep_backgrounds.py.
PEBBLE_LIGHT = (210, 197, 204)
PEBBLE_DARK = (158, 142, 152)
PEBBLE_RIM = (134, 118, 128)
# Contact shadow cast onto the ground under each stone, as a multiplier.
PEBBLE_SHADOW = 0.93
# Grit: the fraction of ground pixels darkened, and by how much. Deliberately weak —
# it should be felt as texture underfoot, not seen as noise. At 0.14/20 it was seen:
# a 14% speckle over the whole farm is a dither pattern, not dirt.
GRIT_CHANCE = 0.05
GRIT_DEPTH = 9


# ---- Wild ground: the same terrain, OUTSIDE the farm ---------------------
# The fill and the farm must not be the same picture. Making them seamless was the
# right first move — it stopped the farm reading as a textured island on a blank
# sheet — but taken all the way it erases the fence line, and a player should be
# able to see at a glance where their land stops.
#
# So the two are cut from the same cloth and finished differently: the farm is the
# ground someone works, carrying the stones that come up out of it, and the land
# beyond is left plain and a shade deeper, the way unworked ground reads at a
# distance. No stones at all out there, which is also what keeps the surrounding
# land quiet enough for the scatter of trees and rocks standing ON it to be read.
WILD_DARKEN = 0.955
WILD_GRIT_CHANCE = 0.03
WILD_GRIT_DEPTH = 10


def weather_ground(cell, variant):
    """The plain, slightly deeper cut of a terrain, for the land outside the farm."""
    out = cell.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0 or not _in_diamond(x, y):
                continue
            if _hash2(x, y, variant + 29) % 1000 < WILD_GRIT_CHANCE * 1000:
                r, g, b = (max(0, c - WILD_GRIT_DEPTH) for c in (r, g, b))
            px[x, y] = tuple(max(0, min(255, round(c * WILD_DARKEN)))
                             for c in (r, g, b)) + (a,)
    return out


def _hash2(x, y, salt):
    """Deterministic 0..0x7fffffff from a pixel and a salt. The tiles are checked-in
    build artefacts, so the grain must never come from `random`."""
    h = (x * 73856093) ^ (y * 19349663) ^ (salt * 83492791)
    return (h ^ (h >> 13)) & 0x7FFFFFFF


def strew_pebbles(cell, variant):
    """Bed a few stones and a grit of small chips into one ground tile."""
    out = cell.copy()
    px = out.load()
    stones = ROCKY_PEBBLES[variant % len(ROCKY_PEBBLES)]

    def shade(v, mul):
        return max(0, min(255, round(v * mul)))

    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0 or not _in_diamond(x, y):
                continue
            # Grit first, so a stone laid on top covers it rather than showing through.
            if _hash2(x, y, variant + 7) % 1000 < GRIT_CHANCE * 1000:
                r, g, b = (max(0, c - GRIT_DEPTH) for c in (r, g, b))
            painted = False
            for cx, cy, rx, ry in stones:
                nx, ny = (x - cx) / rx, (y - cy) / ry
                d = nx * nx + ny * ny
                if d <= 1.0:
                    # Lit from the upper right: ramp across that diagonal, with the
                    # outer edge dropped to a rim so the stone has an outline like
                    # every other piece of art in the game.
                    f = min(1.0, max(0.0, (nx * 0.5 - ny * 0.85 + 1) / 2)) ** 0.9
                    if d > 0.72:
                        r, g, b = PEBBLE_RIM
                    else:
                        r, g, b = (round(PEBBLE_DARK[i] + (PEBBLE_LIGHT[i] - PEBBLE_DARK[i]) * f)
                                   for i in range(3))
                        speck = (_hash2(x, y, variant + 13) % 9) - 4
                        r, g, b = (max(0, min(255, c + speck)) for c in (r, g, b))
                    painted = True
                    break
                # Just below and outside a stone: the ground it sits in.
                if not painted and ny > 0 and d <= 2.0:
                    r, g, b = (shade(c, PEBBLE_SHADOW) for c in (r, g, b))
            px[x, y] = (r, g, b, a)
    return out


def recolor_terrain(cell, hue, sat, val):
    """HSV-rotate one ground tile onto a new hue, keeping its texture intact."""
    out = cell.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            _, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            s = max(0.0, min(1.0, s * sat))
            v = max(0.0, min(1.0, v * val))
            nr, ng, nb = colorsys.hsv_to_rgb(hue, s, v)
            px[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
    return out


# The source "water" row is the Lunar Ground skin, and as sliced it is a flat,
# strongly BLUE slate with a handful of soft craters — it reads as water, which
# is what the row is named, not as the moon it dresses. This regrade nudges it
# toward real regolith without abandoning the game's stylised palette: darker,
# most of the blue cast pulled out toward neutral grey, deeper craters, and a
# fine dust grain over the whole tile.
#
# It lives HERE, in the slice, rather than as an edit to the emitted PNGs: the
# tiles are derived from the source atlas every run, so a hand-edited tile would
# be silently reverted the next time anyone regenerates assets.
LUNAR_DESATURATE = 0.72   # fraction of the way to pure luminance
LUNAR_DARKEN = 0.82       # overall exposure
LUNAR_CONTRAST = 1.25     # expansion about LUNAR_PIVOT, so craters stay readable
LUNAR_PIVOT = 84.0
LUNAR_GRAIN = 6           # +/- per-pixel dust grain, in levels
# Extra impact pits, as (centre x, centre y, x radius, y radius, darkening) per
# variant. Deliberately small and few: the tile repeats across the whole farm, so
# anything with a strong silhouette would read as a wallpaper pattern rather than
# as ground. Every centre sits inside the 48x24 diamond.
LUNAR_PITS = [
    [(15, 15, 3, 2, 0.88), (33, 9, 2, 1, 0.91), (24, 17, 2, 1, 0.93)],
    [(30, 15, 3, 2, 0.89), (17, 8, 2, 1, 0.92), (38, 13, 2, 1, 0.93)],
    [(21, 7, 3, 2, 0.88), (13, 13, 2, 1, 0.92), (31, 18, 2, 1, 0.91)],
    [(27, 16, 3, 2, 0.90), (36, 11, 2, 1, 0.92), (16, 11, 2, 1, 0.93)],
    [(19, 16, 3, 2, 0.89), (29, 6, 2, 1, 0.93), (35, 15, 2, 1, 0.92)],
]


def _in_diamond(x, y):
    """The 48x24 iso tile's alpha silhouette, as a half-pixel-centred test."""
    return abs(x + 0.5 - TILE_W / 2) / (TILE_W / 2) + \
           abs(y + 0.5 - TILE_H / 2) / (TILE_H / 2) <= 1.0


def regrade_lunar(cell, variant):
    """Repaint one sliced lunar tile as darker, grainier, near-neutral regolith."""
    out = cell.copy()
    px = out.load()
    pits = LUNAR_PITS[variant % len(LUNAR_PITS)]
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            ch = []
            for v in (r, g, b):
                v = v + (lum - v) * LUNAR_DESATURATE      # toward neutral grey
                v *= LUNAR_DARKEN                          # a stop down
                v = LUNAR_PIVOT + (v - LUNAR_PIVOT) * LUNAR_CONTRAST
                ch.append(v)
            # Dust grain: one deterministic offset applied to all three channels,
            # so the noise reads as brightness variation and never as colour speckle.
            h = (x * 73856093) ^ (y * 19349663) ^ (variant * 83492791)
            h = (h ^ (h >> 13)) & 0x7fffffff
            grain = (h % (2 * LUNAR_GRAIN + 1)) - LUNAR_GRAIN
            for cx, cy, rx, ry, mul in pits:
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0 and _in_diamond(x, y):
                    ch = [v * mul for v in ch]
            px[x, y] = tuple(max(0, min(255, round(v + grain))) for v in ch) + (a,)
    return out


# ---- Ground fill for the land OUTSIDE the farm ---------------------------
# Only the farm itself is built out of ground tiles. Everything around it is the
# renderer's flat `filler` colour (see surroundings.ts) — which is invisible for a
# plain grass skin and glaring for a textured one, since the stony Sakura farm ends
# up a detailed diamond sitting on an unbroken sheet of pink. A terrain with a
# `fill` emits one SEAMLESS rectangle of itself that main tiles over that land, so
# the ground reads the same inside the fence and out.
#
# 240x120 is a genuine period of the iso lattice — both (240,0) and (0,120) are
# integer combinations of the tile steps (24,12) and (-24,12) — so the rect repeats
# with no seam. It holds 50 diamonds: big enough that the repeat is not readable,
# where the minimum period (48x24, two diamonds) would tile as an obvious checker.
GROUND_FILL_W, GROUND_FILL_H = 240, 120


def build_ground_fill(cells):
    """A seamless GROUND_FILL_W x GROUND_FILL_H rectangle of one terrain."""
    out = Image.new("RGBA", (GROUND_FILL_W, GROUND_FILL_H), (0, 0, 0, 0))
    rows = GROUND_FILL_H // (TILE_H // 2)
    cols = GROUND_FILL_W // TILE_W
    for j in range(-2, rows + 2):
        for i in range(-2, cols + 2):
            # Phase matched to Field.fit, which anchors a tile's TOP-CENTRE at
            # gridToScreen(col,row) — so a tile box's left edge lands on a multiple
            # of 48 on odd rows and halfway between on even ones. Getting this
            # backwards puts the fill half a tile out of step with the farm, and the
            # stones visibly jump at the field's edge.
            x = i * TILE_W + (TILE_W // 2 if j % 2 == 0 else 0)
            y = j * (TILE_H // 2)
            # The variant must be periodic too, or the pattern is seamless in
            # geometry and seamed in colour: the tile just past the right edge has to
            # be the same one the left edge starts with.
            v = ((i % cols) * 73856093) ^ ((j % rows) * 19349663)
            cell = cells[((v ^ (v >> 13)) & 0x7FFFFFFF) % len(cells)]
            for dx in (-GROUND_FILL_W, 0, GROUND_FILL_W):
                for dy in (-GROUND_FILL_H, 0, GROUND_FILL_H):
                    out.paste(cell, (x + dx, y + dy), cell)
    if out.getextrema()[3][0] != 255:
        raise ValueError("ground fill has gaps — the tile lattice does not tessellate")
    return out


def slice_ground():
    src = os.path.join(APP, "tex0000.png")
    im = Image.open(src).convert("RGBA")
    cols = im.width // TILE_W
    rows = im.height // TILE_H
    index = {}
    sliced = {}  # terrain -> [cell, ...], kept so derived rows come off the source
    for r in range(rows):
        terrain = GROUND_ROWS[r] if r < len(GROUND_ROWS) else f"terrain{r}"
        index[terrain] = []
        sliced[terrain] = []
        for c in range(cols):
            cell = im.crop((c * TILE_W, r * TILE_H,
                            c * TILE_W + TILE_W, r * TILE_H + TILE_H))
            if terrain == "water":
                cell = regrade_lunar(cell, c)
            name = f"{terrain}_{c}.png"
            cell.save(os.path.join(OUT, "ground", name))
            index[terrain].append(name)
            sliced[terrain].append(cell)

    # Reforged's own terrains, recoloured off a source row. Derived from the cells
    # held above rather than re-read from disk, so re-running can never compound a
    # previous run's recolour onto itself.
    for terrain, spec in DERIVED_GROUND_ROWS.items():
        index[terrain] = []
        wild = []
        for c, cell in enumerate(sliced[spec["source"]]):
            name = f"{terrain}_{c}.png"
            base = recolor_terrain(cell, spec["hue"], spec["sat"], spec["val"])
            # Both cuts come off the same recoloured tile, so the farm and the land
            # around it can never drift apart in hue however either is retuned; only
            # the finish differs. Stone goes in AFTER the recolour, or the pebbles
            # get rotated onto the terrain's hue along with the grass.
            farm = strew_pebbles(base, c) if spec.get("rocky") else base
            farm.save(os.path.join(OUT, "ground", name))
            index[terrain].append(name)
            wild.append(weather_ground(base, c) if spec.get("fill") else base)
        if spec.get("fill"):
            build_ground_fill(wild).save(
                os.path.join(OUT, "ground", f"{terrain}_fill.png"))

    json.dump(index, open(os.path.join(OUT, "ground_index.json"), "w"), indent=1)
    total = sum(len(v) for v in index.values())
    print(f"ground: {len(index)} terrains ({rows} source + "
          f"{len(DERIVED_GROUND_ROWS)} derived) x {cols} variants -> {total} tiles")
    return index


# ---------------------------------------------------------------- player parts
def slice_player():
    plist = load_plist(os.path.join(APP, "playerSpriteSheet.plist"))
    atlas = Image.open(os.path.join(APP, "playerSpriteSheet.png")).convert("RGBA")
    frames = plist["frames"]
    n = 0
    for key, f in frames.items():
        x, y, w, h = rect(f["textureRect"])
        rotated = f.get("textureRotated", False)
        # When rotated, the region in the atlas is stored 90deg CW; w/h are swapped.
        crop_w, crop_h = (h, w) if rotated else (w, h)
        piece = atlas.crop((x, y, x + crop_w, y + crop_h))
        if rotated:
            piece = piece.rotate(-90, expand=True)  # undo CW packing
        piece.save(os.path.join(OUT, "player", key))  # key already ends in .png
        n += 1
    print(f"player: sliced {n} parts")


# --------------------------------------------------------------------- soil
# Soil.png holds the farming-plot diamonds (plowed/unplowed/planted/hole),
# ~194x90 each. We export the ones the game logic needs as standalone PNGs.
SOIL_FRAMES = ["plowed_dirt.png", "unplowed_dirt.png", "planted_dirt.png"]


def slice_soil():
    plist = load_plist(os.path.join(APP, "Soil.plist"))
    atlas = Image.open(os.path.join(APP, "Soil.png")).convert("RGBA")
    os.makedirs(os.path.join(OUT, "soil"), exist_ok=True)
    n = 0
    for name in SOIL_FRAMES:
        if name not in plist["frames"]:
            continue
        f = plist["frames"][name]
        x, y, w, h = rect(f["textureRect"])
        rotated = f.get("textureRotated", False)
        cw, ch = (h, w) if rotated else (w, h)
        piece = atlas.crop((x, y, x + cw, y + ch))
        if rotated:
            piece = piece.rotate(-90, expand=True)
        piece.save(os.path.join(OUT, "soil", name))
        n += 1
    print(f"soil: sliced {n} plot textures")


# ------------------------------------------------------- generic named slicer
def slice_named(plist_name, png_name, frame_names, outdir):
    plist = load_plist(os.path.join(APP, plist_name))
    atlas = Image.open(os.path.join(APP, png_name)).convert("RGBA")
    os.makedirs(os.path.join(OUT, outdir), exist_ok=True)
    n = 0
    for name in frame_names:
        f = plist["frames"].get(name)
        if not f:
            print("   missing frame:", name)
            continue
        x, y, w, h = rect(f["textureRect"])
        rotated = f.get("textureRotated", False)
        cw, ch = (h, w) if rotated else (w, h)
        piece = atlas.crop((x, y, x + cw, y + ch))
        if rotated:
            piece = piece.rotate(-90, expand=True)
        piece.save(os.path.join(OUT, outdir, name))
        n += 1
    return n


# HUD icons: top-bar currencies (GUI.png) + XP (DetailsQuestsDelete.png) + tool buttons.
UI_FROM_GUI = [
    "topbar_money_icon.png", "topbar_money_symbol.png", "topbar_brain_icon.png",
    "topbar_zombie_icon.png", "topbar_level_icon.png",
    "button_menu.png", "button_market.png", "button_plow.png", "button_plant.png",
    "button_multitool.png", "button_invade.png", "button_move.png", "button_sell.png",
    "button_mausoleum.png", "button_friends.png", "button_storage.png",
    "button_bg.png", "button_invade.png",  # dark slot frame + blank red pill
    "button_move.png", "button_close.png",  # edit-toolbar: move + delete(X)
]
UI_FROM_QUESTS = ["topbar_exp_icon.png"]
UI_FROM_MENU = ["menu_settings_icon.png", "menu_zombies_icon.png",
                "menu_storage_icon.png", "menu_profile_icon.png"]
UI_FROM_MARKET = ["icon_market_zombie.png"]
# Standalone quest-icon PNGs (already loose files in the bundle) for the quest bar.
QUEST_ICONS = [
    "Icon_Quest_HarvestVegetables.png", "Icon_Quest_HarvestZombies.png",
    "Icon_Quest_Invasion.png", "Icon_Quest_Decorating.png", "Icon_Quest_Combining.png",
]


def slice_ui():
    a = slice_named("GUI.plist", "GUI.png", UI_FROM_GUI, "ui")
    b = slice_named("DetailsQuestsDelete.plist", "DetailsQuestsDelete.png",
                    UI_FROM_QUESTS, "ui")
    c = slice_named("MenuHelpProfileSettings.plist", "MenuHelpProfileSettings.png",
                    UI_FROM_MENU, "ui")
    d = slice_named("MarketMenuAssets.plist", "MarketMenuAssets.png",
                    UI_FROM_MARKET, "ui")
    n = 0
    for q in QUEST_ICONS:  # loose PNGs — just copy through
        src = os.path.join(APP, q)
        if os.path.exists(src):
            Image.open(src).convert("RGBA").save(os.path.join(OUT, "ui", q))
            n += 1
    print(f"ui: sliced {a + b + c + d} HUD icons + {n} quest icons")


def make_composites():
    """Assemble the green nav pill (button_left + middle + right) into one PNG for
    CSS border-image (9-slice) use."""
    d = load_plist(os.path.join(APP, "GUI.plist"))
    atlas = Image.open(os.path.join(APP, "GUI.png")).convert("RGBA")

    def slc(frame):
        f = d["frames"][frame]
        x, y, w, h = rect(f["textureRect"])
        rot = f.get("textureRotated", False)
        cw, ch = (h, w) if rot else (w, h)
        im = atlas.crop((x, y, x + cw, y + ch))
        return im.rotate(-90, expand=True) if rot else im

    L, M, R = slc("button_left.png"), slc("button_middle.png"), slc("button_right.png")
    nav = Image.new("RGBA", (L.width + M.width + R.width, L.height), (0, 0, 0, 0))
    x = 0
    for p in (L, M, R):
        nav.alpha_composite(p, (x, 0))
        x += p.width
    os.makedirs(os.path.join(OUT, "ui"), exist_ok=True)
    nav.save(os.path.join(OUT, "ui", "nav_green.png"))
    # grey version (same glossy shading, desaturated) for the neutral menu buttons
    grey = nav.copy()
    gpx = grey.load()
    for y in range(grey.height):
        for x in range(grey.width):
            r, g, b, a = gpx[x, y]
            if a:
                lum = 0.299 * r + 0.587 * g + 0.114 * b
                s = min(255, int(lum * 1.15 + 55))  # lift to a light silver
                gpx[x, y] = (s, s, s, a)
    grey.save(os.path.join(OUT, "ui", "nav_grey.png"))
    print("composites: nav_green.png + nav_grey.png")


def slice_crops():
    # Core + event crop frames that live in the two packed crop atlases.
    n = slice_named("Crops1.plist", "Crops1.png", [
        "Bloodberry_stage1.png", "Bloodberry_stage2.png",
        "Pumpking_stage1.png", "Pumpking_stage2.png",
        "Skellyberry_stage1.png", "Skellyberry_stage2.png",
        "Spineapple_stage1.png", "Spineapple_stage2.png",
        "Sun_Glower_stage1.png", "Sun_Glower_stage2.png",
        "breadfruit_stage1.png", "breadfruit_stage2.png",
        "broccoli_stage1.png", "broccoli_stage2.png",
        "carrot_stage1.png", "carrot_stage2.png",
        "candycorn_stage1.png", "candycorn_stage2.png",
        "cauliflower_stage1.png", "cauliflower_stage2.png",
        "celerey_stage1.png", "celerey_stage2.png",
        "coffee_stage1.png", "coffee_stage2.png",
        "corpseflower_stage1.png", "corpseflower_stage2.png",
        "dragonfruit_stage1.png", "dragonfruit_stage2.png",
        "garlic_stage1.png", "garlic_stage2.png",
        "limabean_stage1.png", "limabean_stage2.png",
        "meatflower_stage1.png", "meatflower_stage2.png",
        "onion_stage1.png", "onion_stage2.png",
        "potato_stage1.png", "potato_stage2.png",
        "sampaguita_stage1.png", "sampaguita_stage2.png",
    ], "crops")
    n += slice_named("Crops2.plist", "Crops2.png", [
        "Tomato_stage1.png", "Tomato_stage2.png",
        "corn_stage1.png", "corn_stage2.png",
        "eyebiscus_stage1.png", "eyebiscus_stage2.png",
        "heartichoke_stage1.png", "heartichoke_stage2.png",
        "turnip_stage1.png", "turnip_stage2.png",
        "venusflytrap_stage1.png", "venusflytrap_stage2.png",
    ], "crops")
    n += slice_named("starFruitCrop.plist", "starFruitCrop.png",
                     ["starfruit1_stage1.png", "starfruit1_stage2.png"], "crops")

    crop_out = os.path.join(OUT, "crops")

    def loose(src_name, out_name):
        nonlocal n
        Image.open(os.path.join(APP, src_name)).convert("RGBA").save(
            os.path.join(crop_out, out_name))
        n += 1

    # Event crops distributed as loose stage images rather than atlas frames.
    for src, dst in [
        ("holly_crop_stage1.png", "holly_stage1.png"),
        ("holly_crop_stage2.png", "holly_stage2.png"),
        ("FireCracker_Crop_baby.png", "firecracker_stage1.png"),
        ("FireCracker_Crop_bloom.png", "firecracker_stage2.png"),
        ("KELP_CROP_1.png", "kelp_stage1.png"),
        ("KELP_CROP_2.png", "kelp_stage2.png"),
        ("WATER_LILLY_CROP_1.png", "water_lily_stage1.png"),
        ("WATER_LILLY_CROP_2.png", "water_lily_stage2.png"),
        ("Dia_DeLos_Muerte_MarigoldSeed.png", "marigold_stage1.png"),
        ("Dia_DeLos_Muerte_MarigoldHarvestable.png", "marigold_stage2.png"),
    ]:
        loose(src, dst)

    # These three event crops keep both growth frames in one loose sheet.
    sheets = [
        ("tex2005.png", ((1, 1, 190, 92), (1, 94, 189, 332)), "cupcakes"),
        ("eggplant.png", ((0, 0, 192, 128), (0, 128, 192, 256)), "eggplant"),
        ("rainbowCrop.png", ((0, 139, 189, 229), (0, 0, 189, 135)), "rainbow"),
    ]
    for src_name, boxes, stem in sheets:
        sheet = Image.open(os.path.join(APP, src_name)).convert("RGBA")
        for stage, box in enumerate(boxes, 1):
            sheet.crop(box).save(os.path.join(crop_out, f"{stem}_stage{stage}.png"))
            n += 1
    print(f"crops: sliced {n} crop-stage sprites")


def slice_crop_icons():
    """Copy the source Market's standalone produce sprites.

    plants.json receives each authoritative sprite filename from prep_market.py.
    These small icons are used by Market cards and harvest pickups; crop stage art
    remains exclusive to planted farm plots.
    """
    plants = json.load(open(os.path.join(OUT, "plants.json"), encoding="utf-8"))
    icon_out = os.path.join(OUT, "crop-icons")
    os.makedirs(icon_out, exist_ok=True)
    n = 0
    for plant in plants:
        name = plant.get("icon")
        if not name:
            continue
        src = os.path.join(APP, name)
        if not os.path.isfile(src):
            print("   missing crop icon:", name)
            continue
        Image.open(src).convert("RGBA").save(os.path.join(icon_out, name))
        n += 1
    print(f"crop icons: copied {n} standalone Market sprites")


# Storage-menu chrome from Storage.png: the wooden bar, the red STORAGE banner,
# per-tab grass/flower flanks (items/pet/gift), and item/pet slot frames.
STORAGE_FRAMES = [
    "paper_items.png", "board_storage.png",
    "board_items_left.png", "board_item_right.png",
    "board_pet_left.png", "board_pet_right.png",
    "board_gift_left.png", "board_gift_right.png",
    "storage_frame.png", "petstorage_frame.png",
]


def slice_storage():
    n = slice_named("Storage.plist", "Storage.png", STORAGE_FRAMES, "ui/storage")
    print(f"storage: sliced {n} UI pieces")


# ------------------------------------------------------- zombie compositing
# Zombies use a skeletal rig. Two gotchas learned the hard way:
#  1. A zombie's *_default.plist can contain parts for MULTIPLE units (e.g. the
#     Omega variant). Only composite the parts listed in the unit's `assets`.
#  2. Face parts (eyes/jaw/teeth/scar/features) are CHILDREN of the Head slot, so
#     their offsets are relative to the head — add the head's offset.
# `inheritColor` parts are grey base art tinted by the unit's marketInfo.color.
FACE_SLOTS = {
    "EyeL", "EyeR", "Jaw", "JawFeature", "UpperTeeth", "LowerTeeth",
    "Scar", "Features", "Features2", "Features3", "Hat",
}


def inherited_head_offset():
    """The named plists omit Head when they inherit the ordinary zombie skull.

    Their facial attachment offsets remain head-local, so use the base model's
    authored neck instead of incorrectly parenting those parts to actor origin.
    Returned in the source rig's Y-up coordinates.
    """
    models = json.load(open(os.path.join(OUT, "zombie", "models.json")))
    neck = models["ZombieActorRegularTier1"]["neck"]
    return neck["x"], -neck["y"]


def _tint(im, rgb):
    r, g, b = rgb
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            pr, pg, pb, pa = px[x, y]
            if pa:
                px[x, y] = (pr * r // 255, pg * g // 255, pb * b // 255, pa)
    return im


# Slots that belong to the head (tilt together). Face parts (all but Head) are
# positioned relative to the head, so their offsets get the head's offset added.
HEAD_SLOTS = {"Head", *FACE_SLOTS}

# ---------------------------------------------------------------------------
# Faces the ordinary skeleton must not show through
# ---------------------------------------------------------------------------
# A named actor's plist is a DELTA over the regular skeleton, and most of them
# replace Head (and sometimes Jaw) without replacing the separate EyeL/EyeR/teeth/
# scar attachments. For an actor whose head art already has a complete face drawn on
# it, compositing those inherited parts stacks a second face on top of the authored
# one — the reported "Zombug has the default eyes over its model" (its plist supplies
# Head + Jaw only, so the default eyeballs landed on the bug's own compound eyes).
#
# The RUNTIME rig has always handled this: these three sets MIRROR, by catalog key,
# COMPLETE_SPECIAL_FACES / DEFAULT_FACE_SLOTS / MASKED_FACE_SLOTS in src/assets.ts
# (the masked-actor membership itself lives in src/zombie/mutationVisual.ts). The
# baked PORTRAIT did not, which is why a Zombug looked right on the farm and wrong on
# every card that shows the PNG — the rewards screen and Received. Pinned against the
# runtime lists by src/zombie/specialPortrait.test.ts.
COMPLETE_SPECIAL_FACE_KEYS = {
    "ZombieActorZombug",
    "ZombieActorZwampThing",
    "ZombieActorMasterNinjombie",
    "ZombieActorNinjombie",
    "ZombieActorMerZombie",
    "ZombieActorProto",
    "ZombieActorZombieBot",
    "ZombieActorOmegaZombieBot",
    "ZombieActorZomtar",
    "ZombieActorZomdini",
}
MASKED_FACE_KEYS = {
    "ZombieActorOldMcZombie",
    "ZombieActorZastronaut",
    "ZombieActorZosmonaut",
    "ZombieActorForest",
}
DEFAULT_FACE_SLOTS = {"EyeL", "EyeR", "UpperTeeth", "LowerTeeth", "Scar", "Jaw"}
MASKED_FACE_SLOTS = {"LowerTeeth"}

NAMED_SPECIAL_ZOMBIES = [
    ("Bombie", "bombie", "ZombieActorBombie"),
    ("Brock Coley", "brock_coley", "ZombieActorBrockColey"),
    ("Dapper Zombie", "dapper_zombie", "ZombieActorDapper"),
    ("Deputy Zombie", "deputy_zombie", "ZombieActorDeputy"),
    ("Dr. Zombie", "dr_zombie", "ZombieActorDrZombie"),
    ("Forest Zombie", "forest_zombie", "ZombieActorForest"),
    ("George Washington", "george_washington", "ZombieActorGeorgeWashington"),
    ("Granny Zombie", "granny_zombie", "ZombieActorGranny"),
    ("John Hancock", "john_hancock", "ZombieActorJohnHancock"),
    ("Madame Zombie", "madame_zombie", "ZombieActorMadame"),
    ("Master Ninjombie", "master_ninjombie", "ZombieActorMasterNinjombie"),
    ("Medusa Zombie", "medusa_zombie", "ZombieActorMedusa"),
    ("MerZombie", "merzombie", "ZombieActorMerZombie"),
    ("Mummy Zombie", "mummy_zombie", "ZombieActorMummy"),
    ("Ninjombie", "ninjombie", "ZombieActorNinjombie"),
    ("Old McZombie", "old_mczombie", "ZombieActorOldMcZombie"),
    ("Omega Dr. Zombie", "omega_dr_zombie", "ZombieActorOmegaDrZombie"),
    ("Omega Zombie Bot", "omega_zombie_bot", "ZombieActorOmegaZombieBot"),
    ("Poseidon Zombie", "poseidon_zombie", "ZombieActorPoseidon"),
    ("Proto Zombie", "proto_zombie", "ZombieActorProto"),
    ("Sheriff Zombie", "sheriff_zombie", "ZombieActorSheriff"),
    ("Skittles Zombie", "skittles_zombie", "ZombieActorSkittles"),
    ("Zastronaut", "zastronaut", "ZombieActorZastronaut"),
    ("ZomBetty", "zombetty", "ZombieActorZomBetty"),
    ("ZomBloke", "zombloke", "ZombieActorZomBloke"),
    ("ZomHelga", "zomhelga", "ZombieActorZomHelga"),
    ("Zombeach Bum", "zombeach_bum", "ZombieActorZombeachBum"),
    ("Zombie Bot", "zombie_bot", "ZombieActorZombieBot"),
    ("Zombug", "zombug", "ZombieActorZombug"),
    ("Zomdini", "zomdini", "ZombieActorZomdini"),
    ("Zomtar", "zomtar", "ZombieActorZomtar"),
    ("Zula Girl", "zula_girl", "ZombieActorZulaGirl"),
    ("Zwamp Thing", "zwamp_thing", "ZombieActorZwampThing"),
    ("Bandido Zombie", "bandido_zombie", "ZombieActorBandido"),
    ("Vagabond Zombie", "vagabond_zombie", "ZombieActorVagabond"),
    ("Captain Zombie", "captain_zombie", "ZombieActorCaptain"),
    ("Admiral Zombie", "admiral_zombie", "ZombieActorAdmiral"),
    ("Christmas Ghost Zombie", "christmas_ghost_zombie", "ZombieActorChristmasGhost"),
    ("Scrooge Zombie", "scrooge_zombie", "ZombieActorScrooge"),
    ("Diva Zombie", "diva_zombie", "ZombieActorDiva"),
]

# ---------------------------------------------------------------------------
# Video Game Zombie — the one playable zombie that is NOT a paper-doll rig
# ---------------------------------------------------------------------------
# The pixel zombie of the "Zombies vs Video Games" invasion (VideoGameZombie.plist)
# is a seven-frame flipbook — four idle, three attack — with no body parts to hang
# a head-nod or an arm-swing on. As a playable species it is shipped through the
# same special-zombie atlas as the named actors, but its manifest is COMPLETE
# (`complete: true` — nothing of the ordinary skeleton is inherited) and carries a
# `flipbook` block that the farm and raid rigs step through instead of posing bones.
# Every frame is written to one shared box (the union of all seven on the plist's
# 96x96 source canvas), so swapping textures never shifts the feet. Runtime:
# src/assets.ts mergeSpecialZombieModel,
# src/zombie/ZombieUnit.ts, src/raid/RaidActor.ts.
VIDEO_GAME_ZOMBIE = ("video_game_zombie", "ZombieActorRegularVideoGame")
VIDEO_GAME_ZOMBIE_IDLE = ["zombie_idle_fr00.png", "zombie_idle_fr01.png",
                          "zombie_idle_fr02.png", "zombie_idle_fr03.png"]
VIDEO_GAME_ZOMBIE_ATTACK = ["zombie_attack_fr00.png", "zombie_attack_fr01.png",
                            "zombie_attack_fr02.png"]
# The source frame is 94px tall; a Regular rig stands ~82 units. Same height as the
# ordinary zombies it files with (group Regular), so the farm scale is the family's.
VIDEO_GAME_ZOMBIE_SCALE = 0.87
# The sprite's own green (its most common opaque pixel). Nothing is tinted with it —
# the frames are drawn in colour — but it is what a Pot child inherits as its colour
# and what the roster card swatches.
VIDEO_GAME_ZOMBIE_COLOR = [0, 192, 0]
VIDEO_GAME_ZOMBIE_FPS = 4  # matches the raid enemy's idle cadence (RaidScene frameActor)


def export_video_game_zombie():
    """Write the pixel zombie's untrimmed frames + a complete flipbook manifest, and
    bake its card portrait."""
    stem, catalog_key = VIDEO_GAME_ZOMBIE
    plist = load_plist(os.path.join(APP, "VideoGameZombie.plist"))["frames"]
    atlas = Image.open(os.path.join(APP, "VideoGameZombie.png")).convert("RGBA")
    folder = os.path.join(OUT, "zombie", stem)
    os.makedirs(folder, exist_ok=True)

    def untrimmed(frame_name):
        f = plist[frame_name]
        sw, sh = rect("{{0,0}," + f["spriteSourceSize"] + "}")[2:]
        x, y, w, h = rect(f["textureRect"])
        rotated = f.get("textureRotated", False)
        cw, ch = (h, w) if rotated else (w, h)
        piece = atlas.crop((x, y, x + cw, y + ch))
        if rotated:
            piece = piece.rotate(-90, expand=True)
        ox, oy = rect(f["spriteColorRect"])[:2]
        canvas = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
        canvas.alpha_composite(piece, (ox, oy))
        return canvas

    # Every frame is cut to ONE shared box — the union of all seven frames' opaque
    # pixels on the 96x96 source canvas — so the strip keeps its feet planted when a
    # texture swaps, and the rig's bounds (hit box, raid contain-fit) are the zombie
    # rather than the source canvas's transparent margins.
    frames = {name: untrimmed(name) for name in VIDEO_GAME_ZOMBIE_IDLE + VIDEO_GAME_ZOMBIE_ATTACK}
    boxes = [im.getbbox() for im in frames.values()]
    union = (min(b[0] for b in boxes), min(b[1] for b in boxes),
             max(b[2] for b in boxes), max(b[3] for b in boxes))
    idle_files, attack_files = [], []
    for i, name in enumerate(VIDEO_GAME_ZOMBIE_IDLE):
        frames[name].crop(union).save(os.path.join(folder, f"idle-{i}.png"))
        idle_files.append(f"idle-{i}.png")
    for i, name in enumerate(VIDEO_GAME_ZOMBIE_ATTACK):
        frames[name].crop(union).save(os.path.join(folder, f"attack-{i}.png"))
        attack_files.append(f"attack-{i}.png")

    first = Image.open(os.path.join(folder, idle_files[0]))
    # Feet on the origin: the shared box's bottom edge is the sole line, and its
    # horizontal anchor is the standing frame's centre of mass so the idle loop stands
    # on the spot (the attack frames lean forward by a few pixels, as authored).
    idle_box = frames[VIDEO_GAME_ZOMBIE_IDLE[0]].getbbox()
    ax = round(((idle_box[0] + idle_box[2]) / 2 - union[0]) / first.width, 3)
    ay = 1.0
    manifest = {
        "name": stem,
        "neck": inherited_head_offset_pixi(),
        "color": VIDEO_GAME_ZOMBIE_COLOR,
        "complete": True,
        # One part: the current frame, feet on the origin (anchor bottom-centre).
        "parts": [{
            "file": idle_files[0], "group": "root", "px": 0, "py": 0,
            "ax": ax, "ay": ay, "z": 3, "scale": VIDEO_GAME_ZOMBIE_SCALE,
        }],
        "flipbook": {"idle": idle_files, "attack": attack_files, "fps": VIDEO_GAME_ZOMBIE_FPS},
    }
    json.dump(manifest, open(os.path.join(folder, "manifest.json"), "w"), indent=1)

    # Portrait: same canvas + feet origin as composite_zombie, NEAREST so the pixels
    # stay square on the card.
    W, H, cx, cy = 180, 200, 90, 165
    s = VIDEO_GAME_ZOMBIE_SCALE
    fw, fh = max(1, round(first.width * s)), max(1, round(first.height * s))
    scaled = first.resize((fw, fh), Image.Resampling.NEAREST)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas.alpha_composite(scaled, (round(cx - ax * fw), round(cy - fh)))
    out_name = stem + ".png"
    canvas.save(os.path.join(OUT, "zombie", out_name))
    json.dump({"anchorX": cx / W, "anchorY": cy / H, "w": W, "h": H},
              open(os.path.join(OUT, "zombie", out_name + ".json"), "w"))
    portrait_dir = os.path.join(OUT, "zombie", "portrait")
    os.makedirs(portrait_dir, exist_ok=True)
    shutil.copy2(os.path.join(OUT, "zombie", out_name),
                 os.path.join(portrait_dir, catalog_key + ".png"))
    print(f"zombie: exported {catalog_key} ({len(idle_files)} idle + {len(attack_files)} attack frames)")


# ---------------------------------------------------------------------------
# Derived flipbooks — a pixel zombie's palette swap
# ---------------------------------------------------------------------------
# The pixel zombie is drawn in exactly four colours (body green, black ink, cream
# eyes/teeth, brown trousers), so its "elite" form is what a game's own would be: the
# same seven frames under a different palette, mapped colour for colour. The manifest
# is the base's under a new name and swatch colour; everything about how it stands,
# animates and fits (scale, anchor, fps) is inherited, so the two file identically.
DERIVED_FLIPBOOK_ZOMBIES = [
    # The Video Games' promoted (Brain Ticket) prize, the way a final boss is the same
    # sprite in a stronger colour: royal purple body, gold eyes and teeth, charcoal
    # trousers. Ink stays black.
    {
        "stem": "final_boss_zombie", "key": "ZombieActorRegularFinalBoss",
        "base": "video_game_zombie",
        "palette": {
            (0, 192, 0): (146, 46, 214),       # body green -> royal purple
            (254, 223, 150): (255, 208, 64),   # cream eyes / teeth -> gold
            (99, 63, 0): (52, 42, 72),         # brown trousers -> charcoal
        },
    },
]


def _swap_palette(im, palette):
    """Map exact RGB values, leaving alpha alone; any colour not in the map (the ink)
    is untouched. A 4-colour sprite is a lookup, not a hue shift."""
    out = im.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a and (r, g, b) in palette:
                px[x, y] = (*palette[(r, g, b)], a)
    return out


def derive_flipbook_zombies():
    """Write each derived flipbook's recoloured frames + manifest from its base's OUT
    folder, and bake its portrait exactly as the base's was (NEAREST, feet origin)."""
    for spec in DERIVED_FLIPBOOK_ZOMBIES:
        src = os.path.join(OUT, "zombie", spec["base"])
        dst = os.path.join(OUT, "zombie", spec["stem"])
        os.makedirs(dst, exist_ok=True)
        manifest = json.load(open(os.path.join(src, "manifest.json")))
        manifest["name"] = spec["stem"]
        files = list(dict.fromkeys(
            [p["file"] for p in manifest["parts"]]
            + manifest["flipbook"]["idle"] + manifest["flipbook"]["attack"]))
        for file in files:
            _swap_palette(Image.open(os.path.join(src, file)).convert("RGBA"), spec["palette"]) \
                .save(os.path.join(dst, file))
        # The swatch colour is what the body green became.
        base_colour = tuple(manifest["color"])
        manifest["color"] = list(spec["palette"].get(base_colour, base_colour))
        json.dump(manifest, open(os.path.join(dst, "manifest.json"), "w"), indent=1)

        part = manifest["parts"][0]
        first = Image.open(os.path.join(dst, part["file"])).convert("RGBA")
        W, H, cx, cy = 180, 200, 90, 165
        s = part.get("scale", 1)
        fw, fh = max(1, round(first.width * s)), max(1, round(first.height * s))
        scaled = first.resize((fw, fh), Image.Resampling.NEAREST)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(scaled, (round(cx - part["ax"] * fw), round(cy - fh)))
        out_name = spec["stem"] + ".png"
        canvas.save(os.path.join(OUT, "zombie", out_name))
        json.dump({"anchorX": cx / W, "anchorY": cy / H, "w": W, "h": H},
                  open(os.path.join(OUT, "zombie", out_name + ".json"), "w"))
        portrait_dir = os.path.join(OUT, "zombie", "portrait")
        os.makedirs(portrait_dir, exist_ok=True)
        shutil.copy2(os.path.join(OUT, "zombie", out_name),
                     os.path.join(portrait_dir, spec["key"] + ".png"))
        print(f"zombie: derived flipbook {spec['key']} from {spec['base']} ({len(files)} frames)")


def inherited_head_offset_pixi():
    """The ordinary neck in the runtime's Y-down space (what a manifest stores)."""
    x, y_up = inherited_head_offset()
    return {"x": x, "y": -y_up}


def export_zombie_parts(entry_name, name):
    """Export a zombie's individual parts + a manifest so it can be assembled and
    animated at runtime (head tilt, leg walk)."""
    z = load_plist(os.path.join(APP, "Zombies.plist"))["Entries"][entry_name]
    rig = load_plist(os.path.join(APP, z["frameListFile"]))
    atlas = Image.open(os.path.join(APP, z["spriteSheetFile"])).convert("RGBA")
    color = z["marketInfo"].get("color", [255, 255, 255])
    # rightOnly is the authored mirror-facing alternate for the same attachment;
    # the runtime mirrors the assembled actor, so exporting both would stack two
    # bodies (most visibly, both Skittles candies) into one pose.
    assets = [a for a in z["assets"] if a.get("assetKey") and a.get("attachmentID")
              and not a.get("rightOnly")]
    slot = {a["assetKey"]: a["attachmentID"].replace("kActorPartTag", "") for a in assets}
    inherit = {a["assetKey"]: a.get("inheritColor", False) for a in assets}

    def lay(k):
        fn = k if k.endswith(".png") else k + ".png"
        return rig.get(fn) or rig.get(k)

    head = inherited_head_offset()
    for k in slot:
        if slot[k] == "Head":
            L = lay(k)
            if L:
                head = (L["offsetX"], L["offsetY"])

    outdir = os.path.join(OUT, "zombie", name)
    os.makedirs(outdir, exist_ok=True)
    parts = []
    for a in assets:
        k = a["assetKey"]
        L = lay(k)
        if not L:
            continue
        s = slot[k]
        ox, oy = L["offsetX"], L["offsetY"]
        if s in HEAD_SLOTS and s != "Head":
            ox += head[0]
            oy += head[1]  # face parts are relative to the head
        x, y, w, h = L["x"], L["y"], L["width"], L["height"]
        part = atlas.crop((x, y, x + w, y + h))
        if inherit.get(k):
            part = _tint(part, color)
        fname = s + ".png"
        part.save(os.path.join(outdir, fname))
        group = ("head" if s in HEAD_SLOTS
                 else "footF" if s == "FootF" else "footB" if s == "FootB" else "root")
        parts.append({
            "file": fname, "group": group,
            "px": ox, "py": -oy,  # placement in root coords (Y-down)
            "ax": L["pivotX"], "ay": 1 - L["pivotY"], "z": L.get("z", 0),
            "scale": a.get("scale", 1),
        })
    manifest = {
        "name": name,
        "neck": {"x": head[0], "y": -head[1]},
        "color": color,
        # The source flags Bombie as a floating head, but the playable crop uses
        # that bomb head on the standard headless-zombie body.
        "floatingHead": False if entry_name == "Bombie"
                        else bool(z.get("floatingHead", False)),
        "parts": parts,
    }
    json.dump(manifest, open(os.path.join(outdir, "manifest.json"), "w"), indent=1)
    print(f"zombie parts: {len(parts)} parts for {entry_name} -> zombie/{name}/")


def composite_zombie(entry_name, out_name, catalog_key=None):
    z = load_plist(os.path.join(APP, "Zombies.plist"))["Entries"][entry_name]
    rig = load_plist(os.path.join(APP, z["frameListFile"]))
    atlas = Image.open(os.path.join(APP, z["spriteSheetFile"])).convert("RGBA")
    color = z["marketInfo"].get("color", [255, 255, 255])
    assets = [a for a in z["assets"] if a.get("assetKey") and a.get("attachmentID")
              and not a.get("rightOnly")]
    slot = {a["assetKey"]: a["attachmentID"].replace("kActorPartTag", "") for a in assets}
    inherit = {a["assetKey"]: a.get("inheritColor", False) for a in assets}

    def lay(k):
        fn = k if k.endswith(".png") else k + ".png"
        return rig.get(fn) or rig.get(k)

    head = inherited_head_offset()
    for k in slot:
        if slot[k] == "Head":
            L = lay(k)
            if L:
                head = (L["offsetX"], L["offsetY"])

    # Named actor definitions are attachment DELTAS over an ordinary skeleton,
    # not complete bodies. Bombie uses the headless Tier-1 body; other specials
    # use the regular Tier-1 body. Remove only the slots replaced by this actor.
    models = json.load(open(os.path.join(OUT, "zombie", "models.json")))
    frames = json.load(open(os.path.join(OUT, "zombie", "frames.json")))
    base_sheet = Image.open(os.path.join(OUT, "zombie", "ZombieSheet.png")).convert("RGBA")
    base = models["ZombieActorHeadlessTier1" if entry_name == "Bombie"
                  else "ZombieActorRegularTier1"]
    base_head = (base["neck"]["x"], -base["neck"]["y"])
    head_dx, head_dy = head[0] - base_head[0], head[1] - base_head[1]
    replaced = set(slot.values())
    # Same three rules the runtime rig applies (see the sets above). `own_jaw` is the
    # Dapper Zombie case: an actor bringing its own jaw brings its own mouth line, and
    # the default lower teeth are placed against the DEFAULT jaw shape.
    complete_face = catalog_key in COMPLETE_SPECIAL_FACE_KEYS
    masked_face = catalog_key in MASKED_FACE_KEYS
    own_jaw = "Jaw" in replaced
    items = []
    if entry_name == "Bombie" or not z.get("floatingHead", False):
        for p in base["parts"]:
            base_slot = p["file"].removeprefix("default")
            if base_slot in replaced:
                continue
            if complete_face and base_slot in DEFAULT_FACE_SLOTS:
                continue
            if masked_face and base_slot in MASKED_FACE_SLOTS:
                continue
            if own_jaw and base_slot == "LowerTeeth":
                continue
            f = frames[p["file"]]
            part = base_sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
            if p.get("tint"):
                part = _tint(part, color)
            px = p["px"] + (head_dx if p["group"] == "head" and "Head" in replaced else 0)
            py = -p["py"] + (head_dy if p["group"] == "head" and "Head" in replaced else 0)
            items.append((p["z"], part, px, py, p["ax"], 1 - p["ay"], 1))
    for a in assets:
        k = a["assetKey"]
        L = lay(k)
        if not L:
            continue
        ox, oy = L["offsetX"], L["offsetY"]
        if slot[k] in FACE_SLOTS and slot[k] != "Head":
            ox += head[0]
            oy += head[1]  # parent face parts to the head
        x, y, w, h = L["x"], L["y"], L["width"], L["height"]
        part = atlas.crop((x, y, x + w, y + h))
        if inherit.get(k):
            part = _tint(part, color)
        items.append((L.get("z", 0), part, ox, oy, L["pivotX"], L["pivotY"], a.get("scale", 1)))
    items.sort(key=lambda t: t[0])

    W, H, cx, cy = 180, 200, 90, 165  # origin (feet) at (cx, cy)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for _, part, ox, oy, pivot_x, pivot_y, scale in items:
        if scale != 1:
            part = part.resize((max(1, round(part.width * scale)),
                                max(1, round(part.height * scale))), Image.Resampling.LANCZOS)
        w, h = part.size
        canvas.alpha_composite(
            part, (round(cx + ox - pivot_x * w), round(cy - oy - (1 - pivot_y) * h))
        )
    os.makedirs(os.path.join(OUT, "zombie"), exist_ok=True)
    canvas.save(os.path.join(OUT, "zombie", out_name))
    json.dump({"anchorX": cx / W, "anchorY": cy / H, "w": W, "h": H},
              open(os.path.join(OUT, "zombie", out_name + ".json"), "w"))
    print(f"zombie: composited {entry_name} -> {out_name}")


# ---------------------------------------------------------------------------
# Derived specials — recolours of an existing named actor
# ---------------------------------------------------------------------------
# A derived actor has no source plist. Its attachments are the BASE actor's, re-hued
# per pixel class, and its manifest is the base manifest under a new name, so it rigs,
# animates and masks exactly like its parent. The recolour keeps every pixel's own
# brightness (V): the authored shading and the ink outline survive, and only hue /
# saturation (and, for the glass, opacity) move.
#
# Pixel classes on a Zastronaut-shaped actor:
#   line    the ink outline (V < 0.17) — never touched
#   visor   Features.png only: the translucent or blue-leaning paint (the glass)
#   helmet  Features.png: everything else (the shell)
#   boot    Foot*.png: the green boots
#   suit    everything else that is near-neutral — the white fabric AND its grey fold
#           shadows right down to the outline. Capping this class at a brightness left
#           grey speckles across a recoloured suit.
# Each class maps to (target rgb, saturation strength, value multiplier, alpha multiplier).
DERIVED_SPECIAL_ZOMBIES = [
    # The Aliens' promoted (Brain Ticket) prize: the Zastronaut in a rust launch suit
    # under a charcoal helmet with a near-black plate that the face still reads
    # through, and black boots to match the helmet. Picked from a sheet of recolours on
    # 2026-09-07 (src/raid/zombieDrops.ts).
    {
        "stem": "zosmonaut", "key": "ZombieActorZosmonaut", "base": "zastronaut",
        "recolour": {
            "suit":   ((200, 70, 30), 1.0, 0.85, 1.0),
            "helmet": ((60, 60, 70), 0.3, 0.4, 1.0),
            "visor":  ((50, 45, 60), 0.35, 0.42, 1.12),
            "boot":   ((40, 40, 45), 0.3, 0.6, 1.0),
        },
    },
]


def _pixel_class(part_file, r, g, b, a):
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if v < 0.17:
        return "line"
    if part_file == "Features.png":
        if a < 250 or (0.5 < h < 0.72 and s > 0.08):
            return "visor"
        return "helmet"
    if part_file.startswith("Foot") and 0.18 < h < 0.48 and s > 0.3:
        return "boot"
    if s < 0.2:
        return "suit"
    return "other"


def _push_colour(px, target, sat=1.0, value_mul=1.0, alpha_mul=1.0):
    """Re-hue one pixel toward `target`, keeping its own shading (V)."""
    r, g, b, a = px
    th, ts, _ = colorsys.rgb_to_hsv(*[c / 255 for c in target])
    _, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    v = max(0.0, min(1.0, v * value_mul))
    s = s + (ts - s) * sat
    rr, gg, bb = colorsys.hsv_to_rgb(th, s, v)
    return (int(rr * 255), int(gg * 255), int(bb * 255), min(255, int(a * alpha_mul)))


def _recolour_part(part_file, im, spec):
    im = im.convert("RGBA").copy()
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            p = px[x, y]
            if p[3] < 4:
                continue
            k = _pixel_class(part_file, *p)
            if k in spec:
                px[x, y] = _push_colour(p, *spec[k])
    return im


def composite_from_manifest(stem, catalog_key):
    """Bake a card portrait for an actor that lives only as an OUT manifest + parts
    (no source plist): the ordinary Regular skeleton, tinted the actor's colour, with the
    actor's attachments over it — the same slot/face rules composite_zombie applies, on
    the same 180x200 canvas with the feet at (90,165)."""
    folder = os.path.join(OUT, "zombie", stem)
    manifest = json.load(open(os.path.join(folder, "manifest.json")))
    models = json.load(open(os.path.join(OUT, "zombie", "models.json")))
    frames = json.load(open(os.path.join(OUT, "zombie", "frames.json")))
    base_sheet = Image.open(os.path.join(OUT, "zombie", "ZombieSheet.png")).convert("RGBA")
    base = models[manifest.get("base", "ZombieActorRegularTier1")]
    replaced = {p["file"].removesuffix(".png") for p in manifest["parts"]}
    complete_face = catalog_key in COMPLETE_SPECIAL_FACE_KEYS
    masked_face = catalog_key in MASKED_FACE_KEYS
    own_jaw = "Jaw" in replaced
    items = []
    for p in base["parts"]:
        base_slot = p["file"].removeprefix("default")
        if base_slot in replaced:
            continue
        if complete_face and base_slot in DEFAULT_FACE_SLOTS:
            continue
        if masked_face and base_slot in MASKED_FACE_SLOTS:
            continue
        if own_jaw and base_slot == "LowerTeeth":
            continue
        f = frames[p["file"]]
        part = base_sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
        if p.get("tint"):
            part = _tint(part, manifest["color"])
        items.append((p["z"], part, p["px"], p["py"], p["ax"], p["ay"], p.get("scale", 1)))
    for p in manifest["parts"]:
        part = Image.open(os.path.join(folder, p["file"])).convert("RGBA")
        items.append((p["z"], part, p["px"], p["py"], p["ax"], p["ay"], p.get("scale", 1)))
    items.sort(key=lambda t: t[0])
    W, H, cx, cy = 180, 200, 90, 165
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for _, part, px, py, ax, ay, scale in items:
        if scale != 1:
            part = part.resize((max(1, round(part.width * scale)),
                                max(1, round(part.height * scale))), Image.Resampling.LANCZOS)
        w, h = part.size
        canvas.alpha_composite(part, (round(cx + px - ax * w), round(cy + py - ay * h)))
    out_name = stem + ".png"
    canvas.save(os.path.join(OUT, "zombie", out_name))
    json.dump({"anchorX": cx / W, "anchorY": cy / H, "w": W, "h": H},
              open(os.path.join(OUT, "zombie", out_name + ".json"), "w"))
    portrait_dir = os.path.join(OUT, "zombie", "portrait")
    os.makedirs(portrait_dir, exist_ok=True)
    shutil.copy2(os.path.join(OUT, "zombie", out_name),
                 os.path.join(portrait_dir, catalog_key + ".png"))


def derive_special_zombies():
    """Write each derived actor's recoloured parts + manifest from its base's OUT
    folder, and bake its portrait. Runs after the named actors are exported, so the
    base is always the freshly exported one."""
    for spec in DERIVED_SPECIAL_ZOMBIES:
        src = os.path.join(OUT, "zombie", spec["base"])
        dst = os.path.join(OUT, "zombie", spec["stem"])
        os.makedirs(dst, exist_ok=True)
        manifest = json.load(open(os.path.join(src, "manifest.json")))
        manifest["name"] = spec["stem"]
        for part in manifest["parts"]:
            im = Image.open(os.path.join(src, part["file"]))
            _recolour_part(part["file"], im, spec["recolour"]).save(os.path.join(dst, part["file"]))
        json.dump(manifest, open(os.path.join(dst, "manifest.json"), "w"), indent=1)
        composite_from_manifest(spec["stem"], spec["key"])
        print(f"zombie: derived {spec['key']} from {spec['base']} ({len(manifest['parts'])} parts)")


# ---------------------------------------------------------------------------
# Cut specials — a zombie dressed in parts lifted from a raid enemy's art
# ---------------------------------------------------------------------------
# Like a derived actor, a cut actor has no source plist of its own. Its attachments are
# regions of an ENEMY strip (raids/enemies/parts/<key>.png), selected per pixel class
# inside one cell, mirrored to face right (enemies face left), and hung on the ordinary
# skeleton by an authored manifest. Everything not cut — skull, eyes, teeth, arms — is
# inherited and tinted the family's green, so it reads as a zombie in a costume.
#
# Each part's `select(cls, x, y)` says which classified pixels of the cell it keeps;
# the ink outline hugging a kept region rides along (dilated by one pixel) so the cut
# does not lose its edge. Positions are in the ordinary rig's space, Y down, feet at
# the origin — the same numbers models.json / a manifest use — and are a FIRST PASS
# meant to be tuned in tools/rig_studio.html, which lists every special.
def _clown_class(r, g, b, a):
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if v < 0.2:
        return "dark"
    if s < 0.15:
        return "white"
    if 0.45 < h < 0.56 and s > 0.3:
        return "cyan"
    if 0.56 <= h < 0.72:
        return "blue"
    if (h < 0.04 or h > 0.93) and s > 0.5:
        return "red"
    if 0.08 < h < 0.2 and s > 0.4:
        return "yellow"
    if 0.02 <= h <= 0.1:
        return "skin"
    return "other"


CUT_SPECIAL_ZOMBIES = [
    # The Zombozo: the Circus's little stacked clown (CircusStageActorMinion2, one cell
    # of the MidgetStack) as a Mini zombie — blue wig, red nose, striped shirt with its
    # pom-pom, red shoes. Proposed as the Circus invasion's rare zombie, 2026-09-07.
    {
        "stem": "zombozo", "key": "ZombieActorZombozo",
        # A Mini: laid over the Small skeleton so it inherits the Mini's face (the
        # Regular face plus its eyebrow feature), not the Regular's.
        "base": "ZombieActorSmallTier1",
        "source": os.path.join("raids", "enemies", "parts", "CircusStageActorMinion2.png"),
        "cell": (202, 2, 47, 51),
        "classify": _clown_class,
        "color": [194, 255, 95],   # the Small family's green (Zombricaun / Mini Zombie)
        "parts": [
            # wig: the cyan mass across the top of the cell (the pom-pom lower down is
            # cyan too, and belongs to the shirt)
            {"file": "Hat.png", "select": lambda c, x, y: c == "cyan" and y < 27,
             "group": "head", "px": 0, "py": -60, "ax": 0.5, "ay": 0.8, "z": 7, "scale": 1.25},
            # nose: the round red blob on the face, above the mouth (position tuned in the
            # Rig Studio, 2026-09-08)
            {"file": "Features.png", "select": lambda c, x, y: c == "red" and 10 <= y <= 21 and x < 20,
             "group": "head", "px": -11.455, "py": -41.248, "ax": 0.5, "ay": 0.5, "z": 6, "scale": 1.1},
            # shirt: the striped torso, the hand, and the pom-pom, between wig and shoes
            {"file": "Body.png", "select": lambda c, x, y: 27 <= y <= 43 and c in ("yellow", "white", "blue", "cyan", "skin", "other"),
             "group": "root", "px": 10, "py": -13, "ax": 0.63, "ay": 0.66, "z": 3, "scale": 1.8},
            # shoes: the ORDINARY zombie foot, recoloured clown-red, in the default foot's own
            # place — not a cut from the enemy art (the clown's shoes read as blobs at rig scale)
            {"file": "FootF.png", "frame": "defaultFootF", "recolour": ((205, 25, 40), 1.0, 0.95, 1.0),
             "group": "footF", "px": 16, "py": -8, "ax": 0.75, "ay": 0.1, "z": 2},
            {"file": "FootB.png", "frame": "defaultFootB", "recolour": ((205, 25, 40), 1.0, 0.95, 1.0),
             "group": "footB", "px": -1, "py": -8, "ax": 0.75, "ay": 0.1, "z": 1},
        ],
    },
]


def _cut_part(cell, classify, select, mirror=True):
    """The pixels of `cell` that `select` keeps, plus the outline touching them, cropped
    to their box. Returns (image, box) — box in cell coordinates, before mirroring."""
    w, h = cell.size
    px = cell.load()
    cls = {}
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if p[3] >= 8:
                cls[(x, y)] = classify(*p)
    keep = {xy for xy, c in cls.items() if select(c, *xy)}
    for (x, y) in list(keep):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                n = (x + dx, y + dy)
                if cls.get(n) == "dark":
                    keep.add(n)
    if not keep:
        raise SystemExit("cut selected no pixels")
    xs = [x for x, _ in keep]; ys = [y for _, y in keep]
    box = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
    out = Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), (0, 0, 0, 0))
    op = out.load()
    for (x, y) in keep:
        op[x - box[0], y - box[1]] = px[x, y]
    if mirror:
        out = out.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    return out, box


def _recoloured_frame(frame_name, recolour):
    """An ordinary ZombieSheet frame with every painted pixel (not the ink outline) pushed
    toward a colour — for a costume piece that is the default part in a different paint."""
    frames = json.load(open(os.path.join(OUT, "zombie", "frames.json")))
    sheet = Image.open(os.path.join(OUT, "zombie", "ZombieSheet.png")).convert("RGBA")
    f = frames[frame_name]
    im = sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"])).copy()
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            p = px[x, y]
            if p[3] < 8:
                continue
            _, _, v = colorsys.rgb_to_hsv(p[0] / 255, p[1] / 255, p[2] / 255)
            if v >= 0.17:
                px[x, y] = _push_colour(p, *recolour)
    return im


def cut_special_zombies():
    """Write each cut actor's parts + manifest from its enemy strip, and bake its portrait.
    A part with a `frame` instead of a `select` is an ordinary skeleton frame recoloured
    (see _recoloured_frame) rather than a cut."""
    for spec in CUT_SPECIAL_ZOMBIES:
        strip = Image.open(os.path.join(OUT, spec["source"])).convert("RGBA")
        cx, cy, cw, ch = spec["cell"]
        cell = strip.crop((cx, cy, cx + cw, cy + ch))
        dst = os.path.join(OUT, "zombie", spec["stem"])
        os.makedirs(dst, exist_ok=True)
        parts = []
        for part in spec["parts"]:
            if "frame" in part:
                im = _recoloured_frame(part["frame"], part["recolour"])
                print(f"    {part['file']:14} {im.width}x{im.height} = {part['frame']} recoloured")
            else:
                im, box = _cut_part(cell, spec["classify"], part["select"])
                print(f"    {part['file']:14} {im.width}x{im.height} from cell box {box}")
            im.save(os.path.join(dst, part["file"]))
            parts.append({k: v for k, v in part.items() if k not in ("select", "frame", "recolour")})
        manifest = {
            "name": spec["stem"],
            "neck": inherited_head_offset_pixi(),
            "color": spec["color"],
            "floatingHead": False,
            **({"base": spec["base"]} if spec.get("base") else {}),
            "parts": parts,
        }
        json.dump(manifest, open(os.path.join(dst, "manifest.json"), "w"), indent=1)
        composite_from_manifest(spec["stem"], spec["key"])
        print(f"zombie: cut {spec['key']} from {spec['source']} ({len(parts)} parts)")


def pack_special_zombies():
    """Pack all named-special attachments into one runtime atlas.

    Keeping the source manifests/PNGs split by actor is useful for inspection, but
    loading them directly would turn one startup fetch into hundreds. The runtime
    consumes this atlas plus the two compact JSON files instead.
    """
    atlas_w = 2048
    padding = 2
    x = y = padding
    row_h = 0
    frames = {}
    manifests = {}
    images = []
    packed = ([(stem, key) for _, stem, key in NAMED_SPECIAL_ZOMBIES] + [VIDEO_GAME_ZOMBIE]
              + [(d["stem"], d["key"]) for d in DERIVED_SPECIAL_ZOMBIES]
              + [(c["stem"], c["key"]) for c in CUT_SPECIAL_ZOMBIES]
              # Packed LAST so no existing atlas frame moves.
              + [(d["stem"], d["key"]) for d in DERIVED_FLIPBOOK_ZOMBIES])
    for stem, catalog_key in packed:
        folder = os.path.join(OUT, "zombie", stem)
        manifest = json.load(open(os.path.join(folder, "manifest.json")))
        manifests[catalog_key] = manifest
        # A flipbook's other frames are textures too, even though only the first is
        # a "part" — the runtime swaps them in on the same sprite.
        flipbook = manifest.get("flipbook", {})
        files = ([p["file"] for p in manifest["parts"]]
                 + flipbook.get("idle", []) + flipbook.get("attack", []))
        for file in dict.fromkeys(files):
            part = Image.open(os.path.join(folder, file)).convert("RGBA")
            if x + part.width + padding > atlas_w:
                x = padding
                y += row_h + padding
                row_h = 0
            key = f"{catalog_key}:{file}"
            frames[key] = {"x": x, "y": y, "w": part.width, "h": part.height}
            images.append((part, x, y))
            x += part.width + padding
            row_h = max(row_h, part.height)
    atlas_h = y + row_h + padding
    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    for part, px, py in images:
        atlas.alpha_composite(part, (px, py))
    folder = os.path.join(OUT, "zombie")
    atlas.save(os.path.join(folder, "SpecialZombieSheet.png"), optimize=True)
    json.dump(frames, open(os.path.join(folder, "special_frames.json"), "w"), separators=(",", ":"))
    json.dump(manifests, open(os.path.join(folder, "special_models.json"), "w"), separators=(",", ":"))
    print(f"special zombies: packed {len(images)} parts into {atlas_w}x{atlas_h} atlas")


# ------------------------------------------------------------------- rig layout
def export_rig():
    rig = load_plist(os.path.join(APP, "FarmerSprites.plist"))
    # keep only fields we use; drop anything without a layout
    clean = {}
    for k, v in rig.items():
        if not isinstance(v, dict):
            continue
        clean[k] = {
            "offsetX": v.get("offsetX", 0),
            "offsetY": v.get("offsetY", 0),
            "pivotX": v.get("pivotX", 0.5),
            "pivotY": v.get("pivotY", 0.5),
            "z": v.get("z", 0),
        }
    json.dump(clean, open(os.path.join(OUT, "rig_player.json"), "w"), indent=1)
    print(f"rig: exported layout for {len(clean)} parts")
    # log the default male farmer parts so the layering is inspectable
    parts = ["male_arm1", "male_arm3", "malebody1", "boot_back", "boot_front",
             "male_arm2", "male_arm4", "malehead1"]
    for p in parts:
        key = p + ".png"
        if key in clean:
            d = clean[key]
            print(f"    {p:12} z={d['z']} off=({d['offsetX']},{d['offsetY']}) "
                  f"pivot=({d['pivotX']},{d['pivotY']})")


# --------------------------------------------------------------- starter field
def make_field(ground_index, w=30, h=30, seed=7):
    rnd = random.Random(seed)
    grass_n = len(ground_index["grass"])
    tiles = []
    for row in range(h):
        line = []
        for col in range(w):
            # all grass; random variant per tile for subtle texture variety
            line.append({"terrain": "grass", "variant": rnd.randrange(grass_n)})
        tiles.append(line)
    field = {"w": w, "h": h, "tileW": TILE_W, "tileH": TILE_H,
             "start": {"col": w // 2, "row": h // 2}, "tiles": tiles}
    json.dump(field, open(os.path.join(OUT, "field_default.json"), "w"))
    print(f"field: {w}x{h} starter grid written")


if __name__ == "__main__":
    print("APP:", APP)
    assert os.path.isdir(APP), "extracted app bundle not found"
    idx = slice_ground()
    slice_player()
    slice_soil()
    slice_ui()
    make_composites()
    slice_crops()
    slice_crop_icons()
    slice_storage()
    portrait_dir = os.path.join(OUT, "zombie", "portrait")
    os.makedirs(portrait_dir, exist_ok=True)
    for source_name, file_stem, catalog_key in NAMED_SPECIAL_ZOMBIES:
        export_zombie_parts(source_name, file_stem)
        composite_zombie(source_name, file_stem + ".png", catalog_key)
        shutil.copy2(os.path.join(OUT, "zombie", file_stem + ".png"),
                     os.path.join(portrait_dir, catalog_key + ".png"))
    export_video_game_zombie()
    derive_flipbook_zombies()
    derive_special_zombies()
    cut_special_zombies()
    pack_special_zombies()
    export_rig()
    make_field(idx)
    print("done ->", OUT)
