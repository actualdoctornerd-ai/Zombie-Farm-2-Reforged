#!/usr/bin/env python3
"""The Reforged economy's price rules, shared by every prep_*.py generator.

BRAIN PRICES — the "brainflation" retune
----------------------------------------
ZF2 inflated ZF1's brain prices tenfold: a ZF1 item costing 5 brains was priced at
50 in ZF2. Reforged undoes that, so a brain stays a rare, high-value currency and
typical prices sit in the 1-5 range (the premium Pet Brain, 500 in source, is 50).

The retune was originally applied to the checked-in assets BY HAND and never taught
to the generators, so re-running prep_market / prep_boots / prep_upgrades /
prep_placeables silently reverted it — 55 zombies, 5 boosts, 3 farm-size tiers and
121 placeables all snapped back to their ZF2 prices. Every generator now routes
brain prices through brain_price() so a regeneration is a no-op.

prep_pets.py had this rule right from the start; this module is that rule, lifted
out so there is exactly one copy of it.

GOLD PRICES are NOT retuned — they pass through from source untouched, EXCEPT for
the regular crops, which take the crop rebalance below.

CROP ECONOMY — the unlock/profit/XP rebalance
---------------------------------------------
ZF2 unlocks all 25 regular crops by level 25 and pays 1 XP for nearly every harvest,
so the back half of the level curve has nothing left to give and crops barely feed
progression. Reforged respreads them over levels 1-45 (the real level cap) on an
explicit profit and XP curve. See zombie-farm-crop-rebalancing-model.pdf for the
derivation; CROP_REBALANCE below is that model's output, and it is authoritative
over Market.json.

Same hazard as the brain retune: prep_market.py joins plants.json against
Market.json and writes cost/sell/level/xp back, so without this table a single
re-run would silently revert the whole rebalance. Grow times are NOT rebalanced and
still pass through from source.
"""

BRAIN_COST_DIVISOR = 10

# key -> (level, cost, sell, xp). `sell` is the model's target harvest value
# (cost + 10 plow + target profit) and `xp` is its total cycle XP minus the one plow
# XP that farmRewards.ts already awards. Seasonal crops are deliberately absent —
# they are outliers and keep their source values until they get their own pass.
CROP_REBALANCE = {
    "carrot":        (1,    5,  16, 1),
    "onion":         (1,   20,  60, 4),
    "tomato":        (3,   10,  31, 2),
    "turnip":        (5,   30,  62, 3),
    "breadfruit":    (9,   20,  35, 2),
    "potato":        (10,  50,  99, 5),
    "sampaguita":    (14,  25,  38, 2),
    "coffee":        (15,  20,  53, 4),
    "candycorn":     (16,  60,  79, 2),
    "venus_flytrap": (19,  80, 111, 3),
    "celery":        (20,  40,  56, 2),
    "Spineapple":    (21,  17,  29, 1),
    "broccoli":      (23,  70,  97, 3),
    "garlic":        (25,  50,  88, 4),
    "Bloodberry":    (27,  55,  72, 2),
    "cauliflower":   (29,  90, 138, 5),
    "skellyberry":   (31,  40,  54, 2),
    "lima_beans":    (33, 120, 191, 6),
    "sun_glower":    (35, 150, 181, 4),
    "dragon_fruit":  (37, 120, 195, 7),
    # Pumpking's seed cost is deliberately far above its source price (142). The
    # profit is unchanged; the larger stake exists to make it a fertilize target,
    # since fertilizing pays out the harvest value a second time.
    "pumpking":      (39, 380, 425, 5),
    "corpse_flower": (41, 200, 240, 5),
    "meat_flower":   (43,  26,  38, 2),
    "eyebiscus":     (44, 100, 158, 6),
    # The capstone is the one entry that sits above the model's own curve: at level
    # 45 the equations give 73 profit / 8 total XP, and it keeps 78 / 9 by decision.
    # Re-derive it by hand if the profit slope is ever retuned.
    "heartichoke":   (45, 125, 213, 8),
}

# Nothing may unlock past the top XP tier. src/GameState.ts XP_THRESHOLDS and
# server/src/levels.ts both stop at 45, so a crop above it would be unplantable.
LEVEL_CAP = 45

