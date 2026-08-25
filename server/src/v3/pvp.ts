// Friend invasions (PvP) — server routes' logic. See src/raid/pvp.ts (shared rules)
// and raidVerifier.buildPinnedPvpRaid / buildDefenseSnapshot (the pinned config).
//
// The invariants this file exists to hold:
//  - NOBODY LOSES ANYTHING. The defender is a snapshot pinned at start; the finish
//    path touches no roster row, no balance, no cooldown — the only mutation a fight
//    settles is a boost grant into the WINNER's own inventory (plus the win/loss
//    counters in pvp_stats_v3, which are server-authored bookkeeping).
//  - The defender's account is never written while they are away. Their reward for a
//    successful defense parks on the session row until THEY claim it (/raid/pvp/collect
//    or /collect-all), exactly the Black Market's claim-on-login shape.
//  - The outcome is the server's own deterministic replay of the pinned config, same
//    verifier as ordinary raids; `clientWin` remains a pure concession (ANDed).
//  - INCOME IS CAPPED PER DAY, FIGHTS ARE NOT. Any number of fights may happen (the
//    pair cap is only a spam guard), but only the first PVP_DAILY_REWARDED_WINS
//    verified wins pay the attacker and only the first PVP_DAILY_REWARDED_DEFENSES
//    held defenses park a defender reward — stamped at settlement in
//    attacker_rewarded / defense_rewarded, so a claim can never re-litigate them.
//    Capping the income is also the anti-collusion lever for a zero-risk mode.
//  - REPLAYS ARE A ROLLING WINDOW, REWARDS ARE FOREVER. Each finish sweeps the heavy
//    replay payload (config_json + inputs_json) off rows outside both participants'
//    newest PVP_REPLAYS_KEPT finished fights; the result row, its reward and the
//    stats survive, so a month of absence loses recordings, never loot.
import { MAX_STACK, BOOST_KEYS } from "../boostCatalog";
import { areFriends } from "../db";
import { zombieGroup } from "../rosterCatalog";
import { dayBucket } from "../logic";
import {
  buildDefenseSnapshot,
  buildPinnedPvpRaid,
  verifyRaid,
  RAID_RULESET_VERSION,
  type PinnedPvpConfig,
  type PvpDefenderPreview,
  type RaidReplayInput,
} from "../raidVerifier";
import {
  PVP_DAILY_ATTACKS_PER_PAIR,
  PVP_DAILY_REWARDED_DEFENSES,
  PVP_DAILY_REWARDED_WINS,
  PVP_DEFENSE_CAP,
  PVP_DEFENSE_MODE_DEFAULT,
  PVP_REPLAYS_KEPT,
  pvpRewardsForTier,
  type PvpDefenseMode,
  type PvpReward,
} from "../../../src/raid/pvp";
import type { RaidOutcome } from "../../../src/raid/types";

/** Same job as the raid TTL, same length, same limits: it only releases an ABANDONED
 *  session (here: frees the one-live-session slot); a finish keyed on `finished_at
 *  IS NULL` still settles late on its merits. */
const PVP_TTL_MS = 15 * 60 * 1000;
const EARLIEST_FINISH_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Claim-all works in bounded slices so a pathological backlog cannot build an
 *  unbounded batch; the client just calls again while `remaining` is true. */
const CLAIM_ALL_SLICE = 200;

interface SessionRow {
  id: string;
  attacker_id: string;
  defender_id: string;
  config_json: string;
  ruleset_version: number;
  attack_score: number;
  defense_score: number;
  boosts_json: string;
  started_at: number;
  finished_at: number | null;
  result_json: string | null;
  win: number | null;
  final_tick: number | null;
  inputs_json: string | null;
  defense_claimed_at: number | null;
  attacker_rewarded: number | null;
  defense_rewarded: number | null;
}

interface CoreState {
  inventory: Record<string, number>;
  [key: string]: unknown;
}

const parse = <T>(value: string | null | undefined, fallback: T): T => {
  try { return JSON.parse(value ?? "") as T; } catch { return fallback; }
};

/** Fold a list of reward-tier bundles into one merged bundle (claim-all display and
 *  grant). Clamping to MAX_STACK happens at the inventory write, not here. */
function mergeTierRewards(tiers: number[]): PvpReward[] {
  const merged = new Map<string, number>();
  for (const tier of tiers) {
    for (const reward of pvpRewardsForTier(tier)) {
      merged.set(reward.key, (merged.get(reward.key) ?? 0) + reward.qty);
    }
  }
  return [...merged.entries()].map(([key, qty]) => ({ key, qty }));
}

function grantBoosts(core: CoreState, rewards: PvpReward[]): void {
  core.inventory = core.inventory ?? {};
  for (const reward of rewards) {
    if (!BOOST_KEYS.includes(reward.key)) continue;
    core.inventory[reward.key] = Math.min(MAX_STACK, (core.inventory[reward.key] ?? 0) + reward.qty);
  }
}

/** Strip the replay payload (most of a session row's weight) off every finished row
 *  that is outside BOTH participants' newest PVP_REPLAYS_KEPT recordings — a row
 *  survives while either its attacker or its defender still has it in their window.
 *  Expired-unfought rows (win IS NULL) are never watchable and are swept outright.
 *  Idempotent housekeeping: safe to run any time, scoped to one account's rows. */
