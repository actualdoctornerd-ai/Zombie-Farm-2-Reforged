import type { GameAssets } from "../assets";
import { deriveAttackIntervalMs, pickByFrequency } from "../raid/combatStats";
import { buildPlayerUnits } from "../raid/CombatEngine";
import type { CombatUnit, RaidDef } from "../raid/types";
import type { OwnedZombie } from "../zombie/types";
import { epicBossDamage, epicBossDamageTiming } from "./catalog";
import type { EpicBossDef, EpicBossLoot, EpicBossRun } from "./types";
import { EPIC_LOOT_DROP_CHANCE, EPIC_LOOT_ROLLS, epicLootWeight } from "./rewards";

/** Prefix of the `sourceKey` an Epic Boss fights under. It names an event, not a file:
 *  an Epic Boss draws from its own asset folder (`bossTexture` + the animation strips),
 *  and NOTHING under `assets/raids/enemies/` will ever answer to it.
 *
 *  Exported because the scene loader has to know that. Asking for the file anyway cost
 *  every Epic Boss fight a three-second stall on a 404 that cannot succeed — see
 *  `isEpicBossKey`'s use in RaidScene. */
export const EPIC_BOSS_KEY_PREFIX = "EpicBoss:";

/** Whether a combat `sourceKey` names an Epic Boss (and so has no shared enemy art). */
export function isEpicBossKey(sourceKey: string): boolean {
  return sourceKey.startsWith(EPIC_BOSS_KEY_PREFIX);
}

/** What an Epic Boss fight needs to know about the PLAYER. GameState satisfies this
 *  structurally, so the game passes its own state and nothing changes; the raid lab
 *  (src/devtools/raidLab.ts) passes a plain object, because a tool that wants to watch
 *  the boss's attack strip should not have to construct a save first. */
export interface EpicBossPlayerContext {
  level: number;
  abilityUnlocked(key: string): boolean;
  farmerZombieStrengthMult(): number;
  farmerZombieLifeMult(): number;
}

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
  state: EpicBossPlayerContext
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
    sourceKey: `${EPIC_BOSS_KEY_PREFIX}${def.id}`,
    team: "enemy",
    name: def.name,
    // Damage compounds 5% per rung (epicBossDamage) — MUST match server/src/v3/epicBoss.ts.
    str: epicBossDamage(def, run.level),
    dex: def.unitStats.dex,
    con: def.unitStats.con,
    focus: 0,
    hp: run.currentHp,
    maxHp: run.maxHp,
    // Raw enemy clock (1/dex) — an epic boss is an ordinary fight-scene enemy, so it
    // uses the same recovered cadence as every other one. MUST stay identical to
    // server/src/v3/epicBoss.ts or the authoritative replay diverges.
    attackCooldownMs: deriveAttackIntervalMs(def.unitStats.dex, "enemy"),
    attacks: def.unitStats.attacks.map((attack) => ({ ...attack, mult: attack.mult ?? 1 })),
    isBoss: true,
    alive: true,
    isGarden: false,
    isHeadless: false,
    abilities: [],
    // Per-attack, from the catalog — 0.88 for the six that punch, 0.25 for the two
    // that bite. MUST stay identical to server/src/v3/epicBoss.ts.
    attackDamageTiming: epicBossDamageTiming(def),
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

/** Documented fallback when the exact binary loot selector is unavailable.
 *
 *  One roll per cleared level at EPIC_LOOT_DROP_CHANCE, preferring prizes not yet
 *  collected, then weighted by the rung that unlocks each one (`epicLootWeight`) so the
 *  top-of-ladder signature item stays rare instead of being as likely as the first. */
export function rollEpicBossLoot(
  def: EpicBossDef,
  defeatedLevel: number,
  collected: ReadonlySet<string>,
  random: () => number = Math.random
): EpicBossLoot | null {
  if (random() >= EPIC_LOOT_DROP_CHANCE) return null;
  const eligible = def.loot.filter((loot) => loot.level <= defeatedLevel);
  if (!eligible.length) return null;
  const fresh = eligible.filter((loot) => !collected.has(loot.name));
  const pool = fresh.length ? fresh : eligible.filter((loot) => !loot.stageActor);
  if (!pool.length) return null;
  const picked = pickByFrequency(
    pool.map((loot) => ({ loot, frequency: epicLootWeight(loot.level) })), random
  );
  return picked?.loot ?? null;
}

/** Every decor drop from one cleared rung: EPIC_LOOT_ROLLS independent rolls.
 *
 *  Anything already picked in THIS clear joins `collected` for the next roll, so two
 *  rolls cannot hand over the same prize twice — which for a `unique` item would be a
 *  wasted drop, and is the whole reason two rolls beat one at double the rate. */
export function rollEpicBossDrops(
  def: EpicBossDef,
  defeatedLevel: number,
  collected: ReadonlySet<string>,
  random: () => number = Math.random
): EpicBossLoot[] {
  const drops: EpicBossLoot[] = [];
  const seen = new Set(collected);
  for (let roll = 0; roll < EPIC_LOOT_ROLLS; roll++) {
    const loot = rollEpicBossLoot(def, defeatedLevel, seen, random);
    if (!loot || drops.some((d) => d.name === loot.name)) continue;
    drops.push(loot);
    seen.add(loot.name);
  }
  return drops;
}
