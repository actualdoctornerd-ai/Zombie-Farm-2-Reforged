import { defineConfig } from "vitest/config";

// Lethality calibration (src/raid/harness/lethality.ts): how hard each too-easy fight would
// have to hit to land inside the benchmark's casualty band.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/lethality*.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 7_200_000,
  },
});
