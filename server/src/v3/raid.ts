import { BRAIN_TICKET_KEY, DICE_KEY, CONCENTRATION_KEY, VOUCHER_KEY, MAX_STACK } from "../boostCatalog";
import { XP_THRESHOLDS, levelForXp, levelUpBrains } from "../levels";
import { ownedLootCounter, resolveLoot, rollLoot } from "../loot";
import { raidEcon, raidUnlocked, winGold } from "../raidCatalog";
import { invasionWinXp } from "../../../src/raid/repeatXp";
import { applyQuestEvents, CONFIG_SPENT, MEMORIAL_GRAVEYARD_CAP } from "./engine";
import { applyPeriodicEvents, refreshPeriodicState, xpToNextLevel } from "../../../src/quest/periodic/generate";
import type { PeriodicQuestState } from "../../../src/quest/periodic/types";
import type { PeriodicQuestProjection, QuestProjection } from "../../../src/net/protocol";
import type { RaidOutcome } from "../../../src/raid/types";
import raidRows from "../../../public/assets/raids/raids.json";
import { activeBonusHeadId, farmerCooldownMs } from "../../../src/farmer";
import { buildPinnedV3Raid, verifyRaid, RAID_RULESET_VERSION, type PinnedRaidConfig, type RaidReplayInput } from "../raidVerifier";
import { rollBrainDrop, rollBrainDropWithPity, nextBrainDryStreak, firstClearBrains } from "../../../src/raid/brainDrops";
import { ELITE_BRAIN_LUCK } from "../../../src/raid/eliteInvasion";
import { rollRaidZombieDropWithPity, nextRaidZombieDryWins, hasRaidZombieDrop,
  RARE_INVASION_ZOMBIE_SUBJECT } from "../../../src/raid/zombieDrops";
import { raidFeatQuestEvents } from "../../../src/raid/featQuestEvents";
import objectRows from "../../../public/assets/placeables.json";
import { shouldStoreEpicReward } from "../../../src/epicBoss/rewards";
import { encodeReceivedZombie } from "../../../src/zombie/receivedReward";
import { isLiveSessionCollision } from "./liveSessionRace";

const DEFAULT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/** How long an invasion session may sit open before it is treated as ABANDONED and
 *  its roster released. That is the whole job, and the only one it can do well.
 *
 *  It used to void the fight as well — a finish arriving after it was answered 200 with
 *  `{expired:true}` and nothing else, no replay, whatever the battle had done. That
 *  predates deterministic replay and outlived its reason. Nothing about a LATE
 *  transcript is easier to forge than a prompt one: the fight is replayed byte-for-byte
 *  from the `config_json` pinned at /raid/start, `pacedTick` still refuses a finalTick
 *  ahead of wall clock, and `RAID_MAX_TICKS` caps any replay at four simulated minutes
 *  however long the session has been open. So the clock was gating rewards it was not
 *  protecting.
 *
 *  Meanwhile an honest player reaches it easily, because the fight does NOT run on wall
 *  clock — it is driven by the Pixi ticker, so a backgrounded tab or a locked phone
 *  freezes the battle while this keeps counting. Prod bore that out: 11 sessions across
 *  11 accounts in 8 days, 18 to 785 minutes late, one apiece. Not a client defect;
 *  people walking away mid-fight and coming back.
 *
 *  Fifteen minutes is RIGHT for the job that remains, and deliberately not raised:
 *  a player who abandoned a fight wants their zombies back promptly, and the lock is
 *  the real correctness boundary — while it is held, nothing else can have touched
 *  those units, which is exactly the condition under which a late settlement is safe to
 *  pay. `finishRaid` therefore keys on the lock (`finished_at IS NULL`), not the clock. */
const RAID_TTL_MS = 15 * 60 * 1000;
const EARLIEST_FINISH_MS = 15_000;

interface CoreState {
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  farmerHeadId?: number;
  farmerBonusHeadId?: number | null;
  zombieMax?: number;
  [key: string]: unknown;
}

interface UnitRow { unit_id: string }
interface RaidStateRow {
  last_started_at: number;
  progress_json: string;
  brain_dry_streak: number;
  zombie_dry_json: string;
}
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
const objectArmyCapacity = new Map(
  (objectRows as Array<{ key: string; armyMax?: number }>).map((o) => [o.key, o.armyMax ?? 0])
);

/** The win's brain drop. Rolled once at /raid/start — the client shows the pickup during
 *  the fight — and PINNED in the session's `boosts_json` so /raid/finish pays exactly what
 *  was shown, then credited only after the replay verifies the boss died.
 *
 *  It used to be DERIVED from the session id instead of stored, which made the amount a
 *  pure function of a value handed to the client at /raid/start: a player could compute
 *  the pending roll before choosing to fight. The pin costs a field and closes that.
 *
 *  `dryStreak` is the account's brain-eligible invasions since its last brain
 *  (raid_state_v3.brain_dry_streak): at the threshold the roll's zero is floored to one
 *  brain. Silent by design — the pinned amount is the only thing that reaches the client,
 *  and a floored drop looks exactly like a rolled one. */
function rollPinnedBrainDrop(
  recommendedLevel: number,
  hasBoss: boolean,
  dryStreak: number,
  luck: number
): number {
  return hasBoss ? rollBrainDropWithPity(recommendedLevel, dryStreak, Math.random, luck) : 0;
}

/** Brain drop for a session opened BEFORE the amount was pinned (legacy derivation, kept
 *  only so in-flight sessions still pay what their /raid/start response promised). Those
 *  expire within RAID_TTL_MS of the deploy, after which this is dead. */
