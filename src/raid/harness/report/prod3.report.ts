// Shard 3 of the prod grid. See ../prodGrid.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runProdShard, PROD_SHARDS } from "../prodGrid";

describe("prod grid", () => {
  it("measures shard 3", () => {
    const rows = runProdShard(3, PROD_SHARDS);
    mkdirSync("tmp/prodgrid", { recursive: true });
    writeFileSync("tmp/prodgrid/shard3.json", JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  }, 14_400_000);
});
