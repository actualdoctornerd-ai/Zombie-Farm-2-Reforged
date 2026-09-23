// Shard 4 of the difficulty report. See ../report.ts — six shards, one per physical
// core; this file exists only so vitest's file parallelism can run them side by side.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runShard, SHARDS, REPORT_SEEDS } from "../report";

describe("difficulty report", () => {
  it("measures shard 4", () => {
    const rows = runShard(4, SHARDS, REPORT_SEEDS);
    mkdirSync("tmp/difficulty", { recursive: true });
    writeFileSync("tmp/difficulty/shard4.json", JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);
});
