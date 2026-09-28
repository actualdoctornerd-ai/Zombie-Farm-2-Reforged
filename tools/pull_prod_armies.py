#!/usr/bin/env python3
"""Snapshot the parties real accounts actually deployed, bucketed by player level.

Writes ``tmp/prod_armies.json``, the input to the prod difficulty grid
(``src/raid/harness/prodGrid.ts``). Read-only against the production D1.

WHY THIS EXISTS. The difficulty harness composes parties from a sampler, which can only
ever be as right as the sampler's idea of what a player fields. This takes the question
out of our hands: every party here is one an account sent to ``/raid/start``, with its
species, per-unit mutation mask, per-unit veterancy and DEPLOY ORDER intact.

HOW A LEVEL IS RECOVERED. A settled session's ``result_json`` carries ``$.balance.xp`` —
the balance AFTER that fight — so ``levelForXp`` on it gives the exact level the account
held at the time. That turns the whole session table into a longitudinal sample: the
level-10 column draws on everyone who was ever level 10, not just whoever is sitting
there today.

THE ONE LIMITATION. ``roster_json`` stores unit ids, not species, so a party is only
usable if every id still resolves against ``roster_v3`` (alive) or ``fallen_v3`` (dead).
A blind join resolves 27-46% of historical slots — the Zombie Pot consumes both parents,
so most of the evidence has been eaten — and the resolved remainder is biased toward
units that endured. This script therefore keeps only sessions where EVERY id resolves
(``HAVING SUM(zombie_key IS NULL) = 0``), which is a clean sample rather than a partial
one. Restricting to recent fights does not help; the whole beta fits inside 45 days.

Usage:
    python tools/pull_prod_armies.py [--target 60] [--per-account 6]

Requires wrangler to be logged in. ``--env production`` is NOT optional: without it
wrangler resolves the default environment, which only binds the staging database, treats
the name as an id and fails with a misleading authentication error.
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
OUT = ROOT / "tmp" / "prod_armies.json"

# Server mirror of the XP->level curve (server/src/levels.ts XP_THRESHOLDS). Levels 1..45;
# 46-50 are uncommitted in the working tree and production still tops out at 45.
XP_THRESHOLDS = [
    0, 25, 75, 150, 250, 375, 550, 800, 1300, 1800, 2300, 2800, 3300, 3900, 4500,
    5500, 6500, 7500, 8500, 9500, 11500, 13500, 15500, 17500, 20500, 25000, 30000,
    35000, 40000, 46000, 53000, 61000, 69000, 78000, 87000, 97000, 107000, 117000,
    127000, 137000, 151000, 165000, 179000, 193000, 218000,
]

#: The grid's columns. Each holds parties from accounts within +/-2 levels of it, so the
#: windows tile the ladder without overlapping.
COLUMNS = [10, 15, 20, 25, 30, 35, 40, 45]
HALF_WIDTH = 2

#: Sessions considered per column before dedup. The `whole` filter is selective, so this
#: has to be much larger than what survives it.
CANDIDATES = 700

#: Keep a party only if it is at least this share of the BIGGEST party the same account
#: sent in the same column.
#:
#: Players farm easy invasions with a subset — eight zombies at Old McDonnell's when they
#: own twenty. That is a real thing they do, but it is evidence about a farm run, not about
#: their army, and the grid then flies that eight-party against raid 15 tier 10, which they
#: would never do. Using the account's own largest party as the yardstick keeps this from
#: being a strength filter: it drops small parties from strong accounts and keeps complete
#: parties from weak ones. (A genuinely weak level-40 army — fourteen zombies, no healer,
#: no mutations — stays in, because that IS what that player brings.)
#:
#: Measured effect: 2-8% of each column, except level 40 where it is 20%, which is itself
#: the finding — that column was disproportionately partial parties, and it read as a dip
#: in difficulty at 40 against both 35 and 45. Column medians move by under 2% either way.
MIN_PARTY_SHARE = 0.8


def drop_partial_parties(pool: list[dict], min_share: float = MIN_PARTY_SHARE) -> list[dict]:
    """Remove parties materially smaller than the same account's own largest. See above."""
    biggest: dict[str, int] = collections.defaultdict(int)
    for army in pool:
        biggest[army["acct"]] = max(biggest[army["acct"]], len(army["units"]))
    return [a for a in pool if len(a["units"]) >= min_share * biggest[a["acct"]]]


def xp_window(level: int) -> tuple[int, int]:
    """[lo, hi) in XP for a column centred on `level`, +/-HALF_WIDTH levels."""
    lo_i = max(0, level - 1 - HALF_WIDTH)
    hi_i = level + HALF_WIDTH
    lo = XP_THRESHOLDS[lo_i]
    hi = XP_THRESHOLDS[hi_i] if hi_i < len(XP_THRESHOLDS) else 10**9
    return lo, hi


ANSI = re.compile(r"\x1b?\[[0-9;]*m")


