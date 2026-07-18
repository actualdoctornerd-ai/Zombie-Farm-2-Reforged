import raidsJson from "../../public/assets/raids/raids.json";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import zombiesJson from "../../public/assets/zombies.json";
import { BattleSim, type BattleSimSnapshot } from "../../src/raid/BattleSim";
import { buildEnemyUnits, buildPlayerUnits } from "../../src/raid/CombatEngine";
import { fightStage, minArmyFor, ARMY_CAP } from "../../src/raid/RaidCatalog";
import { makeOwned } from "../../src/zombie/types";
import { ABILITY_TIER, abilityTierOf } from "../../src/zombie/traits";
import { advanceRaidSegment, replayRaid, RAID_RULESET_VERSION, type RaidReplayInput } from "../../src/raid/replay";
import type {
  AttackDef,
  BossSpecial,
  BossThrowConfig,
  CombatUnit,
  EnemyStat,
  RaidDef,
  RaidOutcome,
  RaidStage,
  GrabberConfig,
} from "../../src/raid/types";
import { levelForXp } from "./levels";
import { farmerMultiplier } from "../../src/farmer";

export { RAID_RULESET_VERSION };
export type { RaidReplayInput };

interface RosterRow {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
}

export interface PinnedRaidConfig {
  raidId: number;
  raidName: string;
  rosterIds: string[];
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  bossThrow: BossThrowConfig | null;
  bossSpecials: BossSpecial[];
  summonTemplate: CombatUnit | null;
  wallTemplate: CombatUnit | null;
  grabber: GrabberConfig | null;
  concentration: boolean;
}

interface V3RosterRow {
  unit_id: string;
  zombie_key: string;
  mutation: number;
  invasions: number;
}

const raids = raidsJson as RaidDef[];
const enemyStats = enemyStatsJson as Record<string, EnemyStat>;
const attacks = attacksJson as Record<string, AttackDef>;
const zombieDefs = new Map((zombiesJson as Array<{ key: string }>).map((z) => [z.key, z]));
const GRAB_SPRITE: Readonly<Record<number, string>> = { 8: "hazard_trapeze_girl.png" };

function grabberOf(raid: RaidDef): GrabberConfig | null {
  const sprite = GRAB_SPRITE[raid.id];
  return raid.hasGrab && sprite ? { sprite, hp: 1000, tapDamage: 100, spawnDelayMs: 4000 } : null;
}

function stageRosterKeys(stage: RaidStage): string[] {
  return [stage.bossKey ?? "", ...(stage.enemyKeys ?? []), ...(stage.weighted ?? []).map((w) => w.enemy)]
    .filter(Boolean);
}

function findStageAction(stage: RaidStage, name: string) {
  for (const key of stageRosterKeys(stage)) {
    const action = enemyStats[key]?.bossActions?.find((candidate) => candidate.name === name);
    if (action) return action;
  }
  return undefined;
}

function bossThrowOf(raid: RaidDef, stage: RaidStage): BossThrowConfig | null {
  if (!stage.bossKey || stage.throwingDisabled) return null;
  const options = (enemyStats[stage.bossKey]?.bossActions ?? [])
    .filter((a) => a.name === "throw")
    .map((a) => ({
      damage: a.damage ?? 0,
      weight: a.frequency,
      sprite: a.sprite ?? "",
      spriteSize: a.spriteSize ?? 32,
    }))
    .filter((o) => o.sprite);
  if (!options.length) return null;
  const secs = stage.throwSpeed ?? raid.throwSpeed;
  return { intervalMs: (secs > 0 ? secs : 2) * 2000, options };
}

function bossSpecialsOf(stage: RaidStage): BossSpecial[] {
  if (!stage.bossKey || stage.throwingDisabled) return [];
  const actions = [...(enemyStats[stage.bossKey]?.bossActions ?? [])];
  if (!actions.some((action) => action.name === "wall")) {
    const wall = findStageAction(stage, "wall");
    if (wall) actions.push(wall);
  }
  return actions
    .filter((a) => a.name !== "throw")
    .map((a) => ({
      name: a.name,
      weight: a.frequency,
      castMs: (a.castTime ?? 0) * 1000,
      cooldownMs: (a.cooldownTime ?? a.castTime ?? 2) * 1000,
      damage: a.damage ?? 0,
    }));
}

