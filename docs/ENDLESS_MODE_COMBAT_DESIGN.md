# Endless Mode Combat Design Notes

This note records the implementation direction for making Endless encounters more
tactical and less dependent on raw stat growth. The ratios below are the initial live
profiles and still require balance runs.

## Agreed constraints

- Endless-only stat profiles may reshape enemies. Normal invasion stats and behavior
  remain unchanged everywhere else.
- Preserve each location's signature mechanics. Increase their cadence through the
  location section as already planned.
- Alien waves keep the normal Alien invasion's deployment count and timing. Endless
  changes the stats and the type of enemy beamed down; do not add ordinary wave bodies
  there as part of density tuning.
- Enemies should sometimes arrive in pairs in later waves, making area attacks more
  valuable and enabling complementary combinations such as a durable frontliner with a
  fragile high-damage partner.
- After wave 16, flatten the stat ramp to +4% damage and +3% HP per wave in normal Endless
  (+3.5% and +2.5% in Nightmare). Composition and the 7x normal T7+ boss gate add later
  difficulty.
- A close win should sometimes cost two or three zombies. Strong wins can still have no
  casualties, and close losses should sometimes leave survivors. Avoid making outcomes
  collapse into either a perfect army or a full wipe.
- Slow, telegraphed, high-damage attacks can create casualty risk. They should be rare and
  readable, with enough wind-up for players to react. Lumberjack is a candidate for this
  bruiser role; Pirate enemies can provide related examples.
- Deployment-speed boon reduces zombie focus time, stacking to an 80% bonus cap; opening
  deploy releases up to three zombies at fight start. Both are run-local combat effects.
- The headless-revival boon revives fallen headless zombies at each fight end.

## How enemies are scaled

**Status: built (owner, 2026-11-07).** Every enemy starts from its invasion's real numbers.
Endless scales damage and health, and leaves attack speed as the source has it.

1. **Shape within the invasion.** Each enemy's source damage per second and health are
   compared with the other enemies of its own invasion: the invasion's baseline is the
   geometric mean of its ordinary enemies. A Ninja Boy is measured against the Ninja Girl,
   not against a Farmhand, so invasions that differ a hundredfold in raw scale start level,
   and who hits harder or lasts longer within each one is kept. A shape is capped at 2x
   either way of its baseline (`ENDLESS_SHAPE_LIMIT`).
2. **Killers.** A former boss is measured against its own invasion's crew too. The four are
   then brought to one shared level, so `ENDLESS_KILLER` (0.8x health, 2x damage) sets how
   dangerous killers are and the source sets how they differ from each other.
3. **Entry floor and ramp.** Damage and health are the entry rating (23) times the shape,
   times `ENDLESS_LINE` (1.5x health, 0.95x damage) or `ENDLESS_KILLER`, times the depth ramp.
4. **Hits follow from speed.** A hit is the damage per second times the enemy's own swing
   interval, so a Ninja Girl pecks ten times a second for small hits and a Farmhand swings once
   a second for larger ones, at the same pressure.

Enemies are built without the Farm invasion's level pace, which speeds Farm enemies up as a
starter raid is out-levelled. The Lumberjack keeps a 2.4 s wind-up chop with 5.2 s recovery,
only in Endless. Standard invasions keep their original stats and attack behaviour.

Current shapes, damage / health against the invasion baseline:

| Invasion | Shapes |
|---|---|
| Farm | Farmhand 0.94 / 0.87, Lumberjack 1.06 / 1.15 |
| Pirates | Scallywag 1.58 / 1.26, Swashbuckler 0.63 / 0.79 |
| Ninja | Girl 0.91 / 0.82, Boy 1.10 / 1.22 |
| Robots | BrainBot 0.77 / 0.90, JunkBot 0.99 / 0.99, BroBot 1.32 / 1.12 |
| Video Game | Knight 0.96 / 1.11, Ghost 1.08 / 0.95, Monster 0.96 / 0.95 |
| Alien, Beach, Circus | 1 / 1 |
| Killers | Farm boss 0.52 / 1.43, Ninja boss 0.79 / 1.26, Pirate captain 2.00 / 0.94 (capped from 4.5x), Video Game boss 0.53 / 0.59 |

## Proposed roles for the current Endless roster

