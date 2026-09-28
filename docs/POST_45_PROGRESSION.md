# Post-45 Progression — levels 46-50 and the dual invasions

SPEC — hand-off draft. All four invasions are BUILT (Stages 0-4) bar their art; next is the balance pass.

> **REDESIGNED 2026-09-27: read "Part 2B — The tier ladders, redesigned" first.** It supersedes
> the tier dials in Part 3, the tuning rule in "The eight permanent unlocks" and the prestige
> split. Part 3 is kept as the record of what is BUILT today.

The mechanics in Parts 2 and 3 are **decided**; the numbers in them are **placeholders**. The
difficulty harness cannot currently measure three of these four fights, so every profile,
threshold and reward gets re-derived after it is rebuilt (see Sequencing). Build the
mechanics; do not spend time hand-tuning numbers that are going to be thrown away.

Open questions are collected at the end, and marked OPEN where they appear inline.

## Why both paths

A community poll (51 votes, multi-select) asked what should follow level 45:

| option | votes | share |
|---|---|---|
| Both — allow prestige after a certain level | 25 | 49% |
| Increase the level cap, with additional content | 19 | 37% |
| Prestige system — reset the farm for long-term buffs | 4 | 8% |
| Neither — no more content after 45 | 3 | 6% |

Read as coalitions: 86% want more levels, 57% want prestige. So both ship, but the cap
raise is the broader mandate and prestige is the enthusiast path. **This document is the
level path only.**

**Prestige is being reworked and is out of scope for this document** (Part 5 is kept only
as a record and is ON HOLD). **Update 2026-09-27: prestige is being relegated to ECONOMY, so the tier ladders may grant army
power (see Part 2B).** One rule survives whatever it becomes: **levels 46-50 are tuned
at no-prestige power.** A fight that needs a prestige upgrade is a fight that has quietly
made prestige mandatory.

---

## Part 1 — Levels 46-50

### The XP curve

`XP_THRESHOLDS` gains five entries (client `src/GameState.ts`, server `server/src/levels.ts`
— the two are hand-mirrored and the server file says so). Everything else derives the cap
from `XP_THRESHOLDS.length`, with one exception: `MAX_LEVEL = 45` in
`src/quest/periodic/generate.ts`, which is the interpolation endpoint for the daily share
and stays at 45 deliberately (see below).

**The daily-quest freeze.** Periodic rewards are a *share of the requirement*:

```
dailyUnitXp = xpToNext × dailyShare(level) / 3
```

so raising the thresholds inflates the dailies to match and the wall-clock per level does
not move. The file already says this at line 40: *"Because the reward is a SHARE of the
requirement, raising thresholds could never slow that down — only this number can."*

Decision: **dailies keep paying their level-45 value at 46-50.** One change covers client
and server, because `generate.ts` is a shared import (`server/src/v3/{engine,db,raid}.ts`
all pull from it) — clamp the reference level inside `xpToNextLevel`:

```ts
export const PERIODIC_XP_REFERENCE_LEVEL = 44;
const capped = Math.min(Math.floor(level), PERIODIC_XP_REFERENCE_LEVEL);
```

Every caller of `xpToNextLevel` is periodic-reward sizing; the HUD's own progress bar comes
from `GameState.levelXp`, so nothing else moves.

**It is 44, not 45.** An earlier draft of this section said 45 and was wrong. While 45 was the
top of the array, `xpToNextLevel(45)` meant "the final step reused", i.e. 218,000 − 193,000 =
25,000. Add five tiers and level 45 acquires a real next step — the new, much larger 45→46 one
— so a clamp at 45 would hand the board a raise at exactly the level it is meant to be pinned
to. Clamping at 44 keeps the 25,000 the shipped board has always been paid from, which is also
what `generate.test.ts:323` already asserts.

**DONE.** Thresholds extended on both sides (client `XP_THRESHOLDS`, server mirror,
`server/test/levels.test.ts` length pin), and the board frozen. The five new thresholds are
40k/50k/62k/76k/95k steps — **placeholders**, marked as such in both files, carrying the
intended SHAPE (a step that keeps steepening) and a guessed magnitude. At 323,000 XP total
against ~1,666/day plus ~80,000 from tier first-clears they are very probably too slow; that
is the fitting step's problem, not the build's.

**Measured board income at the cap**, which the thresholds must be fitted against:

| source | per day |
|---|---|
| 3 dailies (unit 333 XP, weights sum to 3) | ~1,000 |
| weekly (2 slots × 7 units = 4,662/week) | ~666 |
| **total** | **~1,666 XP/day, ~11,700/week** |

So a 40,000-XP level is 3½ weeks on the board alone. The rest must come from the tier
ladder (below) and from purchases.

**Thresholds: OPEN.** Fit them once a target wall-clock per level is chosen. The inputs are
board income above, purchase XP, and ~40 tier first-clears.

### What the five levels unlock

One dual invasion per level at 46-49, each with its own ten-rung tier ladder. Level 50 is
reserved — a capstone fight, or the prestige on-ramp, or both. Also worth placing here:

- A crop at 46 / 48 / 50. The crop ladder currently stops at 45 (Heartichoke), which means
  the farm loop goes completely flat exactly where the new levels begin.
- The eight permanent unlocks (t5 and t10 of each invasion — see Part 2) are the level
  path's own permanent rewards, and the reason it is not strictly dominated by prestige.

---

## Part 2 — The tier ladder

Each dual invasion carries **ten tiers**. Beating tier N unlocks tier N+1; any unlocked
tier can be replayed at will. Tier 1 is a tutorial for that invasion's mechanic; tier 10
should need near-ideal play and a purpose-built roster.

The ten-rung shape has precedent in Epic Bosses (`0051_epic_boss_ten_rung_ladder.sql`,
+5% damage compounding per rung), but differs in one important way: that ladder is a
sequential run with a persistent HP pool, this one is a difficulty selector.

### Tiers add mechanics before they add multipliers

| rung | what changes |
|---|---|
| t1 | the invasion's core mechanic alone, gently timed |
| t2-3 | the second faction's special switches on |
| t4-5 | the boss's signature action (charge / drop / bubble) |
| t6-9 | timings tighten, stat profile scales |
| t10 | everything at once, at its tightest |

This is what makes t1 a tutorial and t10 a test of play rather than of gear — and it is
also why the existing p* harness cannot grade these ladders as they stand. A rung whose
difficulty is a timing window is invisible to a harness that never taps. See "The harness,
and what it cannot see".

### The hard constraint: four minutes

**CORRECTED 2026-09-21.** Earlier drafts of this section said a fight that outlives the cap
"cannot settle at all" and comes back `truncated_transcript`. That was wrong, and the error
ran through this document, `dualInvasion.ts`, `eliteInvasion.ts` and the memory. `BattleSim`
has always carried its own cap at the same instant, so a fight that runs the clock out
**ends, and the player loses** — a clean, settled, verified loss. `truncated_transcript` is
not reachable from an ordinary finish. What was genuinely missing was that nothing on screen
said the clock existed; that is fixed (see below), and `src/raid/timeLimit.test.ts` now pins
the whole thing, including the two constants that have to stay equal.

The fight clock ends every battle at four simulated minutes — `BattleSim.RAID_TIME_LIMIT_MS`
for the fight, `replay.RAID_MAX_TICKS` for the verifier's replay, the same instant declared
in two files that do not import each other. The player sees it counting down on the top bar,
and the result panel says OUT OF TIME rather than reporting a defeat that did not happen.

**It binds these designs exactly as hard as before**, for a different reason. A rung nobody
can finish inside the clock is not difficult, it is broken: the player is beaten by an
arithmetic they were never shown and cannot go faster than, having been winning the whole
way. Consequences that bind every design below:

- t10 difficulty comes from lethality, never from bulk.
- Every damage-suppression mechanic (the objection, a wall, a charge that must be interrupted)
  spends the same four-minute budget.
- Anything that multiplies the number of bodies on the field (the Circus copies, the
  stacks) needs a hard concurrent cap, and that cap is load-bearing, not cosmetic.

**The clock is now on screen** (owner call, 2026-09-21). The top-centre countdown used to be
the ENRAGE timer, which reads like a fight timer, runs out three minutes early and then
leaves the slot blank for the rest of the battle — so a player could be a minute from losing
a fight they were winning with nothing saying so. It shows the fight clock instead
(`⏱ 2:14`, amber under a minute, red under fifteen seconds), with enrage demoted to a suffix
that appears only inside its last twenty seconds and is dropped entirely on a cramped phone
HUD. `RaidOutcome.outOfTime` carries the reason out to the result panel, which reads OUT OF
TIME. Presentation and a derived flag — no simulation decision changes, so no ruleset bump.

One thing this deliberately leaves alone: a timeout's survivors are the whole standing army,
so the player loses the raid but keeps every zombie that was alive at the bell. That is the
most generous loss in the game, and whether it should stay that way is a BALANCE question,
not a correctness one — it is on the list for the pass, not fixed here.

### Rewards

These four are **the hardest content in the game** and their rewards should say so. Two
draws carry them: brains, and eight permanent unlocks.

**Brains, scaled by tier.** This is the repeatable draw. The shape:

| tier | brains on a win |
|---|---|
| t1-2 | the ordinary roll (~0.54 expected at this recommended level) |
| t3-4 | 1 guaranteed |
| t5-6 | 2 |
| t7-8 | 3 |
| t9-10 | 4-5 |

The ceiling worth knowing before these numbers are fixed: the invasion cooldown is **global**
(one `lastRaidAt`, not one per raid), so it is 12 invasions a day free, plus whatever a player
buys vouchers for at 2,000 gold each. A player who has genuinely solved t10 and runs nothing
else could take ~60 brains a day against maybe 3 today. That may be entirely fine — it is the
reward for the hardest content in the game and it is gated by actually being able to win —
but it should be a decision made with the number in view, and it should be set **after** the
harness rework says how hard t10 really is. If it needs a brake later, the honest one is to
pay the guaranteed portion only on the first win per tier per day, leaving the rolled drop
uncapped.

