# Endless Mode Rewards

The owner's reward design for Endless Mode. It was agreed in design sessions in October 2026
and was not written down anywhere in the repo until now. "Status" says what the code does
today; everything marked **not built** is intent, not behaviour.

## Three reward tracks

1. **Depth gold**, paid when the run ends.
2. **Repeatable loot**, rolled on every win.
3. **First-clear milestones**, paid once per account per mode, the first time a boss tier is
   beaten. "Rewards are larger the first time a milestone is reached."

A run costs 1 brain (Nightmare 3), except the first normal run an account starts each day
(UTC), which is free (owner, 2026-11-08; `endlessFreeDayStart`). Zombies lost in a run are gone
for good, as on any invasion (owner, 2026-11-10): when the run ends, the server buries everyone
still down (graveyard + roster delete, like an Epic Boss) and the client drops them.

## Depth gold

**Status: built.** Each cleared floor pays 450 gold x its tier number and each boss 900 x, so a
tier pays 1,800 x its number: 1,800 through T1, 5,400 through T2, 50,400 through T7, 64,800 through
T8. Cut from 625 / 1,250 on 2026-11-10 (owner: about 100k for a 45-minute run was too much; aim for
50k at T7). Ending early pays in full.

## Repeatable loot

**Status: built for normal Endless. Nightmare pays no loot yet.** Tables are in
`src/raid/endlessLoot.ts`.

- **Ordinary floors** (owner, 2026-11-05, replacing "normal waves just grant gold"): one small
  roll per win. Smaller bundles than a boss, and no cosmetics or Zwamp Thing.
- **Bosses:** one full roll per win from the tier's boss table, which stops changing at T10.

Owner's guidance for the tables:

- Early tiers lean on small Harvest and Plow bundles and tickets. Later tiers lean on Golden
  Dice, Brain Tickets and larger Grow bundles.
- Grow comes in steps of five, at least 5, usually 10. x20 is T7+ only.
- By T5: 5% Grow, and Harvest and Plow at x3.
- "The loot shouldn't be too insane, though, as this is rather farmable."

## Zwamp Thing

**Status: built (owner, 2026-11-08).** Players may own several. The first T3 clear pays one (a
milestone). After that, each boss rolls: 5% at T3, 7.5% T4, 10% T5, 12.5% T6, 15% T7. A run that has
had none by T7's boss is given one there, and from T8 every boss pays one. A repeat run through T8
averages about two (`endlessExpectedZwamps`). Zwamp Thing counts its mutations twice (`MUTATION_SCALE`):
fully mutated it fields about 27 str / 40 con at 3 dex, against a fully mutated Video Game Zombie's
38 / 47 at 2.1 dex, the same damage per second.

## Location rare zombies

**Status: built (owner, 2026-11-08).** Every normal-Endless win also rolls for the location's own
invasion zombies, at that invasion's ordinary rate (`rollEndlessLocationZombie`): the Pirate Ship
1.4% (MerZombie or Poseidon), the Ninja Dojo 1.6% (Ninjombie or Master Ninjombie), Alien Landing 2%
(Zastronaut or Cozmonaut), Video Game 2% (Video Game Zombie or a Boss Zombie colour), the Farm 1%
(Old McZombie). A hit is the ordinary prize two times in three, the promoted one otherwise.

## Brains on every win

**Status: built (owner, 2026-11-10).** Every normal-Endless win, floor or boss, has a flat 5% chance
to pay 1 brain on top of its loot, the same at every tier and location (`ENDLESS_BRAIN_DROP_CHANCE`).
It came back in exchange for fallen zombies staying lost for the rest of the run. A run through T8
(24 wins) averages 1.2 brains, about its entry cost.

## First-clear milestones

**Status: built (owner, 2026-11-08).** `endless_progress` tracks each account's best tier per mode,
and a tier's reward pays once, the first time its boss falls (`endlessMilestoneRewards`). T5-T8 are
permanent unlocks, all read off one number, `endlessBestTier` on the gameplay core document, which
every normal-Endless boss win raises (`src/raid/endlessPerks.ts`). T8 is the stretch tier, the last
real reward; deeper tiers are for leaderboard chasers (owner: "This content is in part designed to
push people's builds").

| Tier | Reward |
|---|---|
| T1 | 2 Brain Tickets |
| T2 | 1 brain |
| T3 | Zwamp Thing |
| T4 | 3 brains |
| T5 | +8 Mausoleum slots, on top of whatever Mausoleum stands (none placed = still no crypt) |
| T6 | +16 shed slots |
| T7 | The 80x80 farm goes on sale: Gargantuan 'ol Farm, 4,000,000 gold or 30 brains. Gated by the unlock alone: its level is 70x70's (41) |
| T8 | Legend veterancy: a sixth rank at 6 survived fights, +5% more, so +30% in all (Master is +25%) |
| T9+ | +16 more shed slots for each new deepest tier (owner, 2026-11-08: storage, not brains) |
| Nightmare T5 | Medusa Zombie (Nightmare is held, see below) |

Where each unlock is enforced:

- **Mausoleum:** Worker `placedCapacity` (engine.ts) and the Black Market's `CRYPT_CAP` SQL;
  client `ZombieField.mausoleumCap`.
- **Shed:** Worker `shedCapacity`; client `refreshShedCap` and the object reconcile in main.ts.
- **80x80:** Worker `shop.size` rejects it as `locked`; the Market card reads "Clear Endless Tier 7".
  The tier lives in `ENDLESS_SIZE_TIERS` (tools/reforge_economy.py), off the farm ladder's x5 curve.
- **Legend:** `buildPlayerUnits({ maxVetRank })`, passed from the account's core document by every
  Worker fight (raids, Endless, Epic Boss, both sides of a friend invasion) and by the client's
  own; display reads the signed-in account's ceiling.

## Nightmare

**Status: held for a later release (owner, 2026-11-08).** `ENDLESS_NIGHTMARE_LIVE` is off: no
Nightmare run can start (the server answers 404 `mode_closed`) and the client shows no Nightmare
button or board tab. Fights, milestones and Medusa are built; its loot tables and higher Zwamp
Thing odds are not, and are what turning it on needs besides the flag.

- A separate milestone track, with the same kinds of reward. T10 should be nearly impossible.
- Higher Zwamp Thing odds than normal.
- **Medusa Zombie** at T5 (built, ruleset 83, everywhere she fights). Abilities (owner, 2026-11-05,
  replacing the earlier stun-all idea), otherwise standard Girl Zombie abilities:
  - On deploy, freezes a boss on the perch for 5 seconds, stalling whatever it is doing: throws,
    abilities, anything. Greyed out with the stone look. Only a perched boss is affected.
  - On deploy, stuns the first enemy it sees for 2 seconds, with the same grey-out.
  - A boss cannot be frozen again for 20 seconds, so an all-Medusa army cannot lock it down.
  - On her card (built 2026-11-08) the two are **Stone Gaze** (slot 3, in place of Random Stun:
    "One look and they freeze") and **Petrify** (slot 4, in place of Double Strike: "Stops the
    boss in its tracks"). Each opens with its Life Force slot, like every other ability.
- Its own loot tables.

## Curses in the design but not in the pool

"Bosses throw projectiles 50% faster" and "Projectiles do +50% damage" are on the owner's list
and not in `CURSE_POOL`.

## Open decisions

None for the milestones: T4-T7 and T8+ were settled on 2026-11-08 and are for tuning now.
