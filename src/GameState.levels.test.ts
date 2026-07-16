import { describe, expect, it, vi } from "vitest";
import { GameState } from "./GameState";

describe("GameState level-up notifications", () => {
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
