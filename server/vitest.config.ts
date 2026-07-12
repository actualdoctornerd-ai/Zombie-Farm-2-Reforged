import { defineConfig } from "vitest/config";

// Pure-logic tests only (logic.ts) — no Worker runtime needed, so the default
// node environment is fine. Route handlers are exercised end-to-end via wrangler.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
