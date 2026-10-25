"""
Quest-data prep for the ZF2R quest engine.

Reads the extracted 1.0 app bundle's Quests.plist (the authoritative, data-driven
quest definitions) and produces:

  public/assets/quests.json      all 105 quests, normalized to JSON (71 standard +
                                 34 Epic Boss event quests, incl. the Bully Frog
                                 records embedded in the EpicEventEnemy row)
  public/assets/ui/<sprite>.png  each quest's top-level rail icon (loose PNGs)

The quest engine (src/quest/) consumes quests.json at runtime. Every quest is kept,
including raid/social/seasonal ones whose trigger events don't have emitters yet;
those simply never advance until their system lands (dormant, not broken).

Run:  python tools/prep_quests.py
"""
import os, re, io, json, plistlib, shutil

import quest_xp_rebalance

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
APP = os.path.normpath(os.path.join(
    PROJ, "..", "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app"))
OUT = os.path.join(PROJ, "public", "assets")
UI = os.path.join(OUT, "ui")

CTRL = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")  # invalid XML control bytes

# ---- Objective wording vs. what the objective actually accepts ---------------
# Decor sold in several colors is ONE item for quest purposes: buying any Fence
# satisfies "Fence", because every recolor answers to its siblings' names (see
# src/quest/objectVariants.ts). The source objective text names a color anyway —
# "Buy 4 White Fences" against the requirement "Fence", "Buy 2 Red Balloons"
# against "Balloon" — which tells the player to hunt a specific card that is not
# actually required, and in the Flower Bed case is now outright wrong.
#
# So: when an objective's subject belongs to a recolor family, the color adjective
# comes out of its text. Objectives naming genuinely distinct art keep theirs — the
# Easter eggs and circus flags are separate sprites, not tints, and "Orange Tree"
# is a fruit.
#
# NOTE: reads the generated placeables.json, so prep_placeables.py runs first.
COLOR_WORD = re.compile(
    r"\b(white|red|blue|black|pink|yellow|violet|purple|green|silver|gold|orange|brown)\s+",
    re.IGNORECASE)
LEADING_COUNT = re.compile(r"\d+")

# ---- Quest gates the shipped data gets wrong ---------------------------------
# A quest whose objective needs something the player cannot yet buy or plant sits
# on the rail as an impossible task. The source gates predate Reforged's own
# catalogs, so a handful have to be re-cut here — this table is authoritative over
# Quests.plist, and lives in the generator (not in quests.json) so a regeneration
# cannot silently revert it, exactly like CROP_REBALANCE in reforge_economy.py.
#
# Most of these come from the crop rebalance (tools/reforge_economy.py), which
# respread the 25 regular crops over levels 1-45: every quest below asked for a
# crop that now unlocks later than the quest did. Each gate is the highest crop
# level the quest requires — no higher, so nothing is delayed further than the
# objective itself demands. src/quest/cropUnlockAlignment.test.ts is what fails if
# this table and the crop ladder ever drift apart again.
#
# `levelRequired` is the quest's OWN gate. The real gate is the highest in its
# prerequisite chain, so a quest that already inherits enough needs no entry.
QUEST_LEVEL_OVERRIDES = {
    # quest id: (level, why)
    "0":  (3,  "Tomatoes moved to level 3; inherited a level-1 gate from quest 2"),
    "6":  (9,  "Bread Fruit moved to level 9"),
    "31": (41, "Corpse Flower moved to level 41"),
    "32": (29, "Broccoli 23 + Cauliflower 29; the later of the two decides"),
    "33": (21, "Spineapple moved to level 21"),
    "57": (44, "Eyebiscus moved to level 44"),
    "58": (45, "Heartichoke moved to level 45 (the cap, and the capstone crop)"),
    "59": (45, "Eyebiscus 44 + Heartichoke 45; set explicitly rather than relying "
               "on inheriting 45 from quest 58"),
    # Not a crop: The Perfect Yard requires the Lawnmower, which the Market does
    # not sell until level 45, while the quest shipped at 44.
    "61": (45, "Lawnmower unlocks at level 45"),
    # Not a crop either: quest 22 ships with levelRequired -1, but its prerequisite
    # (quest 21) is gated at 25, so 25 is where it actually unlocks. Spelling that
    # out is what lets quest_xp_rebalance price it as the level-25 quest it is
    # instead of a level-1 one.
    "22": (25, "prerequisite quest 21 is gated at 25; the -1 was never the real gate"),
}

