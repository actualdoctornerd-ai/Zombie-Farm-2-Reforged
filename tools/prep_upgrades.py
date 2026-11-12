#!/usr/bin/env python3
"""Extract the Market's "upgrade" category (Farm Size + Ground/climate) into a
compact runtime JSON, and copy their thumbnail icons.

Source: ZF2R_extracted/data/json/gameplay/Market.json -> Entries with
category == "upgrade":
  - subCategory "mapsize": the farm-size expansions. Each size ships as TWO
    entries (a gold-priced one and a brains-priced one) that are otherwise
    identical; we merge them per size into {gold, brains}.
  - subCategory "climate": the ground skins (grass is the free default). Emitted
    for future use; only Farm Size is wired into the UI so far.

Card thumbnails are the entries' own `spriteSheet` (a 58x58 market icon under
assets/standalone-images/misc), copied into public/assets/ui/market/.

Run from zombiefarm/:  python tools/prep_upgrades.py
"""
import json
import os
import shutil

from PIL import Image

import prep_assets
from reforge_economy import (
    ENDLESS_SIZE_TIERS, EXTRA_CLIMATES, EXTRA_SIZE_TIERS, LEVEL_CAP, QUEST_SIZE_TIERS, brain_price,
)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXTRACT = os.path.join(ROOT, "..", "ZF2R_extracted")
MARKET = os.path.join(EXTRACT, "data", "json", "gameplay", "Market.json")
MISC = os.path.join(EXTRACT, "assets", "standalone-images", "misc")
OUT_JSON = os.path.join(ROOT, "public", "assets", "upgrades.json")
ICON_DIR = os.path.join(ROOT, "public", "assets", "ui", "market")


def copy_icon(sheet, dest_name):
    """Copy a misc/stexNNNN.png thumbnail into the UI market folder."""
    src = os.path.join(MISC, sheet)
    if not os.path.exists(src):
        print(f"  WARN missing icon {sheet}")
        return ""
    os.makedirs(ICON_DIR, exist_ok=True)
    shutil.copyfile(src, os.path.join(ICON_DIR, dest_name))
    return dest_name


def derived_climate_icon(terrain):
    """Market thumbnail for a Reforged-added skin: the grassy icon put through the
    exact same recolour its ground tiles get, so the card matches the terrain."""
    spec = prep_assets.DERIVED_GROUND_ROWS.get(terrain)
    if not spec:
        return ""
    src = os.path.join(ICON_DIR, "upgrade_ground_grassy.png")
    if not os.path.exists(src):
        print(f"  WARN no grassy icon to derive {terrain} from")
        return ""
    dest = f"upgrade_ground_{terrain}.png"
    prep_assets.recolor_terrain(
        Image.open(src).convert("RGBA"), spec["hue"], spec["sat"], spec["val"]
    ).save(os.path.join(ICON_DIR, dest))
    return dest


def check_climates(climates):
    """Every skin must name a terrain the ground slicer actually emits, or the
    Market sells a card that silently does nothing (Field.setClimate no-ops on an
    unknown terrain key)."""
    known = set(prep_assets.GROUND_ROWS) | set(prep_assets.DERIVED_GROUND_ROWS)
    for c in climates:
        if c["terrain"] not in known:
            raise ValueError(f"{c['name']}: unknown terrain {c['terrain']!r}")
    keys = [c["terrain"] for c in climates]
    if len(keys) != len(set(keys)):
        raise ValueError(f"duplicate climate terrains: {keys}")


def check_size_progression(tiers):
    """Assert the farm-size ladder keeps the source's own progression.

    The source ships three tiers and Reforged appends more (EXTRA_SIZE_TIERS); the
    added ones are only defensible if they continue the existing curve rather than
    inventing a price. Fail loudly here rather than let an off-pattern tier ship.
    """
    for prev, cur in zip(tiers, tiers[1:]):
        where = f"{cur['name']} ({cur['size']}x{cur['size']})"
        if cur["size"] - prev["size"] != 10:
            raise ValueError(f"{where}: size must step by 10, got +{cur['size'] - prev['size']}")
        if cur["level"] - prev["level"] != 10:
            raise ValueError(f"{where}: level must step by 10, got +{cur['level'] - prev['level']}")
        if cur["gold"] != prev["gold"] * 5:
            raise ValueError(f"{where}: gold must be 5x the previous tier "
                             f"({prev['gold'] * 5}), got {cur['gold']}")
        if cur["level"] > LEVEL_CAP:
            raise ValueError(f"{where}: level {cur['level']} is past the cap {LEVEL_CAP}")
    # Brains rise by a doubling step (+2, +4, +8, ...), so compare second differences.
    steps = [cur["brains"] - prev["brains"] for prev, cur in zip(tiers, tiers[1:])]
    for i, (a, b) in enumerate(zip(steps, steps[1:])):
        if b != a * 2:
            raise ValueError(f"{tiers[i + 2]['name']}: brains step must double "
                             f"({a} -> {a * 2}), got {b}")


