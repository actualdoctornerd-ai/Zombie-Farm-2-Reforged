"""
Raid/invasion prep for the ZF2R reimplementation.

Reads the source invasion catalog + combat stats and emits a runtime bundle:

  public/assets/raids/raids.json         normalized RaidDef[] (all 11 invasions)
  public/assets/raids/enemy_stats.json   { unitKey -> stats } for every enemy/boss
                                         referenced by any raid stage
  public/assets/raids/attacks.json       { attackName -> {damageMultiplier,...} }
                                         for every attack those enemies use
  public/assets/raids/images/...         boss portraits + stage backgrounds

Only Old McDonnell (ID 1) ships a full multi-stage ladder in the source data, and
Lawyers/Tree World/Valentine's ship one source stage. Every OTHER invasion has its
enemy/boss STATS in UnitStats.json (keyed by a family prefix) but was never wired
into Enemies.json stageSettings — so we SYNTHESIZE one boss wave for them (see
synth_stage) from the family's minions + boss, making all 11 invasions playable.

The boss's own bossActions bring its throw projectiles (parrot/anchor/kunai/…),
which get copied into images/. Stage backgrounds (levelAssets) are copied for all
raids and layered by the live scene in the source 480x320 design space.

Run:  python tools/prep_raids.py
"""
import os, json, shutil, re

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
APP = os.path.normpath(os.path.join(
    PROJ, "..", "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app"))
GAMEPLAY = os.path.normpath(os.path.join(
    PROJ, "..", "ZF2R_extracted", "data", "json", "gameplay"))
OUT = os.path.join(PROJ, "public", "assets", "raids")
IMGDIR = os.path.join(OUT, "images")

# Event/seasonal invasions: shown in the catalog but not part of the level ladder.
# NB: Circus (ID 8) is a CORE ladder invasion (level 12), not seasonal — confirmed
# against the public wiki's normal-invasion list. Only Summer Break (7), Tree World
# (10), and Valentine's Day (11) are the limited/seasonal events here.
SEASONAL_IDS = {7, 10, 11}

# Gold rewards are NOT present in the source data (Enemies.json only lists loot
# NAMES; Drops.json has no amounts) — the real values are computed in the game
# binary. These figures are sourced from the PUBLIC WIKI and the public wiki openly
# mixes ZF1/ZF2 data, so treat them as approximate and VERIFY against a real ZF2R
# copy before trusting them. Keyed by raid ID -> (goldReward, bonusGold):
#   goldReward = "gold without casualties" (the guaranteed win payout)
#   bonusGold  = "possible bonus gold"     (an additional performance roll)
# Lawyers' base scales by player level band (1500/1875/2250); we take the base band.
# IDs 7 and 11 aren't in the wiki tables — filled to match the level-8 seasonal
# pattern (Tree World / Circus-adjacent) as a placeholder.
WIKI_GOLD = {
    1: (1200, 400),    # Old McDonnell's Farm
    2: (1500, 750),    # Zombies vs Lawyers (base band)
    3: (2000, 750),    # Zombies vs Pirates
    4: (2500, 1250),   # Zombies vs Ninjas
    5: (3000, 1500),   # Zombies vs Robots
    6: (4000, 2000),   # Zombies vs Aliens
    7: (1200, 600),    # Summer Break (filled — not in wiki)
    8: (1200, 600),    # Zombies vs Circus
    9: (5000, 1200),   # Zombies vs Video Games
    10: (1200, 600),   # Tree World
    11: (1200, 600),   # Valentine's Day (filled — not in wiki)
}


