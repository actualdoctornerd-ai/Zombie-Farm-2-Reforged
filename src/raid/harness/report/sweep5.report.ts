import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSweepShard } from "../prodSweep";
describe("prod sweep", () => {
  it("shard 5", () => {
    const rows = runSweepShard(5, 6);
    mkdirSync("tmp/sweep", { recursive: true });
    writeFileSync("tmp/sweep/shard5.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 14_400_000);
});
