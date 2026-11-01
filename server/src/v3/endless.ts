import enemyStatsJson from "../../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../../public/assets/raids/attacks.json";
import zombiesJson from "../../../public/assets/zombies.json";
import { buildFight } from "../../../src/raid/buildFight";
import { buildPlayerUnits, buildUnitsForKeys } from "../../../src/raid/CombatEngine";
import {
  applyEndlessBoon, applyEndlessCurse, applyEndlessEnemyCurses, beginEndlessRun,
  endlessBossDraft, endlessPlayerUnits, endlessWavePlan, finishEndlessFight,
  scaleEndlessEnemy, endlessBossMultiplier, ENDLESS_ENTRY_COST, ENDLESS_UNLOCK_LEVEL,
  type EndlessBoon, type EndlessCurse, type EndlessMode, type EndlessRunState,
} from "../../../src/raid/endless";
import { buildEndlessStageMechanics } from "../../../src/raid/endlessMechanics";
import { waveCadenceFor } from "../../../src/raid/alienStage";
import { epicBossDamage, epicBossHp, DR_GROUNDHOG, GALACTIC_GROUNDHOG } from "../../../src/epicBoss/catalog";
import { makeOwned, type OwnedZombie } from "../../../src/zombie/types";
import { loadMutationStrengthMultiplier } from "../raidVerifier";
import { abilitySlotUnlocked } from "../../../src/lifeForce";
import { farmerMultiplier, activeBonusHeadId } from "../../../src/farmer";
import { ARMY_CAP } from "../../../src/raid/RaidCatalog";
import { replayRaid, RAID_RULESET_VERSION, type RaidReplayInput } from "../../../src/raid/replay";
import type { AttackDef, BossSpecial, CombatUnit, EnemyStat, EndlessStageMechanics, WaveCadence } from "../../../src/raid/types";
import { levelForXp } from "../levels";
import { recordEndlessLeaderboardStatement, type EndlessLeaderboardArmyMember } from "../db";
import { MAX_STACK } from "../boostCatalog";
import { encodeReceivedZombie } from "../../../src/zombie/receivedReward";
import { rollEndlessBossLoot, type EndlessBossLoot } from "../../../src/raid/endlessLoot";

const enemyStats = enemyStatsJson as Record<string, EnemyStat>;
const attacks = attacksJson as Record<string, AttackDef>;
const zombies = new Map((zombiesJson as Array<{ key: string }>).map((z) => [z.key, z]));
const raidId: Record<string, number> = { farm: 1, ninja: 3, alien: 6, "video-game": 9, pirate: 4 };
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

interface FightConfig {
  wave: number;
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  bossSpecials: BossSpecial[];
  bossFallsFromSky: boolean;
  noDistractions: boolean;
  escapeOnRoundEnd: boolean;
  roundMs?: number;
  endlessMechanics: EndlessStageMechanics;
  waveCadence?: WaveCadence;
}

interface RunPayload {
  run: EndlessRunState;
  playerLevel: number;
  /** Accumulated combat time, excluding time spent disconnected or on a draft screen. */
  durationMs: number;
  /** A cleared boss awaiting its durable boon/curse choice. */
  pendingBossChoice?: { wave: number; loot?: EndlessBossLoot[] };
}
interface EndlessRewardCore {
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  [key: string]: unknown;
}
const parse = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
const fail = (status: number, error: string) => ({ status, body: { ok: false, error } });

function isMode(mode: unknown): mode is EndlessMode { return mode === "endless" || mode === "nightmare"; }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function offered<T>(choice: unknown, choices: readonly T[]): choice is T {
  const encoded = stable(choice);
  return choices.some((candidate) => stable(candidate) === encoded);
}