# ---- Farm size ------------------------------------------------------------
# Farm-size tiers Reforged ADDS beyond the three the source ships. The source
# ladder tops out at 60x60 from level 31, leaving the last stretch to the cap with
# nothing left to expand into.
#
# Each entry continues the source's own progression rather than inventing a curve:
#
#   size    +10 per tier      40    50     60      70
#   level   +10 per tier      11    21     31      41
#   gold    x5  per tier      10k   50k    250k    1.25M
#   brains  step doubles      6     8      12      20      (+2, +4, +8)
#
# prep_upgrades.py appends these after the extracted tiers AND asserts they still
# continue that progression, so a tier added with an off-pattern price fails loudly
# instead of quietly shipping. Without this table a prep re-run would drop them.
#
# KEEP IN SYNC with SIZE_TIERS in server/src/shopCatalog.ts — the server prices the
# purchase itself and would reject a tier it doesn't know.
EXTRA_SIZE_TIERS = [
    {"name": "Colossal 'ol Farm", "size": 70, "level": 41,
     "gold": 1_250_000, "brains": 20},
]

# ---- Ground skins ---------------------------------------------------------
# Ground/climate skins Reforged ADDS beyond the six the source ships. `terrain`
# must name a row emitted by prep_assets.slice_ground — for a derived skin, a key
# of DERIVED_GROUND_ROWS there.
#
# Priced into the existing gold ladder (stone 1000, dirt 2000, snow/sand 5000,
# water 10000) rather than given a curve of its own, and level 1 like every other
# skin: the ground is pure cosmetics, so the gate is the price.
#
# KEEP IN SYNC with CLIMATE_COST in server/src/shopCatalog.ts, which charges the
# purchase, and with the theme table in src/surroundings.ts, which dresses the
# land around a farm wearing the skin.
EXTRA_CLIMATES = [
    {"name": "Autumn Ground", "terrain": "autumn", "level": 1, "gold": 3000},
    # Sakura sits on the rung the ladder was missing, between the 5000 pair
    # (snow/sand) and the 10000 moon — it is the most elaborate skin in the set
    # (its own trees, its own falling petals) without being the end of the ladder.
    {"name": "Sakura Ground", "terrain": "sakura", "level": 1, "gold": 7500},
]

# ---- Mutant zombies -------------------------------------------------------
# A "mutant" zombie is the pre-mutated unit the market sells: it carries its
# mutation already grown AND a tier-graded body (Green 2/2/2, Blue 5/2/5,
# Red 8/2/10, Silver 12/2/18). The other route to the same mutation is planting
# any zombie beside the matching crop (src/zombie/cropMutations.ts).
#
# ZF2 unlocked each mutant AT or AFTER its crop, which made buying one pointless —
# by then you could grow the mutation yourself for the price of a seed. Reforged
# inverts that: the mutant lands BEFORE its crop, so buying it is the only way to
# get that mutation early, and the crop later becomes the cheap bulk route.
#
# The lead widens with progression, from 2 levels early to 5:
#
#     lead(cropLevel) = min(5, round(2 + 3 * (cropLevel - 5) / 24))
#
# Two places the formula is not applied literally:
#   * Carrot/Onion/Tomato/Turnip — their crops sit at levels 1-5, so there is no
#     room to be early. They stay at 3, clear of the tutorial.
#   * Flytrap — Red tier, but its crop (venus_flytrap) unlocks at 19. The formula
#     would put it at 15, ahead of every Blue mutant and level with the ordinary
#     Red zombies, so the premium body would outclass everything on sale for the
#     next 13 levels. It stays late instead, which is also what ZF2 did with it.
#
# The result keeps the tier bands ordered and behind their ordinary counterparts:
#     Green 3-12, Blue 16-28, Red 30-32, Silver 39-40
#     (ordinary: Green 1-6, Blue 8-13, Red 15-20, Silver 25-30)
MUTANT_REBALANCE = {
    "ZombieActorRegularTier1Carrots": 3,       # Carrot Zombie      (carrot L1)
    "ZombieActorRegularTier1Tomatoes": 3,      # Tomato Zombie      (tomato L3)
    "ZombieActorRegularTier1Onions": 3,        # Onion Zombie       (onion L1)
    "ZombieActorRegularTier1Turnips": 3,       # Turnip Zombie      (turnip L5,  -2)
    "ZombieActorRegularTier1Potatoes": 7,      # Potato Zombie      (potato L10, -3)
    "ZombieActorRegularTier1Coffee": 12,       # Coffee Zombie      (coffee L15, -3)
    "ZombieActorRegularTier2Celery": 16,       # Celery Zombie      (celery L20, -4)
    "ZombieActorRegularTier2Broccoli": 19,     # Broccoli Zombie    (broccoli L23, -4)
    "ZombieActorRegularTier2Garlic": 20,       # Garlic Zombie      (garlic L25, -5)
    "ZombieActorRegularTier2Cauliflower": 24,  # Cauliflower Zombie (cauliflower L29, -5)
    "ZombieActorRegularTier2LimaBeans": 28,    # Lima Bean Zombie   (lima_beans L33, -5)
    "ZombieActorRegularTier3VenusFlytrap": 30, # Flytrap Zombie     (venus_flytrap L19, tier exception)
    "ZombieActorRegularTier3DragonFruit": 32,  # Dragon Fruit Zombie(dragon_fruit L37, -5)
    "ZombieActorRegularTier4Eyebiscus": 39,    # Eyebiscus Zombie   (eyebiscus L44, -5)
    "ZombieActorRegularTier4Heartichoke": 40,  # Heartichoke Zombie (heartichoke L45, -5)
}

