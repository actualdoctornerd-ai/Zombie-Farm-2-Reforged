# Friend Invasions (PvP)

**Status: REWORKED, LIVE ON STAGING, PARKED IN PRODUCTION.** The v1 feature shipped and
was parked on 2026-08-23; the interface/progression rework landed the same week: a
dedicated Invasions panel (Social → Invasions), defender-authored defenses, a level-7
gate, daily income caps, lifetime + weekly stats, an accumulate-forever claim backlog
with Claim-all, and a watch-the-replay viewer. The staging Worker runs it ON for
playtesting and reward tuning; production keeps it OFF. This document is the record of
what exists, why it is shaped the way it is, and what remains.

## How to turn it on (and off)

**One switch**: the Worker var `PVP_ENABLED` (`server/wrangler.toml` — `[vars]` is the
staging block, `[env.production.vars]` is prod), then deploy that Worker. The client
needs no redeploy: the bootstrap response carries a `pvpEnabled` capability flag, and
every client surface (the Social-hub entry, the panel, the launch hook) follows it —
off means no dead buttons, on means the feature simply appears.

`PVP_UI_ENABLED` (`src/raid/pvp.ts`) still exists but is now a **client-side emergency
kill switch**, normally `true`: set it `false` and redeploy the client only if the
client half itself must be hidden regardless of what the server says.

Local dev and the integration suite keep the Worker flag ON (`server/.dev.vars`,
`server/test/integration/wrangler.test.env`), so the feature stays tested wherever the
deployed state is off.

Asymmetries built into the off state, on purpose:
- `/raid/pvp/start`, `/defense` and `/preview` refuse with `503 pvp_disabled`;
  **`/finish`, `/collect`, `/collect-all`, `/history` and `/replay` stay live**, so a
  fight in flight at switch-off still settles, earned rewards stay claimable, and
  history/recordings stay readable.

## What the feature is (as built)

- **The Invasions panel** (Social → Invasions, `src/ui/panels/invasions.ts`) is the
  whole feature's home, in three market-styled tabs:
  - **Attack** — the friends list with a **Scout** step per friend: defender count,
    arranged-vs-auto defense, the line-up's portraits, and the reward tier beating it
    pays, all BEFORE committing. Invade opens the exactly-8 ordered army picker
    (`Hud.openPvpArmy`) and launches. The tab shows today's rewarded-wins pips.
  - **Defense** — the defender AUTHORS their defense: any owned zombies (crypt-resting
    ones included — a defense is a plan, not who stands on the lawn), in an explicit
    order where **slot 1 emerges first** (teams-style numbered picker). The defense
    fields **6 zombies base** (`PVP_DEFENSE_CAP`); the customization shop will sell
    slot upgrades toward the **10-slot ceiling** (`PVP_DEFENSE_CAP_MAX`). Accounts
    that never arrange one fall back to the automatic strongest-6 pick, weakest
    emerging first. The tab shows your defense as attackers will meet it.
  - **History** — the last 10 attacks and 10 defenses (rewarded/unrewarded marked,
    **▶ Watch** where the recording survives), lifetime + trailing-7-day win/loss
    stats for both roles, and the claim backlog banner with **Claim all**.
- **Level gate**: both sides must be **level 7+** (`PVP_MIN_LEVEL`) — new farms are
  neither attackers nor targets. The Social hub shows the Invasions entry greyed with
  "Unlocks at level 7" below that, rather than hiding it: the locked entry is the only
  place a player learns the feature exists and what reaching it costs. The panel keeps
  its own in-panel gate too, since the hub is not the only way in.
- **First open**: Tim Buckwheat gives a one-shot briefing (`PVP_INTRO_TIP`, remembered
  per device via `prefs.hasSeenPvpTip`) explaining the two things the Defense tab never
  states — that defending picks the strongest of each CLASS rather than an army, and
  that nothing is ever lost holding the farm. It layers over the panel, so the tabs stay
  usable behind it.
- The fight runs on **Old McDonnell's stage** against the defense snapshot under a mild
  swarm cadence (3 on the field, +1 every 5 s). Defenders render with their real farm
  rigs — mutations, tints, names — mirrored to face the attackers.
- **Nobody loses anything.** The defender is only ever a snapshot; the settlement path
  touches no roster row, no balance, no cooldown, and offers no revival. There is no
  gold/XP/loot — the reward is **boost bundles**, priced by the OPPOSING group's tier.
  Only tier 5 pays a Brain Ticket.
- **Tiers read the ACTUAL fight stats** (`unitTierPoints` / `groupTierPoints`,
  `PVP_TIER_POINT_THRESHOLDS`): hp × dps over the BUILT units — level ramp,
  veterancy, mutations, team auras, farmer heads, and Protect's damage reduction all
  count. The level ramp bands each species, so an outleveled lawn of greens DEFLATES
  rather than inflates — greens stay tier 1 at any account level. **Group size
  matters, sub-linearly**: the score is Σ points / √(count × base size), so more
  zombies raise the tier a bit while one powerful zombie still out-scores a crowd of
  weaklings (and a lone zombie is never a tier-5 GROUP). Focus never enters.
  Calibration pinned by tests: plain greens tier 1 at any level and count, even the
  max 5-slot mutation set on greens stops at tier 2, the top epic shelf (which
  cannot carry mutations) is tier 5 unmutated.
