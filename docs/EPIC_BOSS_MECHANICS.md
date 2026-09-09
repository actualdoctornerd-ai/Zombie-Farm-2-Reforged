# Epic Boss Mechanics

## Implemented coverage

Market → Epic Boss offers all eight recovered bosses. Starting one creates a 14-day
wall-clock run; only one boss event can be active at a time. A run can be purchased again
after its final level is completed or the event expires, and purchasing never extends an
active run.

Costs and unlocks (server-enforced in `v3/epicBoss.ts`): activation **ramps 3-5 brains**
with the unlock ladder. Each event has its own unlock level, ordered by how strong its
prize zombies are, because the eight are not interchangeable — Loco Locust pays the
strongest zombie in the game and Dr. Groundhog one that deals a third of its damage.

Since the 2026-09-07 Epic re-fit the prizes are FITTED TO THE LADDER rather than the ladder
to the prizes: the prizes can now be mutated in the Zombie Pot, so each one's str and con
are scaled (dex never) so that, wearing the five-slot damage mutation set, its strength
(`sqrt(DPS x HP)`) lands on a line from 1,500 at level 24 to 2,000 at level 42 — the omega
75 above the line, the rung-5 prize 75 below (`tools/reforge_economy.py`
SPECIAL_STAT_REBALANCE has the fit; the Zombie Strength Ladder page plots it). The slow
tanks — Bully Frog's two prizes — keep that str but take their con from a separate HP fit:
the HP they reach with the five-slot life set lands on a tank line from 5,000 at level 24 to
6,600 at level 42 (omega +200, rung-5 prize −200), because a tank's value is the hits it
absorbs, not a damage-weighted average. Two pairs have since left the fit (2026-09-08):
Dr. Groundhog's Doctors are Garden healers (Heal / Heal All, with Laser Beam Ver.2 from the
support station in place of Resurrect) held a step over the Cupid Zombie, and General
Larvaelus's Proto Zombie / Zombug are Minis (fitted str and con ×0.86; Explode / Explode
Ver.2, and they ride a brute as its Mini Buddy).

| Level | Boss | Brains | Best prize | str / dex / con | DPS | HP |
|---|---|---:|---|---|---:|---:|
| 24 | Dr. Groundhog | 3 | Omega Dr. Zombie | 15 / 2.65 / 25 | 199 | 2,500 |
| 28 | Bully Frog | 3 | Admiral Zombie | 18 / 2.9 / 41 | 261 | 4,100 |
| 30 | Rocky Rhino | 4 | Brock Coley | 46 / 3 / 8 | 690 | 800 |
| 32 | General Larvaelus | 4 | Zombug | 15 / 7 / 15 | 525 | 1,500 |
| 34 | Mystical Mamba | 4 | Zomtar | 23 / 6 / 17.2 | 690 | 1,720 |
| 38 | Foul Owl | 4 | Scrooge Zombie | 10 / 8 / 32 | 400 | 3,200 |
| 40 | Skunkarella | 5 | Madame Zombie | 19 / 8 / 20 | 760 | 2,000 |
| 42 | Loco Locust | 5 | Vagabond Zombie | 20 / 8 / 21 | 800 | 2,100 |

(Plain catalog stats: `str x 10` per hit every `2 / dex` seconds, `con x 100` HP — no
veterancy, abilities or mutations.)

Rocky Rhino and Foul Owl are swapped against a strict DPS sort deliberately: Brock Coley
is a 46-str/800-HP glass cannon, while Scrooge is the toughest Epic and is
worth holding back. A locked activation returns `403 locked` with the required level, and
the Market card renders "Available at player level N".

