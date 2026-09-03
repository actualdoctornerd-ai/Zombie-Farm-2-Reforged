import type { EpicBossProjection, QuestProjection } from "../../../src/net/protocol";
import { epicBossById, epicBossDamage, epicBossDamageTiming, epicBossHp, epicBossUnlockLevel } from "../../../src/epicBoss/catalog";
import type { EpicBossDef } from "../../../src/epicBoss/types";
import { ownedLootCounter } from "../loot";
import { pickByFrequency } from "../../../src/raid/combatStats";
import { applyQuestEvents, CONFIG_SPENT, MEMORIAL_GRAVEYARD_CAP } from "./engine";
import zombieRows from "../../../public/assets/zombies.json";
import { buildPlayerUnits } from "../../../src/raid/CombatEngine";
import { deriveAttackIntervalMs } from "../../../src/raid/combatStats";
import { BattleSim } from "../../../src/raid/BattleSim";
import { replayRaid, type RaidReplayInput } from "../../../src/raid/replay";
import type { CombatUnit } from "../../../src/raid/types";
import { makeOwned } from "../../../src/zombie/types";
import { ABILITY_TIER, abilityTierOf } from "../../../src/zombie/traits";
import { activeBonusHeadId, farmerMultiplier } from "../../../src/farmer";
import { levelForXp } from "../levels";
import { EPIC_LOOT_DROP_CHANCE, EPIC_LOOT_ROLLS, epicBrainTicketChance, epicBossCurrencyReward, epicLootWeight, epicQuestZombieReward, reopenEpicQuests, shouldStoreEpicReward } from "../../../src/epicBoss/rewards";
import objectRows from "../../../public/assets/placeables.json";
import { EPIC_BOSS_FIGHT_BRAIN_COST } from "../../../src/epicBoss/tokens";
import { ARMY_CAP } from "../../../src/raid/RaidCatalog";
import { BRAIN_TICKET_KEY } from "../../../src/raid/eliteInvasion";
import { RAID_RULESET_VERSION } from "../../../src/raid/replay";
import { isLiveSessionCollision } from "./liveSessionRace";
import { encodeReceivedZombie } from "../../../src/zombie/receivedReward";

export interface RunRow {
  run_id: string; boss_id: string; activated_at: number; expires_at: number;
  level: number; max_hp: number; current_hp: number; encounter_started_at: number;
  retry_ready_at: number; token_count: number; completed_at: number; attack_order_json: string;
  /** Crop key that lured this boss, or '' when the event was bought (migration 0054). */
  started_crop?: string;
}
interface SessionRow {
  id: string; run_id: string; level: number; starting_hp: number; roster_json: string;
  config_json: string; started_at: number; expires_at: number; finished_at: number | null; result_json: string | null;
}
interface EpicCombatConfig { rulesetVersion: number; playerUnits: CombatUnit[]; enemyUnits: CombatUnit[] }
const zombies = new Map((zombieRows as Array<{key:string}>).map((z) => [z.key, z]));
const objectArmyCapacity = new Map((objectRows as Array<{key:string;armyMax?:number}>).map((o) => [o.key, o.armyMax ?? 0]));
const defFor = (bossId: string): EpicBossDef | null => epicBossById(bossId);
const DEFAULT_DEF = epicBossById("dr-groundhog")!;
interface CoreState {
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  ownedPets: string[];
  zombieMax: number;
  farmerHeadId?: number;
  farmerBonusHeadId?: number | null;
  [key: string]: unknown;
}

const parse = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

