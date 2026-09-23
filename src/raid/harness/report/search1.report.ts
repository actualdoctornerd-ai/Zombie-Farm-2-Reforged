// Shard 1 of the build search. See ../search.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSearchShard, SEARCH_SHARDS } from "../search";

describe("build search", () => {
  it("searches shard 1", () => {
    const rows = runSearchShard(1, SEARCH_SHARDS);
    mkdirSync("tmp/search", { recursive: true });
    writeFileSync("tmp/search/shard1.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
