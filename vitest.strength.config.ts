import { defineConfig } from "vitest/config";

// The strength sweep (src/raid/harness/strengthSweep.ts): one roster pool spanning the
// whole Strength Ladder, flown against every fight at every level of play. Excluded from
// `vitest run` like the other reports, and sharded to physical cores.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/strength*.report.ts", "src/raid/harness/report/markers.report.ts"],
    maxWorkers: 6,
    minWorkers: 6,
    testTimeout: 7_200_000,
  },
});