function legacyBrainDrop(sessionId: string, recommendedLevel: number, hasBoss: boolean): number {
  if (!hasBoss) return 0;
  let salt = 17;
  return rollBrainDrop(recommendedLevel, () => {
    let h = 2166136261 ^ salt++;
    for (let i = 0; i < sessionId.length; i++) {
      h ^= sessionId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 0x1_0000_0000;
  });
}

/** Releases a settled invasion's roster and ticks veterancy in ONE write per zombie.
 *
 *  Every survivor's row used to be written TWICE per invasion — once to bump `invasions`,
 *  once to drop the lock — which across the beta was 420k of 5.9M rows written, about 7% of
 *  the entire D1 write bill, for nothing the unlock was not already carrying.
 *
 *  The CASE is load-bearing and must not be simplified into a blanket `+ 1`. By the time
 *  this runs the casualties are already deleted, so the rows still locked by this session
 *  are everyone who was NOT killed — a SUPERSET of `survivors`. A retreat brings zombies
 *  home that the replay does not count as survivors, and a concession fallback empties
 *  `survivors` outright while still releasing the whole roster. Those come home WITHOUT a
 *  veterancy tick. Veterancy is +5% a rank, so a blanket bump would quietly inflate the
 *  army on every retreat.
 *
 *  Binds in order: the survivor ids, then accountId, sessionId, and whatever `guard` takes.
 *  Exported so raidSettlementWrites.test.ts can run this exact string against real SQLite —
 *  the risk here is in the SQL, not in the surrounding TypeScript. */
export function releaseRosterSql(survivors: string[], guard: string): string {
  const veterancy = survivors.length
    ? `invasions + CASE WHEN unit_id IN (${survivors.map(() => "?").join(",")}) THEN 1 ELSE 0 END`
    : "invasions";
  return `UPDATE roster_v3 SET locked_by_raid = NULL, invasions = ${veterancy}
    WHERE account_id = ? AND locked_by_raid = ? AND ${guard}`;
}

export async function expireLiveRaid(db: D1Database, accountId: string, now: number): Promise<void> {
  const expired = await db.prepare(`SELECT id FROM raid_sessions_v3
    WHERE account_id = ? AND finished_at IS NULL AND expires_at <= ?`)
    .bind(accountId, now).first<{ id: string }>();
  if (!expired) return;
  await db.batch([
    db.prepare(`UPDATE raid_sessions_v3 SET finished_at = ?, config_json = ${CONFIG_SPENT}
      WHERE id = ? AND finished_at IS NULL`).bind(now, expired.id),
    db.prepare("UPDATE roster_v3 SET locked_by_raid = NULL WHERE account_id = ? AND locked_by_raid = ?").bind(accountId, expired.id),
  ]);
}

export async function startRaid(
  db: D1Database,
  accountId: string,
  body: { raidId?: unknown; orderedUnitIds?: unknown; useVoucher?: unknown; brainTicket?: unknown; concentration?: unknown; dice?: unknown; rulesetVersion?: unknown },
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
  // Minted before the wave is pinned: it doubles as the seed for any per-fight
  // randomness in the wave (the Robots' random boss), and the client redraws the same
  // wave from the session id this response returns.
  const sessionId = crypto.randomUUID();
  // The gameplay document is read BEFORE the wave is pinned, because whether the player
  // owns a Brain Ticket decides whether the pinned wave is the elite one. Owning none is
  // not settled here — it is refused alongside the other inventory gates below, with the
  // wave pinned as an ordinary invasion that is then never used.
  const coreRow = await db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?")
    .bind(accountId).first<{ current_json: string }>();
  const wantsElite = body.brainTicket === true;
  const ticketsOwned = parse<CoreState>(coreRow?.current_json ?? "", { inventory: {}, storage: { received: {}, stored: {} } })
    .inventory[BRAIN_TICKET_KEY] ?? 0;
  const elite = wantsElite && ticketsOwned >= 1;
  const pinned = await buildPinnedV3Raid(db, accountId, raidId, body.orderedUnitIds, concentration, sessionId, elite);
  if (!pinned.ok) {
    const status = pinned.error === "locked" ? 403 : pinned.error === "bad_raid" || pinned.error === "bad_roster" ? 400 : 409;
    return { status, body: { ok: false, error: pinned.error } };
  }
  const [balance, raidState, live, liveEpic, roster] = await Promise.all([
    db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?").bind(accountId).first<{ gold: number; brains: number; xp: number }>(),
    db.prepare("SELECT last_started_at, progress_json, brain_dry_streak FROM raid_state_v3 WHERE account_id = ?")
      .bind(accountId).first<Pick<RaidStateRow, "last_started_at" | "progress_json" | "brain_dry_streak">>(),
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
  const activeCooldownMs = farmerCooldownMs(cooldownMs, activeBonusHeadId(core.farmerHeadId ?? 1, core.farmerBonusHeadId));
  const remaining = Math.max(0, raidState.last_started_at + activeCooldownMs - now);
  const useVoucher = body.useVoucher === true;
  // A Brain Ticket covers the wait as well as the difficulty — charging a voucher on top
  // of it would bill the player twice for one bypass.
  if (wantsElite && !elite) return { status: 409, body: { ok: false, error: "no_brain_ticket" } };
  const voucherBypass = remaining > 0 && !elite;
  if (remaining && !useVoucher && !elite) return { status: 429, body: { ok: false, error: "cooldown", cooldownRemaining: remaining } };
  if (voucherBypass && (core.inventory[VOUCHER_KEY] ?? 0) < 1) return { status: 409, body: { ok: false, error: "no_voucher" } };
  const dice = Math.max(0, Math.min(10, Math.trunc(Number(body.dice) || 0)));
  if ((core.inventory[DICE_KEY] ?? 0) < dice) return { status: 409, body: { ok: false, error: "insufficient_dice" } };
  if (concentration && (core.inventory[CONCENTRATION_KEY] ?? 0) < 1) return { status: 409, body: { ok: false, error: "no_concentration" } };
  // Re-read from `core` rather than trusting the count taken before the pin: this is the
  // copy that gets written back, so the debit has to come off it.
  if (elite && (core.inventory[BRAIN_TICKET_KEY] ?? 0) < 1) return { status: 409, body: { ok: false, error: "no_brain_ticket" } };
  if (elite) core.inventory[BRAIN_TICKET_KEY]--;
  if (voucherBypass) core.inventory[VOUCHER_KEY]--;
  if (dice) core.inventory[DICE_KEY] -= dice;
  if (concentration) core.inventory[CONCENTRATION_KEY]--;
  const brainDrop = rollPinnedBrainDrop(
    econ.recLevel,
    pinned.config.enemyUnits.some((unit) => unit.isBoss),
    raidState.brain_dry_streak ?? 0,
    elite ? ELITE_BRAIN_LUCK : 1
  );
  const expiresAt = now + RAID_TTL_MS;
  const earliestFinishAt = now + EARLIEST_FINISH_MS;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO raid_sessions_v3
      (id, account_id, raid_id, roster_json, boosts_json, config_json, ruleset_version, started_at, earliest_finish_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, accountId, String(raidId), JSON.stringify(requested), JSON.stringify({ dice, concentration, brainDrop, elite }),
        JSON.stringify(pinned.config), RAID_RULESET_VERSION, now, earliestFinishAt, expiresAt),
    db.prepare("UPDATE raid_state_v3 SET last_started_at = ? WHERE account_id = ?").bind(now, accountId),
    db.prepare("UPDATE gameplay_documents_v3 SET current_json = ?, updated_at = ? WHERE account_id = ?")
      .bind(JSON.stringify(core), now, accountId),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      VALUES(?,?, 'raid_start', ?, ?)`)
      .bind(crypto.randomUUID(), accountId, JSON.stringify({ sessionId, raidId, roster: requested, dice, concentration, elite, bypassed: remaining > 0 }), now),
  ];
  // One statement for the whole army. `locked_by_raid IS NULL` still gates each row
  // individually, so a unit locked between the pre-check above and this write is skipped
  // exactly as it was when this ran a statement per zombie — the set of rows written is
  // unchanged, only the number of round trips inside the batch.
  statements.push(db.prepare(`UPDATE roster_v3 SET locked_by_raid = ?
    WHERE account_id = ? AND locked_by_raid IS NULL
      AND unit_id IN (${requested.map(() => "?").join(",")})`)
    .bind(sessionId, accountId, ...requested));
  try {
    await db.batch(statements);
  } catch (error) {
    // Two starts tied: both read "no live session" above, and idx_raid_v3_live refused
    // the second insert. The same answer the read gives, not a 500 (liveSessionRace.ts).
    if (isLiveSessionCollision(error)) return { status: 409, body: { ok: false, error: "raid_in_progress" } };
    throw error;
  }
  return { status: 200, body: { ok: true, sessionId, bypassed: remaining > 0, dice,
    concentration, elite, brainDrop, inventory: core.inventory, lastRaidAt: now, expiresAt, earliestFinishAt,
    serverTime: now,
    rulesetVersion: RAID_RULESET_VERSION } };
}

async function closeInvalidRaid(
  db: D1Database,
  accountId: string,
  sessionId: string,
  now: number,
  rejection?: { raidId: string; error: string; finalTick: unknown; clientWin: unknown; inputCount: number }
): Promise<void> {
  const statements = [
    db.prepare(`UPDATE raid_sessions_v3 SET finished_at=?, config_json=${CONFIG_SPENT}
      WHERE id=? AND account_id=? AND finished_at IS NULL`)
      .bind(now, sessionId, accountId),
    db.prepare("UPDATE roster_v3 SET locked_by_raid=NULL WHERE account_id=? AND locked_by_raid=?")
      .bind(accountId, sessionId),
  ];
  if (rejection) statements.push(
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      VALUES(?,?, 'raid_finish_rejected', ?, ?)`)
      .bind(crypto.randomUUID(), accountId, JSON.stringify({ sessionId, ...rejection }), now)
  );
  await db.batch(statements);
}

export async function finishRaid(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown; finalTick?: unknown; inputs?: unknown; clientWin?: unknown; clientLosses?: unknown },
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return { status: 400, body: { error: "bad_session" } };
  // CONCESSION ONLY. The server's replay stays authoritative for everything it can see;
  // this flag is ANDed with it below, so a client can only ever turn its own win into a
  // loss (pure self-harm — it forfeits gold, XP, brains, loot and the first clear). It
  // exists because client-only hazards are deliberately omitted from the server's replay
  // (see RaidManager.crabOf): the server simulates the UN-HARASSED fight, an optimistic
  // ceiling, so a fight the player actually lost to a crab must be allowed to count as
  // lost. Absent (older clients) = no concession.
  if (body.clientWin !== undefined && typeof body.clientWin !== "boolean") {
    return { status: 400, body: { error: "bad_client_win" } };
  }
  const conceded = body.clientWin === false;
  // Deaths the LIVE fight suffered that the server's hazard-free replay did not. Same
  // one-way rule as `clientWin` (see the merge below). Bounded by the army cap so a
  // malformed body can't build an unbounded IN (...) clause downstream.
  if (body.clientLosses !== undefined &&
      (!Array.isArray(body.clientLosses) || body.clientLosses.length > 64 ||
       body.clientLosses.some((id) => typeof id !== "string"))) {
    return { status: 400, body: { error: "bad_client_losses" } };
  }
  const clientLosses = [...new Set((body.clientLosses as string[] | undefined) ?? [])];
  const session = await db.prepare("SELECT * FROM raid_sessions_v3 WHERE id = ? AND account_id = ?")
    .bind(body.sessionId, accountId).first<SessionRow>();
  if (!session) return { status: 404, body: { error: "bad_session" } };
  if (session.result_json) {
    return { status: 200, body: { ...parse<Record<string, unknown>>(session.result_json, {}), serverTime: now } };
  }
  if (session.finished_at) return { status: 409, body: { error: "already_finished" } };
  // NO expiry gate here on purpose — see RAID_TTL_MS. A session still holding its
  // roster lock is settled on its merits however late it arrives; one whose lock has
  // already been released by `expireLiveRaid` was caught by the `finished_at` check
  // above and answers 409, because those units are free again and may since have fought
  // elsewhere, which makes retroactive casualties and veterancy unsound rather than
  // merely generous.
  const locked = parse<string[]>(session.roster_json, []);
  if (session.ruleset_version !== RAID_RULESET_VERSION) {
    await closeInvalidRaid(db, accountId, session.id, now, {
      raidId: session.raid_id, error: "stale_ruleset", finalTick: body.finalTick,
      clientWin: body.clientWin, inputCount: Array.isArray(body.inputs) ? body.inputs.length : 0,
    });
    return { status: 409, body: { error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION } };
  }
  const pacedTick = Math.floor((now - session.started_at) / 50) + 40;
  if (Number(body.finalTick) > pacedTick) return { status: 422, body: { error: "future_finish" } };
  let config: PinnedRaidConfig;
  try { config = JSON.parse(session.config_json) as PinnedRaidConfig; }
  catch {
    await closeInvalidRaid(db, accountId, session.id, now, {
      raidId: session.raid_id, error: "bad_session_config", finalTick: body.finalTick,
      clientWin: body.clientWin, inputCount: Array.isArray(body.inputs) ? body.inputs.length : 0,
    });
    return { status: 409, body: { error: "bad_session_config" } };
  }
  if (!Array.isArray(config.playerUnits) || !Array.isArray(config.enemyUnits) ||
      !Array.isArray(config.rosterIds) || config.rosterIds.length !== locked.length) {
    await closeInvalidRaid(db, accountId, session.id, now, {
      raidId: session.raid_id, error: "bad_session_config", finalTick: body.finalTick,
      clientWin: body.clientWin, inputCount: Array.isArray(body.inputs) ? body.inputs.length : 0,
    });
    return { status: 409, body: { error: "bad_session_config" } };
  }
  const verified = verifyRaid(config, body.finalTick as number, body.inputs as RaidReplayInput[]);
  // How far the replay had to depart from the client's account of the fight. Zero on a
  // fight both simulations agreed on, so a non-zero rate on a raid is the signal that
  // caught the ruleset-14 wall desync — keep it queryable rather than player-facing.
  const divergence = verified.ok &&
    (verified.divergence.overrunTicks || verified.divergence.inputsAfterFinish ||
     verified.divergence.refusedInputs)
    ? verified.divergence
    : null;
  // Client-only hazards can make the visible fight finish after the two deterministic
  // simulations have diverged. In that case the server may still be fighting
  // (`truncated_transcript`) or may disagree about a post-divergence interaction. A
  // client concession is pure self-harm, so accept only those divergence-shaped replay
  // failures as a zero-reward loss. Structural transcript failures remain rejected.
  // The three `illegal_*` entries are kept for older clients only: since the finish path
  // started dropping refused taps (see advanceRaidSegment) the replay no longer returns
  // them, and a WIN that used to die here now settles on the server's own fight.
  const concessionReplayErrors = new Set([
    "truncated_transcript", "illegal_bubble", "illegal_ability", "illegal_wall_tap",
    "input_after_finish",
  ]);
  const concessionFallbackError = !verified.ok && conceded && concessionReplayErrors.has(verified.error)
    ? verified.error
    : null;
  if (!verified.ok && !concessionFallbackError) {
    await closeInvalidRaid(db, accountId, session.id, now, {
      raidId: session.raid_id, error: verified.error, finalTick: body.finalTick,
      clientWin: body.clientWin, inputCount: Array.isArray(body.inputs) ? body.inputs.length : 0,
    });
    return { status: 422, body: { error: verified.error } };
  }
  let replaySurvivors: string[];
  let replayLosses: string[];
  let retreated: boolean;
  let replayOutcome: RaidOutcome;
  if (concessionFallbackError) {
    // Do not award unverifiable survivor veterancy. Claimed deaths are applied below;
    // every other locked unit simply returns home unchanged.
    replaySurvivors = locked;
    replayLosses = [];
    retreated = false;
    replayOutcome = { win: false, rounds: 0, survivors: [], losses: [], enemiesBeaten: 0, playerDamage: 0 };
  } else {
    const accepted = verified as Extract<typeof verified, { ok: true }>;
    replaySurvivors = accepted.outcome.survivors;
    replayLosses = accepted.outcome.losses;
    retreated = accepted.retreated;
    replayOutcome = accepted.outcome;
    const accounted = new Set([...replaySurvivors, ...replayLosses]);
    if ([...accounted].some((id) => !locked.includes(id)) || (!retreated && accounted.size !== locked.length)) {
      await closeInvalidRaid(db, accountId, session.id, now, {
        raidId: session.raid_id, error: "replay_roster_mismatch", finalTick: body.finalTick,
        clientWin: body.clientWin, inputCount: Array.isArray(body.inputs) ? body.inputs.length : 0,
      });
      return { status: 422, body: { error: "replay_roster_mismatch" } };
    }
    const replayEscaped = retreated ? locked.filter((id) => !replayLosses.includes(id)) : replaySurvivors;
    if (new Set([...replayEscaped, ...replayLosses]).size !== locked.length ||
        replayEscaped.some((id) => replayLosses.includes(id))) {
      return { status: 400, body: { error: "bad_roster_partition" } };
    }
  }
  const replayEscaped = retreated ? locked.filter((id) => !replayLosses.includes(id)) : replaySurvivors;
  // Fold in the client's CONCEDED deaths. Same one-way rule as `clientWin`: a zombie the
  // server's (hazard-free) replay brought home may be reported dead, never the reverse, and
  // only from this raid's locked roster. Every consequence is self-harm — fewer survivors
  // means less win gold, no perfect-game bonus, no veterancy tick, and a casualty that costs
  // brains to revive — so it needs no authority beyond a membership check. Ids the server
  // already counted dead, or that it never locked, are ignored rather than rejected: a
  // divergent client shouldn't be able to fail its own settlement.
  const concededDeaths = clientLosses.filter((id) => replayEscaped.includes(id));
  const losses = [...replayLosses, ...concededDeaths];
  const escaped = replayEscaped.filter((id) => !concededDeaths.includes(id));
  const survivors = concessionFallbackError
    ? []
    : retreated ? replaySurvivors.filter((id) => !concededDeaths.includes(id)) : escaped;
  // AND, never OR: the client may only drag a win down to a loss (see `conceded` above).
  const win = !retreated && replayOutcome.win && !conceded;
  const raidId = Number(session.raid_id);
  const econ = raidEcon(raidId);
  if (!econ) return { status: 409, body: { error: "bad_raid" } };
  // Materialise the daily/weekly document before reading it. Every OTHER writer of it
  // reaches it through ensureV3 (bootstrap, a command batch, a presentation write); the
  // raid path deliberately loads no projection, so this is the one place that can meet
  // an account which has never had the row created. A missing row is read as null below
  // and answered `state_conflict` — i.e. a won invasion paying nothing — so it is worth
  // one statement to make impossible. Same INSERT OR IGNORE `startRaid` already does for
  // raid_state_v3, and a no-op once 0049's backfill has run.
  await db.prepare(`INSERT OR IGNORE INTO periodic_quest_documents_v3
    (account_id, updated_at) VALUES (?, ?)`).bind(accountId, now).run();
  const [balance, coreRow, raidState, questRow, periodicRow, casualtyRows, presentationRow, objectRow, rosterCounts] = await Promise.all([
    db.prepare("SELECT gold, brains, xp, claimed_level FROM balances WHERE account_id = ?").bind(accountId).first<{ gold: number; brains: number; xp: number; claimed_level: number }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?").bind(accountId).first<{ current_json: string }>(),
    db.prepare("SELECT last_started_at, progress_json, brain_dry_streak, zombie_dry_json FROM raid_state_v3 WHERE account_id = ?").bind(accountId).first<RaidStateRow>(),
    db.prepare("SELECT version, current_json FROM quest_documents_v3 WHERE account_id = ?").bind(accountId).first<QuestRow>(),
    db.prepare("SELECT version, current_json FROM periodic_quest_documents_v3 WHERE account_id = ?").bind(accountId).first<QuestRow>(),
    losses.length
      ? db.prepare(`SELECT unit_id, zombie_key, mutation, invasions, stored, created_at, color FROM roster_v3
          WHERE account_id = ? AND locked_by_raid = ? AND unit_id IN (${losses.map(() => "?").join(",")})`)
        .bind(accountId, session.id, ...losses)
        .all<{ unit_id: string; zombie_key: string; mutation: number; invasions: number; stored: number;
          created_at: number; color: string | null }>()
      : Promise.resolve({ results: [] }),
    // Individual zombie NAMES live only in the client's presentation blob, keyed by
    // unit id. This is the last moment they can be captured: the roster row is about
    // to be deleted, and with it the id that entry hangs off. Read only when someone
    // actually died. A missing name is harmless — the client falls back to the same
    // deterministic default it uses for an unnamed living unit.
    losses.length
      ? db.prepare("SELECT current_json FROM presentations_v3 WHERE account_id = ?")
        .bind(accountId).first<{ current_json: string }>()
      : Promise.resolve(null),
    db.prepare("SELECT current_json FROM object_documents_v3 WHERE account_id = ?")
      .bind(accountId).first<{ current_json: string }>(),
    db.prepare("SELECT stored, COUNT(*) AS count FROM roster_v3 WHERE account_id = ? GROUP BY stored")
      .bind(accountId).all<{ stored: number; count: number }>(),
  ]);
  if (!balance || !coreRow || !raidState || !questRow || !periodicRow || !objectRow) {
    return { status: 409, body: { error: "state_conflict" } };
  }
  const core = parse<CoreState>(coreRow.current_json, { inventory: {}, storage: { received: {}, stored: {} } });
  const objects = parse<Array<{ catalogKey: string; status: string }>>(objectRow.current_json, []);
  const progress = parse<Record<string, number>>(raidState.progress_json, {});
  // Wins of each raid since it last handed over its rare zombie (silent pity — never sent
  // to the client, see zombieDrops.ts). Only the four raids that HAVE a rare zombie ever
  // appear as keys.
  const zombieDry = parse<Record<string, number>>(raidState.zombie_dry_json, {});
  const firstClear = win && !(progress[String(raidId)] > 0);
  const baseGold = win ? winGold(econ, survivors.length / locked.length) : 0;
  const boosts = parse<{ dice?: number; brainDrop?: number; elite?: boolean }>(session.boosts_json, {});
  // Elite is read back from the SESSION, not from this request: the ticket was charged
  // and the wave scaled at /raid/start, so that is where the fact lives.
  const eliteLuck = boosts.elite ? ELITE_BRAIN_LUCK : 1;
  // The first clear pays the enemy's authored bonus; every later win pays the small
  // per-raid trickle, x4 on a Brain Ticket (repeatXp.ts). Priced here from the raid id
  // and the SESSION's elite flag — never from anything the client sent — so a repeat
  // win cannot be re-billed as a first clear.
  const xp = win ? invasionWinXp(raidId, econ.xp, firstClear, !!boosts.elite) : 0;
  const pinnedBrains = Number.isFinite(boosts.brainDrop)
    ? Math.max(0, Math.trunc(boosts.brainDrop as number))
    : null;
  const hasBoss = config.enemyUnits.some((unit) => unit.isBoss);
  const rolledBrains = !win ? 0
    : pinnedBrains ?? legacyBrainDrop(session.id, econ.recLevel, hasBoss);
  // The first-ever clear of an invasion pays a guaranteed brain on top of the roll
  // (2 from the Pirates' unlock level up — see firstClearBrains). Derived from the
  // server's own progress_json + catalog, never the request, and paid even on a
  // boss-less stage: it rewards the clear, not the boss.
  const brains = rolledBrains + (firstClear ? firstClearBrains(econ.unlockLevel) : 0);
  // Advance the silent brain pity counter. Only a WIN against a boss was a real chance at
  // a brain, so only that settles the streak — a loss (paid nothing) and a boss-less stage
  // (can't roll brains) leave it exactly where it was. The streak settles on the ROLLED
  // drop alone: the one-time first-clear grant is deterministic, not a lucky roll, and
  // must not push the RNG guarantee further out for the ladder-climbing players who are
  // exactly the ones collecting first clears.
  const brainDryStreak = win && hasBoss
    ? nextBrainDryStreak(raidState.brain_dry_streak ?? 0, rolledBrains)
    : Math.max(0, Math.trunc(raidState.brain_dry_streak ?? 0));
  // `qty` is present only for a bundled boost drop; the client shows it as "x10".
  let loot: { name: string; kind: "gold" | "boost" | "item"; qty?: number } | null = null;
  let newZombie: { id: string; key: string; stored: boolean; received?: boolean } | null = null;
  let newZombieName: string | null = null;
  let lootGold = 0;
  if (win) {
    progress[String(raidId)] = (progress[String(raidId)] ?? 0) + 1;
    // Ownership spans Received + the shed + placed objects, so a `unique` really does drop
    // once (see ownedLootCounter) and the rarest tier walks down to a repeatable one
    // afterwards. Reading Received alone made every unique re-droppable the moment it was
    // claimed, which is exactly when it leaves Received.
    const name = rollLoot(raidId, boosts.dice ?? 0, ownedLootCounter(core.storage, objects), Math.random(), Math.random());
    const grant = resolveLoot(name, econ.recLevel);
    if (grant.kind === "gold") { lootGold = grant.gold; loot = { name: grant.name, kind: "gold" }; }
    else if (grant.kind === "boost") {
      // Bundled drops (Insta-Grow x10) stack in one go, clamped like every other inventory
      // grant so the count stays inside the plausibility bound.
      core.inventory[grant.key] = Math.min(MAX_STACK, (core.inventory[grant.key] ?? 0) + grant.qty);
      loot = { name: grant.name, kind: "boost", qty: grant.qty };
    }
    else if (grant.kind === "item") { core.storage.received[grant.name] = (core.storage.received[grant.name] ?? 0) + 1; loot = { name: grant.name, kind: "item" }; }
    // Same PINNED dice the item roll uses: they widen the rare-zombie chance too, and the
    // count came from /raid/start (already charged), never from this request.
    const zombieDrop = rollRaidZombieDropWithPity(
      raidId, true, Math.random(), zombieDry[String(raidId)] ?? 0, boosts.dice ?? 0, eliteLuck
    );
    // Settle this raid's dry-win streak on every win it could have dropped from. A win that
    // pays (rolled or floored) resets it; a dry one adds to it. Raids with no rare zombie
    // never get a key at all.
    if (hasRaidZombieDrop(raidId)) {
      zombieDry[String(raidId)] = nextRaidZombieDryWins(zombieDry[String(raidId)] ?? 0, !!zombieDrop);
    }
    if (zombieDrop) {
      const activeCapacity = (core.zombieMax ?? 16) + objects.reduce(
        (total, object) => total +
          (object.status === "placed" ? objectArmyCapacity.get(object.catalogKey) ?? 0 : 0),
        0
      );
      const activeCount = Math.max(
        0,
        (rosterCounts.results.find((row) => !row.stored)?.count ?? 0) - losses.length
      );
      newZombie = {
        id: crypto.randomUUID(),
        key: zombieDrop.key,
        stored: shouldStoreEpicReward(activeCount, activeCapacity),
      };
      if (newZombie.stored) {
        newZombie.received = true;
        const marker = encodeReceivedZombie({ id: newZombie.id, key: newZombie.key, mutation: 0, invasions: 0 });
        core.storage.received[marker] = 1;
      }
      newZombieName = zombieDrop.name;
    }
  }
  const nextBalance = { gold: balance.gold + baseGold + lootGold, brains: balance.brains + brains, xp: balance.xp + xp };
  const questData = parse<{ completed: string[]; progress: QuestProjection["progress"] }>(
    questRow.current_json, { completed: [], progress: [] }
  );
  const quests: QuestProjection = { version: questRow.version, ...questData };
  const raidName = raidNames.get(raidId) ?? String(raidId);
  const questEvents = win ? [
    { type: "kInvasionSuccessfulNotification", subject: raidName },
    ...(losses.length === 0 ? [{ type: "kInvasionPerfectGameNotification", subject: raidName }] : []),
    // The rare invasion zombie also answers to a generic alias, so ONE quest can ask for
    // "a rare zombie from an invasion" without naming which of the four. A blank subject
    // would not do: it is the format's wildcard and would count Bonus Gold as well.
    ...(loot ? [{ type: "kLootItemWonNotification", subject: loot.name }] : []),
    ...(newZombieName
      ? [{ type: "kLootItemWonNotification", subject: newZombieName, aliases: [RARE_INVASION_ZOMBIE_SUBJECT] }]
      : []),
    // Elite + technique events, derived by the SAME shared function the offline build
    // uses. `outcome.feats` comes from the server's own replay of this fight, so none of
    // it is client-asserted.
    ...raidFeatQuestEvents({
      win: true,
      perfect: losses.length === 0,
      elite: !!boosts.elite,
      raidName,
      feats: replayOutcome.feats,
    }),
  ] : [];
  const questChanges = applyQuestEvents(nextBalance, quests, questEvents, {
    inventory: core.inventory,
    storage: core.storage,
  });
  // Daily/weekly quests count invasions too, and this is the only path a win travels —
  // raids deliberately bypass the command lane. Roll the sets forward first (a raid can
  // easily be the first thing a player does after midnight) using the level they held
  // BEFORE this win, so the board they were playing against is the one that pays.
  const periodicLevel = levelForXp(balance.xp);
  const periodic: PeriodicQuestState = parse<PeriodicQuestState>(
    periodicRow.current_json, { daily: null, weekly: null }
  );
  const periodicBefore = JSON.stringify(periodic);
  refreshPeriodicState(periodic, {
    accountId,
    level: periodicLevel,
    xpToNext: xpToNextLevel(periodicLevel, XP_THRESHOLDS),
    now,
  });
  applyPeriodicEvents(periodic, questEvents);
  const periodicChanged = periodicBefore !== JSON.stringify(periodic);
  const periodicQuests: PeriodicQuestProjection = {
    version: periodicRow.version + (periodicChanged ? 1 : 0),
    daily: periodic.daily,
    weekly: periodic.weekly,
  };
  const levelBefore = levelForXp(balance.xp);
  const levelAfter = levelForXp(nextBalance.xp);
  const lastRaidAt = levelAfter > levelBefore ? 0 : raidState.last_started_at;
  nextBalance.brains += levelUpBrains(levelBefore, levelAfter);
  // Report the SETTLED result, not the raw replay: on a concession the reward pipeline
  // above already treated this as a loss, so the echoed outcome must agree or the
  // client's result panel would claim a win it was not paid for.
  const outcome = { ...replayOutcome, win, survivors, losses };
  // unit id -> the name its owner gave it, harvested from the presentation blob
  // before the roster row that entry is keyed to disappears.
  const casualtyNames = new Map<string, string>();
  if (presentationRow) {
    const layout = parse<{ rosterLayout?: { id?: unknown; name?: unknown }[] }>(
      presentationRow.current_json, {}
    ).rosterLayout;
    for (const entry of Array.isArray(layout) ? layout : []) {
      if (typeof entry?.id === "string" && typeof entry.name === "string" && entry.name) {
        casualtyNames.set(entry.id, entry.name.slice(0, 24));
      }
    }
  }
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
  const result = { settlementId, lastRaidAt, serverTime: now, balance: nextBalance, gold: baseGold + lootGold,
    brains, xp: nextBalance.xp - balance.xp, firstClear, loot, newZombie, outcome, questChanges,
    inventory: core.inventory, storage: core.storage, raidProgress: progress, revival,
    periodicQuests, rulesetVersion: RAID_RULESET_VERSION };
  const resultJson = JSON.stringify(result);
  const guard = "EXISTS (SELECT 1 FROM raid_sessions_v3 s WHERE s.id = ? AND s.result_json = ?)";
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE raid_sessions_v3 SET finished_at = ?, result_json = ?, config_json = ${CONFIG_SPENT}
      WHERE id = ? AND finished_at IS NULL`)
      .bind(now, resultJson, session.id),
    db.prepare(`UPDATE balances SET gold = ?, brains = ?, xp = ?, claimed_level = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(nextBalance.gold, nextBalance.brains, nextBalance.xp, levelForXp(nextBalance.xp), accountId, session.id, resultJson),
    db.prepare(`UPDATE gameplay_documents_v3 SET current_json = ?, updated_at = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(JSON.stringify(core), now, accountId, session.id, resultJson),
    db.prepare(`UPDATE raid_state_v3 SET progress_json = ?, last_started_at = ?, brain_dry_streak = ?,
      zombie_dry_json = ? WHERE account_id = ? AND ${guard}`)
      .bind(JSON.stringify(progress), lastRaidAt, brainDryStreak, JSON.stringify(zombieDry), accountId, session.id, resultJson),
    db.prepare(`UPDATE quest_documents_v3 SET version = version + 1, current_json = ?, updated_at = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(JSON.stringify({ completed: quests.completed, progress: quests.progress }), now, accountId, session.id, resultJson),
    db.prepare(`UPDATE periodic_quest_documents_v3 SET version = version + ?, current_json = ?, updated_at = ?
      WHERE account_id = ? AND ${guard}`)
      .bind(periodicChanged ? 1 : 0, JSON.stringify({ daily: periodic.daily, weekly: periodic.weekly }),
        now, accountId, session.id, resultJson),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?, ?, 'raid_finish', ?, ? WHERE ${guard}`)
      .bind(settlementId, accountId, JSON.stringify({ sessionId: session.id, raidId, win, survivors, losses,
        gold: baseGold + lootGold, brains, xp, ...(concessionFallbackError ? { concessionFallbackError } : {}),
        ...(divergence ? { divergence } : {}) }), now,
        session.id, resultJson),
  ];
  if (revival) statements.push(db.prepare(`INSERT OR IGNORE INTO raid_revivals_v3
    (session_id, account_id, casualties_json, created_at) VALUES (?, ?, ?, ?)`)
    .bind(session.id, accountId, JSON.stringify(casualties), now));
  // The graveyard. Written here, at the one moment a zombie stops existing, so a
  // Memorial Statue has something to carve. Anyone the player then buys back at the
  // revival offer is deleted again in resolveRevival — they are not dead after all.
  for (const row of casualtyRows.results ?? []) {
    statements.push(db.prepare(`INSERT INTO fallen_v3
      (account_id, unit_id, zombie_key, name, mutation, invasions, color, died_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
      ON CONFLICT(account_id, unit_id) DO NOTHING`)
      .bind(accountId, row.unit_id, row.zombie_key, casualtyNames.get(row.unit_id) ?? null,
        row.mutation, row.invasions, row.color, now, session.id, resultJson));
  }
  // Keep the graveyard bounded. Only UNENSHRINED rows are candidates: a statue is a
  // monument, and a player who raids for a year must not come back to find the farm
  // covered in bare plinths. Runs after the inserts above, so a settlement that
  // overflows the cap drops the oldest rather than refusing the newest.
  //
  // "Oldest" is COALESCE(released_at, died_at), matching the bootstrap's ORDER BY in
  // v3/db.ts: a zombie taken back off a statue rejoins the graveyard at the top and
  // is aged out by the NEXT sixty losses, not deleted by the first settlement after
  // the statue was sold.
  if (casualties.length) statements.push(db.prepare(`DELETE FROM fallen_v3
    WHERE account_id = ? AND memorial_object_id IS NULL AND unit_id NOT IN (
      SELECT unit_id FROM fallen_v3 WHERE account_id = ? AND memorial_object_id IS NULL
      ORDER BY COALESCE(released_at, died_at) DESC, unit_id LIMIT ?
    ) AND ${guard}`)
    .bind(accountId, accountId, MEMORIAL_GRAVEYARD_CAP, session.id, resultJson));
  // The casualties, in one statement rather than one apiece. Same rows deleted; the win is
  // that a full army costs the batch one statement instead of twenty. Bounded by ARMY_CAP,
  // like the `IN (...)` the roster pre-check at /raid/start already builds.
  if (losses.length) statements.push(db.prepare(`DELETE FROM roster_v3
    WHERE account_id = ? AND locked_by_raid = ?
      AND unit_id IN (${losses.map(() => "?").join(",")}) AND ${guard}`)
    .bind(accountId, session.id, ...losses, session.id, resultJson));
  if (newZombie && !newZombie.received) statements.push(db.prepare(`INSERT INTO roster_v3
    (account_id, unit_id, zombie_key, mutation, invasions, stored, created_at)
    SELECT ?, ?, ?, 0, 0, ?, ? WHERE ${guard}`)
    .bind(accountId, newZombie.id, newZombie.key, newZombie.stored ? 1 : 0, now, session.id, resultJson));
  statements.push(db.prepare(releaseRosterSql(survivors, guard))
    .bind(...survivors, accountId, session.id, session.id, resultJson));
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) {
    const raced = await db.prepare("SELECT result_json FROM raid_sessions_v3 WHERE id = ?").bind(session.id).first<{ result_json: string | null }>();
    return raced?.result_json
      ? { status: 200, body: { ...parse<Record<string, unknown>>(raced.result_json, {}), serverTime: now } }
      : { status: 409, body: { error: "state_conflict" } };
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
  for (const zombie of revived) {
    statements.push(
      db.prepare(`INSERT INTO roster_v3
        (account_id, unit_id, zombie_key, mutation, invasions, stored, locked_by_raid, created_at)
        SELECT ?, ?, ?, ?, ?, ?, NULL, ? WHERE ${guard}`)
        .bind(accountId, zombie.id, zombie.key, zombie.mutation, zombie.invasions,
          zombie.stored ? 1 : 0, zombie.createdAt, body.sessionId, accountId, resolutionId)
    );
    // Bought back, so not dead after all: out of the graveyard. Settlement wrote the
    // row a moment ago, and leaving it would let a Memorial Statue remember a zombie
    // that is standing on the farm.
    statements.push(
      db.prepare(`DELETE FROM fallen_v3 WHERE account_id = ? AND unit_id = ? AND ${guard}`)
        .bind(accountId, zombie.id, body.sessionId, accountId, resolutionId)
    );
  }
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
