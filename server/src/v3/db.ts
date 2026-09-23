import type {
  BootstrapResponse,
  CommandBatchRequest,
  CommandBatchResponse,
  GameplayProjection,
  PresentationProjection,
  ResumableRaidProjection,
} from "../../../src/net/protocol";
import { GAMEPLAY_PROTOCOL } from "../../../src/net/protocol";
import type { WriterProjection } from "./writer";
import * as legacyDb from "../db";
import {
  applyCommandBatch, freshGameplayState, zombieDefaultMutation,
  MEMORIAL_GRAVEYARD_CAP, MAX_FUNCTIONAL_OBJECTS,
} from "./engine";
import { XP_THRESHOLDS, levelForXp } from "../levels";
import { projectRun } from "./epicBoss";
import { RAID_RULESET_VERSION } from "../raidVerifier";
import { parseRosterColor, serializeRosterColor } from "./rosterColor";
import { refreshPeriodicState, xpToNextLevel } from "../../../src/quest/periodic/generate";
import type { PeriodicQuestState } from "../../../src/quest/periodic/types";

interface RuntimeRow {
  account_version: number;
  writer_device_id: string | null;
  writer_generation: number;
  writer_last_activity_at: number;
  active_batch_expires_at: number;
  active_batch_id: string | null;
  last_batch_id: string | null;
  last_first_sequence: number | null;
  command_window_start: number;
  command_window_count: number;
}

interface DocumentRow {
  version: number;
  current_json: string;
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
  from_escrow: number;
  /** JSON "[r,g,b]" inherited body tint, or NULL for the catalog colour. */
  color: string | null;
}
/** One row of the graveyard (see migration 0047). */
interface FallenRow {
  unit_id: string;
  zombie_key: string;
  name: string | null;
  mutation: number;
  invasions: number;
  color: string | null;
  died_at: number;
  /** When it last came off a statue; NULL if it never has (see migration 0048). */
  released_at: number | null;
  memorial_object_id: string | null;
}
interface RaidRow {
  id: string;
  raid_id: string;
  roster_json: string;
  started_at: number;
  earliest_finish_at: number;
  expires_at: number;
}
interface RaidStateRow { last_started_at: number; progress_json: string; tier_json: string }
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
  farmerBonusHeadId: state.farmerBonusHeadId ?? null,
  ownedPets: state.ownedPets,
  activePet: state.activePet,
  penPets: state.penPets,
  zombieMax: state.zombieMax,
  zombiePotBought: state.zombiePotBought,
  tutorialRewarded: state.tutorialRewarded,
  // Which parent is in slot 1 of each running Pot. It has to outlive the request that
  // started the combine — the collect arrives an hour later — and it deliberately lives
  // HERE rather than in the roster's reservation marker: the marker is projected to
  // clients, and an older bundle parses its pot id straight out of that string, so
  // decorating it would make those clients read one job as two and retire it.
  potSlots: state.potSlots,
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
    db.prepare(`INSERT OR IGNORE INTO periodic_quest_documents_v3
      (account_id, current_json, updated_at) VALUES (?, ?, ?)`)
      .bind(accountId, JSON.stringify({ daily: null, weekly: null }), now),
    db.prepare(`INSERT OR IGNORE INTO gameplay_documents_v3
      (account_id, current_json, updated_at) VALUES (?, ?, ?)`)
      .bind(accountId, JSON.stringify(coreFrom(fresh)), now),
    db.prepare(`INSERT OR IGNORE INTO presentations_v3
      (account_id, current_json, updated_at) VALUES (?, '{}', ?)`)
      .bind(accountId, now),
    db.prepare(`INSERT OR IGNORE INTO raid_state_v3(account_id) VALUES (?)`).bind(accountId),
  ]);
}

