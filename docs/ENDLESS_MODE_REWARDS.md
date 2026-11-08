# Endless Mode Rewards

The owner's reward design for Endless Mode. It was agreed in design sessions in October 2026
and was not written down anywhere in the repo until now. "Status" says what the code does
today; everything marked **not built** is intent, not behaviour.

## Three reward tracks

1. **Depth gold**, paid when the run ends.
2. **Repeatable loot**, rolled on every win.
3. **First-clear milestones**, paid once per account per mode, the first time a boss tier is
   beaten. "Rewards are larger the first time a milestone is reached."

A run costs 1 brain (Nightmare 3), and zombies lost in a run come back when it ends.

## Depth gold

**Status: built.** Each cleared floor pays 250 gold x its tier number and each boss 500 x, so a
tier still pays 1,000 x its number on the three-fight tier: 1,000 through T1, 3,000 through T2,
28,000 through T7. Ending a run early pays in full.

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

Players may own several. **The owner's rules changed over the design sessions, and the code
follows the older version:**

| | Rule |
|---|---|
| Owner direction (2026-10-19), now in the code | Guaranteed the first time T3 is beaten (a milestone); extra rolls of 5%, 10%, 15%, 20% at T3-T6; guaranteed at every boss from T7, plus 25% for a second |

**Not built:** the double-mutation mechanic. Zwamp Thing should count mutations twice, and at
its maximum be about as strong as a mutated Video Game Zombie.

## First-clear milestones

**Status: partly built.** `endless_progress` tracks each account's best tier per mode, and a tier's
reward pays once, the first time its boss falls.

| Tier | Reward in the code |
|---|---|
| T1 | 2 Brain Tickets |
| T2 | 1 brain |
| T3 | Zwamp Thing |
| T8+ | 3 brains on each new best tier |
| Nightmare T5 | Medusa Zombie |

**T4-T7 are proposed and not built:** +8 Mausoleum slots, +12 storage slots, the farm expansion unlock
and +1 max veterancy. The owner has not confirmed that mapping, and each needs design work: the
capacity rewards touch the derived caps on client and server, the expansion needs pricing, and
veterancy needs a cap and display decision.

Latest full table, written for the original ten-tier ladder:

| Tier | First-clear reward (normal Endless) |
|---|---|
| T1 | 2 Brain Tickets |
| T2 | 1 brain |
| T3 | 5 Brain Tickets |
| T4 | 3 brains |
| T5 | Major reward |
| T6 | 1 brain |
| T7 | +8 Mausoleum slots |
| T8 | +12 storage slots |
| T9 | Unlocks a farm expansion for purchase |
| T10 | +1 max veterancy |
| T11+ | 3 brains on each boss victory |

The owner then cut the ladder to seven tiers (28 fights, for a 30-40 minute run): "tier 7 is the
new tier 10", with the rewards "essentially what they were before". **No seven-tier table was
ever written, so the mapping is an open decision.**

Rulings that go with it:

- T10 pays no brains ("I misspoke").
- The farm expansion needs buying, like the other farm upgrades. It grows the farm by the same
  amount, and costs more than the previous one without scaling as hard.
- Max veterancy going to +6 is fine: "it lets us raise the difficulty of some of the content
  later on". The owner was also considering +1 max veterancy from T10 of each dual invasion.

## Nightmare

**Status: fights, milestones and Medusa are built. Its loot tables and higher Zwamp Thing odds are not.**

- A separate milestone track, with the same kinds of reward. T10 should be nearly impossible.
- Higher Zwamp Thing odds than normal.
- **Medusa Zombie** at T5 (built, ruleset 83, everywhere she fights). Abilities (owner, 2026-11-05,
  replacing the earlier stun-all idea), otherwise standard Girl Zombie abilities:
  - On deploy, freezes a boss on the perch for 5 seconds, stalling whatever it is doing: throws,
    abilities, anything. Greyed out with the stone look. Only a perched boss is affected.
  - On deploy, stuns the first enemy it sees for 2 seconds, with the same grey-out.
  - A boss cannot be frozen again for 20 seconds, so an all-Medusa army cannot lock it down.
- Its own loot tables.

## Curses in the design but not in the pool

"Bosses throw projectiles 50% faster" and "Projectiles do +50% damage" are on the owner's list
and not in `CURSE_POOL`.

## Open decisions

1. The seven-tier milestone mapping.
2. Whether T8+ pays 3 brains on **every** boss win or only on a new best. The code pays on a new best;
   on every win, entry would stop costing anything for players who reach it.
