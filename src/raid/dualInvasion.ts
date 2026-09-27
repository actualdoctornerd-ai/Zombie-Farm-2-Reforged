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
import type { CombatUnit, WaveCadence } from "./types";

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
/** ONE CHANGE PER TIER (owner, 2026-09-26; docs/POST_45_PROGRESSION.md Part 2B).
 *
 *  The ladder used to be a straight-line ramp on every stat at once, so every rung was a
 *  little of everything and none of them meant anything in particular. Now the rungs take
 *  turns: the odd ones add or sharpen a MECHANIC (see each raid's section below) and the
 *  even ones below t10 are STAT steps, which are all this table does. Between two stat
 *  steps the profile does not move at all.
 *
 *  The stat steps alternate: t2 and t6 raise enemy DAMAGE, t4 and t8 raise enemy ATTACK
 *  SPEED. Never hit points — the four-minute clock owns bulk (see DUAL_SETTLE_REFERENCE_DPS),
 *  so `con` is solved from one flat hit-point target at every rung.
 *
 *  The step sizes and the flat target are placeholders until the tuning pass. */
export const STAT_TIERS: Readonly<Record<number, "damage" | "speed">> = {
  2: "damage", 4: "speed", 6: "damage", 8: "speed",
};
/** What one damage step multiplies enemy damage by (str, throws and specials together). */
export const DUAL_DAMAGE_STEP = 1.25;
/** What one speed step multiplies enemy attack speed by (dex and throw rate together). */
export const DUAL_SPEED_STEP = 1.12;

/** How many damage and speed steps are in force at this rung. */
export function statSteps(tier: number): { damage: number; speed: number } {
  const rung = clampTier(tier);
  let damage = 0;
  let speed = 0;
  for (const [at, kind] of Object.entries(STAT_TIERS)) {
    if (rung < Number(at)) continue;
    if (kind === "damage") damage++; else speed++;
  }
  return { damage, speed };
}

/** See `DUAL_LETHALITY` further down for the per-raid base. */
export function tierProfile(raidId: number, tier: number): EliteProfile {
  const steps = statSteps(tier);
  const damage = (DUAL_LETHALITY[raidId] ?? 1) * DUAL_DAMAGE_STEP ** steps.damage;
  const speed = DUAL_SPEED_STEP ** steps.speed;
  // BULK cannot be one multiplier across four waves this different — see DUAL_BASE_HP —
  // so `con` is solved backwards from the flat hit-point target.
  const base = DUAL_BASE_HP[raidId] ?? DUAL_BASE_HP[SIGN_RAID_ID];
  return {
    str: 1.8 * damage,
    con: DUAL_WAVE_HP / base.wave,
    bossCon: DUAL_BOSS_HP / base.boss,
    dex: 1 * speed,
    throwDamage: 1.6 * damage,
    throwRate: 1.15 * speed,
    wallHp: 1.2,
    specialDamage: 1.8 * damage,
  };
}

/** THE HIT POINTS EVERY RUNG FIELDS, which is what `con` above is solved for. Flat across
 *  the ladder (the rungs climb in mechanics and in damage/speed, not in bulk) and shared by
 *  all four invasions so a rung means one thing. The tuning pass sets the real value; the
 *  ceiling on it is the settle budget below. */
export const DUAL_WAVE_HP = 70_000;
export const DUAL_BOSS_HP = 12_000;

/** WHAT EACH INVASION'S OWN WAVE WEIGHS at 1.0x, wave and boss separately.
 *
 *  These four fights borrow four different stages, and the stages are nowhere near each
 *  other in bulk — the Circus boss is 1,500 hit points and the Ninja boss is 25,000; the
 *  City wave is 21,400 and the cloned Alien wave is 409,000. ONE multiplier across all four
 *  is therefore meaningless, and trying it is how this was first written: a ramp fitted on
 *  raid 12 put raid 13's tier 10 at 408,000 points, three times what any roster can clear
 *  inside the cap.
 *
 *  So the ladder names a TARGET and divides. The numbers here are the wave's OWN bodies as
 *  the builders produce them — not the units a mechanic brings on (the farmer mob, the
 *  captain, the towers, anything summoned), which ride on top of the target — and
 *  `tierLadder.test.ts` re-derives them from the catalog and fails if a wave is ever
 *  re-composed underneath them.
 *
 *  A number here far above the 70,000 the bottom rung wants is a WAVE THAT NEEDS
 *  RE-COMPOSING, not a datum to live with: the ladder then spends itself shrinking the
 *  fight instead of building it, and the rung stops meaning anything. Raid 15 was exactly
 *  that at 409,000 until Stage 4 fixed the composition rather than the multiplier. */
