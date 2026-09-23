// The post-45 DUAL INVASIONS — what makes raids 12-15 different from the eleven below them.
//
// Each of the four pairs two shipped factions and carries a TEN-TIER LADDER in place of the
// single difficulty every other invasion has. Beating tier N unlocks tier N+1; any unlocked
// tier can be replayed for its rewards. Tier 1 teaches the fight's mechanic, tier 10 is meant
// to need near-ideal play. See docs/POST_45_PROGRESSION.md.
//
// TIERS REPLACE BRAIN TICKETS HERE, deliberately. An elite flag on top of ten tiers would be
// twenty configurations per raid to reason about, and four more elite profiles fitted into
// headroom eliteInvasion.ts says is already spent. The tier IS the difficulty selector, so
// `acceptsBrainTicket` is false for all four and the launch path refuses one.
//
// DETERMINISM. `tierProfile` feeds the same builders `eliteProfile` does, so it is part of the
// deterministic fight the server replays, and both sides must derive it from the raid id and
// the session's tier and NOTHING else. Editing a profile changes every transcript at that
// tier: bump RAID_RULESET_VERSION in the same commit (see replay.ts).
import { eliteProfile, type EliteProfile } from "./eliteInvasion";
import { seededRandom } from "./RaidCatalog";
import type { WaveCadence } from "./types";

/** Raid ids of the four dual invasions, in ladder order (levels 46-49). */
export const DUAL_INVASION_IDS = [12, 13, 14, 15] as const;

export function isDualInvasion(raidId: number): boolean {
  return (DUAL_INVASION_IDS as readonly number[]).includes(raidId);
}

/** Whether an invasion will accept a Brain Ticket. Every shipped raid does; the four dual
 *  invasions do not, because their tier ladder is the difficulty selector. One predicate so
 *  the launch gate, the UI and the balance suites all ask the same question. */
export function acceptsBrainTicket(raidId: number): boolean {
  return !isDualInvasion(raidId);
}

/** Rungs on every dual invasion's ladder. */
export const MAX_TIER = 10;

/** The lowest tier, which every player starts unlocked. */
export const MIN_TIER = 1;

export function clampTier(tier: number): number {
  if (!Number.isFinite(tier)) return MIN_TIER;
  return Math.max(MIN_TIER, Math.min(MAX_TIER, Math.floor(tier)));
}

/** A tier's scaling of the fight, in exactly the shape `eliteProfile` returns so the throw,
 *  special, wall and enemy builders can take either without knowing which it got.
 *
 *  PLACEHOLDER — PLAYTEST-SET, NOT FITTED.
 *
 *  Every number here is a straight-line ramp, which is certainly wrong in detail and is
 *  meant to be. The ladder's SHAPE is still the thing being built:
 *
 *   1. THE DIFFICULTY OF THESE FIGHTS IS NOT MEANT TO BE IN THEIR STATS. Each one is built
 *      around a mechanic — an objection that bars a class, a charge that has to be
 *      interrupted, copies landing behind the line, a bubble that has to be triaged — and
 *      the tier ladder is supposed to introduce and tighten THOSE before it touches a
 *      multiplier. This table is the floor they stand on, not the ladder itself.
 *   2. NOTHING CAN MEASURE THEM YET. The p* harness never taps an activated ability, so it
 *      cannot see an interrupt, a cancel or a burst window, and it bisects on a stat
 *      multiplier in a way two of these fights break outright. It is being rebuilt after the
 *      four raids are built, and the profiles are fitted after that.
 *
 *  WHY TIER 1 IS NOT 1.0. It was, and the fight was trivial: an unmutated Silver roster beat
 *  raid 12 at rung 7 in 44 s without losing anybody (owner playtest, 2026-09-19). These are
 *  level-46+ invasions fought by accounts with a finished roster, so the AUTHORED wave — the
 *  same enemies a level-16 player meets — is not a floor worth having. Tier 1 now opens above
 *  it and the ladder climbs from there.
 *
 *  `con` is held deliberately low for the same reason eliteInvasion.ts holds it: hit points
 *  are what make a fight LONG, and the fight clock ends a battle at four minutes wherever it
 *  has got to (BattleSim.RAID_TIME_LIMIT_MS). Past a certain bulk a rung stops being hard and
 *  starts being unfinishable — a player who is winning the whole way still loses on the
 *  clock, having been given no way to go faster. Difficulty at the top of these ladders has
 *  to arrive as lethality and mechanics.
 *
 *  `dex` is held at 1.0 low down for a sharper reason: an enemy's attack cycle is exactly
 *  1/dex (see ENEMY_DAMAGE ground truth), so dex is a straight DPS multiplier that COMPOUNDS
 *  with `str`. Raising both at the bottom of the ladder doubles a change you meant to make
 *  once.
 */
export function tierProfile(raidId: number, tier: number): EliteProfile {
  const t = (clampTier(tier) - MIN_TIER) / (MAX_TIER - MIN_TIER); // 0 at t1, 1 at t10
  const ramp = (from: number, to: number) => from + (to - from) * t;
  // LETHALITY is one ramp for all four: a damage multiplier means the same thing whatever
  // the wave is made of. BULK cannot be — see DUAL_BASE_HP — so `con` is solved backwards
  // from the hit points this rung is supposed to field.
  const base = DUAL_BASE_HP[raidId] ?? DUAL_BASE_HP[SIGN_RAID_ID];
  return {
    str: ramp(1.8, 4.5),
    con: ramp(DUAL_WAVE_HP_AT_MIN, DUAL_WAVE_HP_AT_MAX) / base.wave,
    bossCon: ramp(DUAL_BOSS_HP_AT_MIN, DUAL_BOSS_HP_AT_MAX) / base.boss,
    dex: ramp(1, 1.45),
    throwDamage: ramp(1.6, 3),
    throwRate: ramp(1.15, 1.5),
    wallHp: ramp(1.2, 1.6),
    specialDamage: ramp(1.8, 4.5),
  };
}

/** THE HIT POINTS A RUNG FIELDS, which is what the `con` multipliers above are solved for.
 *
 *  A shared curve rather than four, because the rungs have to mean the same thing across
 *  the four invasions: tier 7 should be tier 7 wherever you fight it. The top of the curve
 *  is set by the settle budget below and nothing else — see DUAL_SETTLE_REFERENCE_DPS. */
