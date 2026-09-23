// Shard 5 of the best-builds sweep. See ../bestBuilds.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_SHARDS, runBuildShard } from "../bestBuilds";

describe("best builds", () => {
  it("measures shard 5", () => {
    const rows = runBuildShard(5, BUILD_SHARDS);
    mkdirSync("tmp/builds", { recursive: true });
    writeFileSync("tmp/builds/shard5.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