# ---- Objective sizes the shipped data gets wrong ------------------------------
# Quests.plist sizes every objective for the front of the original game. A few ask
# for so little that the quest is over before it registers — and because the XP
# rule prices on `levelRequired` alone (see quest_xp_rebalance), asking for less
# work never cost them anything. Resizing them here, in the generator, keeps a
# regeneration from reverting it.
#
# Counts apply positionally to the quest's requirements list.
QUEST_COUNT_OVERRIDES = {
    # quest id: (counts per requirement, why)
    "32": ((25, 25), "10 Broccoli + 10 Cauliflower for 900 XP at level 29 was 45 "
                     "XP/harvest — an order above every other harvest quest"),
    "59": ((50, 50), "25 + 25 for 3750 XP at the level cap was 75 XP/harvest"),
}

# ---- The Halloween invasion's quests -----------------------------------------
# 48 Down for the Count, 49 Six Feet Under and 50 Uber Loser ship `seasonal`, which
# keeps them off the rail (QuestSystem.eligible / the server engine skip seasonal
# quests), and 48 and 50 listen for the invasion under its source quest subject
# "Seasonal : Halloween". The reconstructed invasion (prep_raids.HALLOWEEN_ENEMY)
# settles as "Halloween", and like the other seasonal invasions it is always on, so
# these become ordinary quests aimed at that name — the way Tree World's 51/52 are.
HALLOWEEN_QUESTS = ("48", "49", "50")
HALLOWEEN_SOURCE_SUBJECT = "Seasonal : Halloween"
HALLOWEEN_RAID_NAME = "Halloween"


def recolor_families():
    """Display name -> base tile, for every color of a multi-color decor item."""
    path = os.path.join(OUT, "placeables.json")
    if not os.path.exists(path):
        return {}
    rows = json.load(open(path, encoding="utf-8"))
    by_key = {r["key"]: r for r in rows}
    families = {}
    for row in rows:
        base = row.get("variantOf")
        if not base or base not in by_key:
            continue
        families[row["name"]] = base
        families[by_key[base]["name"]] = base
    return families


def decolor_objective(text, subject, families):
    """Drop the color adjective from `text` when any color satisfies `subject`."""
    if subject not in families:
        return text
    return COLOR_WORD.sub("", text, count=1)


def merge_recolor_objectives(reqs, families):
    """Fold objectives that decoloring left indistinguishable.

    Quest 28 asks for 2 Red, 2 Violet and 2 Yellow Flower Beds. Those are three
    tints of one sprite, so any flower bed satisfies any of the three lines — and
    once the color comes out of the text they render as the same sentence three
    times. Merged, that is one honest "Buy 6 Flower Beds" for the same six items.

    Only same-family, same-event, same-text neighbours merge, so objectives that
    merely read alike but need different things are left alone.
    """
    out = []
    wording = []  # each accumulator's text BEFORE its count was rewritten
    for r in reqs:
        prev = out[-1] if out else None
        family = families.get(r["notificationObject"])
        mergeable = (
            prev is not None
            and family is not None
            and families.get(prev["notificationObject"]) == family
            and prev["notificationID"] == r["notificationID"]
            and prev["type"] == r["type"]
            # Compare the ORIGINAL wording: after a merge the accumulator reads
            # "Buy 4 ..." and would stop matching the third "Buy 2 ..." sibling.
            and wording[-1] == r["text"]
        )
        if not mergeable:
            out.append(dict(r))
            wording.append(r["text"])
            continue
        prev["countTotal"] += r["countTotal"]
        # "Buy 2 Flower Beds" x3 -> "Buy 6 Flower Beds"
        prev["text"] = LEADING_COUNT.sub(str(prev["countTotal"]), wording[-1], count=1)
    return out


def load_plist(path):
    raw = CTRL.sub(b"", open(path, "rb").read())
    return plistlib.load(io.BytesIO(raw))


