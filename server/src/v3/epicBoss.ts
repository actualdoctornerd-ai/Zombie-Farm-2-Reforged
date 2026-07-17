import type { EpicBossProjection, QuestProjection } from "../../../src/net/protocol";
import { epicBossById, epicBossHp } from "../../../src/epicBoss/catalog";
import type { EpicBossDef } from "../../../src/epicBoss/types";
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
import { epicBossCurrencyReward, epicQuestZombieReward, shouldStoreEpicReward } from "../../../src/epicBoss/rewards";
import objectRows from "../../../public/assets/placeables.json";
import { EPIC_BOSS_FIGHT_BRAIN_COST } from "../../../src/epicBoss/tokens";

export interface RunRow {
  run_id: string; boss_id: string; activated_at: number; expires_at: number;
  level: number; max_hp: number; current_hp: number; encounter_started_at: number;
  retry_ready_at: number; token_count: number; completed_at: number; attack_order_json: string;
}
interface SessionRow {
  id: string; run_id: string; level: number; starting_hp: number; roster_json: string;
  config_json: string; started_at: number; expires_at: number; finished_at: number | null; result_json: string | null;
}
interface EpicCombatConfig { playerUnits: CombatUnit[]; enemyUnits: CombatUnit[] }
const zombies = new Map((zombieRows as Array<{key:string}>).map((z) => [z.key, z]));
const objectArmyCapacity = new Map((objectRows as Array<{key:string;armyMax?:number}>).map((o) => [o.key, o.armyMax ?? 0]));
const defFor = (bossId: string): EpicBossDef | null => epicBossById(bossId);
const DEFAULT_DEF = epicBossById("dr-groundhog")!;
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
  retryReadyAt: 0,
  tokenCount: row.completed_at || row.expires_at <= Date.now() ? 0 : Math.max(0, row.token_count ?? 0),
  completedAt: row.completed_at,
  attackOrder: parse<string[]>(row.attack_order_json, []),
}) : null;

export async function readRun(db: D1Database, accountId: string): Promise<EpicBossProjection | null> {
  return projectRun(await db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id = ?")
    .bind(accountId).first<RunRow>());
}

export async function activate(
  db: D1Database, accountId: string, activationId: string, bossId: unknown, now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const def = bossId === undefined ? DEFAULT_DEF : typeof bossId === "string" ? defFor(bossId) : null;
  if (!def) return { status: 400, body: { error: "unknown_boss" } };
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
  if (balance.brains < def.costBrains) return { status: 409, body: { error: "insufficient_brains", balance } };
  const hp = epicBossHp(def, 1);
  const expiresAt = now + def.durationMs;
  const statements = await db.batch([
    db.prepare(`INSERT INTO epic_boss_runs_v3
      (account_id,run_id,boss_id,activated_at,expires_at,level,max_hp,current_hp)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
      run_id=excluded.run_id,boss_id=excluded.boss_id,activated_at=excluded.activated_at,
      expires_at=excluded.expires_at,level=excluded.level,max_hp=excluded.max_hp,
      current_hp=excluded.current_hp,encounter_started_at=0,retry_ready_at=0,
      token_count=0,completed_at=0,attack_order_json='[]'
      WHERE epic_boss_runs_v3.completed_at != 0 OR epic_boss_runs_v3.expires_at <= ?`)
      .bind(accountId, activationId, def.id, now, expiresAt, 1, hp, hp, now),
    db.prepare(`UPDATE balances SET brains = brains - ? WHERE account_id = ? AND brains >= ?
      AND EXISTS(SELECT 1 FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?)`)
      .bind(def.costBrains, accountId, def.costBrains, accountId, activationId),
  ]);
  if ((statements[0]?.meta.changes ?? 0) !== 1 || (statements[1]?.meta.changes ?? 0) !== 1) {
    return { status: 409, body: { error: "activation_conflict" } };
  }
  return { status: 200, body: {
    event: await readRun(db, accountId),
    balance: { ...balance, brains: balance.brains - def.costBrains },
  } };
}

