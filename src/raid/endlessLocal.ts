// Endless Mode for a LOCAL farm (owner, 2026-11-11: "local farms can also do endless mode.
// They will not show up on the leaderboards though").
//
// An online account's run lives on the Worker (server/src/v3/endless.ts). A local farm has
// no Worker, so this module plays the Worker's part on the device: it keeps the run in the
// save, builds each floor with the same fight builder, replays the finished floor's
// transcript to carry the army forward, and rolls the same loot through the same shared
// rules (raid/endlessRunRules.ts). Its answers have the same shapes as the Worker's
// /endless/* responses, so the screens drive both alike. What it never does is post a
// score: a local run is not ranked.

import type { OwnedZombie } from "../zombie/types";
import type { CombatUnit } from "./types";
import {
  applyEndlessCurse, applyEndlessOrder, applyEndlessStop, beginEndlessRun, endlessFreeDayStart,
  endlessMaxStartTier, endlessModeOpen, endlessWavePlan, endlessWeekSeed,
  ENDLESS_ENTRY_COST, ENDLESS_FIGHTS_PER_LOCATION, ENDLESS_UNLOCK_LEVEL,
  type EndlessBoon, type EndlessCurse, type EndlessMode, type EndlessStop,
} from "./endless";
import {
  endlessApplyBoon, endlessCarryFromSim, endlessFightConfig, endlessSimFor, type EndlessFightConfig,
} from "./endlessFight";
import type { EndlessBossLoot } from "./endlessLoot";
import {
  endlessBossScreen, endlessBossWinRewards, endlessDraftFor, endlessGoldReward,
  endlessLosses, endlessOffered, rollEndlessWinLoot, type EndlessRunPayload,
} from "./endlessRunRules";
import { replayRaid, RAID_RULESET_VERSION, type RaidReplayInput } from "./replay";

/** A local run, as the save keeps it. */
export interface EndlessLocalRun {
  id: string;
  mode: EndlessMode;
  currentWave: number;
  payload: EndlessRunPayload;
  /** The floor being fought; null while a boss choice is pending. */
  fight: EndlessFightConfig | null;
  /** The battle rules the fight was built under: an older one is rebuilt on resume. */
  ruleset: number;
  startedAt: number;
}

/** What a local farm saves for Endless (SaveGame.endless). */
export interface EndlessLocalSave {
  /** Deepest normal tier cleared: the permanent unlocks read it (raid/endlessPerks.ts). */
  bestTier: number;
  /** When the last normal run started (the day's first is free). */
  lastRunStartedAt?: number;
  run?: EndlessLocalRun | null;
}

/** Everything the engine needs from the farm. */
export interface EndlessLocalHost {
  now(): number;
  random(): number;
  newId(): string;
  level(): number;
  brains(): number;
  spendBrains(n: number): boolean;
  concentrations(): number;
  useConcentration(): boolean;
  /** The farm's (not stored) zombies with these ids, in this order; null if any is missing. */
  party(ids: readonly string[]): OwnedZombie[] | null;
  /** Combat units for a party, with the farm's own multipliers and veterancy ceiling. */
  buildUnits(party: OwnedZombie[], level: number): CombatUnit[];
  load(): EndlessLocalSave;
  store(save: EndlessLocalSave): void;
  /** Pay loot as it is won (boosts, items, zombies, brains). */
  payLoot(loot: readonly EndlessBossLoot[]): void;
  payGold(gold: number): void;
}

/** A refusal, shaped like the Worker's error body. */
export class EndlessLocalError extends Error {
  constructor(public status: number, public code: string, public body?: unknown) {
    super(`${code} (${status})`);
  }
}

export interface EndlessRunEnd {
  ok: true; runFinished: true; deepestFloor: number; durationMs: number; gold: number;
  losses: string[]; abandoned?: boolean;
}

export class EndlessLocalEngine {
  constructor(private readonly host: EndlessLocalHost) {}

  private save(): EndlessLocalSave {
    const save = this.host.load();
    return { bestTier: Math.max(0, Math.floor(save.bestTier || 0)), lastRunStartedAt: save.lastRunStartedAt, run: save.run ?? null };
  }

  freeRunAvailable(): boolean {
    const last = this.save().lastRunStartedAt ?? 0;
    return last < endlessFreeDayStart(this.host.now());
  }

  /** A run started under older battle rules: rebuild its floor under the current ones. */
  private rearm(run: EndlessLocalRun): EndlessLocalRun {
    if (run.ruleset === RAID_RULESET_VERSION) return run;
    const fight = run.payload.pendingBossChoice ? null : endlessFightConfig(run.payload.run, run.payload.playerLevel);
    return { ...run, fight, ruleset: RAID_RULESET_VERSION };
  }

  private liveRun(sessionId: unknown): { save: EndlessLocalSave; run: EndlessLocalRun } {
    const save = this.save();
    if (typeof sessionId !== "string" || !save.run || save.run.id !== sessionId) throw new EndlessLocalError(404, "bad_session");
    const run = this.rearm(save.run);
    return { save, run };
  }

