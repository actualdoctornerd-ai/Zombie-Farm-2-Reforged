# Ability ideas — endgame backlog

Status: **IDEAS ONLY. Nothing here is implemented.** Owner-proposed 2026-09-21.

Context: the 2026-09-08 special/epic reclass (rulesets 50–51) put off-class abilities on
five invasion/epic pairs and landed well with players. These extend that idea. The goal is
endgame texture that rewards **party composition**, **well-timed activations**, and
**interesting mutation use**, using mechanics the sim already has.

## Structural constraints any of these must respect

- The base 6-groups × 4-tiers matrix in `src/zombie/traits.ts` is closed: every one of the
  22 ability icons is used **exactly once**. New abilities therefore live in
  `SPECIAL_ABILITIES` as per-unit overrides, not in `GROUP_ABILITIES`.
- A tier slot may hold an ability from a *different* tier. `abilityUnlocked` keys off the
  ability's own tier (`abilityTierOf`), not the slot's — so a tier-4 ability parked in a
  tier-3 slot unlocks with the Ninjas, and the card's padlock names that boss. This is
  already how Dr. Zombie's `zomBeam` works.
- `ABILITY_KIND` decides strip presence: `self` = hidden, `team` = info icon, `activated` =
  tappable button. **Four activated buttons is the landscape-phone worst case** (see the
  `ACTIVATED_STACKS` comment) — new buttons are the scarcest resource on this list.
- Every new ability needs a new `ability_*.png` through the contributed-art pipeline.
- Any of these bumps `RAID_RULESET_VERSION` (currently 61). Deploy discipline applies: the
  Worker bundles the working-tree `src/raid`, so a dirty tree means 426 for every player.

All four pairs below are `group: Regular`, `className: Special`, so today they all run the
stock Regular ladder: `buffAllStats` / `chivalry` / `laserBeam` / `zomBeam`.

---

## 1. Scrooge / Christmas Ghost — gold find

**Keys:** `ZombieActorScrooge`, `ZombieActorChristmasGhost`
**Proposal:** +8% gold from invasions. Stacks per carrier.
**Tier slot:** not yet chosen.

This is the odd one out: it is an **economy** ability, not a combat one. It cannot live in
`ABILITY_COMBAT` or `BattleSim` at all — it has to be applied at raid **settlement**, and
under own-account containment that means **server-side, computed from the verified
roster**. A client-claimed multiplier is exactly the shape of thing the containment work
removed. Fold it into the existing settlement write rather than adding a second one.

`ABILITY_KIND` has no category for "affects rewards, does nothing in the fight". Either add
a fourth kind, or file it as `team` so it at least shows as an info icon during the raid.

Open questions:

- **Stacking cap.** 8% per carrier across a 20-slot army is +160% unbounded. Needs a cap or
  diminishing returns. Capping around 3–5 carriers keeps it a *choice* rather than a
  mandatory gold-farm loadout that crowds out fighters.
- **Must the carrier survive?** Paying out for a dead Scrooge is simpler and kinder;
  requiring survival makes it interact with casualties and reads as a double punishment.
- Does it apply to boss-token / brain / prize rolls too, or strictly gold? Strictly gold is
  the cleaner promise and the easier one to keep honest.

---

## 2. Admiral / Captain — Leader

**Keys:** `ZombieActorAdmiral`, `ZombieActorCaptain`
**Proposal:** +5% stats to all **other** zombies.
**Tier slot:** not yet chosen.

Mechanically this is Chivalry/Grace with the group filter removed, so `refreshTeamAuras`
already does almost all of it — it counts deployed carriers per ability and stacks them
additively (two holders = +10%, three = +15%).

Two things it does NOT already do:

- **Self-exclusion.** Chivalry and Grace buff their own carrier when it shares the group.
  "All other zombies" needs an explicit skip, which is a new branch in the aura loop.
- **Untyped targeting.** Every existing stat aura is keyed to a group (`Female` / `Regular`
  / `Headless`). Leader hits everyone, so `teamAuraStats` needs a carrier count that isn't
  group-conditional.

