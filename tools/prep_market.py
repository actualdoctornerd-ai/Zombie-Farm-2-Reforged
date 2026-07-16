#!/usr/bin/env python3
"""Enrich the crop/zombie catalog JSON with authoritative economy data.

Source of truth: ZF2R_extracted/data/json/gameplay/Market.json (the game's own
market table). This joins the CURATED catalog (the subset of crops/zombies that
already have extracted sprite art, in public/assets/plants.json + zombies.json)
against Market.json and writes back the authoritative fields:

  plants:  cost, sell (=price), growMs (=growTime*1000), level (unlock), xp
  zombies: cost, growMs, level, xp, brainsNeeded, category,
           + group/className/classColor (taxonomy) + str/dex/con/focus (UnitStats)

The curated SET and order (which crops have art) are preserved as-is; only the
per-entry economy numbers are refreshed from source. Re-runnable / idempotent.

Run from the repo root (the folder containing ZF2R_extracted/ and zombiefarm/):
    python zombiefarm/tools/prep_market.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAMEPLAY = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "gameplay", "Market.json")
UNITSTATS = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "gameplay", "UnitStats.json")
SPECIAL_ZOMBIES = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "gameplay", "Zombies.json")
ASSETS = os.path.join(ROOT, "zombiefarm", "public", "assets")
PLANTS = os.path.join(ASSETS, "plants.json")
ZOMBIES = os.path.join(ASSETS, "zombies.json")

CATMAP = {"zombie": "normal", "special": "special", "mutation": "mutant"}

# ---- Zombie taxonomy (Phase 3) ---------------------------------------------
# Keys look like ZombieActor<Group><Tier?><Suffix?>. The GROUP token (with a
# trailing seasonal-variant digit stripped) maps to a display family; the Tier
# number maps to a colour CLASS. Named variants with no Tier (Crazy, Cupid) are
# the "Yellow" uniques. This mirrors src/zombie/taxonomy.ts.
GROUP_FAMILY = {
    "Regular": "Regular", "Girl": "Female", "Small": "Small",
    "Large": "Large", "Headless": "Headless", "Garden": "Garden",
}
TIER_CLASS = {
    "1": ("Green", "#7bd84a"),
    "2": ("Blue", "#5aa8ff"),
    "3": ("Red", "#ff5a4a"),
    "4": ("Silver", "#cfd4dd"),
    "5": ("Special", "#c077ff"),
}
YELLOW = ("Yellow", "#ffd24a")


def classify(key):
    """(group, className, classColor) from a ZombieActor key."""
    body = re.sub(r"^ZombieActor", "", key)
    # Family = the leading group token (longest known prefix wins so "Regular"
    # matches before nothing); seasonal variant digits (Regular2) are ignored.
    group = "Regular"
    for fam in sorted(GROUP_FAMILY, key=len, reverse=True):
        if body.startswith(fam):
            group = GROUP_FAMILY[fam]
            break
    m = re.search(r"Tier(\d)", body)
    tier = m.group(1) if m else None
    if tier and tier in TIER_CLASS:
        cls, color = TIER_CLASS[tier]
    else:
        cls, color = YELLOW  # no tier -> named unique (Crazy, Cupid, ...)
    return group, cls, color


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    market = load(GAMEPLAY)["Entries"]
    unitstats = load(UNITSTATS)
    plant_src = {
        e["name"]: e
        for e in market
        if e.get("category") == "crop" and e.get("subCategory") == "plant"
    }
    zombie_src = {}
    for e in market:
        if e.get("category") == "crop" and e.get("subCategory") in CATMAP:
            # First entry per unitKey wins (duplicates share level/xp).
            zombie_src.setdefault(e.get("unitKey"), e)

    missing = []

    # ---- plants: join by display name ----
    plants = load(PLANTS)
    for p in plants:
        s = plant_src.get(p["name"])
        if not s:
            missing.append(f"plant {p['name']}")
            continue
        p["cost"] = s.get("cost", p.get("cost", 0))
        p["sell"] = s.get("price", p.get("sell", 0))
        p["growMs"] = (s.get("growTime") or 900) * 1000
        p["level"] = s.get("level", 1)
        p["xp"] = s.get("xp", 1)

    # ---- zombies: join by unitKey (== catalog key) ----
    zombies = load(ZOMBIES)
    named = load(SPECIAL_ZOMBIES)["Entries"]
    for source_name, key, sprite in [
        ("Dr. Zombie", "ZombieActorDrZombie", "dr_zombie.png"),
        ("Omega Dr. Zombie", "ZombieActorOmegaDrZombie", "omega_dr_zombie.png"),
    ]:
        source = named[source_name]
        info, stats = source["marketInfo"], source["unitStats"]
        row = next((z for z in zombies if z["key"] == key), None)
        data = {
            "key": key, "name": source_name, "cost": info["cost"], "growMs": 86_400_000,
            "category": "special", "level": info["level"], "xp": info["xp"],
            "brainsNeeded": bool(info["brainsNeeded"]), "group": "Regular",
            "className": "Special", "classColor": "#c077ff", "str": stats["str"],
            "dex": stats["dex"], "con": stats["con"], "focus": stats["focus"],
            "mutation": 0, "tier": stats["tier"], "specialSprite": sprite,
        }
        if row: row.update(data)
        else: zombies.append(data)
    for z in zombies:
        if z.get("specialSprite"):
            continue
        s = zombie_src.get(z["key"])
        if not s:
            missing.append(f"zombie {z['key']} ({z['name']})")
            continue
        z["cost"] = s.get("cost", z.get("cost", 0))
        z["growMs"] = (s.get("growTime") or 86400) * 1000
        z["level"] = s.get("level", 1)
        z["xp"] = s.get("xp", 2)
        z["brainsNeeded"] = bool(s.get("brainsNeeded", False))
        z["category"] = CATMAP.get(s.get("subCategory"), z.get("category", "normal"))
        # Market mutant zombies carry a mutation BITMASK (power of two) in the
        # source `mutation` field (e.g. Carrot=4, Tomato=1). Bake it so a grown
        # market mutant gets its mutation guaranteed. Non-mutants have no bit (0).
        z["mutation"] = int(s.get("mutation") or 0)
        # Taxonomy (group + colour class) derived from the key.
        group, cls, color = classify(z["key"])
        z["group"] = group
        z["className"] = cls
        z["classColor"] = color
        # Combat stats from UnitStats (str/dex/con; focus where present).
        us = unitstats.get(z["key"], {})
        z["str"] = round(float(us.get("str", 1)), 2)
        z["dex"] = round(float(us.get("dex", 1)), 2)
        z["con"] = round(float(us.get("con", 1)), 2)
        z["focus"] = round(float(us.get("focus", 0)), 2)
        # Tier (0..5) drives Zombie Pot species selection: when two non-veggie
        # parents are combined, the higher-tier one wins (see determineBaseClass,
        # recovered from the binary — docs/mechanics/BINARY_RE_METHODOLOGY.md).
        z["tier"] = int(us.get("tier", 0))
        # NOTE: abilities are NOT baked here. In ZF2 a zombie's abilities are
        # assigned by compiled logic (initActorSpecificAbilities group aura +
        # getRandomAbilityToUnlock veterancy unlocks), not by the asset data, so
        # the runtime derives the group aura from the taxonomy (see traits.ts).
        z.pop("abilities", None)

    # Permanent crops first, then holiday/seasonal crops; unlock level orders each
    # group. Python's stable sort retains authored order for complete ties.
    plants.sort(key=lambda p: (bool(p.get("seasonal", False)), p.get("level", 1)))
    zombies.sort(key=lambda z: z.get("level", 1))

    with open(PLANTS, "w", encoding="utf-8") as f:
        json.dump(plants, f, indent=1)
    with open(ZOMBIES, "w", encoding="utf-8") as f:
        json.dump(zombies, f, indent=1)

    print(f"plants:  {len(plants)} enriched (levels {min(p['level'] for p in plants)}"
          f"-{max(p['level'] for p in plants)})")
    print(f"zombies: {len(zombies)} enriched (levels {min(z['level'] for z in zombies)}"
          f"-{max(z['level'] for z in zombies)})")
    if missing:
        print("WARNING unmatched (left unchanged):", *missing, sep="\n  ")
        sys.exit(1)
    print("done")


if __name__ == "__main__":
    main()
