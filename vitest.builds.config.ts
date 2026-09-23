import { defineConfig } from "vitest/config";

// The best-builds sweep (src/raid/harness/bestBuilds.ts): every support shape x filler x
// deploy order x species plan x duplicate cap, flown against the hard end of the game.
// Excluded from `vitest run` like the other reports, and sharded to physical cores.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/build*.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 7_200_000,
  },
});
