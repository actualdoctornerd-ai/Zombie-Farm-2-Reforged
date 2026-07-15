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
    // Protocol v2 route specs are intentionally retired with their 410 surface.
    include: ["test/integration/v3.spec.ts"],
    globalSetup: ["./test/integration/globalSetup.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
});
