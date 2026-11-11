import zombiesJson from "../../../public/assets/zombies.json";
import { buildPlayerUnits } from "../../../src/raid/CombatEngine";
import {
  applyEndlessCurse, applyEndlessStop, beginEndlessRun,
  applyEndlessOrder, endlessMaxStartTier, endlessWavePlan, endlessWeekSeed,
  ENDLESS_ENTRY_COST, ENDLESS_FIGHTS_PER_LOCATION, ENDLESS_LOCATIONS, ENDLESS_UNLOCK_LEVEL, endlessFreeDayStart, endlessModeOpen,
  type EndlessBoon, type EndlessLocation, type EndlessCurse, type EndlessMode, type EndlessRunState, type EndlessStop,
} from "../../../src/raid/endless";
import {
  endlessApplyBoon, endlessCarryFromSim as carryFromSim, endlessFightConfig as fightConfig, endlessSimFor as simFor,
  type EndlessFightConfig as FightConfig,
} from "../../../src/raid/endlessFight";
import { makeOwned, type OwnedZombie } from "../../../src/zombie/types";
import { loadLifeForceLevel, loadMutationStrengthMultiplier } from "../raidVerifier";
import { abilitySlotUnlocked } from "../../../src/lifeForce";
import { farmerMultiplier, activeBonusHeadId } from "../../../src/farmer";
import { ARMY_CAP } from "../../../src/raid/RaidCatalog";
import { replayRaid, RAID_RULESET_VERSION, type RaidReplayInput } from "../../../src/raid/replay";
import { levelForXp } from "../levels";
import { recordEndlessLeaderboardStatement, recordEndlessWeeklyStatement, type EndlessLeaderboardArmyMember } from "../db";
import { CONCENTRATION_KEY, MAX_STACK } from "../boostCatalog";
import { MEMORIAL_GRAVEYARD_CAP } from "./engine";
import { encodeReceivedZombie } from "../../../src/zombie/receivedReward";
import { endlessBestTierOf, endlessMaxVetRankOf } from "../../../src/raid/endlessPerks";
import type { EndlessBossLoot } from "../../../src/raid/endlessLoot";
import {
  endlessBossScreen, endlessBossWinRewards, endlessCredited, endlessDraftFor,
  endlessGoldReward, endlessLosses, endlessOffered as offered, rollEndlessWinLoot, type EndlessRunPayload,
} from "../../../src/raid/endlessRunRules";

const zombies = new Map((zombiesJson as Array<{ key: string }>).map((z) => [z.key, z]));
interface StoredRun {
  id: string;
  account_id: string;
  mode: EndlessMode;
  current_wave: number;
  run_state_json: string;
  army_json: string;
  fight_config_json: string;
  ruleset_version: number;
  started_at: number;
  fight_started_at: number;
  finished_at: number | null;
  result_json: string | null;
}

type RunPayload = EndlessRunPayload;
interface EndlessRewardCore {
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  [key: string]: unknown;
}
const parse = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
const fail = (status: number, error: string) => ({ status, body: { ok: false, error } });

function isMode(mode: unknown): mode is EndlessMode { return mode === "endless" || mode === "nightmare"; }
function leaderboardArmy(party: readonly OwnedZombie[]): EndlessLeaderboardArmyMember[] {
  return party.map((unit) => ({
    species: unit.key,
    mutation: unit.mutation,
    veterancy: Math.max(0, Math.min(5, Math.trunc(unit.invasions))),
  }));
}

/** A dead zombie as the revival offer restores it: the roster row's own fields (the same shape
 *  an invasion's raid_revivals_v3 offer stores, so /raid/revive resolves both). */
export interface EndlessCasualtySnapshot {
  id: string; key: string; mutation: number; invasions: number; stored: boolean; createdAt: number;
}

/** Read the fallen's names and roster rows while they (and the layout naming them) still exist.
 *  Only unlocked rows: a zombie fighting an invasion right now is not buried here. */
async function fallenRecords(db: D1Database, accountId: string, losses: readonly string[]): Promise<{
  names: Map<string, string>; snapshots: EndlessCasualtySnapshot[];
}> {
  const names = new Map<string, string>();
  if (!losses.length) return { names, snapshots: [] };
  const [row, rosterRows] = await Promise.all([
    db.prepare("SELECT current_json FROM presentations_v3 WHERE account_id=?")
      .bind(accountId).first<{ current_json: string }>(),
    db.prepare(`SELECT unit_id, zombie_key, mutation, invasions, stored, created_at FROM roster_v3
      WHERE account_id=? AND locked_by_raid IS NULL AND unit_id IN (${losses.map(() => "?").join(",")})`)
      .bind(accountId, ...losses)
      .all<{ unit_id: string; zombie_key: string; mutation: number; invasions: number; stored: number; created_at: number }>(),
  ]);
  const layout = row ? parse<{ rosterLayout?: { id?: unknown; name?: unknown }[] }>(row.current_json, {}).rosterLayout : null;
  for (const entry of Array.isArray(layout) ? layout : []) {
    if (typeof entry?.id === "string" && typeof entry.name === "string" && entry.name) names.set(entry.id, entry.name.slice(0, 24));
  }
  const snapshots = (rosterRows.results ?? []).map((r) => ({
    id: r.unit_id, key: r.zombie_key, mutation: r.mutation, invasions: r.invasions, stored: !!r.stored, createdAt: r.created_at,
  }));
  return { names, snapshots };
}

