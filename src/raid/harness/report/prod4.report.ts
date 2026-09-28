// Shard 4 of the prod grid. See ../prodGrid.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProdPools, runProdShard, PROD_SHARDS } from "../prodGrid";

describe("prod grid", () => {
  it("measures shard 4", async () => {
    await loadProdPools();
    const rows = runProdShard(4, PROD_SHARDS);
    const dir = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PRODGRID_DIR ?? "tmp/prodgrid";
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/shard4.json`, JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  }, 14_400_000);
});
