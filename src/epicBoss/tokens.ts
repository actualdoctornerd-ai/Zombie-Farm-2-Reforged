/** One paid attempt when the player has no harvested event token. */
export const EPIC_BOSS_FIGHT_BRAIN_COST = 10;
export type EpicBossPayment = "token" | "brains";

/**
 * Chance that a ripe vegetable crop yields an active-event fight token.
 *
 * The shipped game exposes `epicEventStarterLootAppearChance = 0.35` and rolls it
 * from `EpicEventManager harvestEventTriggered`. That pickup started the event in
 * the original build. Reforged uses the recovered 35% as the ceiling for attempt
 * tokens, then weights it by both the crop's real grow time and harvest value.
 * A 24-hour, 200-gold crop reaches the ceiling; short/cheap crops remain useful but
 * cannot be spammed as efficiently as crops that tie up a plot for longer.
 */
export function epicBossTokenChance(growMs: number, harvestValue: number): number {
  if (!Number.isFinite(growMs) || !Number.isFinite(harvestValue) || growMs <= 0 || harvestValue <= 0) return 0;
  const timeWeight = Math.max(0, growMs) / 86_400_000;
  const valueWeight = Math.max(0, harvestValue) / 200;
  return Math.min(0.35, 0.35 * Math.sqrt(timeWeight * valueWeight));
}

export function dropsEpicBossToken(
  growMs: number,
  harvestValue: number,
  random: () => number = Math.random
): boolean {
  return random() < epicBossTokenChance(growMs, harvestValue);
}