/** The brain revival offered when a run ends, exactly as after an invasion: one brain each,
 *  resolved once through /raid/revive. Null when nobody is down. */
function endlessRevival(sessionId: string, snapshots: readonly EndlessCasualtySnapshot[]) {
  return snapshots.length ? { sessionId, zombies: [...snapshots], costPerZombie: 1 as const } : null;
}

/** Bury the run's dead, as an invasion or an Epic Boss does (owner, 2026-11-10: zombies lost in
 *  Endless stay dead). Each goes to the graveyard (fallen_v3, so a Memorial Statue can carve it)
 *  and leaves the roster. Guarded on this run having closed with exactly this result, so a
 *  replayed or raced settlement buries nobody twice; a zombie sold mid-run simply has no row. */
function buryStatements(
  db: D1Database, session: StoredRun, losses: readonly string[],
  fallen: { names: ReadonlyMap<string, string>; snapshots: readonly EndlessCasualtySnapshot[] },
  resultJson: string, now: number,
): D1PreparedStatement[] {
  if (!losses.length) return [];
  const names = fallen.names;
  const guard = "EXISTS(SELECT 1 FROM endless_runs_v3 r WHERE r.id=? AND r.result_json=?)";
  const accountId = session.account_id;
  const statements: D1PreparedStatement[] = losses.map((id) => db.prepare(`INSERT INTO fallen_v3
      (account_id,unit_id,zombie_key,name,mutation,invasions,color,died_at)
      SELECT account_id,unit_id,zombie_key,?,mutation,invasions,color,? FROM roster_v3
      WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL AND ${guard}
    ON CONFLICT(account_id,unit_id) DO NOTHING`)
    .bind(names.get(id) ?? null, now, accountId, id, session.id, resultJson));
  statements.push(db.prepare(`DELETE FROM fallen_v3
    WHERE account_id=? AND memorial_object_id IS NULL AND unit_id NOT IN (
      SELECT unit_id FROM fallen_v3 WHERE account_id=? AND memorial_object_id IS NULL
      ORDER BY COALESCE(released_at,died_at) DESC, unit_id LIMIT ?
    ) AND ${guard}`)
    .bind(accountId, accountId, MEMORIAL_GRAVEYARD_CAP, session.id, resultJson));
  for (const id of losses) {
    statements.push(db.prepare(`DELETE FROM roster_v3 WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL AND ${guard}`)
      .bind(accountId, id, session.id, resultJson));
  }
  // The brain revival (2026-11-11: players could not buy back their Endless dead). Same offer
  // an invasion writes; /raid/revive restores the roster row and lifts it off the graveyard.
  if (fallen.snapshots.length) statements.push(db.prepare(`INSERT INTO endless_revivals_v3
      (session_id, account_id, casualties_json, created_at)
      SELECT ?, ?, ?, ? WHERE ${guard}
    ON CONFLICT(session_id) DO NOTHING`)
    .bind(session.id, accountId, JSON.stringify(fallen.snapshots), now, session.id, resultJson));
  return statements;
}

function settleTerminalStatements(
  db: D1Database,
  session: StoredRun,
  run: EndlessRunState,
  deepestFloor: number,
  durationMs: number,
  now: number,
  update: D1PreparedStatement,
  burial: D1PreparedStatement[] = [],
): D1PreparedStatement[] {
  const statements = [update];
  const gold = endlessGoldReward(deepestFloor, run.startWave);
  if (gold > 0) {
    statements.push(db.prepare(`UPDATE balances SET gold=gold+?
      WHERE account_id=? AND changes()=1`).bind(gold, session.account_id));
    statements.push(db.prepare(`INSERT INTO ledger (id,account_id,currency,delta,reason,created_at)
      SELECT ?,?,'gold',?,'endless_depth',? WHERE changes()=1`)
      .bind(`endless:${session.id}:gold`, session.account_id, gold, now));
  }
  if (endlessCredited(deepestFloor, run.startWave)) {
    const score = {
      accountId: session.account_id, mode: session.mode, deepestFloor, durationMs,
      army: parse<EndlessLeaderboardArmyMember[]>(session.army_json, []), achievedAt: now,
    };
    statements.push(recordEndlessLeaderboardStatement(db, score, "changes()=1"));
    statements.push(recordEndlessWeeklyStatement(db, { ...score, week: run.weekSeed, sessionId: session.id, finishedAt: now }));
  }
  // Last, so the changes()=1 chain above is untouched; the burial keys off the stored result.
  statements.push(...burial);
  return statements;
}

