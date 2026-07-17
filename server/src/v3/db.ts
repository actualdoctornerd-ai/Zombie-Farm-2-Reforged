import type {
  BootstrapResponse,
  CommandBatchRequest,
  CommandBatchResponse,
  GameplayProjection,
  PresentationProjection,
  ResumableRaidProjection,
} from "../../../src/net/protocol";
import { GAMEPLAY_PROTOCOL } from "../../../src/net/protocol";
import * as legacyDb from "../db";
import { applyCommandBatch, freshGameplayState, zombieDefaultMutation } from "./engine";
import { levelForXp } from "../levels";
import { projectRun } from "./epicBoss";

interface RuntimeRow {
  account_version: number;
  writer_device_id: string | null;
  writer_generation: number;
  active_batch_id: string | null;
  last_batch_id: string | null;
  last_first_sequence: number | null;
  last_result_json: string | null;
  command_window_start: number;
  command_window_count: number;
}

interface DocumentRow {
  version: number;
  current_json: string;
  previous_version?: number | null;
  previous_json?: string | null;
}

interface CoreRow { current_json: string }
interface BalanceRow { gold: number; brains: number; xp: number }
interface PresentationRow { version: number; current_json: string }
interface RosterRow {
  unit_id: string;
  zombie_key: string;
  mutation: number;
  invasions: number;
  stored: number;
  locked_by_raid: string | null;
}
interface RaidRow {
  id: string;
  raid_id: string;
  roster_json: string;
  started_at: number;
  earliest_finish_at: number;
  expires_at: number;
}
interface RaidStateRow { last_started_at: number; progress_json: string }
interface EpicRunRow {
  run_id: string; boss_id: string; activated_at: number; expires_at: number; level: number;
  max_hp: number; current_hp: number; encounter_started_at: number; retry_ready_at: number;
  token_count: number; completed_at: number; attack_order_json: string;
}

export type BatchFailure =
  | { status: 400 | 409 | 423 | 429; error: string; body?: Record<string, unknown> }
  | { status: 200; response: CommandBatchResponse };

const parse = <T>(json: string | null | undefined, fallback: T): T => {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
};

const coreFrom = (state: GameplayProjection) => ({
  inventory: state.inventory,
  storage: state.storage,
  farmSize: state.farmSize,
  climates: state.climates,
  farmerHeads: state.farmerHeads,
  farmerHeadId: state.farmerHeadId,
  ownedPets: state.ownedPets,
  activePet: state.activePet,
  penPets: state.penPets,
  zombieMax: state.zombieMax,
  tutorialRewarded: state.tutorialRewarded,
});