export async function end(
  db: D1Database, accountId: string, runId: unknown, now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof runId !== "string" || !runId) return { status: 400, body: { error: "bad_request" } };
  const run = await db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=?")
    .bind(accountId).first<RunRow>();
  if (!run || run.run_id !== runId) return { status: 409, body: { error: "inactive" } };
  // Repeating a successfully-ended request is harmless and returns the same run.
  if (run.completed_at || run.expires_at <= now) {
    return { status: 200, body: { event: projectRun(run) } };
  }
  await db.batch([
    db.prepare(`UPDATE epic_boss_sessions_v3 SET finished_at=?
      WHERE account_id=? AND run_id=? AND finished_at IS NULL`).bind(now, accountId, runId),
    db.prepare(`UPDATE roster_v3 SET locked_by_raid=NULL WHERE account_id=? AND locked_by_raid IN
      (SELECT id FROM epic_boss_sessions_v3 WHERE account_id=? AND run_id=?)`)
      .bind(accountId, accountId, runId),
    db.prepare(`UPDATE epic_boss_runs_v3 SET expires_at=?,encounter_started_at=0,
      retry_ready_at=0,token_count=0,attack_order_json='[]' WHERE account_id=? AND run_id=?
      AND completed_at=0 AND expires_at>?`).bind(now, accountId, runId, now),
  ]);
  return { status: 200, body: { event: await readRun(db, accountId) } };
}

export async function expireLiveEpicBoss(db: D1Database, accountId: string, now: number): Promise<void> {
  const live = await db.prepare(`SELECT s.id,s.run_id,r.boss_id FROM epic_boss_sessions_v3 s
    JOIN epic_boss_runs_v3 r ON r.account_id=s.account_id AND r.run_id=s.run_id
    WHERE s.account_id=? AND s.finished_at IS NULL AND s.expires_at <= ?`).bind(accountId, now)
    .first<{ id: string; run_id: string; boss_id: string }>();
  if (!live) return;
  await db.batch([
    db.prepare("UPDATE epic_boss_sessions_v3 SET finished_at=? WHERE id=? AND finished_at IS NULL").bind(now, live.id),
    db.prepare("UPDATE epic_boss_runs_v3 SET retry_ready_at=0 WHERE account_id=? AND run_id=? AND completed_at=0")
      .bind(accountId, live.run_id),
    db.prepare("UPDATE roster_v3 SET locked_by_raid=NULL WHERE account_id=? AND locked_by_raid=?").bind(accountId, live.id),
  ]);
}