/** Pull a stored run down onto the ladder it is actually on.
 *
 *  The seven 40-rung events were cut to 20 (levels 21-40 were padding — every one of
 *  them reused level 20's HP multiplier), so a run that was mid-flight across the
 *  deploy can hold a level the boss no longer has. Migration 0046 repairs the stored
 *  rows; this is the read-time twin, covering rows written between the deploy and the
 *  migration, and any row a rollback re-raises.
 *
 *  Clamping is strictly in the player's favour and costs them nothing: level 20 and
 *  level 40 are the same 107x fight, so `max_hp` is unchanged, but a run left above
 *  the top would display as "25/20", would never match the retuned top-prize quest
 *  (which now fires on level 20), and would be marked complete on its next win with
 *  the omega zombie unclaimable. Clamped, that win IS the level-20 win: it grants the
 *  prize and pays the top-tier bonus brain. Completed runs are left alone — their
 *  ladder is already over and their prizes already paid. */
const clampRun = <T extends RunRow | null>(row: T, cap?: number): T => {
  if (!row || row.completed_at) return row;
  const max = cap ?? defFor(row.boss_id)?.maxLevel;
  if (!max || row.level <= max) return row;
  const level = max;
  const maxHp = epicBossHp(defFor(row.boss_id)!, level);
  return { ...row, level, max_hp: maxHp, current_hp: Math.max(1, Math.min(row.current_hp, maxHp)) };
};

export const projectRun = (row: RunRow | null): EpicBossProjection | null => row ? ({
  runId: row.run_id, bossId: row.boss_id, activatedAt: row.activated_at,
  expiresAt: row.expires_at, level: row.level, maxHp: row.max_hp,
  currentHp: row.current_hp, encounterStartedAt: row.encounter_started_at,
  retryReadyAt: 0,
  tokenCount: row.completed_at || row.expires_at <= Date.now() ? 0 : Math.max(0, row.token_count ?? 0),
  completedAt: row.completed_at,
  attackOrder: parse<string[]>(row.attack_order_json, []),
  // Omitted rather than sent empty, so "bought" is the absence of a crop on the wire
  // exactly as it is in the client's type.
  ...(row.started_crop ? { startedCrop: row.started_crop } : {}),
}) : null;

export async function readRun(db: D1Database, accountId: string): Promise<EpicBossProjection | null> {
  return projectRun(await db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id = ?")
    .bind(accountId).first<RunRow>().then(clampRun));
}

