// Shard 3 of the build search. See ../search.ts.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSearchShard, SEARCH_SHARDS } from "../search";

describe("build search", () => {
  it("searches shard 3", () => {
    // WHICH QUESTION is picked by the environment, because the two are different runs
    // over the same machinery and neither is the default answer — see search.ts `better`.
    // "cheap" is the smallest army that still brings everybody home; "fast" is the one
    // that does it soonest. Unset means cheap, which is what the balance table reads.
    // @ts-ignore — node globals are not typed in this project; same pattern as
    // effectiveFit.report.ts. Widening report/node-fs.d.ts to cover them breaks four
    // unrelated suites that rely on the unresolved import being `any`.
    const objective = process.env.SEARCH_OBJECTIVE === "fast" ? "fast" : "cheap";
    const dir = objective === "fast" ? "tmp/search-fast" : "tmp/search";
    const rows = runSearchShard(3, SEARCH_SHARDS, objective);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/shard3.json`, JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