- **Daily income caps, not fight caps** (`PVP_DAILY_REWARDED_WINS` /
  `_DEFENSES`, both 3): any number of fights happen, count in the stats, and are
  recorded — but only the first 3 verified wins per UTC day pay the attacker, and only
  the first 3 held defenses per UTC day park a defender reward. Stamped at settlement
  (`attacker_rewarded` / `defense_rewarded`, migration 0057) so a claim can never
  re-litigate them. This is also the anti-collusion lever; the per-pair cap
  (`PVP_DAILY_ATTACKS_PER_PAIR`, now 10) is just a spam guard.
- **Rewards accumulate forever, recordings do not**: every finish sweeps the heavy
  replay payload (config + transcript) off rows outside both participants' newest
  **10** finished fights (`PVP_REPLAYS_KEPT`); the result rows, their rewards and the
  stats survive indefinitely. Someone back after a month with 50 held defenses claims
  all 50 in one tap and can watch the last 10.
- **Watch the replay**: `/raid/pvp/replay/:id` returns the pinned config + verified
  transcript; the client runs the ordinary `RaidScene` in **playback mode** (inputs
  injected at their recorded ticks exactly where the verifier injects them, every
  control disabled, retreat button becomes ✕ End Replay). Deterministic — the replay
  reaches the recorded fight's exact final tick. A recording only replays on the
  ruleset it was recorded under; older ones show the record without a Watch button.
- **Stats are server-authored**: lifetime counters live in `pvp_stats_v3`, incremented
  only inside the guarded settlement batch; trailing-week numbers are computed from
  the session rows.
- PvP always fights at **full focus** (concentration pinned on both sides): no
  focus-bubble minigame, so a transcript is just ability taps + retreat.
