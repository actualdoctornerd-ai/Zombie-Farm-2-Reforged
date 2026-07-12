import { describe, it, expect } from "vitest";
import { GameState } from "../GameState";
import { canGiftBrain, nextFriendId, GIFT_COOLDOWN_MS, Friend } from "./friends";

describe("nextFriendId — lowest free fN", () => {
  it("starts at f1", () => expect(nextFriendId([])).toBe("f1"));
  it("skips taken ids", () => expect(nextFriendId(["f1", "f2"])).toBe("f3"));
  it("fills a gap left by a removal", () =>
    expect(nextFriendId(["f1", "f3"])).toBe("f2"));
});

describe("canGiftBrain — daily gate is deferred", () => {
  const now = 1_000_000;
  const base: Friend = { id: "f1", name: "Al", addedAt: 0, giftsSent: 0 };
  it("always allows a gift while enforcement is off (default)", () => {
    expect(canGiftBrain({ ...base, lastGiftAt: now }, now)).toBe(true);
  });
  it("blocks a same-day gift once enforcement is on", () => {
    expect(canGiftBrain({ ...base, lastGiftAt: now }, now, true)).toBe(false);
  });
  it("allows a gift after the cooldown when enforced", () => {
    expect(canGiftBrain({ ...base, lastGiftAt: now }, now + GIFT_COOLDOWN_MS, true)).toBe(true);
  });
  it("allows the first-ever gift when enforced (no lastGiftAt)", () => {
    expect(canGiftBrain(base, now, true)).toBe(true);
  });
});

describe("GameState friends + gifting", () => {
  it("adds a friend with a fresh id and zero gifts", () => {
    const s = new GameState();
    const f = s.addFriend("  Bob  ");
    expect(f).not.toBeNull();
    expect(f!.name).toBe("Bob"); // trimmed
    expect(f!.giftsSent).toBe(0);
    expect(s.friends).toHaveLength(1);
  });

  it("rejects a blank friend name", () => {
    const s = new GameState();
    expect(s.addFriend("   ")).toBeNull();
    expect(s.friends).toHaveLength(0);
  });

  it("gifts a brain: records it on the friend without charging the player", () => {
    const s = new GameState();
    const before = s.brains;
    const f = s.addFriend("Cal")!;
    expect(s.giftBrain(f.id)).toBe(true);
    expect(f.giftsSent).toBe(1);
    expect(f.lastGiftAt).toBeGreaterThan(0);
    expect(s.brains).toBe(before); // gifting is free to the sender
  });

  it("gifting an unknown friend fails", () => {
    const s = new GameState();
    expect(s.giftBrain("nope")).toBe(false);
  });

  it("removes a friend by id", () => {
    const s = new GameState();
    const f = s.addFriend("Dee")!;
    expect(s.removeFriend(f.id)).toBe(true);
    expect(s.friends).toHaveLength(0);
    expect(s.removeFriend(f.id)).toBe(false); // already gone
  });
});