/** Has the account started no normal Endless run since midnight UTC? Its next one is free. */
async function freeRunAvailable(db: D1Database, accountId: string, now: number): Promise<boolean> {
  const used = await db.prepare(`SELECT 1 AS used FROM endless_runs_v3
    WHERE account_id=? AND mode='endless' AND started_at>=? LIMIT 1`)
    .bind(accountId, endlessFreeDayStart(now)).first<{ used: number }>();
  return !used;
}

/** Start an account-owned Endless run. The cost and opening roster are pinned server-side. */
export async function startEndless(
  db: D1Database,
  accountId: string,
  body: { mode?: unknown; orderedUnitIds?: unknown; rulesetVersion?: unknown; startTier?: unknown; concentration?: unknown },
  now: number,
  /** Dev servers only (the route checks DEV_AUTH and the dev key): the location the run's
   *  first floors are fought at, in place of The Farm, so every stage can be looked at
   *  without playing to it; it also lifts the level's cap on the starting tier. Never
   *  reachable on prod, where DEV_AUTH is unset. */
  dev: { startLocation?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isMode(body.mode)) return fail(400, "bad_mode");
  const devLocation = dev.startLocation;
  if (devLocation !== undefined && !ENDLESS_LOCATIONS.includes(devLocation as EndlessLocation)) return fail(400, "bad_location");
  const mode = body.mode;
  if (!endlessModeOpen(mode)) return fail(404, "mode_closed");
  if (body.rulesetVersion !== RAID_RULESET_VERSION) return fail(426, "stale_ruleset");
  if (!Array.isArray(body.orderedUnitIds) || !body.orderedUnitIds.length || body.orderedUnitIds.length > ARMY_CAP ||
      body.orderedUnitIds.some((id) => typeof id !== "string" || !id) ||
      new Set(body.orderedUnitIds).size !== body.orderedUnitIds.length) return fail(400, "bad_roster");
  const ids = body.orderedUnitIds as string[];
  const [balance, coreRow, roster, liveRaid, liveBoss, liveRun, mutationStrengthMult, lifeForceLevel, freeToday] = await Promise.all([
    db.prepare("SELECT xp,brains FROM balances WHERE account_id=?").bind(accountId).first<{ xp: number; brains: number }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").bind(accountId).first<{ current_json: string }>(),
    db.prepare(`SELECT unit_id,zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND stored=0 AND locked_by_raid IS NULL AND unit_id IN (${ids.map(() => "?").join(",")})`)
      .bind(accountId, ...ids).all<{ unit_id: string; zombie_key: string; mutation: number; invasions: number }>(),
    db.prepare("SELECT id FROM raid_sessions_v3 WHERE account_id=? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    db.prepare("SELECT id FROM epic_boss_sessions_v3 WHERE account_id=? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    db.prepare("SELECT id FROM endless_runs_v3 WHERE account_id=? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    loadMutationStrengthMultiplier(db, accountId),
    loadLifeForceLevel(db, accountId),
    mode === "endless" ? freeRunAvailable(db, accountId, now) : Promise.resolve(false),
  ]);
  // The day's first normal run is free. Two starts racing for it cannot both land: only one
  // run may be live at a time (idx_endless_runs_v3_live), and the next start sees this one.
  const entryCost = freeToday ? 0 : ENDLESS_ENTRY_COST[mode];
  if (!balance || !coreRow) return fail(409, "state_conflict");
  const level = levelForXp(balance.xp);
  if (level < ENDLESS_UNLOCK_LEVEL[mode]) return fail(403, "locked");
  if (balance.brains < entryCost) return fail(409, "no_brains");
  if (liveRaid || liveBoss || liveRun) return fail(409, "run_in_progress");
  const startTier = body.startTier === undefined ? 1 : Number(body.startTier);
  // A dev start (dev servers only) may also skip past the level's cap, to test deep tiers.
  const maxStart = devLocation !== undefined ? 20 : endlessMaxStartTier(mode, level);
  if (!Number.isInteger(startTier) || startTier < 1 || startTier > maxStart) return fail(403, "start_tier_locked");
  const rows = roster.results ?? [];
  const byId = new Map(rows.map((row) => [row.unit_id, row]));
  if (byId.size !== ids.length) return fail(409, "bad_roster");
  const party: OwnedZombie[] = ids.map((id) => {
    const row = byId.get(id)!;
    const def = zombies.get(row.zombie_key);
    if (!def) throw new Error(`unknown roster catalog key ${row.zombie_key}`);
    return makeOwned(id, def as Parameters<typeof makeOwned>[1], 0, 0, row.invasions, row.mutation);
  });
  const core = parse<Record<string, unknown>>(coreRow.current_json, {});
  // Concentration (owner, 2026-11-11): one from the boost inventory, spent at the start, and
  // every floor of the run is fought with it, as an invasion's whole fight is.
  const concentration = body.concentration === true;
  const inventory = (core.inventory && typeof core.inventory === "object" ? core.inventory : {}) as Record<string, number>;
  if (concentration && (Number(inventory[CONCENTRATION_KEY]) || 0) < 1) return fail(409, "no_concentration");
  const farmerHead = Number(core.farmerHeadId ?? 1);
  const bonusHead = activeBonusHeadId(farmerHead, core.farmerBonusHeadId as number | null | undefined);
  const playerUnits = buildPlayerUnits(party, {
    playerLevel: level,
    // Ability slots open with the farm's Life Force, exactly as for an invasion (owner,
    // 2026-11-11). It once passed the player level, which opened every slot from level 30.
    abilitySlotUnlocked: (slot) => abilitySlotUnlocked(slot, lifeForceLevel),
    farmerStrengthMult: farmerMultiplier(bonusHead, "zombieStrength"),
    farmerLifeMult: farmerMultiplier(bonusHead, "zombieLife"),
    farmerDexMult: farmerMultiplier(bonusHead, "zombieDex"),
    mutationStrengthMult: mutationStrengthMult * farmerMultiplier(bonusHead, "mutationStrength"),
    maxVetRank: endlessMaxVetRankOf(core),
  });
  const state: RunPayload = {
    run: beginEndlessRun(mode, playerUnits, endlessWeekSeed(now), startTier, concentration), playerLevel: level, lifeForceLevel, durationMs: 0,
  };
  if (devLocation !== undefined) state.run.stop = { location: devLocation as EndlessLocation, modifier: null };
  // A skipped tier's boons and curses are drafted first, one screen each, before any fight.
  if (startTier > 1) state.pendingBossChoice = { wave: ENDLESS_FIGHTS_PER_LOCATION, opening: true };
  const firstWave = state.pendingBossChoice?.wave ?? 1;
  const config = state.pendingBossChoice ? null : fightConfig(state.run, level);
  const sessionId = crypto.randomUUID();
  const armyJson = JSON.stringify(leaderboardArmy(party));
  try {
    // The Concentration comes off the farm document first, guarded on it being unchanged since
    // the read: D1 does not roll a batch back for a statement that matched nothing, so the
    // brain charge and the run only follow it (changes()=1) and a raced farm write stops all.
    const spendConcentration = concentration ? [db.prepare(`UPDATE gameplay_documents_v3 SET current_json=?,updated_at=?
      WHERE account_id=? AND current_json=?`)
      .bind(JSON.stringify({ ...core, inventory: { ...inventory, [CONCENTRATION_KEY]: (Number(inventory[CONCENTRATION_KEY]) || 0) - 1 } }),
        now, accountId, coreRow.current_json)] : [];
    const results = await db.batch([
      ...spendConcentration,
      db.prepare(`UPDATE balances SET brains=brains-? WHERE account_id=? AND brains>=?${concentration ? " AND changes()=1" : ""}`)
        .bind(entryCost, accountId, entryCost),
      db.prepare(`INSERT INTO endless_runs_v3
        (id,account_id,mode,current_wave,run_state_json,army_json,fight_config_json,ruleset_version,started_at,fight_started_at)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()=1`)
        .bind(sessionId, accountId, mode, firstWave, JSON.stringify(state), armyJson, JSON.stringify(config ?? {}), RAID_RULESET_VERSION, now, now),
    ]);
    if (concentration && results[0]?.meta?.changes !== 1) return fail(409, "state_conflict");
    const charged = results[spendConcentration.length];
    const inserted = results[spendConcentration.length + 1];
    if (charged?.meta?.changes !== 1 || inserted?.meta?.changes !== 1) return fail(409, "no_brains");
  } catch {
    return fail(409, "run_in_progress");
  }
  return { status: 200, body: {
    ok: true, sessionId, mode, wave: firstWave, brainCost: entryCost, freeRun: freeToday, concentration,
    rulesetVersion: RAID_RULESET_VERSION,
    ...(config ? { fight: config } : { stage: "boss-choice", ...endlessBossScreen(mode, state.pendingBossChoice!, state) }),
  } };
}

/** Finish one pinned wave by replaying its transcript, then either advance or record the run. */
export async function finishEndlessWave(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown; wave?: unknown; finalTick?: unknown; inputs?: unknown },
  now: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return fail(400, "bad_session");
  const session = await db.prepare("SELECT * FROM endless_runs_v3 WHERE id=? AND account_id=?")
    .bind(body.sessionId, accountId).first<StoredRun>();
  if (!session) return fail(404, "bad_session");
  if (session.finished_at) return { status: 200, body: parse(session.result_json ?? "", { ok: true, runFinished: true }) };
  if (session.ruleset_version !== RAID_RULESET_VERSION) return fail(409, "stale_ruleset");
  if (body.wave !== session.current_wave) return fail(409, "stale_wave");
  if (!Number.isInteger(body.finalTick) || !Array.isArray(body.inputs)) return fail(400, "bad_transcript");
  const storedPayload = parse<RunPayload | null>(session.run_state_json, null);
  if (storedPayload?.pendingBossChoice) return fail(409, "boss_choice_pending");
  const pacedTick = Math.floor((now - session.fight_started_at) / 50) + 40;
  if (Number(body.finalTick) > pacedTick) return fail(422, "future_finish");
  const config = parse<FightConfig | null>(session.fight_config_json, null);
  const payload = storedPayload;
  if (!config || !payload || config.wave !== session.current_wave) return fail(409, "bad_session_state");
  const sim = simFor(config);
  const verified = replayRaid(sim, Number(body.finalTick), body.inputs as RaidReplayInput[]);
  if (!verified.ok) return fail(422, verified.error);
  const won = verified.outcome.win && !verified.retreated;
  const plan = endlessWavePlan(session.mode, session.current_wave, payload.run.stop, payload.run.weekSeed);
  let state = payload.run;
  if (won) {
    state = carryFromSim(state, sim);
    if (plan.bossGate) {
      // Persist the recovery and choice checkpoint before asking for the boon/curse.
      // A reload or lost response returns to this screen without replaying the boss.
    }
  }
  const durationMs = Math.max(0, payload.durationMs ?? 0) + Math.max(0, Number(body.finalTick)) * 50;
  const deepestFloor = won ? session.current_wave : session.current_wave - 1;
  const completed = !won;
  const awaitingBossChoice = won && plan.bossGate;
  // Every win pays loot in normal Endless: one small floor roll, or the boss's full roll, and
  // a skipper's first boss brings the skipped tiers' rolls with it. First-clear milestones pay
  // in both modes; Nightmare's loot tables are not written yet (docs/ENDLESS_MODE_REWARDS.md).
  const paysLoot = won && (session.mode === "endless" || plan.bossGate);
  const [coreRow, progressRow] = paysLoot
    ? await Promise.all([
      db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?")
        .bind(accountId).first<{ current_json: string }>(),
      plan.bossGate
        ? db.prepare("SELECT best_tier FROM endless_progress WHERE account_id=? AND mode=?")
          .bind(accountId, session.mode).first<{ best_tier: number }>()
        : Promise.resolve(null),
    ])
    : [null, null];
  if (paysLoot && !coreRow) return fail(409, "state_conflict");
  let loot: EndlessBossLoot[] = [];
  let rewardCore: EndlessRewardCore | null = null;
  let brainsEarned = 0;
  const startWave = payload.run.startWave;
  if (coreRow) {
    try { rewardCore = JSON.parse(coreRow.current_json) as EndlessRewardCore; }
    catch { return fail(409, "state_conflict"); }
    if (!rewardCore || typeof rewardCore !== "object" || !rewardCore.inventory || typeof rewardCore.inventory !== "object" ||
        !rewardCore.storage || typeof rewardCore.storage !== "object" || !rewardCore.storage.received || !rewardCore.storage.stored) {
      return fail(409, "state_conflict");
    }
    // Zwamp Things this run has paid so far, kept running so T7's guarantee sees them all.
    loot = rollEndlessWinLoot(session.mode, plan, session.current_wave, startWave,
      payload.lootEarned?.["Zwamp Thing"] ?? 0, Math.random);
    if (plan.bossGate) {
      loot.push(...endlessBossWinRewards(session.mode, plan.tier, progressRow?.best_tier ?? 0, Math.random));
      // The permanent unlocks (raid/endlessPerks.ts) all read this one number off the core
      // document. Recorded on every normal boss win, never lowered, and lifted to the
      // endless_progress best so an account that cleared tiers before it existed has them.
      if (session.mode === "endless") {
        rewardCore.endlessBestTier = Math.max(endlessBestTierOf(rewardCore), progressRow?.best_tier ?? 0, plan.tier);
      }
    }
    for (const reward of loot) {
      if (reward.kind === "boost") {
        rewardCore.inventory[reward.key] = Math.min(MAX_STACK, (rewardCore.inventory[reward.key] ?? 0) + reward.quantity);
      } else if (reward.kind === "item") {
        rewardCore.storage.received[reward.name] = (rewardCore.storage.received[reward.name] ?? 0) + 1;
      } else if (reward.kind === "brains") {
        brainsEarned += reward.quantity;
      } else if (reward.kind === "perk") {
        // Paid by endlessBestTier above.
      } else {
        const marker = encodeReceivedZombie({ id: crypto.randomUUID(), key: reward.key, mutation: 0, invasions: 0 });
        rewardCore.storage.received[marker] = 1;
      }
    }
  }
  const lootEarned = { ...(payload.lootEarned ?? {}) };
  for (const reward of loot) lootEarned[reward.name] = (lootEarned[reward.name] ?? 0) + reward.quantity;
  const losses = completed ? endlessLosses(payload.run, sim) : [];
  const fallen = completed ? await fallenRecords(db, accountId, losses) : null;
  const result = completed
    ? { ok: true, runFinished: true, deepestFloor: Math.max(0, deepestFloor), durationMs, gold: endlessGoldReward(deepestFloor, startWave), outcome: verified.outcome, losses,
      revival: endlessRevival(session.id, fallen!.snapshots) }
    : null;
  const nextState: RunPayload = awaitingBossChoice
    ? { run: state, playerLevel: payload.playerLevel, durationMs, lootEarned, pendingBossChoice: { wave: session.current_wave, ...(loot.length ? { loot } : {}) } }
    : { run: state, playerLevel: payload.playerLevel, durationMs, lootEarned };
  const nextConfig = completed || awaitingBossChoice ? null : fightConfig(state, payload.playerLevel);
  const resultJson = JSON.stringify(result);
  const update = db.prepare(`UPDATE endless_runs_v3 SET
      current_wave=?, run_state_json=?, fight_config_json=?, fight_started_at=?, finished_at=?, result_json=?
    WHERE id=? AND account_id=? AND finished_at IS NULL AND current_wave=? AND run_state_json=?`)
    .bind(completed || awaitingBossChoice ? session.current_wave : state.nextWave, JSON.stringify(nextState),
      nextConfig ? JSON.stringify(nextConfig) : session.fight_config_json, now,
      completed ? now : null, completed ? resultJson : null,
      session.id, accountId, session.current_wave, session.run_state_json);
  if (completed) {
    const committed = await db.batch(settleTerminalStatements(
      db, session, payload.run, deepestFloor, durationMs, now, update,
      buryStatements(db, session, losses, fallen!, resultJson, now),
    ));
    if (committed[0]?.meta?.changes !== 1) return fail(409, "stale_wave");
    if (endlessGoldReward(deepestFloor, startWave) > 0 && committed[1]?.meta?.changes !== 1) return fail(409, "state_conflict");
  } else if (rewardCore && coreRow) {
    // Loot first, and the run only advances on top of it: D1 does not roll a batch back for
    // a statement that matched no rows, so a farm write landing in between must stop both
    // or the run would move on without its reward. The floor is simply submitted again.
    const coreUpdate = db.prepare(`UPDATE gameplay_documents_v3 SET current_json=?,updated_at=?
      WHERE account_id=? AND current_json=? AND EXISTS (
        SELECT 1 FROM endless_runs_v3 WHERE id=? AND account_id=? AND finished_at IS NULL AND current_wave=? AND run_state_json=?
      )`).bind(JSON.stringify(rewardCore), now, accountId, coreRow.current_json,
      session.id, accountId, session.current_wave, session.run_state_json);
    const advance = db.prepare(`UPDATE endless_runs_v3 SET
        current_wave=?, run_state_json=?, fight_config_json=?, fight_started_at=?
      WHERE id=? AND account_id=? AND finished_at IS NULL AND current_wave=? AND run_state_json=? AND changes()=1`)
      .bind(awaitingBossChoice ? session.current_wave : state.nextWave, JSON.stringify(nextState),
        nextConfig ? JSON.stringify(nextConfig) : session.fight_config_json, now,
        session.id, accountId, session.current_wave, session.run_state_json);
    // Everything else keys off the run having really moved on to this very state.
    const advanced = "EXISTS (SELECT 1 FROM endless_runs_v3 WHERE id=? AND run_state_json=?)";
    const moved = [session.id, JSON.stringify(nextState)];
    const statements = [coreUpdate, advance];
    if (brainsEarned > 0) {
      statements.push(db.prepare(`UPDATE balances SET brains=brains+? WHERE account_id=? AND ${advanced}`)
        .bind(brainsEarned, accountId, ...moved));
      statements.push(db.prepare(`INSERT INTO ledger (id,account_id,currency,delta,reason,created_at)
        SELECT ?,?,'brains',?,'endless_milestone',? WHERE ${advanced}`)
        .bind(`endless:${session.id}:brains:${session.current_wave}`, accountId, brainsEarned, now, ...moved));
    }
    if (plan.bossGate && plan.tier > (progressRow?.best_tier ?? 0)) {
      statements.push(db.prepare(`INSERT INTO endless_progress (account_id,mode,best_tier,updated_at)
        SELECT ?,?,?,? WHERE ${advanced}
        ON CONFLICT(account_id,mode) DO UPDATE SET best_tier=MAX(best_tier,excluded.best_tier),updated_at=excluded.updated_at`)
        .bind(accountId, session.mode, plan.tier, now, ...moved));
    }
    const committed = await db.batch(statements);
    if (committed[0]?.meta?.changes !== 1 || committed[1]?.meta?.changes !== 1) return fail(409, "state_conflict");
  } else {
    const committed = await update.run();
    if (committed.meta.changes !== 1) return fail(409, "stale_wave");
  }
  return { status: 200, body: completed ? result! : awaitingBossChoice ? {
    ok: true, runFinished: false, won: true, clearedWave: session.current_wave,
    awaitingBossChoice: true, ...endlessBossScreen(session.mode, nextState.pendingBossChoice!, nextState),
  } : {
    ok: true, runFinished: false, won: true, clearedWave: session.current_wave,
    nextWave: state.nextWave, fight: nextConfig, floorLoot: loot,
  } };
}

/** Commit a boss reward choice and open the next battle. The draft and cleared boss
 *  are derived from the stored checkpoint, never from client-supplied progression. */
export async function chooseEndlessBossReward(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown; boon?: unknown; curse?: unknown; location?: unknown; order?: unknown },
  now: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return fail(400, "bad_session");
  const found = await db.prepare("SELECT * FROM endless_runs_v3 WHERE id=? AND account_id=?")
    .bind(body.sessionId, accountId).first<StoredRun>();
  if (!found) return fail(404, "bad_session");
  let session = found;
  if (session.finished_at) return fail(409, "run_finished");
  if (session.ruleset_version !== RAID_RULESET_VERSION) {
    // A boss choice holds no fight, so an update in between costs nothing: carry on.
    session = await rearmForRuleset(db, session, now);
    if (session.ruleset_version !== RAID_RULESET_VERSION) return fail(409, "stale_ruleset");
  }
  const payload = parse<RunPayload | null>(session.run_state_json, null);
  const pending = payload?.pendingBossChoice;
  if (!payload || !pending || pending.wave !== session.current_wave) return fail(409, "no_boss_choice_pending");
  const draft = endlessDraftFor(session.mode, pending, payload.run);
  const locationOffered = draft.locations.length === 0 || offered(body.location, draft.locations);
  if (!offered(body.boon, draft.boons) || !offered(body.curse, draft.curses) || !locationOffered) {
    return fail(400, "bad_boss_draft_choice");
  }
  let run = applyEndlessCurse(endlessApplyBoon(payload.run, body.boon as EndlessBoon, payload.playerLevel, payload.lifeForceLevel), body.curse as EndlessCurse);
  if (draft.locations.length) run = applyEndlessStop(run, body.location as EndlessStop);
  if (body.order !== undefined) {
    const ordered = applyEndlessOrder(run, body.order);
    if (!ordered) return fail(400, "bad_army_order");
    run = ordered;
  }
  // More of the opening draft to go: the next skipped tier's screen, and still no fight.
  const nextOpening = pending.opening ? pending.wave + ENDLESS_FIGHTS_PER_LOCATION : 0;
  if (nextOpening && nextOpening < run.startWave) {
    const opening: RunPayload = {
      ...payload, run, pendingBossChoice: { wave: nextOpening, opening: true },
    };
    const step = await db.prepare(`UPDATE endless_runs_v3 SET current_wave=?, run_state_json=?
      WHERE id=? AND account_id=? AND finished_at IS NULL AND current_wave=?`)
      .bind(nextOpening, JSON.stringify(opening), session.id, accountId, session.current_wave).run();
    if (step.meta.changes !== 1) return fail(409, "stale_wave");
    return { status: 200, body: { ok: true, runFinished: false, stage: "boss-choice", ...endlessBossScreen(session.mode, opening.pendingBossChoice!, opening) } };
  }
  const nextPayload: RunPayload = { run, playerLevel: payload.playerLevel, durationMs: payload.durationMs ?? 0, lootEarned: payload.lootEarned ?? {} };
  const fight = fightConfig(run, payload.playerLevel);
  const update = await db.prepare(`UPDATE endless_runs_v3 SET current_wave=?, run_state_json=?,
      fight_config_json=?, fight_started_at=?
    WHERE id=? AND account_id=? AND finished_at IS NULL AND current_wave=?`)
    .bind(run.nextWave, JSON.stringify(nextPayload), JSON.stringify(fight), now,
      session.id, accountId, session.current_wave).run();
  if (update.meta.changes !== 1) return fail(409, "stale_wave");
  return { status: 200, body: { ok: true, runFinished: false, nextWave: run.nextWave, fight } };
}

