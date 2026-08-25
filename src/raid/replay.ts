import { BattleSim, type BattleSimSnapshot } from "./BattleSim";
import type { RaidOutcome } from "./types";

// 6: hazards moved client-only (the verifier no longer simulates the trapeze) and
// `clientWin` concessions were added — in-flight v5 sessions must not replay under these
// rules, so the bump invalidates them via the existing stale_ruleset path.
// 7: recovered zombie abilities changed deterministic damage, healing, movement,
// resurrection, and fight duration. This bump prevents a newer client and an older
// Worker from accepting a fight under the same identifier and then disagreeing on
// whether its transcript reached a completed outcome.
// 8: enemy CADENCE corrected to the disassembled clock — `ENEMY_ATTACK_PACE=2` retired
// (enemies attack at 1/dex, twice as often as an equal-dex zombie), per-attack
// `speedMultiplier`, the Scallywag's opponent mirror, the farm raid's level speed-up, the
// player lineup-depth slowdown band, and ground-truth boss throw / laser / burn /
// telekinesis values. Every one of those changes the deterministic transcript.
// 9: post-v8 simulator corrections changed pixelFire from a long burn to a one-frame
// interrupt and made Mini Buddy use authored Small/Large groups for special zombies.
// In particular, a v8 client could attach a mini to Dapper while an older v8 Worker
// attached it to a different Large zombie, causing a late truncated_transcript.
// 10: boss throws and specials now share ONE weighted action budget (ground truth: the
// source makes a single roll over `bossActions` per cycle), instead of running on two
// independent timers. Bosses whose lists mix throws with specials — the Robot BrainBot
// and the Video Games boss — now throw proportionally less, which changes the
// deterministic transcript from the first boss action onward.
// 11: two fidelity corrections that both change the transcript from tick 0. (a) Mutation
// stat bonuses are now applied LAST, as the source's `modifyStatWithMutations:` does,
// instead of being baked into the base stat before the player-level ramp — mutated
// zombies below level 25 are substantially stronger than under v10. (b) The 10 raids
// that are not McDonnell now field their AUTHORED single wave at every level instead of
// an extrapolated per-level ladder, so both the enemy count and composition change.
// 12: formation vacancies now refill correctly after knockback. A displaced Headless
// zombie temporarily yields its priority so the next row can advance, then resumes its
// defining push-to-front behavior after reaching its recovery slot.
// 13: the boss's wall special is now gated on the perch (Ninja carrotWall / Robot
// junkWall). A descended boss used to keep summoning blockers behind itself at the
// Garden support line; it now spends its whole budget on melee once it climbs down, so
// the transcript diverges from the first post-descent action. This bump also raises
// ARMY_CAP 16 → 20, which a v12 Worker would reject as `bad_roster`.
// 14: player taps on a boss-summoned wall (Ninja carrotWall / Robot junkWall) are now
// TRANSCRIBED as `wallTap` input. The wall is the one hazard the verifier simulates — the
// other two are client-only — so the client chipping it for 75 a tap without telling the
// server put the two simulations permanently out of step from the first tap. The player
// then lost the fight on the server's un-tapped wall while winning it on screen, and the
// finish was rejected (`illegal_ability` / `truncated_transcript`). Losses were absorbed
// by the `clientWin` concession; wins were not, so a winning Ninja run could never settle.
// 15: NOT a simulation change — a deliberate retirement of every bundle that can
// destroy its own live invasion. Up to v14 the client's abandoned-raid recovery
// (EconomyClient.recoverResumableRaid) ran from four MID-SESSION bootstraps and settled
// the fight in progress with a tick-0 retreat; the player then won, /raid/finish
// replayed that stored zero result, and the victory panel showed 0 gold / 0 brains /
// no loot with no error anywhere. The fix is client-side, so a cached or installed v14
// bundle would keep eating wins until its owner happened to accept the update prompt.
// Bumping here refuses `/raid/start` from those bundles (426 stale_ruleset → the
// existing reload prompt), which is the only way to make the fix reach everyone. Cost,
// accepted knowingly: an invasion in flight at deploy time settles as stale_ruleset and
// pays nothing.
// 16: Zombies vs Robots composes its wave differently. The raid's `randomBoss` flag is
// now honoured (one of each bot, a random one leading — ground truth ZFFightMan
// initialSpawn), seeded by the raid session id so the client and the pinned server
// config draw the SAME wave; and boss specials no longer scan the whole roster, so only
// a JunkBot boss summons junk walls. A v15 bundle would field the old fixed BrainBot
// wave against a v16 pinned config and desync on the first tick.
// 17: the Lawyers boss's Double Punch special (`CorporateBossPunchSpecial`) STUNS and no
// longer knocks back. The shipped plist flagged it both; his page lists the stun as his
// special, and he is the only stunner in the attack table, so the shove is dropped and the
// 1 s hold kept (see ATTACK_OVERRIDES in tools/prep_raids.py). The struck zombie now holds
// its slot instead of being re-sent to the back of the formation, so a v16 client and a v17
// Worker would disagree about the Lawyers fight from the boss's first special onward.
// 18: a ONE-USE activated ability (Explode / Explode Ver.2 / Mini Buddy) is now spent
// the instant the player commits it, not when its wind-up pays off. Anything that
// cancels a wind-up mid-charge — a knockback, the Video Games boss's pixelFire, and
// (client-only) a trapeze or crab grab — used to hand the move straight back, because
// `usedAbilities` was written at the payoff and Explode carries no cooldown to mask the
// gap. On the two hazard raids that made the two simulations disagree about a REFUSED
// tap rather than about timing: the client's grabbed leprechaun could explode a second
// time, the server's (which never grabs anyone) was still charging the first, and the
// finish died on `illegal_ability` — a player-reported bug on exactly the Silver Small's
// two explosion buttons. Same cost as v15: an invasion in flight at deploy time settles
// as stale_ruleset and pays nothing.
// 19: Explode / Explode Ver.2 now KILL the zombie that uses them. The blast still lands
// first (full 10× area hit and 3 s stun), then the performer is dealt its remaining Life
// and joins the raid's losses — a real price for the army's biggest single hit, and what
// "the zombie explodes" should have meant all along. Only Smalls carry the move and
// `tryResurrect` refuses Smalls, so the death is final. This changes who is standing for
// the rest of the fight, so a v18 client and a v19 Worker diverge from the first tap
// onward. Same cost as v15: an invasion in flight at deploy time settles as
// stale_ruleset and pays nothing.
// 20: Explode is a FUSE, not a swing. It can now be lit by any zombie that has reached
// the combat zone — no enemy has to be standing in front of it — and once lit the charge
// keeps burning down and detonates on schedule even into an empty field. Before this the
// gate was `state === "fight"`, which flips off in every gap between one enemy dying and
// the next walking on, so the move you most want to pre-time was the one you could not.
// Both halves move the client/server agreement: a tap that a v19 Worker REFUSES as
// `illegal_ability` a v20 client accepts, and a charge a v19 Worker freezes a v20 client
// pays off. Same cost as v15: an invasion in flight at deploy time settles as
// stale_ruleset and pays nothing.
// 21: Resurrect no longer refuses Small zombies, so an exploder can be brought back —
// and a revived zombie now comes back WHOLE, one-use moves included. Two corrections in
// one: the blanket `isSmall` refusal was read off a wrong annotation in
// ZOMBIE_ABILITIES_BINARY_AUDIT.md (it called `canRez`'s state-100 rejection "the
// mini-zombie case"; `-[ZombieActorSmall suicide:]` sets exactly state 100, so the source
// was refusing the SUICIDED zombie, not Smalls as a type) — which meant a Small cut down
// by an ordinary enemy could not be revived either, for no reason at all. And ZF2's
// refusal of the suicided zombie is DELIBERATELY not carried over: an exploder that a
// Garden holder brings back rejoins the queue its move is picked from. It rejoins at the
// BACK, though — `abilityRearms` outranks position in `activate` — so a second Explode
// spends a zombie that still has one instead of killing the same one twice while its
// squadmates stand there. All three change who is standing and who acts, so a v20 client
// and a v21 Worker diverge from the first revival. Same cost as v15: an invasion in
// flight at deploy time settles as stale_ruleset and pays nothing.
// 22: two changes, either of which alone would force the bump.
// (a) The Brain Ticket adds ELITE invasions (src/raid/eliteInvasion.ts) — an authorized
// launch may now pin a wave whose enemy str/con/dex, boss projectiles, boss specials and
// summoned wall are all multiplied by that raid's elite profile. A v21 Worker ignores
// `brainTicket` entirely, so it would pin the ordinary wave against a v22 client fighting
// the scaled one and diverge on the very first tick; `/raid/start` also gained a
// `no_brain_ticket` refusal a v21 client cannot interpret.
// (b) A KNOCKBACK enemy with nothing inside `engageDistance` now strikes the front-most
// zombie close enough to be hitting IT (BattleSim.playerInRange). Knockback shoves its
// victim 150 units back and re-slots it last, landing it inside the 220-deep band it
// still attacks from but far outside the enemy's 60-unit reach — so an enemy could clear
// its own melee range and then stand there being killed, punished for using its ability.
// This changes the transcript of every fight against a knockback unit from its first
// shove: Old McDonnell's Lumberjack and boss, and the Video Games knights, monsters and
// boss. Only those units, deliberately — handing the longer reach to every enemy also
// re-balances the raids that merely lose a target for a beat, and flips a recorded Circus
// victory in the server's fixtures into a defeat. It does make the ORDINARY Video Games
// invasion materially harder (measured difficulty 1.59 -> 2.11), which is the fix landing
// rather than a balance pass. Same cost as v15: an invasion in flight at deploy time
// settles as stale_ruleset and pays nothing.
// 23: the ZOMBIE FORMATION and KNOCKBACK, plus the alien boss's laser, are now the ones in
// the binary rather than this sim's approximations. Four transcript-changing pieces, any
// one of which forces the bump (see docs/mechanics/ZOMBIE_FORMATION_RECOVERED.md and
// ALIEN_RAID_RECOVERED.md):
// (a) FORMATION. `-[ZombieActor calculateDestinationPoint]` derives a zombie's slot from
// its index in `[fightMan zombies]`: depth band = index / FIVE (the same divisor the damage
// and cadence falloffs already used, where the layout used four), and the slot inside a band
// is its rank by BODY TYPE — Small, Headless, Girl, Regular, Large, Garden — each with its
// own standoff, so a light body plants closer to the enemy than a heavy one. Gardens take a
// further fixed setback. The old layout filled 4-deep columns in release order with the
// Headless sorted to the front; the new one changes who is standing where, and therefore who
// the enemy's front-most-target rule picks, from the first frame of every fight.
// (b) HEADLESS PROMOTION is now the source's repair rather than a standing sort: only when
// NO engaged Headless is in the front five is the last one pulled to index 0.
// (c) KNOCKBACK. `-[Actor damageIn:]` rolls `-(50 + arc4random() % 100)` at `force: 5.0`, and
// `movementUpdate:` SLIDES the victim there at force*60 — it is not the old fixed 150-unit
// teleport. For the 0.17-0.5 s the slide lasts the zombie neither walks nor fights and is not
// a melee target, because a live `knockBackPoint` makes `isInMeleeRange` false.
// (d) The alien boss's laser picks a RANDOM ENGAGED zombie (`shootBullet:from:`) instead of
// the rear-most deployed one, holds fire when nobody is engaged, flies at the recovered 180
// points/second instead of a guessed 900, and leaves from one of the saucer's two gun ports.
//
// (d2) SUPER ARMOUR. `cantInterrupt` in Attacks.json is carried by exactly four attacks —
// ZombieBash, ZombieBashV2, ZombieExplode, ZombieExplodeV2 — and `-[Actor fightAttack:]`
// turns it into `fightData.canInterrupt = NO` for that swing, which `damageIn:` checks before
// applying EITHER the stun or the knockback. So a zombie mid-Bash/Smash/Explode can no longer
// be shoved or stunned out of the move it spent a charge on. Previously nothing was immune.
// (e) BALANCE RE-FIT, forced by (c). The Video Games invasion is built out of knockback
// enemies, so it absorbs nearly all of the new shove: its measuring-stick difficulty goes
// 1.99 -> 2.38 ORDINARY. That is the ladder's top rung, and three elite profiles are pinned
// to it, so ELITE_PROFILES 3 / 5 / 6 are re-fitted x1.3 on each multiplier's distance from
// 1.0 (shape untouched) to hold the rungs and the top band. ELITE_PROFILES[9] is NOT
// touched: flattening it was tried and cannot buy back the winnability, because the problem
// was never its own multipliers. The balance suite's "maxed roster" stick also moves 2.2 ->
// 3.0, since at 2.2 it was consumed by the ORDINARY Video Games fight alone and so measured
// its own ceiling rather than the tuning. Same cost as v15: an invasion in flight at deploy
// time settles as stale_ruleset and pays nothing.
// 24: MINIS NO LONGER LEAD THE ROW. v23 brought over the binary's per-body standoff, in
// which the lightest body plants closest to the enemy — `Small: -15`, and the front-most
// slot of its band. Paired with this sim's front-most-target rule (`playerInRange` commits
// an enemy's whole output to the single nearest zombie), that made every Mini in the army
// the designated casualty of every fight, which is what players reported. A Mini now
// buckets and stands with Regular (so do the Cupid Gardens that bucket with Small), leaving
// the Headless as the one body that pushes to the front — its defining behaviour, and
// untouched here. Who stands where decides who the enemy hits, so the transcript diverges
// from the first frame of every fight with a Mini in the party. Narrowing the standoff
// spread also shortens BAND_ROW_DEPTH, which relaxes the in-row compression for every army.
// Same cost as v15: an invasion in flight at deploy time settles as stale_ruleset and pays
// nothing.
// 25: MUTATION VALUES. Four entries in the mutation CATALOG changed what they are worth,
// which changes the army a raid is fought with — `buildPlayerUnits` folds the mutation
// bonus in as a flat addition (v11), so a mutated party's str/dex/con differ from the
// first frame. Eyebiscus and Heartichoke also stopped RIDING a lower tier's bit and were
// appended as mutations of their own, so a unit of either species now carries a different
// mask entirely (upgraded on both sides inside makeOwned — see zombie/variantMutations,
// which is why the two simulations still agree). The four:
//   Eyebiscus    (new bit) +1 str, +2 dex — was Carrot-eyed's +1 dex
//   Heartichoke  (new bit) +5 con         — was Cauli-hair's +3 con, and in the BODY slot
//   Cauli-hair   +3 -> +4 con             — it was identical to Broccohair, six crop
//                                           levels earlier, and lost every Pot conflict
//   Pumpking     +3 -> +4 str             — it was identical to Garlichead, fourteen crop
//                                           levels earlier
// A fight ALREADY in flight replays from its pinned `config_json` and so is not affected
// by the numbers themselves; the bump is for the launch handshake, where a client holding
// the old catalog would otherwise build a different army than the Worker does. Same cost
// as v15: an invasion in flight at deploy time settles as stale_ruleset and pays nothing.
// 26: RESURRECT, brought back to what the binary actually does. Three changes, all in
// BattleSim, all of which move raid outcomes and so must be versioned:
//   * A revived zombie is ALIVE BUT SPENT. `-[ZombieActorGarden ressurectZombie:]`
//     (0x7d3c2-0x7d436) walks the revived actor's abilityList and hands every consumable
//     ability `setConsumed:YES`; `isUseable` (0x9cafc) then refuses it. So an exploder
//     pulled out of its own blast can NOT light a second fuse, and a revived Garden holder
//     can NOT pay the revive forward. It is unconditional — a one-use move the zombie never
//     got round to using is spent too. This retires the v21 re-arm divergence along with
//     `SimUnit.abilityRearms` and its back-of-the-queue tiebreak, which existed only to
//     make the re-arm survivable.
//   * Resurrect now draws from a CORPSE BACKLOG. `-[ZombieActor fightUpdate:]` (0x4d406)
//     appends the dead to `ZFFightMan.defeatedZombies`, which nothing drains but a revival,
//     and the Garden polls `canRez` against it from its own update. The old model fired at
//     the instant of death and lost the corpse if no holder was deployed yet; a holder that
//     arrives later now still brings that casualty back. Target is the most recent corpse.
//   * Resurrect pre-empts Heal on a holder that carries both, matching the single shared
//     cast slot and the `canRez`-before-`canHeal` order at 0x7c0a8.
// Same cost as v15: an invasion in flight at deploy time settles as stale_ruleset and pays
// nothing. In-flight checkpoints are safe — a session pinned to 25 is rejected outright,
// so no pre-backlog snapshot is ever fed to this code.
// 27: THE ALIEN RAID, run against the binary a second time after a tester's report. Full
// disassembly in docs/mechanics/ALIEN_RAID_RECOVERED.md §7. Three of the fixes move raid
// outcomes and so must be versioned:
//   * ZOMBIES VS ALIENS IS A SWARM. `-[ZFFightMan spawnEnemyIn:]` fills a five-slot
//     `enemySlots` array beside the one "current" enemy — six at once — and `spawnTimer`
//     seeds to 10 s on stage 6 and 3600 s everywhere else, so the alien raid is the only
//     one whose slots are ever filled. The other ten stay one-at-a-time, unchanged.
//   * A LANDED BOSS HAS NO ACTIONS. `-[CivilianActorFight bossUpdate:]` only rolls an
//     action in state 19, and a boss that has finished its descent is in state 9 — below
//     the 15..27 window — so it drops through to `civilianUpdate` and just swings. This
//     used to be enforced for throws and walls only, which left Zedzox casting turnZombie
//     and the alien boss firing its laser for the whole ground phase.
//   * `summonBoss` ABDUCTS HUMANS. `bossSummonList` is seeded with four of them and
//     refilled by a five-way roll on every cast, so it never runs dry; the real limit is
//     `allowedToSummonBoss` refusing a second while the first still lives. It replaces a
//     cap of three copies of the wave's own minion, and the abductee is off-budget.
//   * AN ATTACK'S EFFECTS LAND AT ITS OWN FREQUENCY. A unit rolls ONE entry out of its
//     `attacks` list per swing and applies that entry's flags, so knockback and stun
//     belong to the entry that carries them, not to the unit. Collapsing the list to a
//     boolean gave every swing the rarest entry's effects — the Lumberjack's shove lives
//     on a 10 %-frequency special and he was shoving on all 100 %. Also moves the Lawyers
//     boss's stun (40 %) and the Special/TreeWorld/Valentine's minions 2 and 3 (50 %);
//     every other carrier is already at 100 % and is unchanged.
// Two data changes ride along, both playtest verdicts rather than recovered values, and
// both recorded where a regeneration cannot undo them (tools/prep_raids.py UNIT_OVERRIDES,
// BattleSim SUMMON_SPAWN_X): the alien minion's str 6 -> 5 (4 was tried first and read as
// too soft), because the recovered swarm delivers the authored number six times over onto
// one zombie; and the abductee's landing point moved from the stage's arithmetic centre
// onto the scorch mark it is visibly beamed onto. A later playtest also moved the two
// LINES both armies stand on — ENEMY_HOLD_X 915 -> 940 (the zombies' front rank follows it)
// and the Garden healers off a relative setback onto a fixed station at 3/10 of the stage
// (GARDEN_STATION_X) — which changes who is in range of what from the first frame.
// ELITE_PROFILES 6 and 9 are re-fitted in the same change — both raids' difficulty moved
// under the rules above, and the profiles are pinned to a measured ladder.
// Same cost as v15: an invasion in flight at deploy time settles as stale_ruleset and pays
// nothing. The v26 checkpoint fields it retires (`summonsLeft`) are read defensively in
// BattleSim.restore, but a session pinned to 26 is rejected at the handshake anyway.
// v28 — EPIC BOSS RETUNE, two coupled edits in tools/prep_all_epic_bosses.py, mirrored
// into every epic catalog:
//   * the attempt window (EPIC_BOSS_FIGHT_MS) 30 s -> 60 s, and
//   * every rung of EPIC_BOSS_DAMAGE scaled by 0.8 (the ramp's SHAPE is unchanged, so
//     "higher unlock, higher damage" still holds exactly).
// Epic fights are server-replayed through this module and the window is the fight's
// deadline, so a transcript recorded under 30 s does not replay under 60 s.
//
// A BALANCE change, not a mechanics one — no rule here moved. Zombies still enter one at
// a time every CHARGE_MS, which is precisely why the window is load-bearing: it decides
// how much of the army ever reaches the boss (6 of 20 at 30 s, 13 at 60 s), so damage per
// attempt is super-linear in it and a 20-rung ladder cost 135 attempts for an ordinary
// army. Cutting that to roughly a third was the point. The second effect is that the
// per-boss ramp finally becomes legible — it was worth about one zombie across the whole
// ladder at 30 s — and the 0.8x scale is what keeps that from overshooting into
// "own the one right tank or do not play".
// Same cost as every bump: an epic attempt in flight at deploy settles as stale_ruleset.
//
// v29 — EPIC BOSS DAMAGE COMPOUNDS 5% PER RUNG (epicBossDamage in epicBoss/catalog.ts).
// Rung 1 keeps its authored value, so the entry fight of every event is unchanged; the top
// of a ten-rung ladder now hits 1.05^9 = 1.55x. Both the client sim and this module's
// replay read the same helper, so a fight recorded on rung N replays at rung N's damage.
//
// WHY. Play-tested: a maxed army cleared Loco Locust — the hardest event in the game — in
// 11 attempts without losing a single zombie, taking the top rung in two. HP could not fix
// that. HP only buys attempts (the fight is capped and damage carries over), so a ladder
// tuned by HP alone is walkable by any army with enough patience, which is precisely what
// an endgame event should not be. Damage is regressive by design here: it costs a weak
// roster far more than a developed one, and that IS the gate. The bounding rule is
// unchanged and still holds at the new top-rung values — see epicBoss/combat.test.ts.
//
// v30 COMBAT POSITIONING AND EFFECT-FREQUENCY PASS. Production is already pinned to v29,
// so this deterministic batch needs its own version. It changes enemy/front-line and
// Garden support positions, makes alien abductees stationary mid-field blockers, and
// makes knockback/stun respect authored attack-entry frequency instead of every swing.
//
// The same bump covers MINI BUDDY's window. The move is loaded onto a Large while it
// stands in the deployment slot, and
// `readyToActivate` also accepted one still queued at the back ("waiting"), which is not a
// display detail: the button armed from the first frame of the fight and a tap loaded the
// mini onto whichever carrier was furthest right, deployment slot or not. It now requires
// the carrier to have REACHED the slot, which is a tap the sim used to accept and now
// refuses. The finish path drops a refused ability rather than failing (see
// `advanceRaidSegment`), so the two simulations would have settled different fights
// instead of erroring — which is exactly why this needs the bump rather than a quiet fix.
// v31 ZEDZOX'S TWO SPECIALS. Both change the Video Games transcript from the boss's first
// action, and both add a transcribed tap, so the bump is forced twice over.
//
//   * `turnZombie` CONVERTS instead of deleting. It used to be modelled as
//     `dealDamage(victim, victim.hp)`: your front zombie evaporated where it stood, with
//     no projectile, no animation and no attacker within reach, and went home a permanent
//     casualty. That is the "zombies keep dying suddenly for no reason" players reported
//     on this invasion, and it was never what the action does — the source name, the wiki
//     text, and an authored-but-never-spawned `VideoGameStageZombieActor` (con 10000, its
//     own idle/attack frames, listed in no stage table) all say convert. The zombie is now
//     carried out of the fight as `taken` — alive, a survivor, NOT a loss — and a pixel
//     zombie stands up mid-lane wearing its identity. Twenty taps break it open and hand
//     the zombie back (`turnedTap`). A converted body is excluded from the win condition:
//     at a million hit points a fight that had to kill it would run to the cap every time.
//   * `pixelFire` BURNS. Recovered, it lasts exactly one frame — `setOnFire` parks the
//     zombie's destination on its own position, so the burning state ticks once and
//     leaves, making the boss's headline special worth about two damage. It now burns for
//     PIXEL_FIRE_BURN_MS at the recovered 5 %/s while the zombie panics on the spot, and
//     the player can smother it with a tap (`fireTap`). A DELIBERATE divergence from
//     ENEMY_DAMAGE_RECOVERED.md, which the doc now records as such.
//
// Both taps are transcribed for the reason `wallTap` is (v14): they move the SERVER's
// simulation too, and an untranscribed one puts the two permanently out of step.
//
// The same bump covers an ELITE RE-FIT that the conversion forces. ELITE_PROFILES 3/4/5/6
// and 9 all move, so every elite transcript on those five raids changes. The old table put
// the Robots, the Aliens and the Video Games in one shared top BAND, because raid 9's
// ordinary fight measured 2.11-2.72 on the balance stick and there was no headroom above it
// to ramp into — and raid 9's own profile was kept deliberately tiny for the same reason,
// so a Brain Ticket there bought the brains rather than a different fight. That difficulty
// was the instant kill. With it gone the ordinary fight measures 1.33, and the five late
// invasions are re-fitted as a smooth RAMP in ladder order instead: Pirates 1.50, Ninjas
// 1.67, Robots 1.82, Aliens 2.04, Video Games 2.21. Each profile keeps its SHAPE — every
// multiplier's distance from 1.0 is scaled by one factor per raid — so no raid's character
// changes, only where it sits. See eliteInvasion.ts.
//
// Same cost as every bump: an invasion in flight at deploy time settles as stale_ruleset
// and pays nothing.
//
// v32 — MINI BUDDY RAMS TO CONTACT, on a player report. The move is "the brute runs forward
// with the mini aboard and stuns what it HITS", and it charged to the carrier's own
// formation SLOT instead. A Large's slot is the furthest back of any body type (v23 gave
// each body its own standoff), so with a real army the charge stopped short and the stun
// paid out at range — measured: the carrier halted 72 units behind its own front rank and
// stunned a knight 162 units away. A carrier with a passenger now drives at the enemy line
// and dismounts on contact, with the old arrival-at-slot test kept only as a backstop for a
// target that dies mid-charge.
//
// This wanted to ride along on v31 above and CANNOT, which is worth spelling out because
// the mistake is invisible: 31 was already deployed — pushed to Pages and served by the
// live Worker — by the time the ram was fixed. `session.ruleset_version !== VERSION` at
// /raid/finish is the only guard there is, so leaving the number alone does not mean "no
// bump", it means every session started before the deploy replays under rules it was not
// played under, and settles as a disagreement rather than as stale_ruleset. A transcript
// change gets its own number the moment the previous one is live, however small it is.
// v33 — A BLOCKER ONLY STOPS WHAT WAS WALKING PAST IT. An alien abductee is beamed into
// the middle of the lane and treated as a roadblock: zombies short of it stop and fight it
// (see wallInWay / SUMMON_SPAWN_X). "Short of it" was read as pure x, which swept in the
// Garden zombies — they hold at a FIXED station (GARDEN_STATION_X) far behind the front
// line and behind every blocker, so they were counted as blocked by something they can
// never walk to, never reach and never break. Both their heal timers and Resurrect were
// gated on that, so an abduction stopped the army's healing outright for as long as the
// abductee lived, and the alien boss re-summons the moment one dies. Same for the Ninja
// and Robot bosses' WALL, which spawns at supportX — also ahead of the station.
//
// The blocker now only intercepts a unit whose own destination lies beyond it, which is
// exactly the test the march already applied when clamping `destinationX`. Every zombie
// walking to the LINE is still stopped and still fights the blocker; only units already
// standing still, short of it, are let alone. Measured: no ordinary formation slot falls
// behind either blocker AND inside the combat zone, so the Garden zombies are the only
// units whose behaviour moves.
//
// Transcript-changing on the alien, Ninja and Robot invasions, hence the bump. Same cost
// as every bump: a fight in flight at deploy time settles as stale_ruleset and pays
// nothing.
// v34 — BOSS PROJECTILES SCALE WITH THE FIGHT. The authored throw damage is flat chip
// applied verbatim (`ZFFightPhysics throwProjectile:` — see BattleSim), and against
// `con x 100` hit points it had stopped being a mechanic: the Pirate boss lobbed 12.5/25/50
// once every EIGHT seconds at an army it unlocks for at level 21, and measured over a whole
// invasion its throws took 0% off a lone Garden healer — the very unit the lob is aimed at
// (`throwTarget` picks the rear-most zombie, which is the Garden support station). Lawyers
// managed 1%, Ninjas 37%, Robots 47%.
//
// Throw damage is now re-based onto the raid's own rung (RaidCatalog.fightScaledThrow),
// keeping every boss's authored SHAPE — the light/medium/heavy split, each option's
// frequency, the authored duds and the raid's own cadence — and fitting only the magnitude
// to one yardstick: FIFTEEN SECONDS of a boss holding its throws on one target must kill the
// healer a player on that rung would actually own (the most recently PURCHASABLE Garden
// zombie, gold ladder only), with no second healer supporting it. Measured after: nine of the
// ten throwing invasions take that healer from full to dead, the Robots reach 99% (their boss
// abandons the perch mid-fight and stops throwing — see projectileScale.test.ts), and no
// fight that was winnable on the elite balance stick became unwinnable. The floor never
// lowers an authored value, so the alien laser's flat 200 and Zedzox's flat 100s — the
// hardest-hitting authored throw in the game — stand exactly as the binary has them.
//
// Two things ride the same version because they are the same change:
//
//   * OLD McDONNELL'S IS FITTED TO A DPS BAND, not to the flat window. His is the one raid
//     whose throw cadence carries meaning — the ladder speeds up as it climbs, and the first
//     two clears are eased on top of that — and a fixed time-to-kill made all nine
//     combinations land on exactly 16.7 dmg/s, cancelling both ramps. Fitted to a band, the
//     slowest fight the game can present (the opening armed stage, first clear, the one
//     fight `minArmyFor` still lets a player launch with a SINGLE zombie) throws at 12 dmg/s
//     and the fastest at 20.
//   * THE ELITE PROFILES ARE RE-FITTED. `throwDamage` multiplies the ordinary throw, so
//     every Brain Ticket fight would otherwise have charged the rebalance twice — elite
//     Circus measured 343 dmg/s, deleting the healer it aims at in six tenths of a second.
//     Each profile's throw is now a step over the REBALANCED throw, in a 2x-4x band, and the
//     Circus (whose boss has no action but the throw, so the projectile was carrying real
//     difficulty rather than only looking absurd) takes the budget back in str and con to
//     hold the rung it is fitted to. See eliteInvasion.ts.
//
// Transcript-changing on every invasion whose boss throws (all but the Aliens), and on every
// elite fight, hence the bump. Same cost as every bump: an invasion in flight at deploy time
// settles as stale_ruleset and pays nothing.
// v35 — A REINFORCEMENT NO LONGER OPENS A HOLE IN THE LINE. Reported as the enemy
// stopping mid-fight whenever a Regular or a Headless was sent out, and staying stopped
// until that zombie had walked all the way up and taken the front slot.
//
// The row hangs off its front-most member's body standoff (`assignFormation`), and it was
// re-anchored the instant a lighter body was RELEASED rather than when it arrived. So the
// zombie already toe-to-toe with the wave stepped 32 units backwards to make room for one
// still three seconds of walking away — out of `engageDistance`, with nothing else in the
// enemy's reach behind it. Measured on a two-zombie fight: 3.3 seconds of a 8-second
// window with the enemy holding, and because an enemy with no target re-arms its attack
// clock every idle tick, the swings lost are worse than the gap. The binary has no such
// transient: its geometry counts the units BEHIND you (`+5*(n-1-slot)`), so joining a row
// never moves anyone back.
//
// The row now anchors on the front-most member that has actually reached the line, and a
// newcomer that outranks everyone standing walks to the line rather than past it. The
// formation the army settles into is unchanged — the Headless still leads and the heavier
// body still gives way — it just happens on the frame the newcomer arrives, with that
// newcomer in contact, so there is no moment where nobody is.
//
// Transcript-changing on every invasion (any fight where a second zombie is released
// while the first is engaged), hence the bump. Same cost as every bump: an invasion in
// flight at deploy time settles as stale_ruleset and pays nothing.
// v36 — TWO CHANGES, EITHER OF WHICH FORCES THE BUMP.
// (a) MINI BUDDY'S WINDOW IS ANY TIME BEFORE THE CARRIER HAS DEPLOYED — a Large still
// queued at the back or out being deployed both take the mount (BattleSim.canTakeMini).
// This deliberately reverts the charge-slot-only narrowing: that window was a few
// seconds per fight, easy to miss outright, and a Large that deployed un-mounted had
// spent the army's one shot at the move. A tap a v35 Worker refuses as `illegal_ability`
// (the Large still "waiting", or walking out) a v36 client accepts, and the mount
// changes who is standing where from that tick on.
// (b) A CONVERTED ZOMBIE GIVES UP ITS FORMATION SLOT (BattleSim.armyOrder now tests
// `taken`). Reported from the Video Games invasion as "the enemies stop attacking when
// my headless zombie becomes the pixelated zombie": the victim of `turnZombie` keeps
// whatever state it was in, so it kept its slot, and a Headless leads its row from the
// FRONT — the ghost went on anchoring the line it was no longer standing in. The
// survivors re-slotted behind it, one body-standoff short of the wave's 60-unit reach,
// and an enemy with no target holds and re-arms its attack clock every idle tick, so the
// wave stood there swinging at nothing for the rest of the fight (the army, whose combat
// band is 220 deep, kept hitting back — a free win every time Zedzox landed the move
// that is supposed to hurt most). Transcript-changing on every Video Games fight from
// the first conversion onward; the crab's `taken` is client-only, so no other invasion
// moves. Same cost as every bump: an invasion in flight at deploy time settles as
// stale_ruleset and pays nothing.
// v37 — MINI BUDDY PICKS ITS CARRIER IN DEPLOY ORDER. The mount went to whichever
// eligible brute `outranks` put first, and `outranks` means front-most x. Every eligible
// carrier is by definition still un-deployed, and an un-deployed zombie's x is
// `clusterHome` scatter plus an idle shuffle that re-rolls every 2.6-4.8 s — so with more
// than one brute in the party the mount landed on an arbitrary one, and on a DIFFERENT one
// depending on where in the shuffle cycle the tap arrived. The carrier is now the brute
// that will deploy next (`deployRank`), which is the pairing the player is watching when
// they tap. The mini half already resolved to the same unit (the queue is only ever drained
// from the front) and now says so explicitly. The window is unchanged — still any time
// before the carrier has deployed (v36), and still nothing that has already deployed.
// Transcript-changing on any fight with two or more eligible brutes, hence the bump. Same
// cost as every bump: an invasion in flight at deploy time settles as stale_ruleset and
// pays nothing.
// v38 — TWO PIRATE-RAID CHANGES, both transcript-changing from the first contact.
// (a) PROTECT NO LONGER SKIPS HEADLESS. The aura's damage reduction was gated
// `group === "Headless" ? 0 : protect × 0.20` at BOTH sites that compute it
// (CombatEngine build + BattleSim.refreshTeamAuras), so the game's TANK group was the
// only one that could not be shielded — and Protect is a HEADLESS ability, so it skipped
// exactly the body type that carries it. Nothing in the recovered notes justifies that.
// Every zombie now takes the aura, with one rule kept from the old behaviour: a carrier
// does not shield ITSELF, only the rest of the line (`combatStats.protectReduction`, now
// the single source both sites read). So a lone carrier still sits at zero — which is
// what the exclusion was clumsily encoding — while a real Headless line protects each of
// its members with every other carrier's share, up to the same 0.95 cap. Measured: a
// realistic mixed 16-party fields three Headless, so each takes 0.40 and Arrrnold's 5000
// lands as 3000 — survivable outright by a master Bombie's 4084.
// (b) THE DREAD PIRATE ARRRNOLD MIRRORS HIS OPPONENT'S ATTACK SPEED, as the Scallywag
// already does (`mirroredAttackIntervalSec`, max(0.5, opponentInterval²/0.8) — the boss's
// divisor is his own from v44 down). The
// binary reaches that override through the Scallywag class alone, so this half is a
// DELIBERATE DIVERGENCE — see combatStats.PIRATE_BOSS_KEY for the reasoning. It exists
// because his authored 5000-damage slam is larger than the max hit points of every
// zombie in the game (best in roster: 5513), so con buys nothing against him and the
// one-shot latch made every body die on exactly his second swing. Keying his clock to
// the front zombie's gives the matchup a dial: a slow Headless line (1.6 s) holds him to
// 3.2 s, slower than his authored 2.5 s, while a fast front line drives him toward the
// 0.5 s floor. Headless already has front priority, so the counter-play is reachable.
// Measured on a 16-strong master army at levels 21/30/45: mixed party unchanged at 15/16
// survivors, all-Headless 11/16 → 16/16, no-Headless 12/16 → 11/16. No win/loss flipped,
// and the epic-boss bounding rule (src/epicBoss/combat.test.ts) is untouched, because the
// self-shield is what would have moved it.
// Same cost as every bump: an invasion in flight at deploy time settles as stale_ruleset
// and pays nothing.
// v39 — A HELD THROW WINDS UP BEFORE IT RELEASES. Player report: "sometimes bosses don't
// play the animation for throwing objects." The throw animation is a 550 ms arm-swing the
// renderer maps over the last THROW_WINDUP_MS of the boss's action cooldown
// (BattleSim.bossThrowSwing) — but a throw that came due while no zombie was in the lane
// pinned its timer at ZERO and held ("hold the slot until someone is in the lane"), so the
// projectile launched on the very tick a target first appeared, with the swing helper
// having returned "arm at rest" for every preceding frame. Three player-visible cases, all
// the same tick: the FIRST throw of every fight (the action clock starts at 0, faithful to
// `bossActionCooldownTimer`, and nobody is deployed at t=0, so the opening throw fired the
// instant the first zombie walked out), every throw pending across a line wipe, and a
// wind-up whose last target died mid-swing (the arm snapped back to rest, then fired
// instantly on the next arrival).
//
// A waiting throw now PARKS its timer at THROW_WINDUP_MS instead of zero, re-parking every
// tick the lane stays empty (checked before the decrement, so a lane that empties
// mid-wind-up re-parks too). The moment a target enters the lane the timer runs the full
// window down to release — the exact window bossThrowSwing animates over, read from the
// same constant — so a launch with zero telegraph frames is structurally impossible.
//
// Transcript-changing on every throwing invasion (all but the Aliens): each held throw —
// which is at least the first throw of every fight — releases THROW_WINDUP_MS later than
// v38 rolled it, and every subsequent action inherits the shift. The boss's damage output
// only ever drops (throws lost to the added delay, none gained), so no fight winnable on
// v38 becomes unwinnable. Same cost as every bump: an invasion in flight at deploy time
// settles as stale_ruleset and pays nothing.
// v40 — TWO ENGAGEMENT FIXES, both surfaced by the first friend-invasion playtests but
// applying to every fight.
// (a) A GARDEN ZOMBIE THAT CANNOT HEAL FIGHTS IN THE LINE. `isGarden` used to mean the
// body type, and the body type alone bought the whole support treatment: deploy-last,
// pinned at GARDEN_STATION_X (outside the combat zone, outside every enemy's reach),
// boss throws lobbed at it. A Garden zombie whose owner has not unlocked a healing
// ability — heal is the FIFTH tier-1 unlock, so early accounts field plenty — therefore
// stood at the station doing literally nothing, and an army whose last survivor was one
// soft-locked the fight into the four-minute cap. `isGarden` is now set by
// buildPlayerUnits only when the unit actually carries heal / healAOE / ressurect;
// without one it deploys in order, takes a real slot (rear of its band — bodyOf still
// ranks the Garden body last), and swings like everyone else.
// (b) AN ENEMY BEING HIT BY A STANDING FRONT ROW FIGHTS BACK. `playerInRange` returned
// null whenever the melee band was empty, and v36 gave only KNOCKBACK enemies the
// reach-of-last-resort because only they could empty their own range. But the melee
// band also empties when the front SLOT is merely reserved: a Headless walking to the
// promotion slot (or a line re-slotted by a garden reshuffle) holds slot 0 while the
// rest of the row STANDS a row-depth back — inside the combat zone, hitting the enemy
// every swing — and the enemy stood there taking it with no target ("enemies not
// attacking despite zombies being in front of them"). A LINE enemy (not a turned pixel
// zombie, a beamed-in abductee, or a wall — those stand mid-lane and the reach would
// let them shred the army from behind: measured +35% on the ordinary Video Games p*,
// almost entirely the turned unit) with nobody in melee range now strikes the
// front-most FRONT-BAND zombie standing at its slot. Zombies mid-walk stay
// untargetable exactly as before — a line re-forming after a death, a burn or a
// conversion still walks in unpunished — so the change closes only the windows where
// a STANDING row was hitting a contractually blind enemy. Knockback enemies keep their
// broader v36 reach unchanged. Measured on the balance stick: every raid within
// +3-9% of v39 (Pirates and Video Games elites the high end), ramp order intact, and
// the elite profiles did not need to move — the balance suite passes on the same
// numbers. Both halves make fights no easier; a rare v39-marginal win may become a
// loss. Same cost as every bump: an invasion in flight at deploy time settles as
// stale_ruleset and pays nothing.
// v41 — THE PvP DEFENSE FORMATION, and the two things it needed from the sim. Only a
// friend invasion fought in "formation" defense mode is affected; every raid transcript
// is byte-identical, which is what the optional-field gating below buys and what the
// raid suites prove.
// (a) AUTHORED STATIONS AND ARRIVALS. A defender may now carry `stationX`/`stationY`
// (walk here and stand, instead of holding at the shared ENEMY_HOLD_X doorway) and
// `deployAtMs` (walk on when my own clock says so, ignoring the wave's drip budget
// entirely — such a unit neither counts toward `activeTarget` nor competes for it).
// That is what lets a farm defend itself as a FORMATION — a Headless tank holding the
// front at 820, the brute and mini behind it at 890, the line arriving as
// reinforcements — rather than as a wave trickling out of a barn three at a time.
// (b) DEFENDERS KEEP THE ABILITIES THAT RUN THEMSELVES. `toSim` no longer force-strips
// the enemy ability list (every raid enemy is authored with `abilities: []`, so raids
// do not move), and `stepHealing` runs a second pass over the enemy roster. A defending
// Garden zombie therefore HEALS, which it never did: PvP stripped every ability as
// "nobody is home to tap them", but heal needs nobody. Measured before the fix — giving
// the defense a healer made it lose 7 s FASTER, because the slot cost it a fighter and
// bought nothing. `ressurect` is deliberately still stripped on defense: it reads the
// player-side corpse backlog and a defender backlog is its own piece of work.
// A support defender left alone at the back also drops its station and walks up to the
// ordinary doorway, so a won-on-points defense ends in a fight rather than idling into
// the four-minute cap.
// Same cost as every bump: an invasion in flight at deploy time settles as
// stale_ruleset and pays nothing, and stored PvP replays recorded under 40 stop being
// watchable (the 10-per-role window washes that out within a few fights).
// v42 — THE MINI IS THE AMMUNITION, NOT A DEFENDER. In formation mode the defense's
// Small zombie no longer starts on the field: it carries `deployWithBoss` and waits
// off-field while the brute lobs it, taking the field only when the brute climbs down
// and brings it along. It is excluded from the "normals left" test that holds the boss
// on its perch (counting it there would deadlock — the descent is the very thing that
// releases it), from the wave pick, and from the army's front-line anchor while it
// waits. A defense with no brute is unaffected: with nothing to throw it, its mini
// deploys normally, or it would wait for a descent that never comes.
// The line reinforcement beat drops 15 s -> 5 s (PVP_DEFENSE_DRIP_MS), so a formation
// defense puts its Regular and Girl on the ground at 5 s and 10 s instead of 15 s and
// 30 s. Measured as the strongest available dial and the only one that answers an
// attacking army built to out-LAST a defense rather than out-damage it.
// The brute also comes DOWN sooner: it leaves the perch once no non-healer defender is
// standing on the ground, rather than waiting for every last defender (healer included)
// to die. Queued reinforcements do not hold it up, so killing the tank before the drip
// lands earns the brute early. Measured: descent moves 33.0 s -> 24.5 s on the pinned
// fight. Gated on the boss carrying defenseRole "brute", so a raid boss is untouched.
// The brute's throw also now pays BOTH zombies' swings (brute + mini) rather than the
// mini's alone: the brute supplies the arm, the mini the teeth. That is a fight-damage
// change on every formation invasion, which is the other half of why this bump exists.
// Raids are untouched again — `deployWithBoss` is absent on every authored enemy, and
// no raid boss's throw goes through pvpBossThrow.
// v43 — THE WALKING LASER, ON BOTH SIDES.
// (a) THE BOLT PAYS DOUBLE. `laserBeam`/`zomBeam` bolts were ground truth's
// "10 % of Power", which (power = str x 10) made one bolt worth exactly the firer's raw
// strength — 8 damage on the tier-3 Regular that first earns the beam, against 84 for the
// same zombie's ordinary swing. The bolt now pays 20 % of Power, twice the binary's
// (combatStats.laserHitDamage). Strength remains the only input and the firing CADENCE is
// untouched ground truth (attackSpeed/3, and /6 for the Ver.2 upgrade), so dex still
// decides how often the beam fires and still has no say in how hard one bolt lands.
// Measured against melee: the beam goes from 0.30x a front-rank zombie's own melee DPS to
// 0.60x at T3, and 0.60x to 1.20x at T4.
// This makes fights strictly EASIER for any army carrying a laser: a deliberate balance
// change, not a fix. Armies with no laser zombie replay byte-identically, and the step is
// small enough that every elite profile held its fitted rung (eliteInvasion.balance.test).
//
// (b) AND THE DEFENDER GETS ONE TOO — PvP only. The beam was the single ability a defender
// could never have: `pvp.toEnemyCopy` stripped it, and `stepLaser` runs from the zombie walk
// step, which a defender stood on an authored station never reaches. So every player-side
// damage change landed on the attacking side alone and tilted the mode a little further.
// `laserBeam`/`zomBeam` now survive into a FORMATION defense (PVP_DEFENSE_PASSIVE_ABILITIES,
// the same 'nobody has to tap it' test heal passes), fired by BattleSim.stepDefenderLaser on
// the mirror-image trigger: an attacker shoots while IT walks in, a defender shoots while
// THEY do. Same bolt, same clock, through dealEnemyDamage so Protect/Block/the one-shot
// floor all apply. Measured, break-even defense multiplier on the pinned mirror: 1.125
// before this ruleset, 1.175 with the damage buff alone, 1.101 with the defender's beam in.
// Raids are untouched: every authored enemy carries `abilities: []` (a converted pixel
// zombie included), so laserInterval returns 0 and the new call is a no-op. Classic PvP
// defenses are untouched too — they still clear every ability. Stored FORMATION replays
// recorded under 42 stop being watchable; the 10-per-role window washes that out in a few
// fights, the same as at v41.
// Same cost as every bump: an invasion in flight at deploy time settles as stale_ruleset
// and pays nothing.
// v44 — ARRRNOLD IS PRICED ON THE BODY IN FRONT OF HIM. He keeps the v38 mirror, but
// none of the Scallywag's three constants: not its divisor, not its 0.5 s floor, and not
// — the part that actually changes the fight — the thing it reads about its opponent.
//
// The minion mirrors the zombie's CURRENT cycle, which is recovered ground truth and
// stays exactly as it is. Applying that same reading to the boss made his slam get
// FASTER as the player's army got better: veterancy is +5% dex a rank, the level ramp and
// speed abilities add more, and the three dex mutations add +5 FLAT between them — every
// one of those shortens the zombie's cycle, which the square then shortens again. A fresh
// Headless bought him down to a 5 s slam; the same Headless at Master pulled him back up
// to 3.2 s. The mutations are the violent term, and they are also why this was worse for
// every OTHER body than for the counter-play one: a Headless cannot wear them at all
// (makeOwned strips them by body type), but a Large carrying all three goes from a
// 1.538 s cycle to 0.317 s, which under the old reading put Arrrnold on the Scallywag's
// 0.5 s floor — a 5000-damage one-shot twice a second. Since the slam is a one-hit kill
// on every body in the roster (5000 damage against a 5513 best-in-roster max HP), that
// meant progression bought a strictly worse matchup, and the counter-play the raid states
// out loud — "pirates clobber anything that moves too fast" — was something the player
// could not actually hold on to.
//
// He now reads the zombie's SPECIES BASE cycle: 2 s / catalog dex, with no veterancy,
// mutation, level ramp, ability buff or lineup band on it (CombatUnit.speciesCycleMs, set
// once by buildPlayerUnits from the pre-mutation, pre-scale dex; the server rebuilds the
// same field from the pinned party, so nothing new goes over the wire). What decides his
// pace is therefore WHICH BODY leads the line, and nothing else.
//
// The curve is `speciesCycle² / PIRATE_BOSS_MIRROR_DIVISOR`, on a divisor of 2² / 6.5
// ≈ 0.6154 derived from the Headless tuning point rather than authored, floored at
// PIRATE_BOSS_MIN_SLAM_SEC = 1.25 s. The floor is his own and much higher than the
// minion's 0.5 s: at one-shot damage, half a second between slams is not a fight. It
// binds from a 0.877 s species cycle (catalog dex 2.28) down.
//
// Read the result per CATALOG ENTRY, not per family. Two families are uniform and four
// are not, and that difference is the whole reason the counter-play works (measured over
// all 95 entries carrying a group and a dex):
//
//   family     n   catalog dex   slam            at the 1.25 s floor
//   Headless   7   1.0           6.50 s          0/7    <- uniform: the counter-play
//   Large      8   1.3           3.85 s          0/8    <- uniform
//   Garden     8   2.0 - 3.0     1.62 s - floor  2/8
//   Female    13   2 - 8         1.62 s - floor  12/13
//   Regular   54   1 - 8         6.50 s - floor  24/54  <- the whole span, see below
//   Small      5   4.0 - 4.4     floor           5/5
//
// Regular spans the entire range because the family holds both the mainline ladder and
// the named specials. The ladder itself is nearly flat — Tier 1 through Tier 4 and every
// crop variant are dex 2.0 (1.62 s), the Tier 5s dex 2.1 (1.47 s) — so ORDINARY
// progression barely moves him, which is the important half. The outliers are named
// zombies: Zombeach Bum is dex 1 and holds him at 6.50 s exactly like a Headless, while
// Ninjombie, Bandido, Vagabond and the rest of the fast specials sit on the floor. Zula
// Girl is the same story in the Female column (dex 2, 1.62 s, against a family that is
// otherwise floored). So a player CAN hand him a faster clock — by fielding a different,
// faster BODY, never by upgrading the one they have.
//
// Headless keeps front priority, so the counter-play is reachable, unmissable, and — the
// point of the change — permanent: all seven Headless entries are dex 1, so it holds
// whichever one is fielded and at whatever rank, and no upgrade to that zombie can undo
// it. Precisely: it is body CHOICE that is still live, not body PROGRESS.
//
// The Scallywags in that same wave still mirror effective speed, so the
// raid's "too fast" rule keeps its teeth against a decked-out army; it is now the minions
// that enforce it rather than the one-shot boss.
//
// Transcript-changing from the boss's first swing on every Pirates invasion; no other raid
// fields a mirroring enemy and no PvP defense can, so every other transcript is
// byte-identical. Measured on the balance stick (16-strong, front unit a Headless T4 —
// effective cycle 1.6 s, species cycle 2.0 s) at power 1/1.5/2/3, ordinary and elite: the
// boss lands roughly half the slams he used to (6->3 at power 1, 15->9 on the power-2
// elite, 6->3 on the power-3 elite), which is worth ONE extra survivor at three of the
// eight rungs and nothing at the other five. No win or loss flipped: weakest-winning-army
// is 0.451 ordinary / 1.581 elite before and after, to three decimals. His melee was
// always a small share of a fight the Scallywags do most of the killing in — the change is
// to the pacing of the one attack that one-shots, not to the raid's difficulty.
// The old reading is visible in that same trace: on the power-2 elite the v43 boss ran
// 3.25 s -> 2.6 s -> 0.75 s -> 2.55 s as the front slot changed hands, the 0.75 s coming
// from a fast Regular stepping up after the Headless fell. Under v44 the same fight reads
// 6.5 s while the Headless holds. Same cost as every bump: an invasion in flight at deploy
// time settles as stale_ruleset and pays nothing.
export const RAID_RULESET_VERSION = 44;
export const RAID_TICK_MS = 50;
export const RAID_MAX_TICKS = 4 * 60 * 1000 / RAID_TICK_MS;
export const RAID_MAX_INPUTS = 512;
export const RAID_MAX_TRANSCRIPT_BYTES = 32 * 1024;