async function ensureV3(db: D1Database, accountId: string, now: number): Promise<void> {
  const fresh = freshGameplayState();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO account_runtime_v3
      (account_id, updated_at) VALUES (?, ?)`).bind(accountId, now),
    db.prepare(`INSERT OR IGNORE INTO balances
      (account_id, gold, brains, xp, claimed_level) VALUES (?, ?, ?, ?, 1)`)
      .bind(accountId, fresh.balance.gold, fresh.balance.brains, fresh.balance.xp),
    db.prepare(`INSERT OR IGNORE INTO farm_documents_v3
      (account_id, current_json, updated_at) VALUES (?, ?, ?)`)
      .bind(accountId, JSON.stringify(fresh.farm.plots), now),
    db.prepare(`INSERT OR IGNORE INTO object_documents_v3
      (account_id, current_json, updated_at) VALUES (?, ?, ?)`)
      .bind(accountId, JSON.stringify(fresh.objects.objects), now),
    db.prepare(`INSERT OR IGNORE INTO quest_documents_v3
      (account_id, current_json, updated_at) VALUES (?, ?, ?)`)
      .bind(accountId, JSON.stringify({ completed: [], progress: [] }), now),
    db.prepare(`INSERT OR IGNORE INTO gameplay_documents_v3
      (account_id, current_json, updated_at) VALUES (?, ?, ?)`)
      .bind(accountId, JSON.stringify(coreFrom(fresh)), now),
    db.prepare(`INSERT OR IGNORE INTO presentations_v3
      (account_id, current_json, updated_at) VALUES (?, '{}', ?)`)
      .bind(accountId, now),
    db.prepare(`INSERT OR IGNORE INTO raid_state_v3(account_id) VALUES (?)`).bind(accountId),
  ]);
}

async function loadRows(db: D1Database, accountId: string, now: number) {
  await ensureV3(db, accountId, now);
  const [runtime, balance, farm, objects, quests, core, presentation, roster, raid, raidState, raidRevival, epicBoss] = await Promise.all([
    db.prepare("SELECT * FROM account_runtime_v3 WHERE account_id = ?").bind(accountId).first<RuntimeRow>(),
    db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?").bind(accountId).first<BalanceRow>(),
    db.prepare("SELECT * FROM farm_documents_v3 WHERE account_id = ?").bind(accountId).first<DocumentRow>(),
    db.prepare("SELECT * FROM object_documents_v3 WHERE account_id = ?").bind(accountId).first<DocumentRow>(),
    db.prepare("SELECT * FROM quest_documents_v3 WHERE account_id = ?").bind(accountId).first<DocumentRow>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?").bind(accountId).first<CoreRow>(),
    db.prepare("SELECT version, current_json FROM presentations_v3 WHERE account_id = ?").bind(accountId).first<PresentationRow>(),
    db.prepare(`SELECT unit_id, zombie_key, mutation, invasions, stored, locked_by_raid
      FROM roster_v3 WHERE account_id = ? ORDER BY created_at, unit_id`).bind(accountId).all<RosterRow>(),
    db.prepare(`SELECT id, raid_id, roster_json, started_at, earliest_finish_at, expires_at
      FROM raid_sessions_v3 WHERE account_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`)
      .bind(accountId).first<RaidRow>(),
    db.prepare("SELECT last_started_at, progress_json FROM raid_state_v3 WHERE account_id = ?")
      .bind(accountId).first<RaidStateRow>(),
    db.prepare(`SELECT session_id, casualties_json FROM raid_revivals_v3
      WHERE account_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .bind(accountId).first<{ session_id: string; casualties_json: string }>(),
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id = ?")
      .bind(accountId).first<EpicRunRow>(),
  ]);
  if (!runtime || !balance || !farm || !objects || !quests || !core || !presentation || !raidState) throw new Error("v3_state_init_failed");
  return { runtime, balance, farm, objects, quests, core, presentation, roster: roster.results ?? [], raid, raidState, raidRevival, epicBoss };
}

function project(rows: Awaited<ReturnType<typeof loadRows>>): GameplayProjection {
  const base = freshGameplayState();
  const core = parse<ReturnType<typeof coreFrom>>(rows.core.current_json, coreFrom(base));
  return {
    balance: { ...rows.balance },
    farm: { version: rows.farm.version, plots: parse(rows.farm.current_json, {}) },
    objects: { version: rows.objects.version, objects: parse(rows.objects.current_json, []) },
    quests: { version: rows.quests.version, ...parse(rows.quests.current_json, { completed: [], progress: [] }) },
    inventory: core.inventory ?? {},
    storage: core.storage ?? { received: {}, stored: {} },
    farmSize: core.farmSize ?? 30,
    climates: core.climates ?? ["grass"],
    farmerHeads: core.farmerHeads ?? base.farmerHeads,
    farmerHeadId: core.farmerHeadId ?? base.farmerHeadId,
    ownedPets: core.ownedPets ?? [],
    activePet: core.activePet ?? null,
    penPets: core.penPets ?? [],
    zombieMax: core.zombieMax ?? 16,
    tutorialRewarded: core.tutorialRewarded ?? false,
    roster: rows.roster.map((u) => ({
      id: u.unit_id,
      key: u.zombie_key,
      // Older v3 harvests persisted every new zombie with mutation 0. Market-mutant
      // species have a guaranteed catalog bit, so repair those legacy rows in the
      // authoritative projection. Explicit inherited masks remain untouched.
      mutation: u.mutation || zombieDefaultMutation(u.zombie_key),
      invasions: u.invasions,
      stored: !!u.stored,
      ...(u.locked_by_raid ? { lockedByRaid: u.locked_by_raid } : {}),
    })),
    raids: { progress: parse(rows.raidState.progress_json, {}), lastRaidAt: rows.raidState.last_started_at },
    raidRevival: rows.raidRevival ? {
      sessionId: rows.raidRevival.session_id,
      zombies: parse(rows.raidRevival.casualties_json, []),
      costPerZombie: 1,
    } : null,
    epicBoss: projectRun(rows.epicBoss),
  };
}

