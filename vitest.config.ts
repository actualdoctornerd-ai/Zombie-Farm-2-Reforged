import { defineConfig } from "vitest/config";

// Pure-logic regression tests (no Pixi / no DOM). These lock in the mechanics
// recovered by disassembling the iOS binary (see
// ZF2R_extracted/docs/mechanics/COMBAT_STATS_RECOVERED.md and zombie-pot notes),
// so a future refactor can't silently drift from ground truth.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/vitest.setup.ts"],
  },
});
