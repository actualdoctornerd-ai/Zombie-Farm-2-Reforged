import { defineConfig } from "vitest/config";

// Does a better army do better? (src/raid/harness/monotonicity.ts) Every roster in the pool
// against every fight, as a rank correlation. Excluded from `vitest run` like the other
// reports.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/monotonic*.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 7_200_000,
  },
});