Flag: an untyped, stacking, whole-army stat buff is the most cascade-prone change on this
list — a player-side buff reddens roughly four suites at once, and the fix is to re-fit the
elite profiles, not to move thresholds. Budget that re-fit as part of the feature. Consider
whether Leader should be **non-stacking** (one Admiral's worth, period) to keep the blast
radius small; "the fleet has one Admiral" is a defensible fiction.

---

## 3. Vagabond / Bandido — Opportunist (tier 4)

**Keys:** `ZombieActorVagabond`, `ZombieActorBandido`
**Proposal:** +25% damage against **stunned** enemies. Replaces `zomBeam` in the t4 slot.
**Kind:** `self` (hidden from the strip — there is no decision at the moment of use).

Cheapest of the four to build: read `target.stunMs > 0` at damage resolution. No new UI, no
new button, no aura bookkeeping.

What makes it interesting is that it has **no value on its own** — it needs a stun source in
the same army. Today those are Smash's 1-second area stun, Explode's 3 seconds, and Random
Stun's 4% proc. So it quietly rewards both composition (bring a stunner) and timing (Smash,
then hit the window) without costing a strip slot.

Note the Vagabond is the strongest Epic and the balance stick the Video Game Zombie was
fitted under; a damage passive on it moves that reference point.

---

## 4. Zastronaut / Cozmonaut — Escape Pod (tier 3)

**Keys:** `ZombieActorZastronaut`, `ZombieActorZosmonaut` (display name **Cozmonaut**)
**Proposal:** on what would be a killing blow, the zombie instead launches straight up with
a small explosion — area damage plus a stun — and returns to the **waiting/deploy** pool
instead of dying. Replaces `laserBeam` in the t3 slot.
**Precedence:** takes priority over Resurrect, and does **not** consume the revive.

The best fantasy of the four and the most involved to build. It is a death-replacement, a
brand-new category: nothing in the sim currently intercepts lethal damage except the
one-shot protection latch and the Resurrect path.

Design decisions still open:

- **Once per fight, surely.** Without a latch (the `resurrectUsed` pattern is the model)
  this is an unkillable zombie. A per-unit `escapePodUsed` flag is the obvious shape.
- **HP on return.** Full, or a fraction? Full is generous but legible.
- **Precedence.** `canResurrect` keys off the ability rather than the body since v51. The
  pod has to be checked *before* the resurrect path so it fires first and leaves the revive
  banked, exactly as specified.
- **The return is the real cost, and it is a big one.** A zombie re-entering the deploy
  queue goes to the back — and 20 zombies already need ~72 seconds to deploy, with the rear
  routinely never arriving at all. So in a long fight the pod may read as "died, but
  politely". That may be the right price; it should be a decision, not a surprise. Worth
  considering whether it re-enters at the **front** of the queue instead.
- **Casualty and veterancy accounting.** Does a podded zombie count as surviving the
  invasion (veterancy rank), and does it stay out of the graveyard (`fallen_v3`)? The
  graveyard is server-authoritative, so the verifier and the client must agree.
- **Edge states.** What happens if the killing blow lands while `grabbed` / `taken` (crab
  carry, pixel-fire conversion)? Simplest answer: the pod does not fire from those states.
- The explosion should probably NOT hit the boss by default — that is `explodeV2`'s
  distinguishing privilege and the thing its tier is sold on.

---

## Also discussed, not yet adopted

From the 2026-09-21 brainstorm, kept here so they are not lost:

- **Lightning Rod** — passive that redirects the boss's throw to its carrier instead of the
  rear-most zombie (`throwTarget()` currently always picks the back line, which is a fixed
  tax on Gardens). One candidate filter to build; composes with Protect, Block and
  Fortitude. Hazard: boss throw damage is re-based on the newest Garden healer, so
  redirecting onto a tank is a real effective-DPS cut and will need an elite re-fit.
- **Counterweight** — activating any move during the boss's 550 ms throw wind-up makes it
  hit harder. The telegraph is already animated and honest.
- **Regimental / Menagerie** — opposed composition passives (all-one-group vs. one per
  distinct group). **Trap:** compute composition from the **roster at fight start**, not
  from deployed units — a deployed-unit count ramps over ~72 seconds and would switch on
  near the end of the fight, invisibly. Roster-based is also visible on the party screen
  before launch, which is where the decision actually happens.
- **Splice / Grafted** — mutation breadth vs. depth. `u.mutation` is already on `SimUnit`
  and `maskBits` gives the count, so both are cheap. Measured endgame armies use 3 mutation
  masks for 85% of slots, so anything paying for breadth attacks a known monoculture.