const DUAL_WAVE_HP_AT_MIN = 70_000;
const DUAL_WAVE_HP_AT_MAX = 110_000;
const DUAL_BOSS_HP_AT_MIN = 12_000;
const DUAL_BOSS_HP_AT_MAX = 20_000;

/** WHAT EACH INVASION'S OWN WAVE WEIGHS at 1.0x, wave and boss separately.
 *
 *  These four fights borrow four different stages, and the stages are nowhere near each
 *  other in bulk — the Circus boss is 1,500 hit points and the Ninja boss is 25,000; the
 *  City wave is 21,400 and the cloned Alien wave is 409,000. ONE multiplier across all four
 *  is therefore meaningless, and trying it is how this was first written: a ramp fitted on
 *  raid 12 put raid 13's tier 10 at 408,000 points, three times what any roster can clear
 *  inside the cap.
 *
 *  So the ladder names a TARGET and divides. The numbers here are measured from what the
 *  builders actually produce (`buildEnemyUnits` + the guest squad), not estimated from the
 *  stage table — and `tierLadder.test.ts` re-derives them from the catalog and fails if a
 *  wave is ever re-composed underneath them.
 *
 *  A number here far above the 70,000 the bottom rung wants is a WAVE THAT NEEDS
 *  RE-COMPOSING, not a datum to live with: the ladder then spends itself shrinking the
 *  fight instead of building it, and the rung stops meaning anything. Raid 15 was exactly
 *  that at 409,000 until Stage 4 fixed the composition rather than the multiplier. */
const DUAL_BASE_HP: Readonly<Record<number, { wave: number; boss: number }>> = {
  12: { wave: 21_400, boss: 4_500 },   // City wave + Old McDonnell's squad
  13: { wave: 58_500, boss: 25_000 },  // Ninja wave + the pirate captain
  // Circus wave + the three towers AT FULL HEIGHT. A stack grows to STACK_MAX_HEIGHT if
  // it is left alone, so its grown weight is what the settle budget has to carry — count
  // one and the fight quietly overruns the curve by two thirds of a tower each. The
  // Ringmaster himself is tiny, which is why his multiplier is the largest in the table.
  14: { wave: 82_600, boss: 1_500 },
  // Alien wave (10 minions) + the ONE robot heavy that escorts it. This used to be
  // 409,000 — the alien stage's twenty minions cloned wholesale WITH the robots in the
  // weighted table, where a BroBot's con 350 against a minion's 60 made a fight nearly
  // four times the whole settle budget, and the ladder had to divide by six to keep it
  // finishable. Stage 4 re-composed it: the aliens are the wave and the robots send one
  // powerful minion, exactly as raids 12 and 13 do with their guest factions.
  15: { wave: 91_000, boss: 25_000 },
};

/** THE SETTLE BUDGET THESE HIT POINTS ARE FITTED TO, written down because the number that
 *  matters is not in the profile — it is the one that breaks it.
 *
 *  A fight that outlives the four-minute clock LOSES, wherever it had got to
 *  (BattleSim.RAID_TIME_LIMIT_MS — a clean, settled, verified loss; an earlier draft of this
 *  comment claimed `truncated_transcript`, which the sim's own cap makes unreachable, and
 *  timeLimit.test.ts now pins that). It is still the constraint that sets these numbers,
 *  because a rung nobody can finish inside the clock is not difficult, it is broken: the
 *  player is beaten by an arithmetic they were never shown and cannot play around.
 *
 *  The binding case is not the strongest roster, it is the WEAKEST one that still wins —
 *  bodies and sustain with almost nothing that ends anything. Measured in the Raid Lab, a
 *  20-strong Headless/Large/Garden/Small wall sustains about 750 damage a second against
 *  this wave.
 *
 *  The figure below is WALL-CLOCK INCLUSIVE — it already carries the walk-in, the drip
 *  opening one slot at a time, the boss's descent and the objection benching part of the
 *  army off and on throughout. It is not a damage stat; it is "hit points per second of
 *  real fight", taken from the one run that matters: that roster cleared raid 12's whole
 *  tier-10 fight, 128,940 points, in 188 s of a 240 s cap.
 *
 *  So the top rung's wave is held near 110,000 hit points and its boss near 20,000, and the
 *  ladder buys its difficulty above that in LETHALITY (`str`, `dex`, `specialDamage`)
 *  rather than in bulk.
 *
 *  An earlier cut of this table ramped `con` to 8.5 instead. It measured beautifully on
 *  every roster that kills quickly — and hung the wall roster at exactly 240 s with the
 *  entire 181,900-point wave cleared and the boss still untouched on its perch. Not a
 *  loss on the merits: a rung that cannot be finished. RAISING con HERE IS NOT A FREE DIAL.
 *  Re-measure that roster, and
 *  see tierLadder.test.ts, which fails before you get as far as playing it. */
export const DUAL_SETTLE_REFERENCE_DPS = 686;

/** THE MULTIPLIERS A FIGHT RUNS UNDER, whichever kind of fight it is: the rung's profile on a
 *  dual invasion, the Brain Ticket's on any other, and null for an ordinary launch.
 *
 *  One function because there are three callers that must never disagree — the client's
 *  RaidManager, the Worker's verifier and the Raid Lab — and a fight built under two
 *  different profiles desyncs the replay from tick 0. The two cases can never both apply:
 *  `acceptsBrainTicket` is false for exactly the raids `isDualInvasion` is true for. */
export function raidProfile(
  raidId: number,
  opts: { elite?: boolean; tier?: number } = {}
): EliteProfile | null {
  if (isDualInvasion(raidId)) return tierProfile(raidId, opts.tier ?? MIN_TIER);
  return eliteProfile(raidId, !!opts.elite);
}