**Every boss runs 10 rungs.** ZF2 authored 20 HP multipliers (`EpicBossHP.json`
LevelMultiplier) and seven bosses used to advertise 40, of which 21-40 were the level-20
multiplier repeated — grind rather than difficulty. That padding went first (20 rungs,
migration `0046`); the ladder is now **10 rungs, each one two of the authored multipliers
added together**, so it carries exactly the HP it always did in half as many fights:
`[2.4, 5.8, 14.2, 17.5, 37, 52.4, 71.7, 111, 138, 195]`, summing to the same 645x.

The point of the second cut is the floor. A rung costs at least one attempt however far you
overkill it, and the bottom half of the 20-rung curve was a formality for any real army.
Merging pairs deletes those without touching the rungs where HP genuinely gates progress.
Every prize moved with it: the first prize zombie sits at rung 5 and every top prize at
rung 10, with the intermediate reward quests on 3/4/5/7/8/9.

**`baseHp` ramps with the unlock ladder** rather than being ZF2's flat 2000 for all eight.
Flat baseHp made the ENTRY event the grindiest, because the ladder was flat while the
player was not: a level-24 roster deals about a third less damage than a level-30 one, so
Dr. Groundhog cost a moderate army 91 attempts against 63-64 everywhere above him. baseHp
now runs ±25% end to end, symmetric about General Larvaelus and Mystical Mamba, which keep
the source's 2000 and are the fixed point the rest is stated against
(`tools/prep_all_epic_bosses.py EPIC_BOSS_BASE_HP` is the source of truth):

| Boss | `baseHp` | Rung 1 HP | Rung 10 HP | Whole ladder |
|---|---:|---:|---:|---:|
| Dr. Groundhog | 1,500 | 3,600 | 292,500 | 967,500 |
| Bully Frog | 1,650 | 3,960 | 321,750 | 1,064,250 |
| Rocky Rhino | 1,850 | 4,440 | 360,750 | 1,193,250 |
| General Larvaelus | 2,000 | 4,800 | 390,000 | 1,290,000 |
| Mystical Mamba | 2,000 | 4,800 | 390,000 | 1,290,000 |
| Foul Owl | 2,150 | 5,160 | 419,250 | 1,386,750 |
| Skunkarella | 2,350 | 5,640 | 458,250 | 1,515,750 |
| Loco Locust | 2,500 | 6,000 | 487,500 | 1,612,500 |

Rung HP is `round(baseHp * LevelMultiplier[level - 1])`. Runs mid-flight across either cut
are repaired by migration: `0051` pulls a run parked above the new top down to rung 10 and
**rewrites its HP columns**, because unlike the 20-rung truncation this cut reshaped the
curve; `0052` re-fits in-flight runs onto the per-boss `baseHp`. Both cap `current_hp`
rather than resetting it, so damage already dealt is kept, and neither touches a completed
run. `clampRun` in `v3/epicBoss.ts` and `EpicBossManager.normalize` carry the level
correction at read time for rows written between the deploy and the migration — but *not*
the per-boss HP, which is why `0052` has to exist rather than being optional cleanup.

Each fight has a hard **60-second** escape deadline. Zombies use manual brain-bubble
release without butterfly distractions or consuming Concentration. The normal army cap and
permanent invasion casualty rules apply, and Epic Boss attack order is stored separately.
Casualties are written to the authoritative graveyard (`fallen_v3`) on the same terms as an
invasion's, so a Memorial Statue can carve one; migration `0053` recovers those lost before
that write existed, from the party the server itself pinned into the finished session.

### Boss damage ramps by event

Every boss originally dealt exactly **40 DPS** — `str 2 / dex 2`, or Skunkarella's
`str 1 / dex 4` (the same rate in faster, smaller hits) — at every level of every ladder.
Only HP scaled. That made all eight events identical in threat and different only in how
many attempts they took.

HP is the wrong difficulty knob here. A fight is capped at 60 s and damage carries over
between attempts, so **more HP buys only more attempts**, and every attempt costs a Boss
Token or a brain. That is grind — and worse, it is grind a bad army can walk, given
patience. Incoming damage is the one lever that raises the bar without adding an attempt,
and it is deliberately **regressive**: it costs a weak roster far more than a developed one.
That is the gate. Attack power ramps with the event's unlock level:

| Boss | Unlock | `str` | `dex` | Rung-1 DPS | Rung-10 DPS | Dmg per full 60 s fight (rung 1) | Unaided front-liner |
|---|---:|---:|---:|---:|---:|---:|---|
| Dr. Groundhog | 24 | 2.400 | 2 | 48 | 74 | 2,880 | alive, 48% |
| Bully Frog | 28 | 3.000 | 2 | 60 | 93 | 3,600 | alive, 36% |
| Rocky Rhino | 30 | 3.600 | 2 | 72 | 112 | 4,320 | alive, 23% |
| General Larvaelus | 32 | 4.200 | 2 | 84 | 130 | 5,040 | alive, 17% |
| Mystical Mamba | 34 | 4.800 | 2 | 96 | 149 | 5,760 | DEAD |
| Foul Owl | 38 | 5.500 | 2 | 110 | 171 | 6,600 | DEAD |
| Skunkarella | 40 | 3.125 | 4 | 125 | 194 | 7,500 | DEAD |
| Loco Locust | 42 | 7.000 | 2 | 140 | 217 | 8,400 | DEAD |

`dex` is never touched — it is each boss's hit rhythm, and Skunkarella's fast small hits are
its signature. That is also why its `str` reads low out of order: at `dex 4` it lands 125
DPS from 3.125, so the ramp is monotonic in **DPS**, which is the quantity that matters, and
not in `str`. Anything comparing these bosses by `str` alone will place Skunkarella second
from the bottom of the ladder instead of second from the top.

**Damage compounds 5% per rung climbed** (`epicBossDamage`, raid ruleset v29). Rung 1 keeps
the authored value above, so the entry fight of every event is exactly what it was; the top
of a ten-rung ladder hits `1.05^9` = **1.55x** it. Only the deep rungs moved. The "unaided
front-liner" column is the rung-1 read: a level-appropriate best-mutated headless with no
support, where the first four events leave it standing on a visibly narrowing margin and
Mystical Mamba upward kill it every attempt. **Backed by two level-appropriate healers,
every one of the eight leaves it at 100% HP** — and that crossing is the design. It is the
ramp's job to make bringing support a real decision rather than a nicety.

Compounding is computed by repeated multiplication, not `Math.pow`, which the spec leaves
implementation-approximated. The client sim and the Worker's replay must agree bit for bit
or a won fight fails verification, and only exactly-rounded IEEE-754 operations guarantee
that.

**The ramp was measured in BattleSim with the fight played correctly** (brain bubbles
released), not modelled — `epicBoss/combat.test.ts` pins the calibration. Two properties of
the epic fight break any closed-form estimate:

- **Only a fraction of the army is engaged at once**, however deep the line — zombies enter
  one at a time every `CHARGE_MS`, so the attempt window decides how many ever reach the
  boss at all: **6 of 20 at 30 s, 13 at 60 s**. Damage per attempt is therefore
  super-linear in the window, which is precisely why 30 s -> 60 s was worth more than any HP
  edit (ruleset v28, taken together with scaling the whole damage ramp by 0.8 so the
  now-legible per-boss difference did not overshoot). A 20-strong army still does not bring
  20 zombies' worth of damage, and incoming damage concentrates on the front slot instead of
  spreading across the line.
- **A level takes many full-length attempts.** With damage carrying over, most attempts run
  the whole window, so a boss that can kill the front unit kills one **per attempt** — and
  casualties are permanent. There is no such thing as a small per-fight casualty rate here.

