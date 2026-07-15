import { DICE_KEY, CONCENTRATION_KEY, VOUCHER_KEY } from "../boostCatalog";
import { levelForXp, levelUpBrains } from "../levels";
import { resolveLoot, rollLoot } from "../loot";
import { raidEcon, raidUnlocked, winGold } from "../raidCatalog";
import { applyQuestEvents } from "./engine";
import type { QuestProjection } from "../../../src/net/protocol";
import raidRows from "../../../public/assets/raids/raids.json";

const DEFAULT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const RAID_TTL_MS = 15 * 60 * 1000;
const EARLIEST_FINISH_MS = 15_000;

interface CoreState {
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
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
  started_at: number;
  earliest_finish_at: number;
  expires_at: number;
  finished_at: number | null;
  result_json: string | null;
}

const parse = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const raidNames = new Map((raidRows as { id: number; name: string }[]).map((r) => [r.id, r.name]));

async function expireLive(db: D1Database, accountId: string, now: number): Promise<void> {
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
  body: { raidId?: unknown; orderedUnitIds?: unknown; useVoucher?: unknown; concentration?: unknown; dice?: unknown },
  now: number,
  cooldownMs = DEFAULT_COOLDOWN_MS
): Promise<{ status: number; body: Record<string, unknown> }> {
  await expireLive(db, accountId, now);
  const raidId = Number(body.raidId);
  const econ = raidEcon(raidId);
  const requested = Array.isArray(body.orderedUnitIds)
    ? [...new Set(body.orderedUnitIds.filter((id): id is string => typeof id === "string" && !!id))].slice(0, 64)
    : [];
  if (!econ) return { status: 400, body: { ok: false, error: "bad_raid" } };
  if (!requested.length) return { status: 400, body: { ok: false, error: "bad_roster" } };
  await db.prepare("INSERT OR IGNORE INTO raid_state_v3(account_id) VALUES (?)").bind(accountId).run();
  const [balance, coreRow, raidState, live, roster] = await Promise.all([
    db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?").bind(accountId).first<{ gold: number; brains: number; xp: number }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?").bind(accountId).first<{ current_json: string }>(),
    db.prepare("SELECT last_started_at, progress_json FROM raid_state_v3 WHERE account_id = ?").bind(accountId).first<RaidStateRow>(),
    db.prepare("SELECT id FROM raid_sessions_v3 WHERE account_id = ? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    db.prepare(`SELECT unit_id FROM roster_v3 WHERE account_id = ? AND locked_by_raid IS NULL AND stored = 0
      AND unit_id IN (${requested.map(() => "?").join(",")})`).bind(accountId, ...requested).all<UnitRow>(),
  ]);
  if (!balance || !coreRow || !raidState) return { status: 409, body: { ok: false, error: "state_conflict" } };
  if (live) return { status: 409, body: { ok: false, error: "raid_in_progress" } };
  if (!raidUnlocked(econ, levelForXp(balance.xp))) return { status: 403, body: { ok: false, error: "locked", unlockLevel: econ.unlockLevel } };
  if ((roster.results ?? []).length !== requested.length) return { status: 409, body: { ok: false, error: "bad_roster" } };
  const core = parse<CoreState>(coreRow.current_json, { inventory: {}, storage: { received: {}, stored: {} } });
  const remaining = Math.max(0, raidState.last_started_at + cooldownMs - now);
  const useVoucher = body.useVoucher === true;
  if (remaining && !useVoucher) return { status: 429, body: { ok: false, error: "cooldown", cooldownRemaining: remaining } };
  if (remaining && (core.inventory[VOUCHER_KEY] ?? 0) < 1) return { status: 409, body: { ok: false, error: "no_voucher" } };
  const dice = Math.max(0, Math.min(10, Math.trunc(Number(body.dice) || 0)));
  if ((core.inventory[DICE_KEY] ?? 0) < dice) return { status: 409, body: { ok: false, error: "insufficient_dice" } };
  const concentration = body.concentration === true;
  if (concentration && (core.inventory[CONCENTRATION_KEY] ?? 0) < 1) return { status: 409, body: { ok: false, error: "no_concentration" } };
  if (remaining) core.inventory[VOUCHER_KEY]--;
  if (dice) core.inventory[DICE_KEY] -= dice;
  if (concentration) core.inventory[CONCENTRATION_KEY]--;
  const sessionId = crypto.randomUUID();
  const expiresAt = now + RAID_TTL_MS;
  const earliestFinishAt = now + EARLIEST_FINISH_MS;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO raid_sessions_v3
      (id, account_id, raid_id, roster_json, boosts_json, started_at, earliest_finish_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, accountId, String(raidId), JSON.stringify(requested), JSON.stringify({ dice, concentration }), now, earliestFinishAt, expiresAt),
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
    concentration, inventory: core.inventory, lastRaidAt: now, expiresAt, earliestFinishAt } };
}

export async function finishRaid(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown; win?: unknown; survivors?: unknown; losses?: unknown },
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return { status: 400, body: { error: "bad_session" } };
  const session = await db.prepare("SELECT * FROM raid_sessions_v3 WHERE id = ? AND account_id = ?")
    .bind(body.sessionId, accountId).first<SessionRow>();
  if (!session) return { status: 404, body: { error: "bad_session" } };
  if (session.result_json) return { status: 200, body: parse(session.result_json, {}) };
  if (session.finished_at) return { status: 409, body: { error: "already_finished" } };
  if (now < session.earliest_finish_at) return { status: 425, body: { error: "too_early", retryAfterMs: session.earliest_finish_at - now } };
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
  const clean = (value: unknown) => Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && locked.includes(id)))]
    : [];
  const survivors = clean(body.survivors);
  const losses = clean(body.losses);
  if (new Set([...survivors, ...losses]).size !== locked.length || survivors.some((id) => losses.includes(id))) {
    return { status: 400, body: { error: "bad_roster_partition" } };
  }
  const win = body.win === true;
  const raidId = Number(session.raid_id);
  const econ = raidEcon(raidId);
  if (!econ) return { status: 409, body: { error: "bad_raid" } };
  const [balance, coreRow, raidState, questRow] = await Promise.all([
    db.prepare("SELECT gold, brains, xp, claimed_level FROM balances WHERE account_id = ?").bind(accountId).first<{ gold: number; brains: number; xp: number; claimed_level: number }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?").bind(accountId).first<{ current_json: string }>(),
    db.prepare("SELECT last_started_at, progress_json FROM raid_state_v3 WHERE account_id = ?").bind(accountId).first<RaidStateRow>(),
    db.prepare("SELECT version, current_json FROM quest_documents_v3 WHERE account_id = ?").bind(accountId).first<QuestRow>(),
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
  const outcome = { win, rounds: 0, survivors, losses, enemiesBeaten: 0, playerDamage: 0 };
  const settlementId = crypto.randomUUID();
  const result = { settlementId, lastRaidAt: raidState.last_started_at, balance: nextBalance, gold: baseGold + lootGold,
    xp: nextBalance.xp - balance.xp, firstClear, loot, outcome, questChanges,
    inventory: core.inventory, storage: core.storage, raidProgress: progress };
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
