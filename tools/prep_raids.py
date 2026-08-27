"""
Raid/invasion prep for the ZF2R reimplementation.

Reads the source invasion catalog + combat stats and emits a runtime bundle:

  public/assets/raids/raids.json         normalized RaidDef[] (all 11 invasions)
  public/assets/raids/enemy_stats.json   { unitKey -> stats } for every enemy/boss
                                         referenced by any raid stage
  public/assets/raids/attacks.json       { attackName -> {damageMultiplier,...} }
                                         for every attack those enemies use
  public/assets/raids/images/...         boss portraits + stage backgrounds

Every raid's wave composition is taken from the source VERBATIM (see stages_for).
The binary picks the fought stage once, as `stageSettings[playerLevel −
recommendedLevel]` clamped, with no in-fight wave advancement — so only Old McDonnell
(ID 1), the one raid shipping a 7-entry ladder, scales with player level. Lawyers /
Tree World / Valentine's author a single `stageSettings` stage; the other 7 invasions
author their single wave on the raid entry's own `population` + `enemies` + `boss`
fields. All three shapes are honoured, so those 10 raids field one fixed wave at every
level, exactly as the source does.

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

# DELIBERATE DIVERGENCE from Enemies.json: the three seasonal invasions all ship
# stacked at level 8 (`level` and `reccomendedLevel` alike, so all three landed at
# once). Spread them so the early ladder paces out: Valentine's Day at 6, Tree World
# kept at 8, Summer Break (the beach/Spring Break invasion) at 10. Applied to BOTH
# unlockLevel and recommendedLevel — the pair mirror each other on every non-tutorial
# raid — so everything priced off the raid's rung re-fits on its own: the boss-throw
# yardstick (RaidCatalog.targetThrowDamage reads unlockLevel) and the brain-drop ramp
# (brainDrops.ts reads recommendedLevel). Tree World's two Goffy quests stay at
# levelRequired 8, which still matches; no quest references the other two invasions.
LEVEL_OVERRIDES = {
    11: 6,   # Valentine's Day  8 -> 6
    7: 10,   # Summer Break     8 -> 10
}

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
    # Video Games' base is deliberately 1,300 above the wiki's 5,000. It is the last
    # invasion unlocked and the hardest fight on the ladder, and at the wiki figure it
    # paid barely more per run than the Aliens five levels below it.
    9: (6300, 1200),   # Zombies vs Video Games
    10: (1200, 600),   # Tree World
    11: (1200, 600),   # Valentine's Day (filled — not in wiki)
}

# DELIBERATE DIVERGENCE from Attacks.json. Applied to the emitted attacks.json after
# the verbatim copy, so a regeneration does not silently undo it.
#   CorporateBossPunchSpecial — the Lawyers boss's Double Punch (40%). The shipped
#   plist flags it BOTH `knockBack` and `stun`; his wiki page lists his special as a
#   STUN only, and the stun is what makes him distinct (he is the only attack in the
#   whole table carrying `stun: true`). Dropping `knockBack` here keeps the 1 s hold
#   and removes the shove-to-back-of-line, so he no longer plays as another
#   push-back boss. Removing a key -> list it under REMOVE.
ATTACK_OVERRIDES = {
    "CorporateBossPunchSpecial": {"REMOVE": ["knockBack"]},
}

# Deliberate divergences from UnitStats.json, same contract as ATTACK_OVERRIDES: applied
# last so a regeneration cannot silently undo them.
#   AlienStageActorMinion — str 6 -> 5. Nothing is wrong with 6 in isolation; it is a
#   mid-table minion (60 damage a swing on a 1 s clock, against the Ninja Boy's 180 and
#   the Crazed Worker's 20). What changed is that the alien raid is the ONLY swarm in the
#   game — six of them stand on the field at once, and every enemy commits its whole
#   output to the single front-most zombie (which the source does too), so the authored
#   number arrives six times over: 360 damage a second onto one unit, twice the worst any
#   other invasion can produce. Playtest verdict on the shipped value: a full mutated army
#   was "absolutely creamed". 4 read as too soft on the next pass — an ELITE run cleared
#   with no losses at all — so it sits at 5: the swarm lands 300/s, still the heaviest
#   incoming rate on the ladder and still a level-36 fight.
UNIT_OVERRIDES = {
    "AlienStageActorMinion": {"str": 5},
}

# Units a raid SPAWNS but never lists in a stage. `used_units` is walked out of the
# stage tables, so a unit that only ever arrives through a boss action is dropped and
# the runtime has no stats to build it from.
#   VideoGameStageZombieActor — what Zedzox's `turnZombie` makes out of one of YOUR
#   zombies (raid 9). It is authored in UnitStats.json like any other actor (con 10000,
#   dex 6, str 8, VideoGameZombieBite) and ships its own idle/attack frames in
#   spritesheets/zombies/VideoGameZombie, but it appears in no `stageSettings` entry
#   because nothing spawns it as wave population. The con is the tell: 10000 is roughly
#   sixty times a wave minion's, far past what melee can chew through inside a round —
#   this is a hazard you TAP down, not an enemy you out-fight. See BattleSim's
#   `turnZombie` case.
EXTRA_UNITS = {
    "VideoGameStageZombieActor",
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

# When a family has several boss-flagged units, pick THE boss; the rest become minions.
# Empty today: the one family with several boss-capable units is the Robots, and picking
# one for it was the bug — `randomBoss` means the fight draws its own (see
# synth_authored_stage), so pinning BrainBot here made it the boss of every invasion.
BOSS_PREF = {}
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
    """FALLBACK ONLY — extrapolate McDonnell's 7-stage ladder onto a raid that authors
    no wave of its own. Not the normal path: every shipped raid authors its own
    composition and `stages_for` uses that verbatim.

    Stage indices mirror McDonnell exactly (bossIdx 3): the pre-boss stages grow the
    grunt count, then the boss appears at recommendedLevel, then two endless population
    waves. Unlike McDonnell — whose first boss stage disables throwing — every OTHER
    boss throws from its first appearance (stage 3). Returns [] if the family can't be
    resolved (raid then falls back to any source stages)."""
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


def synth_authored_stage(e, boss=None, hazards=frozenset()):
    """The single authored wave of a raid that ships no `stageSettings`.

    Seven raids (Pirates, Ninjas, Robots, Aliens, Summer Break, Circus, Video Games)
    put their wave on the raid entry itself rather than in a stage: `population` is the
    grunt count and `enemies` the weighted spawn table, with `boss` naming the boss.
    That is the same shape `stageSettings` uses, so hand it to `norm_stage`. Hazard
    actors (obstacle / initialSpawnClass) are dropped — they arrive on the obstacle
    timer, not in the wave. Returns None when the entry authors no wave at all.

    ROBOTS (`randomBoss: true`) is the one raid with no named boss, and that is not an
    omission: GROUND TRUTH `-[ZFFightMan initialSpawn]` guards a whole branch on the
    randomBoss flag which copies the raid's `enemies` array into `enemyList`, picks a
    UNIFORMLY RANDOM entry as the boss, and REMOVES it — so the fight fields exactly one
    of each robot with a different boss every time (wiki: "any one of them has a random
    chance to be the Boss"). The stage carries `randomBoss` and NO bossKey; the boss is
    resolved per fight by resolveStageWave(). `boss` stays the family-resolved fallback
    for any other raid whose top-level `boss` is null."""
    pop = as_int(e.get("population"))
    pool = [w for w in (e.get("enemies") or []) if w.get("enemy") not in hazards]
    if not pop or not pool:
        return None
    if e.get("randomBoss"):
        return norm_stage({"randomBoss": True, "population": pop, "enemies": pool})
    return norm_stage({
        "bossKey": e.get("boss") or boss,
        "population": pop,
        "enemies": pool,
    })


def stages_for(rid, e, unit_stats):
    """Final stage list for a raid — the source's AUTHORED composition, verbatim.

    ZF2 picks the fought stage ONCE, by `stageSettings[playerLevel − recommendedLevel]`
    (clamped) — there is no in-fight wave advance. Only McDonnell ships a real ladder;
    every other raid authors a SINGLE wave that is fought identically at every level.

    Three shapes exist in Enemies.json, all handled here:
      * McDonnell (ID 1) — 7 `stageSettings` entries, a genuine per-level ladder.
      * Lawyers / Tree World / Valentine's — exactly ONE `stageSettings` entry
        (bossKey + population + weighted `enemies`).
      * The other 7 raids — no `stageSettings` at all. Their single wave is authored in
        the raid entry's TOP-LEVEL `population` + `enemies` + `boss` fields, which is
        what `synth_authored_stage` lifts into a stage.

    A population stage needs a weighted spawn pool or `buildEnemyUnits` spawns the boss
    alone, so any stage carrying `population` with neither `enemyKeys` nor `weighted`
    gets one derived from the family's minions.

    Extrapolating McDonnell's ladder onto the other raids (the previous behaviour, see
    `build_ladder`) both under-fielded the mid raids — Circus 4500 HP against an
    authored 6300 — and wildly over-fielded Robots / Video Games, whose authored
    populations are 2 and 8. It survives only as the unresolvable-family fallback."""
    real = [norm_stage(s) for s in e.get("stageSettings", []) or []]
    hazards = hazard_keys(e)
    _, _, boss, minions = family_parts(rid, unit_stats, hazards)
    if not real:
        authored = synth_authored_stage(e, boss, hazards)
        if authored:
            real = [authored]
    if minions:
        for s in real:
            if s.get("population") and not s.get("enemyKeys") and not s.get("weighted"):
                s["weighted"] = population_pool(minions)
    if real:
        return real
    # No authored composition anywhere — fall back to the extrapolated ladder so the
    # raid is at least playable, and say so loudly.
    print(f"  ! raid {rid}: no authored wave, falling back to the extrapolated ladder")
    return build_ladder(rid, unit_stats, LADDER_POP_BASE, hazards)


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
    if s.get("randomBoss"):  # boss drawn from `weighted` per fight (see synth_authored_stage)
        out["randomBoss"] = True
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
    used_units = set(EXTRA_UNITS)  # boss-action spawns, which no stage table lists

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
            "unlockLevel": LEVEL_OVERRIDES.get(rid, as_int(e.get("level"))),
            "recommendedLevel": LEVEL_OVERRIDES.get(rid, as_int(e.get("reccomendedLevel"))),  # source typo
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
    # Player presentation alternates these two ordinary attacks, so retain their
    # authored timing/SFX alongside the enemy-used set.
    used_attacks.update({"ZombieBite", "ZombieScratch"})
    attack_defs = {}
    for name in sorted(used_attacks):
        a = attacks.get(name)
        if a is None:
            missing.add(f"Attacks:{name}")
            continue
        attack_defs[name] = a

    # Deliberate divergences (see UNIT_OVERRIDES / ATTACK_OVERRIDES) — applied last so
    # they survive every regeneration.
    for key, override in UNIT_OVERRIDES.items():
        target = enemy_stats.get(key)
        if target is None:
            missing.add(f"UnitOverride:{key}")
            continue
        for field, value in override.items():
            target[field] = value

    for name, override in ATTACK_OVERRIDES.items():
        target = attack_defs.get(name)
        if target is None:
            missing.add(f"AttackOverride:{name}")
            continue
        for key in override.get("REMOVE", []):
            target.pop(key, None)
        for key, value in override.items():
            if key != "REMOVE":
                target[key] = value

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
