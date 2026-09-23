// Shard 2 of the best-builds sweep. See ../bestBuilds.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_SHARDS, runBuildShard } from "../bestBuilds";

describe("best builds", () => {
  it("measures shard 2", () => {
    const rows = runBuildShard(2, BUILD_SHARDS);
    mkdirSync("tmp/builds", { recursive: true });
    writeFileSync("tmp/builds/shard2.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
