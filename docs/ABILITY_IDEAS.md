# Ability ideas — endgame backlog

Owner-proposed, 2026-09-21 → 2026-09-23.

Two sections:

1. **[Agreed reshuffles](#agreed-reshuffles-existing-abilities-only)** — **BUILT 2026-09-24
   at ruleset 62.** Uses only the 22 existing abilities.
2. **[Parked new abilities](#parked-new-abilities)** — agreed as ideas, need new mechanics
   and new art. **Not built, not scheduled.**

Context: the 2026-09-08 special/epic reclass (rulesets 50–51) put off-class abilities on
five invasion/epic pairs and landed well with players. All of this extends that idea. The
goal is endgame texture that rewards **party composition**, **well-timed activations**, and
**interesting mutation use**.

## Structural constraints everything here must respect

- The base 6-groups × 4-tiers matrix in `src/zombie/traits.ts` is closed: every one of the
  22 ability icons is used **exactly once**. Changes live in `SPECIAL_ABILITIES` as
  per-unit overrides, not in `GROUP_ABILITIES`.
- A tier slot may hold an ability from a *different* tier. `abilityUnlocked` keys off the
  ability's own tier (`abilityTierOf`), **not the slot's** — so a tier-2 ability parked in a
  tier-3 slot unlocks with the Lawyers, and the card's padlock names that boss. Keep each
  unit's four unlock bosses **non-decreasing** across slots or the card reads as a ladder
  that goes backwards. Every entry below was checked for this.
- `ABILITY_KIND` decides strip presence: `self` = hidden, `team` = info icon, `activated` =
  tappable button. **Four activated buttons is the landscape-phone worst case.**
- Any of these bumps `RAID_RULESET_VERSION` (now 62 — the reshuffle below took 61 → 62).
  The Worker bundles the working-tree `src/raid`, so a dirty tree means 426 for every
  player.

**Why this matters at all:** fifteen prize zombies are `group: Regular` and therefore run
the *identical* stock ladder (`buffAllStats` / `chivalry` / `laserBeam` / `zomBeam`) — Old
McZombie, Teddy, Deputy, Sheriff, Zastronaut, Cozmonaut, Video Game Zombie, Boss Zombie,
Brock Coley, Bandido, Vagabond, Captain, Admiral, Christmas Ghost, Scrooge. Mechanically
they are the same zombie wearing different art.

Guiding principle: **each reclass moves exactly one scarce ability onto a body that cannot
normally hold it.** Not a shuffle — one "you can't get this anywhere else" hook per zombie.

---

# Agreed reshuffles (existing abilities only)

> **Shipped at ruleset 62 on 2026-09-24.** Seven `SPECIAL_ABILITIES` keys in
> `src/zombie/traits.ts`; the `isHealer` un-gate, `healSuppressed` and the banked timers in
> `src/raid/BattleSim.ts`; pinned by `src/zombie/specialAbilities.test.ts` and the
> "off-Garden healers" block in `src/raid/BattleSim.abilities.test.ts`.

| Zombie | Group | t1 | t2 | t3 | t4 |
|---|---|---|---|---|---|
| **Captain / Admiral** | Regular | `grace` | `chivalry` | `tankHitPointsBuff` | `protect` |
| **Old McZombie** | Regular | `buffAllStats` | `chivalry` | `tankHitPointsBuff` | `healAOE` |
| **Forest Zombie** | Female | `heal` | `grace` | `stun` | `doubleStrike` |
| **Brock Coley** | Regular | `buffAllStats` | `chivalry` | `tankHitPointsBuff` | `bash` |
| **Zastronaut / Cozmonaut** | Regular | `buffAllStats` | `chivalry` | `turboSpeed` | `zomBeam` |

Changed slots are the ones differing from each unit's stock group ladder.

## Captain / Admiral — the line commander

**Keys:** `ZombieActorCaptain`, `ZombieActorAdmiral` (epic-quest rungs `3000` / `3011`)
**Change:** all four slots. Drops both lasers and `buffAllStats`. A plain body that carries
four stacking support auras.

One Admiral gives:

| Group | Gets |
|---|---|
| Regular | +10% dmg/life/speed (Grace), +20% damage reduction |
| Female | +10% dmg/life/speed (Chivalry), +20% damage reduction |
| Headless | +10% Life (Fortitude), +20% damage reduction |
| **Large / Small / Garden** | **+20% damage reduction only** |

Three things to know:

- **All four abilities are tier 2**, so all four gate on the Lawyers *simultaneously*. There
  is no progression ladder on this zombie — it arrives fully formed, and before the Lawyers
  it has nothing at all. Harmless in practice (it is an epic-quest reward, long after the
  Lawyers) but the card will show four padlocks naming the same boss.
- **Protect does not shield its own carrier.** `protectReduction(carriers, isCarrier)`
  subtracts the carrier from the count, so a lone Admiral gives 20% to everyone else and
  **0% to itself**. Good for the fantasy — the commander shields the troops — but it is
  squishier than the buff list suggests. `PROTECT_STEP` 0.20, `PROTECT_CAP` 0.95.
- **Large, Small and Garden cannot be buffed by any existing ability.** All three stat auras
  are hard-keyed to Regular/Female/Headless in `refreshTeamAuras`. "Significant buffs" tops
  out as a *line* commander; brutes, minis and healers get only the damage reduction. There
  is no way to close that gap without a new ability.

Practical trap: `refreshTeamAuras` counts **deployed** carriers only. With 20 zombies taking
~72 s to deploy, an Admiral late in the army order contributes nothing for most of the
fight. It needs to be early in the formation, and players will not know that unaided —
worth a raid tip or a line on the card.

## Old McZombie — the farmhand medic

**Key:** `ZombieActorOldMcZombie` (Old McDonnell's invasion, rec 5, 1% drop)
**Change:** t3 `laserBeam` → `tankHitPointsBuff`, t4 `zomBeam` → `healAOE`. **No lasers.**
**Stats: UNCHANGED** (str 8 / dex 3.67 / con 12). An earlier draft cut str and raised dex;
that was dropped — the ability swap is the whole change.

Heal All pays `str × 5` = **40 to every damaged deployed zombie**, on a flat 20-second
timer (`HEAL_AOE_MS`; unlike single-target `heal`, its cadence is *not* dex-scaled).

Unlock ladder is clean and strictly non-decreasing: Old McDonnell → Lawyers → Lawyers
(Fortitude is tier 2 sitting in the t3 slot) → Ninjas (`healAOE` is tier 4, in its natural
slot). Note there is **no dead window**: stock Old McZombie would gain its first laser at
the Pirates, whereas this one gains Fortitude at the *Lawyers* — strictly earlier. The
damage loss and the support gain arrive together, so it reads as a side-grade the whole way
up rather than a nerf with a delayed payoff.

Keeping the original stats also removed the laser/heal inconsistency flagged earlier: it no
longer has a walking laser to fire while healing.

**Note it is now nearly a sibling of Brock Coley** — same t1/t2/t3, differing only at t4
(`healAOE` vs `bash`). Fine if deliberate; flagged in case more differentiation is wanted.

## Forest Zombie — nature regrows

**Key:** `ZombieActorForest` (Tree World, rec 8, seasonal, 1% drop)
**Change:** t1 `attackSpeedBuff` → `heal`. Everything else stock Female.

`heal` is tier 1, so it unlocks at Old McDonnell — available immediately. This is the first
non-Garden single-target healer: a healer that is also a fighter.

**Raw throughput is high, but uptime is not.** At str 9 / dex 3.67 it heals 45 per cast on a
545 ms cadence (`heal` reuses the attack interval, `2.0 / dex` seconds):

| Healer | Per cast | Cadence | Nominal HP/s |
|---|---|---|---|
| Garden tier-5 | 30 | 1000 ms | 30 |
| Dr. Zombie (epic prize) | 70 | 833 ms | 84 |
| **Forest Zombie** | **45** | **545 ms** | **82** |

That nominal rate is Dr. Zombie's, on a rec-8 seasonal drop — but **it will not cast
anywhere near as often as a real Garden does.** A Garden never enters `fight` state, so its
uptime is effectively 100%; the Forest Zombie is a front-line Female that only heals in the
gaps between swings and during its walk-in (see the gap rule below). The headline HP/s is
the ceiling, not the average, and the gap rule is what separates the two. This is the
intended design, not an oversight — but it does mean the ability's real value is very
sensitive to how often the line is idle, which is worth measuring rather than assuming.

If it over-performs, the lever is **str** (heal = `str × 5`), not dex: str 9 → 7 brings a
cast to 35. Also note `healer.power` includes team auras, veterancy and mutations, so a
Master-rank mutated Forest under Chivalry heals considerably harder than the base number.

## Brock Coley — the glass nuke

**Key:** `ZombieActorBrockColey` (Rocky Rhino event)
**Change:** t3 `laserBeam` → `tankHitPointsBuff`, t4 `zomBeam` → `bash`. **No lasers.**

Unlock ladder: Old McDonnell → Lawyers → Lawyers → Pirates (`bash` is tier 3 in the t4
slot). Non-decreasing, reads correctly.

**This is the biggest damage addition in the batch.** Brock Coley is str **46** — by far the
highest here — and Bash is 2.75× AoE with `cantInterrupt` super armour. Three things offset
it: con 8 is glass (Old McZombie has 12), and it loses **both** lasers, trading sustained
DPS for burst. Watch it in the balance suites.

Not obviously priced in: **Rocky Rhino pays Brock Coley at both rung 5 and rung 10** — the
only event awarding the same zombie twice. Players can hold two, meaning two Bash carriers
and stacked Fortitude.

## Zastronaut / Cozmonaut — low-gravity bounding

**Keys:** `ZombieActorZastronaut`, `ZombieActorZosmonaut` (display name **Cozmonaut**)
**Change:** t3 `laserBeam` → `turboSpeed`. Nothing else.

Cleanest change on the list: both abilities are tier 3, so unlock timing is unchanged (the
Pirates). No gating consequences at all.

Hidden synergy worth knowing: `leadVelocity` caps how far a boss throw leads its target
(`PREDICT_SPEED_CAP`), so a fast zombie outruns thrown projectiles — the shot lands behind
it. Combined with con 30, this makes the Zastronaut a tank that arrives early *and* eats
fewer throws on the approach. It also directly helps the deploy-queue starvation problem.

If Escape Pod (below) is ever built, it would displace `turboSpeed` from this slot.

---

## Implementation notes for the agreed set

### `isHealer` is Garden-gated and must change

```ts
private isHealer(p: SimUnit): boolean {
  return p.isGarden && (p.abilities.includes("heal") || p.abilities.includes("healAOE"));
}
```

Unlike Resurrect — deliberately un-gated in v51 so Proto/Zombug could carry it — `heal` and
`healAOE` are still hard-gated to Garden bodies. **Without this change, the Forest Zombie
and Old McZombie changes do literally nothing**: `stepHealing` skips them at the first line.

### The gap rule: heal only when not in `fight` state

Off-Garden healers heal in the gaps between swings and while walking in, never while
actually attacking. The signal already exists — **`p.state === "fight"`**:

| Situation | State | Heals? |
|---|---|---|
| Garden at its station | never enters `fight` | ✅ **unchanged from today** |
| Off-Garden healer walking in | `advance` | ✅ |
| Off-Garden healer, nothing in front | flips out of `fight` | ✅ |
| Off-Garden healer swinging | `fight` | ❌ suppressed |

**CORRECTION, found while building it (2026-09-24).** The rule as first written was just
`p.state === "fight"`, on the reasoning that a Garden pinned at `GARDEN_STATION_X` closes on
nothing and so never enters that state. That is true of an ATTACKING Garden and false of a
**defending** one: in PvP the defenders are enemy-side units, and the enemy loop flips them
to `"fight"` the moment `playerInRange` finds an attacker. The first build therefore
silently stopped every formation defense in the wild from healing under assault, and
`pvp.test.ts` caught it as a balance-band move (the attacker's break-even ratio drifted from
under 1.25 to 1.259).

The shipped rule carries an explicit exemption:

```ts
private healSuppressed(p: SimUnit): boolean {
  return !p.isGarden && p.state === "fight";
}
```

`isGarden` is the SUPPORT flag (`CombatEngine.supportsFromRear`), so this reads as **a
station-holder heals for a living, a line-fighter heals between swings**. It is a genuine
no-op for every Garden on both sides, and `BattleSim.abilities.test.ts` pins the defending
case specifically, since the attacking one passes on geometry alone and would not catch a
regression.

The gap behaviour is already modelled: see the comment at `BattleSim.ts` ~1521 noting that
`state` "flips out of `fight` in every gap between one enemy dying and the next walking on."

**Do NOT implement this as `targetEnemy() === null`.** `targetEnemy` has no range cap and
returns the nearest enemy at any distance, so it returns a target for a Garden at x=250 and
would stop every healer in the game from healing.

### Heals are HELD, not reset (decided)

When a heal comes due while the carrier is suppressed, the timer **drains to ≤ 0 and holds
there**, firing on the first gap. It does *not* reset.

Without this, a front-line carrier on a flat 20-second `healAOE` timer would only ever cast
when the expiry happened to coincide with a gap — i.e. almost never. Holding means the heal
banks and lands the moment the enemy in front dies, which reads as catching your breath.

Applies to both `healTimerMs` (single-target) and `healAoeTimerMs` (Heal All). The held
timer parks at exactly zero rather than running negative, so a checkpoint taken mid-hold
replays identically however long the hold ran.

One tick of lag, as built: `stepHealing` runs before the state update inside a tick, so the
banked cast lands on the tick after the gap opens — 50 ms, against cadences of 400 ms and
20 s.

### Balance — as measured on the build

Four stacking auras on the Admiral plus Brock Coley's Bash was expected to redden roughly
four suites. **It did not.** The full suite (239 files, 2417 tests) is green with no profile
re-fit and no threshold moved. The only balance failure at any point was the PvP band above,
which was a bug in the gap rule rather than a tuning consequence, and it went away when the
rule was corrected.

The reason is worth recording: none of the seven reshuffled keys appears in the balance or
harness fixtures, which build their armies from the generic `ZombieActor*Tier*` catalog
rows. So the suites never fielded an Admiral or a Brock Coley and had nothing to redden.
**That is a gap in coverage, not a clean bill of health** — the aura stack and Bash on str
46 are still untested against the elite profiles, and the first real signal will come from
the difficulty harness or from players. Worth a deliberate pass before treating the numbers
as settled.

---

# Parked new abilities

Agreed as ideas, but each needs a new mechanic **and** new `ability_*.png` art. Not
scheduled.

## Scrooge / Christmas Ghost — gold find

**Keys:** `ZombieActorScrooge`, `ZombieActorChristmasGhost`
**Proposal:** +8% gold from invasions, stacking per carrier. Tier slot not chosen.

The odd one out: an **economy** ability, not a combat one. It cannot live in `ABILITY_COMBAT`
or `BattleSim` — it applies at raid **settlement**, and under own-account containment that
means **server-side, computed from the verified roster**. A client-claimed multiplier is
exactly what the containment work removed. Fold it into the existing settlement write.

`ABILITY_KIND` has no category for "affects rewards, does nothing in the fight" — either add
a fourth kind, or file it as `team` so it at least shows as an info icon.

Open: **stacking cap** (8% × 20 slots = +160% unbounded; a cap around 3–5 carriers keeps it
a choice rather than a mandatory gold loadout); **must the carrier survive?** (paying out
for a dead Scrooge is simpler and kinder); **gold only, or tokens/brains/prizes too?**
(gold only is the cleaner promise).

## Vagabond / Bandido — Opportunist (tier 4)

**Keys:** `ZombieActorVagabond`, `ZombieActorBandido`
**Proposal:** +25% damage against **stunned** enemies. Replaces `zomBeam`. Kind: `self`.

Cheapest new ability on the list — read `target.stunMs > 0` at damage resolution. No UI, no
button, no aura bookkeeping.

Its point is that it has **no value alone**: it needs a stun source in the same army (Smash's
1 s area stun, Explode's 3 s, Random Stun's 4% proc). So it rewards composition *and* timing
without costing a strip slot.

The Vagabond is the strongest Epic and the balance stick the Video Game Zombie was fitted
under, so a damage passive on it moves that reference point.

## Zastronaut / Cozmonaut — Escape Pod (tier 3)

**Keys:** `ZombieActorZastronaut`, `ZombieActorZosmonaut`
**Proposal:** on a killing blow, the zombie instead launches straight up with a small
explosion — area damage plus a stun — and returns to the **waiting/deploy** pool instead of
dying. Would replace `turboSpeed` in the t3 slot.
**Precedence:** fires before Resurrect and does **not** consume the revive.

A death-replacement — a brand-new category. Nothing currently intercepts lethal damage
except the one-shot protection latch and the Resurrect path.

Open questions:

- **Once per fight**, or it is an unkillable zombie. The `resurrectUsed` latch is the model.
- **HP on return** — full, or a fraction?
- **Precedence.** `canResurrect` keys off the ability, not the body (v51). The pod must be
  checked *before* the resurrect path so it fires first and leaves the revive banked.
- **The return is the real cost.** A zombie re-entering the deploy queue goes to the back,
  and 20 zombies already need ~72 s to deploy with the rear often never arriving. In a long
  fight the pod may read as "died, but politely." That may be the right price — it should be
  a decision, not a surprise. Consider re-entering at the **front** instead.
- **Accounting.** Does a podded zombie count as surviving (veterancy) and stay out of the
  graveyard (`fallen_v3`)? The graveyard is server-authoritative; verifier and client must
  agree.
- **Edge states.** Killing blow while `grabbed` / `taken` (crab carry, pixel-fire)? Simplest
  answer: the pod does not fire from those states.
- The explosion should probably **not** hit the boss — that is `explodeV2`'s distinguishing
  privilege and what its tier is sold on.

## Superseded

- **Leader** (+5% to all other zombies, for the Admiral) — superseded by the agreed
  Captain/Admiral loadout above, which reaches the same goal with existing abilities. Kept
  for the finding that motivated it: `refreshTeamAuras` already stacks per-carrier
  additively, but every stat aura is group-keyed, so an *untyped* whole-army buff would need
  both a self-exclusion branch and a non-group-conditional carrier count.

## Considered and rejected

- **Video Game Zombie / Boss Zombie → Resurrect.** Rejected 2026-09-23: they are already
  extremely strong and any change to them should be a side-grade at best. Resurrect is one
  of the strongest abilities in the game and stays **rationed** — Garden group plus
  Proto/Zombug, and no further carriers.
- **Zastronaut → Mini Buddy.** `canTakeMini` hard-requires `isLarge(p)`, so on a Regular body
  the ability is inert and the button would not even appear. Needs a code change, not a
  table edit.
- **Other brainstormed ideas** not taken forward: **Lightning Rod** (redirect the boss throw
  to its carrier — `throwTarget()` always picks the rear-most zombie, a fixed tax on
  Gardens); **Counterweight** (activating a move during the boss's 550 ms throw wind-up hits
  harder); **Regimental / Menagerie** (opposed composition passives — *trap:* compute
  composition from the **roster at fight start**, not deployed units, which ramp over ~72 s
  and would switch on invisibly near the end); **Splice / Grafted** (mutation breadth vs.
  depth — `u.mutation` is already on `SimUnit`, and measured endgame armies use 3 masks for
  85% of slots).