# Most invasions ship their stage actors' STATS in UnitStats.json (keyed by a
# family prefix) but were never wired into Enemies.json stageSettings — only
# McDonnell (and the three single-stage events) have source stages. We synthesize
# one boss wave for the rest so every invasion is playable like McDonnell: a mix of
# the family's minions plus its boss (which brings its own throw projectiles).
STAGE_FAMILY = {
    3: "PirateStageActor",
    4: "NinjaStageActor",
    5: "RobotStageActor",
    6: "AlienStageActor",
    7: "BeachStageActor",
    8: "CircusStageActor",
    9: "VideoGameStage",
}
# When a family has several boss-flagged units (Robots: BrainBot/BroBot/JunkBot are
# all boss-capable — "any can be the boss"), pick THE boss; the rest become minions.
BOSS_PREF = {5: "RobotStageActorBrainBot"}
SYNTH_MINIONS = 6  # minion slots in a synthesized boss wave (McDonnell fields ~5-6)


def synth_stage(rid, unit_stats):
    """Build one boss wave for a raid the source left without stageSettings."""
    pfx = STAGE_FAMILY.get(rid)
    if not pfx:
        return []
    members = sorted(k for k in unit_stats if k.startswith(pfx))
    if not members:
        return []
    bosses = [k for k in members if unit_stats[k].get("bossActions")]
    boss = BOSS_PREF.get(rid) or (bosses[0] if bosses else None)
    minions = [k for k in members if k != boss] or members
    wave = [minions[i % len(minions)] for i in range(SYNTH_MINIONS)]
    stage = {"enemyKeys": wave, "wave": 1, "throwSpeed": 2, "synthesized": True}
    if boss:
        stage["bossKey"] = boss
    return [stage]


def load(name):
    return json.load(open(os.path.join(GAMEPLAY, name), encoding="utf-8"))


def as_int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def copy_img(name, missing):
    """Copy a source image into images/ if it exists; track misses. Returns name."""
    if not name:
        return ""
    src = os.path.join(APP, name)
    if os.path.exists(src):
        shutil.copy(src, os.path.join(IMGDIR, name))
        return name
    missing.add(name)
    return name  # keep the reference so the runtime can decide a fallback


def norm_stage(s):
    """Normalize one source stageSettings entry into a runtime stage."""
    out = {"enemyKeys": list(s.get("enemyKeys", []))}
    if s.get("bossKey"):
        out["bossKey"] = s["bossKey"]
    if "level" in s:  # source "wave ordinal", not player level
        out["wave"] = as_int(s["level"])
    if "population" in s:
        out["population"] = as_int(s["population"])
    if "throwSpeed" in s:
        out["throwSpeed"] = s["throwSpeed"]
    if s.get("throwingDisabled"):
        out["throwingDisabled"] = True
    if s.get("enemies"):  # weighted spawn table
        out["weighted"] = [
            {"enemy": w.get("enemy"), "frequency": as_int(w.get("frequency"))}
            for w in s["enemies"]
        ]
    return out


