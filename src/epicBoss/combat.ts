import type { GameAssets } from "../assets";
import { deriveAttackIntervalMs } from "../raid/combatStats";
import { buildPlayerUnits } from "../raid/CombatEngine";
import type { CombatUnit, RaidDef } from "../raid/types";
import type { GameState } from "../GameState";
import type { OwnedZombie } from "../zombie/types";
import type { EpicBossDef, EpicBossLoot, EpicBossRun } from "./types";

export interface EpicBossSetup {
  raid: RaidDef;
  party: OwnedZombie[];
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
}

export function buildEpicBossSetup(
  def: EpicBossDef,
  run: EpicBossRun,
  party: OwnedZombie[],
  assets: GameAssets,
  state: GameState
): EpicBossSetup {
  const playerUnits = buildPlayerUnits(party, {
    concentration: true, // full focus throughput; BattleSim still uses manual brain release
    abilityUnlocked: (key) => state.abilityUnlocked(key),
    playerLevel: state.level,
    farmerStrengthMult: state.farmerZombieStrengthMult(),
    farmerLifeMult: state.farmerZombieLifeMult(),
  });
  const boss: CombatUnit = {
    id: `epic:${run.runId}:${run.level}`,
    sourceKey: "DrGroundhogEpicBoss",
    team: "enemy",
    name: def.name,
    str: 2,
    dex: 2,
    con: 20,
    focus: 0,
    hp: run.currentHp,
    maxHp: run.maxHp,
    attackCooldownMs: deriveAttackIntervalMs(2, "enemy") * 2,
    attacks: [{ name: "EpicBossAttack", frequency: 100, mult: 1 }],
    isBoss: true,
    alive: true,
    isGarden: false,
    isHeadless: false,
    abilities: [],
    attackDamageTiming: 0.88,
  };
  const raid: RaidDef = {
    id: -101,
    name: `${def.name} · Level ${run.level}`,
    bossName: def.name,
    bossPortrait: "",
    enemyIcon: "",
    unlockLevel: 0,
    recommendedLevel: 0,
    introText: def.introText,
    successText: def.successText,
    failureText: def.failedText,
    xp: 0,
    goldReward: 0,
    bonusGold: 0,
    throwSpeed: 0,
    music: `epic-bosses/${def.id}/${def.music}`,
    seasonal: true,
    playable: true,
    levelAssets: def.levelAssets,
    stages: [{ enemyKeys: [], bossKey: boss.sourceKey }],
    loot: [],
    obstacleLimit: 0,
    obstacleSpawnSecs: 0,
    obstacleActors: [],
    initialSpawnClass: "",
    hasGrab: false,
  };
  void assets; // retained in the signature alongside raid setup call sites
  return { raid, party, playerUnits, enemyUnits: [boss] };
}

/** Documented fallback when the exact binary loot selector is unavailable. */
export function rollEpicBossLoot(
  def: EpicBossDef,
  defeatedLevel: number,
  collected: ReadonlySet<string>,
  random: () => number = Math.random
): EpicBossLoot | null {
  if (random() >= 0.35) return null;
  const eligible = def.loot.filter((loot) => loot.level <= defeatedLevel);
  if (!eligible.length) return null;
  const fresh = eligible.filter((loot) => !collected.has(loot.name));
  const pool = fresh.length ? fresh : eligible.filter((loot) => !loot.stageActor);
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