function epicBossUnit(mode: EndlessMode, wave: number, playerLevel: number): { unit: CombatUnit; specials: BossSpecial[]; roundMs: number } {
  const plan = endlessWavePlan(mode, wave);
  const def = mode === "nightmare" ? GALACTIC_GROUNDHOG : DR_GROUNDHOG;
  const bossMultiplier = endlessBossMultiplier(mode, wave);
  const hp = Math.max(1, Math.round(epicBossHp(def, 1) * plan.healthScale * bossMultiplier));
  const unit: CombatUnit = {
    id: `endless-boss-${wave}`, sourceKey: `EpicBoss:${def.id}`, team: "enemy", name: def.name,
    str: epicBossDamage(def, 1) * plan.damageScale * bossMultiplier, dex: def.unitStats.dex, con: def.unitStats.con,
    focus: 0, hp, maxHp: hp, attackCooldownMs: Math.max(1, Math.round(1000 / Math.max(0.1, def.unitStats.dex))),
    attacks: def.unitStats.attacks.map((a) => ({ name: a.name, frequency: a.frequency, mult: a.mult ?? 1 })),
    isBoss: true, alive: true, isGarden: false, isHeadless: false, abilities: [],
  };
  const specials = (def.specials ?? []).map((s) => ({
    name: s.name, weight: s.weight, castMs: s.castMs, cooldownMs: s.cooldownMs, damage: s.damage * bossMultiplier,
  }));
  void playerLevel;
  return { unit, specials, roundMs: def.fightMs };
}

function fightConfig(run: EndlessRunState, playerLevel: number): FightConfig {
  const plan = endlessWavePlan(run.mode, run.nextWave);
  const mechanics = buildEndlessStageMechanics(plan, playerLevel, undefined, run.curses);
  mechanics.deploymentSpeedBonus = run.deploymentSpeedBonus;
  mechanics.openingDeploy = run.openingDeploy;
  const waveCadence: WaveCadence = plan.location === "alien"
    ? waveCadenceFor(6)
    : { maxActive: plan.pairDeploy ? 2 : 1, dripMs: 0, openingActive: plan.pairDeploy ? 2 : 1 };
  if (plan.bossGate) {
    const boss = epicBossUnit(run.mode, plan.wave, playerLevel);
    return {
      wave: plan.wave,
      playerUnits: endlessPlayerUnits(run),
      enemyUnits: [applyEndlessEnemyCurses(boss.unit, run.curses)],
      bossSpecials: boss.specials,
      bossFallsFromSky: true,
      noDistractions: true,
      escapeOnRoundEnd: true,
      roundMs: boss.roundMs,
      endlessMechanics: mechanics,
      waveCadence,
    };
  }
  const enemyUnits = buildUnitsForKeys([...plan.enemyKeys], null, enemyStats, attacks, {
    raidId: raidId[plan.location], playerLevel,
  }).map((unit) => scaleEndlessEnemy(unit, plan, run.curses));
  return {
    wave: plan.wave,
    playerUnits: endlessPlayerUnits(run), enemyUnits, bossSpecials: [],
    bossFallsFromSky: false, noDistractions: false, escapeOnRoundEnd: false,
    endlessMechanics: mechanics,
    waveCadence,
  };
}

function simFor(config: FightConfig) {
  return buildFight({
    playerUnits: config.playerUnits,
    enemyUnits: config.enemyUnits,
    bossSpecials: config.bossSpecials,
    bossFallsFromSky: config.bossFallsFromSky,
    noDistractions: config.noDistractions,
    escapeOnRoundEnd: config.escapeOnRoundEnd,
    roundMs: config.roundMs,
    endlessMechanics: config.endlessMechanics,
    waveCadence: config.waveCadence,
  });
}

function carryFromSim(run: EndlessRunState, sim: ReturnType<typeof simFor>) {
  const states = new Map(sim.units.filter((unit) => unit.team === "player").map((unit) => [unit.id, unit]));
  const battleUnits = run.units.map((unit) => {
    const state = states.get(unit.id);
    return state ? { ...unit, hp: state.hp, alive: state.alive } : unit;
  });
  return finishEndlessFight(run, battleUnits);
}

function leaderboardArmy(party: readonly OwnedZombie[]): EndlessLeaderboardArmyMember[] {
  return party.map((unit) => ({
    species: unit.key,
    mutation: unit.mutation,
    veterancy: Math.max(0, Math.min(5, Math.trunc(unit.invasions))),
  }));
}

/** The depth payout is 250 gold per fight per section number: 250/fight in T1,
 *  500/fight in T2, and so on. It is awarded once when a run ends, based only on
 *  fully cleared fights. */
function endlessGoldReward(deepestFloor: number): number {
  let total = 0;
  for (let wave = 1; wave <= Math.max(0, Math.floor(deepestFloor)); wave++) {
    total += 250 * Math.ceil(wave / 4);
  }
  return total;
}

