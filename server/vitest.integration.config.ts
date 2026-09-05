import { defineConfig } from "vitest/config";

// Integration tests drive a REAL `wrangler dev` Worker (+ local D1) over HTTP.
//
// Why not @cloudflare/vitest-pool-workers (the in-process workerd pool)? Its module
// fallback service mangles paths that contain a space, and this project lives under
// ".../Zombie Farm/..." — so the pool can't boot here. `wrangler dev` handles the
// space fine, so globalSetup spawns it once, applies the schema, and the specs hit
// it with fetch. Single-threaded + no file parallelism because all specs share the
// one Worker/DB (tests isolate via unique account ids, not separate databases).
export default defineConfig({
  test: {
    // A GLOB, not a list. The previous shape named two files explicitly, so every
    // other spec in this directory silently did not run — nineteen of twenty-one —
    // while CI reported the integration suite green. Most of them were legitimately
    // retired with the v2 route surface, but `smoke`, `sessions` and the raid specs
    // were not: they exercise live v3 routes and went dark alongside the v2 files
    // with nothing recording it. A new spec must run the day it is written, so
    // opting OUT is now the thing that has to be spelled out.
    include: ["test/integration/**/*.spec.ts"],
    // No exclusions. The four protocol-v2 specs that used to sit here (api, inventory,
    // raidLoot, raidRewards) were deleted with the v2 routes and their D1 tables; what
    // they uniquely covered on the LIVE surface was ported first (see README.md).
    globalSetup: ["./test/integration/globalSetup.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    pool: "threads",
    maxWorkers: 1,
  },
});