/** Every row a projection is built from, fanned out in one round of reads.
 *
 *  Columns are named rather than `SELECT *`, and that is the whole point rather than a
 *  style preference. These tables carry the player's save as JSON, so a `*` bills every
 *  read for whatever the widest column happens to hold — and two of them are dead weight
 *  on this path:
 *
 *    account_runtime_v3.last_result_json   avg 9.4 KB, max 67 KB in production
 *    farm_documents_v3.previous_json       avg 3.9 KB, max 38 KB in production
 *
 *  Neither is read here. `last_result_json` has exactly one consumer — the idempotent
 *  replay in applyBatch, which now fetches it only when the batch ids actually match —
 *  and `previous_json` is written by the farm document update and read by nothing at all,
 *  anywhere in the repo. Together they were roughly 13 KB per request of pure carry.
 *
 *  This is also why cost per request GREW through the beta rather than staying flat: both
 *  columns are copies of the player's own save, so every request got more expensive as the
 *  farm it belonged to got bigger. A `SELECT *` on a save table is a per-request cost that
 *  scales with how much the player has played. */
async function readAll(db: D1Database, accountId: string) {
  const [runtime, balance, farm, objects, quests, periodic, core, presentation, roster, fallen, raid, raidState, raidRevival, epicBoss] = await Promise.all([
    db.prepare(`SELECT account_version, writer_device_id, writer_generation, writer_last_activity_at,
        active_batch_expires_at, active_batch_id, last_batch_id, last_first_sequence,
        command_window_start, command_window_count
      FROM account_runtime_v3 WHERE account_id = ?`).bind(accountId).first<RuntimeRow>(),
    db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?").bind(accountId).first<BalanceRow>(),
    db.prepare("SELECT version, current_json FROM farm_documents_v3 WHERE account_id = ?").bind(accountId).first<DocumentRow>(),
    db.prepare("SELECT version, current_json FROM object_documents_v3 WHERE account_id = ?").bind(accountId).first<DocumentRow>(),
    db.prepare("SELECT version, current_json FROM quest_documents_v3 WHERE account_id = ?").bind(accountId).first<DocumentRow>(),
    db.prepare("SELECT version, current_json FROM periodic_quest_documents_v3 WHERE account_id = ?").bind(accountId).first<DocumentRow>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?").bind(accountId).first<CoreRow>(),
    db.prepare("SELECT version, current_json FROM presentations_v3 WHERE account_id = ?").bind(accountId).first<PresentationRow>(),
    db.prepare(`SELECT unit_id, zombie_key, mutation, invasions, stored, locked_by_raid, from_escrow, color
      FROM roster_v3 WHERE account_id = ? ORDER BY created_at, unit_id`).bind(accountId).all<RosterRow>(),
    // Newest first, and capped: the graveyard is a memento list, and MEMORIAL_GRAVEYARD_CAP
    // is what stops a long-lived farm carrying an unbounded list of its dead into
    // every bootstrap. Enshrined zombies are pinned ahead of the cap below.
    //
    // "Newest" is COALESCE(released_at, died_at) — a zombie taken back off a statue
    // rejoins at the top rather than at its (usually old) date of death. Same
    // expression as the settlement trim in v3/raid.ts; they must agree or the row the
    // bootstrap shows is not the row that survives.
    db.prepare(`SELECT unit_id, zombie_key, name, mutation, invasions, color, died_at,
        released_at, memorial_object_id
      FROM fallen_v3 WHERE account_id = ?
      ORDER BY (memorial_object_id IS NULL), COALESCE(released_at, died_at) DESC, unit_id
      LIMIT ?`).bind(accountId, MEMORIAL_GRAVEYARD_CAP + MAX_FUNCTIONAL_OBJECTS).all<FallenRow>(),
    db.prepare(`SELECT id, raid_id, roster_json, started_at, earliest_finish_at, expires_at
      FROM raid_sessions_v3 WHERE account_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`)
      .bind(accountId).first<RaidRow>(),
    db.prepare("SELECT last_started_at, progress_json, tier_json FROM raid_state_v3 WHERE account_id = ?")
      .bind(accountId).first<RaidStateRow>(),
    db.prepare(`SELECT session_id, casualties_json FROM raid_revivals_v3
      WHERE account_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .bind(accountId).first<{ session_id: string; casualties_json: string }>(),
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id = ?")
      .bind(accountId).first<EpicRunRow>(),
  ]);
  return { runtime, balance, farm, objects, quests, periodic, core, presentation, roster, fallen,
    raid, raidState, raidRevival, epicBoss };
}

/** Whether the rows `ensureV3` seeds are all present. */
const seeded = (r: Awaited<ReturnType<typeof readAll>>): boolean =>
  !!(r.runtime && r.balance && r.farm && r.objects && r.quests && r.periodic && r.core
    && r.presentation && r.raidState);

async function loadRows(db: D1Database, accountId: string, now: number) {
  // Read FIRST, seed only if something is actually missing.
  //
  // `ensureV3` is a nine-statement INSERT OR IGNORE batch, and it used to run ahead of
  // every single read — 689k executions of its first statement alone in a month of beta,
  // the fourth most expensive query on the server by total time, every one of them a no-op
  // after the account's first ever request. Now an established account pays nothing, and a
  // brand-new one pays a single extra round of reads, once in its life.
  //
  // The inversion is safe under concurrency because the seeding is INSERT OR IGNORE: two
  // requests racing a new account both find rows missing, both seed, and the second one's
  // inserts are ignored rather than conflicting.
  let rows = await readAll(db, accountId);
  if (!seeded(rows)) {
    await ensureV3(db, accountId, now);
    rows = await readAll(db, accountId);
  }
  const { runtime, balance, farm, objects, quests, periodic, core, presentation, raidState } = rows;
  if (!runtime || !balance || !farm || !objects || !quests || !periodic || !core || !presentation || !raidState) throw new Error("v3_state_init_failed");
  return { runtime, balance, farm, objects, quests, periodic, core, presentation, roster: rows.roster.results ?? [],
    fallen: rows.fallen.results ?? [], raid: rows.raid, raidState, raidRevival: rows.raidRevival, epicBoss: rows.epicBoss };
}

function project(rows: Awaited<ReturnType<typeof loadRows>>): GameplayProjection {
  const base = freshGameplayState();
  const core = parse<ReturnType<typeof coreFrom>>(rows.core.current_json, coreFrom(base));
  const roster = rows.roster.map((u) => {
    const color = parseRosterColor(u.color);
    return {
      id: u.unit_id,
      key: u.zombie_key,
      // Older v3 harvests persisted every new zombie with mutation 0. Market-mutant
      // species have a guaranteed catalog bit, so repair those legacy rows in the
      // authoritative projection. Explicit inherited masks remain untouched.
      mutation: u.mutation || zombieDefaultMutation(u.zombie_key),
      invasions: u.invasions,
      stored: !!u.stored,
      ...(u.locked_by_raid ? { lockedByRaid: u.locked_by_raid } : {}),
      // A zombie handed back by a cancelled Black Market sale. It reaches the client
      // under a new unit id, so the flag is what stops the Almanac counting the
      // player's own zombie as freshly obtained every list/cancel cycle.
      ...(u.from_escrow ? { restored: true as const } : {}),
      // Set only for a unit whose tint survived a trade (see migration 0041). Absent
      // means the client falls back to its presentation hint, then the catalog colour.
      ...(color ? { color } : {}),
    };
  });
  const fallen = rows.fallen.map((f) => {
    const color = parseRosterColor(f.color);
    return {
      id: f.unit_id,
      key: f.zombie_key,
      ...(f.name ? { name: f.name } : {}),
      mutation: f.mutation,
      invasions: f.invasions,
      ...(color ? { color } : {}),
      diedAt: f.died_at,
      ...(f.released_at != null ? { releasedAt: f.released_at } : {}),
      ...(f.memorial_object_id ? { memorialObjectId: f.memorial_object_id } : {}),
    };
  });
  const epicBoss = projectRun(rows.epicBoss);
  if (epicBoss) {
    const owned = new Set(roster.map((unit) => unit.id));
    epicBoss.attackOrder = epicBoss.attackOrder.filter((id) => owned.has(id));
  }
  return {
    balance: { ...rows.balance },
    farm: { version: rows.farm.version, plots: parse(rows.farm.current_json, {}) },
    objects: { version: rows.objects.version, objects: parse(rows.objects.current_json, []) },
    quests: { version: rows.quests.version, ...parse(rows.quests.current_json, { completed: [], progress: [] }) },
    periodicQuests: {
      version: rows.periodic.version,
      ...parse(rows.periodic.current_json, { daily: null, weekly: null }),
    },
    inventory: core.inventory ?? {},
    storage: core.storage ?? { received: {}, stored: {} },
    farmSize: core.farmSize ?? 30,
    climates: core.climates ?? ["grass"],
    farmerHeads: core.farmerHeads ?? base.farmerHeads,
    farmerHeadId: core.farmerHeadId ?? base.farmerHeadId,
    // Absent in every core document written before the bonus slot existed, and null
    // there means "the worn head supplies the bonus" — i.e. the behaviour those
    // accounts already had, so no backfill migration is needed.
    farmerBonusHeadId: core.farmerBonusHeadId ?? null,
    ownedPets: core.ownedPets ?? [],
    activePet: core.activePet ?? null,
    penPets: core.penPets ?? [],
    zombieMax: core.zombieMax ?? 16,
    zombiePotBought: core.zombiePotBought ?? false,
    tutorialRewarded: core.tutorialRewarded ?? false,
    potSlots: core.potSlots ?? {},
    roster,
    fallen,
    raids: { progress: parse(rows.raidState.progress_json, {}), tiers: parse(rows.raidState.tier_json, {}),
      lastRaidAt: rows.raidState.last_started_at },
    raidRevival: rows.raidRevival ? {
      sessionId: rows.raidRevival.session_id,
      zombies: parse(rows.raidRevival.casualties_json, []),
      costPerZombie: 1,
    } : null,
    epicBoss,
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

/** Generate or roll over the authoritative periodic board before bootstrap projects it.
 *
 * Periodic documents are born with both scopes null. Command batches refresh them before
 * applying gameplay, but bootstrap is what draws the panel; returning the null document
 * there makes an eligible player act once before they can even see today's objectives.
 * This refresh is projection-only. The generator is deterministic, and the next command
 * or raid settlement performs the same rollover and persists it. Keeping bootstrap free
 * of a document write avoids racing an in-flight command batch while still showing the
 * player the exact authoritative board that batch will use.
 */
export function refreshPeriodicForBootstrap(
  accountId: string,
  rows: Awaited<ReturnType<typeof loadRows>>,
  now: number,
): void {
  const state = parse<PeriodicQuestState>(rows.periodic.current_json, { daily: null, weekly: null });
  const level = levelForXp(rows.balance.xp);
  const changed = refreshPeriodicState(state, {
    accountId,
    level,
    xpToNext: xpToNextLevel(level, XP_THRESHOLDS),
    now,
  });
  if (!changed) return;

  const currentJson = JSON.stringify({ daily: state.daily, weekly: state.weekly });
  rows.periodic = { ...rows.periodic, version: rows.periodic.version + 1, current_json: currentJson };
}

export async function bootstrap(
  db: D1Database,
  accountId: string,
  now: number,
  mutationsEnabled: boolean,
  minimumProtocolVersion: number,
  writer?: WriterProjection
): Promise<BootstrapResponse> {
  const rows = await loadRows(db, accountId, now);
  refreshPeriodicForBootstrap(accountId, rows, now);
  const [friends, incomingRequestCount, inboxCount] = await Promise.all([
    legacyDb.listFriends(db, accountId),
    legacyDb.countIncomingRequests(db, accountId),
    legacyDb.countUnclaimedTo(db, accountId),
  ]);
  return {
    protocolVersion: GAMEPLAY_PROTOCOL,
    serverTime: now,
    minimumProtocolVersion,
    raidRulesetVersion: RAID_RULESET_VERSION,
    mutationsEnabled,
    accountVersion: rows.runtime.account_version,
    writerGeneration: rows.runtime.writer_generation,
    writerDeviceId: rows.runtime.writer_device_id,
    writer: writer ?? {
      status: rows.runtime.writer_device_id ? "other" : "free",
      generation: rows.runtime.writer_generation,
      lastActivityAt: rows.runtime.writer_last_activity_at ?? 0,
    },
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
  // Fetched here rather than carried by loadRows: this is the ONLY reader of
  // last_result_json, it averages 9.4 KB (peaking at 67 KB), and it matters only when a
  // client actually retries a batch id. Reading it on the id match instead of on every
  // request trades one rare extra query for ~9 KB off the cost of all of them.
  const replay = runtime.last_batch_id === body.batchId
    ? await db.prepare("SELECT last_result_json FROM account_runtime_v3 WHERE account_id = ?")
        .bind(accountId).first<{ last_result_json: string | null }>()
    : null;
  if (replay?.last_result_json) {
    const cached = parse<CommandBatchResponse>(replay.last_result_json, null as never);
    // The projection timestamps are absolute server epochs, but serverTime is the
    // response-time clock anchor used to translate them into the browser's clock
    // domain. Refresh only that anchor when replaying an idempotent result; reusing
    // the original value would add the whole retry/offline interval to every timer.
    return { status: 200, response: { ...cached, serverTime: now } };
  }
  // An EXPIRED operation marker must not block a batch. `beginOperation` and `release`
  // both treat one past its TTL as absent; this was the last reader that did not, and
  // the marker is SHARED - a raid, gift, black-market or presentation request killed
  // between `beginOperation` and `endOperation` leaves one behind. Without the expiry
  // clause that orphan answers every subsequent batch with 409 forever: nothing sweeps
  // it (D1 has no TTL), the only writers that clear it are the operation that owns it
  // and a sign-out release, and the account is left holding a live lease that applies
  // nothing - "Gameplay paused - reconnect to continue" on a farm the server thinks is
  // perfectly healthy. The CAS below carries the same clause; relaxing only one of them
  // just changes which 409 the player is stuck behind.
  if (runtime.active_batch_id && runtime.active_batch_expires_at > now) {
    return { status: 409, error: "batch_in_progress" };
  }
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
  const engine = applyCommandBatch(before, body.commands, { now, accountId });
  if (engine.farmChanged) engine.state.farm.version++;
  if (engine.objectChanged) engine.state.objects.version++;
  if (engine.questChanged) engine.state.quests.version++;
  if (engine.periodicChanged && engine.state.periodicQuests) engine.state.periodicQuests.version++;
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
      active_batch_id = ?, active_batch_expires_at = ?, account_version = account_version + 1,
      writer_device_id = COALESCE(writer_device_id, ?),
      writer_generation = CASE WHEN writer_device_id IS NULL THEN writer_generation + 1 ELSE writer_generation END,
      command_window_start = ?, command_window_count = ?, updated_at = ?
    WHERE account_id = ? AND account_version = ?
      AND (active_batch_id IS NULL OR active_batch_expires_at <= ?)
      AND (writer_device_id IS NULL OR writer_device_id = ?)`)
    .bind(body.batchId, now + 120_000, body.deviceId, windowStart, windowCount, now,
      accountId, runtime.account_version, now, body.deviceId));
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
  if (engine.periodicChanged) statements.push(db.prepare(`UPDATE periodic_quest_documents_v3 SET
      version = version + 1, current_json = ?, updated_at = ? WHERE account_id = ? AND ${guard}`)
    .bind(JSON.stringify({
      daily: engine.state.periodicQuests?.daily ?? null,
      weekly: engine.state.periodicQuests?.weekly ?? null,
    }), now, accountId, accountId, body.batchId));
  if (before.raids.lastRaidAt !== engine.state.raids.lastRaidAt) {
    statements.push(db.prepare(`UPDATE raid_state_v3 SET last_started_at = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(engine.state.raids.lastRaidAt, accountId, accountId, body.batchId));
  }
  if (before.epicBoss && engine.state.epicBoss && before.epicBoss.runId === engine.state.epicBoss.runId &&
      before.epicBoss.tokenCount !== engine.state.epicBoss.tokenCount) {
    statements.push(db.prepare(`UPDATE epic_boss_runs_v3 SET token_count=?
      WHERE account_id=? AND run_id=? AND ${guard}`)
      .bind(engine.state.epicBoss.tokenCount, accountId, engine.state.epicBoss.runId, accountId, body.batchId));
  }
  // A run the batch INVENTED: harvesting a boss's favourite crop lured it onto the farm
  // (engine.ts maybeLureEpicBoss). This is the only path that can create an epic-boss
  // row outside /epic-boss/activate, and it charges nothing, so there is no balance
  // statement to pair with it — the quest reopen it performs rides along in the ordinary
  // quest-document write, which `questChanged` has already noticed.
  //
  // The DO UPDATE carries the SAME liveness condition /epic-boss/activate puts on its
  // own upsert, and it is not redundant with the engine's check. The engine tested the
  // state this batch was READ from, and the batch writer lock does not cover
  // /epic-boss/activate — that route touches this table without ever taking
  // account_runtime_v3. So a purchase committing between our read and our write would,
  // unguarded, be silently replaced here by a free level-1 run for some other boss,
  // with the brains already spent and no way to notice. A paid event outranks a lucky
  // one, always; on that interleaving the lure is simply lost, which costs the player
  // nothing they paid for.
  //
  // The response was serialized before this point and still describes the lured run, so
  // a refusal leaves it optimistic for one round trip. That is the accepted cost and it
  // self-heals: the client adopts whatever the next projection carries (readRun ->
  // onEpicBossState), and an event it never gets is not one it can spend anything on.
  if (engine.state.epicBoss && engine.state.epicBoss.runId !== before.epicBoss?.runId) {
    const lured = engine.state.epicBoss;
    statements.push(db.prepare(`INSERT INTO epic_boss_runs_v3
      (account_id,run_id,boss_id,activated_at,expires_at,level,max_hp,current_hp,started_crop)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}
      ON CONFLICT(account_id) DO UPDATE SET
      run_id=excluded.run_id,boss_id=excluded.boss_id,activated_at=excluded.activated_at,
      expires_at=excluded.expires_at,level=excluded.level,max_hp=excluded.max_hp,
      current_hp=excluded.current_hp,encounter_started_at=0,retry_ready_at=0,
      token_count=0,completed_at=0,attack_order_json='[]',started_crop=excluded.started_crop
      WHERE epic_boss_runs_v3.completed_at != 0 OR epic_boss_runs_v3.expires_at <= ?`)
      .bind(accountId, lured.runId, lured.bossId, lured.activatedAt, lured.expiresAt,
        lured.level, lured.maxHp, lured.currentHp, lured.startedCrop ?? "", accountId, body.batchId,
        now));
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
      (account_id, unit_id, zombie_key, mutation, invasions, stored, locked_by_raid, created_at, color)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
      ON CONFLICT(account_id, unit_id) DO UPDATE SET zombie_key=excluded.zombie_key,
        mutation=excluded.mutation, invasions=excluded.invasions, stored=excluded.stored,
        locked_by_raid=excluded.locked_by_raid, color=excluded.color`)
      .bind(accountId, unit.id, unit.key, unit.mutation, unit.invasions, unit.stored ? 1 : 0,
        unit.lockedByRaid ?? null, now, serializeRosterColor(unit.color), accountId, body.batchId));
  }
  // The graveyard, diffed exactly like the roster above. Commands only ever move a
  // zombie ON or OFF a statue (memorial.enshrine / memorial.clear) — nothing in the
  // engine can add or remove a fallen zombie, which is why there is no INSERT here:
  // rows are born at raid settlement and die when the account does.
  const oldFallen = new Map((before.fallen ?? []).map((f) => [f.id, f]));
  for (const fallen of engine.state.fallen ?? []) {
    const old = oldFallen.get(fallen.id);
    if (old && old.memorialObjectId === fallen.memorialObjectId &&
        old.releasedAt === fallen.releasedAt) continue;
    // `released_at` rides along because it is stamped by the same move that clears
    // the statue (see releaseMemorial) — it is what keeps the released zombie at the
    // top of the graveyard instead of at its date of death.
    statements.push(db.prepare(`UPDATE fallen_v3
      SET memorial_object_id = ?, released_at = ?, name = COALESCE(?, name)
      WHERE account_id = ? AND unit_id = ? AND ${guard}`)
      .bind(fallen.memorialObjectId ?? null, fallen.releasedAt ?? null, fallen.name ?? null,
        accountId, fallen.id, accountId, body.batchId));
  }
  const durableKinds = new Set(["power.buy", "object.buy", "object.refund", "object.upgrade", "storage.claim", "roster.sell", "roster.combine_start", "roster.combine", "farmer.buy", "pet.buy"]);
  body.commands.forEach((entry, index) => {
    const result = engine.results[index];
    if (result?.status !== "applied" || !durableKinds.has(entry.command.type)) return;
    statements.push(db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(`${accountId}:${body.batchId}:${entry.sequence}`, accountId, entry.command.type,
        JSON.stringify({ command: entry.command, createdIds: result.createdIds ?? [] }), now,
        accountId, body.batchId));
  });
  const rejectedCommands = engine.results.flatMap((result, index) =>
    result.status === "rejected" || result.status === "dependency_failed"
      ? [{ sequence: result.sequence, type: body.commands[index]?.command.type ?? "unknown",
          status: result.status, error: result.error ?? "unknown" }]
      : []
  );
  if (rejectedCommands.length) {
    statements.push(db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, 'command_rejected', ?, ? WHERE ${guard}`)
      .bind(`${accountId}:${body.batchId}:rejected`, accountId, JSON.stringify({ commands: rejectedCommands }), now,
        accountId, body.batchId));
  }
  if (engine.createdZombieIds.length) {
    statements.push(db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, 'zombie_created', ?, ? WHERE ${guard}`)
      .bind(`${accountId}:${body.batchId}:zombies`, accountId, JSON.stringify({ ids: engine.createdZombieIds }), now,
        accountId, body.batchId));
  }
  statements.push(db.prepare(`UPDATE account_runtime_v3 SET active_batch_id = NULL, active_batch_expires_at = 0,
      last_batch_id = ?, last_first_sequence = ?, last_result_json = ?, updated_at = ?
    WHERE account_id = ? AND active_batch_id = ?`)
    .bind(body.batchId, lastSequence, resultJson, now, accountId, body.batchId));

  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) return { status: 409, error: "state_conflict" };
  return { status: 200, response };
}

/** The presentation blob as stored, or null when the account has none yet (or it is
 *  unreadable). Read on the ONE path that has to look at what is already there:
 *  carrying a lifetime tally forward past a client too old to send one — see
 *  statsToCarryForward in index.ts. Everything else writes the blob wholesale. */
export async function readPresentationData(
  db: D1Database,
  accountId: string
): Promise<Record<string, unknown> | null> {
  const row = await db.prepare("SELECT current_json FROM presentations_v3 WHERE account_id = ?")
    .bind(accountId).first<{ current_json: string }>();
  if (!row?.current_json) return null;
  try {
    const parsed = JSON.parse(row.current_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
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