const DUAL_BASE_HP: Readonly<Record<number, { wave: number; boss: number }>> = {
  12: { wave: 18_500, boss: 4_500 },   // the City wave
  13: { wave: 46_500, boss: 25_000 },  // the Ninja wave
  // The Circus wave. The Ringmaster himself is tiny, which is why his multiplier is the
  // largest in the table.
  14: { wave: 77_200, boss: 1_500 },
  // The alien wave (10 minions) alone. This used to be 409,000 — the alien stage's twenty
  // minions cloned wholesale WITH the robots in the weighted table, four times the whole
  // settle budget. The robots now arrive only when the saucer summons one (capped at one
  // standing), so they are outside this figure, like the abductees.
  15: { wave: 60_000, boss: 25_000 },
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
// RAID 12 — RULINGS (Lawyers & Farmers)
// ---------------------------------------------------------------------------
// Every SIGN_DWELL_MS the Lawyer boss offers two RULINGS in thought bubbles and the player
// taps the one they will live with for the next dwell. Each ruling hurts a different KIND
// of army — slower attacks, less damage, an ability disabled, a class benched, enemies
// hitting harder, enemies that cannot be stunned, no healing — so the right pick depends
// on what the player brought, and the wrong one for their army is what costs them.
//
// THE LADDER (docs/POST_45_PROGRESSION.md Part 2B, "Rulings"):
//
//   t1  rulings: one per bubble, from the pool below; ignoring the offer lets a coin decide
//   t3  the angry farmer mob walks on at the midpoint of the fight
//   t5  each bubble holds TWO rulings
//   t7  contempt: ignoring the offer applies BOTH bubbles
//   t9  the rulings are more severe
//   t10 precedent: each ruling lasts two slots, so two are always in force
//   (t2/t4/t6/t8 are stat steps — see tierProfile)
//
// THE PAIRING IS THE DESIGN. The two bubbles offered never punish the same build (see
// RULING_TAG), and a class is never offered in two consecutive slots — under precedent that
// would bench it for two dwells running. A ruling that is in force twice (precedent, or
// contempt handing over both bubbles) REFRESHES rather than stacking.
//
// TIMING. One dwell is one SLOT. During slot s the two bubbles for offer s are up and the
// rulings actually in force are the pick(s) that resolved at the end of slot s-1 (and s-2
// under precedent). So slot 0 is a free opening window with the first offer already on
// screen, and from then on the player is always choosing one ruling ahead while living
// with the last one. See BattleSim.activeRulings / pickSign.
//
// THE OFFERS ARE PRE-DRAWN from the session seed, like the auto-picks: a pick is player
// input and is TRANSCRIBED (`signPick`), and everything else about the table is pinned into
// the config at /raid/start, so both sides replay the same fight whether the player tapped
// or not. The rulings only run while the Lawyer is on his perch — he is always the boss that
// descends, and the pressure lifts when he does.

/** Lawyers & Farmers — the invasion the rulings belong to. */
export const SIGN_RAID_ID = 12;

/** The six zombie classes a Barred ruling can name. */
export const SIGN_GROUPS = ["Headless", "Garden", "Small", "Large", "Regular", "Female"] as const;

/** The activated moves an Overruled ruling can disable, by the button family each names. */
export const OVERRULED_ABILITIES: Readonly<Record<string, readonly string[]>> = {
  bash: ["bash", "bashV2"],
  explode: ["explode", "explodeV2"],
  attachMini: ["attachMini"],
};

/** What a ruling can be. Every one reads as a single icon (see RaidScene's sign panel). */
export type RulingKind =
  | "slowed"       // ally attack speed down
  | "weakened"     // ally damage down
  | "overruled"    // one activated ability disabled (`ability`)
  | "barred"       // one class benched — it walks off the line (`group`)
  | "emboldened"   // enemies deal more damage
  | "immunity"     // enemies cannot be stunned
  | "orderInCourt"; // no healing

export interface Ruling {
  kind: RulingKind;
  /** The class a Barred ruling benches. */
  group?: string;
  /** The OVERRULED_ABILITIES family an Overruled ruling disables. */
  ability?: string;
}

/** The whole pool. Deliberately small: a player has eight seconds to read two bubbles. */
export const RULING_POOL: readonly Ruling[] = [
  { kind: "slowed" },
  { kind: "weakened" },
  ...Object.keys(OVERRULED_ABILITIES).map((ability): Ruling => ({ kind: "overruled", ability })),
  ...SIGN_GROUPS.map((group): Ruling => ({ kind: "barred", group })),
  { kind: "emboldened" },
  { kind: "immunity" },
  { kind: "orderInCourt" },
];

/** Which kind of army a ruling hurts. Two rulings with the same tag are never on opposite
 *  sides of one offer, or inside one bubble: slower attacks and less damage both land on the
 *  army that wins by hitting, so offering them as a choice is not a choice. */
export function rulingTag(r: Ruling): string {
  switch (r.kind) {
    case "slowed":
    case "weakened": return "offense";
    case "overruled": return `taps:${r.ability}`;
    case "barred": return `class:${r.group}`;
    default: return r.kind;
  }
}

/** A stable name for a ruling — for equality, dedupe and the icon cache. */
export function rulingKey(r: Ruling): string {
  return r.kind === "barred" ? `barred:${r.group}` : r.kind === "overruled" ? `overruled:${r.ability}` : r.kind;
}

/** How long one offer stays up, and so how long the ruling it resolves into is in force.
 *  Eight seconds (owner, 2026-09-19): long enough to read two bubbles and think about them. */
export const SIGN_DWELL_MS = 8_000;

/** The rungs at which the fight changes — see the ladder above. */
export const FARMER_MOB_TIER = 3;
export const PAIRED_SIGN_TIER = 5;
export const CONTEMPT_TIER = 7;
export const SEVERE_TIER = 9;
export const PRECEDENT_TIER = 10;

/** What the scalar rulings do, ordinary and severe (t9+). Placeholders until tuning. */
export const RULING_SLOW = { normal: 1.35, severe: 1.6 };      // ally attack interval x
export const RULING_WEAKEN = { normal: 0.75, severe: 0.6 };    // ally damage x
export const RULING_EMBOLDEN = { normal: 1.3, severe: 1.5 };   // enemy damage x

/** What one bubble contains: the ruling(s) that come into force if the player picks it. */
export type SignOption = readonly Ruling[];
/** One offer — the two bubbles a player chooses between. Always exactly two: the mechanic is
 *  a dilemma, and a third bubble makes it a menu. */
export type SignOffer = readonly [SignOption, SignOption];

/** How many slots of offers and auto-picks to pre-draw. A fight is capped at four minutes
 *  (replay.RAID_MAX_TICKS) which is 30 dwells; sized with headroom, and the sim wraps the
 *  index anyway, so a shorter dwell can never run the table dry. */
export const SIGN_MAX_SLOTS = 40;

/** The value a resolved slot holds when contempt applied BOTH bubbles. */
export const SIGN_BOTH = 2;

export interface SignConfig {
  /** One offer PER SLOT, pre-drawn. The fight reads slot s's offer at index s. */
  offers: readonly SignOffer[];
  /** How long each offer stays up before it resolves. */
  dwellMs: number;
  /** Which bubble is taken when the player does not choose, one per slot, PRE-DRAWN from
   *  the session seed. Unused from CONTEMPT_TIER, where ignoring the offer takes both. */
  autoPicks: readonly number[];
  /** Ignoring the offer applies both bubbles (t7+). */
  contempt: boolean;
  /** The scalar rulings bite harder (t9+). */
  severe: boolean;
  /** How many resolved slots are in force at once: 1, or 2 under precedent (t10). */
  inForce: number;
}

/** Draw one bubble's worth of rulings that shares no tag with `avoid`. */
function drawOption(
  rand: () => number, size: number, avoid: Set<string>, barredLast: Set<string>
): Ruling[] {
  const out: Ruling[] = [];
  for (let n = 0; n < size; n++) {
    const pool = RULING_POOL.filter((r) =>
      !avoid.has(rulingTag(r)) &&
      !(r.kind === "barred" && barredLast.has(r.group!)));
    const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    out.push(pick);
    avoid.add(rulingTag(pick));
  }
  return out;
}

/** The ruling table for a fight, or null for an invasion that has none.
 *
 *  `seed` MUST be the raid session id online — the verifier pins the config it builds from
 *  the same seed at /raid/start, and the client redraws from it, exactly as the Robots'
 *  wave does (see RaidCatalog.resolveStageWave). Offline any value works. */
export function signFor(raidId: number, tier: number, seed: string): SignConfig | null {
  if (raidId !== SIGN_RAID_ID) return null;
  const rung = clampTier(tier);
  const rand = seededRandom(`sign:${seed}:${raidId}:${rung}`);
  const size = rung >= PAIRED_SIGN_TIER ? 2 : 1;
  const offers: SignOffer[] = [];
  let barredLast = new Set<string>();
  for (let slot = 0; slot < SIGN_MAX_SLOTS; slot++) {
    const avoid = new Set<string>();
    const a = drawOption(rand, size, avoid, barredLast);
    const b = drawOption(rand, size, avoid, barredLast);
    offers.push([a, b]);
    barredLast = new Set([...a, ...b].filter((r) => r.kind === "barred").map((r) => r.group!));
  }
  return {
    offers,
    dwellMs: SIGN_DWELL_MS,
    autoPicks: Array.from({ length: SIGN_MAX_SLOTS }, () => (rand() < 0.5 ? 0 : 1)),
    contempt: rung >= CONTEMPT_TIER,
    severe: rung >= SEVERE_TIER,
    inForce: rung >= PRECEDENT_TIER ? 2 : 1,
  };
}

/** Which bubble an unattended slot takes: the pinned coin, or both under contempt. Wraps,
 *  so a slot beyond the pre-drawn table still answers. */
export function autoPickFor(sign: SignConfig, slot: number): number {
  if (sign.contempt) return SIGN_BOTH;
  if (!sign.autoPicks.length) return 0;
  const pick = sign.autoPicks[Math.max(0, slot) % sign.autoPicks.length];
  return pick === 1 ? 1 : 0;
}

/** The offer for a slot, wrapping past the pre-drawn table. */
export function signOfferAt(sign: SignConfig, slot: number): SignOffer {
  return sign.offers[Math.max(0, slot) % sign.offers.length];
}

/** The rulings a resolved slot put in force: one bubble, or both. */
export function rulingsFor(offer: SignOffer, pick: number): Ruling[] {
  return pick === SIGN_BOTH ? [...offer[0], ...offer[1]] : [...offer[pick === 1 ? 1 : 0]];
}

// ---------------------------------------------------------------------------
// RAID 12 — THE ANGRY FARMER MOB (t3+)
// ---------------------------------------------------------------------------
// Old McDonnell and his farmhands walk on together, off the wave budget, once HALF of the
// wave is down — the midpoint of the fight, measured in the fight rather than on a clock,
// so a fast army meets them early and a slow one late. They hold the Lawyer on his perch
// until they are dealt with, so the rulings keep coming while they are on the field.
/** Who walks on together: the farm boss leading three farmhands. */
export const FARMER_SQUAD_LEADER = "FarmStageActorBoss";
export const FARMER_SQUAD_MINION = "FarmStageActorFarmhand";
export const FARMER_SQUAD_MINIONS = 3;
/** Fraction of the wave that must be down before the mob walks on. */
export const MIDPOINT_WAVE_FRAC = 0.5;

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
// A thought bubble appears over the saucer with a charging bar and an icon naming what is
// coming. The player holds a handful of cancels for the whole fight and must choose which
// casts to stop and which to eat.
//
// THE ORDER IS FIXED AND IDENTICAL EVERY FIGHT: a planning puzzle rather than a slot
// machine, and it costs the replay no randomness at all. What keeps the decision live is
// SCARCITY — far fewer cancels than casts, so a fixed order produces a menu, and which
// items you can afford depends on your own army and on how the fight has gone.
//
//   wall     a blocker inside the player's own half — punishes low burst
//   portal   half the deployed line back to the staging slot, behind the wall
//   robot    the saucer beams down a JunkBot — punishes low damage
//   aoe      (t5+, the giant bot) chunks the whole deployed army — punishes low HP
//   stunAll  (t5+, the giant bot) holds the whole army — worst when a wall is up
//
// THE WALL SITS INSIDE THE PLAYER'S OWN HALF (`supportX`, halfway between the staging slot
// and the front line): it does not bar the front line, which has already walked past it.
// It cuts REINFORCEMENTS off. Wall + portal is the fight's signature play — half the army
// thrown to the back and walled in while the other half fights alone.

/** Aliens & Robots — the invasion the bubble belongs to. */
export const BUBBLE_RAID_ID = 15;

/** PER-RAID BASE LETHALITY: one flat damage multiplier per invasion, under the shared stat
 *  steps (see tierProfile).
 *
 *  The four fights are nowhere near each other in how much of their danger lives in the
 *  enemies' own swings, so one damage number cannot place all four. This used to be a
 *  [t1, t10] PAIR tapering across a straight-line ramp; the ramp is gone (rungs now take
 *  turns, see STAT_TIERS), so what is left is the bottom of each pair — the lift the t1
 *  fight needed. Placeholders until the tuning pass.
 *
 *  Damage only — `str`, `throwDamage`, `specialDamage`. Not `con` (the flat hit-point target
 *  owns bulk) and not `dex` (it compounds with `str`). Raids 13 and 14 default to 1.0. */
export const DUAL_LETHALITY: Readonly<Record<number, number>> = {
  [SIGN_RAID_ID]: 1.8,
  [BUBBLE_RAID_ID]: 1.5,
};

// THE LADDER (docs/POST_45_PROGRESSION.md Part 2B, "Interference"):
//
//   t1  the saucer casts every 10 s: walls, zombies portalled to the back, a summoned
//       robot. 5 cancels for the whole fight.
//   t3  abductees start appearing in the middle, as in the ordinary Alien fight
//   t5  the giant McDonnell bot appears at the back — a SIGNAL, drawn by the scene: from
//       here the massive area hit and the full-army stun are in the cycle
//   t7  a cast every 7 s
//   t9  lockout: a cancel cannot be used on two activations in a row
//   t10 dual cast: casts come in pairs, and one cancel stops one of the pair
//   (t2/t4/t6/t8 are stat steps — see tierProfile)
//
// This fight punishes no one build. It is about the interrupt: which casts you stop is
// decided by your own army's weak points, and it favours damage, because enemies that live
// longer cast more. Five cancels against a cast every ten seconds is the design — pressing
// every time runs you dry by the second minute.

/** What the saucer can be thinking about. */
export type BubbleAction = "wall" | "portal" | "robot" | "aoe" | "stunAll";

/** The cycle below the giant bot, in order. */
export const BUBBLE_CYCLE_BASE: readonly BubbleAction[] = ["wall", "portal", "robot"];
/** The cycle once the giant bot is up. The two big ones are spaced apart so they never land
 *  back to back, and the portal sits after the wall so the wall it throws people behind is
 *  already standing. */
export const BUBBLE_CYCLE: readonly BubbleAction[] = ["wall", "aoe", "portal", "stunAll", "robot"];

/** The rungs at which the fight changes — see the ladder above. */
export const ABDUCTEE_TIER = 3;
export const GIANT_BOT_TIER = 5;
export const FAST_CAST_TIER = 7;
export const LOCKOUT_TIER = 9;
export const DUAL_CAST_TIER = 10;

/** Cancels for the whole fight, at every rung. */
export const BUBBLE_CANCELS = 5;

/** One activation every this many ms: the cast window plus the quiet before it. */
export const BUBBLE_INTERVAL_MS = 10_000;
export const BUBBLE_INTERVAL_MS_FAST = 7_000;
/** The reaction window inside that interval: long enough to read the icon and decide. */
export const BUBBLE_CAST_MS = 4_000;
export const BUBBLE_CAST_MS_FAST = 3_000;

/** How much of the deployed army the portal throws back to the staging slot. */
export const PORTAL_FRACTION = 0.5;

/** What the giant bot's area hit takes off every deployed zombie, and how long its stun-all
 *  holds them. Placeholders until the tuning pass. */
export const BUBBLE_AOE_DAMAGE = 450;
export const BUBBLE_STUN_MS = 3_000;

/** The robot the saucer beams down, and how many of them may stand at once. A summoned
 *  robot is hit points outside the settle budget, so the cap is not optional. */
export const BUBBLE_ROBOT_KEY = "RobotStageActorJunkBot";
export const BUBBLE_ROBOT_MAX_ALIVE = 1;

export interface BubbleConfig {
  /** The actions, in the order they are cast. */
  cycle: readonly BubbleAction[];
  /** The reaction window on each cast. */
  castMs: number;
  /** Quiet between one activation resolving and the next beginning (interval - castMs).
   *  A cancelled activation waits the same gap: a cancel stops the action, it does not
   *  buy extra time. */
  gapMs: number;
  /** Cancels the player starts the fight holding. */
  cancels: number;
  /** Damage the area hit lands on every deployed zombie. */
  aoeDamage: number;
  /** How long stun-all holds the army. */
  stunMs: number;
  /** A cancel cannot be spent on the activation straight after a cancelled one (t9+). */
  lockout: boolean;
  /** Each activation casts TWO actions at once, and one cancel stops one of them (t10). */
  dualCast: boolean;
  /** Presentation: the giant McDonnell bot stands at the back (t5+). The sim never reads
   *  it — the area hit and the stun are in the cycle or they are not. */
  giantBot: boolean;
  /** How many summoned robots may stand at once. */
  robotMaxAlive: number;
  /** The robot the `robot` action beams down, attached by composeFight from the catalog
   *  (this module has no asset access). Null means the action does nothing. */
  robot: CombatUnit | null;
}

/** The bubble at this rung, or null for an invasion without one. `robot` comes back null;
 *  composeFight fills it in. */
export function bubbleFor(raidId: number, tier: number): BubbleConfig | null {
  if (raidId !== BUBBLE_RAID_ID) return null;
  const rung = clampTier(tier);
  const fast = rung >= FAST_CAST_TIER;
  const castMs = fast ? BUBBLE_CAST_MS_FAST : BUBBLE_CAST_MS;
  const intervalMs = fast ? BUBBLE_INTERVAL_MS_FAST : BUBBLE_INTERVAL_MS;
  return {
    cycle: rung >= GIANT_BOT_TIER ? BUBBLE_CYCLE : BUBBLE_CYCLE_BASE,
    castMs,
    gapMs: intervalMs - castMs,
    cancels: BUBBLE_CANCELS,
    aoeDamage: BUBBLE_AOE_DAMAGE,
    stunMs: BUBBLE_STUN_MS,
    lockout: rung >= LOCKOUT_TIER,
    dualCast: rung >= DUAL_CAST_TIER,
    giantBot: rung >= GIANT_BOT_TIER,
    robotMaxAlive: BUBBLE_ROBOT_MAX_ALIVE,
    robot: null,
  };
}

/** Whether the saucer abducts humans at this rung (t3+). Below it the summon is off, so the
 *  fight's roadblocks are the wall alone. */
export function abducteesAt(raidId: number, tier: number): boolean {
  return raidId !== BUBBLE_RAID_ID || clampTier(tier) >= ABDUCTEE_TIER;
}

// ---------------------------------------------------------------------------
// RAID 15 — WHY THE ALIEN WAVE WAS RE-COMPOSED
// ---------------------------------------------------------------------------
// The first cut of this invasion cloned the alien stage's weighted table wholesale, which
// put the ROBOTS in it as ordinary minions. They are not ordinary minions: a BroBot is
// con 350 and a JunkBot con 310, against an alien minion's 60. Five of them in a
// twenty-strong wave made a 409,000-point fight — nearly four times the entire settle
// budget before any rung applied. So the wave is the aliens alone, and the robots arrive
// one at a time when the saucer summons them (BUBBLE_ROBOT_KEY), capped. The JunkBot,
// because the bubble's wall is borrowed from its own `wall` action.

/** Where an abducted human is put down on this raid: immediately enemy-side of where the
 *  wall materialises, rather than at the authored mid-lane spawn. Wall plus abductee is
 *  then a double-thick roadblock across the player's own lane instead of two separate
 *  nuisances. */
export const ABDUCTEE_WALL_GAP = 70;

// (The sim keys the re-homing on THIS FIGHT HAVING a bubble wall rather than on a raid id —
// the repositioning exists because of that wall, and a fight without one has nothing to
// stand an abductee beside. See BattleSim's summonBoss case.)
