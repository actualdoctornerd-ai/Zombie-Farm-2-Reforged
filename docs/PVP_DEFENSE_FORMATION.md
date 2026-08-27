# PvP Defense Formation — Half A spec

**Status: BUILT (Half A), LIVE ON STAGING.** Shipped as one of TWO defense modes —
`PVP_DEFENSE_MODE` picks which one a Worker fields, and exactly one is reachable in
game at a time (`"formation"` on staging and in dev, `"classic"` in production).
Measured after the build: break-even moved from **1.24x to 1.05x**, inside the target
band below, with no four-minute timeouts. The section headings below describe what was
built; deviations are called out inline.

**Original status when written: SPEC, NOT BUILT.** This describes the defense rework for friend invasions
(`docs/FRIEND_INVASIONS.md`), split into two halves. **Half A — roles, standing
positions and deployment — is specified here.** Half B (the brute on the perch, the
thrown-and-returning mini, descend-on-tank-death) is deliberately out of scope; it is
sketched at the end so Half A does not paint it into a corner.

## Why

Measured on the shipped build (all-fighter rosters, level 30, no ability taps, each
duel played twice with the roles swapped):

| Matchup, identical rosters | Result |
|---|---|
| 8 attack v 6 defense (shipped) | attacker wins **both** directions, 4 of 8 survive |
| break-even | defense needs **+10% stats (1.34x strength)** just to hold |

Three causes, all of which Half A addresses:

1. **The defense can never field more than three zombies.**
   `PVP_WAVE_CADENCE.maxActive = 3` caps *concurrent* defenders no matter how many are
   in the roster; death only ever *replaces*. The attacker has no such ceiling — they
   arrive one at a time (`CHARGE_MS` 3600 plus the walk, ~4.5 s each) but **accumulate**.
   That is why the attacker's edge grows with army size: at 6v6 the defense wins, at
   10v10 it loses.
2. **A defending healer heals nothing.** `toEnemyCopy` sets `abilities: []`, and heal and
   resurrect are ability-driven. Worse, `stepHealing` and `stepResurrect` iterate
   `this.players` only — so restoring the array alone would still do nothing. Measured:
   swapping a fighter for a healer gains the *attacker* 3 survivors, and costs the
   *defender* the fight 7 s faster.
3. **The defense has no shape.** It is a raid wave walking out of a doorway. Invading a
   friend's farm should not look like raiding stage 4.

## The roles

One zombie per class — six **jobs**, exactly today's `PVP_DEFENSE_CAP`. The defender
picks *which* of their zombies fills each job; the jobs themselves are fixed.

