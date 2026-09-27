// The ENEMY SIDE of a fight, composed once.
//
// `buildFight` fixed the argument list; this fixes what goes into it. Assembling the
// opposition was written out three times — RaidManager (the live launch), raidVerifier
// (`buildPinnedRaid` and `buildPinnedV3Raid`, with its own private copies of the throw,
// special and template builders) and the Raid Lab — and the server's copies carried
// comments admitting the hazard outright: "mirrors RaidManager.bossSpecialsOf, and must
// stay in step with it or the pinned config and the client's fight disagree."
//
// Fifteen lines of the same sequence, in three places, where a disagreement between any
// two of them is a desync between the fight on the player's screen and the fight the
// server settles. fightConfig.ts's own header already states the rule this file is
// applying — "a second copy of a rule is a rule that can quietly disagree with itself" —
// one level up from where it stated it.
//
// PURE. Everything here is a function of authored data plus the six things the caller
// knows: which raid, which stage, what level, which rung, whether a Brain Ticket was
// spent, and the wave seed. Nothing reads a save, a database or a device — which is what
// lets the client, the Worker and the difficulty harness all call it.
import { buildEnemyUnits } from "./CombatEngine";
import {
  abducteesAt, bubbleFor, copiesFor, duelFor, ringmasterDropMs, RINGMASTER_STATION_X, signFor,
  type BubbleConfig, type CopyConfig, type DuelConfig, type SignConfig,
} from "./dualInvasion";
import { eliteBossSpecials, eliteBossThrow, type EliteProfile } from "./eliteInvasion";
import {
  bossSpecialsFor, bossThrowFor, bubbleWallFor, circusStacksFor, crabFor, farmerSquadFor,
  bubbleRobotFor, grabberFor, megaBotFor, pirateCaptainFor, summonFor, turnedTemplateFor,
  wallTemplateFor, type FightAssets,
} from "./fightConfig";
import { waveCadenceFor } from "./alienStage";
import type {
  BossSpecial, BossThrowConfig, CombatUnit, CrabConfig, GrabberConfig, MegaBotConfig, RaidDef,
  RaidStage, SummonConfig, WaveCadence,
} from "./types";

/** What the caller knows that the authored data does not. */
export interface FightContext {
  /** Drives the level stat ramp AND the farm raid's enemy speed-up. The client and the
   *  verifier must pass the same value or the replay diverges on the first tick. */
  playerLevel: number;
  /** The dual-invasion rung (0 for every raid without a ladder). */
  tier: number;
  /** The elite profile in force: a Brain Ticket's, a rung's, or null. Already resolved
   *  by the caller, because the two come from different places (eliteProfile /
   *  tierProfile) and only the caller knows which applies. */
  elite: EliteProfile | null;
  /** Prior wins on this raid — the boss's throw interval tightens with them. */
  priorWins: number;
  /** Seed for everything the fight draws rather than authors: the placard's auto-picks.
   *  ONLINE this MUST be the raid session id, because the client redraws from it and the
   *  pinned config is what the replay is checked against. */
  waveSeed: string;
  /** Include the CLIENT-ONLY hazards (trapeze, crab, Mega-Robot). False on the server, which deliberately
   *  simulates the un-harassed fight so its replay is a ceiling the live game can only
   *  fall short of. See raidVerifier and pilot.ts. */
  hazards: boolean;
}

/** Everything about the opposition, in the shape `FightSpec` wants it. */
export interface ComposedFight {
  enemyUnits: CombatUnit[];
  bossThrow: BossThrowConfig | null;
  bossSpecials: BossSpecial[];
  summon: SummonConfig | null;
  wallTemplate: CombatUnit | null;
  turnedTemplate: CombatUnit | null;
  waveCadence: WaveCadence;
  grabber: GrabberConfig | null;
  crab: CrabConfig | null;
  megaBot: MegaBotConfig | null;
  sign: SignConfig | null;
  duel: DuelConfig | null;
  copies: CopyConfig | null;
  bubble: BubbleConfig | null;
  bubbleWall: CombatUnit | null;
  bossDropAtMs: number | null;
  bossGroundStationX: number | null;
}

export function composeFight(
  assets: FightAssets,
  raid: RaidDef,
  stage: RaidStage,
  ctx: FightContext
): ComposedFight {
  const { playerLevel, tier, elite, priorWins, waveSeed } = ctx;
  const sign = signFor(raid.id, tier, waveSeed);

  const enemyUnits = buildEnemyUnits(stage, assets.enemyStats, assets.raidAttacks, {
    raidId: raid.id, playerLevel, elite,
  });
  // The four dual invasions' guest units are APPENDED rather than mixed into the wave,
  // because they are authored rather than drawn: the same units at the same moment every
  // fight, each on its own clock. Order matters only in that it is the same everywhere,
  // which is the entire reason this sequence now lives in one place.
  enemyUnits.push(...farmerSquadFor(assets, raid, tier, elite, playerLevel));
  enemyUnits.push(...pirateCaptainFor(assets, raid, tier, elite, playerLevel));
  enemyUnits.push(...circusStacksFor(assets, raid, tier, elite, playerLevel));

  const dropAtMs = ringmasterDropMs(raid.id, tier);
  return {
    enemyUnits,
    // Elite scales the boss's whole repertoire, not just its body. The ORDER of the two
    // wrappers is load-bearing on the throw — rebalance onto the raid's rung and the
    // boss's own pace first, elite last (see brobot-throw-pace).
    bossThrow: eliteBossThrow(bossThrowFor(assets, raid, stage, priorWins), elite),
    bossSpecials: eliteBossSpecials(bossSpecialsFor(assets, stage), elite),
    summon: abducteesAt(raid.id, tier) ? summonFor(assets, raid, stage, playerLevel, elite) : null,
    wallTemplate: wallTemplateFor(assets, stage, elite),
    turnedTemplate: turnedTemplateFor(assets, raid, stage, playerLevel, elite),
    waveCadence: waveCadenceFor(raid.id),
    grabber: ctx.hazards ? grabberFor(raid) : null,
    crab: ctx.hazards ? crabFor(raid) : null,
    megaBot: ctx.hazards ? megaBotFor(raid) : null,
    sign,
    duel: duelFor(raid.id, tier),
    copies: copiesFor(raid.id, tier),
    bubble: withRobot(bubbleFor(raid.id, tier), bubbleRobotFor(assets, raid, elite, playerLevel)),
    bubbleWall: bubbleWallFor(assets, raid, elite),
    bossDropAtMs: dropAtMs,
    bossGroundStationX: dropAtMs === null ? null : RINGMASTER_STATION_X,
  };
}

/** The rung's bubble with the robot its `robot` action beams down attached. `bubbleFor`
 *  cannot build that unit itself (dualInvasion has no asset access), so it is joined here,
 *  where both halves are in hand. */
function withRobot(bubble: BubbleConfig | null, robot: CombatUnit | null): BubbleConfig | null {
  return bubble ? { ...bubble, robot } : null;
}
