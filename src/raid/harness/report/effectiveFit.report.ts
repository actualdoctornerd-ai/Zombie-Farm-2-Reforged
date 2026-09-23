// The regression over every shard's observations. Runs as its OWN vitest pass after the
// sampling shards, because it needs all of them on disk — see the npm script.
//
// The read side of node:fs is imported the way the rest of this repo does it: with a
// `@ts-ignore` and hand-annotated parameters. Declaring `readdirSync`/`readFileSync` in
// report/node-fs.d.ts instead was tried and reverted — those names are declared exactly
// once for the whole client, so any signature narrow enough to be useful here immediately
// broke four unrelated test files that were relying on the unresolved import being `any`.
// A local `@ts-ignore` keeps the blast radius at this file.
import { writeFileSync } from "node:fs";
// @ts-ignore — see above
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fitEffective, type Observation } from "../effectiveStrength";

describe("effective strength", () => {
  it("fits weights over every shard", () => {
    const files: string[] = readdirSync("tmp/effective");
    const rows = files
      .filter((f: string) => f.startsWith("shard") && f.endsWith(".json"))
      .flatMap((f: string) => JSON.parse(readFileSync(`tmp/effective/${f}`, "utf8")) as Observation[]);
    expect(rows.length, "no shard JSON — run the sampling pass first").toBeGreaterThan(0);
    const fit = fitEffective(rows);
    writeFileSync("tmp/effective/fit.json", JSON.stringify(fit, null, 1));
    expect(fit.species.length).toBeGreaterThan(0);
    // A fit nobody validated is numerology. The held-out comparison is the whole point,
    // so refuse to emit one that was not computed.
    expect(Number.isFinite(fit.validation.fittedSpearman)).toBe(true);
  }, 600_000);
});
