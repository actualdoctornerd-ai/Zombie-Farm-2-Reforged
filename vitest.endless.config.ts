import { defineConfig } from "vitest/config";

// The Endless balance report (src/raid/harness/report/endless.report.ts). Excluded from
// `vitest run` like the other reports.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/endless.report.ts"],
    testTimeout: 3_600_000,
  },
});
