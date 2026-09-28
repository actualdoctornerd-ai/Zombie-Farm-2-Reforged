import { defineConfig } from "vitest/config";

// The prod grid (src/raid/harness/prodGrid.ts): every invasion flown by real prod
// parties, bucketed by the level the account held. Excluded from `vitest run` like the
// other reports, and sharded to physical cores.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/prod*.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 14_400_000,
  },
});
