// Shard 3 of the monotonicity check. See ../monotonicity.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MONOTONIC_SHARDS, runMonotonicShard } from "../monotonicity";

describe("monotonicity", () => {
  it("checks shard 3", () => {
    const rows = runMonotonicShard(3, MONOTONIC_SHARDS);
    mkdirSync("tmp/monotonic", { recursive: true });
    writeFileSync("tmp/monotonic/shard3.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
