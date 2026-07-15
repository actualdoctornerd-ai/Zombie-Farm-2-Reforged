"""
Asset-prep for the ZF2R field milestone.

Reads the extracted ZF2R 1.0 app bundle and produces clean PNGs + JSON under
zombiefarm/public/assets/ :

  ground/<terrain>_<variant>.png   sliced from tex0000.png (48x24 iso diamonds)
  player/<part>.png                sliced from playerSpriteSheet.png (cocos2d fmt 3)
  rig_player.json                  FarmerSprites.plist layout (offset/pivot/z per part)
  ground_index.json                terrain -> [variant filenames]
  field_default.json               a starter 30x30 terrain grid

Run:  python tools/prep_assets.py
"""
import os, re, io, json, plistlib, random
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


def slice_ground():
    src = os.path.join(APP, "tex0000.png")
    im = Image.open(src).convert("RGBA")
    cols = im.width // TILE_W
    rows = im.height // TILE_H
    index = {}
    for r in range(rows):
        terrain = GROUND_ROWS[r] if r < len(GROUND_ROWS) else f"terrain{r}"
        index[terrain] = []
        for c in range(cols):
            cell = im.crop((c * TILE_W, r * TILE_H,
                            c * TILE_W + TILE_W, r * TILE_H + TILE_H))
            name = f"{terrain}_{c}.png"
            cell.save(os.path.join(OUT, "ground", name))
            index[terrain].append(name)
    json.dump(index, open(os.path.join(OUT, "ground_index.json"), "w"), indent=1)
    print(f"ground: {rows} terrains x {cols} variants -> {rows*cols} tiles")
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
        "carrot_stage1.png", "carrot_stage2.png",
        "candycorn_stage1.png", "candycorn_stage2.png",
    ], "crops")
    n += slice_named("Crops2.plist", "Crops2.png",
                     ["corn_stage1.png", "corn_stage2.png"], "crops")
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
FACE_SLOTS = {"EyeL", "EyeR", "Jaw", "UpperTeeth", "LowerTeeth", "Scar", "Features"}


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
HEAD_SLOTS = {"Head", "EyeL", "EyeR", "Jaw", "UpperTeeth", "LowerTeeth", "Scar", "Features"}


def export_zombie_parts(entry_name, name):
    """Export a zombie's individual parts + a manifest so it can be assembled and
    animated at runtime (head tilt, leg walk)."""
    z = load_plist(os.path.join(APP, "Zombies.plist"))["Entries"][entry_name]
    rig = load_plist(os.path.join(APP, z["frameListFile"]))
    atlas = Image.open(os.path.join(APP, z["spriteSheetFile"])).convert("RGBA")
    color = z["marketInfo"].get("color", [255, 255, 255])
    slot = {a["assetKey"]: a["attachmentID"].replace("kActorPartTag", "") for a in z["assets"]}
    inherit = {a["assetKey"]: a.get("inheritColor", False) for a in z["assets"]}

    def lay(k):
        fn = k if k.endswith(".png") else k + ".png"
        return rig.get(fn) or rig.get(k)

    head = (0, 0)
    for k in slot:
        if slot[k] == "Head":
            L = lay(k)
            if L:
                head = (L["offsetX"], L["offsetY"])

    outdir = os.path.join(OUT, "zombie", name)
    os.makedirs(outdir, exist_ok=True)
    parts = []
    for a in z["assets"]:
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
        })
    manifest = {"name": name, "neck": {"x": head[0], "y": -head[1]}, "parts": parts}
    json.dump(manifest, open(os.path.join(outdir, "manifest.json"), "w"), indent=1)
    print(f"zombie parts: {len(parts)} parts for {entry_name} -> zombie/{name}/")


def composite_zombie(entry_name, out_name):
    z = load_plist(os.path.join(APP, "Zombies.plist"))["Entries"][entry_name]
    rig = load_plist(os.path.join(APP, z["frameListFile"]))
    atlas = Image.open(os.path.join(APP, z["spriteSheetFile"])).convert("RGBA")
    color = z["marketInfo"].get("color", [255, 255, 255])
    slot = {a["assetKey"]: a["attachmentID"].replace("kActorPartTag", "") for a in z["assets"]}
    inherit = {a["assetKey"]: a.get("inheritColor", False) for a in z["assets"]}

    def lay(k):
        fn = k if k.endswith(".png") else k + ".png"
        return rig.get(fn) or rig.get(k)

    head = (0, 0)
    for k in slot:
        if slot[k] == "Head":
            L = lay(k)
            if L:
                head = (L["offsetX"], L["offsetY"])

    items = []
    for a in z["assets"]:
        k = a["assetKey"]
        L = lay(k)
        if not L:
            continue
        ox, oy = L["offsetX"], L["offsetY"]
        if slot[k] in FACE_SLOTS and slot[k] != "Head":
            ox += head[0]
            oy += head[1]  # parent face parts to the head
        items.append((L.get("z", 0), k, L, ox, oy))
    items.sort(key=lambda t: t[0])

    W, H, cx, cy = 180, 200, 90, 165  # origin (feet) at (cx, cy)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for _, k, L, ox, oy in items:
        x, y, w, h = L["x"], L["y"], L["width"], L["height"]
        part = atlas.crop((x, y, x + w, y + h))
        if inherit.get(k):
            part = _tint(part, color)
        canvas.alpha_composite(
            part, (round(cx + ox - L["pivotX"] * w), round(cy - oy - (1 - L["pivotY"]) * h))
        )
    os.makedirs(os.path.join(OUT, "zombie"), exist_ok=True)
    canvas.save(os.path.join(OUT, "zombie", out_name))
    json.dump({"anchorX": cx / W, "anchorY": cy / H, "w": W, "h": H},
              open(os.path.join(OUT, "zombie", out_name + ".json"), "w"))
    print(f"zombie: composited {entry_name} -> {out_name}")


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
    slice_storage()
    export_zombie_parts("Dr. Zombie", "dr_zombie")
    export_rig()
    make_field(idx)
    print("done ->", OUT)