function summonWallTemplates(stage: RaidStage, units: CombatUnit[]): {
  summonTemplate: CombatUnit | null;
  wallTemplate: CombatUnit | null;
} {
  let summonTemplate: CombatUnit | null = null;
  let wallTemplate: CombatUnit | null = null;
  if (!stage.bossKey || stage.throwingDisabled) return { summonTemplate, wallTemplate };
  const actions = enemyStats[stage.bossKey]?.bossActions ?? [];
  if (actions.some((a) => a.name === "summonBoss")) {
    const minion = units.find((u) => !u.isBoss);
    if (minion) summonTemplate = { ...minion };
  }
  const wall = findStageAction(stage, "wall");
  if (wall) {
    const hp = Math.max(1, Math.round(wall.hp ?? 1500));
    wallTemplate = {
      id: "wall",
      sourceKey: (wall.sprite ?? "carrotWall.png").replace(/\.png$/i, ""),
      team: "enemy",
      name: "Wall",
      str: 0,
      dex: 1,
      con: Math.round(hp / 10),
      focus: 0,
      hp,
      maxHp: hp,
      attackCooldownMs: 3500,
      attacks: [{ name: "", frequency: 1, mult: 0 }],
      isBoss: false,
      alive: true,
      isGarden: false,
      isHeadless: false,
      abilities: [],
    };
  }
  return { summonTemplate, wallTemplate };
}

export type BuildPinnedResult =
  | { ok: true; config: PinnedRaidConfig }
  | { ok: false; error: string };

