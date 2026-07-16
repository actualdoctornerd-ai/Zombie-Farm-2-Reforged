import type { EpicBossProjection, QuestProjection } from "../../../src/net/protocol";
import { DR_GROUNDHOG, epicBossHp } from "../../../src/epicBoss/catalog";
import { DICE_KEY, VOUCHER_KEY } from "../boostCatalog";
import { QUEST_REWARD, questDefinition } from "../questCatalog";
import { applyQuestEvents } from "./engine";
import zombieRows from "../../../public/assets/zombies.json";
import { buildPlayerUnits } from "../../../src/raid/CombatEngine";
import { deriveAttackIntervalMs } from "../../../src/raid/combatStats";
import { BattleSim } from "../../../src/raid/BattleSim";
import { replayRaid, type RaidReplayInput } from "../../../src/raid/replay";
import type { CombatUnit } from "../../../src/raid/types";
import { makeOwned } from "../../../src/zombie/types";
import { ABILITY_TIER, abilityTierOf } from "../../../src/zombie/traits";
import { farmerMultiplier } from "../../../src/farmer";
import { levelForXp } from "../levels";

export interface RunRow {
  run_id: string; boss_id: string; activated_at: number; expires_at: number;
  level: number; max_hp: number; current_hp: number; encounter_started_at: number;
  retry_ready_at: number; completed_at: number; attack_order_json: string;
}
interface SessionRow {
  id: string; run_id: string; level: number; starting_hp: number; roster_json: string;
  config_json: string; started_at: number; expires_at: number; finished_at: number | null; result_json: string | null;
}
interface EpicCombatConfig { playerUnits: CombatUnit[]; enemyUnits: CombatUnit[] }
const zombies = new Map((zombieRows as Array<{key:string}>).map((z) => [z.key, z]));
const GROUNDHOG_QUESTS = new Set(["1000", "1001", "1002", "1003", "1010", "1011"]);
interface CoreState {
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  ownedPets: string[];
  zombieMax: number;
  [key: string]: unknown;
}

const parse = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

export const projectRun = (row: RunRow | null): EpicBossProjection | null => row ? ({
  runId: row.run_id, bossId: row.boss_id, activatedAt: row.activated_at,
  expiresAt: row.expires_at, level: row.level, maxHp: row.max_hp,
  currentHp: row.current_hp, encounterStartedAt: row.encounter_started_at,
  retryReadyAt: row.retry_ready_at, completedAt: row.completed_at,
  attackOrder: parse<string[]>(row.attack_order_json, []),
}) : null;

export async function readRun(db: D1Database, accountId: string): Promise<EpicBossProjection | null> {
  return projectRun(await db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id = ?")
    .bind(accountId).first<RunRow>());
}

export async function activate(
  db: D1Database, accountId: string, activationId: string, now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [balance, current] = await Promise.all([
    db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?").bind(accountId)
      .first<{ gold: number; brains: number; xp: number }>(),
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id = ?").bind(accountId).first<RunRow>(),
  ]);
  if (!balance) return { status: 409, body: { error: "state_conflict" } };
  if (current?.run_id === activationId) return { status: 200, body: { event: projectRun(current), balance } };
  if (current && !current.completed_at && current.expires_at > now) {
    return { status: 409, body: { error: "event_active", event: projectRun(current) } };
  }
  if (balance.brains < DR_GROUNDHOG.costBrains) return { status: 409, body: { error: "insufficient_brains", balance } };
  const hp = epicBossHp(DR_GROUNDHOG, 1);
  const expiresAt = now + DR_GROUNDHOG.durationMs;
  const statements = await db.batch([
    db.prepare(`INSERT INTO epic_boss_runs_v3
      (account_id,run_id,boss_id,activated_at,expires_at,level,max_hp,current_hp)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
      run_id=excluded.run_id,boss_id=excluded.boss_id,activated_at=excluded.activated_at,
      expires_at=excluded.expires_at,level=excluded.level,max_hp=excluded.max_hp,
      current_hp=excluded.current_hp,encounter_started_at=0,retry_ready_at=0,
      completed_at=0,attack_order_json='[]'
      WHERE epic_boss_runs_v3.completed_at != 0 OR epic_boss_runs_v3.expires_at <= ?`)
      .bind(accountId, activationId, DR_GROUNDHOG.id, now, expiresAt, 1, hp, hp, now),
    db.prepare(`UPDATE balances SET brains = brains - ? WHERE account_id = ? AND brains >= ?
      AND EXISTS(SELECT 1 FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?)`)
      .bind(DR_GROUNDHOG.costBrains, accountId, DR_GROUNDHOG.costBrains, accountId, activationId),
  ]);
  if ((statements[0]?.meta.changes ?? 0) !== 1 || (statements[1]?.meta.changes ?? 0) !== 1) {
    return { status: 409, body: { error: "activation_conflict" } };
  }
  return { status: 200, body: {
    event: await readRun(db, accountId),
    balance: { ...balance, brains: balance.brains - DR_GROUNDHOG.costBrains },
  } };
}

