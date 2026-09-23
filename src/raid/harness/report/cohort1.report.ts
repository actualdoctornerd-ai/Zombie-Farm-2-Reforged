// Shard 1 of the cohort sweep. See ../cohortReport.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCohortShard, COHORT_SHARDS } from "../cohortReport";

describe("cohort sweep", () => {
  it("measures shard 1", () => {
    const rows = runCohortShard(1, COHORT_SHARDS);
    mkdirSync("tmp/cohorts", { recursive: true });
    writeFileSync("tmp/cohorts/shard1.json", JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