def main():
    entries = json.load(open(MARKET, encoding="utf-8"))["Entries"]
    ups = [e for e in entries if isinstance(e, dict) and e.get("category") == "upgrade"]

    # --- Farm size: merge the gold + brains entries for each size. ---
    by_size = {}
    for e in ups:
        if e.get("subCategory") != "mapsize":
            continue
        size = int(e["mapSize"])
        rec = by_size.setdefault(size, {
            "name": e["name"], "size": size, "level": int(e["level"]),
            "info": e.get("info", f"{size}x{size}"), "sheet": e.get("spriteSheet", ""),
            "costs": [],
        })
        rec["costs"].append(int(e["cost"]))

    farm_icon = copy_icon("stex0019.png", "upgrade_farmsize.png")
    map_size = []
    for size in sorted(by_size):
        r = by_size[size]
        costs = sorted(r["costs"])
        # gold is always the larger price, brains the smaller (10000 vs 60, etc.)
        # The brains half takes the brainflation retune (60 source -> 6 here); the
        # gold half passes through. See tools/reforge_economy.py.
        brains = brain_price(costs[0], r["name"]) if len(costs) > 1 else 0
        gold = costs[-1]
        map_size.append({
            "name": r["name"], "size": size, "level": r["level"],
            "gold": gold, "brains": brains, "info": r["info"], "icon": farm_icon,
        })

    # Reforged's own tiers, continuing the ladder past where the source stops.
    for extra in EXTRA_SIZE_TIERS:
        map_size.append({
            "name": extra["name"], "size": extra["size"], "level": extra["level"],
            "gold": extra["gold"], "brains": extra["brains"],
            "info": f"{extra['size']}x{extra['size']}", "icon": farm_icon,
        })
    map_size.sort(key=lambda m: m["size"])
    check_size_progression(map_size)
    # Endless's unlocks go on the end, off the progression curve (see reforge_economy).
    for extra in ENDLESS_SIZE_TIERS:
        if extra["size"] <= map_size[-1]["size"]:
            raise ValueError(f"{extra['name']}: an Endless farm size must top the ladder")
        map_size.append({
            "name": extra["name"], "size": extra["size"], "level": extra["level"],
            "gold": extra["gold"], "brains": extra["brains"],
            "info": f"{extra['size']}x{extra['size']}", "icon": farm_icon,
            "endlessTier": extra["endlessTier"],
        })
    # Quest unlocks go on after those, likewise off the curve.
    for extra in QUEST_SIZE_TIERS:
        if extra["size"] <= map_size[-1]["size"]:
            raise ValueError(f"{extra['name']}: a quest farm size must top the ladder")
        map_size.append({
            "name": extra["name"], "size": extra["size"], "level": extra["level"],
            "gold": extra["gold"], "brains": extra["brains"],
            "info": f"{extra['size']}x{extra['size']}", "icon": farm_icon,
            "quest": extra["quest"],
        })

    # --- Climate/ground skins (emitted for later; not wired into UI yet). ---
    # Source terrain tileset (tex0000.png) rows, one block of 5 GIDs per climate,
    # in the SAME order the ground tiles were sliced by prep_assets.slice_ground.
    # So a climate's terrain = row (GID-1)//5. The extractor named rows by eye, so
    # e.g. climate "Dead" (GID 21) maps to the "sand" row and "Lunar" (26) to
    # "water"; the names are cosmetic — the GID block is the ground truth.
    GROUND_ROWS = ["grass", "dirt", "snow", "stone", "sand", "water"]
    climate = []
    for e in ups:
        if e.get("subCategory") != "climate":
            continue
        sheet = e.get("spriteSheet", "")
        slug = e["name"].lower().split()[0]  # "Sandy Ground" -> "sandy"
        icon = copy_icon(sheet, f"upgrade_ground_{slug}.png") if sheet else ""
        gid = int(e.get("climateGID", 0))
        row = (gid - 1) // 5 if gid > 0 else 0
        terrain = GROUND_ROWS[row] if 0 <= row < len(GROUND_ROWS) else "grass"
        # Key order matches the committed asset so a re-run is a clean no-op rather
        # than a whole-file rewrite. Climates are gold-only (grass is free).
        climate.append({
            "name": e["name"], "climateGID": gid, "level": int(e["level"]),
            "gold": int(e["cost"]), "icon": icon, "terrain": terrain,
        })

    # Reforged's own skins, on terrain rows prep_assets derives rather than slices.
    # climateGID 0 marks "no source entry" — the field is vestigial (nothing at
    # runtime reads it; a climate card previews the ground tile itself), but the
    # shape stays uniform across the catalog.
    for extra in EXTRA_CLIMATES:
        climate.append({
            "name": extra["name"], "climateGID": 0, "level": extra["level"],
            "gold": extra["gold"], "icon": derived_climate_icon(extra["terrain"]),
            "terrain": extra["terrain"],
        })
    check_climates(climate)

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    # indent=1 and no trailing newline: matches the committed asset (and the other
    # generated catalogs) so a re-run is a clean no-op.
    json.dump({"mapSize": map_size, "climate": climate},
              open(OUT_JSON, "w", encoding="utf-8"), indent=1)
    print(f"wrote {OUT_JSON}")
    print(f"  mapSize: {len(map_size)} tiers -> {[m['size'] for m in map_size]}")
    print(f"  climate: {len(climate)} skins")


if __name__ == "__main__":
    main()
