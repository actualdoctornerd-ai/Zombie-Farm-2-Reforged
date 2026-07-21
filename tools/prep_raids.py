"""
Raid/invasion prep for the ZF2R reimplementation.

Reads the source invasion catalog + combat stats and emits a runtime bundle:

  public/assets/raids/raids.json         normalized RaidDef[] (all 11 invasions)
  public/assets/raids/enemy_stats.json   { unitKey -> stats } for every enemy/boss
                                         referenced by any raid stage
  public/assets/raids/attacks.json       { attackName -> {damageMultiplier,...} }
                                         for every attack those enemies use
  public/assets/raids/images/...         boss portraits + stage backgrounds

Only Old McDonnell (ID 1) ships a full multi-stage difficulty LADDER in the source
data (7 stages selected by player level — see fightStage); Lawyers/Tree World/
Valentine's ship a single source stage, and the other 7 invasions ship none. The
game is a difficulty ladder (verified in the binary: `stageSettings[playerLevel −
recommendedLevel]`, one stage per invasion, no in-fight wave advancement), so to
give EVERY raid the same per-level scaling McDonnell has, we extrapolate McDonnell's
canonical ladder SHAPE (build_ladder) onto each raid using its own minions/boss/
population from UnitStats.json. McDonnell keeps its authored stages verbatim.

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


# Each invasion's stage actors live in UnitStats.json under a family prefix. We use
# this to resolve every raid's minions + boss so the ladder builder can extrapolate
# McDonnell's shape onto raids the source left without (or with only one) stage.
STAGE_FAMILY = {
    1: "FarmStageActor",
    2: "CityStageActor",
    3: "PirateStageActor",
    4: "NinjaStageActor",
    5: "RobotStageActor",
    6: "AlienStageActor",
    7: "BeachStageActor",
    8: "CircusStageActor",
    9: "VideoGameStage",
    10: "TreeWorldStage",
    11: "ValentinesDayStageActor",
}
# Battle BGM per raid. The binary ships exactly FIVE themed stage tracks —
# farm/pirate/ninja/robot/alien StageBGM (confirmed by the only *StageBGM strings in
# ZF2R.app/ZF2R) — played by ZFFightMan's playFightMusic when the matching stage
# loads. Every other invasion (Lawyers/City, Summer/Beach, Circus, Video Games,
# Tree World, Valentine's) has no themed track and falls back to the generic
# fightBGM, exactly as the original game does. Filenames resolve under assets/audio/.
RAID_MUSIC = {
    1: "farmStageBGM.mp3",     # Old McDonnell's Farm
    3: "pirateStageBGM.mp3",   # Zombies vs Pirates
    4: "ninjaStageBGM.mp3",    # Zombies vs Ninjas
    5: "robotStageBGM.mp3",    # Zombies vs Robots
    6: "alienStageBGM.mp3",    # Zombies vs Aliens
}
DEFAULT_RAID_MUSIC = "fightBGM.mp3"

# When a family has several boss-flagged units (Robots: BrainBot/BroBot/JunkBot are
# all boss-capable — "any can be the boss"), pick THE boss; the rest become minions.
BOSS_PREF = {5: "RobotStageActorBrainBot"}
# McDonnell's authored ladder: bossIdx 3, population base 7. Every extrapolated raid
# reuses this so fightStage (bossIdx + level − recommendedLevel) paces identically.
LADDER_POP_BASE = 7


def hazard_keys(e):
    """Actor classes a raid spawns as ENVIRONMENTAL HAZARDS rather than wave enemies.

    These carry UnitStats entries (they need hp/damage to interact with zombies) and
    share the raid's `<Family>StageActor` prefix, so a naive prefix sweep files them as
    minions. The beach Crab is the case that bit us: `BeachStageActorCrab` has no
    "Obstacle" in its name — unlike TreeWorldStageTurtleObstacleActor — so only the
    raid's own hazard fields identify it. It was landing in the endless-wave spawn pool
    and marching in as a regular enemy."""
    keys = set(e.get("obstacleActors") or [])
    if e.get("initialSpawnClass"):
        keys.add(e["initialSpawnClass"])
    return keys


def family_parts(rid, unit_stats, hazards=frozenset()):
    """Resolve a raid's (primary, secondary, boss, all_minions) from UnitStats.

    primary  = the weakest grunt (str+con) — the numerous common enemy, like the
               single Farmhand McDonnell opens with. secondary = the toughest grunt
               (the McDonnell Lumberjack that rounds out a full wave). all_minions is
               weak→strong for the population pool. `hazards` (see hazard_keys) are
               excluded — they spawn on the obstacle timer, not in a wave. Returns
               (None, None, None, []) if the family can't be resolved."""
    pfx = STAGE_FAMILY.get(rid)
    if not pfx:
        return None, None, None, []
    members = sorted(k for k in unit_stats if k.startswith(pfx) and k not in hazards)
    if not members:
        return None, None, None, []
    bosses = [k for k in members if unit_stats[k].get("bossActions")]
    boss = BOSS_PREF.get(rid) or (bosses[0] if bosses else None)
    minions = [k for k in members if k != boss] or members
    minions.sort(key=lambda k: fnum(unit_stats[k].get("str")) + fnum(unit_stats[k].get("con")))
    primary = minions[0]
    secondary = minions[-1] if len(minions) > 1 else minions[0]
    return primary, secondary, boss, minions


