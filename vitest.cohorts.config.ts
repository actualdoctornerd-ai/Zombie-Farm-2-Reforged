import { defineConfig } from "vitest/config";

// The cohort sweep (src/raid/harness/cohortReport.ts): hundreds of sampled armies per
// cohort, flown against every fight. Excluded from `vitest run` like the difficulty
// report, and sharded to physical cores for the same measured reason.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/cohort*.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 7_200_000,
  },
});
