import { defineConfig } from "vitest/config";

// Pure-logic unit tests (logic.ts / economy.ts / validate.ts) — default node
// environment, fast. The Worker-runtime INTEGRATION tests live under
// test/integration and run in a separate config (vitest.integration.config.ts)
// because they need the Cloudflare Workers pool (workerd + real D1).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**"],
  },
});