def main():
    os.makedirs(IMGDIR, exist_ok=True)
    enemies = load("Enemies.json")
    unit_stats = load("UnitStats.json")
    attacks = load("Attacks.json")

    missing = set()
    raids = []
    used_units = set()

    for e in enemies:
        rid = as_int(e.get("ID"))
        level_assets = []
        for a in e.get("levelAssets", []) or []:
            spr = copy_img(a.get("sprite", ""), missing)
            level_assets.append({
                "sprite": spr,
                "position": a.get("position", "{0,0}"),
                "anchor": a.get("anchor", "{0,0}"),
                "z": a.get("z", 0),
            })
        stages = [norm_stage(s) for s in e.get("stageSettings", []) or []]
        if not stages:  # no source stages — synthesize a boss wave so it's playable
            stages = synth_stage(rid, unit_stats)
        for s in stages:
            used_units.update(s.get("enemyKeys", []))
            if s.get("bossKey"):
                used_units.add(s["bossKey"])
            for w in s.get("weighted", []) or []:
                if w.get("enemy"):
                    used_units.add(w["enemy"])
        raids.append({
            "id": rid,
            "name": e.get("name", f"Raid {rid}"),
            "bossName": e.get("bossName", ""),
            "bossPortrait": copy_img(e.get("bossHeadPortrait", ""), missing),
            "enemyIcon": copy_img(e.get("enemyIcon", ""), missing),
            "unlockLevel": as_int(e.get("level")),
            "recommendedLevel": as_int(e.get("reccomendedLevel")),  # source typo
            "introText": e.get("introText", ""),
            "successText": e.get("invasionSuccessText", ""),
            "failureText": e.get("invasionFailedText", ""),
            "xp": as_int(e.get("xp")),
            # Wiki-sourced (see WIKI_GOLD note) — approximate, verify vs real ZF2R.
            "goldReward": WIKI_GOLD.get(rid, (0, 0))[0],
            "bonusGold": WIKI_GOLD.get(rid, (0, 0))[1],
            "throwSpeed": e.get("throwSpeed", 0),
            "seasonal": rid in SEASONAL_IDS,
            "playable": len(stages) > 0,
            "levelAssets": level_assets,
            "stages": stages,
            "loot": e.get("loot", []),
            # Environmental hazards (recovered from the binary's ZFFightMan spawnObstacle:
            # loop — see ZF2R_extracted/docs/mechanics/RAID_TIMING_AND_HAZARDS.md). Beach,
            # Tree World, and Valentine spawn obstacle actors periodically up to a cap;
            # initialSpawnClass (e.g. the beach Crab) appears once at the start.
            "obstacleLimit": as_int(e.get("obstacleLimit")) if e.get("obstacleLimit") is not None else 0,
            "obstacleSpawnSecs": float(e.get("obstacleSpawnTimer") or 0),
            "obstacleActors": sorted((e.get("obstacleActors") or {}).keys()),
            "initialSpawnClass": e.get("initialSpawnClass") or "",
            # A grabZombie stage actor (Lawyers cars / Circus trapeze) that seizes a
            # zombie and drops it at the back. Detected by scanning the raid's action
            # strings for "grabZombie".
            "hasGrab": "grabzombie" in json.dumps(e.get("stageActors") or []).lower(),
        })

    raids.sort(key=lambda r: r["id"])

    # Enemy/boss stat templates for every unit any raid stage references.
    enemy_stats = {}
    used_attacks = set()
    for key in sorted(used_units):
        st = unit_stats.get(key)
        if st is None:
            missing.add(f"UnitStats:{key}")
            continue
        enemy_stats[key] = st
        for atk in st.get("attacks", []) or []:
            if atk.get("name"):
                used_attacks.add(atk["name"])
        for ba in st.get("bossActions", []) or []:
            # boss projectile sprites (used later by the live scene)
            copy_img(ba.get("sprite", ""), missing)

    # Attack definitions for every attack the enemies use.
    attack_defs = {}
    for name in sorted(used_attacks):
        a = attacks.get(name)
        if a is None:
            missing.add(f"Attacks:{name}")
            continue
        attack_defs[name] = a

    with open(os.path.join(OUT, "raids.json"), "w", encoding="utf-8") as f:
        json.dump(raids, f, indent=1)
    with open(os.path.join(OUT, "enemy_stats.json"), "w", encoding="utf-8") as f:
        json.dump(enemy_stats, f, indent=1)
    with open(os.path.join(OUT, "attacks.json"), "w", encoding="utf-8") as f:
        json.dump(attack_defs, f, indent=1)

    playable = [r for r in raids if r["playable"]]
    print(f"raids: wrote {len(raids)} invasions ({len(playable)} playable) "
          f"+ {len(enemy_stats)} enemy stat sets + {len(attack_defs)} attacks")
    for r in raids:
        tag = "PLAYABLE" if r["playable"] else ("seasonal" if r["seasonal"] else "locked")
        print(f"  {r['id']:>2} {r['name']:<24} lvl{r['unlockLevel']:<3} "
              f"rec{r['recommendedLevel']:<3} {len(r['stages'])} stages  [{tag}]")
    print(f"  enemy units: {', '.join(sorted(enemy_stats)) or '(none)'}")
    if missing:
        print(f"  MISSING ({len(missing)}): {', '.join(sorted(missing))}")


if __name__ == "__main__":
    main()
