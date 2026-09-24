// Shard 0 of the monotonicity check. See ../monotonicity.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MONOTONIC_SHARDS, runMonotonicShard } from "../monotonicity";

describe("monotonicity", () => {
  it("checks shard 0", () => {
    const rows = runMonotonicShard(0, MONOTONIC_SHARDS);
    mkdirSync("tmp/monotonic", { recursive: true });
    writeFileSync("tmp/monotonic/shard0.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
