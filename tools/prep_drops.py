#!/usr/bin/env python3
"""Prep raid loot drop art + a name->sprite map.

Reads Drops.json, finds each item's standalone sprite PNG in the extracted
assets, copies it to public/assets/raids/loot/, and writes a compact
public/assets/raids/drops.json mapping:

  { "<item name>": { "icon": "<file>.png", "brains": bool, "gold": bool } }

`icon` is "" when no standalone sprite could be resolved (the results panel then
falls back to the item name). Run from the zombiefarm/ dir:  python tools/prep_drops.py
"""
import json
import os
import shutil

import boss_statues

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # zombiefarm/
EXTRACT = os.path.join(ROOT, "..", "ZF2R_extracted")
DROPS_SRC = os.path.join(EXTRACT, "data", "json", "gameplay", "Drops.json")
ASSET_DIRS = [
    os.path.join(EXTRACT, "assets", "standalone-images"),
    os.path.join(EXTRACT, "assets", "spritesheets"),
]
OUT_DIR = os.path.join(ROOT, "public", "assets", "raids")
LOOT_DIR = os.path.join(OUT_DIR, "loot")
EPIC_DIR = os.path.join(ROOT, "public", "assets", "epic-bosses")

# The seven invasion faction banners the source drops only once (see the banner
# note in main()), and the pick share each keeps after the first copy.
REPEATABLE_BANNERS = {
    "Farmer Banner", "Corporate Banner", "Pirate Banner", "Ninja Banner",
    "Robot Banner", "Alien Banner", "Pixel Banner",
}
BANNER_REPEAT_WEIGHT = 0.25


def build_index():
    """filename -> full path, first match wins."""
    idx = {}
    for base in ASSET_DIRS:
        for r, _, files in os.walk(base):
            for f in files:
                idx.setdefault(f, os.path.join(r, f))
    return idx


def main():
    drops = json.load(open(DROPS_SRC, encoding="utf-8"))
    idx = build_index()
    os.makedirs(LOOT_DIR, exist_ok=True)

    out = {}
    copied, missing = 0, []
    for name, info in drops.items():
        sprite = info.get("sprite", "")
        is_brains = "brain" in name.lower()
        is_gold = "gold" in name.lower()
        icon = ""
        # Only copy real decoration/loot art (tex*), not the tiny stex UI glyphs
        # (gold/brains use the topbar icons instead).
        if sprite and sprite.startswith("tex") and sprite in idx:
            shutil.copy(idx[sprite], os.path.join(LOOT_DIR, sprite))
            icon = sprite
            copied += 1
        elif sprite and sprite.startswith("tex"):
            missing.append(name)
        # `tile` (when present) links the drop to its TileProperties entry, which
        # prep_placeables turns into a real placeable — so the Received tab can map
        # a reward name to its placeable even when the placeable's name differs
        # (e.g. "Golden Egg" -> tile goldEgg -> placeable "Mechanical Egg").
        # `unique`: item drops only ONCE — once owned, the loot roll filters it out
        # (19 items: banners + signature decorations). `limit`: max copies that can
        # ever drop (only "Rusty Fragment": 3); 0 = unlimited. Both drive the
        # eligible-item filter in RaidManager (recovered from lootTableFromCategory:).
        out[name] = {"icon": icon, "brains": is_brains, "gold": is_gold,
                     "tile": info.get("tile", ""),
                     "unique": bool(info.get("unique", False)),
                     "limit": int(info.get("limit", 0))}
        # Design change (not the source's rule): an invasion's faction banner is no
        # longer one-and-done. After the first it stays on the table as a RARER
        # repeat — `repeatWeight` is the share of a normal pick it keeps once owned
        # (see pickLootEntry in src/raid/LootTable.ts).
        if name in REPEATABLE_BANNERS:
            out[name]["unique"] = False
            out[name]["repeatWeight"] = BANNER_REPEAT_WEIGHT

    # ---- Epic-boss prizes ---------------------------------------------------
    # Drops.json covers RAID loot only, but an epic-boss prize is claimed through the
    # very same path: storage.claim -> planClaim -> dropEcon(name). Without an entry
    # here every epic decoration resolved to "bad_item" and the server rolled back the
    # placement, so all 50 prizes across all 8 bosses were unplaceable. Store/retrieve
    # (planStore / planRetrieve) read the same table and failed the same way.
    #
    # `icon` stays empty: the prize's own art is the placeable its `tile` names, and
    # the results panel already prefers that over a loot glyph.
    epic = 0
    for boss in sorted(os.listdir(EPIC_DIR)) if os.path.isdir(EPIC_DIR) else []:
        catalog_path = os.path.join(EPIC_DIR, boss, "catalog.json")
        if not os.path.exists(catalog_path):
            continue
        catalog = json.load(open(catalog_path, encoding="utf-8"))
        for entry in catalog.get("loot", []):
            name, tile = entry.get("name"), entry.get("tile")
            # A `stageActor` prize is a tamed PET, unlocked directly rather than
            # claimed out of Received — it needs no drop metadata.
            if not name or not tile or entry.get("stageActor") or name in out:
                continue
            out[name] = {"icon": "", "brains": False, "gold": False, "tile": tile,
                         "unique": bool(entry.get("unique", False)), "limit": 0}
            epic += 1

    # ---- Boss Statues --------------------------------------------------------
    # A reimplementation addition: an invasion milestone prize, stone and golden
    # (src/raid/bossStatues.ts),
    # claimed through the same Received -> storage.claim path as any other loot, so
    # it needs the same drops metadata. Repeatable, and like an epic prize its art
    # is the placeable its `tile` names (tools/boss_statues.py).
    for tile, name, _source in boss_statues.STATUES:
        for t, n in ((tile, name),
                     (boss_statues.golden_key(tile), boss_statues.golden_name(name))):
            out[n] = {"icon": "", "brains": False, "gold": False, "tile": t,
                      "unique": False, "limit": 0}

    with open(os.path.join(OUT_DIR, "drops.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(f"drops: {len(out)} items ({epic} epic-boss prizes), {copied} sprites copied -> {LOOT_DIR}")
    if missing:
        print(f"  no standalone art for {len(missing)}: {', '.join(missing[:12])}")


if __name__ == "__main__":
    main()
