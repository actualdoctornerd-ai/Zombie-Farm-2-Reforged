import { defineConfig } from "vitest/config";
// SCRATCH: dual-invasion mechanic probe.
export default defineConfig({ test: { include: ["src/raid/harness/report/mechProbe.report.ts"], testTimeout: 3_600_000 } });