The ramp is therefore read as *what army can hold the front slot*, and the bounding rule
lives in `epicBoss/combat.test.ts` stated on the **army**, not on one zombie: Silver-grade
for events unlocking through 30, specials from 30-35, epic prizes and specials above that.
The older rule measured a single unit's HP, which is not what a player fields. The real
ceiling is around **200 DPS**: past that even the *supported* headless wall comes under
threat (measured: it holds to 240 and dies at 800), so the top of the ladder sits just under
it by design. Raising the ramp reddens that test rather than failing silently.

Two consequences worth knowing. The ramp gives the Headless family a job for the first
time: Bombie/Skull Head/Diver are near-worthless on damage (55 DPS) but hold the front slot
against every boss on the ladder, and Protect (−20% per carrier) stacks on top. And lineup
ORDER becomes a real decision rather than cosmetic — leading with your best damage dealer
now costs you that zombie.

Deploying a **stat** change mid-event is safe: each fight pins its boss stats into the
session's `config_json` at start and the finish handler replays from that pinned config, so
an in-flight fight keeps the numbers it began with.

A change that moves the FIGHT is a different matter, and both v28 and v29 are that. The
window and the damage curve are read by the sim itself, so a transcript recorded under the
old rules does not replay under the new ones — which is why they bump
`RAID_RULESET_VERSION`. The pinned config carries the version it was written under and the
finish handler refuses a mismatch (`409 stale_ruleset`, roster unlocked, attempt lost), so an
epic attempt in flight at deploy time settles as an escape. That is the accepted cost of every
bump.

**`/epic-boss/start` therefore performs the same handshake `/raid/start` does**: the client
sends its `RAID_RULESET_VERSION` and a mismatch is refused with `426 stale_ruleset` before
anything is charged — no token, no brain, no session — and the client answers it with a
reload prompt. This has to be checked at START, because the version pinned into the session
config is the WORKER's, so the finish handler's comparison detects a stale *session* and
never a stale *client*. Without it a tab holding pre-v28 JS would pay for an attempt, fight
to a win under the 30-second rules, and have the replay under the 60-second rules answer
"escaped" — or fail verification outright, with the payment gone either way. It is also
checked before the resume branch: letting a stale client re-enter a session it cannot
simulate correctly just moves the same failure to the finish.

The boot-time skew check (`raidRulesetVersion` on bootstrap) still exists and still prompts a
reload, but it is a dismissible toast and only fires at bootstrap, so it is a courtesy rather
than the gate.

Every attempt costs either one Boss Token or 1 brain (`EPIC_BOSS_FIGHT_BRAIN_COST`, reduced
from 10 by the brainflation revert); there is no retry timer. While
an event is active, harvesting a vegetable crop can yield a Boss Token. The chance uses
the recovered 35% starter-loot rate as a per-harvest ceiling, so no crop is ever a
guaranteed token.

Per-harvest chance is a hump in grow time (peaking around 2-4 hours before the ceiling
takes over) times a weak harvest-value term, **plus a flat 3-point bonus** so no crop
is ever a dead roll — the bare curve left a 15-minute crop near 0.4%, which reads as
"never" to a player pulling carrots. Everything from 8 hours up sits at or near the
ceiling, and the 24-hour band is pinned to it, so harvest value stops separating those
crops.

The whole curve is then **scaled to a quarter** (`SUPPLY_SCALE`), which moves its height and
nothing else — so the effective ceiling is **8.75%**, and the flat floor 0.75%. Read that
against demand, because both halves of it moved underneath the old rate: the attempt window
doubled and the ladder halved, so a full clear now asks roughly half the attempts it used to
(10-47 in total). Left alone, supply of 1.15-3.3 tokens per plot-day against that would have
made attempts free. Quartered rather than halved on purpose — the attempt count halved, so
this leaves tokens about twice as scarce again relative to demand, which is what makes an
attempt worth a moment's thought instead of something you spam until it works. The scale is
applied **after** the ceiling clamp, not inside it: scaling inside would lift every crop off
the ceiling and quietly restore harvest-value separation to the long crops the pin exists to
flatten.

