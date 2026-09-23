import { defineConfig } from "vitest/config";

// The SLOW half of the difficulty harness (src/raid/harness/report.ts): thousands of
// real fights, producing a table rather than a pass/fail. Deliberately excluded from
// `vitest run` — the fast, relational half is `src/raid/harness/difficulty.test.ts`.
//
// Six shards, not twelve. Measured on a 6C/12T laptop: six shards run ~48 fights/s wall
// clock, twelve run ~30, because the hyperthread pairs contend for the same core.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/shard*.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 3_600_000,
  },
});