// ---------------------------------------------------------------------------
// THE WAVE LINES UP
// ---------------------------------------------------------------------------
// Ten of the eleven shipped raids trickle: `activeTarget` sits at 1, the field only refills
// when something dies, and the player fights fifteen enemies one at a time. Against a
// finished roster that is not a battle, it is a queue — and it hides the wave, because you
// can never see how much of it is left.
//
// The dual invasions line up instead, exactly as Zombies vs Aliens does: a growing number of
// bodies stand on the field together, so the fight reads as an army and the whole line
// engages at once. Owner decision, 2026-09-19.
//
// The numbers START as a copy of the alien stage's and are DELIBERATELY NOT AN ALIAS of it.
// The alien pair is ground truth transcribed from `spawnTimer`'s seed; these are a design
// choice that happens to agree today, and a future correction to the binary's figures must
// not silently retune four invasions.

/** How many of the wave may stand on the field at once, once the drip has opened up. */
export const DUAL_MAX_ACTIVE = 6;
/** How often another slot opens. The fight still OPENS on one body — `activeTarget` starts
 *  at 1 — so the line builds over the first minute rather than landing all at once. */
export const DUAL_DRIP_MS = 10_000;

/** This invasion's wave cadence, or null where it keeps the one-at-a-time default. */
export function dualWaveCadence(raidId: number): WaveCadence | null {
  return isDualInvasion(raidId) ? { maxActive: DUAL_MAX_ACTIVE, dripMs: DUAL_DRIP_MS } : null;
}

// ---------------------------------------------------------------------------
// RAID 12 — THE OBJECTION (Lawyers & Farmers)
// ---------------------------------------------------------------------------
// The Lawyer boss files a motion to bar a zombie CLASS from the field. A barred class goes
// sad: it stops attacking, drops its place in the line and walks slowly backwards out of
// the fight. The point is not to stall the battle — it is to open a hole in it. Bar the
// Headless and the Garden and the damage dealers are suddenly standing in the open with no
// tank and no heals; bar the Regulars and the Females and the tanks hold a line they cannot
// end.
//
// THE PLAYER CHOOSES WHICH (owner decision, superseding the original fixed placard). Two
// thought bubbles hover over the lawyer naming two different classes, and a tap picks the
// one that goes. So the fight never asks "can you survive what is coming" — it asks "which
// of your two legs do you want to stand on for the next five seconds", over and over, with
// the answer changing as the field does. From PAIRED_SIGN_TIER each bubble holds TWO
// classes, so the same question is asked about whole layers of the army.
//
// IF YOU DO NOT CHOOSE, ONE IS CHOSEN FOR YOU, from `autoPicks` below. That is what makes
// the tap worth making: the default is not the lesser evil, it is a coin the fight tosses.
//
// THE OFFER ORDER IS STILL FIXED AND IDENTICAL EVERY FIGHT — the *pairings* are learnable,
// which is what keeps this a planning puzzle. What is not learnable is what happens when
// you ignore it.
//
// TIMING. One dwell is one SLOT. During slot s the two bubbles for offer s are up and
// nothing new is barred by them; the bar actually in force is the pick that resolved at the
// end of slot s-1. So slot 0 is a free opening window with the first offer already on
// screen, and from then on the player is always choosing one bar ahead while living with
// the last one. See BattleSim.signedGroups / pickSign.
//
// ANTI-STALL. No class is barred for longer than one dwell and the offers always move on,
// so even an army that is entirely one class is only ever out of the fight for
// SIGN_DWELL_MS at a time. That is what keeps a mono-class roster from being benched into
// the four-minute clock and losing a fight it was never allowed to fight.
// At the current 8 s that is a thirtieth of the budget per bar and the worst case — a
// mono-class army barred every other offer — still spends half the fight swinging. Re-check
// the argument before raising it much past a quarter of a minute.
//
// DETERMINISM. A pick is player input, so it is TRANSCRIBED (`signPick`) exactly as a wall
// tap is, and the auto-pick is drawn ONCE at config time from the raid session seed and
// pinned — never rolled mid-fight. Both sides therefore replay the same fight whether the
// player tapped or not. See replay.ts v58 for why a refused pick is the one refusal in the
// transcript that is not self-harm.

/** Lawyers & Farmers — the invasion the objection belongs to. */
export const SIGN_RAID_ID = 12;

/** The six zombie classes an objection can name. */
export const SIGN_GROUPS = ["Headless", "Garden", "Small", "Large", "Regular", "Female"] as const;

/** How long one offer stays up — and so how long the pick it resolves into stays barred.
 *
 *  Eight seconds, raised from five (owner, 2026-09-19). Five was long enough to READ the two
 *  bubbles and not long enough to think about them, which made the choice reflexive; and it
 *  ran the whole six-offer cycle in half a minute, so a rung the player had not learned went
 *  past faster than it taught anything. The ANTI-STALL argument below survives the change
 *  with room to spare. */
export const SIGN_DWELL_MS = 8_000;

/** From this rung each bubble holds TWO classes, in the pairs below. A pair takes a whole
 *  layer off the army rather than one class: the safety net, the burst, or the damage. The
 *  enemies are meant to be eased to compensate — that is a profile change, and profiles are
 *  fitted after the harness rebuild, so it is not done here. */
export const PAIRED_SIGN_TIER = 6;

/** The three layers the paired bubbles are built from, between them all six classes. */
export const SIGN_PAIRS: readonly (readonly string[])[] = [
  ["Headless", "Garden"], // the safety net — no tank, no heals landing
  ["Small", "Large"],     // the burst — nothing gets deleted on demand
  ["Regular", "Female"],  // the damage — the line holds but cannot end anything
];

/** What one bubble contains: the class, or classes, that go if the player picks it. */
export type SignOption = readonly string[];

/** One offer — the two bubbles a player chooses between. Always exactly two: the mechanic
 *  is a dilemma, and a third bubble makes it a menu. */
export type SignOffer = readonly [SignOption, SignOption];

/** The singles offers (below PAIRED_SIGN_TIER). Every class appears in exactly two of the
 *  six, and no offer repeats a pairing, so over one full cycle the player has been made to
 *  give up each class at least once and has had a genuine choice about it every time. The
 *  first three are the "same layer" dilemmas — the hardest to answer, because whichever you
 *  keep is the one doing that job alone — and the last three cross layers. */