# Pumpking is deliberately absent: it is the one mutation with no market mutant at
# all (crop-adjacency only, and only the headless family can grow it). Its crop
# moved to level 39 and stays there — a late, powerful mutation is a reason to use
# the Black Market rather than a gap to fill.


# ---- Mutant colour class --------------------------------------------------
# Re-levelling the mutants above moved them out of the level bands their colour
# used to sit in: a Blue Lima Bean at level 28 sat among Silver zombies. These
# entries move the colour to the band the zombie now occupies.
#
# Ordinary (non-mutant) zombies hold the bands: Green 1-6, Blue 8-13, Red 15-20,
# Silver 25-30. The promotions below put each mutant in the band containing its
# unlock level, and the existing UnitStats bodies already fit: the Reds carry
# 5/2/5 against ordinary Red 5/4/4.5, and the Silvers carry 5/2/5 to 8/2/10
# against ordinary Silver 5.5/2/5.5. Stats are therefore NOT overridden.
#
# Deliberately unpromoted:
#   * Coffee Zombie (level 12) — it lands in the Blue band, but its body is a
#     genuine Green 2/2/2 and level 12 is the band's last rung. Blue would
#     overpromise. It stays Green.
#   * Carrot/Tomato/Onion/Turnip/Potato (3-7) and Eyebiscus/Heartichoke (39-40)
#     are already in the right band.
#
# NOTE — the key keeps its original tier token: ZombieActorRegularTier2Celery is
# now Red. The key is the save/roster/almanac/sprite identity, so renaming it to
# match would be an identity change for something that is only a display class.
# tools/prep_market.py classify() derives the colour from that token, so THIS
# table has to win, and taxonomy.ts treats the baked value as authoritative.
# Do not "fix" the key/colour disagreement by reverting the colour.
#
# Changing the colour is not purely cosmetic. It also decides which ability tiers
# the zombie can unlock (taxonomy.classTierRank) and its Black Market trade gate
# (className -> coloured gravestone -> that object's level: Red 15, Silver 25).
# Both were checked against the new unlock levels: the earliest Red mutant is 16
# and the earliest Silver is 28, so no mutant is purchasable before it is
# tradeable. The tier NUMBER moves with the colour so the two never disagree —
# it drives roaming fertilize chance and Zombie Pot species selection.
MUTANT_CLASS_REBALANCE = {
    "ZombieActorRegularTier2Celery":       (3, "Red", "#ff5a4a"),     # L16
    "ZombieActorRegularTier2Broccoli":     (3, "Red", "#ff5a4a"),     # L19
    "ZombieActorRegularTier2Garlic":       (3, "Red", "#ff5a4a"),     # L20
    "ZombieActorRegularTier2Cauliflower":  (3, "Red", "#ff5a4a"),     # L24
    "ZombieActorRegularTier2LimaBeans":    (4, "Silver", "#cfd4dd"),  # L28
    "ZombieActorRegularTier3VenusFlytrap": (4, "Silver", "#cfd4dd"),  # L30
    "ZombieActorRegularTier3DragonFruit":  (4, "Silver", "#cfd4dd"),  # L32
}


