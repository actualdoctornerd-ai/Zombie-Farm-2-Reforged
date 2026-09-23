import { defineConfig } from "vitest/config";

// The mechanic-price sweep (src/raid/harness/mechanicPrice.ts): leave-one-out over every
// player input, on every fight built around a mechanic. Excluded from `vitest run` like
// the other reports, and sharded to physical cores.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/mechanic*.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 7_200_000,
  },
});
