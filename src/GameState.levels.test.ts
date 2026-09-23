import { describe, expect, it, vi } from "vitest";
import { GameState, XP_THRESHOLDS } from "./GameState";

describe("GameState level-up notifications", () => {
  it("reports XP relative to the current level", () => {
    const state = new GameState();
    state.xp = 3_250;

    expect(state.level).toBe(12);
    expect(state.levelXp).toEqual({ current: 450, required: 500 });

    // 218,000 is the top of the AUTHENTIC curve, and used to be the cap. It is level 45 of
    // 50 now, so it reports progress into the first reimpl-only level rather than nothing.
    state.xp = 218_000;
    expect(state.level).toBe(45);
    expect(state.levelXp).toEqual({ current: 0, required: XP_THRESHOLDS[45] - 218_000 });

    // Only the real top of the ladder has no next level to report.
    state.xp = XP_THRESHOLDS[XP_THRESHOLDS.length - 1];
    expect(state.level).toBe(XP_THRESHOLDS.length);
    expect(state.levelXp).toBeNull();
  });

  it("starts a fresh player with the one brain required by the tutorial", () => {
    expect(new GameState().brains).toBe(1);
  });

  it("notifies when an authoritative online balance crosses a level threshold", () => {
    const state = new GameState();
    const onLevelUp = vi.fn();
    state.onLevelUpCb = onLevelUp;
    state.lastRaidAt = 123_456;

    state.syncBalance(1_000_000, 10_001, 25);

    expect(onLevelUp).toHaveBeenCalledOnce();
    expect(onLevelUp).toHaveBeenCalledWith(1, 2);
    expect(state.brains).toBe(10_001);
    expect(state.lastRaidAt).toBe(123_456);
  });

  it("does not notify when reconciliation remains within the current level", () => {
    const state = new GameState();
    const onLevelUp = vi.fn();
    state.onLevelUpCb = onLevelUp;

    state.syncBalance(1_000_000, 10_000, 24);

    expect(onLevelUp).not.toHaveBeenCalled();
  });
});