Read supply in tokens per **plot-day**, not per harvest, because a plot is recycled: a
15-minute crop harvests 96 times a day and a 24-hour crop once. That makes the flat
bonus very unevenly levered — three points is worth +0.72 tokens per plot-day on a
15-minute crop and +0.045 on a 4-hour one. **Short crops are therefore the most
efficient token farm**, roughly: 15m 0.83, 30m 0.52, 1h 0.38, 2h 0.31, 4h 0.29, 6h 0.27,
12h 0.18, 24h 0.09 per plot-day. This is a deliberate trade — the flat bonus buys
per-harvest feel at the cost of the grow-time ladder, and shrinking `FLAT_BONUS` in
`src/epicBoss/tokens.ts` restores a 2-4 hour peak.

(The original rule was `0.35 * sqrt(time * value)`, which was *documented* as favouring
long crops but per plot-hour did the opposite, at a much lower overall supply.)

The roll is the **client's**, in both online and offline play, and it happens the moment
the crop is harvested — the token portrait rises out of that plot in the same frame. The
Worker used to roll it authoritatively during command replay, which meant the token
surfaced a batch window later over a plot the player had usually already replanted. It
now only records what the client reports (`epicBoss.token`, pinned to the running
`runId`), and does not re-check the roll. An edited client can therefore mint Boss
Tokens. That is an accepted trade: a token buys one attempt, the drop is common, and the
alternative price is a single brain.

### Favourite crops

Each boss names one **favourite crop** (`src/epicBoss/favoriteCrops.ts`), shown on its
market card: Dr. Groundhog/potato, Bully Frog/venus_flytrap, Rocky Rhino/broccoli,
General Larvaelus/garlic, Mystical Mamba/lima_beans, Foul Owl/dragon_fruit,
Skunkarella/pumpking, Loco Locust/corpse_flower. It does two things, and never both at
once, because the second only applies when no event is running.

**While its own boss's event is active**, that crop's Boss Token chance is multiplied by
`1 + FAVORITE_CROP_TOKEN_BONUS` (**+25%**). The multiplier is applied *outside* the
ceiling clamp, alongside `SUPPLY_SCALE` and for the same reason: three of the eight
favourites are 24-hour crops and that whole band is pinned to the ceiling, so folding the
bonus in before the clamp would delete it on exactly the crops planted for it. It keys off
the *running* event, not merely off being somebody's favourite.

**While no event is running**, the same harvest can instead **lure that boss onto the farm
and start its event for free**, if the account has reached the boss's unlock level. The
rate is `EPIC_BOSS_START_RATE_PER_PLOT_DAY` = **0.006 events per plot-day** for a 24-hour
crop, tilted mildly down for shorter grow times (`EPIC_BOSS_START_TIME_TILT` = 0.15, so a
4-hour crop earns 76% of that daily rate), and spread back over one grow cycle to give the
per-harvest chance. Calibrated against 75 plots at 75% uptime drawing one event per ~3
days, with a casual 8-plot patch at half uptime waiting about six weeks.

75 plots is a dedicated patch, not a ceiling. The farm upgrades 30→40→50→60→70
(`SIZE_TIERS`) and the server caps plots at `MAX_FARM_PLOTS` = `floor(70/4)²` = **289**.
That cap is derived and exact; the **~200** quoted below as what a real farm is left with
after buildings, the zombie patch and walking room is an *estimate* that has never been
checked against an actual maxed layout, so read it as an order of magnitude rather than a
calibration target. The rate is linear in plot count and nothing else damps it:

| plots | uptime | days to a lure | share of time an event is running |
|---|---|---|---|
| 8 | 50% | 41.7 | 25% |
| 40 | 75% | 5.6 | 72% |
| 75 | 75% | 3.0 | 83% |
| 200 | 75% | 1.1 | 93% |