export type RaidReplayInput =
  | { seq: number; tick: number; type: "bubble"; unitId: string }
  | { seq: number; tick: number; type: "ability"; abilityKey: string }
  | { seq: number; tick: number; type: "wallTap"; unitId: string }
  | { seq: number; tick: number; type: "fireTap"; unitId: string }
  | { seq: number; tick: number; type: "turnedTap"; unitId: string }
  | { seq: number; tick: number; type: "retreat" };

/** How far the server's replay had to depart from the client's account of the fight.
 *  Both counters are ZERO for a fight the two simulations agreed on; anything else is a
 *  divergence worth watching, which is how the ruleset-14 wall desync was caught. */
export interface ReplayDivergence {
  /** Ticks simulated BEYOND the client's `finalTick` to reach an outcome. */
  overrunTicks: number;
  /** Taps dropped because the server's fight had already ended when they arrived. */
  inputsAfterFinish: number;
  /** Well-formed taps the server's own sim REFUSED — its copy of that unit was in a
   *  different state than the player's. Dropped rather than fatal on the finish path
   *  (see `advanceRaidSegment`), and counted here so the desync stays queryable. */
  refusedInputs: number;
}

export type ReplayResult =
  | { ok: true; outcome: RaidOutcome; retreated: boolean; divergence: ReplayDivergence }
  | { ok: false; error: string };