function resumable(row: RaidRow | null): ResumableRaidProjection | null {
  if (!row) return null;
  return {
    sessionId: row.id,
    raidId: row.raid_id,
    startedAt: row.started_at,
    earliestFinishAt: row.earliest_finish_at,
    expiresAt: row.expires_at,
    rosterIds: parse<string[]>(row.roster_json, []),
  };
}

export async function bootstrap(
  db: D1Database,
  accountId: string,
  now: number,
  mutationsEnabled: boolean,
  minimumProtocolVersion: number
): Promise<BootstrapResponse> {
  const rows = await loadRows(db, accountId, now);
  const [friends, incomingRequestCount, inboxCount] = await Promise.all([
    legacyDb.listFriends(db, accountId),
    legacyDb.countIncomingRequests(db, accountId),
    legacyDb.countUnclaimedTo(db, accountId),
  ]);
  return {
    protocolVersion: GAMEPLAY_PROTOCOL,
    serverTime: now,
    minimumProtocolVersion,
    mutationsEnabled,
    accountVersion: rows.runtime.account_version,
    writerGeneration: rows.runtime.writer_generation,
    writerDeviceId: rows.runtime.writer_device_id,
    gameplay: project(rows),
    presentation: {
      version: rows.presentation.version,
      data: parse(rows.presentation.current_json, {}),
    },
    social: {
      friends: friends.map((f) => ({ accountId: f.id, name: f.username ?? "Player", friendCode: f.friend_code })),
      incomingRequestCount,
      inboxCount,
    },
    resumableRaid: resumable(rows.raid),
  };
}

