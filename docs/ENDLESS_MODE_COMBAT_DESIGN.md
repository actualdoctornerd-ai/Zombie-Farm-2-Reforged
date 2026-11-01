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

## Endless stat archetypes

Use an archetype profile after the existing Endless entry-floor normalization. This lets
units diverge in durability, sustained damage, burst damage, and attack cadence while
keeping the source stats intact for normal invasions. Initial profile ratios are relative
to a same-wave balanced enemy and should be tuned in simulations.

| Archetype | HP | Sustained damage | Attack cadence | Special profile |
|---|---:|---:|---:|---|
| Balanced | 1.0x | 1.0x | 1.0x | General-purpose baseline |
| Tank | 1.6–1.8x | 0.65–0.8x | 0.8–0.95x | Holds the frontline; low burst |
| High DPS | 0.7–0.85x | 1.25–1.5x | 1.1–1.25x | Fragile; sustained damage |
| Burst DPS | 0.85–1.0x | 0.75–0.95x | 0.6–0.8x | Telegraph one hit at roughly 2–2.5x damage, then recover |
| Control | 0.9–1.1x | 0.65–0.85x | 0.8–1.0x | Existing stun, knockback, flank, or terrain interaction is the threat |
| Swarm | 0.65–0.8x | 0.65–0.85x | 1.0–1.2x | Low individual threat; use only where stage deployment permits |

The implemented profiles are: Swarm .76x HP / .90x damage / 1.46x cadence; Tank 1.62x /
.70x /.88x; High DPS .78x / 1.40x / 1.16x; Burst 1.0x / .92x /.92x; Control .94x /
.82x /.96x; Balanced 1x across. A Lumberjack gets a 2.4-second wind-up single-target
hit with 5.2-second recovery, only in Endless. Standard invasion units retain their
original stats and attack behavior.

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
| Scallywag | Speed-punish / swarm | Keep the mirrored attack-speed identity; pair with a slow bruiser so the response differs by target |
| Swashbuckler | Balanced / duelist | Midline pressure that can accompany a Scallywag or heavy pirate |
| Pirate boss as a regular enemy | Burst bruiser | Rare deep-wave heavy with a long tell and large hit; use as a pair anchor, not as a full boss encounter |

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