# ---- Tier-4 mutant bits ---------------------------------------------------
# ZF2 shipped Eyebiscus and Heartichoke carrying a LOWER tier's mutation bit —
# Carrot's 4 and Cauliflower's 512 — even though Market.json advertises "+3" on
# Eyebiscus against Carrot's "+1". So the game's two priciest, slowest mutation
# crops granted the Tier-1 bonus, and the Heartichoke filed itself under the hair
# slot while visibly wearing a body (heartichokeBody replaces the body exactly as
# limaBeanBody does). Both are mutations of their own now — appended to the catalog
# in src/zombie/mutations.ts, which is where their slot and stats are authored — so
# the source bit has to be overridden here or the join in prep_market.py reverts it.
MUTANT_BIT_REBALANCE = {
    "ZombieActorRegularTier4Eyebiscus":   16384,  # hair_eye, +1 attack +1 speed
    "ZombieActorRegularTier4Heartichoke": 32768,  # body (with Lima Bean), +5 life
}


def rebalance_mutant_bit(key, entry):
    """Overwrite one zombies.json entry's guaranteed mutation bit, in place.

    Returns True if the zombie's bit is overridden, False if it is not in the table.
    Must run AFTER the source `mutation` read, since it overrides it.
    """
    bit = MUTANT_BIT_REBALANCE.get(key)
    if bit is None:
        return False
    entry["mutation"] = bit
    return True


def rebalance_mutant_class(key, entry):
    """Overwrite one zombies.json entry's tier + colour class, in place.

    Returns True if the zombie is re-classed, False otherwise. Must run AFTER
    both classify() and the UnitStats tier read, since it overrides both.
    """
    row = MUTANT_CLASS_REBALANCE.get(key)
    if row is None:
        return False
    entry["tier"], entry["className"], entry["classColor"] = row
    return True


def rebalance_mutant(key, entry):
    """Overwrite one zombies.json entry's unlock level from MUTANT_REBALANCE.

    Returns True if the zombie is rebalanced, False if it is not in the table
    (every non-mutant zombie). Raises if the table names an unreachable level.
    """
    level = MUTANT_REBALANCE.get(key)
    if level is None:
        return False
    if level > LEVEL_CAP:
        raise ValueError(f"{key}: unlock level {level} is above the level cap {LEVEL_CAP}")
    entry["level"] = level
    return True