function sweepReplaysSql(db: D1Database, accountId: string): D1PreparedStatement {
  return db.prepare(`UPDATE pvp_sessions_v3 SET config_json = '{}', inputs_json = NULL
    WHERE (attacker_id = ?1 OR defender_id = ?1)
      AND finished_at IS NOT NULL AND config_json <> '{}'
      AND id NOT IN (
        SELECT a.id FROM pvp_sessions_v3 a
        WHERE a.attacker_id = pvp_sessions_v3.attacker_id AND a.win IS NOT NULL
        ORDER BY a.finished_at DESC LIMIT ?2)
      AND id NOT IN (
        SELECT d.id FROM pvp_sessions_v3 d
        WHERE d.defender_id = pvp_sessions_v3.defender_id AND d.win IS NOT NULL
        ORDER BY d.finished_at DESC LIMIT ?2)`)
    .bind(accountId, PVP_REPLAYS_KEPT);
}

/** Release an abandoned live session (win stays NULL — it never fought). Exported so
 *  /bootstrap can sweep it at READ time, the way raids and Epic Bosses already do: a
 *  player who closed the tab mid-fight should not find the mode locked when they come
 *  back, and nothing about waiting for their next attack makes the stale row truer.
 *  `config_json` is deliberately left alone — see the file header: on THIS table the
 *  windowed sweep is the only writer allowed to clear it, and it collects these rows
 *  (win NULL is outside both replay windows) at the next settled fight. */
export async function expireLivePvp(db: D1Database, attackerId: string, now: number): Promise<void> {
  await db.prepare(`UPDATE pvp_sessions_v3 SET finished_at = ?
    WHERE attacker_id = ? AND finished_at IS NULL AND expires_at <= ?`)
    .bind(now, attackerId, now).run();
}

/** Give the live-session slot back NOW, on the attacker's say-so — the fight never
 *  reached a verdict, so this settles nothing: no win, no loss, no reward, no stats
 *  row. The attempt itself is NOT refunded; `startPvp`'s pair cap counts opened
 *  attacks on purpose, so abandoning cannot farm free retries against one friend.
 *
 *  Without this the 15-minute TTL was the only way out, and every ordinary way a
 *  fight can end badly — a scene that fails to load, a refresh mid-battle, a settle
 *  that the verifier refuses — locked the player out of ALL invasions until it ran
 *  down. Idempotent by the `finished_at IS NULL` guard: a race with a real finish
 *  loses, which is the right way round. */
export async function abandonPvp(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown },
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  // Scoped to the caller's own live row, and to a named session when the client knows
  // which one it is holding: a blind release must not close a fight the player has
  // since (re)opened in another tab.
  const res = await db.prepare(`UPDATE pvp_sessions_v3 SET finished_at = ?
    WHERE attacker_id = ? AND finished_at IS NULL${sessionId ? " AND id = ?" : ""}`)
    .bind(...(sessionId ? [now, accountId, sessionId] : [now, accountId])).run();
  return { status: 200, body: { ok: true, released: (res.meta.changes ?? 0) > 0 } };
}

export async function startPvp(
  db: D1Database,
  accountId: string,
  body: { defenderId?: unknown; orderedUnitIds?: unknown; rulesetVersion?: unknown },
  now: number,
  mode: PvpDefenseMode = PVP_DEFENSE_MODE_DEFAULT
): Promise<{ status: number; body: Record<string, unknown> }> {
  await expireLivePvp(db, accountId, now);
  if (body.rulesetVersion !== RAID_RULESET_VERSION) {
    return { status: 426, body: { ok: false, error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION } };
  }
  const defenderId = typeof body.defenderId === "string" ? body.defenderId : "";
  if (!defenderId || defenderId === accountId) return { status: 400, body: { ok: false, error: "bad_defender" } };
  if (!await areFriends(db, accountId, defenderId)) {
    return { status: 403, body: { ok: false, error: "not_friends" } };
  }
  const [live, pairToday] = await Promise.all([
    db.prepare("SELECT id FROM pvp_sessions_v3 WHERE attacker_id = ? AND finished_at IS NULL")
      .bind(accountId).first<{ id: string }>(),
    // The pair cap counts OPENED attacks (not wins): abandoning a fight must not
    // refund the attempt, or the cap is a suggestion.
    db.prepare(`SELECT COUNT(*) AS n FROM pvp_sessions_v3
      WHERE attacker_id = ? AND defender_id = ? AND started_at >= ?`)
      .bind(accountId, defenderId, dayBucket(now) * DAY_MS).first<{ n: number }>(),
  ]);
  if (live) return { status: 409, body: { ok: false, error: "raid_in_progress" } };
  if ((pairToday?.n ?? 0) >= PVP_DAILY_ATTACKS_PER_PAIR) {
    return { status: 429, body: { ok: false, error: "pair_limit", limit: PVP_DAILY_ATTACKS_PER_PAIR } };
  }
  const pinned = await buildPinnedPvpRaid(db, accountId, defenderId, body.orderedUnitIds, mode);
  if (!pinned.ok) {
    const status = pinned.error === "bad_roster" || pinned.error === "bad_defender" ? 400
      : pinned.error === "attacker_level" || pinned.error === "defender_level" ? 403
      : 409;
    return { status, body: { ok: false, error: pinned.error } };
  }
  const sessionId = crypto.randomUUID();
  const tiers = { attackerTier: pinned.config.pvp.attackerTier, defenderTier: pinned.config.pvp.defenderTier };
  await db.batch([
    db.prepare(`INSERT INTO pvp_sessions_v3
      (id, attacker_id, defender_id, config_json, ruleset_version, attack_score, defense_score,
       boosts_json, started_at, earliest_finish_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, accountId, defenderId, JSON.stringify(pinned.config), RAID_RULESET_VERSION,
        pinned.config.pvp.attackScore, pinned.config.pvp.defenseScore, JSON.stringify(tiers),
        now, now + EARLIEST_FINISH_MS, now + PVP_TTL_MS),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      VALUES(?,?, 'pvp_start', ?, ?)`)
      .bind(crypto.randomUUID(), accountId, JSON.stringify({
        sessionId, defenderId,
        attackScore: pinned.config.pvp.attackScore, defenseScore: pinned.config.pvp.defenseScore,
      }), now),
  ]);
  return { status: 200, body: {
    ok: true, sessionId, config: pinned.config,
    expiresAt: now + PVP_TTL_MS, earliestFinishAt: now + EARLIEST_FINISH_MS,
    serverTime: now, rulesetVersion: RAID_RULESET_VERSION,
  } };
}

