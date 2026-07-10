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
        brains = costs[0] if len(costs) > 1 else 0
        gold = costs[-1]
        map_size.append({
            "name": r["name"], "size": size, "level": r["level"],
            "gold": gold, "brains": brains, "info": r["info"], "icon": farm_icon,
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
        climate.append({
            "name": e["name"], "climateGID": gid, "terrain": terrain,
            "level": int(e["level"]), "gold": int(e["cost"]), "icon": icon,
        })

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    json.dump({"mapSize": map_size, "climate": climate},
              open(OUT_JSON, "w", encoding="utf-8"), indent=2)
    print(f"wrote {OUT_JSON}")
    print(f"  mapSize: {len(map_size)} tiers -> {[m['size'] for m in map_size]}")
    print(f"  climate: {len(climate)} skins")


if __name__ == "__main__":
    main()
