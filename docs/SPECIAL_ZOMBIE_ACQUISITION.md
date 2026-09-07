# Special zombie acquisition

The runtime catalog contains 56 zombies in the Special category. Every one has a
reachable acquisition route; Epic-event rewards and voucher gifts are deliberately
excluded from the plantable zombie Market.

The routes below account for all 56: 15 Epic Boss rewards, 5 plantable Market crops,
2 voucher-exclusive, 6 combine-only, and the remaining **28 obtainable only through the
Black Market** — every one of those is `marketHidden: true` and has no planting route at all.

## Epic Boss events (15)

Every event runs a **10-rung ladder** and pays two prize zombies: the ordinary prize on
rung 5, the omega on rung 10 (`EPIC_PRIZE_RUNGS` in `tools/prep_quests.py`). The rungs
below are the CURRENT ladder's — ZF2 authored these quests against a 40-rung ladder and
`rescale_epic_ladder` maps them onto 10, so the source's 5/10/15/20/40 thresholds are not
what ships.

| Event | Milestone | Zombie |
|---|---:|---|
| Dr. Groundhog | 5 | Dr. Zombie |
| Dr. Groundhog | 10 | Omega Dr. Zombie |
| Loco Locust | 5 | Bandido Zombie |
| Loco Locust | 10 | Vagabond Zombie |
| Bully Frog | 5 | Captain Zombie |
| Bully Frog | 10 | Admiral Zombie |
| Foul Owl | 5 | Christmas Ghost Zombie |
| Foul Owl | 10 | Scrooge Zombie |
| Skunkarella | 5 | Diva Zombie |
| Skunkarella | 10 | Madame Zombie |
| Rocky Rhino | 5 | Brock Coley |
| Rocky Rhino | 10 | Brock Coley |
| General Larvaelus | 5 | Proto Zombie |
| General Larvaelus | 10 | Zombug |
| Mystical Mamba | 5 | Zomdini |
| Mystical Mamba | 10 | Zomtar |

Sixteen milestones, **15 distinct zombies**: Rocky Rhino is the one event that pays the
same zombie on both rungs (see `recovered_epic_rewards` in `tools/prep_quests.py` — its
rung-10 prize is a second Brock Coley rather than an invented eighth omega).

Two caveats the table cannot show:

- **Skunkarella's Diva** is a collection chain — quest `5000` ("Collect Em All") needs
  rungs **2, 3, 4 and 5**, its four "Prize Cards", not just rung 5. It is the only event
  in the game that works this way, and it is authentic ZF2 (the source authored it on
  rungs 5/10/15/20). Rung 5 is listed above because that is where the quest completes:
  the ladder advances one rung per win from 1, so reaching 5 necessarily clears 2-4. The
  per-card breakdown lives on the quest rail; the Market note is deliberately just
  "Level 5" (`epicZombieRewardNotes`).
- **Epic quests re-open on each activation**, so a boss already finished can be run and
  paid out again (`reopenEpicQuests`). Progress is otherwise LIFETIME progress and
  survives the event expiring.

These are granted directly to the deployed farm roster when there is room. When the
deployed army is full the reward is filed in **Received** instead: it is not in the
roster yet, and claiming it from the Storage panel takes a real Mausoleum slot, so a
player with no Mausoleum (or a full one) must make room before the unit can join. The
reward is never destroyed — it waits in Received indefinitely. They cannot be bought,
planted, seeded by migration, or used to duplicate themselves in the Zombie Pot.

## Market: Special zombie crops (5)

These five permanent specials cost **5 brains** to plant (the 50-brain figure predates the
brainflation revert). Their unlock levels are **not** uniform, and are not level 20 — that
figure is the Black Market *delivery* gate below, not the planting gate. Per `zombies.json`,
most `Tier5` crops unlock at level **1**; `ZombieActorRegularTier5` at **15** and
`ZombieActorLargeTier5` at **20**.

