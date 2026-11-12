import { defineConfig } from "vitest/config";

// The Ninja smoke-bomb probe (src/raid/harness/report/smokeProbe.report.ts). Excluded from
// `vitest run` like the other reports.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/smokeProbe.report.ts"],
    testTimeout: 3_600_000,
  },
});