function settleTerminalStatements(
  db: D1Database,
  session: StoredRun,
  deepestFloor: number,
  durationMs: number,
  now: number,
  update: D1PreparedStatement,
): D1PreparedStatement[] {
  const statements = [update];
  const gold = endlessGoldReward(deepestFloor);
  if (gold > 0) {
    statements.push(db.prepare(`UPDATE balances SET gold=gold+?
      WHERE account_id=? AND changes()=1`).bind(gold, session.account_id));
    statements.push(db.prepare(`INSERT INTO ledger (id,account_id,currency,delta,reason,created_at)
      SELECT ?,?,'gold',?,'endless_depth',? WHERE changes()=1`)
      .bind(`endless:${session.id}:gold`, session.account_id, gold, now));
  }
  if (deepestFloor > 0) statements.push(recordEndlessLeaderboardStatement(db, {
    accountId: session.account_id, mode: session.mode, deepestFloor, durationMs,
    army: parse<EndlessLeaderboardArmyMember[]>(session.army_json, []), achievedAt: now,
  }, "changes()=1"));
  return statements;
}

/** Start an account-owned Endless run. The cost and opening roster are pinned server-side. */
export async function startEndless(
  db: D1Database,
  accountId: string,
  body: { mode?: unknown; orderedUnitIds?: unknown; rulesetVersion?: unknown },
  now: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isMode(body.mode)) return fail(400, "bad_mode");
  const mode = body.mode;
  if (body.rulesetVersion !== RAID_RULESET_VERSION) return fail(426, "stale_ruleset");
  if (!Array.isArray(body.orderedUnitIds) || !body.orderedUnitIds.length || body.orderedUnitIds.length > ARMY_CAP ||
      body.orderedUnitIds.some((id) => typeof id !== "string" || !id) ||
      new Set(body.orderedUnitIds).size !== body.orderedUnitIds.length) return fail(400, "bad_roster");
  const ids = body.orderedUnitIds as string[];
  const [balance, coreRow, roster, liveRaid, liveBoss, liveRun, mutationStrengthMult] = await Promise.all([
    db.prepare("SELECT xp,brains FROM balances WHERE account_id=?").bind(accountId).first<{ xp: number; brains: number }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").bind(accountId).first<{ current_json: string }>(),
    db.prepare(`SELECT unit_id,zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND stored=0 AND locked_by_raid IS NULL AND unit_id IN (${ids.map(() => "?").join(",")})`)
      .bind(accountId, ...ids).all<{ unit_id: string; zombie_key: string; mutation: number; invasions: number }>(),
    db.prepare("SELECT id FROM raid_sessions_v3 WHERE account_id=? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    db.prepare("SELECT id FROM epic_boss_sessions_v3 WHERE account_id=? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    db.prepare("SELECT id FROM endless_runs_v3 WHERE account_id=? AND finished_at IS NULL").bind(accountId).first<{ id: string }>(),
    loadMutationStrengthMultiplier(db, accountId),
  ]);
  if (!balance || !coreRow) return fail(409, "state_conflict");
  const level = levelForXp(balance.xp);
  if (level < ENDLESS_UNLOCK_LEVEL[mode]) return fail(403, "locked");
  if (balance.brains < ENDLESS_ENTRY_COST[mode]) return fail(409, "no_brains");
  if (liveRaid || liveBoss || liveRun) return fail(409, "run_in_progress");
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
  const farmerHead = Number(core.farmerHeadId ?? 1);
  const bonusHead = activeBonusHeadId(farmerHead, core.farmerBonusHeadId as number | null | undefined);
  const playerUnits = buildPlayerUnits(party, {
    playerLevel: level,
    abilitySlotUnlocked: (slot) => abilitySlotUnlocked(slot, level),
    farmerStrengthMult: farmerMultiplier(bonusHead, "zombieStrength"),
    farmerLifeMult: farmerMultiplier(bonusHead, "zombieLife"),
    farmerDexMult: farmerMultiplier(bonusHead, "zombieDex"),
    mutationStrengthMult: mutationStrengthMult * farmerMultiplier(bonusHead, "mutationStrength"),
  });
  const state: RunPayload = { run: beginEndlessRun(mode, playerUnits), playerLevel: level, durationMs: 0 };
  const config = fightConfig(state.run, level);
  const sessionId = crypto.randomUUID();
  const armyJson = JSON.stringify(leaderboardArmy(party));
  try {
    const results = await db.batch([
      db.prepare("UPDATE balances SET brains=brains-? WHERE account_id=? AND brains>=?")
        .bind(ENDLESS_ENTRY_COST[mode], accountId, ENDLESS_ENTRY_COST[mode]),
      db.prepare(`INSERT INTO endless_runs_v3
        (id,account_id,mode,current_wave,run_state_json,army_json,fight_config_json,ruleset_version,started_at,fight_started_at)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()=1`)
        .bind(sessionId, accountId, mode, 1, JSON.stringify(state), armyJson, JSON.stringify(config), RAID_RULESET_VERSION, now, now),
    ]);
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) return fail(409, "no_brains");
  } catch {
    return fail(409, "run_in_progress");
  }
  return { status: 200, body: {
    ok: true, sessionId, mode, wave: 1, fight: config, brainCost: ENDLESS_ENTRY_COST[mode],
    rulesetVersion: RAID_RULESET_VERSION,
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
  const plan = endlessWavePlan(session.mode, session.current_wave);
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
  let bossLoot: EndlessBossLoot[] = [];
  let rewardCoreBefore: string | null = null;
  let rewardCore: EndlessRewardCore | null = null;
  if (awaitingBossChoice && session.mode === "endless") {
    const coreRow = await db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?")
      .bind(accountId).first<{ current_json: string }>();
    if (!coreRow) return fail(409, "state_conflict");
    rewardCoreBefore = coreRow.current_json;
    try { rewardCore = JSON.parse(coreRow.current_json) as EndlessRewardCore; }
    catch { return fail(409, "state_conflict"); }
    if (!rewardCore || typeof rewardCore !== "object" || !rewardCore.inventory || typeof rewardCore.inventory !== "object" ||
        !rewardCore.storage || typeof rewardCore.storage !== "object" || !rewardCore.storage.received || !rewardCore.storage.stored) {
      return fail(409, "state_conflict");
    }
    bossLoot = rollEndlessBossLoot(Math.floor(session.current_wave / 4), plan.location,
      Math.random(), Math.random(), Math.random());
    for (const reward of bossLoot) {
      if (reward.kind === "boost") {
        rewardCore.inventory[reward.key] = Math.min(MAX_STACK, (rewardCore.inventory[reward.key] ?? 0) + reward.quantity);
      } else if (reward.kind === "item") {
        rewardCore.storage.received[reward.name] = (rewardCore.storage.received[reward.name] ?? 0) + 1;
      } else {
        const marker = encodeReceivedZombie({ id: crypto.randomUUID(), key: reward.key, mutation: 0, invasions: 0 });
        rewardCore.storage.received[marker] = 1;
      }
    }
  }
  const result = completed
    ? { ok: true, runFinished: true, deepestFloor: Math.max(0, deepestFloor), durationMs, gold: endlessGoldReward(deepestFloor), outcome: verified.outcome }
    : null;
  const nextState: RunPayload = awaitingBossChoice
    ? { run: state, playerLevel: payload.playerLevel, durationMs, pendingBossChoice: { wave: session.current_wave, ...(bossLoot.length ? { loot: bossLoot } : {}) } }
    : { run: state, playerLevel: payload.playerLevel, durationMs };
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
      db, session, deepestFloor, durationMs, now, update,
    ));
    if (committed[0]?.meta?.changes !== 1) return fail(409, "stale_wave");
    if (endlessGoldReward(deepestFloor) > 0 && committed[1]?.meta?.changes !== 1) return fail(409, "state_conflict");
  } else if (awaitingBossChoice && rewardCore && rewardCoreBefore !== null) {
    const coreUpdate = db.prepare(`UPDATE gameplay_documents_v3 SET current_json=?,updated_at=?
      WHERE account_id=? AND current_json=? AND EXISTS (
        SELECT 1 FROM endless_runs_v3 WHERE id=? AND account_id=? AND current_wave=? AND run_state_json=?
      )`).bind(JSON.stringify(rewardCore), now, accountId, rewardCoreBefore,
      session.id, accountId, session.current_wave, JSON.stringify(nextState));
    const committed = await db.batch([update, coreUpdate]);
    if (committed[0]?.meta?.changes !== 1 || committed[1]?.meta?.changes !== 1) return fail(409, "state_conflict");
  } else {
    const committed = await update.run();
    if (committed.meta.changes !== 1) return fail(409, "stale_wave");
  }
  return { status: 200, body: completed ? result! : awaitingBossChoice ? {
    ok: true, runFinished: false, won: true, clearedWave: session.current_wave,
    awaitingBossChoice: true, bossDraft: endlessBossDraft(session.mode, session.current_wave), bossLoot,
  } : {
    ok: true, runFinished: false, won: true, clearedWave: session.current_wave,
    nextWave: state.nextWave, fight: nextConfig,
  } };
}

