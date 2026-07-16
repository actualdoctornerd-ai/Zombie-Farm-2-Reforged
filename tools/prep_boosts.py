"""
Boost/consumable prep for the ZF2R market.

Reads the source Market.json boost entries (categoryID 40 / category "boost") and
emits a runtime catalog + icons:

  public/assets/boosts.json        the consumable catalog
  public/assets/boosts/<key>.png   each boost's 32x32 icon (loose stex PNGs)

Effect classification (from the entry's boolean flags):
  instaGrow    -> "grow"          single-use: grows ONE crop; bought 10x per purchase
  instaHarvest -> "harvest"       harvest every ripe plot
  instaPlow    -> "plow"          re-plow all harvested (spent) plots
  treatAsGift  -> "gift"          grant a specific zombie (giftZombieKey)
  instaHunger  -> "concentration" invasion boost -> spent on the Invade screen
  goldenDice   -> "dice"          invasion boost -> spent on the Invade screen

Refresher boosts are skipped entirely — the game has no crop-freshness system, so
crops stay at full sell value once ripe and there is nothing to refresh.

Farm-usable effects (grow/harvest/plow/gift) set usableOnFarm=true; the
invasion boosts (concentration/dice) are spent from the Invade screen instead.

Run:  python tools/prep_boosts.py
"""
import os, json, shutil, re

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
APP = os.path.normpath(os.path.join(
    PROJ, "..", "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app"))
GAMEPLAY = os.path.normpath(os.path.join(
    PROJ, "..", "ZF2R_extracted", "data", "json", "gameplay"))
OUT = os.path.join(PROJ, "public", "assets")
BOOSTDIR = os.path.join(OUT, "boosts")


def slug(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def effect_of(e):
    if e.get("instaGrow"): return "grow"
    if e.get("instaHarvest"): return "harvest"
    if e.get("instaPlow"): return "plow"
    if e.get("treatAsGift"): return "gift"
    if e.get("instaHunger"): return "concentration"
    if e.get("goldenDice"): return "dice"
    return "other"


FARM_USABLE = {"grow", "harvest", "plow", "gift"}


def main():
    os.makedirs(BOOSTDIR, exist_ok=True)
    market = json.load(open(os.path.join(GAMEPLAY, "Market.json"), encoding="utf-8"))["Entries"]
    zombies = json.load(open(os.path.join(OUT, "zombies.json"), encoding="utf-8"))

    # Resolve a gift's flavor zombie name -> a real catalog key (prefer exact name).
    def gift_key(e):
        want = (e.get("info") or e.get("flavorText") or "").replace("Get a", "").replace("!", "").strip()
        # Some seasonal variants say "pink Cupid Zombie" but the catalog name is just
        # "Cupid Zombie" — so try exact, then exact after dropping a leading colour word.
        candidates = [want]
        m = re.match(r"(?i)(pink|blue|red|golden|green)\s+(.+)", want)
        if m:
            candidates.append(m.group(2))
        for c in candidates:
            for z in zombies:
                if z["name"].lower() == c.lower():
                    return z["key"]
        for z in zombies:  # last resort: the wanted phrase contains the catalog name
            if want and want.lower() in z["name"].lower():
                return z["key"]
        return ""

    boosts = []
    icons = 0
    for e in market:
        if not isinstance(e, dict):
            continue
        if e.get("category") != "boost" and e.get("categoryID") != 40:
            continue
        # Skip mystery/event fragments with no price (Rusty Key/Fragment etc.).
        if e.get("cost") is None:
            continue
        # Skip Refresher boosts: there is no crop-freshness system to refresh.
        if e.get("refresher"):
            continue
        eff = effect_of(e)
        key = e.get("tile") or slug(e["name"])
        icon = ""
        ss = e.get("spriteSheet", "")
        if ss and os.path.exists(os.path.join(APP, ss)):
            icon = f"{key}.png"
            shutil.copy(os.path.join(APP, ss), os.path.join(BOOSTDIR, icon))
            icons += 1
        boosts.append({
            "key": key,
            "name": e["name"],
            "cost": int(e.get("cost", 0)),
            "brainsNeeded": bool(e.get("brainsNeeded", False)),
            "level": max(0, e.get("level", 0)),  # source uses negatives as "always"
            "effect": eff,
            # Insta-Grow is single-use (grows ONE crop per use). To keep the same
            # total value for the same price, a purchase grants 10x the volume:
            # amount 10 -> 1, perPurchase 2 -> 20 (= source amount x perPurchase).
            "amount": 1 if eff == "grow" else e.get("amount", 0),
            "perPurchase": (
                e.get("amount", 1) * e.get("amountGivenPerPurchase", 1)
                if eff == "grow"
                else e.get("amountGivenPerPurchase", 1)
            ),
            "giftZombieKey": (
                "ZombieActorGardenCupidPink"
                if key == "valentine_gift_2012"
                else gift_key(e) if eff == "gift" else ""
            ),
            "usableOnFarm": eff in FARM_USABLE,
            # Insta-Grow is single-use now, so its source "grows 10" copy is wrong.
            "info": (
                "Instantly grows a crop or zombie!"
                if eff == "grow"
                else " ".join(x for x in (e.get("info"), e.get("info2")) if x).strip()
            ),
            "flavorText": e.get("flavorText", ""),
            "icon": icon,
        })

    boosts.sort(key=lambda b: (not b["usableOnFarm"], b["cost"], b["name"]))
    with open(os.path.join(OUT, "boosts.json"), "w", encoding="utf-8") as f:
        json.dump(boosts, f, indent=1)
    usable = sum(1 for b in boosts if b["usableOnFarm"])
    print(f"boosts: wrote {len(boosts)} ({usable} farm-usable) + {icons} icons")
    for b in boosts:
        gk = f" -> {b['giftZombieKey']}" if b["effect"] == "gift" else ""
        print(f"  {b['name']:<22} {b['effect']:<13} {'usable' if b['usableOnFarm'] else 'deferred'}{gk}")


if __name__ == "__main__":
    main()