export async function start(
  db: D1Database, accountId: string, orderedUnitIds: unknown, payment: unknown, now: number
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
    db.prepare("SELECT gold,brains,xp FROM balances WHERE account_id=?").bind(accountId).first<{gold:number;brains:number;xp:number}>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").bind(accountId).first<{current_json:string}>(),
    db.prepare("SELECT progress_json FROM raid_state_v3 WHERE account_id=?").bind(accountId).first<{progress_json:string}>(),
  ]);
  if (!row || row.completed_at || row.expires_at <= now) return { status: 409, body: { error: "inactive" } };
  const def = defFor(row.boss_id);
  if (!def) return { status: 409, body: { error: "unknown_boss" } };
  if (epic) {
    const pinned = parse<string[]>(epic.roster_json, []);
    if (pinned.length === ids.length && pinned.every((id, index) => id === ids[index])) {
      return { status: 200, body: { ok: true, resumed: true, sessionId: epic.id,
        event: projectRun(row), balance, expiresAt: epic.expires_at } };
    }
    return { status: 409, body: { error: "battle_in_progress" } };
  }
  if (raid) return { status: 409, body: { error: "battle_in_progress" } };
  if ((roster.results ?? []).length !== ids.length) return { status: 409, body: { error: "bad_roster" } };
  if (row.encounter_started_at && now >= row.encounter_started_at + def.encounterMs) {
    row.max_hp = epicBossHp(def, row.level); row.current_hp = row.max_hp;
    row.encounter_started_at = 0; row.retry_ready_at = 0;
  }
  if (payment !== "token" && payment !== "brains") return { status: 400, body: { error: "bad_payment" } };
  if (payment === "token" && row.token_count < 1) return { status: 409, body: { error: "insufficient_tokens" } };
  if (payment === "brains" && balance && balance.brains < EPIC_BOSS_FIGHT_BRAIN_COST) {
    return { status: 409, body: { error: "insufficient_brains", balance } };
  }
  const sessionId = crypto.randomUUID();
  const encounterStartedAt = row.encounter_started_at || now;
  const expiresAt = Math.min(row.expires_at + def.fightMs, now + 2 * 60_000);
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
    id:`epic:${row.run_id}:${row.level}`,sourceKey:`EpicBoss:${def.id}`,team:"enemy",name:def.name,
    str:def.unitStats.str,dex:def.unitStats.dex,con:def.unitStats.con,focus:0,hp:row.current_hp,maxHp:row.max_hp,
    attackCooldownMs:deriveAttackIntervalMs(def.unitStats.dex,"enemy")*2,
    attacks:def.unitStats.attacks.map((attack) => ({...attack,mult:attack.mult ?? 1})),isBoss:true,alive:true,isGarden:false,isHeadless:false,
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
  if (payment === "token") {
    statements.push(db.prepare(`UPDATE epic_boss_runs_v3 SET token_count=token_count-1
      WHERE account_id=? AND run_id=? AND token_count>0`).bind(accountId, row.run_id));
  } else {
    statements.push(db.prepare("UPDATE balances SET brains=brains-? WHERE account_id=? AND brains>=?")
      .bind(EPIC_BOSS_FIGHT_BRAIN_COST, accountId, EPIC_BOSS_FIGHT_BRAIN_COST));
  }
  ids.forEach((id) => statements.push(db.prepare(`UPDATE roster_v3 SET locked_by_raid=?
    WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL`).bind(sessionId, accountId, id)));
  await db.batch(statements);
  if (payment === "token") row.token_count--;
  else balance.brains -= EPIC_BOSS_FIGHT_BRAIN_COST;
  return { status: 200, body: { ok: true, sessionId, event: {
    ...projectRun(row)!, encounterStartedAt, retryReadyAt: 0, attackOrder: ids,
  }, balance, expiresAt } };
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
  const pinnedRun = await db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?")
    .bind(accountId, session.run_id).first<RunRow>();
  const def = pinnedRun ? defFor(pinnedRun.boss_id) : null;
  if (!def) return { status: 409, body: { error: "unknown_boss" } };
  const locked = parse<string[]>(session.roster_json, []);
  const pacedTick = Math.floor((now - session.started_at) / 50) + 40;
  if (Number(body.finalTick) > pacedTick) return { status: 422, body: { error: "future_finish" } };
  const config = parse<EpicCombatConfig | null>(session.config_json, null);
  if (!config || !Number.isInteger(body.finalTick) || !Array.isArray(body.inputs)) return { status: 400, body: { error: "bad_replay" } };
  const verified = replayRaid(new BattleSim(
    config.playerUnits, config.enemyUnits, null, false, [], null, def.fightMs,
    null, null, true, true, true, 150
  ), body.finalTick as number, body.inputs as RaidReplayInput[]);
  if (!verified.ok) return { status: 422, body: { error: verified.error } };
  const { survivors, losses } = verified.outcome;
  const lockedSet = new Set(locked);
  const accounted = new Set([...survivors, ...losses]);
  if ([...accounted].some((id) => !lockedSet.has(id)) ||
      (!verified.retreated && accounted.size !== locked.length)) {
    return { status: 422, body: { error: "replay_roster_mismatch" } };
  }
  // Retreating zombies survive but earn no veterancy, so the replay intentionally
  // omits them from survivors. Keep them separate so their server locks still clear.
  const escapedRoster = verified.retreated
    ? locked.filter((id) => !losses.includes(id) && !survivors.includes(id)) : [];
  const [run, balance, coreRow, questRow, objectRow, rosterCounts] = await Promise.all([
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?").bind(accountId, session.run_id).first<RunRow>(),
    db.prepare("SELECT gold,brains,xp,claimed_level FROM balances WHERE account_id=?").bind(accountId).first<{gold:number;brains:number;xp:number;claimed_level:number}>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").bind(accountId).first<{current_json:string}>(),
    db.prepare("SELECT version,current_json FROM quest_documents_v3 WHERE account_id=?").bind(accountId).first<{version:number;current_json:string}>(),
    db.prepare("SELECT current_json FROM object_documents_v3 WHERE account_id=?").bind(accountId).first<{current_json:string}>(),
    db.prepare(`SELECT stored,COUNT(*) AS count FROM roster_v3 WHERE account_id=? GROUP BY stored`)
      .bind(accountId).all<{stored:number;count:number}>(),
  ]);
  if (!run || !balance || !coreRow || !questRow || !objectRow || run.level !== session.level) return { status: 409, body: { error: "stale_session" } };
  const damage = Math.max(0, Math.min(session.starting_hp, Math.round(verified.outcome.playerDamage)));
  const defeated = verified.outcome.win && damage >= session.starting_hp;
  const defeatedLevel = defeated ? run.level : null;
  if (defeatedLevel !== null) {
    const currency = epicBossCurrencyReward(defeatedLevel);
    balance.brains += currency.brains;
    balance.gold += currency.gold;
  }
  if (defeated) {
    if (run.level >= def.maxLevel) { run.current_hp = 0; run.completed_at = now; run.token_count = 0; }
    else { run.level++; run.max_hp = epicBossHp(def, run.level); run.current_hp = run.max_hp; }
    run.encounter_started_at = 0; run.retry_ready_at = 0;
  } else {
    run.current_hp = Math.max(1, session.starting_hp - damage);
    run.retry_ready_at = 0;
  }
  const core = parse<CoreState>(coreRow.current_json, { inventory: {}, storage: { received: {}, stored: {} }, ownedPets: [], zombieMax: 16 });
  const questData = parse<{completed:string[];progress:QuestProjection["progress"]}>(questRow.current_json, { completed: [], progress: [] });
  const quests: QuestProjection = { version: questRow.version, ...questData };
  const beforeCompleted = new Set(quests.completed);
  let loot: { name: string; tile?: string; stageActor?: string; sprite: string } | null = null;
  if (defeatedLevel !== null && random() < 0.35) {
    let eligible = def.loot.filter((x) => x.level <= defeatedLevel && (!x.stageActor || !core.ownedPets.includes(x.stageActor)));
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
  const questChanges = applyQuestEvents(balance, quests, events, { includeEpic: true, epicQuestIds: new Set(def.questIds) });
  const newlyCompleted = quests.completed.filter((id) => !beforeCompleted.has(id));
  const objects = parse<Array<{catalogKey:string;status:string}>>(objectRow.current_json, []);
  const armyCapacity = core.zombieMax + objects.reduce((total, object) =>
    total + (object.status === "placed" ? objectArmyCapacity.get(object.catalogKey) ?? 0 : 0), 0);
  // Casualties are still present in roster_v3 until this transaction commits, so
  // remove them when deciding whether a reward lands on the farm or in storage.
  let activeCount = Math.max(0,
    (rosterCounts.results.find((row) => !row.stored)?.count ?? 0) - losses.length
  );
  const newZombies: { id: string; key: string; stored: boolean }[] = [];
  for (const id of newlyCompleted) {
    const reward = questDefinition(id);
    if (!reward) continue;
    if (reward.rewardType === QUEST_REWARD.Item && reward.rewardItemKey === "Invasion Voucher") core.inventory[VOUCHER_KEY] = (core.inventory[VOUCHER_KEY] ?? 0) + 1;
    if (reward.rewardType === QUEST_REWARD.Item && reward.rewardItemKey === "Golden Dice") core.inventory[DICE_KEY] = (core.inventory[DICE_KEY] ?? 0) + 1;
    const key = epicQuestZombieReward(id);
    if (key) {
      const stored = shouldStoreEpicReward(activeCount, armyCapacity);
      newZombies.push({ id: crypto.randomUUID(), key, stored });
      if (!stored) activeCount++;
    }
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
      retry_ready_at=?,token_count=?,completed_at=? WHERE account_id=? AND run_id=? AND ${guard}`)
      .bind(run.level,run.max_hp,run.current_hp,run.encounter_started_at,run.retry_ready_at,run.token_count,run.completed_at,accountId,run.run_id,session.id,resultJson),
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
  escapedRoster.forEach((id) => statements.push(db.prepare(`UPDATE roster_v3 SET locked_by_raid=NULL
    WHERE account_id=? AND unit_id=? AND locked_by_raid=? AND ${guard}`).bind(accountId,id,session.id,session.id,resultJson)));
  newZombies.forEach((z) => statements.push(db.prepare(`INSERT INTO roster_v3(account_id,unit_id,zombie_key,stored,created_at)
    SELECT ?,?,?,?,? WHERE ${guard}`).bind(accountId,z.id,z.key,z.stored ? 1 : 0,now,session.id,resultJson)));
  await db.batch(statements);
  return { status: 200, body: result };
}
