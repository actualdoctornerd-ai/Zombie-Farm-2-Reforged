#!/usr/bin/env python3
"""Life Force for every placeable (the Zombie Farm 1 mechanic, restored).

Every row of public/assets/placeables.json gets two fields:

  lifeForce         integer >= 0, what one placed copy adds to the farm's total
  lifeForceSource   how that number was reached (see SOURCES below)

The numbers come from tools/life_force.json: the community-documented ZF1 values
plus the few rules that cover everything nobody wrote down. Edit that file, not the
catalog fields. Resolution order, first match wins:

  documented   a value a ZF1 source reports for this key
  override     a hand-set value with a stated reason
  variant      a recolour (`variantOf`) takes its base item's value
  producing-tree  fruit and olive trees: a fixed, slightly lower figure
  tree         footprint area + treeBonus (documented ZF1 trees sit 2-3 above area)
  footprint    tileW x tileH

Estimated values (footprint, tree, producing tree) count area up to footprintCap (the
largest documented value), then only gently beyond it (overCapStep / overCapMax), so one
8x8 pond cannot outweigh a whole farm. THEN they gain a worth bonus
(rules["worthCurve"]): dearer / later-game items give more, in proportion to their size. Worth is the price in gold, a brain price converted, or for an award-only prize
its authored sell value from src/awardSellValue.ts. Documented values and overrides
never take the bonus, and a recolour inherits its base item's final value.

Run from the repo root:  python zombiefarm/tools/life_force.py
It patches public/assets/placeables.json in place and prints a summary. prep_placeables.py
calls apply() before it writes the catalog, so a full regeneration keeps the fields.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
DATA = os.path.join(HERE, "life_force.json")
CATALOG = os.path.join(PROJ, "public", "assets", "placeables.json")

AWARD_SELL = os.path.join(PROJ, "src", "awardSellValue.ts")

SOURCES = ("documented", "override", "variant", "producing-tree", "tree", "footprint")


def load_rules(path=DATA):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def award_sell_values(path=AWARD_SELL):
    """{key: authored sell gold} read out of src/awardSellValue.ts (the three keyed tables
    plus the flat boss-statue prices), so the curve prices award-only prizes the way the
    shop does. Fails loudly if the file stops parsing, rather than silently pricing 0."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    out = {}
    for name in ("RAID_DROP_SELL", "EPIC_PRIZE_SELL", "QUEST_REWARD_SELL"):
        m = re.search(r"export const %s[^=]*=\s*\{(.*?)\n\};" % name, src, re.S)
        if not m:
            raise SystemExit(f"awardSellValue.ts: table {name} not found")
        for key, value in re.findall(r"^\s*(\w+):\s*([\d_]+),", m.group(1), re.M):
            out[key] = int(value.replace("_", ""))
    m = re.search(r"const STATUE_TILES = \[(.*?)\];", src, re.S)
    stone = re.search(r"\[tile, ([\d_]+)\], \[`\$\{tile\}Golden`, ([\d_]+)\]", src)
    if not m or not stone:
        raise SystemExit("awardSellValue.ts: boss statue prices not found")
    for tile in re.findall(r'"(\w+)"', m.group(1)):
        out[tile] = int(stone.group(1).replace("_", ""))
        out[tile + "Golden"] = int(stone.group(2).replace("_", ""))
    if len(out) < 100:
        raise SystemExit(f"awardSellValue.ts parsed to only {len(out)} prices")
    return out


def worth(row, rules, awards):
    """Purchase-equivalent gold value of a catalog row (see worthCurve in the rules)."""
    curve = rules["worthCurve"]
    cost = row.get("cost") or 0
    if cost > 0:
        return cost * (curve["brainGold"] / curve["sellBack"] if row.get("brainsNeeded") else 1)
    return awards.get(row["key"], 0) / curve["sellBack"]


def worth_bonus(value, base, rules):
    """The Life Force bonus of the highest band `value` reaches (0 below the first): the
    larger of the band's flat amount and its percentage of `base`, so a big item's bonus
    scales with it while a 1x1 still gains a whole point."""
    bonus = 0
    for floor, flat, pct in rules["worthCurve"]["bands"]:
        if value >= floor:
            bonus = max(flat, round(base * pct))
    return bonus


def sized(area, rules):
    """Footprint -> base value: the area up to footprintCap, then +1 per overCapStep tiles
    over it, at most overCapMax extra."""
    cap = rules["footprintCap"]
    if area <= cap:
        return area
    return cap + min(rules["overCapMax"], (area - cap) // rules["overCapStep"])


def resolve(catalog, rules, awards=None):
    """{key: (value, source)} for every row of `catalog`."""
    awards = award_sell_values() if awards is None else awards
    by_key = {c["key"]: c for c in catalog}
    documented = {k: v["value"] for k, v in rules["documented"].items()}
    overrides = {k: v["value"] for k, v in rules["overrides"].items()}
    producing = set(rules["producingTrees"])
    trees = set(rules["trees"])
    out = {}

    def plus_bonus(row, base):
        return base + worth_bonus(worth(row, rules, awards), base, rules)

    def one(key, seen=()):
        if key in out:
            return out[key]
        row = by_key[key]
        if key in documented:
            res = (documented[key], "documented")
        elif key in overrides:
            res = (overrides[key], "override")
        elif row.get("variantOf") and row["variantOf"] in by_key and row["variantOf"] not in seen:
            base_value, _ = one(row["variantOf"], seen + (key,))
            res = (base_value, "variant")
        elif key in producing:
            res = (plus_bonus(row, rules["producingTreeValue"]), "producing-tree")
        elif key in trees:
            res = (plus_bonus(row, sized(row["tileW"] * row["tileH"] + rules["treeBonus"], rules)), "tree")
        else:
            res = (plus_bonus(row, sized(row["tileW"] * row["tileH"], rules)), "footprint")
        out[key] = res
        return res

    for c in catalog:
        one(c["key"])
    return out


def apply(catalog, rules=None):
    """Set lifeForce + lifeForceSource on every row of `catalog` (in place)."""
    rules = rules or load_rules()
    table = resolve(catalog, rules)
    unknown = (set(rules["documented"]) | set(rules["overrides"]) | set(rules["trees"])
               | set(rules["producingTrees"])) - {c["key"] for c in catalog}
    if unknown:
        raise SystemExit(f"life_force.json names keys that are not in the catalog: {sorted(unknown)}")
    for c in catalog:
        c["lifeForce"], c["lifeForceSource"] = table[c["key"]]
    return table


def main():
    with open(CATALOG, encoding="utf-8") as f:
        catalog = json.load(f)
    table = apply(catalog)
    with open(CATALOG, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=1)
    by_source = {}
    for _, (v, s) in table.items():
        by_source.setdefault(s, []).append(v)
    print(f"life force: {len(table)} placeables")
    for s in SOURCES:
        vals = by_source.get(s, [])
        if vals:
            print(f"  {s:15} {len(vals):4}  range {min(vals)}-{max(vals)}")


if __name__ == "__main__":
    main()