The gate bounds *frequency* — a lure rolls only with no event running, and an event runs
14 days, so no farm can draw more than one per 14 days. It does not bound *uptime*, which
is the right-hand column: a large farm is rarely eligible to roll and equally rarely
without an event.

The figure that decides whether any of this is felt is the plot count at which the
expected wait falls below the 14 days an event lasts — below it the lure is noise, above
it events run back to back. That is about **a dozen plots** of one favourite (11.9 for a
24-hour crop, 15.6 for Broccoli's 4-hour one), and it saturates by thirty. The feature
switches on across a narrow band.

The high-uptime end is accepted rather than damped — but **not** for the reason
originally given here, which its own arithmetic contradicts. That argument was that a
running event is a ten-rung grind whose real gate is **token supply**, so a farm large
enough to keep an event permanently live spends most of it unable to afford attempts. A
ladder costs an ordinary army ~45 attempts, and a favourite crop pays 0.11–0.33 tokens
per plot-day, so 45 attempts' worth of tokens arrives inside a single 14-day event at
~10 plots of Pumpking, ~12 of Garlic, ~29 of Potato:

| favourite | tokens / plot-day | plots for ~45 attempts in one event |
|---|---|---|
| Potato, Lima Beans, Dragon Fruit (24 h) | 0.109 | 29 |
| Garlic (8 h) | 0.250 | 13 |
| Venus Flytrap (6 h) | 0.291 | 11 |
| Broccoli (4 h) | 0.325 | 10 |
| Pumpking (8 h) | 0.328 | 10 |
| Corpse Flower (6 h) | 0.333 | 10 |

That is the same band the lure turns on in. Token supply stops binding at roughly the
farm size where events begin to overlap, so it cannot be the thing that makes the overlap
harmless. What is actually accepted is the overlap itself, on the judgement that a
permanently available grind is a fair return for a farm given over to one crop. If a
playtest contradicts *that*, a cooldown after an event *ends* is the lever which caps
uptime at any farm size; scaling the rate down is the wrong one, since it hits the casual
patch hardest and the large farm least.

Three invariants hold the pairings (`favoriteCrops.test.ts`): a favourite crop never
unlocks *after* its boss, no crop is two bosses' favourite, and every favourite grows for
at least four hours — a flat per-plot-day rate would otherwise force a 15-minute crop to a
~1-in-50,000 per-harvest chance, which is arithmetically right and invisible in play.

The pairings are surfaced in two places: the boss's own card in Market → Epic Boss (which
switches its wording between the lure and the token bonus depending on whether that event
is running), and the Farmer's Guide's Combat page. Not in the Zombie Almanac — that is a
species collection, and a boss is not a species.

Unlike the token roll, **the lure is the server's** (`maybeLureEpicBoss` in
`server/src/v3/engine.ts`), rolled while the Worker replays the harvest it already
grow-gates. A token is worth one brain; a lure is worth the boss's whole activation price
and reopens its prize quest chain, which is not something to hand an edited client. An
Insta-Harvest rolls every plot it pulls but can start at most one event. The luring crop
is stored in `epic_boss_runs_v3.started_crop` (migration `0054`) and projected as
`startedCrop`; a bought run leaves it empty, which is how the client tells the two apart
when it opens the start announcement (`src/ui/panels/epicBossStart.ts`).

Tokens can be
hoarded during the run, but expire when that boss event ends. Damage survives an escape.
If two hours elapse from the first attempt at the current level, that level returns to
full HP. Winning advances immediately to the next full-health level. A fight begun
before an event or encounter boundary may finish normally.

The farm Boss shortcut appears only for an active run. The Market card shows the event
and encounter timers, token stockpile, level/HP, rewards, activation, and Fight state.

## Rewards

Gold is `max(2, rung) * 100` per cleared rung — 200 gold at the bottom to 1,000 at the top,
**5,600 for a full ladder**. That total is deliberately identical to what the 20-rung curve
paid: each rung merges two of the authored ones, so its payout is the two it replaced added
together, and the gold economy is untouched by either cut.