export const SIGN_OFFERS: readonly SignOffer[] = [
  [["Headless"], ["Garden"]], // the safety net: the body, or the healing on it
  [["Small"], ["Large"]],     // the burst: the fuse, or the weight behind it
  [["Regular"], ["Female"]],  // the damage: the volume, or the procs
  [["Headless"], ["Regular"]],// the front: who stands there, or who kills from it
  [["Garden"], ["Small"]],    // sustain, or the move you were saving
  [["Large"], ["Female"]],    // the anchor, or the stuns holding the flank
];

/** The paired offers (from PAIRED_SIGN_TIER). Three layers, each set against the next, so
 *  every offer costs the army a whole job and the question is only which one. */
export const SIGN_PAIRED_OFFERS: readonly SignOffer[] = [
  [SIGN_PAIRS[0], SIGN_PAIRS[1]], // safety net, or burst
  [SIGN_PAIRS[1], SIGN_PAIRS[2]], // burst, or damage
  [SIGN_PAIRS[2], SIGN_PAIRS[0]], // damage, or safety net
];

/** How many slots of auto-pick to pre-draw. A fight is capped at four minutes
 *  (replay.RAID_MAX_TICKS) which is 48 dwells, and this is not imported from there because
 *  replay.ts already depends on this module. Sized with headroom, and the sim wraps the
 *  index anyway, so a shorter dwell can never run the table dry. */
export const SIGN_MAX_SLOTS = 64;

export interface SignConfig {
  /** The offers, in order. The fight cycles through them. */
  offers: readonly SignOffer[];
  /** How long each offer stays up before it resolves. */
  dwellMs: number;
  /** Which bubble is taken when the player does not choose, one per slot, PRE-DRAWN from
   *  the session seed. Pinned into the fight config rather than rolled during the fight:
   *  the client and the verifier must agree about an unattended slot without exchanging
   *  anything, and a pinned table is the cheapest way to be certain they do. */
  autoPicks: readonly number[];
}

/** The objection config for a fight, or null for an invasion that has none.
 *
 *  `seed` MUST be the raid session id online — the verifier pins the config it builds from
 *  the same seed at /raid/start, and the client redraws from it, exactly as the Robots'
 *  wave does (see RaidCatalog.resolveStageWave). Offline any value works. */
export function signFor(raidId: number, tier: number, seed: string): SignConfig | null {
  if (raidId !== SIGN_RAID_ID) return null;
  const rung = clampTier(tier);
  const rand = seededRandom(`sign:${seed}:${raidId}:${rung}`);
  return {
    offers: rung >= PAIRED_SIGN_TIER ? SIGN_PAIRED_OFFERS : SIGN_OFFERS,
    dwellMs: SIGN_DWELL_MS,
    autoPicks: Array.from({ length: SIGN_MAX_SLOTS }, () => (rand() < 0.5 ? 0 : 1)),
  };
}

/** Which bubble an unattended slot takes. Wraps, so a slot beyond the pre-drawn table
 *  still answers — it cannot happen inside the settle cap, and a fight that somehow got
 *  there must not crash on it. */
