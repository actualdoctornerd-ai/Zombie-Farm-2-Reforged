// Zombies vs Aliens (raid 6) — the stage's hard-coded divergences from the generic raid
// machinery, in ONE place so the client sim and the server verifier cannot drift.
//
// GROUND TRUTH: `docs/mechanics/ALIEN_RAID_RECOVERED.md` §7. Grepping the fight code for
// the stage-ID compare (`[[[GameState gameState] zfGameData] currentEnemy] == 6`) turns up
// exactly four sites, and three of them are modelled here:
//
//   * `initialSpawn` 0x575fe — `spawnTimer = 10` instead of 3600, the reinforcement drip
//     that makes this the only swarm raid in the game.
//   * `initialSpawn` 0x57618 — seed `bossSummonList` with four abducted humans.
//   * `spawnEnemy`   0x57f5c — a random RGB tint per alien (presentation; see RaidScene).
//
// The fourth is an equivalent re-statement of the live-enemy count and needs no model.
import type { AttackDef, CombatUnit, EnemyStat, SummonConfig, WaveCadence } from "./types";
import { buildUnitsForKeys } from "./CombatEngine";
import type { EliteProfile } from "./eliteInvasion";
import { BUBBLE_RAID_ID, dualWaveCadence } from "./dualInvasion";

/** Enemies.json ID of Zombies vs Aliens. */
export const ALIEN_RAID_ID = 6;

/** One "current" enemy + the five `enemySlots` entries. */
const ALIEN_MAX_ACTIVE = 6;
/** `spawnTimer`'s alien seed, in ms (every other stage gets 3600 s, i.e. never). */
const ALIEN_DRIP_MS = 10_000;

/** The four abductees `initialSpawn` seeds `bossSummonList` with, in order. */
export const ABDUCTEE_SEED = [
  "FarmStageActorLumberjack",
  "FarmStageActorLumberjack",
  "CityStageActorCrazedWorker",
  "NinjaStageActorBoy",
];

/** The five names `summonBoss:` rolls between when it pushes a replacement onto the
 *  queue — `(int)((arc4random() % 100) / 100.0f * 5.0f)`, 20 % each. */
export const ABDUCTEE_POOL = [
  "FarmStageActorFarmhand",
  "FarmStageActorLumberjack",
  "CityStageActorCrazedWorker",
  "PirateStageActorSwashbuckler",
  "NinjaStageActorGirl",
];

/** Every unit key the alien summon can put on the field — what a renderer must preload. */
export const ABDUCTEE_KEYS = [...new Set([...ABDUCTEE_SEED, ...ABDUCTEE_POOL])];

/** The wave's minion — the unit that carries the random tint. */
export const ALIEN_MINION_KEY = "AlienStageActorMinion";

/** Every alien in the wave is a DIFFERENT colour.
 *
 *  GROUND TRUTH (`-[ZFFightMan spawnEnemy]` 0x57f3a): on the alien stage and nowhere else,
 *  a freshly spawned minion gets `setSavedColor:` from three independent rolls of
 *  `(int)((arc4random() % 100) / 100.0f * 255.0f)` and then `resetColor`, which applies it
 *  to every attachment whose `inheritColor` is YES. That is why the minion art in
 *  AlienStage.png is greyscale (measured saturation 0-2) while the boss's is already
 *  purple, and why the face and body detail — the two `setInheritColor: NO` parts — stay
 *  grey. See docs/mechanics/ALIEN_RAID_RECOVERED.md §7.4.
 *
 *  The roll is hashed off the unit id rather than drawn from a live RNG: colour does not
 *  touch the fight's outcome, and a pure function of the id keeps the renderer free of
 *  simulation state (a token rebuilt mid-fight comes back the same colour).
 *
 *  Returns null for anything that is not an alien minion. */
export function alienTintFor(sourceKey: string, unitId: string): number | null {
  if (sourceKey !== ALIEN_MINION_KEY) return null;
  const channel = (salt: number) => {
    // The source's roll lands on multiples of 255/100, so quantise to the same 100 steps.
    let h = 2166136261 ^ salt;
    for (let i = 0; i < unitId.length; i++) {
      h = Math.imul(h ^ unitId.charCodeAt(i), 16777619);
    }
    const n = (h >>> 0) % 100;
    return Math.floor((n / 100) * 255);
  };
  return (channel(1) << 16) | (channel(2) << 8) | channel(3);
}

/** How this raid feeds its wave in. Raid 6 departs from one-at-a-time because the binary
 *  says so; the four dual invasions depart from it by design, and line up the same way (see
 *  dualInvasion.dualWaveCadence). Everything else trickles. */
export function waveCadenceFor(raidId: number): WaveCadence {
  if (raidId === ALIEN_RAID_ID) return { maxActive: ALIEN_MAX_ACTIVE, dripMs: ALIEN_DRIP_MS };
  return dualWaveCadence(raidId) ?? { maxActive: 1, dripMs: 0 };
}

/** The abductee queue for a stage whose boss carries `summonBoss` — only the alien one
 *  does, and `allowedToSummonBoss` refuses the cast outright on an empty list, so every
 *  other boss gets null. Units are derived exactly like wave minions (same elite/pace
 *  context) so an abducted lumberjack fights as it would in its own raid. */
export function summonConfigFor(
  raidId: number,
  stats: Record<string, EnemyStat>,
  attacks: Record<string, AttackDef>,
  opts: { raidId?: number; playerLevel?: number; elite?: EliteProfile | null } = {}
): SummonConfig | null {
  // Raid 15 is fought on this stage with this boss, so it gets the rota too. Keyed by id
  // rather than by "does the boss carry summonBoss" because the ROTA is the alien stage's
  // authored content (ABDUCTEE_SEED / _POOL), not the action's — a future boss that
  // summoned something else would want its own list, not this one.
  if (raidId !== ALIEN_RAID_ID && raidId !== BUBBLE_RAID_ID) return null;
  const build = (keys: string[]): CombatUnit[] =>
    buildUnitsForKeys(keys, null, stats, attacks, opts);
  // Seed order matters (the queue is FIFO), so build it as authored rather than deduped.
  const queue = build(ABDUCTEE_SEED);
  const pool = build([...new Set(ABDUCTEE_POOL)]);
  if (!queue.length || !pool.length) return null;
  return { queue, pool };
}
