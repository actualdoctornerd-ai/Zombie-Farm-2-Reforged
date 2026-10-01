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

Estimated values (everything except documented/override) are capped at footprintCap,
the largest documented value, so one 8x8 pond cannot outweigh a whole farm.

Run from the repo root:  python zombiefarm/tools/life_force.py
It patches public/assets/placeables.json in place and prints a summary. prep_placeables.py
calls apply() before it writes the catalog, so a full regeneration keeps the fields.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
DATA = os.path.join(HERE, "life_force.json")
CATALOG = os.path.join(PROJ, "public", "assets", "placeables.json")

SOURCES = ("documented", "override", "variant", "producing-tree", "tree", "footprint")


def load_rules(path=DATA):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def resolve(catalog, rules):
    """{key: (value, source)} for every row of `catalog`."""
    by_key = {c["key"]: c for c in catalog}
    documented = {k: v["value"] for k, v in rules["documented"].items()}
    overrides = {k: v["value"] for k, v in rules["overrides"].items()}
    producing = set(rules["producingTrees"])
    trees = set(rules["trees"])
    cap = rules["footprintCap"]
    out = {}

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
            res = (rules["producingTreeValue"], "producing-tree")
        elif key in trees:
            res = (min(cap, row["tileW"] * row["tileH"] + rules["treeBonus"]), "tree")
        else:
            res = (min(cap, row["tileW"] * row["tileH"]), "footprint")
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