- A held defense parks a **claim-on-login reward** for the defender (Black-Market
  `collect` shape — the defender's account is never written while they are away).
  `/collect` claims one row; `/collect-all` drains the whole rewarded backlog in
  bounded slices, each slice's row-stamps and inventory grant committed atomically.

## The architecture (read before touching)

**The one idea everything hangs off:** `/raid/pvp/start` builds and pins the ENTIRE
fight config server-side and the client **adopts it wholesale** — both armies as
materialised `CombatUnit`s, the wave cadence, the difficulty scores, both reward
tiers. The client builds its `RaidScene`/`BattleSim` from those exact units. No
per-side derivation → nothing to keep in sync → the ordinary deterministic-replay
verifier settles the fight (`verifyRaid`, same as raids: server replays the transcript;
`clientWin` is a pure concession). The PvP feature itself required **zero BattleSim
changes and no ruleset bump** — a defender zombie is just an enemy-team `CombatUnit`.

Invariants that were chosen deliberately (do not "fix" them):
- Defender units keep their **player-side 2 s/dex attack clock** (an enemy slot would
  halve it — same zombie, same strength on either side). Their full-team auras are
  pre-baked and `teamAuraStats` stripped (the sim's aura refresh walks players only);
  `abilities` are `[]` (nobody is home to tap them); Protect's damage reduction
  survives. Ids re-minted `d0..dN` so nothing downstream mistakes them for roster ids.
- The defense snapshot ignores raid locks (a zombie mid-raid elsewhere still stands on
  the farm being copied) and includes presentation names for both sides.
- The REWARD tier (see "Tiers read the ACTUAL fight stats" above) and the
  informational fight score (`armyScore`, the attack/defense score columns) both read
  the built units; the tier additionally folds in Protect and the √count size factor.
  Both are pinned at `/start`, so a payout can never be re-priced at finish.
- Boost grants ride the settlement batch (the trusted-subsystem path
  `server/src/inventory.ts` demands — there is deliberately no public grant).
- The verified transcript is **stored** on the session row (`inputs_json`, ≤32 KB) —
  the "watch attacks on your farm" viewer only needs a playback mode, not new data.

First playtests surfaced two GENERAL engagement bugs, fixed as **ruleset v40**
(see `src/raid/replay.ts`'s changelog): (a) a Garden zombie with no healing ability
now fights instead of stationing (`isGarden` is the support flag, not the body type);
(b) a line enemy with an empty melee ring strikes the front-most front-band zombie
standing at its slot. The v40(b) scoping limits (standing / front band / line enemies
only) are **measured** — the unconditional version cost +49% on ordinary Video Games
difficulty via the turned pixel zombie. Elite profiles did not move.

## Where everything lives

| Piece | File |
|---|---|
| Shared rules: switches, level gate, caps, scores, tiers, defense conversions, synthetic RaidDef | `src/raid/pvp.ts` (+ `src/raid/pvp.test.ts`) |
| Server config + defense-snapshot builders (from D1, offline-safe) | `server/src/raidVerifier.ts` `buildPinnedPvpRaid` / `buildDefenseSnapshot` |
| Server routes' logic: start / finish / defense / preview / history / collect(-all) / replay | `server/src/v3/pvp.ts` |
| Route wiring, rate limits, `PVP_ENABLED` gate, bootstrap `pvpEnabled` capability | `server/src/index.ts` (`/raid/pvp/*` — under `/raid/` so auth + writer fencing apply) |
| Session/result/transcript table + reward flags | `pvp_sessions_v3` — migrations `0055` + `0057`, mirrored in `schema.sql` |
| Authored defense + lifetime stat counters | `pvp_defense_v3` / `pvp_stats_v3` — migration `0057` |
| Client API calls | `src/net/api.ts` (`pvpStart/pvpFinish/pvpHistory/pvpCollect/pvpCollectAll/pvpDefenseGet/pvpDefenseSet/pvpPreview/pvpReplay`) |
| The Invasions panel (Attack / Defense / History tabs) | `src/ui/panels/invasions.ts` |
| Launch, settlement, replay-viewer flows + hook wiring | `src/main.ts` (`hud.onInvadeFriend` → `launchPvpBattle`; `hud.onWatchPvpReplay` → `launchPvpReplay`) |
| Army picker + Social-hub entry | `src/hud.ts` (`openPvpArmy`, `openSocial`) |
| Defender-rig rendering + mirrored facing + art-loader gate + playback mode | `src/raid/RaidScene.ts` (the `zombieRig` test in `makeToken`; `RaidSceneParams.playback`) |
| End-to-end server tests | `server/test/integration/pvp.spec.ts` |

The audit that preceded the build (subsystem map, phase plan) is in the session
history of 2026-08-23; the phases below are its remainder.

## Verified behaviour (what the tests pin)

- Start gates: friendship, ruleset handshake, exactly-8 owned deployed units,
  `no_defense` for an empty farm, one live session, the pair spam guard, and the
  **level-7 gate on both sides** (`attacker_level` / `defender_level`).
- Defense authoring: loadout validation (ownership, size), a **resting zombie
  standing in an authored defense**, the authored order arriving in the pinned
  config as the emergence order, the preview endpoint (friends-only), and the
  clear-to-auto fallback.
- A finish with `finalTick 0, inputs []` settles by pure server simulation (the
  overrun path) — the integration spec wins fights that way and checks the boost
  grant lands in inventory; idempotent replays return the same settlement.
- **Daily caps**: the (cap+1)-th win of the day settles `win: true, rewarded: false`
  with no grant; held defenses past the defender cap are recorded but `not_rewarded`;
  today-counters and the claim backlog come back correct from `/history`.
- **Claim-all** drains exactly the rewarded backlog once; single-claims stay
  one-time, defender-only, rewarded-rows-only.
- **Stats**: `pvp_stats_v3` lifetime counters match the fights fought, per role.
- The stored recording is fetchable by both parties and only them.
- Structural guard (`server/test/spentFightConfig.test.ts`): exactly ONE statement
  may clear a PvP config — the windowed sweep — and it must carry both participants'
  keep-window guards.
- Sim-level: both defense conversions preserve per-unit combat numbers; a
  defense-vs-attack fight is deterministic from an empty transcript and finishes
  inside the replay cap.
- **Played live** (local stack, 2026-08-23): full loop through the real UI — scout,
  authored defense in a real fight, win with tier rewards, history/stats, claim-all
  landing in D1 inventory, and the replay viewer reaching the recorded fight's exact
  final tick, plus a clean ✕ End Replay early exit.

## Known rough edges

- A fight whose last survivor is a **true healer** stalemates to the 4-minute cap and
  scores as a defense win (owner's ruling: stalling is the attacker's own choice and
  buys them nothing — the timeout IS the defense holding).
- No "you were invaded" notification — the defender discovers history by opening the
  Invasions panel.
- Reward tier thresholds (`PVP_TIER_POINT_THRESHOLDS`) are calibrated against the
  catalog (see the comment on them in `src/raid/pvp.ts`) but the BUNDLE contents are
  first guesses — **reward tuning is the explicit next step** once staging play data
  exists.
- Fights are semi-auto (concentration pinned): the attacker's inputs are ability
  taps and retreat only.
- The replay is watched from the ATTACKER's camera (it is the attacker's transcript);
  a defender-flavoured presentation would be cosmetic work on the same playback mode.

## Design space still open (audit Phases 3–4 + owner's wishlist)

- **Defender customization beyond the line-up** — maps almost entirely onto config
  fields that already exist and get pinned: chosen **projectiles** (`bossThrow`, the
  whole throw machinery exists), **deploy-rate / max-out upgrades** (`waveCadence`,
  defense cap), **obstacles** like the carrot wall (`wallTemplate`). Upgrades must be
  server-owned purchase records; only the CHOICE among owned options is loadout data.
- **Exploding mini-zombie projectiles** — the one genuinely new sim mechanic
  (spawn-on-landing precedent: the alien summons); needs a ruleset bump when it lands.
- **The purchasable/upgradable attacker ability** (gold/brains).
- **Reward loop**: tune thresholds/bundles from staging play; defender reward
  notification; whether tier 5 should stay the only Brain Ticket source.
