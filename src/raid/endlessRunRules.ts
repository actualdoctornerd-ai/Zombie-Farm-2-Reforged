// The run-level rules of an Endless run that sit above the fights: what a run pays in gold,
// who it lost, what a boss screen shows, and which of its choices were really offered.
// Shared by the Worker (server/src/v3/endless.ts), which runs an online account's runs, and
// the client's local engine (raid/endlessLocal.ts), which runs a local farm's, so the two
// can never pay or judge a run differently.

import { getsBackUp } from "../zombie/boundlessVitality";
import {
  endlessBossDraft, ENDLESS_FIGHTS_PER_LOCATION,
  type EndlessMode, type EndlessRunState, type EndlessWavePlan,
} from "./endless";
import type { endlessSimFor } from "./endlessFight";
import {
  endlessMilestoneRewards, endlessVictoryRewards, rollEndlessBossLoot, rollEndlessBrain,
  rollEndlessFloorLoot, rollEndlessLocationZombie, type EndlessBossLoot,
} from "./endlessLoot";

/** What a run keeps between requests, beside its fight config. */
export interface EndlessRunPayload {
  run: EndlessRunState;
  playerLevel: number;
  /** The farm's Life Force level when the run started: it opens ability slots, for the army
   *  and for a loaned zombie alike. Absent on runs started before 2026-11-11, which opened
   *  slots by player level and keep doing so to their end. */
  lifeForceLevel?: number;
  /** Accumulated combat time, excluding time spent disconnected or on a draft screen. */
  durationMs: number;
  /** A cleared boss awaiting its durable boon/curse choice. `opening`: not a fight at all, but
   *  the draft standing in for a tier the run skipped. */
  pendingBossChoice?: { wave: number; loot?: EndlessBossLoot[]; opening?: boolean };
  /** Everything loot has paid this run, by name, for the boss screen. */
  lootEarned?: Record<string, number>;
}

