"""Export the source game's Farmer market and modular player attachments."""
import json
import os
import plistlib

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
APP = os.path.normpath(os.path.join(
    PROJ, "..", "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app"))
OUT = os.path.join(PROJ, "public", "assets", "farmer.json")


def load(name):
    with open(os.path.join(APP, name), "rb") as handle:
        return plistlib.load(handle)


market = load("Market.plist")["Entries"]
players = load("PlayerDictionary.plist")

EFFECTS = {
    12: {"key": "harvestGold", "amount": 0.10},
    14: {"key": "harvestGold", "amount": 0.10},
    13: {"key": "zombieGrowTime", "amount": -0.25},
    2: {"key": "zombieLife", "amount": 0.10},
    6: {"key": "zombieLife", "amount": 0.10},
    3: {"key": "zombieStrength", "amount": 0.10},
    7: {"key": "zombieStrength", "amount": 0.10},
    8: {"key": "invasionCooldown", "amount": -0.25},
    9: {"key": "invasionCooldown", "amount": -0.25},
}

heads = []
bodies = {}
for entry in market:
    if entry.get("categoryID") != 90 or entry.get("dontShowInMarket") is True:
        continue
    head_id = int(entry["headID"])
    attachments = players[str(head_id)]["attachments"]
    parts = {part["attachmentID"]: part["key"] for part in attachments}
    body_id = int(entry.get("bodyID", 1 if "female" in parts["kActorPartTagBody"] else 0))
    head = {
        "id": head_id,
        "name": entry["name"],
        "part": parts["kActorPartTagHead"],
        "bodyId": body_id,
        "sort": int(entry.get("sortPriority", 999)),
    }
    if "cost" in entry:
        head["cost"] = int(entry["cost"])
        head["brains"] = bool(entry.get("brainsNeeded", False))
    info = " ".join(filter(None, [entry.get("info"), entry.get("info2")]))
    if info:
        head["description"] = info
    if head_id in EFFECTS:
        head["effect"] = EFFECTS[head_id]
    heads.append(head)

    body_key = parts["kActorPartTagBody"]
    bodies[body_id] = {
        "id": body_id,
        "name": ("Female" if body_key.startswith("female") else "Male") +
                (" Body 2" if body_key.endswith("2.png") else " Body 1"),
        "body": body_key,
        "arm1": parts["kActorPartTagArmB"],
        "arm2": parts["kActorPartTagArmF"],
        "arm3": parts["kActorPartTagArmB"].replace("1.png", "3.png"),
        "arm4": parts["kActorPartTagArmF"].replace("2.png", "4.png"),
    }

result = {
    "heads": sorted(heads, key=lambda item: (item["sort"], item["id"])),
    # Bodies have no independent source price, so they are intentionally unlocked.
    "bodies": [bodies[key] for key in sorted(bodies)],
}
with open(OUT, "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"farmer: exported {len(result['heads'])} heads and {len(result['bodies'])} bodies")
