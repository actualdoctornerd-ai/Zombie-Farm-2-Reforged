// Shard 1 of the monotonicity check. See ../monotonicity.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MONOTONIC_SHARDS, runMonotonicShard } from "../monotonicity";

describe("monotonicity", () => {
  it("checks shard 1", () => {
    const rows = runMonotonicShard(1, MONOTONIC_SHARDS);
    mkdirSync("tmp/monotonic", { recursive: true });
    writeFileSync("tmp/monotonic/shard1.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