async function closeInvalidPvp(
  db: D1Database,
  accountId: string,
  sessionId: string,
  now: number,
  rejection: { error: string; finalTick: unknown; inputCount: number }
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE pvp_sessions_v3 SET finished_at=? WHERE id=? AND attacker_id=? AND finished_at IS NULL")
      .bind(now, sessionId, accountId),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      VALUES(?,?, 'pvp_finish_rejected', ?, ?)`)
      .bind(crypto.randomUUID(), accountId, JSON.stringify({ sessionId, ...rejection }), now),
  ]);
}

export async function finishPvp(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown; finalTick?: unknown; inputs?: unknown; clientWin?: unknown },
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return { status: 400, body: { error: "bad_session" } };
  if (body.clientWin !== undefined && typeof body.clientWin !== "boolean") {
    return { status: 400, body: { error: "bad_client_win" } };
  }
  const conceded = body.clientWin === false;
  const session = await db.prepare("SELECT * FROM pvp_sessions_v3 WHERE id = ? AND attacker_id = ?")
    .bind(body.sessionId, accountId).first<SessionRow>();
  if (!session) return { status: 404, body: { error: "bad_session" } };
  if (session.result_json) {
    return { status: 200, body: { ...parse<Record<string, unknown>>(session.result_json, {}), serverTime: now } };
  }
  if (session.finished_at) return { status: 409, body: { error: "already_finished" } };
  if (session.ruleset_version !== RAID_RULESET_VERSION) {
    await closeInvalidPvp(db, accountId, session.id, now, {
      error: "stale_ruleset", finalTick: body.finalTick,
      inputCount: Array.isArray(body.inputs) ? body.inputs.length : 0,
    });
    return { status: 409, body: { error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION } };
  }
  const pacedTick = Math.floor((now - session.started_at) / 50) + 40;
  if (Number(body.finalTick) > pacedTick) return { status: 422, body: { error: "future_finish" } };
  let config: PinnedPvpConfig;
  try { config = JSON.parse(session.config_json) as PinnedPvpConfig; }
  catch {
    await closeInvalidPvp(db, accountId, session.id, now, {
      error: "bad_session_config", finalTick: body.finalTick,
      inputCount: Array.isArray(body.inputs) ? body.inputs.length : 0,
    });
    return { status: 409, body: { error: "bad_session_config" } };
  }
  const verified = verifyRaid(config, body.finalTick as number, body.inputs as RaidReplayInput[]);
  if (!verified.ok) {
    await closeInvalidPvp(db, accountId, session.id, now, {
      error: verified.error, finalTick: body.finalTick,
      inputCount: Array.isArray(body.inputs) ? body.inputs.length : 0,
    });
    return { status: 422, body: { error: verified.error } };
  }
  // No hazards exist in a friend invasion, so no concession-fallback branch: the
  // replay always completes. `clientWin` stays a one-way concession all the same.
  const win = !verified.retreated && verified.outcome.win && !conceded;

  // Daily income accounting. Two concurrent finishes for one attacker cannot race
  // (one live session per attacker + the result CAS below); two DIFFERENT attackers
  // finishing against one defender can, in which case the defender may be paid for
  // one extra defense that day — a rare, tiny over-pay, accepted over serialising
  // every defender's fights.
  const dayStart = dayBucket(now) * DAY_MS;
  let attackerRewarded = false;
  let defenseRewarded = false;
  if (win) {
    const paid = await db.prepare(`SELECT COUNT(*) AS n FROM pvp_sessions_v3
      WHERE attacker_id = ? AND win = 1 AND attacker_rewarded = 1 AND finished_at >= ?`)
      .bind(accountId, dayStart).first<{ n: number }>();
    attackerRewarded = (paid?.n ?? 0) < PVP_DAILY_REWARDED_WINS;
  } else {
    const paid = await db.prepare(`SELECT COUNT(*) AS n FROM pvp_sessions_v3
      WHERE defender_id = ? AND win = 0 AND defense_rewarded = 1 AND finished_at >= ?`)
      .bind(session.defender_id, dayStart).first<{ n: number }>();
    defenseRewarded = (paid?.n ?? 0) < PVP_DAILY_REWARDED_DEFENSES;
  }

  const tiers = parse<{ attackerTier?: number; defenderTier?: number }>(session.boosts_json, {});
  const rewards: PvpReward[] = win && attackerRewarded ? pvpRewardsForTier(tiers.attackerTier ?? 1) : [];
  // Echo the SETTLED outcome (a conceded win reads as the loss it was paid as).
  const outcome: RaidOutcome = { ...verified.outcome, win };
  const settlementId = crypto.randomUUID();
  const result = {
    settlementId, win, outcome, rewards,
    // A win past the daily cap still counts and records — it just doesn't pay.
    rewarded: win ? attackerRewarded : false,
    attackScore: session.attack_score, defenseScore: session.defense_score,
    rewardTier: win ? tiers.attackerTier ?? 1 : null,
    defenderName: config.pvp?.defenderName ?? "",
    rulesetVersion: RAID_RULESET_VERSION,
  };
  const resultJson = JSON.stringify(result);
  const guard = "EXISTS (SELECT 1 FROM pvp_sessions_v3 s WHERE s.id = ? AND s.result_json = ?)";
  // The transcript is kept for the replay viewer; the replay cap bounds it at
  // 32 KB, but a belt-and-braces size check keeps a hostile body out of the row.
  const inputsJson = JSON.stringify(Array.isArray(body.inputs) ? body.inputs : []);
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE pvp_sessions_v3 SET finished_at = ?, result_json = ?, win = ?,
      final_tick = ?, inputs_json = ?, attacker_rewarded = ?, defense_rewarded = ?
      WHERE id = ? AND finished_at IS NULL`)
      .bind(now, resultJson, win ? 1 : 0, Math.max(0, Math.trunc(Number(body.finalTick) || 0)),
        inputsJson.length <= 40_000 ? inputsJson : null,
        win ? (attackerRewarded ? 1 : 0) : null, win ? null : (defenseRewarded ? 1 : 0),
        session.id),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, 'pvp_finish', ?, ? WHERE ${guard}`)
      .bind(settlementId, accountId, JSON.stringify({
        sessionId: session.id, defenderId: session.defender_id, win,
        rewards, rewarded: result.rewarded, tier: win ? tiers.attackerTier ?? 1 : null,
      }), now, session.id, resultJson),
    // Lifetime counters, server-authored, guarded so an idempotent replay of this
    // finish (or a lost race) can never double-count.
    db.prepare(`INSERT INTO pvp_stats_v3 (account_id, attack_wins, attack_losses, defense_wins, defense_losses)
      SELECT ?, ?, ?, 0, 0 WHERE ${guard}
      ON CONFLICT(account_id) DO UPDATE SET
        attack_wins = attack_wins + excluded.attack_wins,
        attack_losses = attack_losses + excluded.attack_losses`)
      .bind(accountId, win ? 1 : 0, win ? 0 : 1, session.id, resultJson),
    db.prepare(`INSERT INTO pvp_stats_v3 (account_id, attack_wins, attack_losses, defense_wins, defense_losses)
      SELECT ?, 0, 0, ?, ? WHERE ${guard}
      ON CONFLICT(account_id) DO UPDATE SET
        defense_wins = defense_wins + excluded.defense_wins,
        defense_losses = defense_losses + excluded.defense_losses`)
      .bind(session.defender_id, win ? 0 : 1, win ? 1 : 0, session.id, resultJson),
  ];
  let inventory: Record<string, number> | null = null;
  if (rewards.length) {
    // Boost grants come from this trusted settlement path only (see inventory.ts's
    // "no public grant" rule) — same shape as raid loot's bundled boost drop.
    const coreRow = await db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?")
      .bind(accountId).first<{ current_json: string }>();
    if (!coreRow) return { status: 409, body: { error: "state_conflict" } };
    const core = parse<CoreState>(coreRow.current_json, { inventory: {} });
    grantBoosts(core, rewards);
    inventory = core.inventory;
    statements.push(
      db.prepare(`UPDATE gameplay_documents_v3 SET current_json = ?, updated_at = ?
        WHERE account_id = ? AND ${guard}`)
        .bind(JSON.stringify(core), now, accountId, session.id, resultJson)
    );
  }
  // Replay housekeeping rides the settlement: both participants' windows advance by
  // this fight, so both sides' oldest recording may have just fallen out.
  statements.push(sweepReplaysSql(db, accountId), sweepReplaysSql(db, session.defender_id));
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) {
    const raced = await db.prepare("SELECT result_json FROM pvp_sessions_v3 WHERE id = ?")
      .bind(session.id).first<{ result_json: string | null }>();
    return raced?.result_json
      ? { status: 200, body: { ...parse<Record<string, unknown>>(raced.result_json, {}), serverTime: now } }
      : { status: 409, body: { error: "state_conflict" } };
  }
  return { status: 200, body: { ...result, ...(inventory ? { inventory } : {}), serverTime: now } };
}

// ---------------------------------------------------------------------------
// Defense authoring.

/** Save (or clear) the caller's authored defense line-up. Client-authored data —
 *  which owned zombies, in what order — validated for ownership here and again at
 *  every snapshot, so it can never field anything the defender doesn't own. */
export async function setDefensePvp(
  db: D1Database,
  accountId: string,
  body: { unitIds?: unknown },
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!Array.isArray(body.unitIds) || body.unitIds.length > PVP_DEFENSE_CAP) {
    return { status: 400, body: { ok: false, error: "bad_loadout" } };
  }
  const ids = body.unitIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length !== body.unitIds.length || new Set(ids).size !== ids.length) {
    return { status: 400, body: { ok: false, error: "bad_loadout" } };
  }
  if (!ids.length) {
    // Clearing the loadout returns the account to the strongest-16 auto snapshot.
    await db.prepare("DELETE FROM pvp_defense_v3 WHERE account_id = ?").bind(accountId).run();
    return { status: 200, body: { ok: true, unitIds: [] } };
  }
  const placeholders = ids.map(() => "?").join(",");
  const owned = await db.prepare(
    `SELECT unit_id, zombie_key FROM roster_v3 WHERE account_id = ? AND unit_id IN (${placeholders})`)
    .bind(accountId, ...ids).all<{ unit_id: string; zombie_key: string }>();
  const rows = owned.results ?? [];
  if (rows.length !== ids.length) return { status: 400, body: { ok: false, error: "unit_not_owned" } };
  // ONE PER CLASS. The formation fills one job per group, so a second Regular could
  // never take the field — `selectFormationDefense` would drop it at snapshot time and
  // the defender would be quietly guarding with five. Refusing it here makes the rule
  // the player's rule rather than a silent truncation they find out about by losing.
  const groups = new Set<string>();
  for (const row of rows) {
    const group = zombieGroup(row.zombie_key);
    if (!group || groups.has(group)) {
      return { status: 400, body: { ok: false, error: "duplicate_class" } };
    }
    groups.add(group);
  }
  await db.prepare(`INSERT INTO pvp_defense_v3 (account_id, loadout_json, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET loadout_json = excluded.loadout_json,
    updated_at = excluded.updated_at`)
    .bind(accountId, JSON.stringify({ unitIds: ids }), now).run();
  return { status: 200, body: { ok: true, unitIds: ids } };
}

/** The caller's own defense, as an attacker would meet it: the saved loadout plus a
 *  freshly built snapshot (score, the reward tier beating it pays, the line-up). */
export async function getDefensePvp(
  db: D1Database,
  accountId: string,
  mode: PvpDefenseMode = PVP_DEFENSE_MODE_DEFAULT
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [loadoutRow, snapshot] = await Promise.all([
    db.prepare("SELECT loadout_json FROM pvp_defense_v3 WHERE account_id = ?")
      .bind(accountId).first<{ loadout_json: string }>(),
    buildDefenseSnapshot(db, accountId, mode),
  ]);
  const loadout = parse<{ unitIds?: string[] }>(loadoutRow?.loadout_json, {});
  const unitIds = Array.isArray(loadout.unitIds) ? loadout.unitIds : [];
  if (!snapshot.ok) {
    return { status: 200, body: { ok: true, mode, unitIds, defense: null, error: snapshot.error } };
  }
  return { status: 200, body: { ok: true, mode, unitIds, defense: {
    score: snapshot.score,
    tier: snapshot.tier,
    defenders: snapshot.defenders,
    authored: snapshot.authored,
  } } };
}

/** Scout a friend's defense before committing to an attack: name, difficulty score,
 *  the reward tier beating it pays, and the line-up (display fields only — no
 *  stats). Friends-only, like the attack itself. */
export async function previewPvp(
  db: D1Database,
  accountId: string,
  body: { defenderId?: unknown },
  now: number,
  mode: PvpDefenseMode = PVP_DEFENSE_MODE_DEFAULT
): Promise<{ status: number; body: Record<string, unknown> }> {
  const defenderId = typeof body.defenderId === "string" ? body.defenderId : "";
  if (!defenderId || defenderId === accountId) return { status: 400, body: { ok: false, error: "bad_defender" } };
  if (!await areFriends(db, accountId, defenderId)) {
    return { status: 403, body: { ok: false, error: "not_friends" } };
  }
  const [snapshot, pairToday] = await Promise.all([
    buildDefenseSnapshot(db, defenderId, mode),
    db.prepare(`SELECT COUNT(*) AS n FROM pvp_sessions_v3
      WHERE attacker_id = ? AND defender_id = ? AND started_at >= ?`)
      .bind(accountId, defenderId, dayBucket(now) * DAY_MS).first<{ n: number }>(),
  ]);
  if (!snapshot.ok) {
    const status = snapshot.error === "defender_level" ? 403 : snapshot.error === "no_defense" ? 409 : 400;
    return { status, body: { ok: false, error: snapshot.error } };
  }
  return { status: 200, body: { ok: true,
    mode,
    defenderName: snapshot.defenderName,
    defenseScore: snapshot.score,
    /** The defense GROUP's tier — also exactly what a win against it pays. */
    attackerTier: snapshot.tier,
    defenders: snapshot.defenders,
    authored: snapshot.authored,
    pairAttacksToday: pairToday?.n ?? 0,
    pairAttackLimit: PVP_DAILY_ATTACKS_PER_PAIR,
  } };
}

// ---------------------------------------------------------------------------
// History, stats, claims, replays.

export interface PvpHistoryEntry {
  sessionId: string;
  otherName: string;
  finishedAt: number;
  /** Whether the ATTACKER won the fight. */
  attackerWon: boolean;
  attackScore: number;
  defenseScore: number;
  /** Whether this row paid (attack rows: the win was inside the daily cap; defense
   *  rows: the held defense parked a reward). */
  rewarded: boolean;
  /** Set on defense rows where the defense held, the reward was inside the daily
   *  cap, and it is still unclaimed. */
  claimableTier?: number;
  /** The pinned config + transcript still exist and match the live ruleset, so the
   *  fight can be watched. */
  replayAvailable?: boolean;
}

interface HistoryRow extends SessionRow {
  has_replay: number;
}

export interface PvpStatLine {
  attackWins: number;
  attackLosses: number;
  defenseWins: number;
  defenseLosses: number;
}

export async function historyPvp(
  db: D1Database,
  accountId: string,
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const dayStart = dayBucket(now) * DAY_MS;
  const roleQuery = (role: "attacker_id" | "defender_id") => db.prepare(
    `SELECT id, attacker_id, defender_id, finished_at, win, attack_score, defense_score,
       boosts_json, defense_claimed_at, attacker_rewarded, defense_rewarded, ruleset_version,
       (config_json <> '{}' AND inputs_json IS NOT NULL) AS has_replay
     FROM pvp_sessions_v3 WHERE ${role} = ? AND win IS NOT NULL
     ORDER BY finished_at DESC LIMIT ?`)
    .bind(accountId, PVP_REPLAYS_KEPT).all<HistoryRow>();
  const [attackRows, defenseRows, lifetimeRow, weekRow, todayRow, claimRows] = await Promise.all([
    roleQuery("attacker_id"),
    roleQuery("defender_id"),
    db.prepare("SELECT * FROM pvp_stats_v3 WHERE account_id = ?").bind(accountId)
      .first<{ attack_wins: number; attack_losses: number; defense_wins: number; defense_losses: number }>(),
    db.prepare(`SELECT
        SUM(CASE WHEN attacker_id = ?1 AND win = 1 THEN 1 ELSE 0 END) AS aw,
        SUM(CASE WHEN attacker_id = ?1 AND win = 0 THEN 1 ELSE 0 END) AS al,
        SUM(CASE WHEN defender_id = ?1 AND win = 0 THEN 1 ELSE 0 END) AS dw,
        SUM(CASE WHEN defender_id = ?1 AND win = 1 THEN 1 ELSE 0 END) AS dl
      FROM pvp_sessions_v3
      WHERE (attacker_id = ?1 OR defender_id = ?1) AND win IS NOT NULL AND finished_at >= ?2`)
      .bind(accountId, now - WEEK_MS).first<{ aw: number | null; al: number | null; dw: number | null; dl: number | null }>(),
    db.prepare(`SELECT
        SUM(CASE WHEN attacker_id = ?1 AND win = 1 AND attacker_rewarded = 1 THEN 1 ELSE 0 END) AS rw,
        SUM(CASE WHEN defender_id = ?1 AND win = 0 AND defense_rewarded = 1 THEN 1 ELSE 0 END) AS rd
      FROM pvp_sessions_v3
      WHERE (attacker_id = ?1 OR defender_id = ?1) AND finished_at >= ?2`)
      .bind(accountId, dayStart).first<{ rw: number | null; rd: number | null }>(),
    // The claim backlog can be OLDER than the history window — rewards accumulate
    // forever — so it is aggregated separately from the rolling last-10 lists.
    db.prepare(`SELECT boosts_json FROM pvp_sessions_v3
      WHERE defender_id = ? AND win = 0 AND defense_rewarded = 1 AND defense_claimed_at IS NULL
      LIMIT ?`).bind(accountId, CLAIM_ALL_SLICE + 1).all<{ boosts_json: string }>(),
  ]);

  const attacks = attackRows.results ?? [];
  const defenses = defenseRows.results ?? [];
  const otherIds = [...new Set([
    ...attacks.map((s) => s.defender_id),
    ...defenses.map((s) => s.attacker_id),
  ])];
  const names = new Map<string, string>();
  if (otherIds.length) {
    const placeholders = otherIds.map(() => "?").join(",");
    const accounts = await db.prepare(`SELECT id, username FROM accounts WHERE id IN (${placeholders})`)
      .bind(...otherIds).all<{ id: string; username: string | null }>();
    for (const row of accounts.results ?? []) names.set(row.id, row.username?.trim() || "A friend");
  }
  const toEntry = (s: HistoryRow, role: "attacker" | "defender"): PvpHistoryEntry => {
    const tiers = parse<{ defenderTier?: number }>(s.boosts_json, {});
    const claimable = role === "defender" && s.win === 0 && s.defense_rewarded === 1
      && s.defense_claimed_at == null;
    return {
      sessionId: s.id,
      otherName: names.get(role === "attacker" ? s.defender_id : s.attacker_id) ?? "A friend",
      finishedAt: s.finished_at ?? 0,
      attackerWon: s.win === 1,
      attackScore: s.attack_score,
      defenseScore: s.defense_score,
      rewarded: role === "attacker" ? s.attacker_rewarded === 1 : s.defense_rewarded === 1,
      ...(claimable ? { claimableTier: tiers.defenderTier ?? 1 } : {}),
      ...(s.has_replay && s.ruleset_version === RAID_RULESET_VERSION ? { replayAvailable: true } : {}),
    };
  };

  const claimTiers = (claimRows.results ?? []).slice(0, CLAIM_ALL_SLICE)
    .map((row) => parse<{ defenderTier?: number }>(row.boosts_json, {}).defenderTier ?? 1);
  const lifetime: PvpStatLine = {
    attackWins: lifetimeRow?.attack_wins ?? 0,
    attackLosses: lifetimeRow?.attack_losses ?? 0,
    defenseWins: lifetimeRow?.defense_wins ?? 0,
    defenseLosses: lifetimeRow?.defense_losses ?? 0,
  };
  const week: PvpStatLine = {
    attackWins: weekRow?.aw ?? 0,
    attackLosses: weekRow?.al ?? 0,
    defenseWins: weekRow?.dw ?? 0,
    defenseLosses: weekRow?.dl ?? 0,
  };
  return { status: 200, body: { ok: true,
    attacks: attacks.map((s) => toEntry(s, "attacker")),
    defenses: defenses.map((s) => toEntry(s, "defender")),
    stats: { lifetime, week },
    claim: {
      count: claimTiers.length,
      rewards: mergeTierRewards(claimTiers),
      more: (claimRows.results ?? []).length > CLAIM_ALL_SLICE,
    },
    rewardedWinsToday: todayRow?.rw ?? 0,
    rewardedDefensesToday: todayRow?.rd ?? 0,
    rewardedWinsPerDay: PVP_DAILY_REWARDED_WINS,
    rewardedDefensesPerDay: PVP_DAILY_REWARDED_DEFENSES,
  } };
}

/** The defender collects a successful defense's reward — claim-on-login, one time.
 *  This and collect-all are the only PvP writes into the defender's account, and
 *  they are the caller. */
export async function collectPvp(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown },
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return { status: 400, body: { error: "bad_session" } };
  const session = await db.prepare(`SELECT id, defender_id, win, boosts_json, defense_claimed_at, defense_rewarded
    FROM pvp_sessions_v3 WHERE id = ? AND defender_id = ?`)
    .bind(body.sessionId, accountId).first<SessionRow>();
  if (!session) return { status: 404, body: { error: "bad_session" } };
  if (session.win !== 0) return { status: 409, body: { error: "not_defended" } };
  if (session.defense_rewarded !== 1) return { status: 409, body: { error: "not_rewarded" } };
  if (session.defense_claimed_at != null) return { status: 409, body: { error: "already_claimed" } };
  const tiers = parse<{ defenderTier?: number }>(session.boosts_json, {});
  const rewards = pvpRewardsForTier(tiers.defenderTier ?? 1);
  const coreRow = await db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?")
    .bind(accountId).first<{ current_json: string }>();
  if (!coreRow) return { status: 409, body: { error: "state_conflict" } };
  const core = parse<CoreState>(coreRow.current_json, { inventory: {} });
  grantBoosts(core, rewards);
  const guard = `EXISTS (SELECT 1 FROM pvp_sessions_v3 s
    WHERE s.id = ? AND s.defender_id = ? AND s.defense_claimed_at = ?)`;
  const committed = await db.batch([
    db.prepare(`UPDATE pvp_sessions_v3 SET defense_claimed_at = ?
      WHERE id = ? AND defender_id = ? AND win = 0 AND defense_claimed_at IS NULL`)
      .bind(now, session.id, accountId),
    db.prepare(`UPDATE gameplay_documents_v3 SET current_json = ?, updated_at = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(JSON.stringify(core), now, accountId, session.id, accountId, now),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, 'pvp_defense_collect', ?, ? WHERE ${guard}`)
      .bind(crypto.randomUUID(), accountId,
        JSON.stringify({ sessionId: session.id, rewards, tier: tiers.defenderTier ?? 1 }), now,
        session.id, accountId, now),
  ]);
  if ((committed[0]?.meta.changes ?? 0) !== 1) return { status: 409, body: { error: "already_claimed" } };
  return { status: 200, body: { ok: true, rewards, tier: tiers.defenderTier ?? 1, inventory: core.inventory, serverTime: now } };
}

/** Claim EVERY outstanding defense reward in one go — the "back after a month, 50
 *  defenses held" path. Works a bounded slice per call (`remaining: true` says call
 *  again). Each row's claim stamp is CAS'd and the inventory grant is guarded on ALL
 *  of this call's stamps landing; if a concurrent claim stole a row mid-flight the
 *  whole slice is rolled back and the caller retries — realistic contention is one
 *  player double-tapping a button, so the conflict path is a 409, not an over-pay. */
export async function collectAllPvp(
  db: D1Database,
  accountId: string,
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const claimable = await db.prepare(`SELECT id, boosts_json FROM pvp_sessions_v3
    WHERE defender_id = ? AND win = 0 AND defense_rewarded = 1 AND defense_claimed_at IS NULL
    LIMIT ?`).bind(accountId, CLAIM_ALL_SLICE + 1).all<{ id: string; boosts_json: string }>();
  const rows = (claimable.results ?? []).slice(0, CLAIM_ALL_SLICE);
  const remaining = (claimable.results ?? []).length > CLAIM_ALL_SLICE;
  if (!rows.length) return { status: 200, body: { ok: true, claimed: 0, rewards: [], remaining: false, serverTime: now } };
  const tiers = rows.map((row) => parse<{ defenderTier?: number }>(row.boosts_json, {}).defenderTier ?? 1);
  const rewards = mergeTierRewards(tiers);
  const coreRow = await db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?")
    .bind(accountId).first<{ current_json: string }>();
  if (!coreRow) return { status: 409, body: { error: "state_conflict" } };
  const core = parse<CoreState>(coreRow.current_json, { inventory: {} });
  grantBoosts(core, rewards);
  const countGuard = `(SELECT COUNT(*) FROM pvp_sessions_v3
    WHERE defender_id = ? AND defense_claimed_at = ?) = ?`;
  const statements: D1PreparedStatement[] = rows.map((row) =>
    db.prepare(`UPDATE pvp_sessions_v3 SET defense_claimed_at = ?
      WHERE id = ? AND defender_id = ? AND defense_claimed_at IS NULL`)
      .bind(now, row.id, accountId));
  statements.push(
    db.prepare(`UPDATE gameplay_documents_v3 SET current_json = ?, updated_at = ?
      WHERE account_id = ? AND ${countGuard}`)
      .bind(JSON.stringify(core), now, accountId, accountId, now, rows.length),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, 'pvp_defense_collect_all', ?, ? WHERE ${countGuard}`)
      .bind(crypto.randomUUID(), accountId,
        JSON.stringify({ claimed: rows.length, rewards }), now, accountId, now, rows.length),
  );
  const committed = await db.batch(statements);
  const paid = (committed[rows.length]?.meta.changes ?? 0) === 1;
  if (!paid) {
    // A row was claimed between the pre-read and the batch: unwind THIS call's
    // stamps (uniquely identified by defender + this exact timestamp) so nothing is
    // marked claimed-but-unpaid, and let the caller retry.
    await db.prepare(`UPDATE pvp_sessions_v3 SET defense_claimed_at = NULL
      WHERE defender_id = ? AND defense_claimed_at = ?`).bind(accountId, now).run();
    return { status: 409, body: { error: "claim_conflict" } };
  }
  return { status: 200, body: { ok: true, claimed: rows.length, rewards, remaining, inventory: core.inventory, serverTime: now } };
}

