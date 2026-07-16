# Epic Boss Mechanics

## Implemented coverage

Dr. Groundhog is the first and currently only playable Epic Boss. Market â†’ Epic Boss
spends 10 brains to start a 14-day wall-clock run. A run can be purchased again after
level 20 is completed or the event expires; purchasing never extends an active run.

The run has 20 levels. Maximum HP is `round(2000 * LevelMultiplier[level - 1])`, using
`EpicBossHP.json` (2,000 at level 1 and 214,000 at level 20). Each fight has a hard
30-second escape deadline. Zombies use manual brain-bubble release without butterfly
distractions or consuming Concentration. The normal army cap and permanent invasion
casualty rules apply, and Epic Boss attack order is stored separately.

Damage survives an escape. The next attempt unlocks after 20 minutes; if two hours
elapse from the first attempt at the current level, that level returns to full HP.
Winning advances immediately to the next full-health level. A fight begun before an
event or encounter boundary may finish normally.

The farm Boss shortcut appears only for an active run. The Market card shows event,
retry, and encounter timers, level/HP, rewards, activation, and Fight state.

## Rewards

Milestones are Dr. Zombie (5), Invasion Voucher (10), one brain (15), and Golden Dice
plus Omega Dr. Zombie (20). The event also supports eight recovered decor items and the
tame Groundhog. Until exact binary loot selection is recovered, each victory makes one
35% roll, preferring unlocked uncollected drops; decor duplicates become possible after
eligible decor is collected and the pet leaves the pool once owned. The ambiguous source
`reward: 5000` and `xp: 5500` fields are not granted.

Epic quest progress is lifetime progress: it is hidden while no Groundhog event is
active and restored on a later run. Earned rewards and completed quests are permanent.

## Authority and persistence

Offline state is optional in the versioned save, so older saves default to no event.
Online play stores the current run and one-use fight sessions in D1. Activation spends
brains atomically. Start pins level, HP, roster, combat configuration, and server time;
finish deterministically replays the input transcript and applies casualties, damage,
loot, quests, roster rewards, inventory, pet ownership, and balance once. An unfinished
session can be reopened with its pinned attack order until its short expiry; expiration
resolves it as an escape and unlocks the roster. Raid and Epic Boss sessions exclude
each other.

## Asset provenance and future work

`tools/prep_epic_bosses.py` generates the Groundhog catalog and namespaced assets from
`EpicEventEnemy.json`, `EpicBossHP.json`, gameplay parameters, and the extracted app
bundle. It recovered 15 authored background layers, intro/portrait/loot/quest art,
enter/idle/attack/defeat/escape/fly strips, BGM, and combat SFX. Dr. Zombie and Omega
Dr. Zombie use their source stats and dedicated sheet art.

Crop-harvest discovery tokens and brain-paid retry skipping are deferred. Every other
Epic Boss remains future work. The inventory does not prove missing assets are absent:
a deeper dive through other raw files, atlases, plists, binary references, and generic
resources may reveal the rest.