def d1(sql: str, attempts: int = 3) -> list[dict]:
    """One read-only query against the production D1, as rows.

    The statement is COLLAPSED TO ONE LINE first. `npx` needs `shell=True` on Windows,
    and the shell mangles a multi-line argument into `incomplete input: SQLITE_ERROR`.
    `--file` is not an alternative: it answers with an execution summary (rows read,
    database size) instead of the rows themselves.

    wrangler prefixes `--json` output with an ANSI-coloured config warning whose escape
    codes contain a `[`, so "slice from the first bracket" finds the banner rather than
    the payload — strip the escapes first. Transient 7500/7403s from the API are common
    enough on a query this size to be worth a retry rather than a failed run.
    """
    one_line = " ".join(sql.split())
    cmd = [
        "npx", "wrangler", "d1", "execute", "zombiefarm",
        "--env", "production", "--remote", "--json", "--command", one_line,
    ]
    last = ""
    for _ in range(attempts):
        proc = subprocess.run(cmd, cwd=SERVER, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", shell=True)
        text = ANSI.sub("", proc.stdout or "")
        start = text.find("[")
        if start >= 0:
            try:
                payload = json.loads(text[start:])
                if isinstance(payload, list) and payload and "results" in payload[0]:
                    return payload[0]["results"]
            except json.JSONDecodeError:
                pass
        last = (text or proc.stderr or "")[-400:]
    raise SystemExit(f"query failed after {attempts} attempts:\n{last}")


def whole_lineups_sql(lo: int, hi: int) -> str:
    """Every slot of every session in the window whose ids ALL resolve.

    `json_each(roster_json)` gives `key` = the deploy slot and `value` = the unit id, so
    the party comes back in formation order. A unit is looked up in the live roster first
    and the graveyard second — the same unit can never be in both.
    """
    return f"""
WITH sess AS (
  SELECT s.id, s.account_id, s.roster_json
  FROM raid_sessions_v3 s
  WHERE s.finished_at IS NOT NULL AND s.result_json IS NOT NULL
    AND json_extract(s.result_json,'$.balance.xp') >= {lo}
    AND json_extract(s.result_json,'$.balance.xp') <  {hi}
), ex AS (
  SELECT sess.id, sess.account_id, j.key AS slot, j.value AS uid
  FROM sess, json_each(sess.roster_json) j
), res AS (
  SELECT ex.id, ex.account_id, ex.slot,
         COALESCE(r.zombie_key, f.zombie_key) AS k,
         COALESCE(r.mutation,   f.mutation)   AS m,
         COALESCE(r.invasions,  f.invasions)  AS inv
  FROM ex
  LEFT JOIN roster_v3 r ON r.account_id = ex.account_id AND r.unit_id = ex.uid
  LEFT JOIN fallen_v3 f ON f.account_id = ex.account_id AND f.unit_id = ex.uid
), whole AS (
  SELECT id FROM res GROUP BY id
  HAVING SUM(CASE WHEN k IS NULL THEN 1 ELSE 0 END) = 0 AND COUNT(*) >= 6
  LIMIT {CANDIDATES}
)
SELECT res.* FROM res JOIN whole ON whole.id = res.id ORDER BY res.id, res.slot
""".strip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", type=int, default=60, help="parties kept per column")
    ap.add_argument("--per-account", type=int, default=6,
                    help="cap on one account's share of a column, so no single player owns it")
    ap.add_argument("--min-party-share", type=float, default=MIN_PARTY_SHARE,
                    help="drop a party smaller than this share of its own account's largest "
                         "(subset farm runs are not the army that account fields)")
    args = ap.parse_args()

    catalog = {z["key"] for z in json.loads(
        (ROOT / "public/assets/zombies.json").read_text(encoding="utf-8"))}

    pools: dict[str, list[dict]] = {}
    for level in COLUMNS:
        lo, hi = xp_window(level)
        rows = d1(whole_lineups_sql(lo, hi))

        by_session: dict[str, list[dict]] = collections.defaultdict(list)
        account: dict[str, str] = {}
        for r in rows:
            by_session[r["id"]].append(r)
            account[r["id"]] = r["account_id"]

        kept: list[dict] = []
        per_account: collections.Counter[str] = collections.Counter()
        seen_parties: set[str] = set()
        for sid, slots in by_session.items():
            acct = account[sid]
            if per_account[acct] >= args.per_account:
                continue
            slots.sort(key=lambda r: r["slot"])
            # A species retired from the catalog would build a unit the sim cannot fly.
            if any(r["k"] not in catalog for r in slots):
                continue
            # Veterancy caps at Master (5 survived invasions), so a unit with 900 of them
            # is the same unit as one with 5 — clamp here so the dedup can see that.
            units = [[r["k"], r["m"], min(5, r["inv"])] for r in slots]
            signature = json.dumps(units)
            if signature in seen_parties:
                continue  # the same party re-sent on a later fight is not a second sample
            seen_parties.add(signature)
            per_account[acct] += 1
            kept.append({"id": sid[:8], "acct": acct[:8], "units": units})

        kept = kept[: args.target]
        # Applied AFTER the target cut so the yardstick is the pool as sampled, not as
        # queried — otherwise a big party that did not make the cut would still be the
        # thing its account's smaller parties are judged against.
        before = len(kept)
        kept = drop_partial_parties(kept, args.min_party_share)
        pools[str(level)] = kept
        sizes = sorted(len(a["units"]) for a in kept) or [0]
        print(f"L{level}: {len(kept)} parties from {len({a['acct'] for a in kept})} accounts, "
              f"sizes {sizes[0]}-{sizes[-1]} median {sizes[len(sizes) // 2]}"
              f"  (dropped {before - len(kept)} partial)", flush=True)

    thin = [lv for lv, pool in pools.items() if len(pool) < args.target // 2]
    if thin:
        print(f"WARNING: thin columns {', '.join(thin)} — cells there carry fewer flights",
              file=sys.stderr)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(pools, separators=(",", ":")), encoding="utf-8")
    total = sum(len(p) for p in pools.values())
    print(f"wrote {OUT.relative_to(ROOT)} — {total} parties across {len(pools)} columns")


if __name__ == "__main__":
    main()
