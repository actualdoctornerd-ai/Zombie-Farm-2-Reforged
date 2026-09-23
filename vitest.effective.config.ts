import { defineConfig } from "vitest/config";

// Sampling pass for the effective-strength fit (src/raid/harness/effectiveStrength.ts):
// 1,500 random armies over a six-fight battery. The regression is a SEPARATE pass — see
// vitest.effectiveFit.config.ts — because it needs every shard on disk first.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/effective[0-9].report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 7_200_000,
  },
});
