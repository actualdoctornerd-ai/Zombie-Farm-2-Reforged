// One raid, ready to fly — the harness's entry point into a real fight.
//
// Everything here goes through the shared composer (raid/composeFight.ts) and the shared
// builder (raid/buildFight.ts), so a fight the harness measures is assembled by the same
// code that assembles the fight the player plays and the fight the Worker settles. That
// is the whole point of Layer 0: the previous harness hand-wrote a 16-argument subset of
// a 23-argument constructor and therefore measured the four post-45 dual invasions with
// their signature mechanics switched off.
//
// The one axis the harness gets that the game does not is `hazards`. The trapeze and the
// crab are client-only, so the CLIENT's fight and the VERIFIER's fight genuinely differ
// in length on raids 8 and 10 — and conflating the two is what voided ~6% of Circus and
// Beach victories. Difficulty is a question about the fight the player has, so the
// harness defaults to hazards ON; a flight whose transcript is meant to be replayed
// against the server's rules turns them off. Both are available because both are real.
import raidsJson from "../../../public/assets/raids/raids.json";
import enemyStatsJson from "../../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../../public/assets/raids/attacks.json";
import { composeFight } from "../composeFight";
import { raidProfile } from "../dualInvasion";
import { fightStage, resolveStageWave, seededRandom } from "../RaidCatalog";
import type { FightSpec } from "../buildFight";
import type { EliteProfile } from "../eliteInvasion";
import type { AttackDef, CombatUnit, EnemyStat, RaidDef, RaidStage } from "../types";

const raids = raidsJson as RaidDef[];
const enemyStats = enemyStatsJson as Record<string, EnemyStat>;
const attacks = attacksJson as Record<string, AttackDef>;

/** The two catalogs a fight config is built from. Exported so a caller assembling its
 *  own player units (which need the zombie catalog, not these) can reuse them. */
export const HARNESS_ASSETS = { enemyStats, raidAttacks: attacks };

export interface HarnessFightOptions {
  raidId: number;
  /** The army, IN FORMATION ORDER. Build it with `buildPlayerUnits`. */
  playerUnits: CombatUnit[];
  /** Dual-invasion rung. 0 (the default) for every raid without a ladder. */
  tier?: number;
  /** A Brain Ticket was spent. Ignored on a dual invasion, which is scaled by its rung. */
  elite?: boolean;
  /** Drives the enemy level ramp and the farm raid's speed-up. Must match the level the
   *  player units were built at, or the two halves of the fight disagree. */
  playerLevel?: number;
  /** Prior wins on this raid — the boss's throw interval tightens with them. Defaults to
   *  the practised case, because a difficulty number about a raid nobody has beaten yet
   *  is a number about one specific evening. */
  priorWins?: number;
  /** Everything the fight draws rather than authors. Vary it across a measurement: the
   *  Robots' boss is drawn from here, and one seed is one evening. */
  waveSeed?: string;
  /** The Concentration boost: no focus-bubble minigame. Off by default — the minigame is
   *  one of the things the pilot ladder is measuring. */
  concentration?: boolean;
  /** Client-only hazards (trapeze, crab, Mega-Robot). See the header. */
  hazards?: boolean;
  /** MULTIPLY THE FIGHT'S LETHALITY — and only its lethality.
   *
   *  Scales enemy per-hit damage, boss throw damage and boss special damage. Deliberately
   *  NOT `con`, `bossCon` or `wallHp`: hit points are what make a fight LONG, and with the
   *  four-minute clock already slack (the best builds finish in 40-85 s) more bulk buys
   *  duration rather than casualties, while pushing toward the settle budget where a player
   *  who is winning the whole way still loses on the clock. Also not `dex` or `throwRate`,
   *  which are cadence: dex is a straight DPS multiplier that COMPOUNDS with str, so moving
   *  both applies a change twice.
   *
   *  A harness knob for CALIBRATION, not a game rule. It exists so "what would this fight
   *  cost at 1.5x damage" can be measured before anyone edits a profile — and a raid with
   *  no profile at all (every non-elite story raid) gets a synthetic one, which is how a
   *  story raid's lethality can be costed without first inventing a mechanism for it. */
  lethality?: number;
  /** Multiply the fight's BULK — enemy and boss hit points.
   *
   *  The counterpart to `lethality`, and present for one reason: the lethality sweep found
   *  four story raids where TRIPLING damage moved casualties from 0.1 to 0.7. An enemy that
   *  dies before it swings cannot be made dangerous by hitting harder. Bulk is what buys it
   *  the time to act — so the pair has to be measurable together, even though bulk alone is
   *  the axis that runs into the fight clock. */
  bulk?: number;
}

export interface HarnessFight {
  raid: RaidDef;
  stage: RaidStage;
  spec: FightSpec;
}

/** Apply `HarnessFightOptions.lethality` to a profile, inventing one where the fight has
 *  none. `eliteProfile` returns null for every non-elite raid, so a story raid's damage is
 *  purely its authored wave — a synthetic all-ones profile is the only way to ask what that
 *  raid would cost if it hit harder. */
function scaleLethality(
  profile: EliteProfile | null,
  lethality: number | undefined,
  bulk: number | undefined
): EliteProfile | null {
  const L = lethality ?? 1;
  const B = bulk ?? 1;
  if (L === 1 && B === 1) return profile;
  const base: EliteProfile = profile ?? {
    str: 1, con: 1, dex: 1, throwDamage: 1, throwRate: 1, wallHp: 1, specialDamage: 1,
  };
  return {
    ...base,
    str: base.str * L,
    throwDamage: base.throwDamage * L,
    specialDamage: base.specialDamage * L,
    con: base.con * B,
    bossCon: (base.bossCon ?? base.con) * B,
  };
}

export function harnessFight(opts: HarnessFightOptions): HarnessFight {
  const raid = raids.find((r) => r.id === opts.raidId);
  if (!raid) throw new Error(`no raid ${opts.raidId}`);
  const playerLevel = opts.playerLevel ?? 45;
  const tier = opts.tier ?? 0;
  const waveSeed = opts.waveSeed ?? `harness:${raid.id}:${tier}:0`;

  const authored = fightStage(raid, playerLevel);
  if (!authored) throw new Error(`raid ${raid.id} has no stage at level ${playerLevel}`);
  const stage = resolveStageWave(authored, seededRandom(waveSeed));

  // `raidProfile` is the one place that knows whether a fight is scaled by a rung or by
  // a Brain Ticket — the same call the client and the verifier make, so the harness
  // cannot pick the wrong one for the four dual invasions.
  const composed = composeFight(HARNESS_ASSETS, raid, stage, {
    playerLevel,
    tier,
    elite: scaleLethality(
      raidProfile(raid.id, { elite: !!opts.elite, tier }), opts.lethality, opts.bulk),
    priorWins: opts.priorWins ?? 5,
    waveSeed,
    hazards: opts.hazards ?? true,
  });

  return {
    raid,
    stage,
    spec: {
      playerUnits: opts.playerUnits,
      concentration: !!opts.concentration,
      ...composed,
    },
  };
}