# ---- Epic ladder rescale -------------------------------------------------
# Every Epic Boss event now runs 20 levels instead of 40 (see
# tools/prep_all_epic_bosses.py MAX_LEVEL: ZF2 only ever authored 20 HP multipliers, so
# levels 21-40 were a copy of level 20 and added grind rather than difficulty). The
# quests that gate each event's prizes were authored against the 40-rung ladder, so a
# "Defeat Loco Locust Level 40" objective would now be unreachable and every milestone
# above 20 would sit off the end of the ladder.
#
# Each threshold is therefore halved, rounded up: 5 -> 3, 10 -> 5, 15 -> 8, 20 -> 10,
# 25 -> 13, 30 -> 15, 35 -> 18, 40 -> 20. That keeps every quest, keeps their order, and
# keeps each prize at the same FRACTION of its ladder as before. The top prize is
# unaffected in difficulty: old level 40 and new level 20 are the same 107x fight.
#
# Dr. Groundhog's 1xxx quests are excluded — its ladder was authored at 20 rungs and its
# thresholds already sit on it. (Note 10000/10011 are Mystical Mamba, NOT Groundhog: the
# range test below is deliberate, a `startswith("1")` check silently skips them.)
EPIC_LADDER_SCALE = (10, 40)  # new rungs, old rungs
# Dr. Groundhog's 1xxx quests were authored against the 20-rung curve, not the 40-rung
# advertisement, so they rescale from their own origin. (Note 10000/10011 are Mystical
# Mamba, NOT Groundhog: the numeric range test below is deliberate, and a
# `startswith("1")` check would silently sweep them up.)
GROUNDHOG_LADDER_SCALE = (10, 20)
EPIC_DEFEAT_NOTIFICATION = "kEpicStageEnemyDefeatedNotification"

# Where the two headline prizes sit, PINNED rather than derived — the normal event zombie
# on rung 5, the omega on rung 10. Keyed by quest-id suffix, which is the convention every
# event follows (X000 is the ordinary prize, X011 the omega).
#
# Pinned because the arithmetic does not land where the design wants it. Rescaling from 40
# rungs to 10 puts most ordinary prizes on rung 2, which hands a player the event's own
# zombie almost before the event starts. Half-way and the top are the rungs that mean
# something on a 10-rung ladder, so those are stated outright.
EPIC_PRIZE_RUNGS = {"000": 5, "011": 10}


def _retarget(quest, r, new):
    """Move one defeat requirement to rung `new`, carrying its prose with it."""
    old = int(r["notificationObject"])
    if new == old:
        return
    r["notificationObject"] = str(new)
    r["text"] = re.sub(rf"\b{old}\b", str(new), r["text"])
    for field in ("title", "messageComplete", "tip"):
        if field in quest:
            quest[field] = re.sub(rf"(?i)(level\s+){old}\b", rf"\g<1>{new}", quest[field])