def population_pool(minions):
    """Weighted spawn table for a population wave: weaker minions are more common
    (McDonnell's endless waves are Farmhand-heavy with the odd Lumberjack). minions
    arrive weak→strong, so give descending weights."""
    if len(minions) == 1:
        return [{"enemy": minions[0], "frequency": 100}]
    weights = list(range(len(minions), 0, -1))  # weakest gets the highest weight
    total = sum(weights)
    return [
        {"enemy": m, "frequency": round(100 * w / total)}
        for m, w in zip(minions, weights)
    ]


def build_ladder(rid, unit_stats, base_pop, hazards=frozenset()):
    """Extrapolate McDonnell's 7-stage difficulty ladder onto a raid, using its own
    minions/boss. Stage indices mirror McDonnell exactly (bossIdx 3): the pre-boss
    stages grow the grunt count, then the boss appears at recommendedLevel, then two
    endless population waves. Unlike McDonnell — whose first boss stage disables
    throwing — every OTHER boss throws from its first appearance (stage 3). Returns []
    if the family can't be resolved (raid then falls back to any source stages)."""
    primary, secondary, boss, minions = family_parts(rid, unit_stats, hazards)
    if not primary or not boss:
        return []
    full = [primary, primary, primary, primary, secondary]
    pool = population_pool(minions)
    defs = [
        {"enemyKeys": [primary]},                                            # 0
        {"enemyKeys": [primary, primary, primary]},                          # 1
        {"enemyKeys": list(full)},                                           # 2
        {"enemyKeys": list(full), "bossKey": boss},                          # 3 boss + throws
        {"enemyKeys": list(full), "bossKey": boss},                          # 4 boss + throws
        {"bossKey": boss, "population": base_pop, "weighted": pool},          # 5 endless
        {"bossKey": boss, "population": base_pop + 3, "weighted": pool},      # 6 endless+
    ]
    for i, s in enumerate(defs):
        s["wave"] = i + 1
        s["synthesized"] = True
    return defs


def stages_for(rid, e, unit_stats):
    """Final per-level stage ladder for a raid.

    McDonnell (a full authored ladder) is kept verbatim, except its population-only
    stages get a weighted minion pool attached — buildEnemyUnits spawns nothing from a
    bare `population` field, so without this those late stages would be boss-only.
    Every other raid gets McDonnell's ladder shape extrapolated onto its own family,
    seeded with the raid's real source population where the source authored one stage."""
    real = [norm_stage(s) for s in e.get("stageSettings", []) or []]
    hazards = hazard_keys(e)
    primary, secondary, boss, minions = family_parts(rid, unit_stats, hazards)
    src_pop = next((s["population"] for s in real if s.get("population")), None)
    if len(real) >= 3:  # a genuine authored ladder (McDonnell) — keep it
        if minions:
            for s in real:
                if s.get("population") and not s.get("enemyKeys") and not s.get("weighted"):
                    s["weighted"] = population_pool(minions)
        return real
    ladder = build_ladder(rid, unit_stats, src_pop or LADDER_POP_BASE, hazards)
    return ladder or real


def load(name):
    return json.load(open(os.path.join(GAMEPLAY, name), encoding="utf-8"))


def as_int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def fnum(v, default=0.0):
    """Float parse that tolerates the source's fractional stats (e.g. str "1.5")."""
    try:
        return float(str(v).strip())
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
        stages = stages_for(rid, e, unit_stats)
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
            # Looping battle BGM (see RAID_MUSIC): themed track for the 5 stages that
            # ship one, generic fightBGM for the rest. Swapped in for the farm's
            # dayFarmBGM while the raid scene is up, then restored on exit.
            "music": RAID_MUSIC.get(rid, DEFAULT_RAID_MUSIC),
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