export function endlessStable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(endlessStable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${endlessStable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
/** Whether `choice` is one of `choices`, compared by value. */
export function endlessOffered<T>(choice: unknown, choices: readonly T[]): choice is T {
  const encoded = endlessStable(choice);
  return choices.some((candidate) => endlessStable(candidate) === encoded);
}

/** The draft a boss screen offers. Derived, never stored: its week and location are already in
 *  the checkpoint. In an opening draft, only the last screen chooses where the run starts. */
export function endlessDraftFor(
  mode: EndlessMode, pending: NonNullable<EndlessRunPayload["pendingBossChoice"]>, run: EndlessRunState,
) {
  const withLocations = !pending.opening || pending.wave + ENDLESS_FIGHTS_PER_LOCATION >= run.startWave;
  return endlessBossDraft(mode, pending.wave, run.weekSeed, run.stop.location, withLocations, run);
}

/** Everything the boss screen shows. */
export function endlessBossScreen(
  mode: EndlessMode, pending: NonNullable<EndlessRunPayload["pendingBossChoice"]>, payload: EndlessRunPayload,
) {
  return {
    bossDraft: endlessDraftFor(mode, pending, payload.run),
    bossLoot: pending.loot ?? [],
    lootEarned: payload.lootEarned ?? {},
    goldSoFar: pending.opening ? 0 : endlessGoldReward(pending.wave, payload.run.startWave),
    army: payload.run.units.map((unit) => ({ id: unit.id, name: unit.name, key: unit.sourceKey })),
    opening: !!pending.opening,
    tier: Math.ceil(pending.wave / ENDLESS_FIGHTS_PER_LOCATION),
  };
}

/** A run that skipped tiers has earned nothing for them until it beats its first boss. */
export function endlessFirstBossWave(startWave: number): number {
  return startWave + ENDLESS_FIGHTS_PER_LOCATION - 1;
}
/** Whether a run that got this deep counts at all (leaderboards). */
export function endlessCredited(deepestFloor: number, startWave: number): boolean {
  return deepestFloor >= endlessFirstBossWave(startWave) || (startWave === 1 && deepestFloor > 0);
}

/** The depth payout for each tier number: 450 gold a floor and 900 for its boss, so a cleared
 *  tier pays 1,800 x its number (T1 1,800, T2 3,600, and so on; about 50k through T7). Cut from
 *  625 / 1,250 on 2026-11-10 (owner: 100k for a ~45-minute run was too much). Awarded once when a run ends, based only
 *  on fully cleared fights; a skipper's early tiers join in at its first boss. */
const ENDLESS_FLOOR_GOLD = 450;
const ENDLESS_BOSS_GOLD = 900;
export function endlessGoldReward(deepestFloor: number, startWave = 1): number {
  let total = 0;
  const first = deepestFloor >= endlessFirstBossWave(startWave) ? 1 : startWave;
  for (let wave = first; wave <= Math.max(0, Math.floor(deepestFloor)); wave++) {
    const tier = Math.ceil(wave / ENDLESS_FIGHTS_PER_LOCATION);
    total += (wave % ENDLESS_FIGHTS_PER_LOCATION === 0 ? ENDLESS_BOSS_GOLD : ENDLESS_FLOOR_GOLD) * tier;
  }
  return total;
}

/** The run's dead, as roster ids: everyone down in its last saved state, plus anyone the final,
 *  lost fight killed. A zombie a boon brought back (Second Wind) is alive again and is not here,
 *  and a Boundless Vitality zombie (v90) is never here: it gets back up when the run ends. */
export function endlessLosses(run: EndlessRunState, lastFight?: ReturnType<typeof endlessSimFor>): string[] {
  const fell = new Set(run.units.filter((unit) => !unit.alive && !getsBackUp(unit.abilities)).map((unit) => unit.id));
  for (const unit of lastFight?.units ?? []) {
    if (unit.team === "player" && !unit.alive && !getsBackUp(unit.abilities) &&
        run.units.some((u) => u.id === unit.id)) fell.add(unit.id);
  }
  return [...fell];
}

/** The loot one won fight rolls, in normal Endless: a floor's small roll or a boss's full one
 *  (a skipper's first boss brings the skipped tiers' rolls with it), the location's rare
 *  zombies, and the flat brain chance. Nightmare's loot tables are not written yet. */
export function rollEndlessWinLoot(
  mode: EndlessMode, plan: Pick<EndlessWavePlan, "bossGate" | "tier" | "location">, wave: number, startWave: number,
  zwampsSoFar: number, random: () => number,
): EndlessBossLoot[] {
  if (mode !== "endless") return [];
  const loot: EndlessBossLoot[] = [];
  let zwamps = zwampsSoFar;
  const bossRoll = (tier: number) => {
    const rolled = rollEndlessBossLoot(tier, plan.location, random(), random(), random(), zwamps);
    zwamps += rolled.filter((r) => r.kind === "zombie" && r.key === "ZombieActorZwampThing").length;
    return rolled;
  };
  if (plan.bossGate) {
    if (startWave > 1 && wave === endlessFirstBossWave(startWave)) {
      for (let tier = 1; tier < plan.tier; tier++) loot.push(...bossRoll(tier));
    }
    loot.push(...bossRoll(plan.tier));
  } else {
    loot.push(rollEndlessFloorLoot(plan.tier, random()));
  }
  const rare = rollEndlessLocationZombie(plan.location, random(), random());
  if (rare) loot.push(rare);
  const brain = rollEndlessBrain(mode, random());
  if (brain) loot.push(brain);
  return loot;
}

/** A boss win's first-clear milestones (every tier past the best so far) and victory brains. */
export function endlessBossWinRewards(
  mode: EndlessMode, tier: number, bestTierSoFar: number, random: () => number,
): EndlessBossLoot[] {
  const loot: EndlessBossLoot[] = [];
  for (let t = bestTierSoFar + 1; t <= tier; t++) loot.push(...endlessMilestoneRewards(mode, t));
  loot.push(...endlessVictoryRewards(mode, tier, random()));
  return loot;
}