export function autoPickFor(sign: SignConfig, slot: number): number {
  if (!sign.autoPicks.length) return 0;
  const pick = sign.autoPicks[Math.max(0, slot) % sign.autoPicks.length];
  return pick === 1 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// RAID 12 — THE FARMER SQUAD
// ---------------------------------------------------------------------------
// Every other invasion trickles: `activeTarget` sits at 1 and the field only refills when
// something dies, each death buying ENEMY_EMERGE_GAP_MS of dead air before the next walks
// in. High damage therefore buys BREATHING SPACE, 450 ms at a time, and that dead air is
// most of what keeps a Headless alive.
//
// The squad is the moment that stops being true. Old McDonnell and three farmhands walk on
// TOGETHER, off the wave budget, and they are timed to land on the slot whose bar came out
// of the DAMAGE offer — so they arrive on a line that has just lost part of its ability to
// make gaps at all. That timing is the whole mechanic; a squad at any other moment is just
// four more enemies.
//
// Since the player now chooses, the squad no longer lands on a KNOWN hole — it lands on
// whichever of the two damage classes the player decided they could do without, and the
// bubbles are up while the farmers are already walking in. That is the intended shape of
// the decision: the cost of the choice is visible before it is paid.
//
// ONE SQUAD, and the reason is the settle cap rather than taste. A squad member waiting on
// its `deployAtMs` is alive and queued, which counts toward `normalsLeft` and so HOLDS THE
// BOSS ON ITS PERCH: the fight cannot end before the last squad has walked on. Three squads
// spread across the rotation would put a hard floor of ~80 s under every fight, on a
// four-minute budget that also has to cover the wave, the boss and its descent. If more
// squads are ever wanted, that floor is the thing to solve first.

/** Who walks on together: the farm boss leading three farmhands. */
export const FARMER_SQUAD_LEADER = "FarmStageActorBoss";
export const FARMER_SQUAD_MINION = "FarmStageActorFarmhand";
export const FARMER_SQUAD_MINIONS = 3;

/** The classes whose absence is what the squad is timed against: the army's ability to
 *  END things, and so to buy itself dead air between bodies. */
export const SIGN_DAMAGE_GROUPS: readonly string[] = ["Regular", "Female"];

/** When the squad arrives: the start of the slot barred by the first offer that puts a
 *  damage class on the table. `+ 1` because an offer made during slot s is what is barred
 *  during slot s+1 (see the TIMING note above).
 *
 *  Derived from the offers rather than hard-coded, so both offer tables (singles low down,
 *  pairs from PAIRED_SIGN_TIER) get the right moment without a second table. */
export function farmerSquadAtMs(sign: SignConfig | null): number | null {
  if (!sign) return null;
  const index = sign.offers.findIndex((offer) =>
    offer.some((option) => option.some((group) => SIGN_DAMAGE_GROUPS.includes(group))));
  return index < 0 ? null : (index + 1) * sign.dwellMs;
}

// ---------------------------------------------------------------------------
// RAID 13 — THE CHARGE AND POISE (Ninjas & Pirates)
// ---------------------------------------------------------------------------
// The pirate captain fights on the ground here — the ninja holds the boss slot — and he is
// authored `str 500, dex 0.4`, which is already the biggest single blow in the game by a
// wide margin (the Robots' heaviest throw is 50). The charge-up slam is not an invention on
// top of that stat block; it is that stat block, made visible: he swells and reddens through
// a long wind-up and then lands one enormous area hit.
//
// POISE is what makes it a fight rather than a countdown. Stuns FILL A BAR instead of
// overwriting one another, and filling it before the wind-up completes sends him back to
// the start of the charge.
//
// WHY A BAR AND NOT A STUN. Everywhere else in the sim a stun is `Math.max`, and against a
// charge that is an off switch rather than a counter: a Female tier-3 proc is 5% per swing
// for a full second, so a girl-heavy front line lands one about every 1.7 s and a 2.5 s
// wind-up would simply never complete, for the whole fight, for free. The bar keeps girls as
// a real contribution — roughly a quarter of it across a long charge — while making the
// ANSWER a deliberate move somebody had to hold in reserve.
//
// Contributions are per SOURCE rather than per millisecond, because the design intent is
// about what a move costs the player, not how long it happens to freeze someone: Smash is on
// a 10 s cooldown, the ram and the fuse are one-use and cost the zombie.

/** Ninjas & Pirates — the invasion the charge belongs to. */
export const CHARGE_RAID_ID = 13;

/** What each stun source puts into the poise bar, as a fraction of it. */
export const POISE_CONTRIBUTION: Readonly<Record<string, number>> = {
  stun: 0.1,        // Female tier-3 proc — a supplement, never an answer
  bashV2: 0.5,      // Smash: half the bar, but it comes back every 10 s
  attachMini: 1.0,  // the Mini Buddy ram — one-use, and it costs you the mini
  explode: 1.0,     // the fuse — one-use, and it costs you the zombie
  explodeV2: 1.0,
};

/** The bar is always exactly one bar. The rung dials the CHARGE TIME instead (below), which
 *  keeps one banked ram or fuse always sufficient for one slam while making the slams come
 *  faster than any army can answer them all. The question the fight asks is which ones you
 *  stop, never whether you can. */
export const POISE_THRESHOLD = 1;

/** Wind-up at the bottom and the top of the ladder. Ten seconds is long enough to see the
 *  swell, react, and still land a move; five is long enough to do it if you were ready. */
export const CHARGE_MS_AT_MIN_TIER = 10_000;
export const CHARGE_MS_AT_MAX_TIER = 5_000;

/** How long after a broken charge before he can begin another. Without it a player holding
 *  two ready answers could deny the slam back to back for as long as the answers lasted,
 *  which is the same off switch poise exists to remove — it just costs more. */
export const CHARGE_RECOVERY_MS = 2_500;

/** When the captain walks on. He needs his OWN clock for the same reason the farmer squad
 *  does, and for a sharper one: appended to the wave he lands at the BACK of a
 *  ten-deep queue that releases one body at a time, so the fight's centrepiece would not
 *  appear until the player had already killed everything else — and on a short fight,
 *  never. Early and off-budget instead: he arrives while the wave is still trickling, so
 *  the player meets him AND the minions, which is the pressure the fight is for. */
export const CAPTAIN_ARRIVES_MS = 3_000;

export interface ChargeConfig {
  /** Wind-up length at this rung. */
  windupMs: number;
  /** Pause after a slam OR a broken charge before the next wind-up begins. */
  recoveryMs: number;
  /** Area damage the slam lands on every deployed zombie. */
  damage: number;
}

/** The charge the pirate captain carries at this rung, or null for an invasion without one.
 *
 *  `damage` is NOT his authored 5,000-per-hit: that is a number for a single melee target,
 *  and this lands on the whole line at once. It is capped here, and the cap is a PLACEHOLDER
 *  like every other number in these four fights — see the OPEN item in the doc. */
export function chargeFor(raidId: number, tier: number): ChargeConfig | null {
  if (raidId !== CHARGE_RAID_ID) return null;
  const t = (clampTier(tier) - MIN_TIER) / (MAX_TIER - MIN_TIER);
  return {
    windupMs: Math.round(CHARGE_MS_AT_MIN_TIER + (CHARGE_MS_AT_MAX_TIER - CHARGE_MS_AT_MIN_TIER) * t),
    recoveryMs: CHARGE_RECOVERY_MS,
    damage: Math.round(400 + 400 * t),
  };
}

/** The poise a stun source contributes (0 when it contributes nothing). */
export function poiseFor(source: string): number {
  return POISE_CONTRIBUTION[source] ?? 0;
}

// ---------------------------------------------------------------------------
// RAID 13 — THE DEX TAX
// ---------------------------------------------------------------------------
// The ninja holds the perch and throws, and how OFTEN he throws is a function of the army
// underneath him: the total attack speed of everything the player has deployed. The fight
// opens quiet and ends as rapid fire.
//
// This is a ROSTER tax, not a pacing decision. The player cannot hold a zombie back —
// `promote()` auto-charges the next whenever nobody is charging — so the lever is what you
// BRING. Sixteen Vagabonds (dex 8, against a reference maximum of 4.4) make the sky rain;
// a line of Large brutes (dex 1.3) keeps it quiet. It lands on exactly the two stack metas:
// Female averages 4.18 dex and Regular tops out at 8 entirely because of the Vagabond.
//
// It is also the one enemy behaviour in the game that reads the player's own units, so it
// is worth being explicit that it stays deterministic: deployed dex is sim state, both
// sides run the same sim from the same pinned config, and nothing here touches a roll.

/** Dex on the field at which the throw interval has been cut in half. Tuned as a
 *  PLACEHOLDER: 32 is sixteen dex-2 zombies, i.e. a full army of ordinary ones. */
export const DEX_TAX_HALF_AT = 32;

/** The floor on the interval, as a fraction of the authored one. Without it a maxed
 *  dex-8 army drives the interval toward zero and the fight becomes a wall of projectiles
 *  no roster can survive — the tax is meant to bite, not to be a hard cap on dex. */
export const DEX_TAX_MIN_FRACTION = 0.25;

/** The throw interval for a given authored interval and the total dex now deployed.
 *  `deployedDex` 0 (nobody out yet) returns the authored interval unchanged. */
export function dexTaxedInterval(authoredMs: number, deployedDex: number): number {
  const dex = Math.max(0, deployedDex);
  const scale = Math.max(DEX_TAX_MIN_FRACTION, DEX_TAX_HALF_AT / (DEX_TAX_HALF_AT + dex));
  return Math.max(1, Math.round(authoredMs * scale));
}

/** Whether this invasion's perched boss charges the dex tax. Raid 13 alone. */
export function isDexTaxRaid(raidId: number): boolean {
  return raidId === CHARGE_RAID_ID;
}

// ---------------------------------------------------------------------------
// RAID 14 — THE SECOND LINE (Circus & Video Games)
// ---------------------------------------------------------------------------
// Everything happens BEHIND you. A line built for a one-sided fight is suddenly the wrong
// way round: the trapeze drops copies of the player's own zombies into the army's rear,
// where the tank isn't and the healer is, while the circus stacks build themselves up at
// the front and the player is looking the other way.
//
// WHY A COPY IS A BLOCKER. It stands on a station in the player's REAR and carries
// `isBlocker`, which is the sim's existing word for "a thing standing mid-lane that only
// the zombies which have not already walked past it will fight" (see wallInWay /
// passedBlockers). Three things fall out of that, and all three are the design:
//
//   * The front line cannot turn round and help. A zombie attacks whatever is NEAREST in
//     x and it swings from wherever it stands, so an ordinary enemy dropped in the rear
//     would just be shot down from the line at no positional cost and the mechanic would
//     be free. The latch is what makes the rear a different fight.
//   * Reinforcements have to cut their way in. A zombie deployed after the copy lands
//     stops at it, so the copies are a toll on the queue rather than a nuisance behind it.
//   * It can never hang the fight. Blockers sit outside the win condition (BattleSim
//     anyAlive), which they had to anyway: a copy nobody can reach is exactly the
//     orphaned-wall stall ruleset 59 fixed.
//
// So the answers are the ones the design asked for — lasers, which fire over the line and
// are ungated by position, and burst from whoever is still walking in. Neither is
// something the two-healers-two-tanks-twelve-Vagabonds meta brings.
//
// THE PLAN HAD A FOURTH DIAL, "copy keeps mutations", and it is not here. A copy is cloned
// from the BUILT unit, which is the only thing the sim has: `SimUnit` is flattened to
// damage / maxHp / cooldownMs with the species stats, the level ramp, the farmer
// multipliers and any mutations already folded in, and there is no way back to the parts.
// So a copy is exactly as strong as the zombie it copied and cannot be anything else. The
// three dials that remain — how many, how much life, and whether it keeps its passives —
// carry the ladder on their own.

/** Circus & Video Games — the invasion the second line belongs to. */
export const COPY_RAID_ID = 14;

/** Where a copy is dropped: behind the combat line, level with the support station, in
 *  among the healers and the zombies still filing forward. Not so far back that it lands
 *  on the staging slot, where it would meet the army one at a time as they charge. */
export const COPY_STATION_X = 430;

// THE TRAPEZE NEEDS A LINE TO DROP BEHIND, and at the opening bell there is not one. A
// copy lands in front of everyone still filing forward, so the very first deployment made
// one that walled the whole army into its own staging area — measured in
// secondLine.test.ts, where the lead zombie parked at 370 and never reached the front at
// all. So no copy is dropped until somebody has marched PAST the drop point (see
// BattleSim.spawnCopy).
//
// That gate rather than a fixed delay, because a delay is a guess about army size: twenty
// zombies take over a minute to file out and two are gone in seven seconds. "Is there a
// line yet" is the actual condition, and it reads the field instead of the clock.

/** The copy's tint, so a zombie fighting its own reflection can be told from it at a
 *  glance. `CombatUnit.color` already rides through to the rig on both sides. */
export const COPY_TINT: readonly [number, number, number] = [150, 120, 210];

export interface CopyConfig {
  /** How many copies may stand at once. The cap is what bounds the toll on the queue. */
  maxAlive: number;
  /** Fraction of the original's hit points the copy carries. */
  hpFraction: number;
  /** Whether it keeps the SELF/PASSIVE abilities — the lasers, the blocks, the double
   *  strikes. Never the activated ones at any rung: those are taps, and a copy has nobody
   *  to tap them (the same reason PvP strips them from a defender). */
  keepPassives: boolean;
}

/** The copies at this rung, or null for an invasion without them. Every dial is on the
 *  COPIES and none on the statline — the tier ladder's stat ramp already does that job,
 *  and this fight's difficulty is meant to be the second line rather than bigger numbers
 *  on the first one. */
export function copiesFor(raidId: number, tier: number): CopyConfig | null {
  if (raidId !== COPY_RAID_ID) return null;
  const rung = clampTier(tier);
  const t = (rung - MIN_TIER) / (MAX_TIER - MIN_TIER);
  return {
    maxAlive: rung >= 8 ? 4 : rung >= 5 ? 2 : 1,
    hpFraction: 0.6 + 0.4 * t,
    keepPassives: rung >= MAX_TIER,
  };
}

/** The self/passive abilities a copy may keep. Deliberately PvP's formation-defense list
 *  minus the heals: a copy of your Garden zombie healing the OTHER copies turns the rear
 *  into a fight the player cannot finish from where they are standing. */
export const COPY_PASSIVE_ABILITIES: readonly string[] = [
  "laserBeam", "zomBeam", "block", "doubleStrike", "turbo",
];

// ---------------------------------------------------------------------------
// RAID 14 — THE STACKS
// ---------------------------------------------------------------------------
// `CircusStageActorMinion2` swings `MidgetStackAttack` and the ringmaster throws
// `projectile_midget.png`, so a tower of circus midgets is authored art, not an invention.
//
// ONE UNIT WITH A HEIGHT, never three units. Three stacks at three tall is nine extra
// bodies on top of the wave, the copies and the boss, and the fight still has to settle
// inside four minutes (see DUAL_SETTLE_REFERENCE_DPS). It also makes toppling legible:
// burst knocks a level off something the player can see, rather than killing one of three
// identical figures.
//
// HEIGHT IS DERIVED FROM HIT POINTS, which is the whole trick. A stack that has climbed to
// `stackMax` carries that many of its own base pools, and the height it FIGHTS at is how
// many of those pools are still standing — so a hit worth one pool topples one level, and
// the thing gets weaker as it comes apart without needing a second state machine.

/** How many stacks the ring holds, and how tall each may grow. */
export const STACK_COUNT = 3;
export const STACK_MAX_HEIGHT = 3;

/** How long a stack takes to climb another level. Faster up the ladder: the fight is a
 *  race between the player's burst and the tower, and this is the clock they race. */
export const STACK_GROW_MS_AT_MIN_TIER = 12_000;
export const STACK_GROW_MS_AT_MAX_TIER = 6_000;

/** When the stacks walk on, spaced so they do not arrive as one wall. */
export const STACK_FIRST_AT_MS = 6_000;
export const STACK_GAP_MS = 9_000;

export interface StackConfig {
  /** Ms between one level and the next, while the stack is left alone. */
  growMs: number;
  /** Tallest it may get. */
  maxHeight: number;
}

/** The stack rules at this rung, or null for an invasion without them. */
export function stacksFor(raidId: number, tier: number): StackConfig | null {
  if (raidId !== COPY_RAID_ID) return null;
  const t = (clampTier(tier) - MIN_TIER) / (MAX_TIER - MIN_TIER);
  return {
    growMs: Math.round(
      STACK_GROW_MS_AT_MIN_TIER + (STACK_GROW_MS_AT_MAX_TIER - STACK_GROW_MS_AT_MIN_TIER) * t,
    ),
    maxHeight: STACK_MAX_HEIGHT,
  };
}

// ---------------------------------------------------------------------------
// RAID 14 — THE RINGMASTER
// ---------------------------------------------------------------------------
// From rung 5 he stops waiting for his wave. He drops out of the car into the MIDDLE of
// the field and fights there, which matters for one reason beyond the flavour: a boss that
// waits is a boss the player meets once the field is already clear, and this fight is
// about not being able to be in two places at once. Arriving early is what makes that bite.
//
// He lands on a station with `anchorsLine` false. Without that flag `refreshFrontLine`
// re-derives the army's stopping line from the front-most authored station, so anything
// dropped mid-field drags the whole line forward to meet it — and the army would simply
// re-form around him, which is the opposite of the intent.

/** The rung from which the ringmaster stops waiting for his wave. */
export const RINGMASTER_EARLY_TIER = 5;

/** When he drops, and where he stands. Mid-lane: far enough forward that the line has
 *  formed in front of him, far enough back that walking to him means leaving it. */
export const RINGMASTER_DROPS_AT_MS = 25_000;
export const RINGMASTER_STATION_X = 640;

/** Ms after which the ringmaster abandons his perch whatever the wave is doing, or null
 *  when this fight does not do that (every other raid, and the rungs below the fifth). */
export function ringmasterDropMs(raidId: number, tier: number): number | null {
  if (raidId !== COPY_RAID_ID) return null;
  return clampTier(tier) >= RINGMASTER_EARLY_TIER ? RINGMASTER_DROPS_AT_MS : null;
}

// ---------------------------------------------------------------------------
// RAID 15 — THE BUBBLE (Aliens & Robots)
// ---------------------------------------------------------------------------
// The hardest of the four, and the only one whose mechanic is a DECISION ABOUT THE FUTURE.
// A thought bubble appears over the saucer with a charging bar and an icon naming what is
// coming. The player holds a limited number of cancels and must choose which disasters to
// stop and which to eat.
//
// THE ORDER IS FIXED AND IDENTICAL EVERY FIGHT, like the objection's offers and for the
// same reasons: it is a planning puzzle rather than a slot machine, and it costs the replay
// no randomness at all. What keeps the decision live is not surprise, it is SCARCITY —
// fewer charges than actions means a fixed order produces a fixed MENU rather than a fixed
// answer, and which items you can afford depends on how the fight has gone.
//
// The five overlap on purpose, so no roster has a standing answer:
//
//   wall     splits the line          — punishes low burst
//   aoe      chunks the whole army    — punishes low HP, and worse if a swap took a healer
//   swap     the next queued alien becomes a much tougher one — punishes low DPS
//   stunAll  a free window for whatever else is standing — trivial UNLESS a wall is up
//   portal   half the army to the back of the lane — and it makes the wall matter again
//
// THE WALL SITS INSIDE THE PLAYER'S OWN HALF (`supportX`, halfway between the staging slot
// and the front line), which is counter-intuitive and load-bearing: it does not bar the
// front line, which has already walked past it. It cuts REINFORCEMENTS off. So wall plus
// abductee is a double-thick roadblock across the player's own lane, and wall + portal is
// the fight's signature play — half the army thrown to the back and then walled in behind
// two blockers while the other half fights alone.

/** Aliens & Robots — the invasion the bubble belongs to. */
export const BUBBLE_RAID_ID = 15;

/** What the saucer can be thinking about. */
export type BubbleAction = "wall" | "aoe" | "swap" | "stunAll" | "portal";

/** The cycle, in order. The swap is deliberately NOT last: it needs a non-empty wave queue
 *  to have anything to replace, and a cancel spent on an action that would have fizzled is
 *  a cancel the player was cheated out of. Ending on the portal also puts the signature
 *  play at the end of the loop, where the wall it re-enables is already standing. */
export const BUBBLE_CYCLE: readonly BubbleAction[] = ["wall", "aoe", "swap", "stunAll", "portal"];

/** The portal appears only from this rung — it is the action that makes the whole set
 *  compound, so it is the last thing the ladder teaches. Below it the cycle is four long. */
export const PORTAL_TIER = 6;

/** How much of the deployed army the portal throws back to the staging slot. */
export const PORTAL_FRACTION = 0.5;

/** Cast length: the reaction window, and the single most important dial on this fight.
 *  Eight seconds is long enough to read the icon, look at the field and decide; four is
 *  long enough only if you already knew what you were going to do. */
export const BUBBLE_CAST_MS_AT_MIN_TIER = 8_000;
export const BUBBLE_CAST_MS_AT_MAX_TIER = 4_000;

/** Quiet between one cast resolving and the next beginning. */
export const BUBBLE_GAP_MS_AT_MIN_TIER = 7_000;
export const BUBBLE_GAP_MS_AT_MAX_TIER = 3_000;

/** Cancels the player starts with. Fewer than the cycle at every rung — that is what makes
 *  a fixed order a menu instead of an answer — and fewer still up the ladder. */
export const BUBBLE_CANCELS_AT_MIN_TIER = 4;
export const BUBBLE_CANCELS_AT_MAX_TIER = 2;

/** A cancelled cast does not vanish: the saucer goes quiet for this long and then moves on
 *  to the NEXT action in the cycle. Long at the bottom (a cancel buys real time), short at
 *  the top (a cancel buys only the action). */
export const BUBBLE_CANCEL_RECOVERY_MS_AT_MIN_TIER = 9_000;
export const BUBBLE_CANCEL_RECOVERY_MS_AT_MAX_TIER = 2_000;

/** What the AoE takes off every deployed zombie, and how long stun-all holds them. */
export const BUBBLE_AOE_DAMAGE_AT_MIN_TIER = 220;
export const BUBBLE_AOE_DAMAGE_AT_MAX_TIER = 700;
export const BUBBLE_STUN_MS = 3_000;

/** What the queue swap multiplies the replaced alien's body and blow by. A swap adds NO
 *  body to the field — it re-stats one that was already queued — so it can neither stall
 *  the boss's descent nor spend the settle budget. */
export const BUBBLE_SWAP_MULT_AT_MIN_TIER = 2.5;
export const BUBBLE_SWAP_MULT_AT_MAX_TIER = 4.5;

export interface BubbleConfig {
  /** The actions, in the order they are cast. */
  cycle: readonly BubbleAction[];
  /** The reaction window on each cast. */
  castMs: number;
  /** Quiet between casts. */
  gapMs: number;
  /** How long the saucer sulks after a cancelled cast. */
  cancelRecoveryMs: number;
  /** Cancels the player starts the fight holding. */
  cancels: number;
  /** Damage the AoE lands on every deployed zombie. */
  aoeDamage: number;
  /** How long stun-all holds the army. */
  stunMs: number;
  /** What the queue swap multiplies its victim by. */
  swapMult: number;
}

/** The bubble at this rung, or null for an invasion without one. */
export function bubbleFor(raidId: number, tier: number): BubbleConfig | null {
  if (raidId !== BUBBLE_RAID_ID) return null;
  const rung = clampTier(tier);
  const t = (rung - MIN_TIER) / (MAX_TIER - MIN_TIER);
  const ramp = (from: number, to: number) => from + (to - from) * t;
  const cycle = rung >= PORTAL_TIER ? BUBBLE_CYCLE : BUBBLE_CYCLE.filter((a) => a !== "portal");
  return {
    cycle,
    castMs: Math.round(ramp(BUBBLE_CAST_MS_AT_MIN_TIER, BUBBLE_CAST_MS_AT_MAX_TIER)),
    gapMs: Math.round(ramp(BUBBLE_GAP_MS_AT_MIN_TIER, BUBBLE_GAP_MS_AT_MAX_TIER)),
    cancelRecoveryMs: Math.round(
      ramp(BUBBLE_CANCEL_RECOVERY_MS_AT_MIN_TIER, BUBBLE_CANCEL_RECOVERY_MS_AT_MAX_TIER),
    ),
    // ALWAYS at least one short of the cycle. The budget is what turns a fixed order into
    // a menu rather than an answer, and the cycle is SHORTER below PORTAL_TIER — so the
    // straight ramp handed the bottom rung four cancels for four actions and the player
    // could simply switch the mechanic off. Caught by bubble.test.ts, which is the only
    // place that would have noticed.
    cancels: Math.max(1, Math.min(
      cycle.length - 1,
      Math.round(ramp(BUBBLE_CANCELS_AT_MIN_TIER, BUBBLE_CANCELS_AT_MAX_TIER)),
    )),
    aoeDamage: Math.round(ramp(BUBBLE_AOE_DAMAGE_AT_MIN_TIER, BUBBLE_AOE_DAMAGE_AT_MAX_TIER)),
    stunMs: BUBBLE_STUN_MS,
    swapMult: ramp(BUBBLE_SWAP_MULT_AT_MIN_TIER, BUBBLE_SWAP_MULT_AT_MAX_TIER),
  };
}

// ---------------------------------------------------------------------------
// RAID 15 — THE ROBOT ESCORT, AND WHY THE ALIEN WAVE WAS RE-COMPOSED
// ---------------------------------------------------------------------------
// The first cut of this invasion cloned the alien stage's weighted table wholesale, which
// put the ROBOTS in it as ordinary minions. They are not ordinary minions: a BroBot is
// con 350 and a JunkBot con 310, against an alien minion's 60. Five of them in a
// twenty-strong wave made a 409,000-point fight — nearly four times the entire settle
// budget before any rung applied — and the tier ladder had to divide by SIX to keep it
// finishable, which made the rung meaningless (see DUAL_BASE_HP).
//
// So the robots do here what the farm boss does in raid 12 and the pirate captain in 13:
// the guest faction arrives as ONE powerful minion on its own clock, and the wave is the
// host faction's. The JunkBot specifically, because it is the wall-builder, and this is
// the fight whose signature play is being walled into your own half.

/** The guest heavy, and when it walks on. */
export const ROBOT_ESCORT_KEY = "RobotStageActorJunkBot";
export const ROBOT_ESCORT_AT_MS = 20_000;

/** Where an abducted human is put down on this raid: immediately enemy-side of where the
 *  wall materialises, rather than at the authored mid-lane spawn. Wall plus abductee is
 *  then a double-thick roadblock across the player's own lane instead of two separate
 *  nuisances — which is the whole reason the abduction stays in a fight that already has
 *  five other things going on. */
export const ABDUCTEE_WALL_GAP = 70;

// (The sim keys the re-homing on THIS FIGHT HAVING a bubble wall rather than on a raid id —
// the repositioning exists because of that wall, and a fight without one has nothing to
// stand an abductee beside. See BattleSim's summonBoss case.)