**Tier first-clears are also the 46-50 XP fuel.** 4 invasions × 10 tiers = 40 one-time
payments; at ~2,000 XP each that's ~80,000 XP, a real share of the new ladder, and
self-limiting. This is the reason the dailies can be frozen without the tail going dead. (A
fifth invasion at level 50, if that is what level 50 becomes, adds ten more.)

**Prize pairs.** The story ladder tops out at 2.0% ordinary / 4.5% elite
(`STORY_ZOMBIE_DROP_RATES`, `ELITE_PRIZE_RATE_CAP`). The four new raids need prize zombies
registered in `RAID_ZOMBIE_DROPS` — without one, that raid is also a hole in the dry-streak
pity system, which is per prize. Whether the rate ladder climbs past 2% is OPEN.

### The eight permanent unlocks

**Clearing t5 and t10 of each invasion grants a permanent, account-wide unlock — eight in
total.** What they are is OPEN; the leaning is towards substantial bonuses that make the whole
account stronger rather than cosmetics or one-off payouts.

Three constraints on whatever gets chosen:

1. **Decide which system owns permanent account-wide power first.** The prestige upgrade list
   is already exactly this — Master Ranks, More Zombies, Bigger Farm, Brain Fortune, Quick
   Feet, Quicker Invasions — and prestige is being reworked. Two systems granting permanent
   account power will fight over the same design space and the same numbers. A clean split is
   available: prestige owns **economy and convenience** (cooldowns, farm size, walk speed,
   drop rates), the tier ladders own **army capability** (what your army can *do* in a fight).
2. **Prefer capability that only cashes out in hard fights.** A flat stat bonus makes levels
   1-45 trivial for anyone who has these; an extra ability charge, an extra army slot, a
   per-fight revive or a sixth mutation slot only matter where the fight is tight.
3. **SUPERSEDED 2026-09-27 (owner): the tuning rule below is wrong.** t10 does NOT have to be
   tuned against an account holding none of the unlocks; it may lean on rewards from earlier
   tiers. Kept as the record. **Watch the self-reference.** If t10's unlock is what makes t10 of the next invasion
   approachable, the ladder tunes itself into a required order and the last one is balanced
   for a player who has all eight. Tune every tier against an account holding **none** of
   them, and let the unlocks be the cushion.

Candidate directions, for later argument, not decided: +1 to base army capacity; a revive
charge per fight; a sixth mutation slot or a second mutation in one slot; a shorter activated
ability cooldown; a species or mutation-tier unlock.

### Elite invasions do not overlap with tiers