/** Build combat exclusively from the owned roster and server catalogs. */
export async function buildPinnedRaid(
  db: D1Database,
  accountId: string,
  raidId: number,
  orderedIds: unknown,
  concentration: boolean
): Promise<BuildPinnedResult> {
  if (!Array.isArray(orderedIds) || orderedIds.length > ARMY_CAP || orderedIds.length === 0) {
    return { ok: false, error: "bad_roster" };
  }
  const ids = orderedIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length !== orderedIds.length || new Set(ids).size !== ids.length) return { ok: false, error: "bad_roster" };
  const raid = raids.find((r) => r.id === raidId && r.playable);
  if (!raid) return { ok: false, error: "bad_raid" };
  const balance = await db
    .prepare("SELECT xp FROM balances WHERE account_id = ?")
    .bind(accountId)
    .first<{ xp: number }>();
  const level = levelForXp(balance?.xp ?? 0);
  if (level < raid.unlockLevel) return { ok: false, error: "locked" };
  const stage = fightStage(raid, level);
  if (!stage) return { ok: false, error: "bad_stage" };

  const placeholders = ids.map(() => "?").join(",");
  const owned = await db
    .prepare(
      `SELECT id, key, mutation, invasions FROM roster
       WHERE account_id = ? AND id IN (${placeholders})`
    )
    .bind(accountId, ...ids)
    .all<RosterRow>();
  const byId = new Map((owned.results ?? []).map((r) => [r.id, r]));
  if (byId.size !== ids.length) return { ok: false, error: "unit_not_owned" };
  const locks = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM raid_roster_locks
       WHERE account_id = ? AND unit_id IN (${placeholders})`
    )
    .bind(accountId, ...ids)
    .first<{ n: number }>();
  if ((locks?.n ?? 0) > 0) return { ok: false, error: "unit_locked" };
  const progress = await db
    .prepare("SELECT raid_id, wins FROM raid_clears WHERE account_id = ?")
    .bind(accountId)
    .all<{ raid_id: number; wins: number }>();
  const wins = new Map((progress.results ?? []).map((r) => [r.raid_id, r.wins]));
  if (ids.length < minArmyFor(raid, wins.get(raidId) ?? 0)) return { ok: false, error: "army_too_small" };

  const party = ids.map((id) => {
    const row = byId.get(id)!;
    const def = zombieDefs.get(row.key);
    if (!def) throw new Error(`unknown roster catalog key ${row.key}`);
    return makeOwned(id, def as Parameters<typeof makeOwned>[1], 0, 0, row.invasions, row.mutation);
  });
  const abilityUnlocked = (key: string): boolean => {
    const tier = abilityTierOf(key);
    const pool = ABILITY_TIER[tier] ?? [];
    const idx = pool.indexOf(key);
    return idx >= 0 && idx < Math.min(pool.length, wins.get(tier) ?? 0);
  };
  const enemyUnits = buildEnemyUnits(stage, enemyStats, attacks);
  return {
    ok: true,
    config: {
      raidId,
      raidName: raid.name,
      rosterIds: ids,
      playerUnits: buildPlayerUnits(party, { concentration, abilityUnlocked, playerLevel: level }),
      enemyUnits,
      bossThrow: bossThrowOf(raid, stage),
      bossSpecials: bossSpecialsOf(stage),
      ...summonWallTemplates(stage, enemyUnits),
      grabber: grabberOf(raid),
      concentration,
    },
  };
}

export function createPinnedSim(config: PinnedRaidConfig): BattleSim {
  return new BattleSim(
    config.playerUnits,
    config.enemyUnits,
    config.bossThrow,
    config.concentration,
    config.bossSpecials,
    null,
    undefined,
    config.summonTemplate,
    config.wallTemplate,
    false,
    false,
    false,
    undefined,
    config.grabber ?? null
  );
}

/** Build the same pinned combat configuration from protocol-v3 authoritative state. */
export async function buildPinnedV3Raid(
  db: D1Database,
  accountId: string,
  raidId: number,
  orderedIds: unknown,
  concentration: boolean
): Promise<BuildPinnedResult> {
  if (!Array.isArray(orderedIds) || orderedIds.length > ARMY_CAP || orderedIds.length === 0) {
    return { ok: false, error: "bad_roster" };
  }
  const ids = orderedIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length !== orderedIds.length || new Set(ids).size !== ids.length) return { ok: false, error: "bad_roster" };
  const raid = raids.find((candidate) => candidate.id === raidId && candidate.playable);
  if (!raid) return { ok: false, error: "bad_raid" };

  const placeholders = ids.map(() => "?").join(",");
  const [balance, owned, raidState, coreRow] = await Promise.all([
    db.prepare("SELECT xp FROM balances WHERE account_id = ?").bind(accountId).first<{ xp: number }>(),
    db.prepare(`SELECT unit_id,zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND stored=0 AND locked_by_raid IS NULL AND unit_id IN (${placeholders})`)
      .bind(accountId, ...ids).all<V3RosterRow>(),
    db.prepare("SELECT progress_json FROM raid_state_v3 WHERE account_id=?")
      .bind(accountId).first<{ progress_json: string }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?")
      .bind(accountId).first<{ current_json: string }>(),
  ]);
  const level = levelForXp(balance?.xp ?? 0);
  if (level < raid.unlockLevel) return { ok: false, error: "locked" };
  const rows = owned.results ?? [];
  if (rows.length !== ids.length) return { ok: false, error: "unit_not_owned" };
  const byId = new Map(rows.map((row) => [row.unit_id, row]));
  const winsObject = (() => {
    try { return JSON.parse(raidState?.progress_json ?? "{}") as Record<string, number>; }
    catch { return {}; }
  })();
  if (ids.length < minArmyFor(raid, winsObject[String(raidId)] ?? 0)) return { ok: false, error: "army_too_small" };
  const stage = fightStage(raid, level);
  if (!stage) return { ok: false, error: "bad_stage" };
  const core = (() => {
    try { return JSON.parse(coreRow?.current_json ?? "{}") as { farmerHeadId?: number }; }
    catch { return {}; }
  })();
  const party = ids.map((id) => {
    const row = byId.get(id)!;
    const def = zombieDefs.get(row.zombie_key);
    if (!def) return null;
    return makeOwned(id, def as Parameters<typeof makeOwned>[1], 0, 0, row.invasions, row.mutation);
  });
  if (party.some((unit) => unit === null)) return { ok: false, error: "bad_roster" };
  const abilityUnlocked = (key: string): boolean => {
    const tier = abilityTierOf(key);
    const pool = ABILITY_TIER[tier] ?? [];
    const index = pool.indexOf(key);
    return index >= 0 && index < Math.min(pool.length, winsObject[String(tier)] ?? 0);
  };
  const enemyUnits = buildEnemyUnits(stage, enemyStats, attacks);
  return {
    ok: true,
    config: {
      raidId,
      raidName: raid.name,
      rosterIds: ids,
      playerUnits: buildPlayerUnits(party as ReturnType<typeof makeOwned>[], {
        concentration,
        abilityUnlocked,
        playerLevel: level,
        farmerStrengthMult: farmerMultiplier(Number(core.farmerHeadId ?? 1), "zombieStrength"),
        farmerLifeMult: farmerMultiplier(Number(core.farmerHeadId ?? 1), "zombieLife"),
      }),
      enemyUnits,
      bossThrow: bossThrowOf(raid, stage),
      bossSpecials: bossSpecialsOf(stage),
      ...summonWallTemplates(stage, enemyUnits),
      grabber: grabberOf(raid),
      concentration,
    },
  };
}

export function verifyRaid(
  config: PinnedRaidConfig,
  finalTick: number,
  inputs: RaidReplayInput[]
): { ok: true; outcome: RaidOutcome; retreated: boolean } | { ok: false; error: string } {
  return replayRaid(createPinnedSim(config), finalTick, inputs);
}

export function verifyRaidSegment(
  config: PinnedRaidConfig,
  snapshot: BattleSimSnapshot | null,
  startTick: number,
  finalTick: number,
  startingSeq: number,
  inputs: RaidReplayInput[],
  allowRetreat: boolean
) {
  const sim = createPinnedSim(config);
  if (snapshot) sim.restore(snapshot);
  return advanceRaidSegment(sim, startTick, finalTick, startingSeq, inputs, allowRetreat);
}