  start(mode: EndlessMode, orderedUnitIds: string[], startTier = 1, concentration = false) {
    if (!endlessModeOpen(mode)) throw new EndlessLocalError(404, "mode_closed");
    const save = this.save();
    if (save.run) throw new EndlessLocalError(409, "run_in_progress");
    const level = this.host.level();
    if (level < ENDLESS_UNLOCK_LEVEL[mode]) throw new EndlessLocalError(403, "locked");
    if (!Number.isInteger(startTier) || startTier < 1 || startTier > endlessMaxStartTier(mode, level)) {
      throw new EndlessLocalError(403, "start_tier_locked");
    }
    if (!orderedUnitIds.length || new Set(orderedUnitIds).size !== orderedUnitIds.length) throw new EndlessLocalError(400, "bad_roster");
    const party = this.host.party(orderedUnitIds);
    if (!party || party.length !== orderedUnitIds.length) throw new EndlessLocalError(409, "bad_roster");
    const now = this.host.now();
    const free = mode === "endless" && this.freeRunAvailable();
    const entryCost = free ? 0 : ENDLESS_ENTRY_COST[mode];
    if (this.host.brains() < entryCost) throw new EndlessLocalError(409, "no_brains");
    if (concentration && this.host.concentrations() < 1) throw new EndlessLocalError(409, "no_concentration");
    if (entryCost > 0 && !this.host.spendBrains(entryCost)) throw new EndlessLocalError(409, "no_brains");
    if (concentration) this.host.useConcentration();

    const payload: EndlessRunPayload = {
      run: beginEndlessRun(mode, this.host.buildUnits(party, level), endlessWeekSeed(now), startTier, concentration),
      playerLevel: level, durationMs: 0,
    };
    if (startTier > 1) payload.pendingBossChoice = { wave: ENDLESS_FIGHTS_PER_LOCATION, opening: true };
    const fight = payload.pendingBossChoice ? null : endlessFightConfig(payload.run, level);
    const run: EndlessLocalRun = {
      id: `local-${this.host.newId()}`, mode, currentWave: payload.pendingBossChoice?.wave ?? 1,
      payload, fight, ruleset: RAID_RULESET_VERSION, startedAt: now,
    };
    this.host.store({ ...save, run, ...(mode === "endless" ? { lastRunStartedAt: now } : {}) });
    return {
      ok: true, sessionId: run.id, mode, wave: run.currentWave, brainCost: entryCost, freeRun: free, concentration,
      rulesetVersion: RAID_RULESET_VERSION,
      ...(fight ? { fight: fight as unknown as Record<string, unknown> }
        : { stage: "boss-choice" as const, ...endlessBossScreen(mode, payload.pendingBossChoice!, payload) }),
    };
  }

  /** Close the run: pay its depth gold. Nothing is ranked: a local run has no board. */
  private settle(save: EndlessLocalSave, run: EndlessLocalRun, deepestFloor: number, durationMs: number, losses: string[], abandoned: boolean): EndlessRunEnd {
    const gold = endlessGoldReward(deepestFloor, run.payload.run.startWave);
    this.host.store({ ...save, run: null });
    if (gold > 0) this.host.payGold(gold);
    return { ok: true, runFinished: true, deepestFloor: Math.max(0, deepestFloor), durationMs, gold, losses, ...(abandoned ? { abandoned: true } : {}) };
  }

  finish(sessionId: string, wave: number, finalTick: number, inputs: RaidReplayInput[]) {
    const { save, run } = this.liveRun(sessionId);
    if (wave !== run.currentWave) throw new EndlessLocalError(409, "stale_wave");
    const payload = run.payload;
    if (payload.pendingBossChoice) throw new EndlessLocalError(409, "boss_choice_pending");
    const config = run.fight;
    if (!config || config.wave !== run.currentWave) throw new EndlessLocalError(409, "bad_session_state");
    // The same replay the Worker does: it is what carries each zombie's health forward.
    const sim = endlessSimFor(config);
    const verified = replayRaid(sim, finalTick, inputs);
    if (!verified.ok) throw new EndlessLocalError(422, verified.error);
    const won = verified.outcome.win && !verified.retreated;
    const mode = run.mode;
    const plan = endlessWavePlan(mode, run.currentWave, payload.run.stop, payload.run.weekSeed);
    const durationMs = Math.max(0, payload.durationMs ?? 0) + Math.max(0, finalTick) * 50;
    if (!won) {
      const losses = endlessLosses(payload.run, sim);
      return { ...this.settle(save, run, run.currentWave - 1, durationMs, losses, false), outcome: verified.outcome };
    }
    const state = endlessCarryFromSim(payload.run, sim);
    const startWave = payload.run.startWave;
    const random = () => this.host.random();
    const loot = rollEndlessWinLoot(mode, plan, run.currentWave, startWave, payload.lootEarned?.["Zwamp Thing"] ?? 0, random);
    let bestTier = save.bestTier;
    if (plan.bossGate) {
      loot.push(...endlessBossWinRewards(mode, plan.tier, save.bestTier, random));
      if (mode === "endless") bestTier = Math.max(bestTier, plan.tier);
    }
    const lootEarned = { ...(payload.lootEarned ?? {}) };
    for (const reward of loot) lootEarned[reward.name] = (lootEarned[reward.name] ?? 0) + reward.quantity;
    const nextPayload: EndlessRunPayload = plan.bossGate
      ? { run: state, playerLevel: payload.playerLevel, durationMs, lootEarned, pendingBossChoice: { wave: run.currentWave, ...(loot.length ? { loot } : {}) } }
      : { run: state, playerLevel: payload.playerLevel, durationMs, lootEarned };
    const nextFight = plan.bossGate ? null : endlessFightConfig(state, payload.playerLevel);
    const nextRun: EndlessLocalRun = {
      ...run, payload: nextPayload, fight: nextFight,
      currentWave: plan.bossGate ? run.currentWave : state.nextWave,
    };
    // The run moves on and the best tier rises in the same save write as the loot.
    this.host.store({ ...save, bestTier, run: nextRun });
    if (loot.length) this.host.payLoot(loot);
    return plan.bossGate ? {
      ok: true, runFinished: false, won: true, clearedWave: run.currentWave,
      awaitingBossChoice: true, ...endlessBossScreen(mode, nextPayload.pendingBossChoice!, nextPayload),
    } : {
      ok: true, runFinished: false, won: true, clearedWave: run.currentWave,
      nextWave: state.nextWave, fight: nextFight as unknown as Record<string, unknown>, floorLoot: loot,
    };
  }