Brains are a **roll**, not a schedule. An epic event is not a brain faucet: activating one
costs 3-5 brains and every attempt past your harvested tokens costs another, so the old
guaranteed 5 per full clear meant a player came out ahead simply by finishing, and the event
quietly became one of the better brain sources in the game. Brains are meant to stay scarce
(income moves from ~1.6/day at level 4 to ~2.9/day at 44 by design), and an event's real
payment is its prizes: the zombies, the decor and the pet.

- **8%** per cleared rung (`EPIC_BRAIN_DROP_CHANCE`), worth 0.72 brains across the first nine.
- **Guaranteed** on the final rung, so the clear that ENDS a ladder always pays something
  certain rather than being the one fight that can hand back nothing. (`maxLevel`
  parameterises this, so an event of a different length puts the guarantee on its own last
  fight.)
- Expected haul for a full clear: **1.72 brains** against a 3-5 brain entry, so the event
  stays reliably brain-negative.

A cleared rung also rolls for a **Brain Ticket** at 1.5% per rung — 1.5% on rung 1, 13.5% on
rung 9, guaranteed on the last, 1.675 over a full clear. A Brain Ticket is a 10,000-gold
Market item (level 20) that turns an invasion elite, so this is deliberately a *gold*-side
reward: the event is priced in brains and pays out in prizes, and this gives the deep rungs
something a player feels without touching that separation.

The brain roll is the **server's** wherever the server owns the balance. The finish response
carries what the clear actually paid (`currency`), and an online client must print that
rather than re-deriving it — its own roll would disagree with the one the balance moved by,
most of the time. Offline there is only one roller. All of this is in addition to the loot
rolls and quest rewards.

Each boss uses its own recovered quest milestones, decor pool, and tame pet, re-cut onto the
10-rung ladder: **the first prize zombie sits at rung 5 and every top prize at rung 10**, so
each one keeps the fraction of its ladder it always had. Groundhog's chain grants Dr. Zombie
and an Invasion Voucher (rung 5), one brain (8), then Golden Dice and Omega Dr. Zombie (10),
plus five brains for its eight-piece decor set. Loco Locust grants Bandido Zombie (5) and
Vagabond Zombie (10), Bully Frog grants Captain Zombie (5) and Admiral Zombie (10), Foul Owl
grants Christmas Ghost Zombie (5) and Scrooge Zombie (10), Rocky Rhino grants Brock Coley
(5), General Larvaelus grants Proto Zombie (5) and Zombug (10), Mystical Mamba grants
Zomdini (5) and Zomtar (10), and Skunkarella's four-card quest (rungs 2-5) grants Diva
Zombie with Madame Zombie at the top. Loco Locust and Foul Owl run the long recovered chains,
paying brains and Golden Dice on rungs 3, 4, 5, 7, 8 and 9.

A top-prize quest pinned to rung 10 is why migration `0051` has to clamp a run parked above
it: left alone, such a run would display as "Level 15/10", never satisfy that quest, and be
marked complete on its next win with the omega zombie unclaimable.

Admiral Zombie is a **rebalance, not recovered data** (`tools/reforge_economy.py`
SPECIAL_STAT_REBALANCE): it shipped as a strictly worse Captain Zombie — same 21 str and
38.5 con, but dex 2 against the Captain's 2.65 — so Bully Frog was the one ladder whose top
prize was a downgrade on the prize you got at the bottom of it. It keeps dex 2.9 against the
Captain's 2.65 through the 2026-09-07 re-fit (now 18 / 2.9 / 41 against the Captain's
17 / 2.65 / 37), edging it on both axes. These
named zombies are reward-only catalog units: they never appear as purchasable zombie crops.
They can enter the Zombie Pot in slot 1 only, like every special, and come back out as
themselves wearing slot 2's mutations (both parents consumed — nothing is cloned). A reward joins
the farm when an army slot is open; otherwise it is filed in **Received**, where it
waits until the player claims it into a free Mausoleum slot. A full farm can never
destroy an earned unit — but it no longer overflows the Mausoleum either, so claiming
one may mean selling or deploying something first.
Until exact binary loot selection is recovered, each victory makes **two independent 35%
rolls** (`EPIC_LOOT_ROLLS`), preferring unlocked uncollected drops. The 35% rate is the
authored one and stays put — it was calibrated when a ladder was 40 rungs long, so it is the
number of ROLLS that moves as the ladder shortens, not the odds of each. One roll per rung
on a 10-rung ladder would hand over a quarter of the decor for the same event; two restores
the haul to ~7 items over a full clear.

