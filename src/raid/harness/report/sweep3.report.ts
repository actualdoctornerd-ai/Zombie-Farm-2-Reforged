import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSweepShard } from "../prodSweep";
describe("prod sweep", () => {
  it("shard 3", () => {
    const rows = runSweepShard(3, 6);
    mkdirSync("tmp/sweep", { recursive: true });
    writeFileSync("tmp/sweep/shard3.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 14_400_000);
});