  choose(sessionId: string, boon: unknown, curse: unknown, location?: unknown, order?: unknown) {
    const { save, run } = this.liveRun(sessionId);
    const payload = run.payload;
    const pending = payload.pendingBossChoice;
    if (!pending || pending.wave !== run.currentWave) throw new EndlessLocalError(409, "no_boss_choice_pending");
    const draft = endlessDraftFor(run.mode, pending, payload.run);
    const locationOffered = draft.locations.length === 0 || endlessOffered(location, draft.locations);
    if (!endlessOffered(boon, draft.boons) || !endlessOffered(curse, draft.curses) || !locationOffered) {
      throw new EndlessLocalError(400, "bad_boss_draft_choice");
    }
    let state = applyEndlessCurse(endlessApplyBoon(payload.run, boon as EndlessBoon, payload.playerLevel), curse as EndlessCurse);
    if (draft.locations.length) state = applyEndlessStop(state, location as EndlessStop);
    if (order !== undefined) {
      const ordered = applyEndlessOrder(state, order);
      if (!ordered) throw new EndlessLocalError(400, "bad_army_order");
      state = ordered;
    }
    const nextOpening = pending.opening ? pending.wave + ENDLESS_FIGHTS_PER_LOCATION : 0;
    if (nextOpening && nextOpening < state.startWave) {
      const opening: EndlessRunPayload = { ...payload, run: state, pendingBossChoice: { wave: nextOpening, opening: true } };
      this.host.store({ ...save, run: { ...run, currentWave: nextOpening, payload: opening, fight: null } });
      return { ok: true, runFinished: false, stage: "boss-choice" as const, ...endlessBossScreen(run.mode, opening.pendingBossChoice!, opening) };
    }
    const nextPayload: EndlessRunPayload = { run: state, playerLevel: payload.playerLevel, durationMs: payload.durationMs ?? 0, lootEarned: payload.lootEarned ?? {} };
    const fight = endlessFightConfig(state, payload.playerLevel);
    this.host.store({ ...save, run: { ...run, currentWave: state.nextWave, payload: nextPayload, fight } });
    return { ok: true, runFinished: false, nextWave: state.nextWave, fight: fight as unknown as Record<string, unknown> };
  }

  abandon(sessionId: string): EndlessRunEnd {
    const { save, run } = this.liveRun(sessionId);
    const pending = run.payload.pendingBossChoice;
    const deepestFloor = pending?.opening ? 0 : pending?.wave ?? run.currentWave - 1;
    return this.settle(save, run, deepestFloor, Math.max(0, run.payload.durationMs ?? 0), endlessLosses(run.payload.run), true);
  }

  /** The run in progress, as /endless/active answers; a 404 (with the free-run flag) if none. */
  active() {
    const save = this.save();
    if (!save.run) {
      throw new EndlessLocalError(404, "no_active_run", { ok: false, error: "no_active_run", freeRunAvailable: this.freeRunAvailable() });
    }
    const run = this.rearm(save.run);
    if (run !== save.run) this.host.store({ ...save, run });
    const pending = run.payload.pendingBossChoice;
    return {
      ok: true, sessionId: run.id, mode: run.mode, wave: run.currentWave,
      stage: pending ? "boss-choice" as const : "battle" as const,
      ...(pending ? endlessBossScreen(run.mode, pending, run.payload)
        : { fight: run.fight as unknown as Record<string, unknown> | undefined }),
      run: run.payload.run,
    };
  }
}