export async function activate(
  db: D1Database, accountId: string, activationId: string, bossId: unknown, now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const def = bossId === undefined ? DEFAULT_DEF : typeof bossId === "string" ? defFor(bossId) : null;
  if (!def) return { status: 400, body: { error: "unknown_boss" } };
  const [balance, current, questRow] = await Promise.all([
    db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id = ?").bind(accountId)
      .first<{ gold: number; brains: number; xp: number }>(),
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id = ?").bind(accountId).first<RunRow>().then(clampRun),
    db.prepare("SELECT version,current_json FROM quest_documents_v3 WHERE account_id = ?")
      .bind(accountId).first<{ version: number; current_json: string }>(),
  ]);
  if (!balance) return { status: 409, body: { error: "state_conflict" } };
  if (current?.run_id === activationId) return { status: 200, body: { event: projectRun(current), balance } };
  if (current && !current.completed_at && current.expires_at > now) {
    return { status: 409, body: { error: "event_active", event: projectRun(current) } };
  }
  const level = levelForXp(balance.xp);
  const unlockLevel = epicBossUnlockLevel(def);
  if (level < unlockLevel) {
    return { status: 403, body: { error: "locked", level, unlockLevel } };
  }
  if (balance.brains < def.costBrains) return { status: 409, body: { error: "insufficient_brains", balance } };
  const hp = epicBossHp(def, 1);
  const expiresAt = now + def.durationMs;
  // A new run re-offers this boss's quest chain, so its prizes — the signature zombie
  // above all — are earnable once per run instead of once per account. Guarded by the
  // same EXISTS as the brain charge: if the activation loses its race, nothing here
  // lands either, and the quests stay as they were.
  const questData = parse<{ completed: string[]; progress: QuestProjection["progress"] }>(
    questRow?.current_json, { completed: [], progress: [] }
  );
  const reopened = questRow ? reopenEpicQuests(questData, def.questIds) : null;
  const statements = await db.batch([
    db.prepare(`INSERT INTO epic_boss_runs_v3
      (account_id,run_id,boss_id,activated_at,expires_at,level,max_hp,current_hp)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
      run_id=excluded.run_id,boss_id=excluded.boss_id,activated_at=excluded.activated_at,
      expires_at=excluded.expires_at,level=excluded.level,max_hp=excluded.max_hp,
      current_hp=excluded.current_hp,encounter_started_at=0,retry_ready_at=0,
      token_count=0,completed_at=0,attack_order_json='[]',started_crop=''
      WHERE epic_boss_runs_v3.completed_at != 0 OR epic_boss_runs_v3.expires_at <= ?`)
      .bind(accountId, activationId, def.id, now, expiresAt, 1, hp, hp, now),
    db.prepare(`UPDATE balances SET brains = brains - ? WHERE account_id = ? AND brains >= ?
      AND EXISTS(SELECT 1 FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?)`)
      .bind(def.costBrains, accountId, def.costBrains, accountId, activationId),
    ...(reopened ? [db.prepare(`UPDATE quest_documents_v3 SET version=version+1,current_json=?,updated_at=?
      WHERE account_id=? AND EXISTS(SELECT 1 FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?)`)
      .bind(JSON.stringify(reopened), now, accountId, accountId, activationId)] : []),
  ]);
  if ((statements[0]?.meta.changes ?? 0) !== 1 || (statements[1]?.meta.changes ?? 0) !== 1) {
    return { status: 409, body: { error: "activation_conflict" } };
  }
  const reopenCommitted = !!reopened && (statements[2]?.meta.changes ?? 0) === 1;
  return { status: 200, body: {
    event: await readRun(db, accountId),
    balance: { ...balance, brains: balance.brains - def.costBrains },
    ...(reopenCommitted ? { quests: { version: questRow!.version + 1, ...reopened } } : {}),
  } };
}

