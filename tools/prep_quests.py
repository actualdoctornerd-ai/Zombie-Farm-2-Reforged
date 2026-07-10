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
    for k, q in quests.items():
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
        out[str(int(q.get("questID", int(k))))] = {
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

    with open(os.path.join(OUT, "quests.json"), "w") as f:
        json.dump(out, f, indent=1)

    copied = 0
    for s in sorted(icons):
        src = os.path.join(APP, s)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(UI, s))
            copied += 1
        else:
            print(f"  WARN missing quest icon: {s}")

    print(f"quests: wrote {len(out)} quests + copied {copied}/{len(icons)} rail icons")


if __name__ == "__main__":
    main()