/** Commit a boss reward choice and open the next battle. The draft and cleared boss
 *  are derived from the stored checkpoint, never from client-supplied progression. */
export async function chooseEndlessBossReward(
  db: D1Database,
  accountId: string,
  body: { sessionId?: unknown; boon?: unknown; curse?: unknown },
  now: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof body.sessionId !== "string" || !body.sessionId) return fail(400, "bad_session");
  const session = await db.prepare("SELECT * FROM endless_runs_v3 WHERE id=? AND account_id=?")
    .bind(body.sessionId, accountId).first<StoredRun>();
  if (!session) return fail(404, "bad_session");
  if (session.finished_at) return fail(409, "run_finished");
  if (session.ruleset_version !== RAID_RULESET_VERSION) return fail(409, "stale_ruleset");
  const payload = parse<RunPayload | null>(session.run_state_json, null);
  const pending = payload?.pendingBossChoice;
  if (!payload || !pending || pending.wave !== session.current_wave) return fail(409, "no_boss_choice_pending");
  const draft = endlessBossDraft(session.mode, pending.wave);
  if (!offered(body.boon, draft.boons) || !offered(body.curse, draft.curses)) return fail(400, "bad_boss_draft_choice");
  const run = applyEndlessCurse(applyEndlessBoon(payload.run, body.boon as EndlessBoon), body.curse as EndlessCurse);
  const nextPayload: RunPayload = { run, playerLevel: payload.playerLevel, durationMs: payload.durationMs ?? 0 };
  const fight = fightConfig(run, payload.playerLevel);
  const update = await db.prepare(`UPDATE endless_runs_v3 SET current_wave=?, run_state_json=?,
      fight_config_json=?, fight_started_at=?
    WHERE id=? AND account_id=? AND finished_at IS NULL AND current_wave=?`)
    .bind(run.nextWave, JSON.stringify(nextPayload), JSON.stringify(fight), now,
      session.id, accountId, session.current_wave).run();
  if (update.meta.changes !== 1) return fail(409, "stale_wave");
  return { status: 200, body: { ok: true, runFinished: false, nextWave: run.nextWave, fight } };
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
  const deepestFloor = payload?.pendingBossChoice?.wave ?? session.current_wave - 1;
  const durationMs = Math.max(0, payload?.durationMs ?? 0);
  const result = { ok: true, runFinished: true, deepestFloor, durationMs, gold: endlessGoldReward(deepestFloor), abandoned: true };
  const update = db.prepare(`UPDATE endless_runs_v3 SET finished_at=?,result_json=?
    WHERE id=? AND account_id=? AND finished_at IS NULL`).bind(now, JSON.stringify(result), session.id, accountId);
  const committed = await db.batch(settleTerminalStatements(db, session, deepestFloor, durationMs, now, update));
  if (committed[0]?.meta?.changes !== 1) return fail(409, "run_finished");
  if (endlessGoldReward(deepestFloor) > 0 && committed[1]?.meta?.changes !== 1) return fail(409, "state_conflict");
  return { status: 200, body: result };
}

/** Resume a live run without allowing the client to replace its state or fight config. */
export async function activeEndless(
  db: D1Database,
  accountId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const session = await db.prepare(`SELECT * FROM endless_runs_v3
    WHERE account_id=? AND finished_at IS NULL`).bind(accountId).first<StoredRun>();
  if (!session) return fail(404, "no_active_run");
  const payload = parse<RunPayload>(session.run_state_json, { run: beginEndlessRun(session.mode, []), playerLevel: 30, durationMs: 0 });
  const pendingBossChoice = payload.pendingBossChoice;
  return { status: 200, body: {
    ok: true, sessionId: session.id, mode: session.mode, wave: session.current_wave,
    stage: pendingBossChoice ? "boss-choice" : "battle",
    ...(pendingBossChoice ? { bossDraft: endlessBossDraft(session.mode, pendingBossChoice.wave), bossLoot: pendingBossChoice.loot ?? [] }
      : { fight: parse(session.fight_config_json, null) }),
    run: payload.run,
  } };
}
