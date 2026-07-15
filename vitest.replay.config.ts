import { defineConfig } from "vitest/config";

// Dedicated, non-contended CPU gate. The ordinary suite runs files in parallel, which
// makes wall-clock microbenchmarks measure scheduler contention rather than verifier CPU.
export default defineConfig({
  test: {
    include: ["src/raid/replay.test.ts"],
    fileParallelism: false,
    poolOptions: { threads: { singleThread: true } },
    env: { REPLAY_BENCH: "1" },
  },
});