export async function applyBatch(
  db: D1Database,
  accountId: string,
  body: CommandBatchRequest,
  now: number
): Promise<BatchFailure> {
  const rows = await loadRows(db, accountId, now);
  const runtime = rows.runtime;
  if (runtime.last_batch_id === body.batchId && runtime.last_result_json) {
    return { status: 200, response: parse<CommandBatchResponse>(runtime.last_result_json, null as never) };
  }
  if (runtime.active_batch_id) return { status: 409, error: "batch_in_progress" };
  if (body.expectedAccountVersion !== runtime.account_version) {
    return { status: 409, error: "state_conflict", body: { accountVersion: runtime.account_version, writerGeneration: runtime.writer_generation } };
  }
  if (runtime.writer_device_id && runtime.writer_device_id !== body.deviceId) {
    if (!body.takeWriter) return { status: 423, error: "writer_replaced", body: { writerGeneration: runtime.writer_generation } };
    const takeover = await db.prepare(`UPDATE account_runtime_v3
      SET writer_device_id = ?, writer_generation = writer_generation + 1,
          account_version = account_version + 1, updated_at = ?
      WHERE account_id = ? AND account_version = ? AND writer_device_id = ?`)
      .bind(body.deviceId, now, accountId, runtime.account_version, runtime.writer_device_id).run();
    if ((takeover.meta.changes ?? 0) !== 1) return { status: 409, error: "state_conflict" };
    return {
      status: 409,
      error: "writer_taken",
      body: { accountVersion: runtime.account_version + 1, writerGeneration: runtime.writer_generation + 1 },
    };
  }
  if (runtime.writer_device_id === body.deviceId && body.writerGeneration !== runtime.writer_generation) {
    return { status: 423, error: "writer_replaced", body: { writerGeneration: runtime.writer_generation } };
  }
  const lastSequence = body.firstSequence + body.commands.length - 1;
  // Sequence numbers belong to a device-local outbox and may restart when a
  // different device takes writer ownership (or local storage is rebuilt).
  // Account versioning serializes batches, while batchId provides idempotency;
  // comparing sequences across writers would permanently reject a valid retry.
  const farmCommands = body.commands.length;
  const windowStart = now - runtime.command_window_start >= 60_000 ? now : runtime.command_window_start;
  const windowCount = now - runtime.command_window_start >= 60_000 ? farmCommands : runtime.command_window_count + farmCommands;
  if (windowCount > 120) return { status: 429, error: "command_rate_limited", body: { retryAfterMs: Math.max(1, windowStart + 60_000 - now) } };

  const before = project(rows);
  const engine = applyCommandBatch(before, body.commands, { now });
  if (engine.farmChanged) engine.state.farm.version++;
  if (engine.objectChanged) engine.state.objects.version++;
  if (engine.questChanged) engine.state.quests.version++;
  const accountVersion = runtime.account_version + 1;
  const response: CommandBatchResponse = {
    protocolVersion: GAMEPLAY_PROTOCOL,
    batchId: body.batchId,
    accountVersion,
    writerGeneration: runtime.writer_device_id ? runtime.writer_generation : runtime.writer_generation + 1,
    serverTime: now,
    results: engine.results,
    gameplay: engine.state,
    farmVersionBefore: before.farm.version,
    farmVersionAfter: engine.state.farm.version,
    netDelta: {
      gold: engine.state.balance.gold - before.balance.gold,
      brains: engine.state.balance.brains - before.balance.brains,
      xp: engine.state.balance.xp - before.balance.xp,
    },
    questChanges: engine.questChanges,
    createdZombieIds: engine.createdZombieIds,
  };
  const resultJson = JSON.stringify(response);
  const guard = `EXISTS (SELECT 1 FROM account_runtime_v3 r
    WHERE r.account_id = ? AND r.active_batch_id = ?)`;
  const statements: D1PreparedStatement[] = [];
  statements.push(db.prepare(`UPDATE account_runtime_v3 SET
      active_batch_id = ?, account_version = account_version + 1,
      writer_device_id = COALESCE(writer_device_id, ?),
      writer_generation = CASE WHEN writer_device_id IS NULL THEN writer_generation + 1 ELSE writer_generation END,
      command_window_start = ?, command_window_count = ?, updated_at = ?
    WHERE account_id = ? AND account_version = ? AND active_batch_id IS NULL
      AND (writer_device_id IS NULL OR writer_device_id = ?)`)
    .bind(body.batchId, body.deviceId, windowStart, windowCount, now, accountId, runtime.account_version, body.deviceId));
  statements.push(db.prepare(`UPDATE balances SET gold = ?, brains = ?, xp = ?, claimed_level = ?
    WHERE account_id = ? AND ${guard}`)
    .bind(engine.state.balance.gold, engine.state.balance.brains, engine.state.balance.xp,
      levelForXp(engine.state.balance.xp), accountId, accountId, body.batchId));
  statements.push(db.prepare(`UPDATE gameplay_documents_v3 SET current_json = ?, updated_at = ?
    WHERE account_id = ? AND ${guard}`)
    .bind(JSON.stringify(coreFrom(engine.state)), now, accountId, accountId, body.batchId));
  if (engine.farmChanged) statements.push(db.prepare(`UPDATE farm_documents_v3 SET
      previous_version = version, previous_json = current_json, version = version + 1,
      current_json = ?, updated_at = ? WHERE account_id = ? AND ${guard}`)
    .bind(JSON.stringify(engine.state.farm.plots), now, accountId, accountId, body.batchId));
  if (engine.objectChanged) statements.push(db.prepare(`UPDATE object_documents_v3 SET
      version = version + 1, current_json = ?, updated_at = ? WHERE account_id = ? AND ${guard}`)
    .bind(JSON.stringify(engine.state.objects.objects), now, accountId, accountId, body.batchId));
  if (engine.questChanged) statements.push(db.prepare(`UPDATE quest_documents_v3 SET
      version = version + 1, current_json = ?, updated_at = ? WHERE account_id = ? AND ${guard}`)
    .bind(JSON.stringify({ completed: engine.state.quests.completed, progress: engine.state.quests.progress }), now, accountId, accountId, body.batchId));
  if (before.epicBoss && engine.state.epicBoss && before.epicBoss.runId === engine.state.epicBoss.runId &&
      before.epicBoss.tokenCount !== engine.state.epicBoss.tokenCount) {
    statements.push(db.prepare(`UPDATE epic_boss_runs_v3 SET token_count=?
      WHERE account_id=? AND run_id=? AND ${guard}`)
      .bind(engine.state.epicBoss.tokenCount, accountId, engine.state.epicBoss.runId, accountId, body.batchId));
  }

  const oldRoster = new Map(before.roster.map((u) => [u.id, u]));
  const newRoster = new Map(engine.state.roster.map((u) => [u.id, u]));
  for (const id of oldRoster.keys()) {
    if (newRoster.has(id)) continue;
    statements.push(db.prepare(`DELETE FROM roster_v3 WHERE account_id = ? AND unit_id = ? AND ${guard}`)
      .bind(accountId, id, accountId, body.batchId));
  }
  for (const unit of newRoster.values()) {
    const old = oldRoster.get(unit.id);
    if (old && JSON.stringify(old) === JSON.stringify(unit)) continue;
    statements.push(db.prepare(`INSERT INTO roster_v3
      (account_id, unit_id, zombie_key, mutation, invasions, stored, locked_by_raid, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
      ON CONFLICT(account_id, unit_id) DO UPDATE SET zombie_key=excluded.zombie_key,
        mutation=excluded.mutation, invasions=excluded.invasions, stored=excluded.stored,
        locked_by_raid=excluded.locked_by_raid`)
      .bind(accountId, unit.id, unit.key, unit.mutation, unit.invasions, unit.stored ? 1 : 0,
        unit.lockedByRaid ?? null, now, accountId, body.batchId));
  }
  const durableKinds = new Set(["power.buy", "object.buy", "object.refund", "object.upgrade", "roster.sell", "roster.combine", "farmer.buy", "pet.buy"]);
  body.commands.forEach((entry, index) => {
    const result = engine.results[index];
    if (result?.status !== "applied" || !durableKinds.has(entry.command.type)) return;
    statements.push(db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(`${body.batchId}:${entry.sequence}`, accountId, entry.command.type,
        JSON.stringify({ command: entry.command, createdIds: result.createdIds ?? [] }), now,
        accountId, body.batchId));
  });
  if (engine.createdZombieIds.length) {
    statements.push(db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, 'zombie_created', ?, ? WHERE ${guard}`)
      .bind(`${body.batchId}:zombies`, accountId, JSON.stringify({ ids: engine.createdZombieIds }), now,
        accountId, body.batchId));
  }
  statements.push(db.prepare(`UPDATE account_runtime_v3 SET active_batch_id = NULL,
      last_batch_id = ?, last_first_sequence = ?, last_result_json = ?, updated_at = ?
    WHERE account_id = ? AND active_batch_id = ?`)
    .bind(body.batchId, lastSequence, resultJson, now, accountId, body.batchId));

  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) return { status: 409, error: "state_conflict" };
  return { status: 200, response };
}

export async function writePresentation(
  db: D1Database,
  accountId: string,
  expectedVersion: number,
  data: Record<string, unknown>,
  now: number
): Promise<PresentationProjection | null> {
  await ensureV3(db, accountId, now);
  const result = await db.prepare(`UPDATE presentations_v3 SET version = version + 1,
    current_json = ?, updated_at = ? WHERE account_id = ? AND version = ?`)
    .bind(JSON.stringify(data), now, accountId, expectedVersion).run();
  return (result.meta.changes ?? 0) === 1 ? { version: expectedVersion + 1, data } : null;
}
