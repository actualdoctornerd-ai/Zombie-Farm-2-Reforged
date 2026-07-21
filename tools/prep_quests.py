"""
Quest-data prep for the ZF2R quest engine.

Reads the extracted 1.0 app bundle's Quests.plist (the authoritative, data-driven
quest definitions) and produces:

  public/assets/quests.json      all 96 quests, normalized to JSON
  public/assets/ui/<sprite>.png  each quest's top-level rail icon (loose PNGs)

The quest engine (src/quest/) consumes quests.json at runtime. Every quest is kept,
including raid/social/seasonal ones whose trigger events don't have emitters yet;
those simply never advance until their system lands (dormant, not broken).

Run:  python tools/prep_quests.py
"""
import os, re, io, json, plistlib, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
APP = os.path.normpath(os.path.join(
    PROJ, "..", "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app"))
OUT = os.path.join(PROJ, "public", "assets")
UI = os.path.join(OUT, "ui")

CTRL = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")  # invalid XML control bytes


def load_plist(path):
    raw = CTRL.sub(b"", open(path, "rb").read())
    return plistlib.load(io.BytesIO(raw))


def main():
    os.makedirs(UI, exist_ok=True)
    quests = load_plist(os.path.join(APP, "Quests.plist"))

    # Normalize: keep the fields the runtime needs, coerce questID to int, and
    # default the sparse optional flags so the TS side has a stable shape.
    out = {}
    icons = set()
    def add_quest(k, q):
        reqs = []
        for r in q.get("requirements", []):
            reqs.append({
                "notificationID": r.get("notificationID", ""),
                "notificationObject": r.get("notificationObject", ""),
                "countTotal": int(r.get("countTotal", 1)),
                "text": r.get("text", ""),
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
            "requirements": reqs,
            "rewardType": int(q.get("rewardType", 0)),
            "rewardValue": int(q.get("rewardValue", 0)) if q.get("rewardValue") is not None else 0,
            "rewardItem": q.get("rewardItem") or "",
            "rewardItemKey": q.get("rewardItemKey") or "",
            "tutorialQuest": bool(q.get("tutorialQuest", False)),
            "epicEvent": bool(q.get("epicEvent", False)),
            "seasonal": bool(q.get("seasonal", False)),
            "seasonalDate": q.get("seasonalDate") or "",
            "removeQuest": bool(q.get("removeQuest", False)),
            "ignoreCheckQuest": bool(q.get("ignoreCheckQuest", False)),
        }

    for k, q in quests.items():
        add_quest(k, q)

    # The Perfect Yard requires the Lawnmower, which unlocks at level 45. Do not
    # surface the quest at the shipped level 44 while one required purchase is
    # still locked in the Market.
    out["61"]["levelRequired"] = 45

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

    # Bosses 8-10 shipped after the last complete quest table. Their art catalogs
    # and named prize rigs survived, so restore the unambiguous milestone rewards.
    # Skunkarella likewise names Madame Zombie as its epic prize even though only
    # the earlier Diva collection quest survived in Quests.plist.
    recovered_epic_rewards = [
        (5011, 40, "Madame Zombie", "ZombieActorMadame", "questicon_skunkarella.png"),
        (8000, 10, "Brock Coley", "ZombieActorBrockColey", "questicon_rockyrhino.png"),
        (9000, 5, "Proto Zombie", "ZombieActorProto", "questicon_generallarvaelus.png"),
        (9011, 40, "Zombug", "ZombieActorZombug", "questicon_generallarvaelus.png"),
        (10000, 5, "Zomdini", "ZombieActorZomdini", "questicon_mysticalmamba.png"),
        (10011, 40, "Zomtar", "ZombieActorZomtar", "questicon_mysticalmamba.png"),
    ]
    for qid, level, name, key, sprite in recovered_epic_rewards:
        add_quest(str(qid), {
            "questID": qid, "title": name,
            "messageComplete": f"You earned {name}!",
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
        "8000": "ZombieActorBrockColey", "9000": "ZombieActorProto",
        "9011": "ZombieActorZombug", "10000": "ZombieActorZomdini",
        "10011": "ZombieActorZomtar",
    }
    for qid, key in epic_reward_keys.items():
        out[qid]["rewardItemKey"] = key

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

    print(f"quests: wrote {len(out)} quests + copied {copied}/{len(icons)} rail icons")


if __name__ == "__main__":
    main()
