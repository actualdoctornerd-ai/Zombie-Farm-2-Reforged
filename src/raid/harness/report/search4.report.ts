// Shard 4 of the build search. See ../search.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSearchShard, SEARCH_SHARDS } from "../search";

describe("build search", () => {
  it("searches shard 4", () => {
    const rows = runSearchShard(4, SEARCH_SHARDS);
    mkdirSync("tmp/search", { recursive: true });
    writeFileSync("tmp/search/shard4.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
