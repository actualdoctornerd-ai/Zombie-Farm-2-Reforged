// Shard 5 of the effective-strength sample. See ../effectiveStrength.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EFFECTIVE_SHARDS, runEffectiveShard } from "../effectiveStrength";

describe("effective strength", () => {
  it("flies shard 5", () => {
    const rows = runEffectiveShard(5, EFFECTIVE_SHARDS);
    mkdirSync("tmp/effective", { recursive: true });
    writeFileSync("tmp/effective/shard5.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
