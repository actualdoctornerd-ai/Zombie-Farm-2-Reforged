import { describe, expect, it } from "vitest";
import raids from "../../public/assets/raids/raids.json";
import { RAID_TIPS, raidTip } from "./raidTips";

// Tim's pre-fight briefings. The point of the whole file is that a tip is the game's
// OWN warning moved earlier, so the two invariants worth guarding are that every tip
// belongs to a real invasion and that the Pirates' tip still matches the wording their
// defeat text uses — tools/prep_raids.py regenerates raids.json, and a reworded
// failureText would silently leave Tim quoting a line the game no longer says.

describe("raid tips", () => {
  it("only names invasions that exist", () => {
    const ids = new Set((raids as { id: number }[]).map((r) => r.id));
    for (const key of Object.keys(RAID_TIPS)) expect(ids.has(Number(key))).toBe(true);
  });

  it("warns before the Pirates in the game's own words", () => {
    const pirates = (raids as { id: number; failureText: string }[]).find((r) => r.id === 3)!;
    const tip = raidTip(3);
    expect(tip).toBe("Rumors say pirates clobber anything that moves too fast. hmmmm...");
    expect(pirates.failureText).toContain(tip);
  });

  it("briefs Halloween on the night chain and the Count's slam", () => {
    const tip = raidTip(16)!;
    expect(tip).toContain("keep everything the earlier nights paid");
    expect(tip).toContain("slam");
    expect(tip).toContain("stunnin' moves");
  });

  it("has nothing to say about an invasion with no hidden rule", () => {
    expect(raidTip(1)).toBeNull();
  });
});