export type SegmentResult =
  | { ok: true; snapshot: BattleSimSnapshot; finished: boolean; outcome?: RaidOutcome; retreated: boolean; lastSeq: number; divergence: ReplayDivergence }
  | { ok: false; error: string };

/** Advance an existing verifier snapshot. Input ticks/sequences remain global, while
 * only the new segment is simulated. A checkpoint never accepts retreat.
 *
 * `runToCompletion` is for the FINISH path only. Client-only hazards (the Circus
 * trapeze, the Beach crab) mean the player's fight and the server's are not the same
 * LENGTH, and transcript ticks are coordinates in the CLIENT's timeline. `finalTick`
 * therefore says when the player's fight ended, which is no reason to stop the server's
 * — but stopping there is what voided ~6% of all Circus/Beach victories. So the server
 * finishes its own fight, and a tap that arrives after it has done so is dropped rather
 * than fatal. Both effects are one-way self-harm: a dropped tap is help the server's
 * player never receives, and the overrun only ever runs the server's OWN deterministic
 * simulation to its own conclusion.
 *
 * A tap the sim REFUSES (`illegal_bubble` / `illegal_ability` / `illegal_wall_tap` /
 * `illegal_fire_tap` / `illegal_turned_tap`) is dropped the same way, for the same reason.
 * All five are the player HELPING their own army — releasing a charged zombie, spending an
 * activated move, chipping a wall, smothering a fire, breaking a converted zombie back
 * out — so a refusal is help the server's player never receives, and every consequence
 * lands on the
 * server's own outcome: a slower fight, fewer survivors, less reward. It cannot invent a
 * win. Holding them fatal instead cost 84 accounts their hazard-raid victories outright
 * (`clientWin` concedes losses only), which is a far worse answer than settling the
 * server's honest, un-helped fight. `refusedInputs` keeps the desync signal that caught
 * the ruleset-14 wall bug. Structurally malformed input (a non-string id, an unknown
 * type, a bad tick or sequence) remains fatal — that is a broken transcript, not a
 * disagreement about state. A checkpoint passes false: mid-fight segments stay exact. */