/** Fetch one fight's stored replay (pinned config + verified transcript) for the
 *  playback viewer. Party-only; refuses a swept recording or one recorded under an
 *  older ruleset (the current sim would silently play a different fight). */
export async function replayPvp(
  db: D1Database,
  accountId: string,
  sessionId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!sessionId) return { status: 400, body: { error: "bad_session" } };
  const session = await db.prepare(`SELECT id, attacker_id, defender_id, config_json, inputs_json,
      final_tick, win, ruleset_version FROM pvp_sessions_v3
    WHERE id = ? AND (attacker_id = ? OR defender_id = ?)`)
    .bind(sessionId, accountId, accountId).first<SessionRow>();
  if (!session || session.win == null) return { status: 404, body: { error: "bad_session" } };
  if (session.config_json === "{}" || session.inputs_json == null) {
    return { status: 410, body: { error: "replay_expired" } };
  }
  if (session.ruleset_version !== RAID_RULESET_VERSION) {
    return { status: 409, body: { error: "stale_replay" } };
  }
  const config = parse<PinnedPvpConfig | null>(session.config_json, null);
  if (!config) return { status: 410, body: { error: "replay_expired" } };
  const attacker = await db.prepare("SELECT username FROM accounts WHERE id = ?")
    .bind(session.attacker_id).first<{ username: string | null }>();
  return { status: 200, body: { ok: true,
    config,
    finalTick: session.final_tick ?? 0,
    inputs: parse<RaidReplayInput[]>(session.inputs_json, []),
    attackerWon: session.win === 1,
    attackerName: attacker?.username?.trim() || "A friend",
    role: session.attacker_id === accountId ? "attacker" : "defender",
  } };
}

export type { PvpDefenderPreview };
