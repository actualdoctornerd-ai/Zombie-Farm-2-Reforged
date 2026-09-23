// Shard 3 of the mechanic-price sweep. See ../mechanicPrice.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MECHANIC_SHARDS, runMechanicShard } from "../mechanicPrice";

describe("mechanic price", () => {
  it("measures shard 3", () => {
    const rows = runMechanicShard(3, MECHANIC_SHARDS);
    mkdirSync("tmp/mechanics", { recursive: true });
    writeFileSync("tmp/mechanics/shard3.json", JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