Selling one now pays **gold, not brains**: a brain-priced zombie sells for 1,000 gold per brain
of its cost, so a 5-brain special returns 5,000 gold.

- Bombie, Crazy Zombie, Cupid Zombie, Dapper Zombie, and Granny Zombie.

## Market: Video Game Zombie (Normal tab)

The pixel zombie of the *Zombies vs Video Games* invasion is plantable as an **ordinary**
zombie — `category: "normal"`, group Regular, the tier-less Yellow class — not a sixth
special. It costs **6 brains**, unlocks at **level 43** (the invasion's own unlock level)
and grows in 24 hours. Its stats (20 / 2.1 / 29 / 100) sit one step above the Crazy
Zombie's, making it the strongest plantable zombie by a small margin. Being normal, it can
go in either Zombie Pot slot and carries no Black Market special gate. Its art is a
seven-frame flipbook rather than a paper-doll rig, so it wears no mutation art (the
mutation and its stat bonus still apply). Authored in `tools/prep_market.py`
(`AUTHORED_ZOMBIES`) and `tools/prep_assets.py` (`export_video_game_zombie`).

## Market vouchers (4)

These can also be obtained by buying and using a boost rather than planting the
zombie (Crazy and Cupid retain both routes):

| Market item | Zombie |
|---|---|
| Crazy Zombie Voucher | Crazy Zombie |
| Valentine Gift | Cupid Zombie |
| Valentine Gift 2012 | Pink Cupid Zombie |
| Flower Zombie Pot | Green Flower Zombie |

Each voucher is limited to one owned copy of its exact result. The 2012 gift uses
the distinct pink Cupid actor, not the ordinary Cupid actor.

## Black Market (28)

The only route for the 28 `marketHidden` specials — ZomBetty, ZomBloke, George Washington,
John Hancock, Mummy Zombie, ZomHelga, Zombeach Bum, Zula Girl, Skittles, Zwamp Thing,
Zcarecrow, Zanta Clause, Diver, JackoZombie, Reindeer, Teddy, Forest, Medusa, Old McZombie,
Zastronaut, Deputy, Master Ninjombie, MerZombie, Ninjombie, Omega Zombie Bot, Poseidon,
Sheriff, and Zombie Bot. Another player escrows the zombie as a `SELL_ZOMBIE` order, or fills
a `BUY_ZOMBIE` request.

**Thirteen of those 28 also drop from invasions** and are therefore reachable solo: Old McZombie
(Old McDonnell's), Diver (Summer Break), Forest (Tree World) and Teddy (Valentine's Day) at 1%
each; Deputy / MerZombie / Ninjombie / Zombie Bot from an ordinary win of the Lawyers / Pirates /
Ninjas / Robots (1.2 / 1.4 / 1.6 / 1.8%), with Sheriff / Poseidon / Master Ninjombie / Omega
Zombie Bot paid *instead* on an elite (Brain Ticket) win of the same raid (2.5x: 3.0 / 3.5 /
4.0 / 4.5%); and Zastronaut from the Aliens (2%). See `src/raid/zombieDrops.ts` and the rare-zombie section of
`docs/mechanics/RAID_TIMING_AND_HAZARDS.md`. A hidden per-prize pity makes that route bounded:
100 wins of a raid without its zombie guarantees it on the next. Nothing in the game says so.

Delivery is gated on the **recipient**, checked pre-flight and re-checked as a SQL guard inside
the fulfillment transaction (`server/src/rosterCatalog.ts`, `server/src/v3/blackMarket.ts`):

- **Player level 20** for any `special`-category zombie (`BLACK_MARKET_SPECIAL_LEVEL`); a failure
  returns `403 black_market_level_locked`.
- **Player level 1/15/25** for the Blue/Red/Silver colored classes (29 units across the catalog
  carry a `className`), matching the level that unlocks each class's gravestone. The gravestone
  does not need to be owned or placed. A failure returns `403 black_market_level_locked`.

Note the framing difference from the rest of this document: the Black Market **bypasses ordinary
crop unlock levels entirely**. Level 20 for specials and the class-level thresholds for colored
zombies are the *only* gates, so a zombie whose planting route would be locked can still arrive by trade.

## Combining

**Slot 1 decides the output species.** Whichever zombie the player puts in the Zombie
Pot's first slot is the type that comes out; slot 2 contributes only its mutations
(combined per anatomical slot, with the higher-tier bit winning a same-slot conflict).
Combat tier and mutant/veggie status no longer affect the result, and the promotion
roll below is the only randomness left in species selection.

**A matched pair climbs the colour ladder.** Two parents of the **same species** breed
one colour class up, within their own body type:

| Pair | Result | Gate |
| --- | --- | --- |
| Green + Green | that body type's **Blue** (Zyborg, Zmurf, ZomBeauty, ZomBruiser, Kindlehead, ZomBotanist) | the **Blue Grave** is placed |
| Blue + Blue | its **Red** (Zombot, ZomGoblin, Amazombie, ZomBrute, Flamehead, Flower Zombie) | the **Red Grave** is placed |
| Red + Red | its **Silver** (Robo Zombie, Imp Zombie, Zombielocks, Zombarian, Party Zombie, Zombee) | player level 25+ |

The grave gate is the same one that unlocks planting that class, checked when the
result is derived (client: `Field.hasGrave`; server: its own placed objects), so a
combine can never hand out a colour the farm has not unlocked. A step whose gate is
closed falls through to the ordinary rules, taking nothing away.

The **colour class** is authoritative here, not the `Tier<n>` token in the key — the
mutants were deliberately re-banded (Lima Beans is a Silver under a `Tier2` key, Celery
a Red). A matched pair that is already Silver — including the mutant silvers Eyebiscus
and Heartichoke — keeps its own species rather than flattening to its group's plain
silver.

At player level 25 and above, two **non-special** zombies whose body types both map to
a combining-only special have a 25% chance to promote the output to **slot 1's** tier-5
special: Garden produces Zombutterfly, Large produces Zomviking, Small produces
Zombricaun, Female produces Zombelly Dancer, Regular produces Zombotron, and Headless
produces Skull Head. This roll sits **between** the ladder's rungs: the Green and Blue
steps are resolved first (so a green pair breeds to blue rather than leaping to a
special), and the roll then takes precedence over the Red -> Silver step, so a matched
Flamehead pair usually yields a Party Zombie and rarely a Skull Head. A failed roll
falls through to the ordinary rules.

A named special is a permanent output type: it may only be placed in **slot 1** (the
Pot refuses to start otherwise, client and server), and it is always inherited. Two
specials cannot be combined, and Epic/event `rewardOnly` zombies cannot enter the pot
at all.

> Note: this replaces the recovered `determineBaseClass` rules (non-veggie parent wins,
> then higher combat tier, then a coin flip on a tie — see the zombie-pot disassembly
> notes). Slot-1-wins is a deliberate design divergence from the source game, chosen so
> the player controls the result instead of the catalog doing it for them.

### What the combine quests credit

Quests 21 and 22 ("Cook Up Some Zombies" / "…Some More") ask for each of the six
silvers by name, via `kCombinerHarvestedNotification`. That event is emitted **only
when the child's species is one neither parent was** — a matched pair breeding up, or
the tier-5 roll (`isCombinePromotion` in `src/zombie/combineSpecies.ts`, applied by
both the client pot and the authoritative combine command).

Because slot 1 wins by default, an unconditional event let a player who already owned a
Zombarian — bought as a zombie-field seed, won, or gifted — re-cook it against anything
and collect the same Zombarian back out, closing the objective without breeding
anything. (The source game had the same hole for a different reason: a silver paired
with any veggie mutant won `determineBaseClass` deterministically.) Requiring a real
promotion is another deliberate divergence.
