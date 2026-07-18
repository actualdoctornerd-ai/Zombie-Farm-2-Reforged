# Combat stat pipeline — GROUND TRUTH (disassembled)

Recovered 2026-07-09 from the shipped ARMv7 (Thumb) Mach-O
`app-internals/executable/ZF2R` with `tools/re/objc_disasm.py`, the same method that
produced `zombie-pot-ground-truth`. This is REAL ground truth (compiled code), not a plist.
It answers the highest-value open question: **how `str`/`dex`/`con` become HP, damage,
attack speed, and how a hit resolves** — the numbers the reimplementation currently invents.

## Combat resolution — stat→fight-data + per-swing damage (added 2026-07)

`getBaseStats` (str/dex/con from UnitStats) feeds `modifyStats:` (mutations/rank/abilities/
farmerHeads/**levelScale**), and the result is converted into the `ActorFightData` combat values
by **`initFightDataAfterLoad`** — recovered for BOTH sides:

| Fight-data value | Formula | Zombie | Enemy (StageActor) |
|---|---|---|---|
| `power` | `str × 10` | ×10 | ×10 (same) |
| `hitPointsTotal` | `con × 100` | ×100 | ×100 (same) |
| `attackSpeed` (interval, sec) | `C / dex` | **C = 2.0** | **C = 1.0** |

**Asymmetry (real):** enemies use `1.0/dex`, zombies `2.0/dex`, so an enemy attacks **twice as
often** as a zombie at equal dex. Then `calculateFinal{Power,HitPointsTotal,AttackSpeed,
DamageReduction}` (already documented above) apply the passive/temporary modifier channels.

**Per-swing damage — `-[Actor damageIn:]` (0x370d9), main melee branch — DETERMINISTIC:**
```
damage = finalPower × attack.damageMultiplier × lineupBand        # see lineupBand below
target: hitPoints -= max(0, damage − armor) × (1 − finalDamageReduction)   # Actor damage:
```
- `attack.damageMultiplier` is the current attack variation's value (ZombieBite = 1); the attack
  is chosen per swing by the `frequency`-weighted roll. **Default is 1.0 when the key is absent**
  — CONFIRMED at 0x37162: `vmov.f32 d8,#1.0 ; cbz r0,skip` keeps 1.0 when `objectForKey:` is nil.
  So the many enemy attacks with NO `damageMultiplier` (CrazedWorkerAttack, FarmhandPoke,
  NinjaStab, PirateBossSlash, BroBotAttack, …) deal `finalPower × 1 × band`.
- **The "K" scalar is NOT a fixed 0.7 — it is a PLAYER-ZOMBIE LINEUP-DEPTH FALLOFF** (fully pinned
  2026-07-17, 0x372bc–0x37348). `damage = mult × finalPower` is then multiplied by a band chosen
  from the zombie's index in `[fightMan zombies]`:

  | `index / 5` (integer) | lineup positions | band |
  |---|---|---|
  | 0 | 0–4 (front) | **1.0** (penalty block skipped entirely) |
  | 1 | 5–9 | **0.85** (f64 @0x376b8) |
  | 2 | 10–14 | **0.7** (f64 @0x376a8) |
  | ≥3 | 15+ (rear) | **0.55** (f64 @0x376b0) |

  Gated by three tests, ALL must pass for the penalty to apply (else band = 1.0):
  1. `[self isKindOfClass: <player-zombie class from fightMan>]` — enemies (`*StageActor*`, a
     separate array, never in `fightMan.zombies`) FAIL this → **enemies always deal full ×1.0,
     never depth-penalized.** The falloff is a player-army mechanic only.
  2. `self.state != 0x20 (32)` and `!= 0x1f (31)` — two states bypass the penalty (likely the
     special-attack / activated-ability states, e.g. Bash/Explode ignore depth). Not pinned to a
     named enum, but the numeric gate is exact.
  3. `(index / 5) != 0` — the front band of 5 is full damage (the `beq` at 0x37326 skips the block).
  The `index/5` is the classic `umull #0xcccccccd ; lsr #2` divide-by-5. `index` = `[[fightMan
  zombies] indexOfObject: self]` (the zombie's slot in the released/formation order).
- **Net effect:** only your front ~5 zombies hit at full strength; a deep bench does progressively
  less (0.85 → 0.7 → 0.55). This is the damage-side twin of the "front rows fight" formation cap.
- The only `arc4random` in `damageIn:` drives **knockback force**, NOT damage — damage is
  deterministic given the chosen attack and the attacker's lineup position.
- Other branches (wall / special-attack, with `÷10` and `−20` terms) are separate and not fully
  transcribed.

**✓ Reimpl status (2026-07-17, "Faithful combat + stats"):** the melee model is now faithful.
`combatStats.ts deriveHitDamage` returns `finalPower × mult` with **no `K`**; player zombies apply
the recovered **1.0/0.85/0.7/0.55 lineup-depth band** (`lineupDamageBand`, used in
`CombatEngine.hitDamage` + `BattleSim`) and enemies always hit at **band ×1.0**. The old
`ENEMY_DAMAGE_MULT=2` per-hit enemy inflation is **gone**, and the anti-one-shot 1-HP floor is now
implemented (`BattleSim.ONE_SHOT_FLOOR`). The **only** remaining deliberate knob is
`ENEMY_ATTACK_PACE=2` in `balance.ts`: the disassembled enemy clock is `1/dex`, but because the sim
doesn't model attack-animation time, enemy cadence is kept at `2/dex` to match reference footage
(a Pirate brute at dex 0.5 hitting ~every 4 s). Per-hit enemy damage is faithful (×1.0); only the
tempo is fudged.

**Still NOT recovered (the large stateful sim — decompiler territory):** the battle loop itself —
target selection, melee-range/lineup/priority, attack scheduling/timing, boss-action scheduling,
hazards, and the focus/distraction interaction. Hand-tracing these yields only approximate
behavior; matching real raid *outcomes* needs the sim reversed (Ghidra), not this method.

**Reimpl status:** the faithful INPUTS are now wired into `CombatEngine` via
`combatStats.ts` (`deriveMaxHp` = con×100, `deriveAttackIntervalMs` = 2000/dex zombie ÷
1000/dex enemy, `deriveHitDamage` = finalPower(str×10) × mult, then the player lineup-depth band
(1.0/0.85/0.7/0.55) at hit time, enemies at band 1.0). Regression-tested.

**Engagement model (fixed):** `resolveRaid` now brings enemies out **one at a time** (matching
the live scene) — only the front enemy attacks and is targeted; the player's whole army
focus-fires it, next enemy steps up when it dies. This was necessary: with the faithful inputs,
the old "whole wave attacks at once" loop let the enemy tempo (2× attack rate) dog-pile the lead
zombie and produced blowout losses even in even-stat fights (5v5 → 0/5 survive). One-at-a-time
makes army SIZE matter (concentration) — a 5v5 even fight flips to a win (3/5 survive), while
numbers disadvantages and individually-stronger enemies still lose.

The live scene (`BattleSim.ts`) already did this — `MAX_ACTIVE_ENEMIES = 1`, "enemies fight one at
a time," with a 450 ms emerge gap, PLUS a player-side charge queue (one zombie enters at a time,
`CHARGE_MS = 3600`) and a front-formation cap (`MAX_ROWS = 4` fight at once). The instant resolver
was the one out of sync (all-at-once), so it was fixed to bring enemies out one at a time too.

**Autoresolve removed (2026-07):** the game now ALWAYS plays raids in the live scene — the "Quick
Resolve" button, the Start-button instant fallback, and the `onStartRaid` hook are gone.
`RaidManager.start()` / `resolveRaid` remain only for the `ZF.runRaid` dev hook + headless tests,
so the earlier "quick-resolve is more player-favorable" divergence no longer affects gameplay.

**BattleSim damage corrected:** the live sim reused the OLD melee model (`str × mult`) while its
HP came from the CombatUnit (`con × 100`) — an HP-inflated, ~10× too-slow fight. It was first moved
to `deriveHitDamage(str×10, mult) × 0.7` (matching `resolveRaid`); the flat `× 0.7` was then
replaced by the faithful lineup-depth band (players 1.0/0.85/0.7/0.55, enemies ×1.0). Boss throw / special /
hazard chip damage (heuristic, no source value) was scaled ×7 to stay proportional to the
corrected melee/HP scale (`PROJ_DMG_SCALE`/`SPECIAL_DMG_SCALE` 0.25→1.75, `HAZARD_DAMAGE` 4→28).
Verified headlessly: a 5v5 even fight resolves in ~38 s (player wins 4/5) instead of stalling.

The sim LOOP is otherwise still an approximation (attack scheduling, positioning, hazards). The
INPUTS rebalance raids (HP ×10, damage ×7, enemies 2× faster) — expect difficulty tuning next.

## Where each value comes from

- **Base `str`/`dex`/`con`** are plist data. `-[ZombieActor getBaseStats]` (imp 0x4c41c) does
  nothing but look the unit up: `ActorManager.unitStats` → `objectForKey:NSStringFromClass(self)`
  → `initWithDictionary:`. So `UnitStats.json` **is** the base-stat ground truth; do not
  disassemble for those.
- **`ActorFightData`** (imp block 0x209439+) is the per-combatant stat bag. It stores the
  raw stats (`power`, `attackSpeed`, `hitPointsTotal`) plus separate `passive*` and
  `temporary*` modifier channels and the memoized `final*` results.
- The **modify chain** `-[ZombieActor modifyStats:]` (0x4c62d) applies, in order:
  `modifyStatWithLevelScale:` → `modifyStatWithFarmerHeads:` → `modifyStatWithAbilities:` →
  `modifyStatWithRank:` → `modifyStatWithMutations:`. Each takes a stat value + a type tag.

## The four final-stat formulas (`-[Actor calculateFinal*]`)

All four combine a `passive*` channel (gear/monolith/ability buffs) and a `temporary*`
channel (in-battle effects) onto the base stat. `f32` throughout.

**Power** (0x3e708): `finalPower = power × max(0, 1 + passivePowerChange + temporaryPowerChange)`
— the `(1+…)` multiplier is floored at 0 (a combined −1.0 or worse zeroes damage output).

**Attack speed** (0x3e790): `finalAttackSpeed = attackSpeed × (1 − change)` where
`change = clampLow(min(passiveAttackSpeedChange, 0.5) + temporaryAttackSpeedChange, −0.5)`.
`attackSpeed` here is the **attack interval** (seconds between swings): a positive change
shortens it (faster). Passive contribution is capped at +0.5; the combined change is floored
at −0.5, so the interval multiplier stays ≤ 1.5.

**Damage reduction** (0x3e82c):
`finalDamageReduction = clamp(passiveDamageReduction, −0.5, +0.5) + temporaryDamageReduction`.
Passive DR alone is capped to ±50%; temporary DR stacks on top uncapped.

**Hit points** (0x3e8b0): `finalHitPointsTotal = max(1, hitPointsTotal × (1 + hitPointsTotalChange))`.

## Hit resolution (`-[Actor damage:]`, 0x3a064)

The large method is mostly state (blink/death/effects — a big stateful function; don't over-
trace it), but the arithmetic core is clean:

```
raw       = max(0, incomingDamage − armor)      # flat armor subtracts first, floored at 0
applied   = raw × (1 − finalDamageReduction)    # then the % reduction
hitPoints = hitPoints − applied                 # setHitPoints:
```

**Anti-one-shot safeguard (INFERRED — verify in play).** Before the normal path, for a
`ZombieActor` *not* carrying state bit `0x10`, the code computes
`(hitPoints − incomingDamage) / finalHitPointsTotal` and, if that ratio `< 0.1`
(literal `0x3dcccccd`), snaps HP to exactly `1.0` and returns instead of applying the hit.
Reads as "a single blow can't drop a player zombie below 10% / can't outright kill it in one
hit"; the `0x10` bit almost certainly gates when a killing blow is finally allowed. The branch
structure is decoded but the flag's exact meaning is inferred — travel with that uncertainty.

## Scaling formulas (the invented numbers)

**Veterancy / rank** — `-[ZombieActor modifyStatWithRank:ofType:]` (0x4bbe8):
```
stat = stat × (1 + 0.05 × getRank)     # coeff literal 0x4bc24 = 0.05
```
Each survived invasion (`getRank`) adds a flat **+5%** to the stat. Linear, no cap seen.

**Level scaling** — `-[ZombieActor modifyStatWithLevelScale:ofType:]` (0x4c031) — **FULLY
DECODED**:
```
t      = clamp((playerLevel − 8) / 17, 0, 1)     # 0 at level ≤8, 1 at level ≥25
scaled = endpoint + t × (baseStat − endpoint)    # = lerp(endpoint, baseStat, t)
```
So a zombie sits at a per-group **floor** below level 8 and reaches its full listed stat at
level 25. `endpoint` is picked by a chain of `isKindOfClass:` tests on the zombie's group class.
Only **str, con, dex** are scaled — the `ofType` argument is decoded (via `modifyStats:`' `tbb`
jump table) as **1=str, 2=con, 3=dex, 4=focus**, and the method returns focus (type 4) unchanged.

Endpoint table (the level-≤8 floor for each group × stat), transcribed verbatim:

| Group (ZombieActor* class) | str | con | dex |
|---|---|---|---|
| Large | 8.5 | 6.5 | 1.3 |
| Regular | 5.0 | 5.0 | 2.0 |
| Garden | 2.5 | 2.5 | 2.0 |
| Girl (reimpl "Female") | 3.4 | 3.5 | 3.5 |
| Headless | 3.0 | 11.0 | 1.0 |
| Small | 3.125 | 2.75 | 4.0 |
| (isKindOfClass fall-through) | 5.0 | 5.0 | 2.0 |

**Mapping proof (not inferred):** the `dex` floors above equal the base dex of each group in
`zombies.json` (Large 1.3, Headless 1.0, Regular 2.0, Garden 2.0) — those groups therefore have
flat dex, which only holds if the (type→stat) mapping AND the lerp direction (endpoint=low-level,
base=high-level) are both correct. The gate `[self ivar_0x18c] == 5` (a combat/fight state) means
this applies in the invasion combat context, matching where the reimpl now uses it.

## What this replaces in the reimplementation

- `ActorFightData`-equivalent final-stat math: use the four formulas above verbatim (floors/caps
  matter — DR ±0.5, attack-speed change [−0.5, +0.5-passive], power ×max(0,1+Δ), HP ×(1+Δ) min 1).
- Damage: flat `armor` subtract → then `×(1−DR)` → subtract from HP. Not the reimpl's ad-hoc math.
- Veterancy: exactly **+5%/rank**, not an eyeballed curve.
- Level scaling: `lerp(endpoint[group][stat], baseStat, clamp((level−8)/17,0,1))` for str/con/dex
  (not focus), using the endpoint table above — a level-driven ramp the reimpl previously lacked.

Disasm was run ad hoc; re-derive from the binary with
`python objc_disasm.py --func "Actor calculateFinalPower"` etc. See
`BINARY_RE_METHODOLOGY.md`. Cross-check the anti-one-shot branch and the level-scale endpoint
table against in-game behaviour before locking them into balance.

---

# Loot & gold rewards — GROUND TRUTH (disassembled, same session)

Target #2: how raid gold and item drops are actually computed. The loot logic lives on
**`ZFFightMan`** (fight manager) and **`ZFFightSummary`** (the results screen), with the RNG
primitive on **`GameState`**. `gameplayParameters.json` supplies the coefficients; the code
below is the arithmetic that consumes them.

## The universal weighted-RNG primitive — `+[GameState rollAgainstFrequencyInArray:]` (0x11a1c)

Every "pick one weighted entry" in the game funnels through this. Given an array of dicts:
1. sort the array ascending by the **`frequency`** key (confirmed cfstring),
2. `total = Σ entry["frequency"].floatValue`,
3. `roll = arc4random_uniform((u32)total)`,
4. walk the sorted array accumulating `frequency`; return the first entry whose **cumulative**
   frequency exceeds `roll`.

So the `frequency` fields all over the data (`Attacks.json` attack variations,
`UnitStats.json` `attacks[]`/`bossActions[]`, and the loot tables) are **weights in a
cumulative `arc4random_uniform(Σfreq)` selection** — not percentages. This one primitive drives
attack choice, boss-action choice, and loot-entry choice.

## Standard gold — `-[ZFFightMan getStandardGoldLootForStageLevel:]` (0x635e8)

```
coeff = gameState.gameplayParameters["goldDistributionLevelCoefficient"]   # = 2.3 (confirmed key)
gold  = stageLevel × 100.0 × coeff                                          # literal 100.0
if (ivar_0x1ec != 0):  gold = gold / (ivar_0x1ec + 3.0)                     # optional divisor
return (u32)gold
```
Base payout is **`stageLevel × 100 × 2.3 = stageLevel × 230`**. The trailing divide-by-`(n+3)`
is gated on an instance field (`0x1ec`) that's usually 0 in the normal path; its identity
(wave count? gold-pickup count to split across?) is **not yet confirmed** — verify before use.

## Bonus gold — `-[ZFFightMan getBonusGoldLootForStageLevel:]` (0x63690)

Trivial: `return stageLevel × 100`. (One-instruction method: `movs r0,#0x64; muls`.)

## Brain drops

Already plist — `gameplayParameters.json → brainDropRateInvasion`
(`brainAmountIncrements [0,10,30,50]`, per-tier `brainDropChancesLowerLimit` /
`...UpperLimit`). No disassembly needed; the code just reads these arrays.

## Item drop-chance ladder — `-[ZFFightSummary rollForDrop:]` (0x96a59)

```
roll = (arc4random % 100) / 100.0          # a fraction 0.00..0.99  (literal divisor 100.0)
```
Then `roll` is compared (`vcmpe ; bmi "select this tier"`) against a ladder of cumulative
thresholds, and **which ladder is used depends on `[fightMan bonusRoll]`** — i.e. Golden Dice
swaps in a more-generous threshold set. Recovered threshold constants from the function's
literal pool (0x96d40+): **`0.14, 0.24, 0.59, 0.74, 0.79, 0.84, 0.89, 0.92`** (and `0.09`).
These are two/three cumulative rarity bands (common→rare→epic); the exact
threshold→tier assignment and which set is the bonus set need the branch order transcribed —
**values are ground truth, the per-tier labelling is not yet pinned.**

## Which items are in the table — `-[ZFFightSummary lootTableFromCategory:]` (0x967a5)

Built per-enemy from `enemyDictionary` (i.e. `Enemies.json`), filtered through
`doesOwnItem:` / `numberOfItemInStorageWithKey:` — so **already-owned unique drops are excluded**
from the roll (no duplicate uniques). Confirms loot is enemy-scoped, deduped against inventory.
`ZFFightMan buildStandardGoldLootTable` / `buildStandardBossLootTable` assemble the shared
gold/boss pools consumed here.

## What this replaces in the reimplementation

- Raid gold: use **`level × 230`** (+ `level × 100` bonus-gold pickups), not an eyeballed amount.
- Any weighted pick (attacks, boss actions, loot): use the `frequency`-weighted cumulative
  `arc4random_uniform(Σfreq)` rule verbatim — the JSON `frequency` values are already correct
  inputs to it.
- Drop rarity: a fraction roll `(rand%100)/100` against the recovered threshold ladder, with a
  distinct **Golden Dice (`bonusRoll`) ladder** — matches the "dice add extra/better loot rolls"
  UI already wired.
- Uniques already owned must be filtered out of the pool before rolling.

**Still uncertain (verify in play):** the `ivar_0x1ec` gold divisor identity, and the exact
threshold→rarity-tier mapping + which ladder is the bonus one.

---

# Sell values & level-up (disassembled, same session)

## Zombie sell value — `-[ZFToolManager sellZombie:]` (0x1d068)

The whole confirmation-alert method reduces to one arithmetic line (0x1d162):
```
cost = [ZombieMarketPopup getCostForItemName:<zombie name>]   # base market price by name
sell = (cost + (cost >> 31)) >> 1                             # signed floor(cost / 2)
```
**Zombie sell value = floor(baseMarketCost / 2), flat.** It is NOT scaled by stats, mutations,
or veterancy. The reimplementation's `economy.ts zombieSellValue` (stat/mutation/veterancy
scaled) is **wrong** — it should be half the unit's base buy price.

## Harvested-item sell — `-[GameState amountToSellHarvestedItem:]` (0x14350)

```
sell = item["price"] != nil ? (int)item["price"].floatValue
                            : (int)(item["cost"].floatValue + 11.0)
```
An explicit `price` wins; otherwise `cost + 11`, truncated to int.

## Level-up — `-[GameState levelUp]` (0x1356c)  *(large stateful method — partial)*

Cleanly recovered:
- **Level cap**: `if (level > 44) return;` — no-op past level 44 (`PlayerLevels.json` has 46
  entries = levels 0..45). Otherwise `setLevel: level + 1`.
- After incrementing, it **scans `enemyArray`** and queues an unlock alert for each enemy whose
  required level now matches — i.e. **raids unlock at level-up** by their per-enemy level gate.
- Grant calls seen: an `addResource:amount:` of a single unit gated at `level >= 4`, and (for
  `level <= 5`) an `addResource:amount:` of `level × 100`. A separate value is **bucketed** into
  tiers `500,1000,5000,10000,25000,50000,75000,100000,150000,200000,300000,400000,500000,1e6`
  for the animated number in the level-up popup.

**Deferred (needs a decompiler, per METHODOLOGY's "large stateful" rule):** the exact per-level
currency grants and the tier-string/reward bucketing are tangled through many ivars and alert
calls; hand-tracing gives only approximate magnitudes. The reimpl's existing level-up (grant
currency + unlock popup) is structurally correct; don't hard-code magnitudes from this trace.

---

# Implementation status (what got wired into the reimpl)

- **Zombie sell = floor(baseCost/2)** — DONE (`economy.ts`).
- **Raid standard gold = level×230, bonus gold = level×100** — DONE (`economy.ts` / raid resolve).
- **Combat final-stat formulas + veterancy +5%/rank** — DONE (`combatStats.ts`).
- **Damage = max(0, dmg−armor) × (1−DR)** — DONE (`combatStats.ts`).
- **Frequency-weighted `arc4random_uniform(Σfreq)` selection** — DONE (`combatStats.ts pickByFrequency`).
- **Per-group level-scale endpoint table (str/con/dex ramp, level 8→25)** — DONE
  (`combatStats.ts levelScaleStat` + wired into `CombatEngine.buildPlayerUnits`, fed `playerLevel`
  from `RaidManager`). Regression-tested.
- **Stat→fight-data conversion (power=str×10, HP=con×100, interval=2/dex zombie · 1/dex enemy)
  + per-swing damage (finalPower × mult, then the player lineup-depth band 1.0/0.85/0.7/0.55;
  enemies ×1.0)** — DONE (`combatStats.ts deriveMaxHp / deriveAttackIntervalMs / deriveHitDamage /
  lineupDamageBand`, wired into `CombatEngine.unit()` + `hitDamage()`).
  Faithful inputs; sim loop still approximate. Regression-tested.
- **All of the above locked in by `npm test`** (Vitest, `src/**/*.test.ts`).
- **Anti-one-shot 1-HP floor** — IMPLEMENTED as an inferred heuristic (`BattleSim.ONE_SHOT_FLOOR`);
  the exact in-binary state-bit (`0x10`) semantics stay inferred, so verify against play.
- **Deferred / partial:** drop-rarity tier labels + which ladder is the Golden-Dice bonus set,
  the `ivar_0x1ec` gold divisor, and level-up currency magnitudes —
  left as-is pending a decompiler / in-game verification.
