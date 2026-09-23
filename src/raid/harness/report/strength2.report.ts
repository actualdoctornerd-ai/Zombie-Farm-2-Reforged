// Shard 2 of the strength sweep. See ../strengthSweep.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runStrengthShard, STRENGTH_SHARDS } from "../strengthSweep";

describe("strength sweep", () => {
  it("measures shard 2", () => {
    const rows = runStrengthShard(2, STRENGTH_SHARDS);
    mkdirSync("tmp/strength", { recursive: true });
    writeFileSync("tmp/strength/shard2.json", JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
