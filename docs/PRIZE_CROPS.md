# Prize crops and their mutations

Six late-game crops, each with a matching zombie mutation, designed as rewards for the
hardest content (tier clears on the post-45 dual invasions, raids 12-15).

**Status: fully in the code, NOT in the game.** `PRIZE_CROPS.live` in
`src/cropUnlocks.ts` is `false`. While it is, none of this is reachable by a player.

## The six

| Crop key | Name | Base crop | Grow | Seed | Sell | XP | Unlock |
|---|---|---|---|---|---|---|---|
| `golden_carrot` | Golden Carrots | carrot | 30 min | 90 | 108 | 4 | raid 12 (Farmers + Lawyers) t5 |
| `golden_turnip` | Golden Turnips | turnip | 24 h | 230 | 375 | 11 | raid 12 t10 |
| `obsidibeans` | Obsidibeans | lima beans | 48 h | 330 | 530 | 13 | raid 13 (Pirates + Ninjas) t5 |
| `cauliglower` | Cauliglower | cauliflower | 24 h | 190 | 315 | 11 | raid 13 t10 |
| `cosmic_potato` | Cosmic Potatoes | potato | 48 h | 320 | 520 | 15 | raid 15 (Robots + Aliens) t5 |
| `brainato` | Brainatoes | tomato | 8 h | 90 | 152 | 10 | raid 15 t10 |

Raid 14 (Circus + Video Games) has no crop yet.

### The rule behind the numbers

Every prize crop takes **twice** its base crop's grow time and pays **50-75% more** than a
regular crop of the same duration at level 40 (gold crops lean gold, XP crops lean XP).
The baseline is a fit over the 25 rebalanced regular crops:

    net  = e^(1.28 + 0.019*level) * hours^0.725        (net = sell - seed - 10 plow)
    xp+1 = e^(0.88 + 0.012*level) * hours^0.22

`src/prizeCrops.test.ts` checks every row against it (a 1.4-1.85 band, after rounding).
The data lives in `tools/reforge_economy.py` (`PRIZE_CROPS`); `tools/prep_market.py` merges
the rows into `plants.json` on every run.

**Fertilizing:** a Garden-fertilized harvest pays `sell` twice (XP is not doubled), so a crop
with a high sell/net ratio gains most. Golden Carrot is seeded at 90/108 (ratio 13.5, like
Skellyberry) so Meat Flower cannot out-earn it once most plots are fertilized.

## The six mutations

One significant stat plus one minor one; the two crops sharing a slot play different roles.
Dex is deliberately rare (today's best dex is already 4).

| Mutation key | Name | Slot | Stats | Role |
|---|---|---|---|---|
| `goldencarrot` | Golden Carrot-eyed | hair/eye | str +2, dex +2 | quick, hard-hitting |
| `cauliglower` | Cauliglower | hair/eye | con +4, str +1 | tank |
| `goldenturnip` | Golden Turnip-Arm | arm | str +4, con +1 | damage |
| `obsidibeans` | Obsidibeans | body | con +5, str +1 | tank |
| `cosmicpotato` | Cosmic Potatohead | head | con +3, str +2 | tank |
| `brainato` | Brainato | head | str +3, dex +2 | attack |

They are `PRIZE_MUTATIONS` in `src/zombie/mutations.ts`, appended to the catalog only when
the switch is on, so they take bits 16-21 and no existing bit moves. Each prize crop grows
its mutation through `PRIZE_CROP_MUTATIONS` in `src/zombie/cropMutations.ts`.

## How it is kept out of the game

| Surface | While not live |
|---|---|
| Client crop catalog | `src/assets.ts` drops `prize: true` rows at load: no art fetched, no card |
| Market + quest pool | `cropAvailableInMarket` is false for them |
| Worker `farm.plant` | `cropUnlocked` is false whatever the ladder says -> `locked` |
| Mutation catalog | not appended: no bit, no almanac / Pot / Black Market / harness effect |
| Crop adjacency | `PRIZE_CROP_MUTATIONS` not merged into `CROP_MUTATIONS` |
| Rig art offsets | `prize_mutations.json` is not loaded |

The server's generated crop catalog (`server/src/catalog.ts`) does contain the rows; the
planting check is what keeps them closed.

## To ship them

1. Set `PRIZE_CROPS.live = true` in `src/cropUnlocks.ts` (client and Worker both read it).
2. Turn `DUAL_PRACTICE` off (`src/raid/practice.ts`): practice records no tier clears, so
   nothing would ever unlock.
3. **Bump the raid ruleset** (`RAID_RULESET_VERSION`): the mutations change zombie stats.
4. **Re-run the difficulty harness.** Flat adds help weak bodies most; check the dex 4
   ceiling and the lossless-difficulty targets before shipping.
5. Deploy the Worker (the planting gate and the catalog), no migration needed (an unlock is
   derived from the existing `raid_state_v3.tier_json`).
6. **Re-check mutation growth odds.** A crop's chance to grow its mutation is now Life Force based (`cropMutationChance` in `src/lifeForce.ts`: 5% + 10% per Life Force level), not the old flat 25%. Check prize-mutation growth feels right at typical farm Life Force levels (the production median farm sits around Life Force level 2-3, i.e. roughly 25-35%).
7. Check `MutationTier` (1-4 only, presentation) and Black Market / almanac copy for the new
   names, and whether a first clear of t5/t10 should also pay anything else.

## Regenerating the art

    python tools/prize_crops.py            # prototype sheets only -> tmp/variants
    python tools/prize_crops.py --install  # real assets into public/assets (deterministic)

`--install` writes the crop stages, crop icons, mutation rig parts (loose PNGs under
`public/assets/zombie/mutations/`), flask icons, `prize_mutations.json`, and refreshes the
prize rows in `plants.json`.
