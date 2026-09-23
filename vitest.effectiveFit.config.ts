import { defineConfig } from "vitest/config";

// The regression over the sampling pass's output. One worker, no fights flown.
export default defineConfig({
  test: {
    include: ["src/raid/harness/report/effectiveFit.report.ts"],
    testTimeout: 600_000,
  },
});
