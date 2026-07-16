import raw from "../../public/assets/epic-bosses/dr-groundhog/catalog.json";
import type { EpicBossDef } from "./types";

export const DR_GROUNDHOG = raw as EpicBossDef;
export const EPIC_BOSSES = [DR_GROUNDHOG] as const;
export const EPIC_BOSS_SKIP_MS_PER_BRAIN = 2 * 60_000;

/** Cooldown skipping bills started two-minute blocks, so a partial block costs one brain. */
export function epicBossRetrySkipCost(remainingMs: number): number {
  return Math.max(0, Math.ceil(Math.max(0, remainingMs) / EPIC_BOSS_SKIP_MS_PER_BRAIN));
}

export function epicBossHp(def: EpicBossDef, level: number): number {
  const index = Math.max(0, Math.min(def.maxLevel - 1, Math.floor(level) - 1));
  return Math.round(def.baseHp * (def.multipliers[index] ?? 1));
}
