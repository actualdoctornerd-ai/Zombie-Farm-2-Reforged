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

    with open(os.path.join(OUT_DIR, "drops.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(f"drops: {len(out)} items, {copied} sprites copied -> {LOOT_DIR}")
    if missing:
        print(f"  no standalone art for {len(missing)}: {', '.join(missing[:12])}")


if __name__ == "__main__":
    main()