| Unit | Proposed role | Endless use |
|---|---|---|
| Farmhand | Swarm / baseline | Low individual threat; helps make Farm fights readable and keeps the existing entry floor meaningful |
| Lumberjack | Burst bruiser | Durable enough to approach the line; slow, clearly telegraphed heavy chop with high damage and recovery |
| Farm boss as a regular enemy | Tank / elite bruiser | Deep-wave anchor; slower attacks and more durability than a Lumberjack, without boss-only scheduling |
| Beach Minion 1 | Balanced | Mixed-in filler that can accompany heavier pirate enemies |
| Beach Minion 2 | High DPS / harasser | Faster, more fragile partner; use sparingly in pairs |
| Alien Minion | Balanced | Preserve normal Alien deployment count and cadence |
| BrainBot | Tank / control | Durable beam-in threat; use its existing control/throw behavior rather than adding raw damage alone |
| Ninja Girl | Control / flanker | Keep her tied to the Ninja backline pressure and smoke-bomb interaction |
| Ninja Boy | Burst bruiser | Slow, forceful frontline partner; tune its attack profile independently from the girl |
| Ninja boss as a regular enemy | Tank / control elite | Deep-wave anchor; keep the Ninja terrain mechanics, but remove boss-only scheduling as already planned |
| Video Game Ghost | High DPS / fragile | Threatens the army while Knight or Monster units hold attention |
| Video Game Knight | Tank | Durable frontline that makes the Ghost pairing work |
| Video Game Monster | Burst DPS | Large hits with readable recovery; avoid making every attack a one-shot |
| Video Game boss as a regular enemy | Control elite | Deep-wave source of its existing video-game interactions, tuned below a full boss gate |
| Scallywag | Speed-punish / heavy hitter (burst) | Mirrors the zombie it faces (built, see below) |
| Swashbuckler | Balanced / duelist | Midline pressure that can accompany a Scallywag or heavy pirate |
| Pirate boss as a regular enemy | Killer | Mirrors the zombie it faces (built, see below); no slam, since his blow is the killing move |

**Pirate speed mirror. Status: built.** Both pirate heavy hitters keep their invasion
mechanic: they ignore their own attack speed and swing at a pace set by the zombie in front
of them, by the invasion's own curves. The Scallywag follows that zombie's current speed,
upgrades included; the captain follows its body type alone, so a Headless leading the line
is the counter. Their damage per second is defined against an ordinary 1 s front-liner,
where the Scallywag swings every 1.25 s and the captain every 1.6 s. A Headless (2 s) holds
the captain to one blow every 6.5 s, and a fast zombie speeds the Scallywag up to two swings
a second.

- **No slam on the captain.** The killers' slam is a second clock that broke his rhythm: it
  wound up while he waited, each slam pushed the front zombie away, and his swing restarted.
- **His first swing at a new arrival is mirrored too.** In his invasion it runs on his own
  2.5 s clock, so a Headless walking up took a blow after 2 s instead of 6.5 s. Endless only;
  invasions are unchanged.
- **Heavy Hitters and the attack-speed curse still reach the pirates**, through
  `mirrorPace`. Do or Die doubles both, like every enemy.

Pair waves begin at wave 14 and occur on fight 2 of each later non-Alien section. They
deploy a selected frontliner plus a damage partner. The current examples are Farm boss + Beach Minion 2,
Ninja boss + Ninja Boy, Knight + Ghost, and Swashbuckler + Beach Minion 2. Alien remains
at 20 ordinary minions, six active, with a 10-second reinforcement interval; its special
beam-in unit progresses from Farmhand through Ninja, Lumberjack, Pirate, and Video Game
Ghost.

## Boon and curse follow-ups

- Deployment speed should change the actual deployment interval in the Endless fight.
- Opening deploy should put the first selected zombies onto the field at fight start.
- Define stacking caps or diminishing returns for both before final tuning.
- Test a headless-revival boon against armies that rely on headless zombies and against
  armies with few or none, to verify that the choice has a real, legible tradeoff.
- Keep boon/curse impact visible in results: selected options, casualty counts by role,
  clear/fail, and deepest wave.

## Tuning and test plan

Run identical army snapshots against identical encounter seeds, changing only the
archetype pairing, deployment pattern, or boon selection. Include lower-power armies,
level-45 player armies, and high-power mutated armies. Compare clear rate, casualties per
win, full-wipe rate, time to clear, headless survival, and boss-gate success. For Alien,
hold normal deployment timing and count constant while varying only Endless stats and
the beam-in selection.

## Tiers, clocks and overtime

**Status: built.** A tier is three fights at one location: normal, advanced, then the Epic Boss.
Enemies come out one at a time on every floor except Alien, which is built around its swarm
(owner, 2026-11-07). Difficulty comes from each enemy's stats instead, scaled as described under "How enemies are scaled". The killers' slam is 6 seconds of their
damage on the front zombie, and grows with their hit under Heavy Hitters.

Endless uses the Halloween clock model. When the clock runs out, the fight goes into Do or Die:
enemies swing twice as fast and hit twice as hard, and running that out too is a loss. Epic Boss
gates no longer use their own round timer, so Dr. Groundhog cannot escape or enrage first.

