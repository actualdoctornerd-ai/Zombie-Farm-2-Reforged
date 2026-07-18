import { DICE_KEY, CONCENTRATION_KEY, VOUCHER_KEY } from "../boostCatalog";
import { levelForXp, levelUpBrains } from "../levels";
import { resolveLoot, rollLoot } from "../loot";
import { raidEcon, raidUnlocked, winGold } from "../raidCatalog";
import { applyQuestEvents } from "./engine";
import type { QuestProjection } from "../../../src/net/protocol";
import raidRows from "../../../public/assets/raids/raids.json";
import { farmerCooldownMs } from "../../../src/farmer";
import { buildPinnedV3Raid, verifyRaid, RAID_RULESET_VERSION, type PinnedRaidConfig, type RaidReplayInput } from "../raidVerifier";

const DEFAULT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const RAID_TTL_MS = 15 * 60 * 1000;
const EARLIEST_FINISH_MS = 15_000;

interface CoreState {
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  farmerHeadId?: number;
  [key: string]: unknown;
}

interface UnitRow { unit_id: string }
interface RaidStateRow { last_started_at: number; progress_json: string }
interface QuestRow { version: number; current_json: string }
interface SessionRow {
  id: string;
  raid_id: string;
  roster_json: string;
  boosts_json: string;
  config_json: string;
  ruleset_version: number;
  started_at: number;
  earliest_finish_at: number;
  expires_at: number;
  finished_at: number | null;
  result_json: string | null;
}

interface CasualtySnapshot {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
  stored: boolean;
  createdAt: number;
}

export interface RaidRevivalOffer {
  sessionId: string;
  zombies: CasualtySnapshot[];
  costPerZombie: 1;
}

const parse = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const raidNames = new Map((raidRows as { id: number; name: string }[]).map((r) => [r.id, r.name]));

export async function expireLiveRaid(db: D1Database, accountId: string, now: number): Promise<void> {
  const expired = await db.prepare(`SELECT id FROM raid_sessions_v3
    WHERE account_id = ? AND finished_at IS NULL AND expires_at <= ?`)
    .bind(accountId, now).first<{ id: string }>();
  if (!expired) return;
  await db.batch([
    db.prepare("UPDATE raid_sessions_v3 SET finished_at = ? WHERE id = ? AND finished_at IS NULL").bind(now, expired.id),
    db.prepare("UPDATE roster_v3 SET locked_by_raid = NULL WHERE account_id = ? AND locked_by_raid = ?").bind(accountId, expired.id),
  ]);
}