Two rolls at 35% rather than one at 70%, even though the expectation is identical: a single
roll can only ever pay ONE prize, so a shorter ladder means fewer chances to see a *new*
item and a collection that fills more slowly. Two rolls can drop two different prizes from
one clear — the second re-picks with the first already excluded — which is what keeps a
10-rung event able to finish a collection at all.

Within the pool the pick is **weighted by the rung that unlocks each prize**
(`epicLootWeight` = `1/level`, fed to the binary's cumulative frequency pick), so the ladder
is a rarity ladder: the first prize lands far more often than the top-rung signature item. It
was a uniform pick, which made the last prize exactly as likely as the first — climbing bought
no better odds on what climbing unlocks. Monotone-in-level is all this claims; the curve
itself is a reimplementation choice, not recovered data.

"Collected" spans every place a prize can sit — unclaimed, in the shed, or already placed
on the farm. Reading only the unclaimed bucket made a claimed prize look never-won, so
owned decor kept crowding out prizes the player had never seen. Decor duplicates become
possible only after eligible decor is genuinely collected, and a pet leaves its boss's
pool once owned. Ambiguous source `reward: 5000` and `xp: 5500` fields are not granted.

Epic quest progress is lifetime progress: only the active boss's recovered quest family
is surfaced, and it is hidden between events without being discarded. Earned rewards
and completed quests are permanent. Bosses whose shipped quest data is missing still
retain combat, loot, pet, and completion progression.

## Authority and persistence

Offline state is optional in the versioned save, so older saves default to no event.
Online play stores the current run and one-use fight sessions in D1. Activation spends
brains atomically. Start pins level, HP, roster, combat configuration, ruleset version and
server time; finish deterministically replays the input transcript and applies casualties,
damage, loot, quests, roster rewards, inventory, pet ownership, the graveyard row and
balance once. An unfinished session can be reopened with its pinned attack order until its
short expiry; expiration resolves it as an escape and unlocks the roster. Raid and Epic Boss
sessions exclude each other.

Everything the server ROLLS rides back in the finish response, because the client cannot
re-roll it and agree: `currency` (the brain), `drops` (every decor prize, plural) and
`brainTicket`. `loot` is still sent as the first entry of `drops` so a `result_json` written
before multi-drop replays correctly on a duplicate finish, and the client falls back to it
when `drops` is absent.

## Asset provenance and future work

`tools/prep_all_epic_bosses.py` generates eight namespaced catalogs from the source
gameplay files and extracted app bundle. The first five bosses use their authored
enter/idle/attack/defeat/escape/fly strips. EPB 8-10 use static revealed art because
their frame metadata was not present; their full source sheets are retained for future
reconstruction. `tools/prep_placeables.py` exposes 50 boss decorations as reward-only
farm objects, and `tools/prep_quests.py` recovers Bully Frog's three unambiguous embedded
quest records.

The remaining fidelity gaps are the missing EPB 8-10 animation/gameplay metadata and
corrupt or absent late quest data. See
`docs/EPIC_BOSS_ASSET_AUDIT.md` for the exact actor, UI, reward, pet, effect, and audio
mappings and the metadata that is genuinely still missing.
