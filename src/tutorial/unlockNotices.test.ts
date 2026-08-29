import { describe, expect, it } from "vitest";
import { TIM_UNLOCK_NOTICES, timUnlockNoticesFor } from "./unlockNotices";

const messageAt = (level: number) =>
  TIM_UNLOCK_NOTICES.find((n) => n.level === level)!.message;

describe("Tim unlock notices", () => {
  it("covers exactly the system-opening levels", () => {
    expect(TIM_UNLOCK_NOTICES.map((n) => n.level)).toEqual([3, 5, 10, 20]);
  });

  it("fires only for the level a jump actually crossed", () => {
    expect(timUnlockNoticesFor(2, 3, true)).toEqual([messageAt(3)]);
    expect(timUnlockNoticesFor(4, 5, true)).toEqual([messageAt(5)]);
    expect(timUnlockNoticesFor(9, 10, true)).toEqual([messageAt(10)]);
    expect(timUnlockNoticesFor(19, 20, true)).toEqual([messageAt(20)]);
    // Item-only levels stay quiet.
    expect(timUnlockNoticesFor(3, 4, true)).toEqual([]);
    expect(timUnlockNoticesFor(5, 9, true)).toEqual([]);
    expect(timUnlockNoticesFor(10, 19, true)).toEqual([]);
    // The boundary is exclusive at `from`: re-presenting a level says nothing.
    expect(timUnlockNoticesFor(3, 3, true)).toEqual([]);
  });

  it("delivers every notice a multi-level jump crossed, in level order", () => {
    expect(timUnlockNoticesFor(2, 20, true)).toEqual([
      messageAt(3), messageAt(5), messageAt(10), messageAt(20),
    ]);
  });

  it("skips the Black Market on offline farms, which have no Social hub", () => {
    expect(timUnlockNoticesFor(9, 10, false)).toEqual([]);
    // The Brain Ticket is an ordinary Market boost, so offline farms still hear it.
    expect(timUnlockNoticesFor(2, 20, false)).toEqual([
      messageAt(3), messageAt(5), messageAt(20),
    ]);
  });
});
