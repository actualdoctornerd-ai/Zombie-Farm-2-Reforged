// Shard 0 of the lethality calibration. See ../lethality.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LETHALITY_SHARDS, runLethalityShard } from "../lethality";

describe("lethality calibration", () => {
  it("sweeps shard 0", () => {
    const rows = runLethalityShard(0, LETHALITY_SHARDS);
    mkdirSync("tmp/lethality", { recursive: true });
    writeFileSync("tmp/lethality/shard0.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThanOrEqual(0);
  }, 7_200_000);
});
