// Shard 4 of the lethality calibration. See ../lethality.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LETHALITY_SHARDS, runLethalityShard } from "../lethality";

describe("lethality calibration", () => {
  it("sweeps shard 4", () => {
    const rows = runLethalityShard(4, LETHALITY_SHARDS);
    mkdirSync("tmp/lethality", { recursive: true });
    writeFileSync("tmp/lethality/shard4.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThanOrEqual(0);
  }, 7_200_000);
});