| Fight | Clock | Do or Die | Bodies | On the field at once |
|---|---:|---:|---:|---:|
| Normal floor | 90 s | 30 s | 8 | 1 |
| Advanced floor | 120 s | 60 s | 12 | 1 |
| Boss gate | 120 s | 60 s | Dr. Groundhog, no modifier | |
| Alien normal / advanced | 120 s / 150 s | 30 s / 60 s | 20, as authored | as authored |

**Killers.** The former invasion bosses, as ordinary enemies, have less health than the line, a far
harder hit and the Count's slam: a 3 s telegraphed wind-up, then 3 of their hits on the front
zombie, with 7 s between slams. Stuns fill a bar that breaks it, and a timed Block reduces it.
Stun resistance shortens stuns and slows that bar; immunity stops both, leaving Block.
`endlessKillerCount` sets how many stand on a floor: the place to tune how often fights kill.

**Choosing a location. Status: built, in the boss screen.** After each boss, the player chooses
from two other locations, each with its own modifier. T1 is always the Farm with no modifier.
Options, rosters and drafts come from the week's seed (Monday 00:00 UTC), and a run keeps the week
it started in. Alien never gets Crowded or Short Clock, because its drip stays as authored.

| Modifier | Effect |
|---|---|
| Glass Cannon | 40% less enemy health, 60% more damage |
| Chunky | 35% more health, 25% less damage |
| Crowded | 4 extra enemies |
| Unstunnable | Enemies cannot be stunned |
| Short Clock | 20% less time |
| Heavy Hitters | Half dex, 2.5x strength, for all enemies |

Modifiers apply to floors only. The Epic Boss is the same fight wherever he is.

**Dr. Groundhog. Status: built.** His catalog gives him one attack, a melee bite, and no special
moves, so Endless adds one a tier:

| From | Move | Answer |
|---|---|---|
| T1 | Falls from the sky, then bites | |
| T1 | A stun interrupts him: a move mid-cast is lost | Any stun |
| T2 | Slam: 3 s swell, then 4 of his hits on the front zombie, 9 s between | Stuns break it, a timed Block reduces it, and each tap on him takes 10% off, down to half |
| T3 | Launch: 1.5 s tell, then the front zombie takes one hit and is thrown to the back, 12 s between | A stun during the tell |

From T7 his hit is 7x and his health 3x. Dual-invasion mechanics are still only an idea.

To measure with real armies (`src/raid/harness/report/endless.report.ts`):

`ENDLESS_ARMIES=<file> ENDLESS_WEEK=<n> ENDLESS_ROUTE=<0 or 1> npx vitest run --config vitest.endless.config.ts`

## Run design decisions (owner, 2026-11-05)

Status: **built** means in the code now. Everything else is agreed direction, not behaviour.

**Scoring**

- **Built:** the leaderboard ranks by deepest floor, then whoever reached it first. Run time no
  longer breaks ties.
- The leaderboard should have **weekly and all-time** boards.
- **Built:** the draft seed is **weekly**, so nobody out-rolls anybody. Everyone sees the same
  options in the same week.

**Casualties**

- **Built:** every zombie comes back at full health after each boss, by default. The revive boon
  is gone.
- Zombies are never lost permanently here, so fights can kill them much more aggressively.

**The boss screen. Status: built.** One screen shows the boon options, curse options, next location,
the loot and gold earned so far, Go Home, and a button that opens the ordering screen.

- Reordering is optional and only happens through that button.
- It shows only the zombies brought on the run. Bringing 8 shows those 8. It gives no access to
  the Mausoleum or anything else.

**Boons. Status: built.** Build-changing boons stack and read the army's current order, so
reordering changes who benefits:

| Boon | Effect |
|---|---|
| Vanguard | First 3 zombies +50% health, the rest -10% |
| Rear Guard | Last 5 zombies +40% damage, the rest -10% |
| Headless Wall | Headless +40% health, the rest -10% damage |
| Garden Focus | Gardens +60% health, the rest -5% damage |
| Temporary zombie | A strong Special, chosen by the week's seed, joins at Master veterancy for the run, even above the 20-zombie cap. It is never on the roster or the leaderboard army |

**Curses** are about choosing the downside that hurts your build least, and pay nothing for now.
They alter a mechanic and never disable it: shorter stuns, not no stuns.

**Starting later. Status: built.** Normal Endless can start one tier later per 5 levels: T2 at 35, T3
at 40, T4 at 45. The run first drafts a boon and curse for each skipped tier, on the boss screen, and
the last of those screens picks the starting location. Fights the run really plays pay their loot as
usual. Its first boss win pays the skipped tiers' boss rolls, milestones and depth gold, and only
from then on does the run count for the leaderboards. Going home before that pays only floors
actually cleared.

**Leaderboards. Status: built.** This Week and All Time, per mode. A run counts for the week it
started in. Run time is no longer shown.

**Boss mechanics still to decide:** dual-invasion mechanics, and a perch phase so Medusa's freeze
applies to Dr. Groundhog.