/** Carry a live run across a battle-rules update (owner, 2026-11-08: a run must survive the
 *  game closing, including for an update). A run started under an older RAID_RULESET_VERSION
 *  used to be refused on every save forever. Now: a pending boss choice simply carries on,
 *  since it holds no fight, and a floor that was mid-fight is rebuilt from the saved run under
 *  the current rules and restarted. The army is as it entered that floor; nothing earned is lost.
 *  Returns the session as it now stands. */
async function rearmForRuleset(db: D1Database, session: StoredRun, now: number): Promise<StoredRun> {
  if (session.finished_at || session.ruleset_version === RAID_RULESET_VERSION) return session;
  const payload = parse<RunPayload | null>(session.run_state_json, null);
  if (!payload) return session;
  const fight = payload.pendingBossChoice ? null : fightConfig(payload.run, payload.playerLevel);
  const fightJson = fight ? JSON.stringify(fight) : session.fight_config_json;
  const update = await db.prepare(`UPDATE endless_runs_v3 SET ruleset_version=?, fight_config_json=?, fight_started_at=?
    WHERE id=? AND account_id=? AND finished_at IS NULL AND ruleset_version=?`)
    .bind(RAID_RULESET_VERSION, fightJson, now, session.id, session.account_id, session.ruleset_version).run();
  if (update.meta.changes !== 1) return session;
  return { ...session, ruleset_version: RAID_RULESET_VERSION, fight_config_json: fightJson, fight_started_at: now };
}

