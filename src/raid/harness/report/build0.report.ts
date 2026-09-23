// Shard 0 of the best-builds sweep. See ../bestBuilds.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_SHARDS, runBuildShard } from "../bestBuilds";

describe("best builds", () => {
  it("measures shard 0", () => {
    const rows = runBuildShard(0, BUILD_SHARDS);
    mkdirSync("tmp/builds", { recursive: true });
    writeFileSync("tmp/builds/shard0.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
