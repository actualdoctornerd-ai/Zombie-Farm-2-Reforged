import { defineConfig } from "vitest/config";

// The build search (src/raid/harness/search.ts): an evolutionary search over the sixteen-
// slot army genome, per hard fight. Excluded from `vitest run` like the other reports.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/search*.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 7_200_000,
  },
});