**Brain Tickets are not accepted on these four invasions**, at least to begin with. A tier
ladder and an elite flag would be twenty configurations per raid, and four new elite profiles
would have to be fitted into headroom `eliteInvasion.ts` says is already spent ("a
measuring-stick army stops winning the Video Games not far above their elite figure"). The
tier IS the difficulty selector here.

### The cost of failing

A loss costs the ordinary two-hour cooldown, and a player in a hurry pays 2,000 gold for an
Invasion Voucher — no special retry rule, no cooldown exemption. This is deliberate and has a
second benefit: endgame gold currently has almost nowhere to go (purchases mostly convert it
to XP), so a hard tier that eats vouchers is a real sink pointed at exactly the players who
have the most gold.

One thing to watch once it is live: the top tiers are also a **brain** sink, because
**each revival costs 1 brain** (`hud.ts`, the revival panel). A failed t10 that loses six
zombies costs six brains to repair, against a win that pays four — a tier that is
net-negative to attempt is a tier nobody replays. Check the two numbers against each other
once the harness can say how often a good army actually loses.

---

## Part 2B — The tier ladders, redesigned (owner, 2026-09-26/27)

This part supersedes the tier dials in Part 3. What Part 3 describes is what is built today;
what follows is what the four fights are being rebuilt into.

### Goals

- **Decisions made during the fight win it.** These are not four more fights you can win without thinking.
- **No single army clears every t10.** Each fight's mechanics favour different builds.
- **t1 ≈ the ordinary Video Games invasion (raid 9). t5 is farmable. t10 is a push target**
  that needs a highly tuned army and may need rewards from earlier tiers.
- **Substantial first-clear rewards at t5 and t10** (e.g. Master+k veterancy, or another
  meaningful unlock); small first-clear rewards on the other tiers. Prestige now owns only the
  economy, so army power is the ladders' to give.

### One change per tier

| tier | kind |
|---|---|
| t1 | the fight's base mechanic |
| t2, t4, t6, t8 | a **stat** step: enemy damage or attack speed, never hit points (the four-minute clock owns bulk) |
| t3 | a new mechanic, or the base one strengthened |
| t5 | milestone: a new mechanic |
| t7 | a mechanic strengthened, or a new one |
| t9 | the mechanics made more severe |
| t10 | capstone |

The tier-select screen should show what each rung adds, so a player can bring the answer.
Hit points per rung and the transcript input cap are measured AFTER the build.

**The dual invasions run on a SIX-minute clock** (owner, 2026-09-27); every other fight keeps
four. Their mechanics run on 7-15 s timers and their key units carry most of the bulk, so
they need the room. A clock-out is still an ordinary, settled loss.

### 46 — Lawyers & Farmers: Rulings

Every 8 s the Lawyer offers two rulings in thought bubbles and the player taps the one they
will live with. Ignoring the offer lets a coin (pre-drawn from the session seed) decide.

| tier | change |
|---|---|
| t1 | **Rulings**: one ruling per bubble, drawn from the pool below |
| t2 | stat |
| t3 | **Contempt**: ignoring the offer applies BOTH bubbles (moved down from t7, 2026-09-27) |
| t4 | stat |
| t5 | Each bubble holds **two** rulings |
| t6 | stat |
| t7 | **The angry farmer mob** walks on at the midpoint: six farmhands, twice as tough (moved up from t3 and made harder, 2026-09-27) |
| t8 | stat |
| t9 | Rulings are more severe |
| t10 | **Precedent**: each ruling lasts two slots, so two are always in force |

The Lawyer is always the boss that descends.

**The ruling pool is deliberately small: every ruling must read as one icon.**

| ruling | effect | icon | hurts most |
|---|---|---|---|
| Slowed | ally attack speed down | down arrow by the speed symbol | fast attackers |
| Weakened | ally damage down | down arrow by the strength symbol | glass-cannon damage |
| Overruled: Bash/Smash | that ability disabled | X over its ability icon | tap-driven armies |
| Overruled: Explode | that ability disabled | X over its ability icon | tap-driven armies |
| Overruled: Mini Buddy | that ability disabled | X over its ability icon | tap-driven armies |
| Barred: (class), x6 | that class leaves the line | X over the class face (the existing bubble faces) | stacks of one class |
| Emboldened | enemies deal more damage | up arrow by the Lawyer | no tank / low health |
| Immunity | enemies cannot be stunned | X over the stun stars | stun-reliant armies |
| Order in Court | no healing | X over the heal icon | healer stacks |

**The design work is in the PAIRING:** the two bubbles offered should hurt DIFFERENT kinds of
army, so the right pick depends on what the player brought. Never offer two rulings that punish
the same build.

Constraints: a ruling that repeats or overlaps REFRESHES, it does not stack; a class is never
barred in two consecutive slots (under Precedent that would bench it for 16 s).

### 47 — Pirates & Ninjas: The Duel

| tier | change |
|---|---|
| t1 | **The captain** comes out at the fight's midpoint. A smoke bomb pushes the army back so he has room; the other enemies wait while he is fought. His large area attack must be stopped by filling a poise bar with stuns |
| t2 | stat |
| t3 | **Dex tax**: the ninja's throw speed scales with the total dex deployed |
| t4 | stat |
| t5 | **Counter**: the ninja boss reflects a stun back at the zombie that hit it, doubled |
| t6 | stat |
| t7 | The ninja's projectiles briefly stun on hit |
| t8 | stat |
| t9 | **Smoke swap**: while the captain is out, the two bosses trade places by smoke bomb every 8 s. At low health the ninja retreats up top, stops attacking, and cannot be killed until the rest of the enemies are |
| t10 | **Iron Will**: stopping the captain needs 1.5x the stun (first tuned at 3x, which no army broke), and the poise bar drains unless it keeps being filled, so the stuns must land together |

The smoke-bomb pushback must not throw healers at the rear station, or zombies still in the
deploy queue, off the lane.

OPEN: most stuns are passive procs (a Female's 5%) that a player cannot hold back, so t5's
reflection punishes them without offering a choice, and t3's dex tax falls hardest on the
Females who carry them. Consider reflecting only ACTIVATED stuns (Smash, the Mini ram,
Explode).

### 48 — Circus & Video Games: The Big Top

The ringmaster stands in the middle of the lane, BEHIND the army's front line: zombies that
have walked past him do not turn back. Reaching the middle is the problem, and the
counterplay is how you get there: deploy order (later zombies walk out through the middle and
stop to fight whatever stands there), the trapeze drop, and the pixel fire.

| tier | change |
|---|---|
| t1 | **The ringmaster** in the middle. His whip strikes the nearest zombie on his LEFT (the healer side); with nothing there, he whips the front line. The whip stuns **Garden zombies only**, and merely damages anything else. Its crack stuns the nearest Garden on his left within reach even when the lash lands on someone else — otherwise the healers at the back are never touched |
| t2 | stat |
| t3 | **The trapeze artist** grabs a zombie and swings with it. Tapping the artist drops the zombie wherever the swing is, so the player picks the position |
| t4 | stat |
| t5 | **Bozos**: once the ringmaster falls, the Video Games boss converts zombies into bozos, the stacking little men from the Circus fight. They stack in the middle and throw hammers, more the taller the stack. Knocking a bozo off frees your zombie. Cap 3 |
| t6 | stat |
| t7 | **Pixel fire**: a burning zombie walks BACK until it is put out; if it gets far enough it engages the ringmaster or the stack |
| t8 | stat |
| t9 | The bozo cap rises to **6** |
| t10 | **Conversion comes faster**: zombies are lost to the stack faster, so dealing with it becomes the fight |

Zombies still trapped as bozos when the fight ends COME HOME: they are not casualties. The
trapeze grab and the drop point must be simulated fight rules (today's Circus trapeze runs
only in the client); the drop tap is transcribed with its position. The stacks and trapeze
copies of Part 3 are dropped from this fight.

### 49 — Aliens & Robots: Interference

This fight does not punish one build. It is about the interrupt: which casts you cancel is
decided by your own army's weak points, and it favours damage, because enemies that live
longer cast more.

| tier | change |
|---|---|
| t1 | **The saucer** casts every **10 s**: walls, zombies portalled to the back, a summoned robot. The player has **3 cancels** for the whole fight (cut from 5, 2026-09-27), so cancelling everything runs you dry |
| t2 | stat |
| t3 | **Abductees** start appearing in the middle, as in the ordinary Alien fight |
| t4 | stat |
| t5 | **The giant McDonnell bot** appears at the back. It is a signal: from here the massive area hit and the full-army stun are in the cycle |
| t6 | stat |
| t7 | Casts come every **7 s** |
| t8 | stat |
| t9 | **Lockout**: a cancel cannot be used on two activations in a row |
| t10 | **Dual cast**: casts come in pairs and one cancel stops one of the pair (for the lockout, the pair is one activation) |

The giant bot is presentation only; its abilities are ordinary cycle actions in the sim.
Summoned robots need a cap (hit points outside the settle budget).

### Across all four

- **The harness pilots must learn every new decision** (rulings, stun dumping, the trapeze
  drop, cancels), or tuning t1/t5/t10 is guesswork.
- **The clock.** Midpoint phases, an unkillable-until-last ninja and summoned bodies add time
  or hit points. Cap every summon, and check that a strong army finishes with time to spare.

---

## Part 3 — The four invasions

Every one pairs two existing factions, reusing both rosters and one backdrop. The second
faction's boss appears as a **powerful minion**, not a second boss: the sim has one boss
slot per stage and one stage per fight, and a true second boss is a sim-wide change we are
deliberately not making yet.

### 46 — Farmers + Lawyers: the objection

**The mechanic.** The Lawyer boss files a motion to bar a zombie class from the field, and
**the player chooses which**. Two thought bubbles go up over the lawyer naming two different
classes; a tap picks the one that goes. The barred class goes sad: no advance, no attacks, no
activated or in-combat abilities. **If the player does not choose, the fight chooses**, from
a per-session coin. From tier 6 each bubble holds a **pair** of classes instead of one, and
the enemies are eased to compensate:

| pair | what it removes |
|---|---|
| Headless + Garden | the safety net — DPS stands in the open, no protect aura, no heals landing |
| Small + Large | burst — anything with a growth timer gets a free window |
| Regular + Female | damage — tanks and healers hold a line they cannot end |

**Why a choice and not a rotation.** The first draft named one class on a fixed rotation, and
that is a memory test: learn the order, bring a roster that survives it, and every fight after
the first plays the same. Two bubbles turn the same content into a decision the player makes
eleven times a fight, and the right answer moves with the field — the same offer is answered
differently with a wounded tank than with a healthy one, differently with the farmers inbound
than without them. **The offer order stays fixed and learnable**; what is not learnable is
what happens when you ignore it.

**The offer table.** Six offers below tier 6, three from it. Every class is on the table twice
per cycle, and no offer puts the same thing in both bubbles — a dilemma with one answer is not
a dilemma. The first three offers set a layer against itself (whichever you keep is the one
doing that job alone); the last three cross layers.

| # | bubble A | bubble B | the question |
|---|---|---|---|
| 1 | Headless | Garden | the body, or the healing on it |
| 2 | Small | Large | the fuse, or the weight behind it |
| 3 | Regular | Female | the volume, or the procs |
| 4 | Headless | Regular | who stands at the front, or who kills from it |
| 5 | Garden | Small | sustain, or the move you were saving |
| 6 | Large | Female | the anchor, or the stuns holding the flank |

From tier 6 the three layers are set against each other instead: safety net vs burst, burst vs
damage, damage vs safety net.

**Timing.** One dwell is one **slot** (5 s). During slot *s* the bubbles for offer *s* are up
and what is actually barred is the pick that resolved at the end of slot *s-1*. So the fight
opens with a free window and the first question already on screen, and from then on the player
is always **choosing one bar ahead while living with the last one**. That overlap is what
makes it a fight rather than a quiz: you answer the next question while the current answer is
still costing you.

**The farmer burst.** Periodically a squad emerges together — the Farmer boss plus three
farmhands — rather than the usual single walker. It is timed to land on the slot barred by
**the damage offer** (Regular vs Female).

That timing is mechanically load-bearing, not just thematic. Ten of the eleven raids have
no reinforcement drip, so `activeTarget` sits at 1: the field only refills when something
dies, and each death sets `ENEMY_EMERGE_GAP_MS = 450` before the next walks in. High DPS
therefore buys **dead air** — 450 ms at a time in which nothing is swinging at your tank.
Ban a damage class and the dead air thins; the squad arrives on top of a line that has lost
part of its ability to create gaps.

With the choice in place the squad no longer lands on a *known* hole — it lands on whichever
half of the damage the player decided they could do without, and the farmers are visibly
walking in **while the bubbles are still up**. The cost of the decision is on screen before
it is paid, which is the shape this fight should have everywhere.

**Sizing note.** At that moment the live army is missing one damage class, and at tier 6+ both.
Tune the squad against that subset, not against a full 16 — the margin is much thinner than
a whole-roster calculation suggests.

**What a sad zombie does.** It **drops its place in the line and walks slowly backwards** —
it does not stand where it was refusing to fight. That matters mechanically as well as
visually: the formation is the army array and a walker holds no place (`inLine`, ruleset 52),
so a barred front-row zombie that kept its slot would wall off everyone behind it and produce
exactly the stall this design exists to avoid. Retreating, it leaves a gap the rest file into,
and the class visibly walks out of the fight.

**It stops when the boss comes down.** Boss actions are perch-gated, so once the wave is
cleared and the Lawyer boss descends the bubbles end and the fight becomes a straight duel.
That is the intended finale — the pressure lifts exactly when the last enemy standing is the
one who was filing the motions — and at high tiers it means two classes rejoin at once for
the closing phase.

**Guardrails.**

- **The panel has to be readable at a glance**, because the decision is the fight. Three
  things on screen at all times: what is barred right now, the two bubbles, and how long is
  left to answer. A player who cannot see what they picked learns nothing from what happens
  to them five seconds later, so the chosen bubble stays lit until its slot ends.
- **The default must not be a strategy.** If the auto-pick were fixed per slot, ignoring the
  bubbles would itself be learnable and the mechanic would collapse back into the rotation it
  replaced. It is drawn per session instead (below), so not answering is a genuine coin.
- **Mind the stall.** A retreating zombie does not fight, so an army that is mostly one class
  stops dealing damage entirely while that class is barred. If it stops dealing damage while
  the enemy also cannot reach it, the fight runs to the four-minute cap and **cannot settle** —
  not a loss, a broken fight. That exact stalemate has happened here before: raid 6's saucer
  drew its laser target only from engaged zombies, and an all-healer army ran the cap with
  neither side able to touch the other (see the ruleset notes in `src/raid/replay.ts`). Two
  cheap guarantees, both worth having: a sad zombie that is caught still swings back, and the
  dwell is short enough that no single ban can span the cap. Note the choice makes this
  *better*, not worse — a mono-class army can now steer the ban away from itself, at the price
  of never getting to ban anything that matters.

**What it punishes.** Unmixed armies (they have no meaningful answer to give), health-mutation-poor
glass DPS, and — new with the choice — inattention.

**Implementation.**
- The sad state is the `pixelFire` panic machine (`SimUnit.burnMs` / `burnDir`): attacks and
  advance suppressed while a timer runs. Keep the suppression, replace the back-and-forth
  pace with a slow walk backwards, and release the unit's place in the line (`inLine`) on the
  way out. The trigger becomes the objection rather than the burn.
- The squad is `deployAtMs`, which PvP formation defenders already use to walk on at their
  own clock while ignoring the wave budget entirely.
- "No abilities" means the live ones only — heal, resurrect, laser, activated buttons.
  Self-buffs and type-targeted auras are folded in when CombatUnits are built
  (`src/zombie/abilities.ts`) and cannot be switched off mid-fight without a rebuild. Leave
  them; they are invisible anyway.
- **The pick is player input, so it is transcribed** (`signPick`, carrying the offer index and
  which bubble) exactly as a wall tap is, and the resolved picks ride the checkpoint snapshot.
  The auto-pick is **pre-drawn once at config time** from the raid session seed — the same
  seed the Robots' wave is drawn from — and pinned into the fight config, so neither side ever
  rolls anything mid-fight. See the v58 note in `src/raid/replay.ts`, including why a refused
  `signPick` is the one refusal in the transcript that is not one-way self-harm.
### 47 — Pirates + Ninjas: the charge and the dex tax

**The pirate boss as a ground unit.** He is authored `str 500, dex 0.4` — a 2.5 s cycle and
by far the biggest single blow in the game (the Robots' heaviest throw is 50). The
charge-up slam is not an invention; it is the presentation of his existing stat block.
He grows and reddens through the wind-up like a brute, and lands an area attack.

**Poise.** Stuns fill a bar instead of overwriting each other (today they take `Math.max`).
Fill it before the wind-up completes and the charge restarts:

| source | contribution |
|---|---|
| Female tier-3 proc (5% per swing, 1,000 ms) | 10% |
| Smash / bashV2 (10 s per-zombie cooldown) | 50% |
| Mini Buddy ram | 100% |
| Explode (one-use, suicide) | 100% |

**Threshold is a flat 100% at every tier. The tier dial is the charge TIME** (roughly
10 s at t1 down to 5 s at t10). This keeps one banked Explode or ram always sufficient for
one slam, while making the slams come faster than any army can answer them all — so the
question is which ones you stop, never whether you can.

Girl contribution checks out as a supplement rather than an answer: player interval is
`2.0 / dex` seconds, so a dex-4 girl swings every 0.5 s and a girl-heavy front line
generates ~0.4 procs/second — about 25-30% of the bar across a 7-second charge. Real,
never sufficient. Without poise it would be an off switch: six girls deny a 2.5 s charge
outright and forever under `Math.max` semantics.

**The ninja's scaling throws.** The perched Ninja boss throws at a rate derived from the
total attack speed of *deployed* zombies. It opens slow and ends as rapid fire. This is a
roster tax on `dex`, not a pacing decision — the player cannot hold a zombie back, since
`promote()` auto-charges the next whenever nobody is charging.

**What it punishes.** Dex stacking. Female averages 4.18 dex and Regular tops out at 8
entirely because of the Vagabond; Small is technically higher on average (4.74) but is
never brought in bulk. So the tax lands on exactly the two stack metas.

**Also present.** The ninja carrotWall (1,500 HP, 3 s cast), and the pirates' authored
speed-mirroring attacks.

**OPEN — long-term tuning.** The slam's damage needs a ceiling independent of the boss's
authored str 500, or one unstopped hit deletes the line at any tier.

### 48 — Circus + Video Games: the second line

**The premise.** Everything happens behind you. A line built for a one-sided fight is
suddenly the wrong way round.

**The wave** is video-game enemies, supported by a small tier-scaled number of **copies of
the zombies the player has deployed** — the zombie's own stats at a tier-scaled fraction of
its HP, in a different tint — dropped in by the trapeze *behind* the player's line, where
the tank isn't and the healer is.

**The stacks.** Up to three stacks, each growing to three tall while left alone.
`CircusStageActorMinion2` swings `MidgetStackAttack` and the ringmaster throws
`projectile_midget.png`, so the art is authentic. Model each stack as **one unit with a
height counter** whose stats scale with height, not as three units: three stacks at three
tall is nine bodies otherwise, on top of the wave, the copies and the boss, and the fight
still has to settle inside four minutes. One unit per stack also makes toppling readable —
burst knocks a level off.

**The ringmaster (t5+).** He drops from his car into the middle of the field, whipping the
front line when nobody is close enough and otherwise fighting as an ordinary unit placed
mid-lane. `BOSS_JUMP_MS = 650` already exists for exactly this descent.

**Tier dials** — all on the copies, none on the statline:

| | t1 | t5 | t10 |
|---|---|---|---|
| copies alive at once | 1 | 2 | 4 |
| copy HP | ~60% | ~80% | 100% |
| copy keeps mutations | no | yes | yes |
| copy keeps passive abilities | no | no | yes |

**Copies never hold activated abilities**, at any tier. PvP already fields player zombies as
enemies — *"a defender zombie is just an enemy-team CombatUnit"* (`src/raid/pvp.ts`) — and
strips the tap moves because a defender cannot tap. So the top-tier dial is the **self/passive**
set only: Laser Beam, ZomBeam, Block, Double Strike, Turbo. Bash, Smash, Explode and Mini
Buddy would need an AI tapper and are out of scope.

**Counterplay, and what it punishes.** The back line cannot be reached by walking without
abandoning the front, so the fight asks for **lasers** (Regular t3/t4 and Dr. Zombie fire
from the support station) and **burst** to topple stacks before they top out. Both are
things the two-healers-two-tanks-twelve-Vagabonds meta never brings.

**Implementation.**
- Mid-field placement is `stationX`/`stationY` from the PvP formation work.
- **`refreshFrontLine()` re-derives the army's stopping line from the front-most authored
  station.** Anything dropped mid-field drags the whole line up to meet it, which means
  "nobody is close enough, so he whips" can never fire. A **no-anchor flag** is required;
  one flag covers stacks, copies and the ringmaster.
- Copy tint is free: `CombatUnit.color` already exists and is already carried on both sides.

**OPEN.** Copies created per deployment (you choose what to feed it, since you control the
queue order) or on a timer (it picks your best)? Per-deployment is the better game.

### 49 — Robots + Aliens: the bubble

The hardest of the four. A thought bubble appears over the UFO with a charging bar and an
icon naming what is coming. The player holds a **limited number of cancels**, fewer at
higher tiers, and must decide which disasters to stop and which to eat.

**The five actions.**

| action | threat | who it punishes |
|---|---|---|
| Place a powerful wall | splits the line; 1,500 HP authored, 3 s cast | low burst |
| Area-of-effect attack | chunks the whole army at once | low HP / glass DPS |
| Beefier enemy | **replaces** the next queued alien with a much tougher one | low DPS |
| Stun all zombies | a free window for whatever else is standing | anyone, situationally |
| Portal (t-high) | teleports half the army to the back of the lane | anyone, and it makes the wall matter again |

**Abduction runs as authored, alongside the bubble.** The alien boss's `summonBoss` keeps
its normal behaviour — an abducted human popped off the rota and landed as a standing
mid-lane blocker — but positioned **immediately enemy-side of the wall** rather than at the
authored `SUMMON_SPAWN_X = 448`.

Worth being precise about what that does, because the wall's position is counter-intuitive:
a wall materializes at `supportX`, which is *halfway between the staging slot and the front
line* — inside the player's own half. It does not bar the front line, which has already
passed it; it cuts **reinforcements** off from the fight. So wall + abductee is a
double-thick roadblock across the player's own lane, and the trio with the portal is the
fight's signature play: half the army is thrown back to the staging slot, then walled in
behind two blockers, while the front half fights alone.

The beefy enemy is a **queue swap, not a summon**: it walks in from the right behind the
normal alien line, adds no body to the field, and so cannot stall the boss descent or blow
the settle budget. It punishes low DPS specifically, because a tough body keeps the field
occupied and denies the 450 ms emerge gaps that let a tank breathe — the mirror image of
the AoE, which punishes low HP. Two orthogonal threats from one bubble set.

**The actions come in a fixed order, identical every fight** — the same principle as the
sign, and the same expectation that players learn it. It also costs no RNG at all, so the
bubble adds nothing to the replay's random stream.

The trade is that *which* action to cancel can be worked out before the fight rather than
during it. Two things keep the decision live anyway, and both need holding onto:

- **The cancel budget forces a different subset each run.** With fewer charges than actions,
  a fixed order does not produce a fixed answer — it produces a fixed *menu*, and which
  items you can afford depends on how the fight has gone.
- **The fight state at each occurrence varies** even when the order does not (see below).

Place the queue-swap action where the wave queue is guaranteed non-empty — never last in
the cycle — so a cancel is never spent on an action that would have fizzled.

**Make the threat depend on fight state, not just army type.** Otherwise a tank army always
cancels the wall and a DPS army always cancels the AoE, and the decision is made at
roster-build time then executed on autopilot. Overlap is the fix: the AoE is survivable
*unless* the last swap cost you a healer; the wall is trivial *unless* the portal just split
you; stun-all is nothing *unless* a wall is standing when it lands.

**Give the cancels a loop, not just a countdown.** Fewer charges at higher tiers is the
right dial, but a pure budget means "spend everything early and endure". Killed robots drop
a recharge pickup — the in-fight brain pickup already does this job, tapping and all.

**Tier dials.** Cancel charges; cast length (the reaction window); how many casts overlap;
whether a cancelled cast re-queues immediately or goes on cooldown.

---

## Part 4 — Engineering

### Determinism

Every mechanic above changes the fight, which means:

1. `src/raid/BattleSim.ts` and `server/src/raidVerifier.ts` implement it identically.
2. `RAID_RULESET_VERSION` is bumped in the same commit (`src/raid/replay.ts`).
3. **The Worker deploys first.** It bundles the client sim from the working tree, so a
   dirty tree or a client-first deploy means a ruleset mismatch and a 426 for every player.
4. Elite profiles are re-measured; `eliteInvasion.balance.test.ts` goes red on any mechanic
   change and the fix is to move the profile, not the threshold.

### Seven specific hazards found while speccing this

1. **`passedWall` is a single boolean per unit**, latched when a wall spawns for zombies
   already beyond it. The portal must **clear it on teleport**, or the teleported half walks
   straight through the standing wall — the exact combination the portal exists to create.
   There is a precedent to copy rather than a new rule to invent: a revived zombie already
   re-earns `passedWall` because it comes back at `CHARGE_X` behind anything mid-lane, and
   the ruleset note in `src/raid/replay.ts` explains why the latch surviving was a bug. Any
   backwards teleport is the same case.
2. **`wallInWay()` picks the first blocker in ARRAY order, not the nearest.** It is a
   `.find()` over `isWall || isSummon` with no sort by x. No shipped raid has two blockers
   at once, so it has never mattered; Robots + Aliens deliberately has a wall and an
   abductee standing together, and a zombie between them can target the far one and ignore
   the near one. Sort by x before this fight ships. The shared `passedWall` boolean has the
   same root: it must become per-blocker (an id set, or the furthest x passed).
3. **`isSummon` conflates two ideas** — off the wave budget, and is a blocker. The
   converted pixel zombie already needed hand-excluding from the blocker path. Split it
   into `offBudget` and `isBlocker`. (The queue swap sidesteps this for the beefy enemy
   specifically, which is one reason that version is better.)
4. **`refreshFrontLine()` drags the army to any authored station.** Mid-field spawns need a
   no-anchor flag or the "nobody is close enough" branch is unreachable.
5. **`ENEMY_EMERGE_GAP_MS = 450` is the mechanism** behind the Farmers + Lawyers burst
   timing and the beefy-enemy threat. Do not "optimise" it away.
6. **A fight-granted button needs no transcript change.** Replay inputs are
   `bubble` / `ability` / `wallTap` / `retreat`, and `ability` is keyed by an arbitrary
   string, so the bubble cancel can ride the existing `ability` input under a reserved key.
7. **The wave queue is concrete before the fight starts.** `weightedPopulation()` allocates
   it and a seeded shuffle orders it, so swapping the next queued template consumes no RNG
   and cannot desync a replay.

### The settle budget, restated

Copies, stacks, squads and swapped-in heavies all compete for the same four minutes. Every
concurrency cap in this document is there to keep fights FINISHABLE, not merely fair — a
rung that runs the clock out is a loss the player could not have played around.

---

## Part 5 — Prestige interaction

**ON HOLD.** Prestige is being reworked, so nothing below is a live constraint and none of
these invasions should be balanced around a prestiged account. Kept as a list of what the cap
raise does to the *existing* guide, to be revisited once the rework has a shape. The one item
that outlives any rework is the ownership question in Part 2: prestige and the tier unlocks
must not both be handing out permanent account-wide power.

The player guide predates the cap raise. Three deltas:

1. **The award table extends to 50** (11…15 points). Consider scaling the award off levels
   climbed past 40 rather than a fixed table, since "waiting pays" now means waiting twice
   as long.
2. **The bound-until threshold.** The guide says a flat level 40; the newer intent is "the
   level you reset at". With a 50 cap these diverge sharply. The reset-level version is
   self-balancing and makes an early reset genuinely cheaper on both axes.
3. **The faucets a reset re-opens**, each needing a deliberate yes or no: invasion win
   counts rebuild, so first-clear brains pay again (~17 brains a run across 11 raids); quest
   gold and items pay again; and every level-up zeroes the invasion cooldown
   (`GameState.ts:309`), so an early prestige run is effectively cooldown-free.

**Also unresolved:** PvP defense is validated against `roster_v3` at every snapshot, so
vaulting the army leaves a prestiger defending with an auto-snapshot of nothing — free wins
for their friends. The best fix is also the best flavour: the old army stays on as the
farm's defense while its owner rebuilds.

---

## Sequencing

1. **Build the four invasions** — mechanics, not numbers. Tier profiles ship as
   placeholders.
2. **Rebuild the difficulty harness.**
3. **Fit the tier profiles**, then set rewards against what t5 and t10 actually cost.

Rewards are deliberately last: what a fight should pay cannot be decided before anyone knows
what it takes to win. The brain ladder and the eight unlocks in Part 2 are drafts held open
for step 3.

The cost of this order is that three of the four fights are being built without a way to
measure them (see below), so **do not hand-tune numbers during the build** — they will all be
re-derived. Build the mechanic, give the tier ladder a flat placeholder profile, and move on.

### The build, in order

**Stage 0 — the spine.** Nothing raid-specific; everything below depends on it.

- The sim fixes from Part 4: sort blockers by x, make `passedWall` per-blocker, split
  `isSummon` into `offBudget` + `isBlocker`, add the no-anchor flag for mid-field stations.
- `tierProfile(raidId, tier)` — a shared module in the same role as `eliteProfile`, called by
  both the client and the Worker's verifier, deriving the whole fight config from
  `(raidId, tier)` and nothing else.
- Tier carried on the raid session and pinned server-side exactly as the elite flag is.
- Tier unlock state, server-owned, alongside invasion win counts.
- Catalog: four `raids.json` entries at unlock levels 46-49 with their mixed weighted waves,
  backdrops and boss action lists; `REPEAT_INVASION_XP` entries above 140 (the table is
  monotonic by unlock level and a test holds it); prizes in `RAID_ZOMBIE_DROPS` so the dry
  pity has no hole; loot tables.
- Tier selection in the invasion panel.

**DONE so far in Stage 0**, beyond the sim spine above:

- **The level cap is 50.** Thresholds extended on both sides, board frozen at the level-44
  step (see Part 1), `server/test/levels.test.ts` length pin updated.
- **The four raids exist**: ids **12-15** at levels 46-49, generated by a new reimpl-only
  `DUAL_INVASIONS` table in `tools/prep_raids.py` that COMPOSES them from two shipped raids
  apiece. Each takes its stage faction's backdrop, boss, portrait, icon, music, throw speed,
  hazards and loot verbatim, and mixes the guest faction's minions into the wave:

  | id | invasion | staged as | inherits | guest minions |
  |---|---|---|---|---|
  | 12 | Lawyers & Farmers | City | grab (the cars) | farmhand, lumberjack |
  | 13 | Ninjas & Pirates | Ninja | the carrot wall | scallywag, swashbuckler |
  | 14 | Circus & Video Games | Circus | grab (the trapeze) | knight, ghost, monster |
  | 15 | Aliens & Robots | Alien | summon, laser | Bro-Bot, Junk-Bot, Brain-Bot |

  Verified: the eleven shipped raids regenerate byte-identically, and `enemy_stats.json` and
  `attacks.json` are unchanged because every unit in the mixes was already referenced.
- **`src/raid/dualInvasion.ts`** — `DUAL_INVASION_IDS`, `isDualInvasion`,
  `acceptsBrainTicket`, `MAX_TIER`, `clampTier` and a PLACEHOLDER `tierProfile(raidId, tier)`
  in `EliteProfile`'s shape, so the throw/special/wall builders can take either.
- **"Playable" and "takes a Brain Ticket" are now different questions.** Six suites asserted
  an elite profile for every playable raid; they ask `acceptsBrainTicket` instead of being
  loosened. Server catalogs regenerated with `npm run catalogs`.

- **Tier selection, end to end.** Migration 0058 adds `raid_state_v3.tier_json`
  (`{"<raidId>": highest tier CLEARED}`); `/raid/start` takes a `tier`, validates it against
  that map, and PINS it on the session; `/raid/finish` credits the PINNED tier on a win, and
  only upwards. The client mirrors the map like `raidsCompleted` (`syncRaidTiers`), persists
  it offline in the save, and the army screen grows a rung picker — cleared rungs plus the
  next one selectable, the rest padlocked, opening on the highest reached.

  The tier gate sits **beside the level gate and before the cooldown**, deliberately: an
  unclimbed rung is a statement about progression, true whatever the clock says. An
  integration test caught the original ordering answering `cooldown` to a player asking for
  a tier they had not unlocked.

  **Every rung currently builds an identical fight.** `tierProfile` is flat, so picking tier
  7 changes what a win credits, not what you fight. That is the agreed shape for now — the
  mechanics and their per-rung schedule come first, the profiles are fitted last.
- **The Brain Ticket refusal is a rule, not a hidden button.** `RaidManager.beginRaid` forces
  `elite` off for a dual invasion and spends no ticket (the one choke point both builds share,
  which is what covers offline); `/raid/start` answers `elite_unavailable` before the wave is
  pinned or any inventory is touched; the army screen, the card advice, the brain-odds line
  and the cooldown-skip branch all stop offering it; and the Raid Lab's Elite toggle is gated
  so it cannot show a fight the game can never serve.

Verified in a running build: the picker renders 1-4 live with 5 selected and six padlocked at
a ladder position of 4; asking `beginRaid` for an elite dual returns `elite:false` with zero
tickets spent while the Aliens still go elite and spend one; and a requested tier of 99 clamps
to the unlocked rung. Server rules pinned by `server/test/integration/dualInvasion.spec.ts`.

Still to do in Stage 0: nothing — Stage 1 (the objection) is next.

**p\* is not a gate for any of this work** (owner, 2026-09-18). The harness is known to be
inadequate and is being rebuilt after the raids are built, so `eliteInvasion.balance.test.ts`
going red is information, not a blocker: note it and keep moving. The work is theory first,
then play-testing, then a new and more comprehensive way of measuring difficulty.

That said, Stage 0 specifically *should* leave it alone, because every fix in it is latent: no
shipped raid fields two blockers, and no PvE fight authors a station. If the spine moves an
existing measurement, the spine changed behaviour it was not supposed to.

**DONE — raid ruleset 55.** All four sim fixes landed together; the full raid suite (722 tests,
elite balance measurements included) is unmoved, and client + server typecheck clean.

- `isBlocker` splits the GEOMETRY half of `isSummon` out from the BUDGET half, so a blocker no
  longer has to be identified as "a summon that is not a turned zombie".
- `wallInWay` takes the NEAREST blocker ahead instead of the first in array order.
- `passedWall` becomes `passedBlockers`, a per-blocker id list, cleared on any backwards carry.
- `anchorsLine` (default true) lets a mid-lane hazard decline to pull the army's line forward.

The bump is for the SNAPSHOT shape rather than for any behaviour change. Remaining in Stage 0:
`tierProfile`, session/unlock plumbing, the four catalog entries, and tier selection in the
panel.

**Stage 1 — 46 Farmers + Lawyers.** The simplest mechanic set (the bar reuses the existing
panic state plus a retreat walk; the squad is `deployAtMs`), no new blocker semantics, and the
one fight the current harness can still measure. It exists to prove the spine end to end:
build it, settle a real replay through the Worker, then move on.

> **THE OBJECTION IS DONE — raid ruleset 58** (it shipped at 56 as a fixed placard and was
> reworked into a CHOICE at 58; the design section above is the current shape).
> `signFor(raidId, tier, seed)` in `dualInvasion.ts` owns the offers: six two-bubble offers
> below `PAIRED_SIGN_TIER` naming one class each, three pair-vs-pair offers at or above it,
> 5 s a slot. The player taps a bubble to choose which class goes; the pick lands at the NEXT
> slot, so they are always choosing one bar ahead while living with the last one. In the sim,
> a barred class stops attacking, gives up its place in the line (`inLine`) and walks
> backwards at 70 px/s, bounded at the staging slot; its heals, revives and activated buttons
> stop with it; and the whole thing ends when the boss leaves its perch.
>
> **NOT CHOOSING STILL COSTS.** Each slot has a pre-drawn auto-pick — one coin per slot,
> `SIGN_MAX_SLOTS` of them, drawn from the raid session seed at config time and pinned. Per
> session rather than per slot-index on purpose: a fixed default would be learnable, and
> ignoring the bubbles would quietly become a strategy, which is the rotation this replaced.
>
> **DETERMINISM.** The pick is the first thing in raid 12 the two simulations cannot derive
> independently, so it is transcribed as `signPick` (offer index + bubble) exactly as a wall
> tap is, and `signResolved` / `signPending` ride the checkpoint snapshot. Nothing is rolled
> during the fight. See the v58 note in `src/raid/replay.ts` for the one genuinely new
> hazard: a refused `signPick` is the only refusal in the transcript that is not one-way
> self-harm. It is dropped anyway, and the note says why that is safe here.
>
> Pinned by `src/raid/sign.test.ts` (20 tests) and watched in the Raid Lab: tapping a bubble
> records `{type:"signPick", offer, option}`, the panel lights the chosen bubble and dims the
> other, and at the slot boundary exactly that class is barred and walks back at 70 px/s.
>
> **THE SQUAD IS DONE.** `farmerSquadFor` appends Old McDonnell and three farmhands to the
> wave on one shared `deployAtMs`, so they walk on together, off the drip budget, built as
> ordinary units because the lawyer holds the boss slot. The moment is DERIVED from the
> offers (`farmerSquadAtMs` = the slot barred by the first offer that puts a damage class on
> the table), so the singles and paired tables each get the right beat without a second
> table — 15 s low down, 10 s at the paired rungs. Appended identically by the client, the
> verifier and the Raid Lab. Since the rework the squad lands while the damage question is
> still on screen, which is better than the fixed version: the player watches the price of
> the choice walk in before they pay it.
>
> **ONE squad, and the reason is the settle cap.** A squad member waiting on its
> `deployAtMs` is alive and queued, which counts toward `normalsLeft` and so holds the boss
> on its perch: the fight cannot end before the last squad has walked on. Three squads
> across the rotation would put an ~80 s floor under every fight on a four-minute budget.
> If more are ever wanted, that floor is the thing to solve first.
>
> **THE PANEL IS DONE** — under the top HUD: a line reading `⚖ BARRED: Garden` (or
> `⚖ OBJECTION — CHOOSE ONE` in the opening window), the two tappable bubbles, and a
> countdown bar that reddens under 30%. **The bubbles show FACES, not words** (owner,
> 2026-09-19): each names its class with the head of that class's GREEN zombie — the starter
> everybody owns and recognises — and Headless shows its BODY, because it has no head. That
> is not a special case bolted on: `ZombieActorHeadlessTier1` simply has no parts in the
> `head` group, and a decapitated torso is exactly how the class reads on the field anyway.
> Two faces per bubble from the paired rung. See `src/raid/signIcon.ts`; the data premises
> are pinned by `signIcon.test.ts`, which is the only thing that would notice if a re-export
> ever gave the Headless rig a head and turned its icon into an empty box.
>
> The six read apart on feature AND size at once, which is what makes them legible at 38
> pixels: the gnome hat, the hair, the heavy brows, the brute brow and jaw — and Regular,
> which has no distinguishing part at all, is told apart by scale. So the icons keep their
> rigs' RELATIVE sizes rather than each filling the box: a Small that rendered as big as a
> Large would be a worse icon than the word "Small". The `⚖ BARRED:` status line above them
> stays in words on purpose — it is the readout, not the choice, and it keeps the class
> names somewhere the player can learn them. It sits at `topHudHeight + 4` because 22 px under the
> countdown landed it on the enemy's name label. A barred zombie also TURNS ITS BACK
> (`zombieFacingDelta`'s `benched` case): the walk-off moves `x` directly rather than through
> `vx`, so without it the zombie slid backwards still squared up, which reads as a knockback
> rather than as walking out.
>
> One trap worth keeping: **a bare Pixi Container has no hit area.** The first cut of the
> panel drew correctly and took no taps at all, because a `static` Container is hit-tested
> against its `hitArea` and otherwise only recurses into interactive children — and a `bg`
> Graphics left at the default `passive` is not one. The bubbles carry an explicit
> `Rectangle` now.
>
> **Still outstanding: the ART.** The panel is drawn boxes and text, not thought bubbles over
> the lawyer, and there is no sad pose — the zombie walks off in its ordinary walk cycle.
> Both are on the art list, and the fight is legible without them.

**Stage 2 — 47 Pirates + Ninjas.** Poise bar, the charge action, and the throw rate derived
from deployed dex.

> **DONE — raid ruleset 57.** The captain arrives at 3 s on his own `deployAtMs` and winds
> up a slam that lands on the whole deployed line. Stuns aimed at him mid-wind-up do not
> freeze him: they fill a POISE bar per source (Female proc 10%, Smash 50%, ram or fuse
> 100%), and filling it costs him the wind-up plus a rest. The rung dials the wind-up TIME
> (10 s → 5 s), never the bar, so one banked one-use move is always enough for one slam.
> He swells 22% and reddens to `#ff563f` as it fills — the colour and the size are the timer.
>
> The dex tax re-derives the ninja's throw interval from the army's total attack speed at
> every throw, halving it around 32 equivalent dex and flooring at a quarter of the authored
> interval so a maxed line cannot drive it to nothing.
>
> Pinned by `src/raid/charge.test.ts` (10 tests) and watched in the lab. Three things worth
> knowing:
>
> - **`stunEnemy` is now the ONE way the player's side stuns anything.** Every source routes
>   through it — activated moves, the ram, the Female proc — because poise has to intercept
>   each one at the value that source is worth. With no charge running it is the same
>   `Math.max` it always was.
> - **He needs his own arrival clock**, and for a sharper reason than the farmer squad:
>   appended to the wave he sat at the back of a ten-deep queue that releases one body at a
>   time, so the fight's centrepiece would not have appeared until everything else was dead.
> - **The tell lives in the ENEMY render branch.** The first cut put it in the zombie-rig
>   path, where it silently never ran: the captain is an enemy and never reaches that code.

**Stage 3 — 48 Circus + Video Games.** Copies through the PvP zombie-as-enemy path, the stack
as one unit with a height counter, the mid-field ringmaster on a no-anchor station.

> **DONE — raid ruleset 60.** All three, in `src/raid/dualInvasion.ts` (the rules),
> `BattleSim.spawnCopy` / `stepStacks` (the sim) and `fightConfig.circusStacksFor` (the
> towers). Pinned by `src/raid/secondLine.test.ts` (14 tests).
>
> **THE COPIES are dropped per DEPLOYMENT**, which is the game of it: the queue order is
> the player's, so they choose what the circus gets to copy. It is the first thing in the
> sim that makes a unit out of one of the PLAYER's, and it stays deterministic the ordinary
> way — release order is sim state driven by `promote` and by focus-bubble taps, and those
> taps are transcribed, so both sides copy the same zombie on the same tick.
>
> **A copy is a BLOCKER, and that is the mechanic rather than an implementation detail.** A
> zombie swings at whatever is nearest in x, from wherever it is standing — so an ordinary
> enemy dropped in the rear would simply be shot down from the line at no positional cost
> and the whole thing would be free. `passedBlockers` means the existing line ignores it and
> the reinforcements behind it have to cut through, which is exactly "the back line cannot
> be reached without abandoning the front". It also puts copies outside the win condition,
> which they had to be: a copy nobody can reach is the orphaned-wall stall from ruleset 59.
>
> **The plan's fourth dial, "copy keeps mutations", is gone.** A copy is cloned from the
> BUILT unit because that is the only thing the sim has — `SimUnit` is flattened to
> damage / maxHp / cooldownMs with the species stats, the level ramp, the farmer multipliers
> and the mutations already folded in, and there is no way back to the parts. A copy is
> therefore exactly as strong as what it copied and cannot be anything else. Three dials
> remain (how many, how much life, whether it keeps its passives) and they carry the ladder.
>
> **THE STACKS derive their height from their hit points**, which is the whole trick: a
> tower carries one pool per level it has climbed and fights at however many are still
> standing, so a hit worth a pool topples a level and the thing weakens as it comes apart,
> with no second state machine. Measured in the lab: 6 topples across 3 towers in one win.
>
> **THE RINGMASTER drops on a clock from rung 5** onto a mid-lane station with `anchorsLine`
> false — the first `bossDropAtMs` / `bossGroundStationX` in the game. Verified landing at
> x 640 with his wave still standing.
>
> Three things this cost that are worth keeping written down:
>
> 1. **The trapeze needs a LINE to drop behind.** The first cut copied on the very first
>    deployment, when nobody is past the drop point — so the copy walled the whole army into
>    its own staging area and the lead zombie parked at x 370 and never reached the front.
>    The gate is now "has anybody marched past the drop point", not a delay: a delay is a
>    guess about army size (twenty zombies take a minute to file out, two are gone in seven
>    seconds) and the condition is what was actually meant.
> 2. **`u.damage` is not an integer.** The stack's height multiplier was applied
>    unconditionally with a `Math.round`, which moved a burn total in raid 9 by one point.
>    It is guarded on BEING a stack now, and the pixelFire test is what caught it.
> 3. **The Circus boss's jump hard-coded the doorway** as its landing spot, so the ringmaster
>    dropped early and then stood at x 940 with a station of 640. It lands on `holdXOf` now —
>    identical for raid 8, which has no station.
>
> **Still outstanding:** a stack does not LOOK three midgets tall (`stackToppleSeq` is
> published for a topple animation that does not exist yet), and a copy is tinted rather
> than drawn as a mirror.

**Stage 4 — 49 Robots + Aliens.** The bubble, the cancel on a reserved ability key, the five
actions, and abduction repositioned beside the wall.

> **DONE — raid ruleset 61.** The cycle, the cancels and all five actions, in
> `dualInvasion.bubbleFor` (the rules) and `BattleSim.stepBubble` / `fireBubble` (the sim).
> Pinned by `src/raid/bubble.test.ts` (15 tests).
>
> **THE WAVE WAS RE-COMPOSED FIRST**, because it had to be. It cloned the alien stage's
> twenty-strong table WITH the robots in it, and a BroBot is con 350 against an alien
> minion's 60 — a 409,000-point fight, four times the settle budget, which the ladder was
> dividing by six just to keep finishable. The aliens are the wave now (ten of them) and the
> robots send ONE heavy on its own clock, the same shape raids 12 and 13 use. Base is 91,000
> and the rung scales UP from there instead of down.
>
> **A cancel buys tempo, not the action.** The saucer goes quiet for `cancelRecoveryMs` and
> then moves on to the NEXT thing in the cycle, so a cancel is worth most at the bottom of
> the ladder (9 s of silence) and least at the top (2 s). The budget is always at least one
> short of the cycle — that is what makes a fixed order a menu rather than an answer, and
> `bubble.test.ts` caught the straight ramp handing tier 1 four cancels for four actions,
> which would have let the player switch the mechanic off entirely.
>
> **The queue swap takes its hit points OUT OF THE QUEUE.** It was written as a multiplier
> first, and four swaps took a 130,003-point tier-10 fight to 254,827 — the fight hung at
> 240 s in the Raid Lab with the army still alive. The saucer now feeds the aliens still
> waiting at the doorway into the one at the front of it: total weight unchanged, one body
> much worse, and self-limiting because a late swap has little left to take.
>
> **Abduction stays and lands beside the wall**, so the two are one double-thick roadblock
> across the player's own lane. `summonConfigFor` is extended past raid 6 for the first
> time, and the sim keys the re-homing on the fight HAVING a bubble wall rather than on a
> raid id — the repositioning exists because of that wall.
>
> **Still outstanding:** the thought-bubble art and the five action icons (the panel is
> words: "☄ PORTAL incoming"), and the killed-robot recharge pickup from the plan, which
> needs a tappable pickup entity the sim does not have.

**A STALL RAID 15 MAKES EASY TO REACH, and did not cause.** When every surviving zombie is a
Garden, the fight can hang: healers hold `GARDEN_STATION_X` out of the combat zone, so four
of them stood at x 250 from second 120 to the four-minute cap while twelve enemies stood at
the doorway — neither side able to touch the other, and a `truncated_transcript` rather than
a loss. This is the raid-6 all-healer stalemate from ruleset 40 reached by a different road,
and the Brick roster reaches it reliably because its healers outlive everything else.

The obvious fix — let a Garden take an ordinary formation slot once every survivor is a
Garden — was written, measured and REVERTED: it walks the last medic into a blocker, and
`stepResurrect` refuses a healer with a wall in its way, so the army loses the revives that
were its way back (`alienStage.test.ts` catches exactly that). The answer is more likely in
how `wallInWay` treats a stationed healer than in the formation. It wants a measurement
behind it, so it belongs to the balance pass rather than to the end of a build.

**Build and PLAY them in the Raid Lab.** `/raid-lab.html` (`src/devtools/raidLab.ts`) drives
the real `RaidScene` with a hand-made fight config, which is the only sane way to watch one
boss action fire over and over. Every mechanic here is a boss action or an enemy state, so all
of them are lab-shaped. Mind its single-copy rule for `fightConfig`.

It also plays these four properly. Picking a dual invasion snaps the Level slider to that
raid's own level and opens a **Rung** strip (t1-t10) with no padlocks — the lab is not an
account, so every rung is available. The rung feeds `signFor` and `pirateCaptainFor` exactly
as `RaidManager` feeds them, so the strip moves the real fight: which classes the lawyer puts
in a bubble, the captain's wind-up (10.0 s at t1 -> 7.8 s at t5 -> 5.0 s at t10), and since
ruleset 59 the enemies themselves. The note under the strip prints both halves — the mechanic
in words and the rung's total enemy hit points and damage multiplier — because the numbers are
the half you cannot read off the field, and the HP figure is the one to watch against the
settle cap.

Four **endgame rosters** sit under the Army panel, and unlike the animation presets above them
they are what an account at this level really fields: a full army of the best ordinary species,
every ability tier unlocked, and the lab's blanket ability grant CLEARED, so each zombie
carries only what it actually has.

| roster | what it is | what it is for |
|---|---|---|
| Meta stack | 2 Garden, 2 Headless, 12 dex-8 Vagabonds | the stack these invasions exist to break, and the heaviest sky raid 13 can be asked for |
| Balanced 20 | all six classes | the only roster with a real answer to every bubble; the baseline the others are read against |
| Glass | 10 Regular, 10 Female | no tank, no heals — every bubble costs it something it cannot spare |
| Brick | 6 Headless, 6 Large, 4 Garden, 4 Small | bodies and sustain with almost nothing that ENDS anything; watch the settle cap |

A **Best-in-slot mutations** toggle rides on top of whichever roster is loaded, so any
line-up can be read with and without it. It gives every zombie the strongest legal mutation
in every slot, chosen per species by maximising the Strength Ladder (`str x dex x con`) over
an exhaustive search of the 144 legal combinations (`src/devtools/bestMutations.ts`). Nothing
in the game hands a player a maxed mask — it is there so a rung can be asked the question at
the CEILING rather than only against the unmutated line the presets field.

**Two findings from turning it on, both for the tuning pass rather than now.**

*Mutations are not a build decision, and they are almost entirely dex.* The exhaustive
per-zombie search returns the SAME answer for everything with a head — Coffeehead, Eyebiscus,
Dragon-arm, Heartichoke, Flytrap — and only the Headless differs (Pumpking in place of the two
slots it hasn't got). Dex is the scarcest stat in the catalog and the one every zombie has
least of, so a couple of points is the largest proportional gain available to anything and the
same two mutations win everywhere. The effect is not small: a Zombarian's swing goes from
1,231 ms to **356 ms**, and a Balanced 20's total hit points from 38,268 to 56,268.

*So the ladder's ceiling is set against the wrong roster.* Tier 10 is past all four presets
unmutated — and falls to all four with best-in-slot on:

| roster | t10 unmutated | t10 best-in-slot |
|---|---|---|
| Meta stack | LOSS, 75 s | WIN 10/16, 54 s |
| Balanced 20 | LOSS, 102 s | WIN 19/20, 76 s |
| Brick | WIN 20/20, 195 s | WIN 20/20, 88 s |

A maxed account walks the top rung, and the Brick's 195 s of settle-cap anxiety evaporates to
88 s. Whatever the fitted profiles end up being, **they have to be fitted against the mutated
ceiling, not the unmutated floor** — the gap between the two is worth more than the whole
current ladder.

**First finding, from ten minutes with it: the Meta stack answers the objection for free.** It
fields no Smalls and no Larges, so at t7 the "Small + Large" bubble costs it literally nothing
and it can decline every damage question in the fight — 8 offers, 3 of them freebies, won in
44 s with 16/16 alive and no losses. Balanced 20 took 70 s over 14 offers and also lost nobody.
Two things to take from that, both for the tuning pass rather than now:

1. **A bubble naming a class you did not bring is not a question.** The offer table should
   prefer pairings the player's roster can actually feel, or the rung should stop offering a
   class the army does not field. Either way, "bring four of the six classes" must not be the
   whole answer to this fight.
2. **Neither roster was ever in danger**, which is the expected consequence of a flat ladder —
   t7 fields the t1 enemies. That is `tierProfile`, and it is the harness rebuild's job.

### Playtest pass, ruleset 59 (owner, 2026-09-19)

Four changes off one session with the Raid Lab, all of which move the transcript, so they
landed together.

**The wave lines up.** Raids 12-15 leave the one-at-a-time drip for the alien stage's
cadence — 6 on the field, another slot every 10 s. Ten of the eleven shipped raids let
`activeTarget` sit at 1, which against a finished roster is a queue rather than a battle,
and it hides the wave: you can never see how much of it is left. The numbers are a
deliberate COPY of the alien pair, not an alias — those are ground truth from `spawnTimer`,
these are a design choice that happens to agree today.

**The rung finally scales the enemies.** `tierProfile` was built at ruleset 55 and left
disconnected; every rung fought the authored wave, and rung 7 fell to an unmutated Silver
roster in 44 s without a casualty. It is now wired through one shared
`raidProfile(raidId, {elite, tier})` that the client, the Worker and the Raid Lab all call.

**McDonnell does not shove here.** `OldMcDonnellPunch` carries `knockBack` at frequency 100,
so every swing he lands throws a zombie 150 units down the lane and re-slots it last. Against
a trickling wave that is a duel mechanic; against a wave that lines up it carries the zombie
out of reach of the whole line, over and over. Stripped from the farmer squad only — he keeps
it on raid 1.

**The objection dwell is 8 s**, up from 5. Five was long enough to read the two bubbles and
not long enough to think about them.

#### The ladder is an HP TARGET, not a multiplier

The first cut was one ramp for all four, fitted on raid 12. It put raid 13's tier 10 at
408,000 hit points — three times what any roster can clear inside the cap — because the four
borrow four stages that are nowhere near each other in bulk:

| raid | its own wave at 1.0x | its own boss |
|---|---|---|
| 12 Lawyers & Farmers | 21,400 | 4,500 |
| 13 Ninjas & Pirates | 58,500 | 25,000 |
| 14 Circus & Video Games | 77,200 | 1,500 |
| 15 Aliens & Robots | **409,000** | 25,000 |

So the ladder names a target and solves `con` backwards per raid: **70,000 wave / 12,000 boss
at t1, rising to 110,000 / 20,000 at t10**, the same curve everywhere so a rung means one
thing wherever you fight it. Lethality (`str` 1.8 -> 4.5, `dex` 1.0 -> 1.45) stays one ramp,
because a damage multiplier means the same thing whatever the wave is made of.

**Raid 15's 409,000 is a problem, not a datum.** Its wave is the alien stage's twenty minions
cloned wholesale — nearly four times the whole settle budget before any rung applies — so the
division comes out BELOW 1 and the ladder currently has to *shrink* the fight to make it
finishable. Stage 4 should compose a smaller wave; until then this at least keeps it
settleable rather than quietly unplayable.

#### The settle budget, and the two things that broke it

`RAID_MAX_TICKS` is four minutes, and a fight that outlives it does not lose — it returns
`truncated_transcript`: no result, no reward, nothing to tell the player. The binding case is
not the strongest roster but the **weakest one that still wins**, measured at ~686 hit points
a second of wall-clock (the Brick roster, which clears raid 12 t10's 128,940 points in 188 s).
`tierLadder.test.ts` checks the top rung against that and fails before anyone plays it.

Two ways it was actually broken in this session, both worth keeping written down:

1. **An earlier ramp took `con` to 8.5.** It measured beautifully on every roster that kills
   quickly, and hung the Brick roster at exactly 240 s with the whole 181,900-point wave
   cleared and the boss still untouched on its perch. Raising `con` here is not a free dial.
2. **An orphaned wall could hang a fight outright** — a genuine bug, latent until now. A boss
   `wall` is scenery: a zombie only fights one that is AHEAD of it, and `passedBlockers`
   remembers the ones it went around. So a wall the line has walked past is a wall nothing
   will ever attack again — and the win condition still required killing it. Measured on raid
   13: every enemy including the boss dead at 120 s, one 1,800-point wall behind the line, the
   army standing at attention until the cap turned a clean victory into a void. Blockers are
   now excluded from `anyAlive`, exactly as a converted pixel zombie already was. The lined-up
   wave is what made it reachable — a trickling line rarely advances past a blocker.

#### Where it landed (Raid Lab, raid 12)

| roster | t1 | t5 | t10 |
|---|---|---|---|
| Meta stack (12 Vagabonds) | WIN 16/16, 49 s | WIN 11/16, 51 s | **LOSS**, 75 s |
| Balanced 20 | WIN 20/20, 88 s | WIN 16/20, 95 s | **LOSS**, 102 s |
| Brick | WIN 20/20, 125 s | WIN 20/20, 143 s | WIN 20/20, **195 s** |
| Glass | WIN 14/20, 70 s | **LOSS**, 93 s | — |

Reads about right for a placeholder: t1 is a clean win for a finished roster, the middle
costs bodies, and t10 is past all four. Two things to look at in the tuning pass rather than
now — the Brick is the only roster that beats t10 and it does so without a casualty, which
says the objection barely troubles an army deep enough to lose any one class; and its 195 s
is the closest thing to the settle cap in the table.

**A BORROWED STAGE MUST BORROW ITS CORRECTIONS TOO.** Each of the four is fought on a
shipped raid's stage — 12 on the Lawyers' (2), 13 on the Ninjas' (4), 14 on the Circus' (8),
15 on the Aliens' (6) — inheriting its backdrop, parallax layers, perch structure and boss
wholesale. But the client keeps several per-raid PRESENTATION tables that were eyeballed
against the real game and are substantial rather than cosmetic, and they are keyed by raid
id, so all four new ids fell straight through every one of them and rendered their borrowed
stage wrong. Measured in the Raid Lab before the fix:

| raid | on | was | should be | i.e. |
|---|---|---|---|---|
| 12 | Lawyers | perch 0.7936 / **0.14** | 0.7936 / **0.46** | boss a third of a screen above the roof |
| 13 | Ninjas | 0.7806 / **0.0919** | 0.7806 / **0.2119** | boss too high on the structure |
| 14 | Circus | **0.909** / 0.5646 | **0.769** / 0.5646 | boss too far right on the car |
| 15 | Aliens | **0.82 / 0.2** | **0.79 / 0.4** | saucer too high and too far right |

Raid 14 had also silently lost the Circus trapeze: `fightConfig.GRAB_SPRITE` was asked about
raid 14, had never heard of it, and deleted a hazard from a fight whose stage is built around
it. None of this failed, logged or tested — it just looked wrong.

The fix is one authored fact rather than four copied numbers: `prep_raids.py` writes
**`stageOf`** into the dual entries (it already knows, from `DUAL_INVASIONS["stage"]`), and
every per-raid presentation table is keyed through **`RaidCatalog.stageRaidId(raid)`** —
identity for the eleven authored invasions, the borrowed id for these four. Re-tune raid 2's
perch and raid 12 moves with it. `src/raid/borrowedStage.test.ts` pins both halves, including
the premise the whole mechanism rests on (a dual invasion really is a pixel-for-pixel copy of
its source's stage).

**`stageRaidId` is for presentation ONLY.** A borrowed stage inherits how it looks, never how
it plays — route the wave, the cadence, the ladder or the rewards through it and a dual
invasion quietly adopts another raid's balance. Two live examples, both deliberately left
alone: raid 15 is on the Alien stage but does NOT take `waveCadenceFor`'s alien swarm, and its
boss's `summonBoss` still has no abductee queue. Both are Stage 4 decisions about how that
fight should PLAY, not inheritance bugs, and they are listed in the build order above.

**The offline build has to carry it too.** When `VITE_API_URL` is unset the client resolves
raids by itself, so tier unlock state needs a local home alongside the server-owned one, and
the tier profile must come from the same shared module in both builds.

**Ruleset discipline throughout.** Every one of these changes the fight, so each lands with a
`RAID_RULESET_VERSION` bump that 426s any in-flight session — batch them rather than bumping
per commit, deploy the Worker before the client, and stage first (deploys default to staging;
prod needs `--env production`).

### Art that does not exist yet

Everything else in these four fights reuses shipped assets — both factions' enemy rigs, both
backdrops, the stack, the ringmaster's car drop, the wall sprites. What has to be made:

| asset | for |
|---|---|
| the thought-bubble PROP over the lawyer (the faces inside it are done — they reuse each class's Green rig) | 46 — and it is the fight's whole read |
| a "sad" pose or walk cycle, or a tint/droop on the existing walk | 46 |
| charge-up tell: grow + redden over 5-10 s, plus the slam impact | 47 |
| the thought bubble, a charge bar, and one icon per bubble action (5) | 49 |
| portal VFX at both ends | 49 |

The one that carries the most risk now is the raid-49 bubble icon set (the objection's faces
are done, and reusing the Green rigs is why they cost nothing), because it is
the fight's entire legibility: a player who cannot read them at a glance is playing a random
number generator.

## The harness, and what it cannot see

**It never taps.** The measuring fight is a bare `while (!sim.finished) sim.step()` loop
(`eliteInvasion.balance.test.ts`): no `activate()`, no `popBubble()`, no wall taps, no
decisions of any kind. `concentration: true` papers over the focus bar by auto-releasing it.
So p* is "can this army win with its player asleep", and every activated ability in the game —
Bash, Smash, Explode, Mini Buddy — is measured as if it does not exist.

That lands directly on three of these four designs:

| invasion | what the harness cannot see |
|---|---|
| 47 Pirates + Ninjas | poise is filled mostly by activated moves, so every charge measures as landing. The fight reads as impossible while playing fine. |
| 49 Robots + Aliens | the bubble cancels are taps, so it measures the worst case at every occurrence. |
| 48 Circus + Video Games | stacks are toppled with burst, so they always reach full height. Plus the mirror problem below. |
| 46 Farmers + Lawyers | WAS the least affected, when the bar was a fixed rotation and the counterplay was roster composition alone. The rework moved it: the harness never taps, so it always takes the auto-pick, which measures the fight of a player who is not playing. That is a real floor — and a useful one — but it is no longer the whole fight. |

Two further defects, both structural rather than missing features:

`weakestWinningArmy()` bisects on a stat multiplier, which assumes `win(p)` is monotone in
`p`, and `stickArmy()` scales **str and con only — never dex**. So:

- **The Ninja throw tax is invisible to the stick.** Its dex never moves, so the boss's
  throw rate never moves, so the mechanic the fight is built around cannot be
  regression-tested. Scaling dex in the stick fixes it and re-measures every existing rung —
  a deliberate, documented re-fit, not a free change.
- **The Circus copies break monotonicity outright.** A stronger stick builds stronger copies,
  so `win(p)` need not be monotone and the bisection can converge on nothing meaningful. That
  raid probably needs a different metric entirely — win rate at fixed power, or margin of
  victory — because p* is structurally wrong for a mirror fight.

Worth taking as an opportunity rather than a chore: the stick is six catalog zombies at a
flat multiplier, which models neither roster diversity nor mutation spread, and three of these
four fights are explicitly about both.

**And there is barely any headroom left above the current hardest fight.** `MAXED_STICK` is
3.0; elite Video Games measures p* 2.57. That is a 1.17x margin between the hardest fight in
the game and the strongest army the harness can describe — and `eliteInvasion.ts` notes that
army SIZE does not help, because 20 zombies barely beat 16 when only the front engages. So
"t10 is extremely difficult" **cannot** be delivered by scaling stats: on the current stick
there is nowhere to scale to. It has to come from the mechanics, which is what these four
designs are for. Re-establishing where the real ceiling is — with a stick that models a
genuine endgame roster rather than six repeated catalog entries — is part of the rework.

### What the rebuilt harness needs to model

Collected here so the rework has a target rather than a grievance:

- **A player.** Ability activations on some policy (greedy, or held for a threshold), wall
  taps, bubble cancels. Without this, half the game's verbs are invisible.
- **Deploy order and timing.** The army array IS the formation and the deploy queue, and two
  of these fights are built on that. A stick of six repeated zombies has no order to speak of.
- **Roster diversity and mutation spread**, not a flat multiplier on six catalog entries.
- **A metric that survives mirror fights** — p* bisection assumes monotonicity that the
  Circus copies break.
- **Dex**, which the current stick never varies, and which one whole fight is a tax on.

## Open items

1. **What the eight t5/t10 unlocks are**, and which system owns permanent account-wide power
   once prestige is reworked (see Part 2).
2. **The brain ladder's final numbers**, set after the harness rework measures t10.
3. **Level thresholds for 46-50** — fit once a target wall-clock per level is chosen.
4. **What level 50 unlocks** — capstone fight, prestige on-ramp, or both.
5. **Prize pairs for the four new invasions**, and whether the rate ladder climbs past 2%.
6. ~~**Circus copies: per-deployment or on a timer.**~~ SETTLED: per deployment, at
   ruleset 60. The queue order is the player's, so the choice of what gets copied is too.
7. **The pirate slam's damage ceiling**, independent of the authored str 500.
8. **The four need their own loot tables.** They currently inherit their stage faction's
   verbatim, which means the hardest content in the game drops the same decor as invasions
   cleared thirty levels earlier. It also drags in raid 6's Pyramid exemption in
   `awardSellValue.test.ts` (a tier-4 drop worth more than the tier-5 prize), now extended to
   raid 15 for exactly that inherited reason and to be removed with the inheritance.
9. ~~**Raid 15 needs `summonConfigFor` extended.**~~ DONE at ruleset 61, along with
   `waveCadenceFor` at 59.
10. ~~**Raid 15's wave is 409,000 hit points.**~~ RE-COMPOSED at ruleset 61: ten aliens
    plus one robot heavy, base 91,000, and the rung scales up from there.
12. **An all-Garden army can still stall out a fight** (see Stage 4 above). Not new, and
    now easy to reach. Downgraded 2026-09-21 from "the one thing the four invasions leave
    broken": since the clock ends the fight as an ordinary loss, and now says so on screen,
    the stall costs the player a raid rather than voiding one. Still worth fixing — losing
    to a formation rule is a bad loss — but it is no longer a correctness hole, and it no
    longer has to be settled before the rating rebuild can measure anything.
11. **The crop ladder stops at 45** while the cap is 50, so a player climbing 46-50 plants
    the same Heartichoke the whole way. The plan is a crop at 46 / 48 / 50; tracked by
    `cropUnlockAlignment.test.ts`, which asserts the gap rather than the cap.
