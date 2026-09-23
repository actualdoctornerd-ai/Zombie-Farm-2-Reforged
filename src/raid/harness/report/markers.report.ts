// Where a player actually stands when each fight opens. See ../unlockArmy.ts.
//
// Separate from the sweep shards because it flies nothing: two rosters per distinct unlock
// level, seconds rather than minutes. The table and the page both merge it in, so the
// marks can be retuned without re-running 54,000 flights.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allMarks } from "../unlockArmy";
import { sweepFights } from "../strengthSweep";

describe("unlock marks", () => {
  it("places a ceiling and a moderate army on every row", () => {
    const marks = allMarks(sweepFights());
    mkdirSync("tmp/strength", { recursive: true });
    writeFileSync("tmp/strength/markers.json", JSON.stringify(marks, null, 1));
    expect(marks.length).toBeGreaterThan(0);
    // The ceiling is the ceiling: it can tie the moderate army at a level where nothing
    // is mutable or repeatable yet, but it can never be behind it.
    for (const m of marks) expect(m.ceiling.strength).toBeGreaterThanOrEqual(m.moderate.strength);
  }, 300_000);
});