export function advanceRaidSegment(
  sim: BattleSim,
  startTick: number,
  finalTick: number,
  startingSeq: number,
  inputs: RaidReplayInput[],
  allowRetreat: boolean,
  runToCompletion = false
): SegmentResult {
  if (!Number.isInteger(startTick) || !Number.isInteger(finalTick) || finalTick < startTick || finalTick > RAID_MAX_TICKS) {
    return { ok: false, error: "bad_final_tick" };
  }
  if (!Array.isArray(inputs) || inputs.length > RAID_MAX_INPUTS) return { ok: false, error: "too_many_inputs" };
  if (JSON.stringify(inputs).length > RAID_MAX_TRANSCRIPT_BYTES) return { ok: false, error: "transcript_too_large" };
  let lastSeq = startingSeq;
  let lastTick = startTick;
  let sawRetreat = false;
  for (const input of inputs) {
    if (sawRetreat) return { ok: false, error: "input_after_retreat" };
    if (!input || !Number.isInteger(input.seq) || input.seq !== lastSeq + 1) return { ok: false, error: "bad_sequence" };
    if (input.seq > RAID_MAX_INPUTS) return { ok: false, error: "too_many_inputs" };
    if (!Number.isInteger(input.tick) || input.tick < lastTick || input.tick > finalTick) return { ok: false, error: "bad_input_tick" };
    if (startTick > 0 && input.tick <= startTick) return { ok: false, error: "bad_input_tick" };
    if (input.type === "retreat" && !allowRetreat) return { ok: false, error: "retreat_requires_finish" };
    if (input.type === "retreat") sawRetreat = true;
    lastSeq = input.seq;
    lastTick = input.tick;
  }
  let cursor = 0;
  let retreated = false;
  let inputsAfterFinish = 0;
  let refusedInputs = 0;
  /** A well-formed tap the sim would not take. Fatal mid-fight, dropped at the finish. */
  const refuse = (error: string): { ok: false; error: string } | null => {
    if (!runToCompletion) return { ok: false, error };
    refusedInputs++;
    return null;
  };
  for (let tick = startTick; tick <= finalTick; tick++) {
    while (cursor < inputs.length && inputs[cursor].tick === tick) {
      const input = inputs[cursor++];
      if (sim.finished) {
        // The server's fight ended before the player's did. A tap cannot change an
        // outcome that is already settled, so drop it instead of failing the finish.
        if (!runToCompletion) return { ok: false, error: "input_after_finish" };
        inputsAfterFinish++;
        continue;
      }
      if (input.type === "bubble") {
        if (typeof input.unitId !== "string") return { ok: false, error: "illegal_bubble" };
        if (!sim.popBubble(input.unitId)) {
          const fatal = refuse("illegal_bubble");
          if (fatal) return fatal;
        }
      } else if (input.type === "ability") {
        if (typeof input.abilityKey !== "string") return { ok: false, error: "illegal_ability" };
        if (!sim.activate(input.abilityKey)) {
          const fatal = refuse("illegal_ability");
          if (fatal) return fatal;
        }
      } else if (input.type === "wallTap") {
        // Only a live wall takes a tap, so this can neither reach a normal enemy nor
        // outrun the wall's own hit points: `tapWall` refuses everything else.
        if (typeof input.unitId !== "string") return { ok: false, error: "illegal_wall_tap" };
        if (!sim.tapWall(input.unitId)) {
          const fatal = refuse("illegal_wall_tap");
          if (fatal) return fatal;
        }
      } else if (input.type === "fireTap") {
        // Smothering a `pixelFire` burn. `tapFire` refuses anything that is not a live
        // player zombie actually alight, so this can neither reach another unit nor
        // extinguish a fire twice.
        if (typeof input.unitId !== "string") return { ok: false, error: "illegal_fire_tap" };
        if (!sim.tapFire(input.unitId)) {
          const fatal = refuse("illegal_fire_tap");
          if (fatal) return fatal;
        }
      } else if (input.type === "turnedTap") {
        // Chipping a converted pixel zombie. `tapTurned` refuses everything that is not a
        // live turned unit, so it cannot be aimed at an ordinary enemy or the boss.
        if (typeof input.unitId !== "string") return { ok: false, error: "illegal_turned_tap" };
        if (!sim.tapTurned(input.unitId)) {
          const fatal = refuse("illegal_turned_tap");
          if (fatal) return fatal;
        }
      } else if (input.type === "retreat") {
        retreated = true;
      } else return { ok: false, error: "bad_input_type" };
    }
    if (retreated || sim.finished || tick === finalTick) break;
    sim.step(RAID_TICK_MS);
  }
  // Breaking on `finished` above leaves every LATER tap unvisited. They are dropped for
  // the same reason as the ones the loop did see, so count them the same way.
  if (runToCompletion) inputsAfterFinish += inputs.length - cursor;
  // Past `finalTick` the transcript is exhausted (an input beyond it is `bad_input_tick`
  // above), so this is the server finishing its own unattended fight — no player help
  // reaches it. RAID_MAX_TICKS still caps it at four minutes, and `future_finish` still
  // bounds what the client may CLAIM about elapsed wall-clock time.
  let overrunTicks = 0;
  if (runToCompletion && !retreated && !sim.finished) {
    while (!sim.finished && finalTick + overrunTicks < RAID_MAX_TICKS) {
      sim.step(RAID_TICK_MS);
      overrunTicks++;
    }
  }
  return {
    ok: true,
    snapshot: sim.snapshot(),
    finished: sim.finished || retreated,
    outcome: sim.finished || retreated ? (retreated ? { ...sim.outcome(), win: false, survivors: [] } : sim.outcome()) : undefined,
    retreated,
    lastSeq,
    divergence: { overrunTicks, inputsAfterFinish, refusedInputs },
  };
}

/** Replay only outcome-relevant input against a server-built BattleSim. Rendering and
 * wall-clock frame cadence never enter this function. */
export function replayRaid(sim: BattleSim, finalTick: number, inputs: RaidReplayInput[]): ReplayResult {
  const advanced = advanceRaidSegment(sim, 0, finalTick, 0, inputs, true, true);
  if (!advanced.ok) return advanced;
  // Now only a genuine stalemate — neither side able to finish the other inside the
  // four-minute cap — leaves the replay without an outcome.
  if (!advanced.finished || !advanced.outcome) return { ok: false, error: "truncated_transcript" };
  return { ok: true, retreated: advanced.retreated, outcome: advanced.outcome, divergence: advanced.divergence };
}
