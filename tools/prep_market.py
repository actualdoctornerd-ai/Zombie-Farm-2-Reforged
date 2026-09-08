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

Three Reforged retunes override the source and are applied AFTER the join, so a
re-run cannot revert them: brain prices (all catalogs), the regular crops'
level/cost/sell/xp rebalance, and the market mutants' unlock levels + colour
class. All of them live in tools/reforge_economy.py.

Run from the repo root (the folder containing ZF2R_extracted/ and zombiefarm/):
    python zombiefarm/tools/prep_market.py
"""
import json
import os
import re
import sys

from reforge_economy import (
    CROP_REBALANCE, MUTANT_BIT_REBALANCE, MUTANT_CLASS_REBALANCE, MUTANT_REBALANCE,
    SPECIAL_STAT_REBALANCE,
    brain_price, rebalance_crop, rebalance_mutant, rebalance_mutant_bit,
    rebalance_mutant_class, rebalance_special_stats,
)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAMEPLAY = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "gameplay", "Market.json")
UNITSTATS = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "gameplay", "UnitStats.json")
SPECIAL_ZOMBIES = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "gameplay", "Zombies.json")
ASSETS = os.path.join(ROOT, "zombiefarm", "public", "assets")
PLANTS = os.path.join(ASSETS, "plants.json")
ZOMBIES = os.path.join(ASSETS, "zombies.json")

CATMAP = {"zombie": "normal", "special": "special", "mutation": "mutant"}

# The reforged Market deliberately exposes only this small permanent set of
# plantable named specials. Other Special-category zombies retain their quest,
# event, voucher, or collection routes but do not appear as zombie crops.
MARKET_SPECIALS = {
    "Bombie",
    "Crazy Zombie",
    "Cupid Zombie",
    "Dapper Zombie",
    "Granny Zombie",
}

# ---- Authored (Reforged-only) zombies ----------------------------------------
# Species with no row in ZF2's Market.json or UnitStats.json at all, so the source
# join above cannot produce them. Kept as complete literals: a re-run rewrites the
# row from here rather than dropping it, and `specialSprite` keeps it out of the
# source-enrichment loop (which would otherwise report it as unmatched and exit 1).
#
# Video Game Zombie — the pixel zombie of the "Zombies vs Video Games" invasion
# (raid 9, unlock level 43) as a playable species. Filed as an ORDINARY zombie
# (category "normal", group Regular, tier-less Yellow class like Crazy) rather than a
# sixth permanent special, so it sits in the Market's Normal tab, can go in either
# Pot slot and carries no Black Market special gate. Stats are one step above the
# Crazy Zombie (19 / 2 / 28 / 100) — the strongest plantable zombie, by a little.
# Its art is a frame strip, exported by tools/prep_assets.py export_video_game_zombie.
AUTHORED_ZOMBIES = [
    {
        "key": "ZombieActorRegularVideoGame", "name": "Video Game Zombie",
        "cost": 6, "growMs": 86_400_000, "category": "normal", "level": 43, "xp": 2,
        "brainsNeeded": True, "group": "Regular",
        "className": "Yellow", "classColor": "#ffd24a",
        "str": 20.0, "dex": 2.1, "con": 29.0, "focus": 100.0,
        "mutation": 0, "tier": 5, "specialSprite": "video_game_zombie.png",
        "rewardOnly": False, "marketHidden": False,
    },
    # The Aliens' promoted invasion prize: a derived recolour of the Zastronaut
    # (tools/prep_assets.py DERIVED_SPECIAL_ZOMBIES), so it has no source row. Priced
    # and levelled like the other promoted prizes (Sheriff: twice the base zombie).
    # Stats follow the 2026-09-07 invasion-prize re-fit (see SPECIAL_STAT_REBALANCE in
    # reforge_economy.py): the elite Aliens prize, on the prizes' line at level 36 and
    # capped at x1.5 of its first-pass 10.5 / 3.67 / 17.2 (the Zastronaut +20%).
    {
        "key": "ZombieActorZosmonaut", "name": "Zosmonaut",
        "cost": 10, "growMs": 86_400_000, "category": "special", "level": 25, "xp": 1,
        "brainsNeeded": True, "group": "Regular",
        "className": "Special", "classColor": "#c077ff",
        "str": 15.8, "dex": 3.67, "con": 25.8, "focus": 100.0,
        "mutation": 0, "tier": 5, "specialSprite": "zosmonaut.png",
        "rewardOnly": False, "marketHidden": True,
    },
    # The Zombozo: a Mini zombie in the Circus's little clown's costume, cut from the
    # enemy art (tools/prep_assets.py CUT_SPECIAL_ZOMBIES). Proposed as the Circus
    # invasion's rare zombie; stats sit beside the Zombricaun, the Small family's other
    # tier-5 (7.5 / 4.4 / 8.8). Level = the Circus's unlock level.
    {
        "key": "ZombieActorZombozo", "name": "Zombozo",
        "cost": 5, "growMs": 86_400_000, "category": "special", "level": 12, "xp": 1,
        "brainsNeeded": True, "group": "Small",
        "className": "Special", "classColor": "#c077ff",
        "str": 7.5, "dex": 4.5, "con": 8.6, "focus": 100.0,
        "mutation": 0, "tier": 5, "specialSprite": "zombozo.png",
        "rewardOnly": False, "marketHidden": True,
    },
]

# Brain prices take the shared brainflation retune (see tools/reforge_economy.py).
# Without it this script silently reverted the retune on every re-run, snapping all
# 55 brains-priced zombies back to their ZF2 values (5 -> 50, 20 -> 200, 40 -> 400).
# The permanent plantable specials are priced flat rather than from source.
MARKET_SPECIAL_BRAIN_COST = 5

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
    rebalanced = 0
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
        # The regular crops take the rebalance (see tools/reforge_economy.py) LAST,
        # so it wins over the source values just read. Grow time is not rebalanced.
        # Without this the join above would revert the whole thing on every re-run.
        rebalanced += rebalance_crop(p["key"], p)
        # Standalone 27-58px produce art used by the source Market and harvest
        # pickup animation. This is intentionally distinct from the full plot art.
        p["icon"] = s["spriteSheet"]

    unknown = set(CROP_REBALANCE) - {p["key"] for p in plants}
    if unknown:
        # A typo or a renamed key would otherwise be a silent no-op that quietly
        # leaves that crop on its ZF2 economy.
        print("ERROR rebalance keys not in plants.json:", *sorted(unknown), sep="\n  ")
        sys.exit(1)

    # ---- zombies: join by unitKey (== catalog key) ----
    zombies = load(ZOMBIES)
    remutanted = 0
    rebit = 0
    reclassed = 0
    named = load(SPECIAL_ZOMBIES)["Entries"]
    # Named specials use dedicated rigs rather than the shared ZombieSheet model.
    # `reward_only` is deliberately narrower than the source's market visibility:
    # Epic-event prizes are earned, while the other named premium specials retain
    # their authored Market route.
    for source_name, key, sprite, group, reward_only in [
        ("Bombie", "ZombieActorBombie", "bombie.png", "Headless", False),
        ("Brock Coley", "ZombieActorBrockColey", "brock_coley.png", "Regular", True),
        ("Dapper Zombie", "ZombieActorDapper", "dapper_zombie.png", "Large", False),
        ("Deputy Zombie", "ZombieActorDeputy", "deputy_zombie.png", "Regular", False),
        ("Forest Zombie", "ZombieActorForest", "forest_zombie.png", "Female", False),
        ("George Washington", "ZombieActorGeorgeWashington", "george_washington.png", "Regular", False),
        ("Granny Zombie", "ZombieActorGranny", "granny_zombie.png", "Female", False),
        ("John Hancock", "ZombieActorJohnHancock", "john_hancock.png", "Regular", False),
        ("Madame Zombie", "ZombieActorMadame", "madame_zombie.png", "Female", True),
        ("Master Ninjombie", "ZombieActorMasterNinjombie", "master_ninjombie.png", "Regular", False),
        ("Medusa Zombie", "ZombieActorMedusa", "medusa_zombie.png", "Female", False),
        ("MerZombie", "ZombieActorMerZombie", "merzombie.png", "Regular", False),
        ("Mummy Zombie", "ZombieActorMummy", "mummy_zombie.png", "Regular", False),
        ("Ninjombie", "ZombieActorNinjombie", "ninjombie.png", "Regular", False),
        ("Old McZombie", "ZombieActorOldMcZombie", "old_mczombie.png", "Regular", False),
        ("Omega Dr. Zombie", "ZombieActorOmegaDrZombie", "omega_dr_zombie.png", "Regular", True),
        ("Omega Zombie Bot", "ZombieActorOmegaZombieBot", "omega_zombie_bot.png", "Regular", False),
        ("Poseidon Zombie", "ZombieActorPoseidon", "poseidon_zombie.png", "Regular", False),
        ("Proto Zombie", "ZombieActorProto", "proto_zombie.png", "Regular", True),
        ("Sheriff Zombie", "ZombieActorSheriff", "sheriff_zombie.png", "Regular", False),
        ("Skittles Zombie", "ZombieActorSkittles", "skittles_zombie.png", "Regular", False),
        ("Zastronaut", "ZombieActorZastronaut", "zastronaut.png", "Regular", False),
        ("ZomBetty", "ZombieActorZomBetty", "zombetty.png", "Female", False),
        ("ZomBloke", "ZombieActorZomBloke", "zombloke.png", "Regular", False),
        ("ZomHelga", "ZombieActorZomHelga", "zomhelga.png", "Female", False),
        ("Zombeach Bum", "ZombieActorZombeachBum", "zombeach_bum.png", "Regular", False),
        ("Zombie Bot", "ZombieActorZombieBot", "zombie_bot.png", "Regular", False),
        ("Zombug", "ZombieActorZombug", "zombug.png", "Regular", True),
        ("Zomdini", "ZombieActorZomdini", "zomdini.png", "Regular", True),
        ("Zomtar", "ZombieActorZomtar", "zomtar.png", "Regular", True),
        ("Zula Girl", "ZombieActorZulaGirl", "zula_girl.png", "Female", False),
        ("Zwamp Thing", "ZombieActorZwampThing", "zwamp_thing.png", "Regular", False),
        ("Dr. Zombie", "ZombieActorDrZombie", "dr_zombie.png", "Regular", True),
        ("Bandido Zombie", "ZombieActorBandido", "bandido_zombie.png", "Regular", True),
        ("Vagabond Zombie", "ZombieActorVagabond", "vagabond_zombie.png", "Regular", True),
        ("Captain Zombie", "ZombieActorCaptain", "captain_zombie.png", "Regular", True),
        ("Admiral Zombie", "ZombieActorAdmiral", "admiral_zombie.png", "Regular", True),
        ("Christmas Ghost Zombie", "ZombieActorChristmasGhost", "christmas_ghost_zombie.png", "Regular", True),
        ("Scrooge Zombie", "ZombieActorScrooge", "scrooge_zombie.png", "Regular", True),
        ("Diva Zombie", "ZombieActorDiva", "diva_zombie.png", "Female", True),
    ]:
        source = named[source_name]
        info, stats = source["marketInfo"], source["unitStats"]
        row = next((z for z in zombies if z["key"] == key), None)
        brains = bool(info["brainsNeeded"])
        data = {
            "key": key, "name": source_name,
            # These rows skip the main enrichment loop below, so they take the
            # reforged brain price here.
            "cost": brain_price(info["cost"], source_name) if brains else info["cost"],
            "growMs": 86_400_000,
            "category": "special", "level": info["level"], "xp": info["xp"],
            "brainsNeeded": brains, "group": group,
            "className": "Special", "classColor": "#c077ff", "str": stats["str"],
            "dex": stats["dex"], "con": stats["con"], "focus": stats["focus"],
            "mutation": 0, "tier": stats["tier"], "specialSprite": sprite,
            "rewardOnly": reward_only,
        }
        # Applied after the source unitStats read, for the same reason the crop and
        # mutant rebalances are: the join above would otherwise revert it.
        rebalance_special_stats(key, data)
        if row: row.update(data)
        else: zombies.append(data)
    for data in AUTHORED_ZOMBIES:
        row = next((z for z in zombies if z["key"] == data["key"]), None)
        if row: row.update(data)
        else: zombies.append(dict(data))
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
        # Market mutants unlock AHEAD of the crop that grows their mutation (see
        # tools/reforge_economy.py). Applied after the source read for the same
        # reason as the crops: the join above would otherwise revert it.
        remutanted += rebalance_mutant(z["key"], z)
        # Some mutant rows reuse crop-scale XP values (hundreds). Harvesting a
        # zombie unit awards 1-2 XP throughout the playable zombie catalog.
        raw_xp = int(s.get("xp", 2) or 1)
        z["xp"] = raw_xp if raw_xp in (1, 2) else 1
        z["brainsNeeded"] = bool(s.get("brainsNeeded", False))
        # Source prices are ZF2's. Brains-priced units take the reforged tenth.
        if z["brainsNeeded"]:
            z["cost"] = brain_price(z["cost"], z["key"])
        z["category"] = CATMAP.get(s.get("subCategory"), z.get("category", "normal"))
        z["marketHidden"] = bool(s.get("dontShowInMarket", False))
        # Market mutant zombies carry a mutation BITMASK (power of two) in the
        # source `mutation` field (e.g. Carrot=4, Tomato=1). Bake it so a grown
        # market mutant gets its mutation guaranteed. Non-mutants have no bit (0).
        z["mutation"] = int(s.get("mutation") or 0)
        # ...except for the two Tier-4 mutants, whose source bit belongs to a LOWER
        # tier's mutation. Applied after the source read for the same reason the level
        # rebalance is: the join above would otherwise revert it.
        rebit += rebalance_mutant_bit(z["key"], z)
        # NOTE: Market.json's authored bonus line ("+3 speed") is deliberately NOT
        # baked. It is in RAW stat points, while the game shows every stat normalized
        # against a fixed reference (see traits.STAT_DISPLAY_MAX) — "+1 speed" reads as
        # +23 Speed on the card. The client derives the displayed bonus from the mask
        # instead: zombie/statDisplay.mutationMarketDescription.
        z.pop("marketInfo", None)
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
        # Crazy Zombie is functionally a tier-5 Special. Its source UnitStats tier
        # value is an erroneous 0, so keep the corrected gameplay classification.
        if z["key"] == "ZombieActorRegularCrazy":
            z["tier"] = 5
        # Two invasion prizes live in UnitStats rather than Zombies.json (the Teddy and
        # the Diver are seasonal tier-5s), so the prize re-fit has to reach them here.
        rebalance_special_stats(z["key"], z)
        # Re-levelled market mutants wear the colour of the band they now sit in.
        # Runs after BOTH classify() and the UnitStats tier read because it
        # overrides both, keeping colour and tier number in agreement.
        reclassed += rebalance_mutant_class(z["key"], z)
        # NOTE: abilities are NOT baked here. In ZF2 a zombie's abilities are
        # assigned by compiled logic (initActorSpecificAbilities group aura +
        # getRandomAbilityToUnlock veterancy unlocks), not by the asset data, so
        # the runtime derives the group aura from the taxonomy (see traits.ts).
        z.pop("abilities", None)

    # The pink Cupid variant has a dedicated actor model but no standalone Market
    # crop row; it is exclusively granted by the 2012 Valentine Gift voucher.
    for z in zombies:
        if z["key"] == "ZombieActorGardenCupidPink":
            z["name"] = "Pink Cupid Zombie"
            z["category"] = "special"
            z["marketHidden"] = True

    # Normalize the permanent Special tab: exactly five plantable zombies, all
    # unlocked at level 20 for 50 brains. rewardOnly remains the stronger flag
    # for Epic Boss prizes because it also prevents Zombie Pot duplication.
    for z in zombies:
        if z.get("category") != "special":
            continue
        is_market_special = z["name"] in MARKET_SPECIALS
        z["marketHidden"] = not is_market_special
        if is_market_special:
            z["cost"] = MARKET_SPECIAL_BRAIN_COST
            z["level"] = 20
            z["brainsNeeded"] = True
            z["rewardOnly"] = False

    unknown_specials = set(SPECIAL_STAT_REBALANCE) - {z["key"] for z in zombies}
    if unknown_specials:
        # A renamed key would otherwise silently leave that special on its ZF2 stats.
        print("ERROR special stat rebalance keys not in zombies.json:",
              *sorted(unknown_specials), sep="\n  ")
        sys.exit(1)

    unknown_mutants = (set(MUTANT_REBALANCE) | set(MUTANT_CLASS_REBALANCE)) - {z["key"] for z in zombies}
    if unknown_mutants:
        # A typo or a renamed key would otherwise silently leave that mutant on its
        # ZF2 unlock level, back behind the crop it is supposed to lead.
        print("ERROR mutant rebalance keys not in zombies.json:", *sorted(unknown_mutants), sep="\n  ")
        sys.exit(1)

    # Permanent crops first, then holiday/seasonal crops; unlock level orders each
    # group. Python's stable sort retains authored order for complete ties.
    plants.sort(key=lambda p: (bool(p.get("seasonal", False)), p.get("level", 1)))
    zombies.sort(key=lambda z: z.get("level", 1))

    # Trailing newline so a re-run is a byte-for-byte no-op against the committed
    # assets rather than showing a permanent one-line diff.
    with open(PLANTS, "w", encoding="utf-8") as f:
        json.dump(plants, f, indent=1)
        f.write("\n")
    with open(ZOMBIES, "w", encoding="utf-8") as f:
        json.dump(zombies, f, indent=1)
        f.write("\n")

    print(f"plants:  {len(plants)} enriched, {rebalanced} rebalanced "
          f"(levels {min(p['level'] for p in plants)}"
          f"-{max(p['level'] for p in plants)})")
    print(f"zombies: {len(zombies)} enriched, {remutanted} mutants re-levelled, "
          f"{reclassed} re-classed, {rebit} re-bitted "
          f"(levels {min(z['level'] for z in zombies)}"
          f"-{max(z['level'] for z in zombies)})")
    if missing:
        print("WARNING unmatched (left unchanged):", *missing, sep="\n  ")
        sys.exit(1)
    print("done")


if __name__ == "__main__":
    main()