# ---- Named-special stat overrides ----------------------------------------
# The named specials take their combat stats straight from ZF2's Zombies.json.
# These entries overwrite a stat AFTER that read.
#
# EPIC PRIZE RE-FIT (2026-09-07). The 15 Epic Boss prizes can now be mutated in the
# Zombie Pot (slot 1, wearing slot 2's mask — see docs/SPECIAL_ZOMBIE_ACQUISITION.md),
# so their stats are balanced around the MUTATED zombie, not the plain one. The fit:
#
#   * strength = sqrt(DPS x HP) = sqrt(500 x str x dex x con), the same yardstick the
#     Zombie Strength Ladder plots (str x 10 per hit, 2/dex s per swing, con x 100 HP);
#   * the target is what the prize reaches wearing the five-slot DAMAGE set
#     (Pumpking, Eyebiscus, Dragon-arm, Heartichoke, Flytrap: +9 str, +2 dex, +9 con):
#     a line from 1,500 at Dr. Groundhog's unlock (level 24) to 2,000 at Loco
#     Locust's (level 42), the rung-5 prize 75 below the line and the omega 75 above
#     it (Brock Coley, paid on both rungs, sits on the line);
#   * dex is NEVER touched — speed is each prize's character — and str and con are
#     scaled by ONE factor per prize, so its shape survives; a prize that would have
#     to GROW is capped at +15% (Brock Coley, Zombug, Proto, Zomtar, Zomdini land a
#     little under the line rather than jumping a third);
#   * every fitted str and con is then ROUNDED TO A WHOLE NUMBER (owner's call,
#     2026-09-08); the factors quoted beside each row are the fit's, before rounding.
#
# Before the fit the fast omegas ran away once mutated (Vagabond 2,474, Scrooge 2,369,
# Bandido and Madame past 2,150 against a fully mutated Video Game Zombie's 1,503),
# while the slow ones barely moved. Every prize is still stronger unmutated than a
# plain Crazy Zombie (729) or Video Game Zombie (780).
#
# Admiral keeps the earlier correction on top: it is Bully Frog's TOP prize and had
# shipped as a strictly worse Captain (same str/con, dex 2 against 2.65), the only epic
# ladder whose omega was a downgrade. Its dex 2.9 edges the Captain's 2.65.
# TANKS ARE FITTED ON HP, NOT ON sqrt(DPS x HP). The damage yardstick treats a
# tank's missing damage as a deficit and "repairs" it with con (the Diver, dex 1,
# came out of the first pass with 4,460 HP at level 10 — the toughest zombie in the
# game), and it pulled the slow Epic tanks' con DOWN along with their str. So the
# seven slow, con-heavy prizes below — an explicit ROLE list, not a ratio, so nothing
# changes role by accident — keep the str the damage fit gave them and take their
# con from an HP fit instead: the HP they reach wearing the five-slot LIFE set
# (Potatohead, Cauli-hair, Dragon-arm, Heartichoke, Flytrap: +15 con; a headless body
# can only wear the three body-side pieces, +9) lands on a tank line.
#
#   * Invasion tank line: 3,600 HP at level 1 -> 5,600 at level 43, elite prize
#     +200 and ordinary -200 where a raid pays both. Anchored on the Market's own
#     tanks: a Red headless (Flamehead, L17) reaches 2,500 with the life set and a
#     Silver headless (Party Zombie, L29) 4,200, so a prize sits about a colour
#     class ahead at its level. The Diver's authored 29.7 con was already right by
#     this measure; it lands at 31.3.
#   * Epic tank line: 5,000 HP at level 24 -> 6,600 at level 42, omega +200 and
#     rung-5 prize -200. The Groundhog and Bully Frog prizes land within a point or
#     two of their authored con (Admiral 40.6 against ZF2's 40.5).
#
# Scrooge and the Christmas Ghost are NOT on this list although they are the
# toughest Foul Owl prizes: at dex 8 their HP is worth damage too, and an HP fit
# with their str restored put Scrooge at 2,500 on the damage yardstick, back above
# the Vagabond. They stay on the damage line, where they are still the third and
# fifth toughest Epics.
SPECIAL_STAT_REBALANCE = {
    # key: {stat: value}                          # ZF2 str/con -> factor
    # The two Doctors are GARDEN healers since 2026-09-08 (heal / Heal All, a Laser
    # Ver.2 from the support station instead of Resurrect). No longer tanks: held
    # a step over the Cupid Zombie (13.5/3/15 -> plain strength 551, damage set
    # 1,162, life-set HP 3,000): Dr. +10% / +8% / 3,700, Omega +28% / +19% / 4,000.
    "ZombieActorDrZombie":       {"str": 14, "con": 22},  # 19.9/35.5  Garden healer, over the Cupid
    "ZombieActorOmegaDrZombie":  {"str": 15, "con": 25},  # 21/38.5    Garden healer, over the Cupid
    "ZombieActorCaptain":        {"str": 17, "con": 37},  # 21/38.5    str x0.79; TANK
    "ZombieActorAdmiral":        {"str": 18, "dex": 2.9, "con": 41},  # 21/40.5 str x0.85; TANK
    "ZombieActorBrockColey":     {"str": 46, "con": 8},   # 40/7       x1.15 (cap)
    # Proto Zombie and Zombug are MINIS since 2026-09-08 (group Small: ride a brute as
    # its Mini Buddy, drawn at Mini size; Resurrect t3 + Smash t4 in place of the
    # Explodes — traits.SPECIAL_ABILITIES). The MINI
    # RULE below applied literally to the fitted stats: str and con x0.86, dex kept.
    "ZombieActorProto":          {"str": 14, "con": 10},  # 14/10      x1.15 (cap) then x0.86 Mini
    "ZombieActorZombug":         {"str": 15, "con": 15},  # 15/15      x1.15 (cap) then x0.86 Mini
    "ZombieActorZomdini":        {"str": 17, "con": 14},  # 15/12      x1.15 (cap)
    "ZombieActorZomtar":         {"str": 23, "con": 17},  # 20/15      x1.15 (cap)
    "ZombieActorChristmasGhost": {"str": 10, "con": 25},  # 13/32      x0.79
    "ZombieActorScrooge":        {"str": 10,  "con": 32},  # 13/42      x0.76
    "ZombieActorDiva":           {"str": 22, "con": 20},  # 20/18      x1.08
    "ZombieActorMadame":         {"str": 19, "con": 20},  # 21/22      x0.91
    "ZombieActorBandido":        {"str": 20, "con": 19},  # 24/23      x0.84
    "ZombieActorVagabond":       {"str": 20, "con": 21},  # 25/27      x0.78
    # INVASION PRIZE RE-FIT (2026-09-07, raised 2026-09-08), the same method on the
    # rare invasion drops (src/raid/zombieDrops.ts — ordinary prize and the elite
    # promoted one). They can be mutated in the Pot exactly like the epics, so the
    # target is again the damage-set strength. The owner's brief: they are hard to
    # get, so they COMPETE with the Epic prizes — sidegrades at comparable levels —
    # and the elite ones are stronger than their level suggests. So:
    #
    #   * the line is the Epic line itself, extended below level 24 (1,500 at 24 ->
    #     2,000 at 42, i.e. 27.8 per level), floored by the earlier prize line
    #     (1,000 at level 1 -> 1,750 at 43) which is the higher of the two up to
    #     level 15 — so the four early prizes and the Diver did not move;
    #   * the ORDINARY prize sits ON the line, between an Epic rung-5 prize (-75) and
    #     its omega (+75) at the same level;
    #   * the ELITE prize sits 200 ABOVE the line — above the omega — which is about
    #     what the line pays seven levels later. The elite tanks get +500 HP over the
    #     tank line for the same reason.
    #   * growth is capped at x2; nothing reaches it now (the Aliens prizes needed
    #     x1.44 / x1.5).
    #   * the ALIENS pair is then held a step UNDER the Video Games pair (owner's
    #     call, 2026-09-08): the Video Games are the harder invasion, so the
    #     Zastronaut sits under the Video Game Zombie and the Cozmonaut under the
    #     Boss Zombie on plain strength, mutated strength and HP alike (about 4% off
    #     the line for the Zastronaut, 6% for the Cozmonaut) — the Cozmonaut still
    #     edges the Omega Zombie Bot, the elite prize one invasion earlier (moot
    #     since the Bots became Headless tanks — see their rows).
    #   * a MINI prize is fitted as a Mini: its target is 0.86 of the line, the ratio
    #     the Small tier-5 (Zombricaun) holds against the Regular tier-5 (Zombotron)
    #     on this yardstick (the Silver pair gives the same 0.86). The Zombozo is the
    #     one so far. The Video Game Zombie (the Video Games' prize) and its elite, the
    #     Boss Zombie, were fitted on this line and then had their con cut by a fifth
    #     (owner's call) — see AUTHORED_ZOMBIES in prep_market.py.
    #
    # Before the raise the prizes sat 250 under the Epic line. Before the first fit
    # Deputy / Sheriff had Epic-omega stats at level 16, and Zombie Bot / Omega Zombie
    # Bot were the strongest zombies in the game after the Vagabond.
    #                                             # ZF2 str/con -> factor
    "ZombieActorOldMcZombie":      {"str": 8,  "con": 12},  # 8.71/14.3  x0.86  L1
    "ZombieActorRegular4Tier5":    {"str": 12, "con": 19},  # 12.6/19.8  x0.94  L6  Teddy
    "ZombieActorForest":           {"str": 9,  "con": 15},  # 8.71/14.3  x1.07  L8
    "ZombieActorHeadless2Tier5":   {"str": 17, "con": 31},  # 11/29.7    str x1.5; TANK con from HP line
    "ZombieActorDeputy":           {"str": 11, "con": 28},  # 21/38.5    str x0.54; TANK, on the tank line
    "ZombieActorSheriff":          {"str": 14, "con": 33},  # 21/38.5    str x0.65; TANK, elite +500 HP
    "ZombieActorMerZombie":        {"str": 16, "con": 14},  # 18/16      x0.88  L21
    "ZombieActorPoseidon":         {"str": 18, "con": 15},  # 20/17      x0.90  L21 elite
    "ZombieActorNinjombie":        {"str": 25, "con": 13},  # 20/10      x1.27  L26
    "ZombieActorMasterNinjombie":  {"str": 32, "con": 16},  # 20/10      x1.60  L26 elite
    # The two Bots are HEADLESS since 2026-09-08 (Life / Protect / Laser Beam /
    # Block, lead the line): a Headless stat line with the str they already had.
    # Dex 1 like every Headless; con from the TANK line at level 31 — a Headless
    # wears only the three body-slot life mutations (+9 con), so 5,029 -> 41 and
    # the elite's 5,529 -> 46 (the Diver, 4,029 -> 31, is the same arithmetic).
    "ZombieActorZombieBot":        {"str": 19, "dex": 1, "con": 41},  # 24/25  L31; TANK, on the tank line
    "ZombieActorOmegaZombieBot":   {"str": 22, "dex": 1, "con": 46},  # 28/30  L31 elite; TANK, +500 HP
    "ZombieActorZastronaut":       {"str": 19, "con": 30},  # 8.71/14.3  x2.14  L36; held under the VGZ
    # The Cozmonaut (Aliens elite) and the Zombozo (Circus) are AUTHORED rows
    # (prep_market.py AUTHORED_ZOMBIES) and are fitted there.
}