export async function expireLiveEpicBoss(db: D1Database, accountId: string, now: number): Promise<void> {
  const live = await db.prepare(`SELECT id,run_id FROM epic_boss_sessions_v3
    WHERE account_id=? AND finished_at IS NULL AND expires_at <= ?`).bind(accountId, now).first<{ id: string; run_id: string }>();
  if (!live) return;
  await db.batch([
    db.prepare("UPDATE epic_boss_sessions_v3 SET finished_at=? WHERE id=? AND finished_at IS NULL").bind(now, live.id),
    db.prepare("UPDATE epic_boss_runs_v3 SET retry_ready_at=? WHERE account_id=? AND run_id=? AND completed_at=0")
      .bind(now + DR_GROUNDHOG.retryMs, accountId, live.run_id),
    db.prepare("UPDATE roster_v3 SET locked_by_raid=NULL WHERE account_id=? AND locked_by_raid=?").bind(accountId, live.id),
  ]);
}

export async function start(
  db: D1Database, accountId: string, orderedUnitIds: unknown, now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  await expireLiveEpicBoss(db, accountId, now);
  const ids = Array.isArray(orderedUnitIds)
    ? [...new Set(orderedUnitIds.filter((id): id is string => typeof id === "string" && !!id))].slice(0, 64) : [];
  if (!ids.length) return { status: 400, body: { error: "bad_roster" } };
  const [row, raid, epic, roster, balance, coreRow, raidState] = await Promise.all([
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=?").bind(accountId).first<RunRow>(),
    db.prepare("SELECT id FROM raid_sessions_v3 WHERE account_id=? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    db.prepare("SELECT * FROM epic_boss_sessions_v3 WHERE account_id=? AND finished_at IS NULL").bind(accountId).first<SessionRow>(),
    db.prepare(`SELECT unit_id,zombie_key,mutation,invasions FROM roster_v3 WHERE account_id=? AND stored=0 AND locked_by_raid IS NULL
      AND unit_id IN (${ids.map(() => "?").join(",")})`).bind(accountId, ...ids)
      .all<{ unit_id: string; zombie_key: string; mutation: number; invasions: number }>(),
    db.prepare("SELECT xp FROM balances WHERE account_id=?").bind(accountId).first<{xp:number}>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").bind(accountId).first<{current_json:string}>(),
    db.prepare("SELECT progress_json FROM raid_state_v3 WHERE account_id=?").bind(accountId).first<{progress_json:string}>(),
  ]);
  if (!row || row.completed_at || row.expires_at <= now) return { status: 409, body: { error: "inactive" } };
  if (epic) {
    const pinned = parse<string[]>(epic.roster_json, []);
    if (pinned.length === ids.length && pinned.every((id, index) => id === ids[index])) {
      return { status: 200, body: { ok: true, resumed: true, sessionId: epic.id,
        event: projectRun(row), expiresAt: epic.expires_at } };
    }
    return { status: 409, body: { error: "battle_in_progress" } };
  }
  if (raid) return { status: 409, body: { error: "battle_in_progress" } };
  if ((roster.results ?? []).length !== ids.length) return { status: 409, body: { error: "bad_roster" } };
  if (row.encounter_started_at && now >= row.encounter_started_at + DR_GROUNDHOG.encounterMs) {
    row.max_hp = epicBossHp(DR_GROUNDHOG, row.level); row.current_hp = row.max_hp;
    row.encounter_started_at = 0; row.retry_ready_at = 0;
  }
  if (row.retry_ready_at > now) return { status: 429, body: { error: "cooldown", retryAfterMs: row.retry_ready_at - now } };
  const sessionId = crypto.randomUUID();
  const encounterStartedAt = row.encounter_started_at || now;
  const expiresAt = Math.min(row.expires_at + DR_GROUNDHOG.fightMs, now + 2 * 60_000);
  if (!balance || !coreRow || !raidState) return { status: 409, body: { error: "state_conflict" } };
  const byId = new Map((roster.results ?? []).map((unit) => [unit.unit_id, unit]));
  const core = parse<CoreState>(coreRow.current_json, { inventory:{},storage:{received:{},stored:{}},ownedPets:[],zombieMax:16 });
  const wins = parse<Record<string,number>>(raidState.progress_json, {});
  const abilityUnlocked = (key: string) => {
    const tier = abilityTierOf(key), pool = ABILITY_TIER[tier] ?? [];
    const index = pool.indexOf(key);
    return index >= 0 && index < Math.min(pool.length, wins[String(tier)] ?? 0);
  };
  const party = ids.map((id) => {
    const unit = byId.get(id)!;
    return makeOwned(id, zombies.get(unit.zombie_key)! as Parameters<typeof makeOwned>[1], 0, 0, unit.invasions, unit.mutation);
  });
  const playerUnits = buildPlayerUnits(party, {
    concentration: true, abilityUnlocked, playerLevel: levelForXp(balance.xp),
    farmerStrengthMult: farmerMultiplier(Number(core.farmerHeadId ?? 1), "zombieStrength"),
    farmerLifeMult: farmerMultiplier(Number(core.farmerHeadId ?? 1), "zombieLife"),
  });
  const boss: CombatUnit = {
    id:`epic:${row.run_id}:${row.level}`,sourceKey:"DrGroundhogEpicBoss",team:"enemy",name:DR_GROUNDHOG.name,
    str:2,dex:2,con:20,focus:0,hp:row.current_hp,maxHp:row.max_hp,
    attackCooldownMs:deriveAttackIntervalMs(2,"enemy")*2,
    attacks:[{name:"EpicBossAttack",frequency:100,mult:1}],isBoss:true,alive:true,isGarden:false,isHeadless:false,
    abilities:[],attackDamageTiming:0.88,
  };
  const config: EpicCombatConfig = { playerUnits, enemyUnits:[boss] };
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO epic_boss_sessions_v3
      (id,account_id,run_id,level,starting_hp,roster_json,config_json,started_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(sessionId, accountId, row.run_id, row.level, row.current_hp, JSON.stringify(ids), JSON.stringify(config), now, expiresAt),
    db.prepare(`UPDATE epic_boss_runs_v3 SET encounter_started_at=?,retry_ready_at=0,
      attack_order_json=?,max_hp=?,current_hp=? WHERE account_id=? AND run_id=?`)
      .bind(encounterStartedAt, JSON.stringify(ids), row.max_hp, row.current_hp, accountId, row.run_id),
  ];
  ids.forEach((id) => statements.push(db.prepare(`UPDATE roster_v3 SET locked_by_raid=?
    WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL`).bind(sessionId, accountId, id)));
  await db.batch(statements);
  return { status: 200, body: { ok: true, sessionId, event: {
    ...projectRun(row)!, encounterStartedAt, retryReadyAt: 0, attackOrder: ids,
  }, expiresAt } };
}

export async function finish(
  db: D1Database, accountId: string,
  body: { sessionId?: unknown; finalTick?: unknown; inputs?: unknown },
  now: number, random: () => number = Math.random
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string") return { status: 400, body: { error: "bad_session" } };
  const session = await db.prepare("SELECT * FROM epic_boss_sessions_v3 WHERE id=? AND account_id=?")
    .bind(body.sessionId, accountId).first<SessionRow>();
  if (!session) return { status: 404, body: { error: "bad_session" } };
  if (session.result_json) return { status: 200, body: parse(session.result_json, {}) };
  if (session.finished_at) return { status: 409, body: { error: "already_finished" } };
  const locked = parse<string[]>(session.roster_json, []);
  const pacedTick = Math.floor((now - session.started_at) / 50) + 40;
  if (Number(body.finalTick) > pacedTick) return { status: 422, body: { error: "future_finish" } };
  const config = parse<EpicCombatConfig | null>(session.config_json, null);
  if (!config || !Number.isInteger(body.finalTick) || !Array.isArray(body.inputs)) return { status: 400, body: { error: "bad_replay" } };
  const verified = replayRaid(new BattleSim(
    config.playerUnits, config.enemyUnits, null, false, [], null, DR_GROUNDHOG.fightMs,
    null, null, true, true
  ), body.finalTick as number, body.inputs as RaidReplayInput[]);
  if (!verified.ok) return { status: 422, body: { error: verified.error } };
  const { survivors, losses } = verified.outcome;
  if (new Set([...survivors, ...losses]).size !== locked.length) return { status: 422, body: { error: "replay_roster_mismatch" } };
  const [run, balance, coreRow, questRow] = await Promise.all([
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?").bind(accountId, session.run_id).first<RunRow>(),
    db.prepare("SELECT gold,brains,xp,claimed_level FROM balances WHERE account_id=?").bind(accountId).first<{gold:number;brains:number;xp:number;claimed_level:number}>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").bind(accountId).first<{current_json:string}>(),
    db.prepare("SELECT version,current_json FROM quest_documents_v3 WHERE account_id=?").bind(accountId).first<{version:number;current_json:string}>(),
  ]);
  if (!run || !balance || !coreRow || !questRow || run.level !== session.level) return { status: 409, body: { error: "stale_session" } };
  const damage = Math.max(0, Math.min(session.starting_hp, Math.round(verified.outcome.playerDamage)));
  const defeated = verified.outcome.win && damage >= session.starting_hp;
  const defeatedLevel = defeated ? run.level : null;
  if (defeated) {
    if (run.level >= DR_GROUNDHOG.maxLevel) { run.current_hp = 0; run.completed_at = now; }
    else { run.level++; run.max_hp = epicBossHp(DR_GROUNDHOG, run.level); run.current_hp = run.max_hp; }
    run.encounter_started_at = 0; run.retry_ready_at = 0;
  } else {
    run.current_hp = Math.max(1, session.starting_hp - damage);
    run.retry_ready_at = now + DR_GROUNDHOG.retryMs;
  }
  const core = parse<CoreState>(coreRow.current_json, { inventory: {}, storage: { received: {}, stored: {} }, ownedPets: [], zombieMax: 16 });
  const questData = parse<{completed:string[];progress:QuestProjection["progress"]}>(questRow.current_json, { completed: [], progress: [] });
  const quests: QuestProjection = { version: questRow.version, ...questData };
  const beforeCompleted = new Set(quests.completed);
  let loot: { name: string; tile?: string; stageActor?: string; sprite: string } | null = null;
  if (defeatedLevel !== null && random() < 0.35) {
    let eligible = DR_GROUNDHOG.loot.filter((x) => x.level <= defeatedLevel && (!x.stageActor || !core.ownedPets.includes(x.stageActor)));
    const uncollected = eligible.filter((x) => x.stageActor ? !core.ownedPets.includes(x.stageActor) : !(core.storage.received[x.name] > 0));
    if (uncollected.length) eligible = uncollected;
    if (eligible.length) loot = eligible[Math.floor(random() * eligible.length)] ?? null;
    if (loot?.stageActor) core.ownedPets = [...new Set([...core.ownedPets, loot.stageActor])];
    else if (loot) core.storage.received[loot.name] = (core.storage.received[loot.name] ?? 0) + 1;
  }
  const events = defeatedLevel === null ? [] : [
    { type: "kEpicStageEnemyDefeatedNotification", subject: String(defeatedLevel) },
    ...(loot ? [{ type: "kEpicBossEpicItemWonNotification", subject: loot.name }] : []),
  ];
  const questChanges = applyQuestEvents(balance, quests, events, { includeEpic: true, epicQuestIds: GROUNDHOG_QUESTS });
  const newlyCompleted = quests.completed.filter((id) => !beforeCompleted.has(id));
  const newZombies: { id: string; key: string }[] = [];
  for (const id of newlyCompleted) {
    const reward = questDefinition(id);
    if (!reward) continue;
    if (reward.rewardType === QUEST_REWARD.Item && reward.rewardItemKey === "Invasion Voucher") core.inventory[VOUCHER_KEY] = (core.inventory[VOUCHER_KEY] ?? 0) + 1;
    if (reward.rewardType === QUEST_REWARD.Item && reward.rewardItemKey === "Golden Dice") core.inventory[DICE_KEY] = (core.inventory[DICE_KEY] ?? 0) + 1;
    const key = id === "1000" ? "ZombieActorDrZombie" : id === "1011" ? "ZombieActorOmegaDrZombie" : "";
    if (key) newZombies.push({ id: crypto.randomUUID(), key });
  }
  const result = { event: {
    ...projectRun(run)!, level: run.level, maxHp: run.max_hp, currentHp: run.current_hp,
    encounterStartedAt: run.encounter_started_at, retryReadyAt: run.retry_ready_at, completedAt: run.completed_at,
  }, defeatedLevel, escaped: !defeated, loot, balance, inventory: core.inventory,
    storage: core.storage, ownedPets: core.ownedPets, survivors, losses, quests, questChanges, newZombies };
  const resultJson = JSON.stringify(result);
  const guard = "EXISTS(SELECT 1 FROM epic_boss_sessions_v3 s WHERE s.id=? AND s.result_json=?)";
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE epic_boss_sessions_v3 SET finished_at=?,result_json=? WHERE id=? AND finished_at IS NULL")
      .bind(now, resultJson, session.id),
    db.prepare(`UPDATE epic_boss_runs_v3 SET level=?,max_hp=?,current_hp=?,encounter_started_at=?,
      retry_ready_at=?,completed_at=? WHERE account_id=? AND run_id=? AND ${guard}`)
      .bind(run.level,run.max_hp,run.current_hp,run.encounter_started_at,run.retry_ready_at,run.completed_at,accountId,run.run_id,session.id,resultJson),
    db.prepare(`UPDATE balances SET gold=?,brains=?,xp=? WHERE account_id=? AND ${guard}`)
      .bind(balance.gold,balance.brains,balance.xp,accountId,session.id,resultJson),
    db.prepare(`UPDATE gameplay_documents_v3 SET current_json=?,updated_at=? WHERE account_id=? AND ${guard}`)
      .bind(JSON.stringify(core),now,accountId,session.id,resultJson),
    db.prepare(`UPDATE quest_documents_v3 SET version=version+1,current_json=?,updated_at=? WHERE account_id=? AND ${guard}`)
      .bind(JSON.stringify({completed:quests.completed,progress:quests.progress}),now,accountId,session.id,resultJson),
  ];
  losses.forEach((id) => statements.push(db.prepare(`DELETE FROM roster_v3 WHERE account_id=? AND unit_id=? AND locked_by_raid=? AND ${guard}`)
    .bind(accountId,id,session.id,session.id,resultJson)));
  survivors.forEach((id) => statements.push(db.prepare(`UPDATE roster_v3 SET invasions=invasions+1,locked_by_raid=NULL
    WHERE account_id=? AND unit_id=? AND locked_by_raid=? AND ${guard}`).bind(accountId,id,session.id,session.id,resultJson)));
  newZombies.forEach((z) => statements.push(db.prepare(`INSERT INTO roster_v3(account_id,unit_id,zombie_key,stored,created_at)
    SELECT ?,?,?,1,? WHERE ${guard}`).bind(accountId,z.id,z.key,now,session.id,resultJson)));
  await db.batch(statements);
  return { status: 200, body: result };
}