export async function startRaid(
  db: D1Database,
  accountId: string,
  body: { raidId?: unknown; orderedUnitIds?: unknown; useVoucher?: unknown; concentration?: unknown; dice?: unknown; rulesetVersion?: unknown },
  now: number,
  cooldownMs = DEFAULT_COOLDOWN_MS
): Promise<{ status: number; body: Record<string, unknown> }> {
  await expireLiveRaid(db, accountId, now);
  const raidId = Number(body.raidId);
  const econ = raidEcon(raidId);
  const requested = Array.isArray(body.orderedUnitIds)
    ? body.orderedUnitIds.filter((id): id is string => typeof id === "string" && !!id)
    : [];
  if (!econ) return { status: 400, body: { ok: false, error: "bad_raid" } };
  if (!requested.length) return { status: 400, body: { ok: false, error: "bad_roster" } };
  if (body.rulesetVersion !== RAID_RULESET_VERSION) {
    return { status: 426, body: { ok: false, error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION } };
  }
  await db.prepare("INSERT OR IGNORE INTO raid_state_v3(account_id) VALUES (?)").bind(accountId).run();
  const concentration = body.concentration === true;
  const pinned = await buildPinnedV3Raid(db, accountId, raidId, body.orderedUnitIds, concentration);
  if (!pinned.ok) {
    const status = pinned.error === "locked" ? 403 : pinned.error === "bad_raid" || pinned.error === "bad_roster" ? 400 : 409;
    return { status, body: { ok: false, error: pinned.error } };
  }
  const [balance, coreRow, raidState, live, liveEpic, roster] = await Promise.all([
    db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?").bind(accountId).first<{ gold: number; brains: number; xp: number }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?").bind(accountId).first<{ current_json: string }>(),
    db.prepare("SELECT last_started_at, progress_json FROM raid_state_v3 WHERE account_id = ?").bind(accountId).first<RaidStateRow>(),
    db.prepare("SELECT id FROM raid_sessions_v3 WHERE account_id = ? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    db.prepare("SELECT id FROM epic_boss_sessions_v3 WHERE account_id = ? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    db.prepare(`SELECT unit_id FROM roster_v3 WHERE account_id = ? AND locked_by_raid IS NULL AND stored = 0
      AND unit_id IN (${requested.map(() => "?").join(",")})`).bind(accountId, ...requested).all<UnitRow>(),
  ]);
  if (!balance || !coreRow || !raidState) return { status: 409, body: { ok: false, error: "state_conflict" } };
  if (live || liveEpic) return { status: 409, body: { ok: false, error: "raid_in_progress" } };
  if (!raidUnlocked(econ, levelForXp(balance.xp))) return { status: 403, body: { ok: false, error: "locked", unlockLevel: econ.unlockLevel } };
  if ((roster.results ?? []).length !== requested.length) return { status: 409, body: { ok: false, error: "bad_roster" } };
  const core = parse<CoreState>(coreRow.current_json, { inventory: {}, storage: { received: {}, stored: {} } });
  const activeCooldownMs = farmerCooldownMs(cooldownMs, core.farmerHeadId ?? 1);
  const remaining = Math.max(0, raidState.last_started_at + activeCooldownMs - now);
  const useVoucher = body.useVoucher === true;
  if (remaining && !useVoucher) return { status: 429, body: { ok: false, error: "cooldown", cooldownRemaining: remaining } };
  if (remaining && (core.inventory[VOUCHER_KEY] ?? 0) < 1) return { status: 409, body: { ok: false, error: "no_voucher" } };
  const dice = Math.max(0, Math.min(10, Math.trunc(Number(body.dice) || 0)));
  if ((core.inventory[DICE_KEY] ?? 0) < dice) return { status: 409, body: { ok: false, error: "insufficient_dice" } };
  if (concentration && (core.inventory[CONCENTRATION_KEY] ?? 0) < 1) return { status: 409, body: { ok: false, error: "no_concentration" } };
  if (remaining) core.inventory[VOUCHER_KEY]--;
  if (dice) core.inventory[DICE_KEY] -= dice;
  if (concentration) core.inventory[CONCENTRATION_KEY]--;
  const sessionId = crypto.randomUUID();
  const expiresAt = now + RAID_TTL_MS;
  const earliestFinishAt = now + EARLIEST_FINISH_MS;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO raid_sessions_v3
      (id, account_id, raid_id, roster_json, boosts_json, config_json, ruleset_version, started_at, earliest_finish_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, accountId, String(raidId), JSON.stringify(requested), JSON.stringify({ dice, concentration }),
        JSON.stringify(pinned.config), RAID_RULESET_VERSION, now, earliestFinishAt, expiresAt),
    db.prepare("UPDATE raid_state_v3 SET last_started_at = ? WHERE account_id = ?").bind(now, accountId),
    db.prepare("UPDATE gameplay_documents_v3 SET current_json = ?, updated_at = ? WHERE account_id = ?")
      .bind(JSON.stringify(core), now, accountId),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      VALUES(?,?, 'raid_start', ?, ?)`)
      .bind(crypto.randomUUID(), accountId, JSON.stringify({ sessionId, raidId, roster: requested, dice, concentration, bypassed: remaining > 0 }), now),
  ];
  for (const id of requested) statements.push(
    db.prepare("UPDATE roster_v3 SET locked_by_raid = ? WHERE account_id = ? AND unit_id = ? AND locked_by_raid IS NULL")
      .bind(sessionId, accountId, id)
  );
  await db.batch(statements);
  return { status: 200, body: { ok: true, sessionId, bypassed: remaining > 0, dice,
    concentration, inventory: core.inventory, lastRaidAt: now, expiresAt, earliestFinishAt,
    rulesetVersion: RAID_RULESET_VERSION } };
}

async function closeInvalidRaid(db: D1Database, accountId: string, sessionId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE raid_sessions_v3 SET finished_at=? WHERE id=? AND account_id=? AND finished_at IS NULL")
      .bind(now, sessionId, accountId),
    db.prepare("UPDATE roster_v3 SET locked_by_raid=NULL WHERE account_id=? AND locked_by_raid=?")
      .bind(accountId, sessionId),
  ]);
}

export async function finishRaid(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown; finalTick?: unknown; inputs?: unknown },
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return { status: 400, body: { error: "bad_session" } };
  const session = await db.prepare("SELECT * FROM raid_sessions_v3 WHERE id = ? AND account_id = ?")
    .bind(body.sessionId, accountId).first<SessionRow>();
  if (!session) return { status: 404, body: { error: "bad_session" } };
  if (session.result_json) return { status: 200, body: parse(session.result_json, {}) };
  if (session.finished_at) return { status: 409, body: { error: "already_finished" } };
  const locked = parse<string[]>(session.roster_json, []);
  if (now >= session.expires_at) {
    const result = { expired: true, gold: 0, xp: 0, firstClear: false, loot: null };
    await db.batch([
      db.prepare("UPDATE raid_sessions_v3 SET finished_at = ?, result_json = ? WHERE id = ? AND finished_at IS NULL")
        .bind(now, JSON.stringify(result), session.id),
      db.prepare("UPDATE roster_v3 SET locked_by_raid = NULL WHERE account_id = ? AND locked_by_raid = ?").bind(accountId, session.id),
    ]);
    return { status: 200, body: result };
  }
  if (session.ruleset_version !== RAID_RULESET_VERSION) {
    await closeInvalidRaid(db, accountId, session.id, now);
    return { status: 409, body: { error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION } };
  }
  const pacedTick = Math.floor((now - session.started_at) / 50) + 40;
  if (Number(body.finalTick) > pacedTick) return { status: 422, body: { error: "future_finish" } };
  let config: PinnedRaidConfig;
  try { config = JSON.parse(session.config_json) as PinnedRaidConfig; }
  catch {
    await closeInvalidRaid(db, accountId, session.id, now);
    return { status: 409, body: { error: "bad_session_config" } };
  }
  if (!Array.isArray(config.playerUnits) || !Array.isArray(config.enemyUnits) ||
      !Array.isArray(config.rosterIds) || config.rosterIds.length !== locked.length) {
    await closeInvalidRaid(db, accountId, session.id, now);
    return { status: 409, body: { error: "bad_session_config" } };
  }
  const verified = verifyRaid(config, body.finalTick as number, body.inputs as RaidReplayInput[]);
  if (!verified.ok) {
    await closeInvalidRaid(db, accountId, session.id, now);
    return { status: 422, body: { error: verified.error } };
  }
  const { survivors, losses } = verified.outcome;
  const retreated = verified.retreated;
  const accounted = new Set([...survivors, ...losses]);
  if ([...accounted].some((id) => !locked.includes(id)) || (!retreated && accounted.size !== locked.length)) {
    await closeInvalidRaid(db, accountId, session.id, now);
    return { status: 422, body: { error: "replay_roster_mismatch" } };
  }
  const escaped = retreated ? locked.filter((id) => !losses.includes(id)) : survivors;
  if (new Set([...escaped, ...losses]).size !== locked.length || escaped.some((id) => losses.includes(id))) {
    return { status: 400, body: { error: "bad_roster_partition" } };
  }
  const win = !retreated && verified.outcome.win;
  const raidId = Number(session.raid_id);
  const econ = raidEcon(raidId);
  if (!econ) return { status: 409, body: { error: "bad_raid" } };
  const [balance, coreRow, raidState, questRow, casualtyRows] = await Promise.all([
    db.prepare("SELECT gold, brains, xp, claimed_level FROM balances WHERE account_id = ?").bind(accountId).first<{ gold: number; brains: number; xp: number; claimed_level: number }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?").bind(accountId).first<{ current_json: string }>(),
    db.prepare("SELECT last_started_at, progress_json FROM raid_state_v3 WHERE account_id = ?").bind(accountId).first<RaidStateRow>(),
    db.prepare("SELECT version, current_json FROM quest_documents_v3 WHERE account_id = ?").bind(accountId).first<QuestRow>(),
    losses.length
      ? db.prepare(`SELECT unit_id, zombie_key, mutation, invasions, stored, created_at FROM roster_v3
          WHERE account_id = ? AND locked_by_raid = ? AND unit_id IN (${losses.map(() => "?").join(",")})`)
        .bind(accountId, session.id, ...losses)
        .all<{ unit_id: string; zombie_key: string; mutation: number; invasions: number; stored: number; created_at: number }>()
      : Promise.resolve({ results: [] }),
  ]);
  if (!balance || !coreRow || !raidState || !questRow) return { status: 409, body: { error: "state_conflict" } };
  const core = parse<CoreState>(coreRow.current_json, { inventory: {}, storage: { received: {}, stored: {} } });
  const progress = parse<Record<string, number>>(raidState.progress_json, {});
  const firstClear = win && !(progress[String(raidId)] > 0);
  const baseGold = win ? winGold(econ, survivors.length / locked.length) : 0;
  const xp = firstClear ? econ.xp : 0;
  let loot: { name: string; kind: "gold" | "boost" | "item" } | null = null;
  let lootGold = 0;
  if (win) {
    progress[String(raidId)] = (progress[String(raidId)] ?? 0) + 1;
    const boosts = parse<{ dice?: number }>(session.boosts_json, {});
    const name = rollLoot(raidId, boosts.dice ?? 0, (item) => core.storage.received[item] ?? 0, Math.random(), Math.random());
    const grant = resolveLoot(name, econ.recLevel);
    if (grant.kind === "gold") { lootGold = grant.gold; loot = { name: grant.name, kind: "gold" }; }
    else if (grant.kind === "boost") { core.inventory[grant.key] = (core.inventory[grant.key] ?? 0) + 1; loot = { name: grant.name, kind: "boost" }; }
    else if (grant.kind === "item") { core.storage.received[grant.name] = (core.storage.received[grant.name] ?? 0) + 1; loot = { name: grant.name, kind: "item" }; }
  }
  const nextBalance = { gold: balance.gold + baseGold + lootGold, brains: balance.brains, xp: balance.xp + xp };
  const questData = parse<{ completed: string[]; progress: QuestProjection["progress"] }>(
    questRow.current_json, { completed: [], progress: [] }
  );
  const quests: QuestProjection = { version: questRow.version, ...questData };
  const questEvents = win ? [
    { type: "kInvasionSuccessfulNotification", subject: raidNames.get(raidId) ?? String(raidId) },
    ...(losses.length === 0 ? [{ type: "kInvasionPerfectGameNotification", subject: raidNames.get(raidId) ?? String(raidId) }] : []),
    ...(loot ? [{ type: "kLootItemWonNotification", subject: loot.name }] : []),
  ] : [];
  const questChanges = applyQuestEvents(nextBalance, quests, questEvents);
  nextBalance.brains += levelUpBrains(levelForXp(balance.xp), levelForXp(nextBalance.xp));
  const outcome = verified.outcome;
  const casualties: CasualtySnapshot[] = (casualtyRows.results ?? []).map((row) => ({
    id: row.unit_id,
    key: row.zombie_key,
    mutation: row.mutation,
    invasions: row.invasions,
    stored: !!row.stored,
    createdAt: row.created_at,
  }));
  const revival: RaidRevivalOffer | null = casualties.length
    ? { sessionId: session.id, zombies: casualties, costPerZombie: 1 }
    : null;
  const settlementId = crypto.randomUUID();
  const result = { settlementId, lastRaidAt: raidState.last_started_at, balance: nextBalance, gold: baseGold + lootGold,
    xp: nextBalance.xp - balance.xp, firstClear, loot, outcome, questChanges,
    inventory: core.inventory, storage: core.storage, raidProgress: progress, revival,
    rulesetVersion: RAID_RULESET_VERSION };
  const resultJson = JSON.stringify(result);
  const guard = "EXISTS (SELECT 1 FROM raid_sessions_v3 s WHERE s.id = ? AND s.result_json = ?)";
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE raid_sessions_v3 SET finished_at = ?, result_json = ? WHERE id = ? AND finished_at IS NULL")
      .bind(now, resultJson, session.id),
    db.prepare(`UPDATE balances SET gold = ?, brains = ?, xp = ?, claimed_level = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(nextBalance.gold, nextBalance.brains, nextBalance.xp, levelForXp(nextBalance.xp), accountId, session.id, resultJson),
    db.prepare(`UPDATE gameplay_documents_v3 SET current_json = ?, updated_at = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(JSON.stringify(core), now, accountId, session.id, resultJson),
    db.prepare(`UPDATE raid_state_v3 SET progress_json = ? WHERE account_id = ? AND ${guard}`)
      .bind(JSON.stringify(progress), accountId, session.id, resultJson),
    db.prepare(`UPDATE quest_documents_v3 SET version = version + 1, current_json = ?, updated_at = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(JSON.stringify({ completed: quests.completed, progress: quests.progress }), now, accountId, session.id, resultJson),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, 'raid_finish', ?, ? WHERE ${guard}`)
      .bind(settlementId, accountId, JSON.stringify({ sessionId: session.id, raidId, win, survivors, losses, gold: baseGold + lootGold, xp }), now,
        session.id, resultJson),
  ];
  if (revival) statements.push(db.prepare(`INSERT OR IGNORE INTO raid_revivals_v3
    (session_id, account_id, casualties_json, created_at) VALUES (?, ?, ?, ?)`)
    .bind(session.id, accountId, JSON.stringify(casualties), now));
  for (const id of losses) statements.push(db.prepare(`DELETE FROM roster_v3
    WHERE account_id = ? AND unit_id = ? AND locked_by_raid = ? AND ${guard}`)
    .bind(accountId, id, session.id, session.id, resultJson));
  for (const id of survivors) statements.push(db.prepare(`UPDATE roster_v3 SET invasions = invasions + 1
    WHERE account_id = ? AND unit_id = ? AND locked_by_raid = ? AND ${guard}`)
    .bind(accountId, id, session.id, session.id, resultJson));
  statements.push(db.prepare(`UPDATE roster_v3 SET locked_by_raid = NULL
    WHERE account_id = ? AND locked_by_raid = ? AND ${guard}`)
    .bind(accountId, session.id, session.id, resultJson));
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) {
    const raced = await db.prepare("SELECT result_json FROM raid_sessions_v3 WHERE id = ?").bind(session.id).first<{ result_json: string | null }>();
    return raced?.result_json ? { status: 200, body: parse(raced.result_json, {}) } : { status: 409, body: { error: "state_conflict" } };
  }
  return { status: 200, body: result };
}

/** Resolve the single post-battle revival offer. The first accepted request is final:
 * omitted casualties remain deleted, while each selected zombie costs one brain and
 * is restored from the server-owned snapshot captured during raid settlement. */
export async function resolveRevival(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown; reviveIds?: unknown },
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return { status: 400, body: { error: "bad_session" } };
  const row = await db.prepare(`SELECT casualties_json, revived_json, resolved_at FROM raid_revivals_v3
    WHERE session_id = ? AND account_id = ?`).bind(body.sessionId, accountId)
    .first<{ casualties_json: string; revived_json: string | null; resolved_at: number | null }>();
  if (!row) return { status: 404, body: { error: "bad_session" } };
  const casualties = parse<CasualtySnapshot[]>(row.casualties_json, []);
  const requested = Array.isArray(body.reviveIds)
    ? [...new Set(body.reviveIds.filter((id): id is string => typeof id === "string"))]
    : [];
  const allowed = new Set(casualties.map((z) => z.id));
  if (requested.some((id) => !allowed.has(id))) return { status: 400, body: { error: "bad_revive_ids" } };

  if (row.resolved_at != null) {
    const balance = await db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?")
      .bind(accountId).first<{ gold: number; brains: number; xp: number }>();
    return { status: 200, body: { ok: true, revivedIds: parse<string[]>(row.revived_json ?? "[]", []), balance } };
  }
  const balance = await db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?")
    .bind(accountId).first<{ gold: number; brains: number; xp: number }>();
  if (!balance) return { status: 409, body: { error: "state_conflict" } };
  const cost = requested.length;
  if (balance.brains < cost) return { status: 409, body: { error: "insufficient_brains", balance } };
  const revived = casualties.filter((z) => requested.includes(z.id));
  const resolutionId = crypto.randomUUID();
  const guard = `EXISTS (SELECT 1 FROM raid_revivals_v3 r
    WHERE r.session_id = ? AND r.account_id = ? AND r.resolution_id = ?)`;
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE raid_revivals_v3 SET revived_json = ?, resolution_id = ?, resolved_at = ?
      WHERE session_id = ? AND account_id = ? AND resolved_at IS NULL
        AND EXISTS (SELECT 1 FROM balances WHERE account_id = ? AND brains >= ?)`)
      .bind(JSON.stringify(requested), resolutionId, now, body.sessionId, accountId, accountId, cost),
    db.prepare(`UPDATE balances SET brains = brains - ? WHERE account_id = ? AND brains >= ? AND ${guard}`)
      .bind(cost, accountId, cost, body.sessionId, accountId, resolutionId),
  ];
  for (const zombie of revived) statements.push(
    db.prepare(`INSERT INTO roster_v3
      (account_id, unit_id, zombie_key, mutation, invasions, stored, locked_by_raid, created_at)
      SELECT ?, ?, ?, ?, ?, ?, NULL, ? WHERE ${guard}`)
      .bind(accountId, zombie.id, zombie.key, zombie.mutation, zombie.invasions,
        zombie.stored ? 1 : 0, zombie.createdAt, body.sessionId, accountId, resolutionId)
  );
  statements.push(db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
    SELECT ?, ?, 'raid_revive', ?, ? WHERE ${guard}`)
    .bind(crypto.randomUUID(), accountId, JSON.stringify({ sessionId: body.sessionId, revivedIds: requested, cost }), now,
      body.sessionId, accountId, resolutionId));
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) return resolveRevival(db, accountId, body, now);
  return { status: 200, body: {
    ok: true,
    revivedIds: requested,
    balance: { ...balance, brains: balance.brains - cost },
  } };
}