def rebalance_special_stats(key, entry):
    """Overwrite a named special's combat stats from SPECIAL_STAT_REBALANCE, in place.

    Returns True if the zombie is rebalanced, False if it is not in the table.
    Must run AFTER the source unitStats read, since it overrides it.
    """
    row = SPECIAL_STAT_REBALANCE.get(key)
    if row is None:
        return False
    unknown = set(row) - {"str", "dex", "con", "focus"}
    if unknown:
        raise ValueError(f"{key}: unknown stat override {sorted(unknown)}")
    entry.update(row)
    return True


def rebalance_crop(key, entry):
    """Overwrite one plants.json entry's economy from CROP_REBALANCE, in place.

    Returns True if the crop is rebalanced, False if it is not in the table (a
    seasonal crop, which keeps its source values). Raises if the table names a
    level the player can never reach.
    """
    row = CROP_REBALANCE.get(key)
    if row is None:
        return False
    level, cost, sell, xp = row
    if level > LEVEL_CAP:
        raise ValueError(f"{key}: unlock level {level} is above the level cap {LEVEL_CAP}")
    entry["level"], entry["cost"], entry["sell"], entry["xp"] = level, cost, sell, xp
    return True


def brain_price(source_cost, what="item", strict=True):
    """A ZF2 source brain price converted to Reforged terms.

    Rounds half-up and never returns 0 — the cheapest thing costs 1 brain, not
    nothing. `what` names the entry in any error raised.

    strict=True (the default) additionally rejects a source price that is not a
    clean multiple of the divisor, so unexpected source data fails loudly rather
    than silently rounding into a price nobody chose. Catalogs whose source
    legitimately carries odd values (placeables has 15-brain items) pass
    strict=False and accept the rounding.
    """
    cost = int(source_cost or 0)
    if cost <= 0:
        raise ValueError(f"{what}: brain cost must be positive, got {source_cost!r}")
    if strict and cost % BRAIN_COST_DIVISOR != 0:
        raise ValueError(
            f"{what}: brain cost must be a multiple of "
            f"{BRAIN_COST_DIVISOR}, got {source_cost!r}"
        )
    return max(1, int(cost / BRAIN_COST_DIVISOR + 0.5))


def price(source_cost, brains_needed, what="item"):
    """Convenience: retune only when the entry is priced in brains."""
    return brain_price(source_cost, what) if brains_needed else int(source_cost or 0)
