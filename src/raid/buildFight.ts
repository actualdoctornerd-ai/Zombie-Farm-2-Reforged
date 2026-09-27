// ONE place a fight is assembled.
//
// `BattleSim`'s constructor takes twenty-four positional arguments, and until this file
// existed three separate places wrote that call out by hand: the live scene
// (RaidScene), the server verifier (raidVerifier.createPinnedSim) and the balance
// harness (eliteInvasion.balance.test.ts). Three transcriptions of one positional
// signature is a drift machine, and it had already drifted: the harness stopped at
// argument sixteen, so `sign`, `dexTax`, `copies`, `bossDropAtMs`, `bossGroundStationX`,
// `bubble` and `bubbleWall` all silently defaulted OFF — which is to say the four
// post-45 dual invasions were being measured with their signature mechanics removed.
// The balance test's own header warned about exactly this ("which is how a measuring
// stick ends up measuring something the player never fights") and it happened anyway,
// because a comment cannot hold a positional argument list in place.
//
// So: every caller now describes the fight by NAME through `FightSpec`, and this
// function is the only code in the project that knows the order. Adding a mechanic means
// adding one field here; a caller that does not know about it keeps working, and — this
// is the point — a caller that SHOULD know about it fails to compile rather than quietly
// measuring a different fight.
//
// This file deliberately holds no policy. It does not decide whether a raid has a
// grabber, what a wall's hit points are, or which cadence a stage feeds on; those
// answers live in fightConfig.ts / alienStage.ts / dualInvasion.ts and reach here
// already resolved. It is a keyword-to-positional adapter and nothing more, which is why
// it can be trusted to sit underneath the client, the server and the harness at once.
import { BattleSim } from "./BattleSim";
import type { BubbleConfig, CopyConfig, DuelConfig, SignConfig } from "./dualInvasion";
import type {
  BossSpecial,
  BossThrowConfig,
  CombatUnit,
  CrabConfig,
  GrabberConfig,
  MegaBotConfig,
  SummonConfig,
  WaveCadence,
} from "./types";

/** Everything that decides what a fight IS, by name. Presentation (sprites, portraits,
 *  parallax layers, callbacks) is deliberately absent: two callers that agree on this
 *  object are fighting the same fight, whatever either one draws.
 *
 *  Every optional field defaults to the same value `BattleSim`'s constructor defaults it
 *  to, so omitting one is identical to passing `undefined` positionally. */
export interface FightSpec {
  /** The army, IN FORMATION ORDER — the array is the formation (see BattleSim
   *  armyOrder/assignFormation), so this is a decision and not a bag. */
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  bossThrow?: BossThrowConfig | null;
  /** Concentration boost spent: no focus-bubble minigame this fight. */
  concentration?: boolean;
  bossSpecials?: BossSpecial[];
  /** Round length before the boss enrages (ms). Omit for BattleSim's 3:00 default. */
  roundMs?: number;
  /** The alien boss's abductee queue (raid 6). */
  summon?: SummonConfig | null;
  /** Blocker the boss's `wall` action spawns. */
  wallTemplate?: CombatUnit | null;
  /** Epic Boss: no butterflies, but the full brain bubble still gates release. */
  noDistractions?: boolean;
  /** Epic Boss: reaching zero ends the attempt instead of triggering enrage. */
  escapeOnRoundEnd?: boolean;
  /** Epic Boss presentation that the SIM must also know about (it changes where the
   *  boss stands, and therefore the melee line). */
  bossFallsFromSky?: boolean;
  /** Wider melee line for a big boss. Omit for BattleSim's default. */
  engageDistance?: number;
  /** Carried-grab hazard (Circus trapeze). CLIENT-ONLY: the verifier passes null, so
   *  the authoritative replay is the un-harassed fight. See raidVerifier.grabberOf. */
  grabber?: GrabberConfig | null;
  /** Beach crab hazard. CLIENT-ONLY, same as the grabber. */
  crab?: CrabConfig | null;
  /** How the stage feeds its wave in. */
  waveCadence?: WaveCadence;
  /** The pixel zombie `turnZombie` converts a zombie into (raid 9). */
  turnedTemplate?: CombatUnit | null;
  /** The Lawyer boss's placard rotation (raid 12). */
  sign?: SignConfig | null;
  /** The duel's fight-wide rules: the smoke and stand-down around the captain, the dex
   *  tax, the counter, the stunning throws and the smoke swap (raid 13). */
  duel?: DuelConfig | null;
  /** The trapeze's copies of the player's own zombies (raid 14). */
  copies?: CopyConfig | null;
  /** The ringmaster's early drop and the station he then fights from (raid 14, rung 5+). */
  bossDropAtMs?: number | null;
  bossGroundStationX?: number | null;
  /** The saucer's five-action bubble (raid 15). */
  bubble?: BubbleConfig | null;
  /** The blocker the bubble's `wall` action drops — separate from `wallTemplate`
   *  because that one belongs to a BOSS ACTION and the saucer has no `wall` in its
   *  list (see fightConfig.bubbleWallFor). */
  bubbleWall?: CombatUnit | null;
  /** The Mega-Robot (raid 5). CLIENT-ONLY, same as the grabber and the crab. */
  megaBot?: MegaBotConfig | null;
}

/** The one call site of `new BattleSim(...)` outside tests. */
export function buildFight(spec: FightSpec): BattleSim {
  return new BattleSim(
    spec.playerUnits,
    spec.enemyUnits,
    spec.bossThrow ?? null,
    spec.concentration ?? false,
    spec.bossSpecials ?? [],
    spec.roundMs,
    spec.summon ?? null,
    spec.wallTemplate ?? null,
    spec.noDistractions ?? false,
    spec.escapeOnRoundEnd ?? false,
    spec.bossFallsFromSky ?? false,
    spec.engageDistance,
    spec.grabber ?? null,
    spec.crab ?? null,
    spec.waveCadence,
    spec.turnedTemplate ?? null,
    spec.sign ?? null,
    spec.duel ?? null,
    spec.copies ?? null,
    spec.bossDropAtMs ?? null,
    spec.bossGroundStationX ?? null,
    spec.bubble ?? null,
    spec.bubbleWall ?? null,
    spec.megaBot ?? null
  );
}
