# Epic Boss Mechanics

## Implemented coverage

Market â†’ Epic Boss offers all eight recovered bosses. Starting one spends 10 brains
and creates a 14-day wall-clock run; only one boss event can be active at a time. A run
can be purchased again after its final level is completed or the event expires, and
purchasing never extends an active run.

Groundhog uses 20 levels. The other seven bosses use their recovered level-40 reward
tracks. Maximum HP is `round(2000 * LevelMultiplier[level - 1])`, using
`EpicBossHP.json`. Because the shipped HP table ends at level 21, its final multiplier
is held constant for reconstructed levels 22-40. Each fight has a hard
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

Each boss uses its own recovered quest milestones, decor pool, and tame pet. Groundhog's
chain grants Dr. Zombie (5), an Invasion Voucher (10), one brain (15), and Golden Dice
plus Omega Dr. Zombie (20); the level-40 events continue through their recovered chains.
Until exact binary loot selection is recovered, each victory makes one 35% roll,
preferring unlocked uncollected drops. Decor duplicates become possible after eligible
decor is collected, and a pet leaves its boss's pool once owned. Ambiguous source
`reward: 5000` and `xp: 5500` fields are not granted.

Epic quest progress is lifetime progress: only the active boss's recovered quest family
is surfaced, and it is hidden between events without being discarded. Earned rewards
and completed quests are permanent. Bosses whose shipped quest data is missing still
retain combat, loot, pet, and completion progression.

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

`tools/prep_all_epic_bosses.py` generates eight namespaced catalogs from the source
gameplay files and extracted app bundle. The first five bosses use their authored
enter/idle/attack/defeat/escape/fly strips. EPB 8-10 use static revealed art because
their frame metadata was not present; their full source sheets are retained for future
reconstruction. `tools/prep_placeables.py` exposes 50 boss decorations as reward-only
farm objects, and `tools/prep_quests.py` recovers Bully Frog's three unambiguous embedded
quest records.

Crop-harvest discovery tokens are deferred. The remaining fidelity gaps are the missing
EPB 8-10 animation/gameplay metadata and corrupt or absent late quest data. See
`docs/EPIC_BOSS_ASSET_AUDIT.md` for the exact actor, UI, reward, pet, effect, and audio
mappings and the metadata that is genuinely still missing.