export async function end(
  db: D1Database, accountId: string, runId: unknown, now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof runId !== "string" || !runId) return { status: 400, body: { error: "bad_request" } };
  const run = await db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=?")
    .bind(accountId).first<RunRow>().then(clampRun);
  if (!run || run.run_id !== runId) return { status: 409, body: { error: "inactive" } };
  // Repeating a successfully-ended request is harmless and returns the same run.
  if (run.completed_at || run.expires_at <= now) {
    return { status: 200, body: { event: projectRun(run) } };
  }
  await db.batch([
    db.prepare(`UPDATE epic_boss_sessions_v3 SET finished_at=?, config_json=${CONFIG_SPENT}
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
    db.prepare(`UPDATE epic_boss_sessions_v3 SET finished_at=?, config_json=${CONFIG_SPENT}
      WHERE id=? AND finished_at IS NULL`).bind(now, live.id),
    db.prepare("UPDATE epic_boss_runs_v3 SET retry_ready_at=0 WHERE account_id=? AND run_id=? AND completed_at=0")
      .bind(accountId, live.run_id),
    db.prepare("UPDATE roster_v3 SET locked_by_raid=NULL WHERE account_id=? AND locked_by_raid=?").bind(accountId, live.id),
  ]);
}

export async function start(
  db: D1Database, accountId: string, orderedUnitIds: unknown, payment: unknown, now: number,
  rulesetVersion?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  await expireLiveEpicBoss(db, accountId, now);
  const ids = Array.isArray(orderedUnitIds)
    ? orderedUnitIds.filter((id): id is string => typeof id === "string" && !!id) : [];
  if (!ids.length || ids.length > ARMY_CAP || ids.length !== (orderedUnitIds as unknown[]).length ||
      new Set(ids).size !== ids.length) return { status: 400, body: { error: "bad_roster" } };
  // The same handshake `/raid/start` performs, and for a reason that took a live incident
  // to become visible here. The config this handler pins carries the WORKER's ruleset, and
  // the finish handler compares that pinned value — which detects a stale SESSION but can
  // never detect a stale CLIENT. So a tab holding pre-deploy JS used to pay for an attempt,
  // fight it under its own rules, and have the replay disagree: the player watched a win
  // and was told the boss escaped, or the transcript failed verification outright, with the
  // token or brain already spent either way.
  //
  // It was harmless until the epic fight itself became versioned (v28 moved the attempt
  // window, v29 made damage compound). Refusing here costs nothing — nothing has been
  // charged and no session exists yet — and 426 is the status the client already knows how
  // to answer with a reload prompt.
  //
  // Checked BEFORE the resume branch below on purpose: letting a stale client re-enter a
  // session it cannot simulate correctly just moves the same failure to the finish.
  if (rulesetVersion !== RAID_RULESET_VERSION) {
    return { status: 426, body: { error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION } };
  }
  const [row, raid, epic, roster, balance, coreRow, raidState] = await Promise.all([
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=?").bind(accountId).first<RunRow>().then(clampRun),
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
  // The head supplying bonuses is the pinned one, else whatever is being worn.
  const bonusHead = activeBonusHeadId(Number(core.farmerHeadId ?? 1), core.farmerBonusHeadId);
  const playerUnits = buildPlayerUnits(party, {
    concentration: true, abilityUnlocked, playerLevel: levelForXp(balance.xp),
    farmerStrengthMult: farmerMultiplier(bonusHead, "zombieStrength"),
    farmerLifeMult: farmerMultiplier(bonusHead, "zombieLife"),
  });
  const boss: CombatUnit = {
    id:`epic:${row.run_id}:${row.level}`,sourceKey:`EpicBoss:${def.id}`,team:"enemy",name:def.name,
    // Damage compounds 5% per rung (epicBossDamage) — MUST match src/epicBoss/combat.ts.
    str:epicBossDamage(def,row.level),dex:def.unitStats.dex,con:def.unitStats.con,focus:0,hp:row.current_hp,maxHp:row.max_hp,
    // Raw enemy clock (1/dex); mirrors src/epicBoss/combat.ts — keep the two in step.
    attackCooldownMs:deriveAttackIntervalMs(def.unitStats.dex,"enemy"),
    attacks:def.unitStats.attacks.map((attack) => ({...attack,mult:attack.mult ?? 1})),isBoss:true,alive:true,isGarden:false,isHeadless:false,
    // Per-attack, from the catalog; mirrors src/epicBoss/combat.ts — keep the two in step.
    abilities:[],attackDamageTiming:epicBossDamageTiming(def),
  };
  const config: EpicCombatConfig = { rulesetVersion: RAID_RULESET_VERSION, playerUnits, enemyUnits:[boss] };
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
  // One statement for the army, matching startRaid. `locked_by_raid IS NULL` still gates
  // each row, so the rows written are unchanged.
  statements.push(db.prepare(`UPDATE roster_v3 SET locked_by_raid=?
    WHERE account_id=? AND locked_by_raid IS NULL
      AND unit_id IN (${ids.map(() => "?").join(",")})`).bind(sessionId, accountId, ...ids));
  try {
    await db.batch(statements);
  } catch (error) {
    // Two starts tied on idx_epic_boss_session_live_v3 — see liveSessionRace.ts.
    if (isLiveSessionCollision(error)) return { status: 409, body: { error: "battle_in_progress" } };
    throw error;
  }
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
  if (session.result_json) {
    return { status: 200, body: { ...parse<Record<string, unknown>>(session.result_json, {}), serverTime: now } };
  }
  if (session.finished_at) return { status: 409, body: { error: "already_finished" } };
  if (now >= session.expires_at) {
    await expireLiveEpicBoss(db, accountId, now);
    return { status: 409, body: { error: "expired" } };
  }
  const pinnedRun = await db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?")
    .bind(accountId, session.run_id).first<RunRow>().then(clampRun);
  const def = pinnedRun ? defFor(pinnedRun.boss_id) : null;
  if (!def) return { status: 409, body: { error: "unknown_boss" } };
  // A fight opened before the 40 -> 20 ladder cut pinned the old level into its session
  // row. `clampRun` has just pulled the run down to the new top, so the equality check
  // below would read the untouched session as stale and refuse a fight the player has
  // already won. Clamp the session the same way — it is the same boss at the same HP.
  if (session.level > def.maxLevel) session.level = def.maxLevel;
  const locked = parse<string[]>(session.roster_json, []);
  const pacedTick = Math.floor((now - session.started_at) / 50) + 40;
  if (Number(body.finalTick) > pacedTick) return { status: 422, body: { error: "future_finish" } };
  const config = parse<EpicCombatConfig | null>(session.config_json, null);
  if (!config || !Array.isArray(config.playerUnits) || !Array.isArray(config.enemyUnits) ||
      !Number.isInteger(body.finalTick) || !Array.isArray(body.inputs)) {
    return { status: 400, body: { error: "bad_replay" } };
  }
  if (config.rulesetVersion !== RAID_RULESET_VERSION) {
    await db.batch([
      db.prepare(`UPDATE epic_boss_sessions_v3 SET finished_at=?, config_json=${CONFIG_SPENT}
        WHERE id=? AND finished_at IS NULL`).bind(now, session.id),
      db.prepare("UPDATE roster_v3 SET locked_by_raid=NULL WHERE account_id=? AND locked_by_raid=?").bind(accountId, session.id),
    ]);
    return { status: 409, body: { error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION } };
  }
  const verified = replayRaid(new BattleSim(
    config.playerUnits, config.enemyUnits, null, false, [], def.fightMs,
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
  const [run, balance, coreRow, questRow, objectRow, rosterCounts, raidState,
    casualtyRows, presentationRow] = await Promise.all([
    db.prepare("SELECT * FROM epic_boss_runs_v3 WHERE account_id=? AND run_id=?").bind(accountId, session.run_id).first<RunRow>().then(clampRun),
    db.prepare("SELECT gold,brains,xp,claimed_level FROM balances WHERE account_id=?").bind(accountId).first<{gold:number;brains:number;xp:number;claimed_level:number}>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").bind(accountId).first<{current_json:string}>(),
    db.prepare("SELECT version,current_json FROM quest_documents_v3 WHERE account_id=?").bind(accountId).first<{version:number;current_json:string}>(),
    db.prepare("SELECT current_json FROM object_documents_v3 WHERE account_id=?").bind(accountId).first<{current_json:string}>(),
    db.prepare(`SELECT stored,COUNT(*) AS count FROM roster_v3 WHERE account_id=? GROUP BY stored`)
      .bind(accountId).all<{stored:number;count:number}>(),
    db.prepare("SELECT last_started_at FROM raid_state_v3 WHERE account_id=?")
      .bind(accountId).first<{last_started_at:number}>(),
    // The casualties, read while their roster rows still exist — the batch below is
    // what deletes them. Same query the invasion settlement runs (v3/raid.ts), and it
    // is here for the same reason: this is the one moment a zombie stops existing, so
    // it is the only moment a Memorial Statue can be given something to carve.
    losses.length
      ? db.prepare(`SELECT unit_id,zombie_key,mutation,invasions,color FROM roster_v3
          WHERE account_id=? AND locked_by_raid=? AND unit_id IN (${losses.map(() => "?").join(",")})`)
        .bind(accountId, session.id, ...losses)
        .all<{unit_id:string;zombie_key:string;mutation:number;invasions:number;color:string|null}>()
      : Promise.resolve({ results: [] }),
    // Names live only in the client's presentation blob, keyed by unit id — the key
    // that is about to be deleted. Read only when someone actually died; a missing
    // name is harmless (the plaque falls back to the deterministic default).
    losses.length
      ? db.prepare("SELECT current_json FROM presentations_v3 WHERE account_id=?")
        .bind(accountId).first<{current_json:string}>()
      : Promise.resolve(null),
  ]);
  if (!run || !balance || !coreRow || !questRow || !objectRow || !raidState || run.level !== session.level) return { status: 409, body: { error: "stale_session" } };
  const xpBefore = balance.xp;
  const damage = Math.max(0, Math.min(session.starting_hp, Math.round(verified.outcome.playerDamage)));
  const defeated = verified.outcome.win && damage >= session.starting_hp;
  const defeatedLevel = defeated ? run.level : null;
  // The brain is a roll and this is where it is decided — the client cannot re-roll it
  // and agree, so the granted amounts ride back in the response as `currency`.
  let currency = { brains: 0, gold: 0 };
  if (defeatedLevel !== null) {
    currency = epicBossCurrencyReward(defeatedLevel, def.maxLevel, random);
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
  const objects = parse<Array<{catalogKey:string;status:string}>>(objectRow.current_json, []);
  type Drop = { name: string; tile?: string; stageActor?: string; sprite: string };
  const drops: Drop[] = [];
  // EPIC_LOOT_ROLLS independent rolls, each at EPIC_LOOT_DROP_CHANCE — both shared with
  // the client's rollEpicBossDrops, so a rate or roll-count change can't land on one side
  // only. Anything already dropped in THIS clear is excluded from the next roll, which is
  // the point of rolling twice rather than once at double the odds.
  if (defeatedLevel !== null) {
    // Collected spans Received + the shed + the placed object (ownedLootCounter): reading
    // Received alone reset the uncollected preference the moment a prize was claimed, so
    // already-owned decor kept crowding out prizes the player had never seen.
    const owned = ownedLootCounter(core.storage, objects);
    for (let roll = 0; roll < EPIC_LOOT_ROLLS; roll++) {
      if (random() >= EPIC_LOOT_DROP_CHANCE) continue;
      const unlocked = def.loot.filter((entry) =>
        entry.level <= defeatedLevel
        && !(entry.stageActor && core.ownedPets.includes(entry.stageActor))
        && !drops.some((d) => d.name === entry.name));
      if (!unlocked.length) continue;
      const uncollected = unlocked.filter((entry) => entry.stageActor || owned(entry.name, entry.tile) === 0);
      const pool = uncollected.length ? uncollected : unlocked;
      // RARITY ORDERING via the shared epicLootWeight curve (one definition, so the offline
      // roll in epicBoss/combat.ts and this one can't drift): weight each prize by the
      // inverse of the rung that unlocks it. A uniform pick made the top-rung signature
      // item exactly as likely as the level-5 starter.
      const picked = pickByFrequency(
        pool.map((entry) => ({ entry, frequency: epicLootWeight(entry.level) })), random
      );
      if (!picked) continue;
      drops.push(picked.entry);
      if (picked.entry.stageActor) core.ownedPets = [...new Set([...core.ownedPets, picked.entry.stageActor])];
      else core.storage.received[picked.entry.name] = (core.storage.received[picked.entry.name] ?? 0) + 1;
    }
  }
  // Gold-side bonus scaled by how deep the rung was (1.5% per rung).
  let brainTicket = 0;
  if (defeatedLevel !== null && random() < epicBrainTicketChance(defeatedLevel, def.maxLevel)) {
    brainTicket = 1;
    core.inventory[BRAIN_TICKET_KEY] = (core.inventory[BRAIN_TICKET_KEY] ?? 0) + 1;
  }
  // `loot` stays the FIRST drop so a result_json written before this change still reads
  // correctly when a duplicate finish replays it; new clients read `drops`.
  const loot: Drop | null = drops[0] ?? null;
  const events = defeatedLevel === null ? [] : [
    { type: "kEpicStageEnemyDefeatedNotification", subject: String(defeatedLevel) },
    ...drops.map((d) => ({ type: "kEpicBossEpicItemWonNotification", subject: d.name })),
  ];
  const questChanges = applyQuestEvents(balance, quests, events, {
    includeEpic: true,
    epicQuestIds: new Set(def.questIds),
    inventory: core.inventory,
    storage: core.storage,
  });
  const leveledUp = levelForXp(balance.xp) > levelForXp(xpBefore);
  const newlyCompleted = quests.completed.filter((id) => !beforeCompleted.has(id));
  const armyCapacity = core.zombieMax + objects.reduce((total, object) =>
    total + (object.status === "placed" ? objectArmyCapacity.get(object.catalogKey) ?? 0 : 0), 0);
  // Casualties are still present in roster_v3 until this transaction commits, so
  // remove them when deciding whether a reward lands on the farm or in storage.
  let activeCount = Math.max(0,
    (rosterCounts.results.find((row) => !row.stored)?.count ?? 0) - losses.length
  );
  const newZombies: { id: string; key: string; stored: boolean; received?: boolean }[] = [];
  // Item rewards (Invasion Voucher / Golden Dice) are granted generically by
  // applyQuestEvents above, which was handed core.inventory + core.storage. Only
  // the zombie reward still needs placing, because it competes for army capacity.
  for (const id of newlyCompleted) {
    const key = epicQuestZombieReward(id);
    if (key) {
      const stored = shouldStoreEpicReward(activeCount, armyCapacity);
      const zombie = { id: crypto.randomUUID(), key, stored, ...(stored ? { received: true } : {}) };
      newZombies.push(zombie);
      if (stored) {
        const marker = encodeReceivedZombie({ id: zombie.id, key, mutation: 0, invasions: 0 });
        core.storage.received[marker] = 1;
      }
      if (!stored) activeCount++;
    }
  }
  const result = { serverTime: now, event: {
    ...projectRun(run)!, level: run.level, maxHp: run.max_hp, currentHp: run.current_hp,
    encounterStartedAt: run.encounter_started_at, retryReadyAt: run.retry_ready_at, completedAt: run.completed_at,
  }, defeatedLevel, escaped: !defeated, currency, loot, drops, brainTicket, balance, inventory: core.inventory,
    storage: core.storage, ownedPets: core.ownedPets, survivors, losses, quests, questChanges, newZombies };
  if (leveledUp) Object.assign(result, { lastRaidAt: 0 });
  const resultJson = JSON.stringify(result);
  const guard = "EXISTS(SELECT 1 FROM epic_boss_sessions_v3 s WHERE s.id=? AND s.result_json=?)";
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE epic_boss_sessions_v3 SET finished_at=?,result_json=?, config_json=${CONFIG_SPENT}
      WHERE id=? AND finished_at IS NULL`)
      .bind(now, resultJson, session.id),
    db.prepare(`UPDATE epic_boss_runs_v3 SET level=?,max_hp=?,current_hp=?,encounter_started_at=?,
      retry_ready_at=?,token_count=?,completed_at=? WHERE account_id=? AND run_id=? AND ${guard}`)
      .bind(run.level,run.max_hp,run.current_hp,run.encounter_started_at,run.retry_ready_at,run.token_count,run.completed_at,accountId,run.run_id,session.id,resultJson),
    db.prepare(`UPDATE balances SET gold=?,brains=?,xp=?,claimed_level=? WHERE account_id=? AND ${guard}`)
      .bind(balance.gold,balance.brains,balance.xp,levelForXp(balance.xp),accountId,session.id,resultJson),
    db.prepare(`UPDATE gameplay_documents_v3 SET current_json=?,updated_at=? WHERE account_id=? AND ${guard}`)
      .bind(JSON.stringify(core),now,accountId,session.id,resultJson),
    db.prepare(`UPDATE quest_documents_v3 SET version=version+1,current_json=?,updated_at=? WHERE account_id=? AND ${guard}`)
      .bind(JSON.stringify({completed:quests.completed,progress:quests.progress}),now,accountId,session.id,resultJson),
  ];
  if (leveledUp) statements.push(db.prepare(`UPDATE raid_state_v3 SET last_started_at=0
    WHERE account_id=? AND ${guard}`).bind(accountId,accountId,session.id,resultJson));
  // The graveyard. An epic boss kills exactly as permanently as an invasion does, so
  // its dead are written to fallen_v3 on the same terms — otherwise the Memorial
  // Statue, which reads the authoritative graveyard and nothing else, tells a player
  // who has just lost a zombie here that they have never lost one. There is no
  // revival offer on this path, so the row is final the moment it is written.
  const casualtyNames = new Map<string, string>();
  if (presentationRow) {
    const layout = parse<{rosterLayout?:{id?:unknown;name?:unknown}[]}>(presentationRow.current_json, {}).rosterLayout;
    for (const entry of Array.isArray(layout) ? layout : []) {
      if (typeof entry?.id === "string" && typeof entry.name === "string" && entry.name) {
        casualtyNames.set(entry.id, entry.name.slice(0, 24));
      }
    }
  }
  (casualtyRows.results ?? []).forEach((row) => statements.push(db.prepare(`INSERT INTO fallen_v3
    (account_id,unit_id,zombie_key,name,mutation,invasions,color,died_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT(account_id,unit_id) DO NOTHING`)
    .bind(accountId,row.unit_id,row.zombie_key,casualtyNames.get(row.unit_id) ?? null,
      row.mutation,row.invasions,row.color,now,session.id,resultJson)));
  // Same bound the invasion settlement keeps, and for the same reasons: unenshrined
  // rows only (a statue is permanent), and run after the inserts so a settlement that
  // overflows the cap drops the oldest rather than refusing the newest.
  if (losses.length) statements.push(db.prepare(`DELETE FROM fallen_v3
    WHERE account_id=? AND memorial_object_id IS NULL AND unit_id NOT IN (
      SELECT unit_id FROM fallen_v3 WHERE account_id=? AND memorial_object_id IS NULL
      ORDER BY COALESCE(released_at,died_at) DESC, unit_id LIMIT ?
    ) AND ${guard}`)
    .bind(accountId,accountId,MEMORIAL_GRAVEYARD_CAP,session.id,resultJson));
  losses.forEach((id) => statements.push(db.prepare(`DELETE FROM roster_v3 WHERE account_id=? AND unit_id=? AND locked_by_raid=? AND ${guard}`)
    .bind(accountId,id,session.id,session.id,resultJson)));
  survivors.forEach((id) => statements.push(db.prepare(`UPDATE roster_v3 SET invasions=invasions+1,locked_by_raid=NULL
    WHERE account_id=? AND unit_id=? AND locked_by_raid=? AND ${guard}`).bind(accountId,id,session.id,session.id,resultJson)));
  escapedRoster.forEach((id) => statements.push(db.prepare(`UPDATE roster_v3 SET locked_by_raid=NULL
    WHERE account_id=? AND unit_id=? AND locked_by_raid=? AND ${guard}`).bind(accountId,id,session.id,session.id,resultJson)));
  newZombies.filter((z) => !z.received).forEach((z) => statements.push(db.prepare(`INSERT INTO roster_v3(account_id,unit_id,zombie_key,stored,created_at)
    SELECT ?,?,?,?,? WHERE ${guard}`).bind(accountId,z.id,z.key,z.stored ? 1 : 0,now,session.id,resultJson)));
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) {
    const raced = await db.prepare("SELECT result_json FROM epic_boss_sessions_v3 WHERE id=? AND account_id=?")
      .bind(session.id, accountId).first<{ result_json: string | null }>();
    return raced?.result_json
      ? { status: 200, body: { ...parse<Record<string, unknown>>(raced.result_json, {}), serverTime: now } }
      : { status: 409, body: { error: "state_conflict" } };
  }
  return { status: 200, body: result };
}