def rescale_epic_ladder(out):
    """Rescale every Epic Boss level threshold onto the current rung count."""
    for qid, quest in out.items():
        new_max, old_max = (GROUNDHOG_LADDER_SCALE if 1000 <= int(qid) < 2000
                            else EPIC_LADDER_SCALE)
        for r in quest.get("requirements", []):
            if r.get("notificationID") != EPIC_DEFEAT_NOTIFICATION:
                continue
            # Floored at 1: quartering a low threshold can otherwise reach rung 0, which
            # no clear ever satisfies and which would strand the prize behind it.
            _retarget(quest, r, max(1, -(-int(r["notificationObject"]) * new_max // old_max)))


def pin_epic_prize_rungs(out):
    """Put each event's ordinary prize on rung 5 and its omega on rung 10.

    Runs AFTER rescale_epic_ladder, and moves only the LAST defeat requirement — a prize
    gated behind a collection chain (Skunkarella's Diva) keeps its earlier steps spread
    below the pinned one rather than collapsing them all onto the same rung.
    """
    for qid, quest in out.items():
        target = EPIC_PRIZE_RUNGS.get(str(qid)[-3:])
        if target is None:
            continue
        defeats = [r for r in quest.get("requirements", [])
                   if r.get("notificationID") == EPIC_DEFEAT_NOTIFICATION]
        if not defeats:
            continue
        _retarget(quest, max(defeats, key=lambda r: int(r["notificationObject"])), target)


def main():
    os.makedirs(UI, exist_ok=True)
    quests = load_plist(os.path.join(APP, "Quests.plist"))
    families = recolor_families()

    # Normalize: keep the fields the runtime needs, coerce questID to int, and
    # default the sparse optional flags so the TS side has a stable shape.
    out = {}
    icons = set()
    def add_quest(k, q):
        reqs = []
        for r in q.get("requirements", []):
            subject = r.get("notificationObject", "")
            reqs.append({
                "notificationID": r.get("notificationID", ""),
                "notificationObject": subject,
                "countTotal": int(r.get("countTotal", 1)),
                "text": decolor_objective(r.get("text", ""), subject, families),
                "type": int(r.get("type", 2)),
                "sprite": r.get("sprite", ""),
            })
        sprite = q.get("sprite", "")
        if sprite:
            icons.add(sprite)
        qid = str(int(q.get("questID", int(k))))
        out[qid] = {
            "id": str(int(q.get("questID", int(k)))),
            "title": q.get("title", ""),
            "messageComplete": q.get("messageComplete", ""),
            "tip": q.get("tip", ""),
            "sprite": sprite,
            "levelRequired": int(q.get("levelRequired", -1)),
            "prerequisiteQuest": int(q.get("prerequisiteQuest", -1)),
            "requirements": merge_recolor_objectives(reqs, families),
            "rewardType": int(q.get("rewardType", 0)),
            "rewardValue": int(q.get("rewardValue", 0)) if q.get("rewardValue") is not None else 0,
            "rewardItem": q.get("rewardItem") or "",
            # An ITEM reward (rewardType 3) is granted into Received, which resolves
            # placeables by DISPLAY NAME — so its key is the display name and the
            # source omits the redundant field. Only ZOMBIE rewards (type 5) carry a
            # separate key (a ZombieActor* id). Without this fallback, regenerating
            # blanks the reward on the eight type-3 quests and they grant nothing.
            "rewardItemKey": (q.get("rewardItemKey")
                              or (q.get("rewardItem") if int(q.get("rewardType", 0)) == 3 else "")
                              or ""),
            "tutorialQuest": bool(q.get("tutorialQuest", False)),
            "epicEvent": bool(q.get("epicEvent", False)),
            "seasonal": bool(q.get("seasonal", False)),
            "seasonalDate": q.get("seasonalDate") or "",
            "removeQuest": bool(q.get("removeQuest", False)),
            "ignoreCheckQuest": bool(q.get("ignoreCheckQuest", False)),
        }

    for k, q in quests.items():
        add_quest(k, q)

    # Re-cut the gates the shipped data gets wrong (see QUEST_LEVEL_OVERRIDES).
    for qid, (level, _why) in QUEST_LEVEL_OVERRIDES.items():
        if qid not in out:
            raise SystemExit(f"quest gate override names unknown quest {qid}")
        out[qid]["levelRequired"] = level

    # Re-size the objectives that ask for too little (see QUEST_COUNT_OVERRIDES).
    # The displayed text carries the count too, so it moves with the requirement.
    for qid, (counts, _why) in QUEST_COUNT_OVERRIDES.items():
        if qid not in out:
            raise SystemExit(f"quest count override names unknown quest {qid}")
        reqs = out[qid]["requirements"]
        if len(counts) != len(reqs):
            raise SystemExit(
                f"quest {qid} count override has {len(counts)} counts "
                f"for {len(reqs)} requirements")
        for r, n in zip(reqs, counts):
            r["countTotal"] = n
            r["text"] = LEADING_COUNT.sub(str(n), r["text"], count=1)

    # Wake the Halloween quests and point them at the invasion (see HALLOWEEN_QUESTS).
    for qid in HALLOWEEN_QUESTS:
        if qid not in out:
            raise SystemExit(f"Halloween quest {qid} is missing")
        out[qid]["seasonal"] = False
        for r in out[qid]["requirements"]:
            if r["notificationObject"] == HALLOWEEN_SOURCE_SUBJECT:
                r["notificationObject"] = HALLOWEEN_RAID_NAME

    # Bully Frog's only surviving quest definitions are embedded in its
    # EpicEventEnemy row rather than Quests.plist. Import the unambiguous 3xxx
    # records; several middle milestones incorrectly reuse Groundhog's 1xxx IDs
    # in the shipped data and must not overwrite those quests.
    epic_enemies = load_plist(os.path.join(APP, "EpicEventEnemy.plist"))
    for enemy in epic_enemies:
        if int(enemy.get("epicBossID", -1)) != 3:
            continue
        for q in enemy.get("Quests", []):
            qid = int(q.get("questID", -1))
            if 3000 <= qid < 4000:
                add_quest(str(qid), q)

    # MUST run before the recovered rewards below are added: this halves every epic
    # threshold it finds, and those entries are already authored on the 20-rung ladder
    # (see their comment). Running it afterwards halved them a SECOND time — 20 -> 10,
    # 5 -> 3 — silently demoting six prize quests on any regeneration.
    rescale_epic_ladder(out)
    pin_epic_prize_rungs(out)

    # Bosses 8-10 shipped after the last complete quest table. Their art catalogs
    # and named prize rigs survived, so restore the unambiguous milestone rewards.
    # Skunkarella likewise names Madame Zombie as its epic prize even though only
    # the earlier Diva collection quest survived in Quests.plist.
    # Levels are the CURRENT ladder's, and follow the same pinning as every other event
    # (EPIC_PRIZE_RUNGS): the ordinary prize on rung 5, the omega on rung 10. These are
    # added after rescale_epic_ladder and pin_epic_prize_rungs have run, so they are
    # written at their final values rather than passed through either.
    recovered_epic_rewards = [
        (5011, 10, "Madame Zombie", "ZombieActorMadame", "questicon_skunkarella.png"),
        (8000, 5, "Brock Coley", "ZombieActorBrockColey", "questicon_rockyrhino.png"),
        # Rocky Rhino is the one event whose only recovered prize sat on rung 5, so its
        # top five rungs paid nothing at all. It pays a SECOND Brock Coley on rung 10
        # rather than a new named zombie: Brock is already the reason the event is
        # gated at level 30 (see EPIC_BOSS_UNLOCK_LEVELS), and inventing an eighth
        # omega prize would price the ladder against a zombie ZF2 never authored.
        (8011, 10, "Brock Coley", "ZombieActorBrockColey", "questicon_rockyrhino.png"),
        (9000, 5, "Proto Zombie", "ZombieActorProto", "questicon_generallarvaelus.png"),
        (9011, 10, "Zombug", "ZombieActorZombug", "questicon_generallarvaelus.png"),
        (10000, 5, "Zomdini", "ZombieActorZomdini", "questicon_mysticalmamba.png"),
        (10011, 10, "Zomtar", "ZombieActorZomtar", "questicon_mysticalmamba.png"),
    ]
    # A boss that pays the SAME zombie on both rungs needs its second quest to read as
    # a second one in the rail, where only the title is shown.
    repeat_prize_titles = {8011: ("Another Brock Coley", "A second Brock Coley joins the farm!")}
    for qid, level, name, key, sprite in recovered_epic_rewards:
        title, message = repeat_prize_titles.get(qid, (name, f"You earned {name}!"))
        add_quest(str(qid), {
            "questID": qid, "title": title,
            "messageComplete": message,
            "tip": f"Defeat the Epic Boss at level {level}.", "sprite": sprite,
            "levelRequired": -1, "prerequisiteQuest": -1,
            "requirements": [{
                "notificationID": "kEpicStageEnemyDefeatedNotification",
                "notificationObject": str(level), "countTotal": 1,
                "text": f"Epic Boss Level {level} Defeated", "type": 3,
                "sprite": "stex1003.png",
            }],
            "rewardType": 5, "rewardValue": 0, "rewardItem": name,
            "rewardItemKey": key, "epicEvent": True, "ignoreCheckQuest": True,
        })

    # Shipped Epic quests point their named prizes at generic actor classes.
    # Restore dedicated roster identities for every implemented event reward.
    epic_reward_keys = {
        "1000": "ZombieActorDrZombie", "1011": "ZombieActorOmegaDrZombie",
        "2000": "ZombieActorBandido", "2011": "ZombieActorVagabond",
        "3000": "ZombieActorCaptain", "3011": "ZombieActorAdmiral",
        "4000": "ZombieActorChristmasGhost", "4011": "ZombieActorScrooge",
        "5000": "ZombieActorDiva", "5011": "ZombieActorMadame",
        "8000": "ZombieActorBrockColey", "8011": "ZombieActorBrockColey",
        "9000": "ZombieActorProto",
        "9011": "ZombieActorZombug", "10000": "ZombieActorZomdini",
        "10011": "ZombieActorZomtar",
    }
    for qid, key in epic_reward_keys.items():
        out[qid]["rewardItemKey"] = key

    # Reprice every XP reward against the level it unlocks at. The imported values were
    # authored for the front of the original game and are worth ~1% of a level by the
    # forties; see tools/quest_xp_rebalance.py for the bands. Applied HERE so a
    # regeneration cannot silently restore the source numbers.
    repriced = quest_xp_rebalance.apply(out)

    for boss_dir, icon in [
        ("skunkarella", "questicon_skunkarella.png"),
        ("rocky-rhino", "questicon_rockyrhino.png"),
        ("general-larvaelus", "questicon_generallarvaelus.png"),
        ("mystical-mamba", "questicon_mysticalmamba.png"),
    ]:
        src = os.path.join(OUT, "epic-bosses", boss_dir, "quest-icon.png")
        if os.path.exists(src):
            shutil.copy(src, os.path.join(UI, icon))

    with open(os.path.join(OUT, "quests.json"), "w") as f:
        json.dump(out, f, indent=1)

    copied = 0
    for s in sorted(icons):
        src = os.path.join(APP, s)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(UI, s))
            copied += 1
        elif not os.path.exists(os.path.join(UI, s)):
            print(f"  WARN missing quest icon: {s}")

    print(f"quests: wrote {len(out)} quests ({len(repriced)} XP rewards repriced)"
          f" + copied {copied}/{len(icons)} rail icons")


if __name__ == "__main__":
    main()