**Class → job is a bijection** (owner's ruling, 2026-08-25). Normal and Girl are two
jobs even though they do identical work: same station, same reinforcement beat, one
shared drip counter. They were briefly one shared **Line** job with two holders, and
that one-to-many gap generated a bug rather than saving a word — anything enforcing
"one of each" that keyed off the job merged the two line classes into a single slot and
left the sixth permanently unfillable: a full defense read 5/6. With a job per class the
job list, the class list and the cap are the same six things, so `roleForGroup` is the
only key anything needs. Code that means "does the line's work" asks `isLineRole`, never
`=== "line"`.

| Job | Class | Half A behaviour |
|---|---|---|
| **Tank** | Headless | Walks out at t=0 and holds the front. The contact point for the whole fight. |
| **Support** | Garden | Already standing at the back when the fight opens. Heals (see "Abilities on defense"). |
| **Brute** | Large | Stands mid-depth behind the tank. Half B lifts it onto the perch. |
| **Mini** | Small | Deploys beside the Brute. Half B makes it the thrown projectile. |
| **Line** | Regular | Reinforces on a timer. |
| **Girl** | Girl | Reinforces on a timer — same station, same beat, its own job. |

Front-to-back RANK is not the job list: Normal and Girl share a rank and settle between
themselves on unit id, exactly as they did when they shared a job. Giving Girl its own
rank would fix which of the two lands on the 5 s beat and which on the 10 s, and that is
transcript-visible — a ruleset change, which this deliberately is not.

Why the Headless tank is what makes the pile-up fair: it has the game's **lowest dex, a
flat 1.0** (every other class runs 1.3–4.0) on its **highest con**. At tier 4 that is
roughly 50 dps behind 2,700 HP — about a third of Regular/Girl/Small output for nearly
double the staying power. A standing defense led by a Headless is a wall that barely
bites, so the attacker's one-every-4.5-seconds trickle has time to build up behind its
first arrival instead of being fed in and killed piecemeal. **This is load-bearing**:
put a Large in front instead and the same formation becomes a meat grinder.

## Positions

Sim coordinates (`FIELD_W` 1000, `FIELD_H` 560, `CENTER_Y` 280). Existing landmarks:

```
220        250              448            848      940        1000
CHARGE_X   GARDEN_STATION   SUMMON_SPAWN   BOSS_    ENEMY_     right
(attacker  (attacker's      (mid-lane)     STRUCT_X HOLD_X     edge
 staging)   healer)                        (perch)  (doorway)

                                    attacker line ~880 (ENEMY_HOLD_X - ENGAGE)
```

The defense currently has **no depth**: everyone holds at the doorway (940) with 60 px of
stage behind them. Pulling the tank forward is what creates room for a formation, so "a
bit in front of the barn" is structural, not decorative.

| Station | x | Notes |
|---|---|---|
| `DEF_TANK_X` | **820** | ~1 sprite in front of the barn face. Attackers close to ~760. |
| `DEF_LINE_X` | **890** | Brute, Mini, and the Regular/Girl reinforcements — behind the tank, in front of the doorway. |
| `DEF_SUPPORT_X` | **950** | Healer, in the doorway: deepest, out of the combat band. |

Several bodies at one station keep the existing y-fan (`SRC_SLOT_Y_STEP`, `ROW_SPREAD`)
so they do not draw on top of each other.

**Reachability rule (required, not optional).** A healer at 950 sits beyond the
attacker's reach. If it is ever the **last defender alive it drops its station** and
walks up to the ordinary doorway — where every raid's enemies are fought, so it is
reachable by definition — and the fight can end. (Built that way rather than moving it
to `DEF_LINE_X`: it needs no new constant and no coupling from the sim back to the PvP
rules module.) Without this, every won-on-points defense becomes a four-minute
stare-down — the same stalemate the Garden zombie already causes today. The owner has
ruled that a timeout is a defense win; that ruling stands, but it should be rare.

## Deployment schedule

| When | Who |
|---|---|
| t = 0 | Support standing at `DEF_SUPPORT_X`; Tank begins walking to `DEF_TANK_X`; Brute + Mini take `DEF_LINE_X` |
| t = 5 s | Regular joins `DEF_LINE_X` |
| t = 10 s | Girl joins `DEF_LINE_X` |

**One zombie per class, and the picker says so.** A defense line-up may hold at most one
zombie of each group, because the formation fills one job per group — a second Regular has
no job to stand in and `selectFormationDefense` would drop it at snapshot time. The editor
labels every card with the job it would fill, dims one whose job is already held (clicking
it SWAPS rather than failing), and counts "n / 6 jobs filled" naming the empty ones.
`setDefensePvp` refuses a duplicate with `duplicate_class` — per CLASS, which is now
literally the same rule the picker counts, so a full six-class line-up is accepted on both
sides and the rule cannot be worked around by a hand-built request.

Measured consequence, recorded because it is sharp: defensibility tracks farm DIVERSITY,
not farm size. Identical farms on both sides, all Tier 3 — 8 Regulars field 1 defender and
break even at 2.77x; 6 classes field 6 and break even at 0.92x (defense slightly favoured,
which is the goal). A single-class farm is close to indefensible, by design.

`PVP_DEFENSE_DRIP_MS = 5_000` is the primary balance dial — it is what lets an attacker
who clears fast get ahead, and what punishes one who does not. Measured across 13 defense
and 6 attacker compositions it is also the strongest dial available, and the only one that
moves the tanky-attacker case: armies that out-LAST a defense rather than out-damage it
ignore throw damage but not extra bodies. It was 15 s, at which the second reinforcement
arrived at 30 s into a ~33 s fight and barely participated. See "Balance target".

The defenders **stand**. They do not march at the attacker. Contact happens because the
attacker walks into the tank, which is what stops a fully-deployed defense from simply
mobbing the first zombie to arrive.

## Abilities on defense

Today: `abilities: []` for every defender. Change to a **passive allowlist**:

- **Restored**: `heal`, `healAOE`. These run themselves — nobody needs to tap them, so
  "nobody is home to tap them" was never a reason to strip them. **`ressurect` was NOT
  restored** (a deviation from this spec, taken during the build): reviving reads the
  player-side corpse backlog, so a defending Garden needs a backlog of its own, and that
  interacts with the win condition. Left whole for later rather than done by halves.
- **Still stripped**: `bash`, `bashV2`, `explode`, `explodeV2`, `attachMini`. Those are
  taps. A defender cannot tap, and a *scripted* Mini Buddy is Half B.
- **Unchanged**: Protect's damage reduction and the full-team auras already ride
  pre-baked stats and `damageReduction`, and keep working exactly as they do now.

**The real work here is not the allowlist.** `stepHealing` and `stepResurrect` walk
`this.players`, so they need a defender-side pass (or to be generalised over a team).
Either way, keep the behaviour identical to the player-side one — heal cadence,
50%-of-power amount, the corpse backlog for resurrect — so there is one rule rather than
two that drift apart.

## Config shape

The pinned config stays the single source of truth, so both simulations agree by
construction. Add **optional** fields to the materialised defender `CombatUnit`s:

```ts
role?: "tank" | "support" | "brute" | "mini" | "line";
stationX?: number;   // authored hold position
stationY?: number;
deployAtMs?: number; // 0 = on the field when the fight opens
```

Absent fields mean today's behaviour, so **every raid stays byte-identical** and only PvP
changes. `buildDefenseSnapshot` authors these server-side; the client adopts them
wholesale, as it already does for everything else.

## Loadout storage

`pvp_defense_v3.loadout_json` moves from an ordered list to a role map:

```json
{ "roles": { "tank": "u123", "support": "u456", "brute": "u789" } }
```

Migration is cheap (the column is already JSON): read an existing ordered array, assign
each unit to its own class's role, first one wins, drop the rest. No SQL migration is
needed — only the parse path.

**Missing roles are legal and expected.** A level-7 farm may own no Garden and no Large;
that role simply stands empty and the defense is weaker for it. This doubles as a
progression goal ("get a Headless to hold your line"). An entirely empty loadout keeps
today's fallback (auto-pick over the deployed roster); an empty farm keeps `no_defense`.

## Tier scoring

Composition becomes fixed at six, so the `sqrt(count x base)` size factor is nearly
constant for defenses and stops doing useful work there (it still matters on the attack
side, which is always a free 8).

**DECIDED: `unitTierPoints` credits support — a healer is worth what a fighter is worth.**
Left alone, a healer scores near zero on hp x dps while making the fight materially
harder, which is the mismatch that made healers read as dead weight on the scout screen.

The modelling choice inside that decision matters, because the obvious implementation
under-delivers. Crediting a healer with its OWN throughput (`heal per second = power x
HEAL_POWER_MULT x 1000 / cooldownMs`, which lands at about half its attack dps) leaves it
at ~1.5x its solo score — and the Garden class carries the smallest stats in the game
(str and con both 1–5.5 across the normal tiers), so 1.5x of very little is still very
little. A healer is valuable because it multiplies the whole line's staying power, not
because of what it does alone.

So credit it at the GROUP level: healing throughput becomes effective HP for the team,

    groupTierPoints = SUM(fighters' hp x dps) x (1 + healPerSec x fightSecs / teamHp)

with `fightSecs` a fixed nominal fight length rather than anything measured, so the score
stays a pure function of the roster. Tune the constant so a six-role defense with a
healer scores about what six fighters would; that is the whole point of the decision.

## Ruleset and replays

Transcript-changing for PvP, so `RAID_RULESET_VERSION` bumps with a changelog entry in
`src/raid/replay.ts`. Two already-understood costs:

- A PvP fight in flight at deploy settles as `stale_ruleset` and pays nothing.
- **Stored replays recorded under the old version stop being watchable** (`/replay`
  already refuses a stale recording). The 10-per-role window means this washes out within
  a few fights.

Raid transcripts must NOT change — that is what the optional-field gating buys, and it is
worth a test that says so.

## Balance target and what to measure

Target: **the mirror should be close to a coin flip.** Today a defense needs 1.34x to
hold; aim for break-even in the **1.0–1.1x** band, with the defense winning a true mirror
slightly more often than not (defending is passive, so the tie should favour the player
who is not there).

Re-run the harness behind the numbers at the top of this document — the roles-and-stations
version of it — and record:

1. Mirror duel, both directions, with all six roles filled.
2. Break-even multiplier at shipped sizes.
3. The same with roles missing (2, 4, 6 filled) — the degradation curve.
4. Time to resolution: the four-minute cap should be rare, not routine.

## Test plan

- **Determinism**: same pinned config plus transcript gives an identical outcome (the
  existing PvP determinism test, extended to the new fields).
- **Stations and schedule**: each role holds its authored x; Regular and Girl arrive at
  15 s and 30 s; the tank is the front-most defender for the whole fight.
- **The healer heals**: defender HP recovers mid-fight — the assertion that would have
  caught today's silent no-op.
- **Reachability**: a lone surviving healer advances, and the fight ends inside the cap.
- **Degradation**: missing roles field a smaller defense without error; an empty loadout
  falls back to auto-pick; an empty farm still answers `no_defense`.
- **Raids unchanged**: the existing raid suites pass untouched, proving the gating.
- **Balance pin**: break-even multiplier inside the target band, so a later change that
  quietly hands the fight to one side fails a test rather than a playtest.

## Explicitly NOT in Half A

Held back so Half A can ship and be measured on its own: the perch position for the Brute
(`BOSS_STRUCT_X` 848 / `BOSS_STRUCT_Y` -150), the thrown mini that strikes, returns and
reloads (a genuinely new projectile mechanic — the alien spawn-on-landing is *not* the
precedent), the descend-when-the-tank-dies trigger, and the scripted Mini Buddy mount on
descent. Half A leaves the Brute and Mini as ordinary line fighters at `DEF_LINE_X`,
which is the fallback the design already calls for when Mini Buddy is not unlocked.

**DECIDED: there are no defense upgrades at all.** Not slot-count, not behaviour. A
defense is worth exactly what the six zombies standing in it are worth, and the only way
to field a better one is to own better zombies. This retires the planned
`PVP_DEFENSE_CAP_MAX` = 10 path outright (delete the constant with this work), and it
keeps the scout screen honest: the tier a friend shows is their roster, with no invisible
purchased modifiers behind it.