/** A voluntary exit closes the run at the last fully-cleared floor. */
export async function abandonEndless(
  db: D1Database,
  accountId: string,
  sessionId: unknown,
  now: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof sessionId !== "string" || !sessionId) return fail(400, "bad_session");
  const session = await db.prepare("SELECT * FROM endless_runs_v3 WHERE id=? AND account_id=?")
    .bind(sessionId, accountId).first<StoredRun>();
  if (!session) return fail(404, "bad_session");
  if (session.finished_at) return { status: 200, body: parse(session.result_json ?? "", { ok: true, runFinished: true }) };
  const payload = parse<RunPayload | null>(session.run_state_json, null);
  const pending = payload?.pendingBossChoice;
  const deepestFloor = pending?.opening ? 0 : pending?.wave ?? session.current_wave - 1;
  const durationMs = Math.max(0, payload?.durationMs ?? 0);
  const run = payload?.run ?? beginEndlessRun(session.mode, []);
  const gold = endlessGoldReward(deepestFloor, run.startWave);
  const losses = endlessLosses(run);
  const fallen = await fallenRecords(db, accountId, losses);
  const result = { ok: true, runFinished: true, deepestFloor, durationMs, gold, abandoned: true, losses,
    revival: endlessRevival(session.id, fallen.snapshots) };
  const resultJson = JSON.stringify(result);
  const update = db.prepare(`UPDATE endless_runs_v3 SET finished_at=?,result_json=?
    WHERE id=? AND account_id=? AND finished_at IS NULL`).bind(now, resultJson, session.id, accountId);
  const committed = await db.batch(settleTerminalStatements(db, session, run, deepestFloor, durationMs, now, update,
    buryStatements(db, session, losses, fallen, resultJson, now)));
  if (committed[0]?.meta?.changes !== 1) return fail(409, "run_finished");
  if (gold > 0 && committed[1]?.meta?.changes !== 1) return fail(409, "state_conflict");
  return { status: 200, body: result };
}

/** Resume a live run without allowing the client to replace its state or fight config. */
export async function activeEndless(
  db: D1Database,
  accountId: string,
  now = Date.now(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = await db.prepare(`SELECT * FROM endless_runs_v3
    WHERE account_id=? AND finished_at IS NULL`).bind(accountId).first<StoredRun>();
  // Resuming after an update re-arms the run under the current battle rules.
  const session = found ? await rearmForRuleset(db, found, now) : null;
  // No run going: say whether the next one is the day's free one, for the start button.
  if (!session) {
    return { status: 404, body: { ok: false, error: "no_active_run", freeRunAvailable: await freeRunAvailable(db, accountId, now) } };
  }
  const payload = parse<RunPayload>(session.run_state_json, { run: beginEndlessRun(session.mode, []), playerLevel: 30, durationMs: 0 });
  const pendingBossChoice = payload.pendingBossChoice;
  return { status: 200, body: {
    ok: true, sessionId: session.id, mode: session.mode, wave: session.current_wave,
    stage: pendingBossChoice ? "boss-choice" : "battle",
    ...(pendingBossChoice ? endlessBossScreen(session.mode, pendingBossChoice, payload)
      : { fight: parse(session.fight_config_json, null) }),
    run: payload.run,
  } };
}
